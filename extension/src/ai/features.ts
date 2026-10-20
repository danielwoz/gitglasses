import * as vscode from 'vscode';
import { CommitDetails, CommitSummaryInfo, DiffHunk, ErrorCodes } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, requireRepo, ViewNode } from '../views/viewBase';
import { errorMessage, setStatus } from '../commands/ui';
import { SHOW_COMMIT_DETAILS_COMMAND } from '../commitDetails/commitDetails';
import { shortSha } from '@gitglasses/protocol/sha';
import { AI_PROVIDER_LABELS, AiProvider, AiProviderId, CompletionRequest } from './aiProvider';
import { registerAiAuthCommands } from './aiAuth';
import { chooseProvider, ensureAiReady } from './aiSetup';
import {
  buildDiffContext,
  DiffFile,
  pickFilesToShow,
  splitPatch,
  wholePatchFits,
} from './contextBuilder';
import { unifiedDiff } from './lineDiff';
import { parseNlSearchQuery } from './nlQuery';
import {
  COMMIT_MESSAGE_SYSTEM,
  commitMessagePrompt,
  EXPLAIN_COMMIT_SYSTEM,
  explainCommitPrompt,
  EXPLAIN_WIP_SYSTEM,
  explainWipPrompt,
  nlSearchPrompt,
  nlSearchSystem,
} from './prompts';
import { escapeMarkdownText, sanitizeAiMarkdown } from './sanitize';
import { CommitSearchQuery, describeQuery, isoDay } from '../views/searchQuery';
import { searchCommitHistory } from '../views/commitSearch';
import { searchRefusal } from '../views/searchView';
import { isMethodAvailable } from '../engine/capabilityGate';

const CONTEXT_BUDGET_TOKENS = 6000;
const MAX_CONTEXT_FILES = 30;
/** Largest file version read to diff a commit where git cannot. */
const MAX_DIFF_SOURCE_BYTES = 256 * 1024;
const NL_SEARCH_LIMIT = 100;

type Log = (line: string) => void;

function isCancellation(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    message.includes('cancel') ||
    message.includes('abort')
  );
}

function hunksToPatch(hunks: DiffHunk[]): string {
  return hunks.map((hunk) => [hunk.header, ...hunk.lines].join('\n')).join('\n');
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

// --- AI result panel --------------------------------------------------------

const AI_SCHEME = 'gitglasses-ai';

/** Serves AI results as readonly virtual markdown docs; results open in the
 *  built-in markdown preview (falling back to a text editor). Every result is
 *  sanitized first, so the preview never loads an image or HTML from it, and
 *  repository text placed around it is escaped so it reads literally. */
class AiResultContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private maxEntries = 50;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  async show(title: string, markdown: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: AI_SCHEME, path: `/${title}.md` });
    // Evict oldest entries when the map grows too large.
    if (this.contents.size >= this.maxEntries) {
      const firstKey = this.contents.keys().next().value;
      if (firstKey) this.contents.delete(firstKey);
    }
    this.contents.set(uri.path, sanitizeAiMarkdown(markdown));
    this.emitter.fire(uri);
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

// --- Provider readiness, progress, errors -----------------------------------

interface ReadyProvider {
  id: AiProviderId;
  provider: AiProvider;
}

class AiService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Log,
  ) {}

  /** The provider to use, chosen and ready; asked before any other input
   *  so a missing provider is found out before anything is typed. */
  prepare(): Promise<ReadyProvider | undefined> {
    return ensureAiReady(this.context, this.log);
  }

  /** Runs a completion with progress and cancellation. Returns undefined
   *  when cancelled or failed (already reported). */
  async complete(
    ready: ReadyProvider,
    title: string,
    req: CompletionRequest,
  ): Promise<string | undefined> {
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => ready.provider.complete(req, token),
      );
    } catch (error) {
      if (isCancellation(error)) return undefined;
      const label = AI_PROVIDER_LABELS[ready.id];
      this.log(`AI: ${label} request failed: ${errorMessage(error)}`);
      const choose = 'Choose AI Provider…';
      void vscode.window
        .showErrorMessage(`GitGlasses AI (${label}): ${errorMessage(error)}`, choose)
        .then(async (choice) => {
          if (choice === choose) await chooseProvider(this.context.secrets, { log: this.log });
        });
      return undefined;
    }
  }
}

// --- Explain Commit ----------------------------------------------------------

function changeLabel(status: string): string {
  const labels: Record<string, string> = {
    A: 'added',
    D: 'deleted',
    M: 'modified',
    R: 'renamed',
    C: 'copied',
    T: 'type changed',
    U: 'unmerged',
  };
  return labels[status] ?? status;
}

/** The commit's diff computed here from each file's two versions: for
 *  engines that cannot run git (Restricted Mode, no git CLI, the web), and
 *  for commits too big to read whole, where only the files that can fit the
 *  context are read. */
async function diffFromVersions(
  engine: EngineClient,
  repoId: string,
  details: CommitDetails,
): Promise<DiffFile[]> {
  const parent = details.parents[0];
  const read = async (rev: string | undefined, path: string): Promise<string | undefined> => {
    if (rev === undefined) return '';
    const file = await engine.request('rev/fileAtRev', {
      repoId,
      path,
      rev,
      maxBytes: MAX_DIFF_SOURCE_BYTES,
    });
    return file.binary || file.truncated ? undefined : file.contents;
  };
  const files: DiffFile[] = [];
  for (const change of pickFilesToShow(details.files, MAX_CONTEXT_FILES)) {
    const from = change.origPath ? `${change.origPath} → ` : '';
    const header = `${changeLabel(change.status)}: ${from}${change.path}  +${change.additions} −${change.deletions}`;
    if (change.binary) {
      files.push({ path: change.path, patch: `${header}\n(binary file)` });
      continue;
    }
    try {
      const before =
        change.status === 'A' ? '' : await read(parent, change.origPath ?? change.path);
      const after = change.status === 'D' ? '' : await read(details.sha, change.path);
      const hunks =
        before === undefined || after === undefined
          ? '(too large to diff here)'
          : unifiedDiff(before, after);
      files.push({ path: change.path, patch: `${header}\n${hunks}` });
    } catch (error) {
      files.push({
        path: change.path,
        patch: `${header}\n(diff unavailable: ${errorMessage(error)})`,
      });
    }
  }
  return files;
}

/** The commit's real diff, split per file: git's own patch when the engine
 *  can run git and the commit is small enough to read whole, otherwise
 *  computed from the file versions. */
async function collectCommitDiff(
  engine: EngineClient,
  repoId: string,
  details: CommitDetails,
  log: Log,
): Promise<DiffFile[]> {
  if (!wholePatchFits(details)) return diffFromVersions(engine, repoId, details);
  try {
    const { envelope } = await engine.request('patch/create', {
      repoId,
      source: { kind: 'commit', sha: details.sha },
    });
    const files = splitPatch(envelope.patch);
    if (files.length > 0) return files;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== ErrorCodes.Restricted && code !== ErrorCodes.MethodNotSupported) {
      log(
        `AI: patch/create for ${details.sha} failed; diffing the file versions instead: ${errorMessage(error)}`,
      );
    }
  }
  return diffFromVersions(engine, repoId, details);
}

function refsLabel(details: CommitDetails): string {
  return details.refs.map((ref) => (ref.kind === 'tag' ? `tag ${ref.name}` : ref.name)).join(', ');
}

async function explainCommit(
  engine: EngineClient,
  repos: RepositoryService,
  ai: AiService,
  panel: AiResultContentProvider,
  log: Log,
  node?: ViewNode,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;
  const ready = await ai.prepare();
  if (!ready) return;
  const ref =
    node?.sha ??
    (await vscode.window.showInputBox({
      prompt: 'Commit to explain (sha, branch, tag, HEAD~n…)',
      value: 'HEAD',
    }));
  if (!ref) return;

  let details: CommitDetails;
  let files: DiffFile[];
  try {
    details = await engine.request('commit/details', { repoId: repo.repoId, sha: ref });
    files = await collectCommitDiff(engine, repo.repoId, details, log);
  } catch (error) {
    void vscode.window.showWarningMessage(
      `GitGlasses: cannot read commit "${ref}": ${errorMessage(error)}`,
    );
    return;
  }
  const omitted = details.truncated || details.files.length > files.length;
  const context = buildDiffContext(files, CONTEXT_BUDGET_TOKENS);
  const { stats } = details;
  const prompt = explainCommitPrompt(
    {
      sha: details.sha,
      author: `${details.author.name} <${details.author.email}>`,
      date: new Date(details.author.time * 1000).toISOString(),
      subject: details.subject,
      body: details.body,
      refs: refsLabel(details),
      stats: `+${stats.additions} −${stats.deletions} in ${stats.files} file${stats.files === 1 ? '' : 's'}${omitted ? ' (not all shown)' : ''}`,
    },
    context.text,
  );
  const sha7 = shortSha(details.sha);
  const result = await ai.complete(ready, `GitGlasses: explaining ${sha7}…`, {
    system: EXPLAIN_COMMIT_SYSTEM,
    prompt,
    maxTokens: 1024,
  });
  if (!result) return;
  await panel.show(
    `Explain: ${sha7}`,
    `# ${escapeMarkdownText(details.subject)}\n\n\`${details.sha}\` — ${escapeMarkdownText(details.author.name)}\n\n${result}\n`,
  );
}

// --- Explain Working Changes -------------------------------------------------

async function collectChangeHunks(
  engine: EngineClient,
  repoId: string,
  paths: readonly string[],
  staged: boolean,
): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (const path of paths.slice(0, MAX_CONTEXT_FILES)) {
    try {
      const { hunks } = await engine.request('diff/fileHunks', { repoId, path, staged });
      if (hunks.length > 0) files.push({ path, patch: hunksToPatch(hunks) });
    } catch {
      files.push({ path, patch: '(diff unavailable)' });
    }
  }
  return files;
}

async function collectWipFiles(
  engine: EngineClient,
  repoId: string,
): Promise<{ files: DiffFile[]; empty: boolean }> {
  const status = await engine.request('status/summary', { repoId });
  const patches = new Map<string, string[]>();
  const add = (path: string, section: string): void => {
    const sections = patches.get(path) ?? [];
    sections.push(section);
    patches.set(path, sections);
  };
  for (const staged of [true, false]) {
    const paths = (staged ? status.staged : status.unstaged).map((change) => change.path);
    for (const file of await collectChangeHunks(engine, repoId, paths, staged)) {
      add(file.path, `${staged ? '(staged)' : '(unstaged)'}\n${file.patch}`);
    }
  }
  for (const path of status.untracked.slice(0, MAX_CONTEXT_FILES)) add(path, '(untracked file)');
  for (const path of status.conflicted) add(path, '(conflicted)');
  const files = [...patches.entries()].map(([path, sections]) => ({
    path,
    patch: sections.join('\n'),
  }));
  return { files, empty: files.length === 0 };
}

async function explainWip(
  engine: EngineClient,
  repos: RepositoryService,
  ai: AiService,
  panel: AiResultContentProvider,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;
  let status;
  let collected;
  try {
    status = await engine.request('status/summary', { repoId: repo.repoId });
    collected = await collectWipFiles(engine, repo.repoId);
  } catch (error) {
    void vscode.window.showWarningMessage(`GitGlasses: status failed: ${errorMessage(error)}`);
    return;
  }
  if (collected.empty) {
    void vscode.window.showInformationMessage('GitGlasses: working tree is clean.');
    return;
  }
  const ready = await ai.prepare();
  if (!ready) return;
  const context = buildDiffContext(collected.files, CONTEXT_BUDGET_TOKENS);
  const result = await ai.complete(ready, 'GitGlasses: explaining working changes…', {
    system: EXPLAIN_WIP_SYSTEM,
    prompt: explainWipPrompt(status, context.text),
    maxTokens: 1024,
  });
  if (!result) return;
  await panel.show(
    'Explain: Working Changes',
    `# Working changes on ${escapeMarkdownText(status.branch)}\n\n${result}\n`,
  );
}

// --- Generate Commit Message --------------------------------------------------

/** The slice of the built-in Git extension's API (vscode.git, API v1) that
 *  writes the Source Control commit message box. */
interface GitRepositoryApi {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
}
interface GitApi {
  readonly repositories: readonly GitRepositoryApi[];
}
interface GitExtensionExports {
  readonly enabled?: boolean;
  getAPI(version: 1): GitApi;
}

async function builtInGitApi(log: Log): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) return undefined;
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    if (!exports || exports.enabled === false) return undefined;
    return exports.getAPI(1);
  } catch (error) {
    log(`AI: the built-in Git extension's API is unavailable: ${errorMessage(error)}`);
    return undefined;
  }
}

/** The repository a commit message is for: the Source Control the button was
 *  pressed in, else the active repository. */
async function commitMessageRepo(
  repos: RepositoryService,
  sourceControl: { rootUri?: vscode.Uri } | undefined,
): Promise<ActiveRepo | undefined> {
  const rootUri = sourceControl?.rootUri;
  if (rootUri?.scheme === 'file') {
    // Any path directly inside the root locates the repository it belongs to.
    const located = await repos.locateOrDiscover(vscode.Uri.joinPath(rootUri, '.gitglasses'));
    if (located && repos.isRootOf(located.repoId, rootUri.fsPath)) {
      return { repoId: located.repoId, rootPath: repos.rootOf(located.repoId) ?? located.rootPath };
    }
  }
  return requireRepo(repos);
}

async function generateCommitMessage(
  engine: EngineClient,
  repos: RepositoryService,
  ai: AiService,
  log: Log,
  sourceControl?: { rootUri?: vscode.Uri },
): Promise<void> {
  const repo = await commitMessageRepo(repos, sourceControl);
  if (!repo) return;
  const git = await builtInGitApi(log);
  const box = git?.repositories.find((candidate) =>
    repos.isRootOf(repo.repoId, candidate.rootUri.fsPath),
  );

  let status;
  try {
    status = await engine.request('status/summary', { repoId: repo.repoId });
  } catch (error) {
    void vscode.window.showWarningMessage(`GitGlasses: status failed: ${errorMessage(error)}`);
    return;
  }
  // With nothing staged, Source Control commits every change, so the message
  // describes those; the engine fallback commits only what is staged.
  const staged = status.staged.length > 0;
  if (!staged && (!box || status.unstaged.length === 0)) {
    void vscode.window.showInformationMessage(
      box
        ? 'GitGlasses: there are no changes to describe.'
        : 'GitGlasses: nothing staged — stage changes before generating a commit message.',
    );
    return;
  }
  const ready = await ai.prepare();
  if (!ready) return;
  const paths = (staged ? status.staged : status.unstaged).map((change) => change.path);
  const files = await collectChangeHunks(engine, repo.repoId, paths, staged);
  const context = buildDiffContext(files, CONTEXT_BUDGET_TOKENS);
  const raw = await ai.complete(ready, 'GitGlasses: generating commit message…', {
    system: COMMIT_MESSAGE_SYSTEM,
    prompt: commitMessagePrompt(context.text, staged),
    maxTokens: 400,
  });
  if (!raw) return;
  const message = stripCodeFences(raw);

  if (box) {
    // The message lands in the Source Control box, where the editor's own
    // commit flow (amend, sign-off, hooks, multi-line editing) takes over.
    box.inputBox.value = message;
    void vscode.commands.executeCommand('workbench.view.scm');
    setStatus('commit message written to the Source Control box');
    return;
  }
  await commitThroughEditor(engine, repo, message);
}

/** Without the built-in Git extension: the message opens in an editor, where
 *  it keeps its line breaks, and commits the staged changes from there. */
async function commitThroughEditor(
  engine: EngineClient,
  repo: ActiveRepo,
  message: string,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content: message,
    language: 'git-commit',
  });
  await vscode.window.showTextDocument(document);
  const commit = 'Commit Staged Changes';
  const choice = await vscode.window.showInformationMessage(
    'GitGlasses: edit the generated message, then commit the staged changes with it.',
    commit,
    'Copy Message',
  );
  const edited = document.getText().trim();
  if (choice === 'Copy Message') {
    await vscode.env.clipboard.writeText(edited);
    setStatus('commit message copied');
    return;
  }
  if (choice !== commit || edited === '') return;
  try {
    const { sha } = await engine.request('mutate/commit', { repoId: repo.repoId, message: edited });
    setStatus(`committed ${shortSha(sha)}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: commit failed: ${errorMessage(error)}`);
  }
}

// --- Natural-language search ---------------------------------------------------

// NL search results land in the Search & Compare view via the provider's
// runExternalSearch hook, labeled with the user's question. The QuickPick path
// below covers a host that wired in no view provider.
async function nlSearch(
  engine: EngineClient,
  repos: RepositoryService,
  ai: AiService,
  nextStreamId: () => string,
  searchView?: ExternalSearchTarget,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;
  const ready = await ai.prepare();
  if (!ready) return;
  const request = await vscode.window.showInputBox({
    prompt: 'Describe the commits to find: who, what, which files or code, and when',
    placeHolder: 'e.g. commits by alice about the login crash last month',
  });
  if (!request) return;

  // Code and file criteria need git log; dates work on every engine.
  const codeAndPaths = isMethodAvailable(engine.capabilities(), 'search/log');
  const raw = await ai.complete(ready, 'GitGlasses: translating search…', {
    system: nlSearchSystem(codeAndPaths),
    prompt: nlSearchPrompt(request, isoDay(new Date())),
    maxTokens: 300,
  });
  if (!raw) return;
  const parsed = parseNlSearchQuery(raw);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(
      `GitGlasses AI: could not parse a search query (${parsed.error}). Model reply: ${raw.slice(0, 200)}`,
    );
    return;
  }

  if (searchView) {
    await searchView.runExternalSearch(
      parsed.query,
      `for "${request}" (${describeQuery(parsed.query)})`,
    );
    return;
  }

  const matches: CommitSummaryInfo[] = [];
  let truncated: boolean;
  try {
    const request = {
      repoId: repo.repoId,
      streamId: nextStreamId(),
      limit: NL_SEARCH_LIMIT,
      query: parsed.query,
    };
    ({ truncated } = await searchCommitHistory(engine, request, (found) => matches.push(...found)));
  } catch (error) {
    void vscode.window.showWarningMessage(
      `GitGlasses: ${searchRefusal(error) ?? `commit search failed: ${errorMessage(error)}`}`,
    );
    return;
  }

  const queryLabel = describeQuery(parsed.query);
  if (matches.length === 0) {
    void vscode.window.showInformationMessage(`GitGlasses: no commits ${queryLabel}.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    matches.map((commit) => ({
      label: commit.summary,
      description: `${shortSha(commit.sha)} · ${commit.author.name}`,
      commit,
    })),
    {
      placeHolder: `${matches.length}${truncated ? '+' : ''} commits ${queryLabel}`,
      matchOnDescription: true,
    },
  );
  if (picked) {
    await vscode.commands.executeCommand(SHOW_COMMIT_DETAILS_COMMAND, {
      repoPath: repo.rootPath,
      sha: picked.commit.sha,
    });
  }
}

// --- Registration -----------------------------------------------------------

/** The slice of SearchViewProvider that NL search feeds results into. */
export interface ExternalSearchTarget {
  runExternalSearch(query: CommitSearchQuery, label: string): Promise<void>;
}

export function registerAiFeatures(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
  searchView?: ExternalSearchTarget,
  log: Log = () => undefined,
): vscode.Disposable[] {
  const ai = new AiService(context, log);
  const panel = new AiResultContentProvider();
  let streamCounter = 0;
  return [
    vscode.workspace.registerTextDocumentContentProvider(AI_SCHEME, panel),
    vscode.commands.registerCommand('gitglasses.ai.explainCommit', (node?: ViewNode) =>
      explainCommit(engine, repos, ai, panel, log, node),
    ),
    vscode.commands.registerCommand('gitglasses.ai.explainWip', () =>
      explainWip(engine, repos, ai, panel),
    ),
    vscode.commands.registerCommand(
      'gitglasses.ai.generateCommitMessage',
      (sourceControl?: { rootUri?: vscode.Uri }) =>
        generateCommitMessage(engine, repos, ai, log, sourceControl),
    ),
    vscode.commands.registerCommand('gitglasses.ai.nlSearch', () =>
      nlSearch(engine, repos, ai, () => `ai-search-${streamCounter++}`, searchView),
    ),
    ...registerAiAuthCommands(context, log),
  ];
}
