import * as vscode from 'vscode';
import { CommitSummaryInfo, DiffHunk } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { requireRepo, ViewNode } from '../views/viewBase';
import { errorMessage, setStatus } from '../commands/ui';
import { openCommitDoc } from '../views/nodes';
import { shortSha } from '@gitglasses/protocol/sha';
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_LABELS,
  AiProviderId,
  CompletionRequest,
  requiresConsent,
} from './aiProvider';
import { registerAiAuthCommands } from './aiAuth';
import { buildDiffContext, DiffFile } from './contextBuilder';
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
import { createAiProvider } from './providers';

const CONTEXT_BUDGET_TOKENS = 6000;
const MAX_CONTEXT_FILES = 30;
/** Cap per-file content pulled for commit explanation before budgeting. */
const MAX_FILE_CONTENT_CHARS = 20_000;
const NL_SEARCH_LIMIT = 100;

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

// --- Provider dispatch, consent, progress -----------------------------------

class AiService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  providerId(): AiProviderId {
    const raw = vscode.workspace
      .getConfiguration('gitglasses.ai')
      .get<string>('provider', 'vscode-lm');
    return (AI_PROVIDER_IDS as readonly string[]).includes(raw)
      ? (raw as AiProviderId)
      : 'vscode-lm';
  }

  private consentKey(id: AiProviderId): string {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'no-workspace';
    return `gitglasses.ai.consent:${id}:${workspace}`;
  }

  /** First-use confirmation per workspace before diffs leave the machine.
   *  Ollama (local) and vscode-lm (an already-consented surface) skip it. */
  private async ensureConsent(id: AiProviderId): Promise<boolean> {
    if (!requiresConsent(id)) return true;
    const key = this.consentKey(id);
    if (this.context.globalState.get<boolean>(key) === true) return true;
    const choice = await vscode.window.showWarningMessage(
      `Send code diffs to ${AI_PROVIDER_LABELS[id]}? They leave your machine.`,
      { modal: true },
      'Send',
    );
    if (choice !== 'Send') return false;
    await this.context.globalState.update(key, true);
    return true;
  }

  /** Runs a completion with consent, progress, and cancellation. Returns
   *  undefined when declined, cancelled, or failed (already reported). */
  async complete(title: string, req: CompletionRequest): Promise<string | undefined> {
    const id = this.providerId();
    if (!(await this.ensureConsent(id))) return undefined;
    const provider = createAiProvider(id, this.context.secrets);
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => provider.complete(req, token),
      );
    } catch (error) {
      if (!isCancellation(error)) {
        void vscode.window.showErrorMessage(`GitGlasses AI: ${errorMessage(error)}`);
      }
      return undefined;
    }
  }
}

// --- Features ---------------------------------------------------------------

async function resolveCommit(
  engine: EngineClient,
  repoId: string,
  node?: ViewNode,
): Promise<CommitSummaryInfo | undefined> {
  let ref = node?.sha;
  if (!ref) {
    ref = await vscode.window.showInputBox({
      prompt: 'Commit to explain (sha, branch, tag, HEAD~n…)',
      value: 'HEAD',
    });
  }
  if (!ref) return undefined;
  try {
    const { commits } = await engine.request('log/commits', { repoId, ref, limit: 1 });
    return commits[0];
  } catch (error) {
    void vscode.window.showWarningMessage(`GitGlasses: cannot resolve "${ref}": ${errorMessage(error)}`);
    return undefined;
  }
}

/** The engine has no per-commit patch-text method (diff/commit returns the
 *  file list only), so commit context = change stats plus the file contents at
 *  the commit; the context builder budgets/truncates the result. */
async function collectCommitFiles(
  engine: EngineClient,
  repoId: string,
  commit: CommitSummaryInfo,
): Promise<DiffFile[]> {
  const { files } = await engine.request('diff/commit', { repoId, sha: commit.sha });
  const collected: DiffFile[] = [];
  for (const change of files.slice(0, MAX_CONTEXT_FILES)) {
    let patch = `status: ${change.status}  +${change.additions} −${change.deletions}`;
    if (change.origPath) patch += `  (from ${change.origPath})`;
    if (change.status !== 'D') {
      try {
        const { contents } = await engine.request('rev/fileAtRev', {
          repoId,
          path: change.path,
          rev: commit.sha,
        });
        patch += `\ncontents at ${shortSha(commit.sha)}:\n${contents.slice(0, MAX_FILE_CONTENT_CHARS)}`;
      } catch {
        // Binary or unreadable at this rev; the stats line still helps.
      }
    }
    collected.push({ path: change.path, patch });
  }
  if (files.length > MAX_CONTEXT_FILES) {
    collected.push({
      path: '…',
      patch: `(${files.length - MAX_CONTEXT_FILES} additional changed files not shown)`,
    });
  }
  return collected;
}

async function explainCommit(
  engine: EngineClient,
  repos: RepositoryService,
  ai: AiService,
  panel: AiResultContentProvider,
  node?: ViewNode,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;
  const commit = await resolveCommit(engine, repo.repoId, node);
  if (!commit) return;

  let files: DiffFile[];
  try {
    files = await collectCommitFiles(engine, repo.repoId, commit);
  } catch (error) {
    void vscode.window.showWarningMessage(`GitGlasses: commit diff failed: ${errorMessage(error)}`);
    return;
  }
  const context = buildDiffContext(files, CONTEXT_BUDGET_TOKENS);
  const prompt = explainCommitPrompt(
    {
      sha: commit.sha,
      author: `${commit.author.name} <${commit.author.email}>`,
      date: new Date(commit.author.time * 1000).toISOString(),
      summary: commit.summary,
    },
    context.text,
  );
  const sha7 = shortSha(commit.sha);
  const result = await ai.complete(`GitGlasses: explaining ${sha7}…`, {
    system: EXPLAIN_COMMIT_SYSTEM,
    prompt,
    maxTokens: 1024,
  });
  if (!result) return;
  await panel.show(
    `Explain: ${sha7}`,
    `# ${commit.summary}\n\n\`${commit.sha}\` — ${commit.author.name}\n\n${result}\n`,
  );
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
  const context = buildDiffContext(collected.files, CONTEXT_BUDGET_TOKENS);
  const result = await ai.complete('GitGlasses: explaining working changes…', {
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
    const raw = await ai.complete('GitGlasses: generating commit message…', {
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
  const request = await vscode.window.showInputBox({
    prompt: 'Describe the commits to find',
    placeHolder: 'e.g. commits by alice about the login crash last month',
  });
  if (!request) return;

  const raw = await ai.complete('GitGlasses: translating search…', {
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
  let truncated = false;
  try {
    const result = await engine.request('search/commits', {
      repoId: repo.repoId,
      streamId,
      limit: NL_SEARCH_LIMIT,
      query: parsed.query,
    });
    truncated = result.truncated;
  } catch (error) {
    void vscode.window.showWarningMessage(`GitGlasses: commit search failed: ${errorMessage(error)}`);
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
): vscode.Disposable[] {
  const ai = new AiService(context);
  const panel = new AiResultContentProvider();
  let streamCounter = 0;
  return [
    vscode.workspace.registerTextDocumentContentProvider(AI_SCHEME, panel),
    vscode.commands.registerCommand('gitglasses.ai.explainCommit', (node?: ViewNode) =>
      explainCommit(engine, repos, ai, panel, node),
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
    ...registerAiAuthCommands(context),
  ];
}
