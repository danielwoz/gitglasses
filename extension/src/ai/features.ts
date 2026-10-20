import * as vscode from 'vscode';
import { CommitDetails, CommitSummaryInfo, DiffHunk, ErrorCodes } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { requireRepo, ViewNode } from '../views/viewBase';
import { errorMessage, setStatus } from '../commands/ui';
import { openCommitDoc } from '../views/nodes';
import { shortSha } from '@gitglasses/protocol/sha';
import { AI_PROVIDER_LABELS, AiProvider, AiProviderId, CompletionRequest } from './aiProvider';
import { registerAiAuthCommands } from './aiAuth';
import { chooseProvider, ensureAiReady } from './aiSetup';
import { buildDiffContext, DiffFile, splitPatch } from './contextBuilder';
import { unifiedDiff } from './lineDiff';
import { parseNlSearchQuery } from './nlQuery';
import {
  COMMIT_MESSAGE_SYSTEM,
  commitMessagePrompt,
  EXPLAIN_COMMIT_SYSTEM,
  explainCommitPrompt,
  EXPLAIN_WIP_SYSTEM,
  explainWipPrompt,
  NL_SEARCH_SYSTEM,
  nlSearchPrompt,
} from './prompts';

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
 *  built-in markdown preview (falling back to a text editor). */
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
    this.contents.set(uri.path, markdown);
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

/** The commit's diff computed here from each file's two versions, for
 *  engines that cannot run git (Restricted Mode, no git CLI, the web). */
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
  for (const change of details.files.slice(0, MAX_CONTEXT_FILES)) {
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
 *  can run git, otherwise computed from the file versions. */
async function collectCommitDiff(
  engine: EngineClient,
  repoId: string,
  details: CommitDetails,
  log: Log,
): Promise<DiffFile[]> {
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
    `# ${details.subject}\n\n\`${details.sha}\` — ${details.author.name}\n\n${result}\n`,
  );
}

// --- Explain Working Changes -------------------------------------------------

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
  const collectSide = async (paths: string[], staged: boolean): Promise<void> => {
    for (const path of paths.slice(0, MAX_CONTEXT_FILES)) {
      try {
        const { hunks } = await engine.request('diff/fileHunks', { repoId, path, staged });
        if (hunks.length > 0) {
          add(path, `${staged ? '(staged)' : '(unstaged)'}\n${hunksToPatch(hunks)}`);
        }
      } catch {
        add(path, staged ? '(staged; diff unavailable)' : '(unstaged; diff unavailable)');
      }
    }
  };
  await collectSide(
    status.staged.map((change) => change.path),
    true,
  );
  await collectSide(
    status.unstaged.map((change) => change.path),
    false,
  );
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
    `# Working changes on ${status.branch}\n\n${result}\n`,
  );
}

async function generateCommitMessage(
  engine: EngineClient,
  repos: RepositoryService,
  ai: AiService,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;
  let status;
  try {
    status = await engine.request('status/summary', { repoId: repo.repoId });
  } catch (error) {
    void vscode.window.showWarningMessage(`GitGlasses: status failed: ${errorMessage(error)}`);
    return;
  }
  if (status.staged.length === 0) {
    void vscode.window.showInformationMessage(
      'GitGlasses: nothing staged — stage changes before generating a commit message.',
    );
    return;
  }
  const ready = await ai.prepare();
  if (!ready) return;
  const files: DiffFile[] = [];
  for (const change of status.staged.slice(0, MAX_CONTEXT_FILES)) {
    try {
      const { hunks } = await engine.request('diff/fileHunks', {
        repoId: repo.repoId,
        path: change.path,
        staged: true,
      });
      files.push({ path: change.path, patch: hunksToPatch(hunks) });
    } catch {
      files.push({
        path: change.path,
        patch: `status: ${change.status}  +${change.additions} −${change.deletions}`,
      });
    }
  }
  const context = buildDiffContext(files, CONTEXT_BUDGET_TOKENS);

  for (;;) {
    const raw = await ai.complete(ready, 'GitGlasses: generating commit message…', {
      system: COMMIT_MESSAGE_SYSTEM,
      prompt: commitMessagePrompt(context.text),
      maxTokens: 400,
    });
    if (!raw) return;
    const message = stripCodeFences(raw);
    const firstLine = message.split('\n', 1)[0];
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(check) Use this message…', description: firstLine, action: 'use' as const },
        { label: '$(refresh) Regenerate', action: 'regenerate' as const },
        { label: '$(close) Cancel', action: 'cancel' as const },
      ],
      { placeHolder: firstLine },
    );
    if (!choice || choice.action === 'cancel') return;
    if (choice.action === 'regenerate') continue;
    // Never commit unreviewed: the message lands in an editable input first.
    const edited = await vscode.window.showInputBox({
      prompt: 'Commit message (Enter commits the staged changes)',
      value: message,
      ignoreFocusOut: true,
    });
    if (edited === undefined || edited.trim() === '') return;
    try {
      const { sha } = await engine.request('mutate/commit', {
        repoId: repo.repoId,
        message: edited,
      });
      setStatus(`committed ${shortSha(sha)}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`GitGlasses: commit failed: ${errorMessage(error)}`);
    }
    return;
  }
}

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
    prompt: 'Describe the commits to find',
    placeHolder: 'e.g. commits by alice about the login crash last month',
  });
  if (!request) return;

  const raw = await ai.complete(ready, 'GitGlasses: translating search…', {
    system: NL_SEARCH_SYSTEM,
    prompt: nlSearchPrompt(request),
    maxTokens: 200,
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
    await searchView.runExternalSearch(parsed.query, `NL: "${request}"`);
    return;
  }

  const streamId = nextStreamId();
  const matches: CommitSummaryInfo[] = [];
  const sub = engine.onNotification('search/matches', (params) => {
    if (params.streamId === streamId) matches.push(...params.matches);
  });
  let truncated: boolean;
  try {
    const result = await engine.request('search/commits', {
      repoId: repo.repoId,
      streamId,
      limit: NL_SEARCH_LIMIT,
      query: parsed.query,
    });
    truncated = result.truncated;
  } catch (error) {
    void vscode.window.showWarningMessage(
      `GitGlasses: commit search failed: ${errorMessage(error)}`,
    );
    return;
  } finally {
    sub.dispose();
  }

  const queryLabel = [
    parsed.query.text && `text: "${parsed.query.text}"`,
    parsed.query.author && `author: "${parsed.query.author}"`,
    parsed.query.sha && `sha: ${parsed.query.sha}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (matches.length === 0) {
    void vscode.window.showInformationMessage(`GitGlasses: no commits matched (${queryLabel}).`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    matches.map((commit) => ({
      label: commit.summary,
      description: `${shortSha(commit.sha)} · ${commit.author.name}`,
      commit,
    })),
    {
      placeHolder: `${matches.length}${truncated ? '+' : ''} matches for ${queryLabel}`,
      matchOnDescription: true,
    },
  );
  if (picked) await openCommitDoc(picked.commit);
}

// --- Registration -----------------------------------------------------------

/** The slice of SearchViewProvider that NL search feeds results into. */
export interface ExternalSearchTarget {
  runExternalSearch(
    query: { text?: string; author?: string; sha?: string },
    label: string,
  ): Promise<void>;
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
    vscode.commands.registerCommand('gitglasses.ai.generateCommitMessage', () =>
      generateCommitMessage(engine, repos, ai),
    ),
    vscode.commands.registerCommand('gitglasses.ai.nlSearch', () =>
      nlSearch(engine, repos, ai, () => `ai-search-${streamCounter++}`, searchView),
    ),
    ...registerAiAuthCommands(context, log),
  ];
}
