import * as vscode from 'vscode';
import type { PullRequest } from '@gitglasses/integrations';
import { EngineClient } from '@gitglasses/rpc';
import { shortSha } from '@gitglasses/protocol/sha';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, ViewBase, ViewNode, messageNode, withRepo } from '../views/viewBase';
import { commitNode } from '../views/nodes';
import type { LaunchpadService } from '../integrations/launchpadService';
import { BUCKET_LABELS } from '../integrations/launchpadLogic';
import { setStatus } from '../commands/ui';
import { relativeTime } from '../system/dates';
import { BranchStatus, branchCardDescription, glimpsePrs, showGetStarted } from './homeLogic';
import { conflictLabel } from '../model/conflictLogic';
import { allowedDespiteConflicts } from '../commands/conflictGuard';

const REFRESH_DEBOUNCE_MS = 300;
const RECENT_COMMITS = 5;

export const GET_STARTED_DISMISSED_KEY = 'gitglasses.home.getStartedDismissed';

function sectionNode(
  label: string,
  icon: string,
  children: ViewNode[],
  description?: string,
): ViewNode {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.description = description;
  item.contextValue = 'gitglassesHomeSection';
  return { item, children: () => children };
}

function actionNode(label: string, icon: string, command: string, args?: unknown[]): ViewNode {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = 'gitglassesHomeAction';
  item.command = { command, title: label, arguments: args };
  return { item };
}

function glimpsePrNode(bucket: string, pr: PullRequest): ViewNode {
  const item = new vscode.TreeItem(pr.title, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(
    bucket === 'blocked' ? 'error' : bucket === 'needs-your-review' ? 'code-review' : 'git-pull-request',
  );
  const updatedSeconds = Date.parse(pr.updatedAt) / 1000;
  const label = BUCKET_LABELS[bucket as keyof typeof BUCKET_LABELS] ?? bucket;
  item.description = `${label} · #${pr.number} · ${pr.repo.owner}/${pr.repo.name} · ${relativeTime(
    Number.isFinite(updatedSeconds) ? updatedSeconds : Date.now() / 1000,
  )}`;
  item.tooltip = `${pr.title}\n${pr.repo.owner}/${pr.repo.name}#${pr.number} by ${pr.author.username}\n${pr.url}`;
  item.contextValue = 'gitglassesHomePr';
  // Reuses the launchpad open handler, which reads `pr` off its argument.
  const node: ViewNode & { pr: PullRequest } = { item, pr };
  item.command = { command: 'gitglasses.launchpad.open', title: 'Open Pull Request', arguments: [node] };
  return node;
}

// An operation left unfinished: the conflicted files, each opening in the
// editor, under a section that says what has to happen next.
function conflictsSection(repo: ActiveRepo, conflicted: readonly string[]): ViewNode {
  const children = conflicted.map((file) => {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repo.rootPath), file);
    const item = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    item.iconPath = new vscode.ThemeIcon('warning');
    item.contextValue = 'gitglassesConflictedFile';
    item.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
    return { item };
  });
  const section = sectionNode(
    'Conflicts',
    'warning',
    children,
    `${conflictLabel(conflicted.length)} — resolve, stage, then continue`,
  );
  section.item.tooltip =
    'A merge, rebase or cherry-pick is unfinished. Resolve these files and stage ' +
    'them, then continue or abort the operation.';
  return section;
}

// Home: at-a-glance branch card with quick actions, a launchpad glimpse,
// recent commits, and a dismissible get-started section.
export class HomeViewProvider extends ViewBase {
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    engine: EngineClient,
    repos: RepositoryService,
    private readonly launchpad: LaunchpadService,
    private readonly globalState: vscode.Memento,
  ) {
    super(engine, repos);
    // Any repo change (HEAD, refs, index, stash, …) can move the branch card
    // or recent activity; debounce so bursts collapse into one refresh.
    this.disposables.push(
      this.engine.onNotification('repo/didChange', () => this.scheduleRefresh()),
    );
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    // The three sections read independent sources, so they are fetched
    // together: the view renders one round trip after the repo resolves.
    const [status, glimpse, recent] = await Promise.all([
      this.engine.request('status/summary', { repoId: repo.repoId }),
      this.launchpadGlimpse(),
      this.recentActivity(repo),
    ]);
    const nodes: ViewNode[] = [this.branchCard(status)];
    if (status.conflicted.length > 0) nodes.push(conflictsSection(repo, status.conflicted));
    nodes.push(glimpse);
    nodes.push(recent);
    if (showGetStarted(this.globalState.get<boolean>(GET_STARTED_DISMISSED_KEY))) {
      nodes.push(this.getStarted());
    }
    return nodes;
  }

  private branchCard(status: BranchStatus): ViewNode {
    const node = sectionNode(
      status.branch || 'HEAD (detached)',
      'git-branch',
      [
        actionNode('Commit…', 'check', 'gitglasses.gitCommands'),
        actionNode('Push', 'arrow-up', 'gitglasses.home.push'),
        actionNode('Pull', 'arrow-down', 'gitglasses.home.pull'),
        actionNode('Switch Branch…', 'arrow-swap', 'gitglasses.home.switchBranch'),
        actionNode('Create Branch…', 'add', 'gitglasses.home.createBranch'),
      ],
      branchCardDescription(status),
    );
    node.item.tooltip = [
      `Branch: ${status.branch || '(detached)'}`,
      `Upstream: ${status.upstream ?? 'none'}`,
      `Ahead ${status.ahead} / behind ${status.behind}`,
      `${status.conflicted.length} conflicted, ${status.staged.length} staged, ` +
        `${status.unstaged.length} unstaged, ${status.untracked.length} untracked`,
    ].join('\n');
    return node;
  }

  private async launchpadGlimpse(): Promise<ViewNode> {
    let children: ViewNode[];
    let description: string | undefined;
    try {
      const model = await this.launchpad.getModel();
      if (!model.connected) {
        children = [
          actionNode('Connect an integration…', 'plug', 'gitglasses.connectIntegration'),
        ];
      } else {
        const picked = glimpsePrs(model.groups);
        description = model.attentionCount > 0 ? `${model.attentionCount} need attention` : undefined;
        children =
          picked.length > 0
            ? picked.map(({ bucket, item }) => glimpsePrNode(bucket, item))
            : [messageNode('No open pull requests involving you')];
      }
    } catch {
      children = [messageNode('Launchpad unavailable')];
    }
    return sectionNode('Launchpad', 'rocket', children, description);
  }

  private async recentActivity(repo: ActiveRepo): Promise<ViewNode> {
    const { commits } = await this.engine.request('log/commits', {
      repoId: repo.repoId,
      limit: RECENT_COMMITS,
    });
    const children =
      commits.length > 0 ? commits.map(commitNode) : [messageNode('No commits yet')];
    return sectionNode('Recent Activity', 'history', children);
  }

  private getStarted(): ViewNode {
    return sectionNode('Get Started', 'star', [
      actionNode('Show Commit Graph', 'git-branch', 'gitglasses.showGraph'),
      actionNode('Toggle File Blame', 'eye', 'gitglasses.toggleFileBlame'),
      actionNode('Search Commits…', 'search', 'gitglasses.searchCommits'),
      actionNode('Show Visual File History', 'graph-scatter', 'gitglasses.showFileHistory'),
      actionNode('Dismiss', 'close', 'gitglasses.home.dismissGetStarted'),
    ]);
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    super.dispose();
  }
}

/** Home quick-action commands (branch card children + get-started dismissal). */
export function registerHomeCommands(
  engine: EngineClient,
  repos: RepositoryService,
  view: HomeViewProvider,
  globalState: vscode.Memento,
): vscode.Disposable[] {
  // The shared repo action, plus the card refresh every home action ends with.
  // Actions git refuses mid-conflict confirm first; push is not one of them.
  const onRepo = (
    label: string,
    action: (repo: ActiveRepo) => Promise<void>,
    options: { guardConflicts?: boolean } = {},
  ): Promise<void> =>
    withRepo(repos, label, async (repo) => {
      if (
        options.guardConflicts &&
        !(await allowedDespiteConflicts(engine, repo.repoId, label))
      ) {
        return;
      }
      await action(repo);
      view.refresh();
    });

  return [
    vscode.commands.registerCommand('gitglasses.home.push', () =>
      onRepo('push', async (repo) => {
        const status = await engine.request('status/summary', { repoId: repo.repoId });
        const setUpstream = !status.upstream;
        await engine.request('mutate/push', { repoId: repo.repoId, setUpstream });
        setStatus(`Pushed '${status.branch}'${setUpstream ? ' (set upstream)' : ''}`);
      }),
    ),
    vscode.commands.registerCommand('gitglasses.home.pull', () =>
      onRepo(
        'pull',
        async (repo) => {
          await engine.request('mutate/pull', { repoId: repo.repoId, autoStash: true });
          setStatus('Pulled (auto-stash)');
        },
        { guardConflicts: true },
      ),
    ),
    vscode.commands.registerCommand('gitglasses.home.switchBranch', () =>
      onRepo(
        'switch branch',
        async (repo) => {
          const { branches } = await engine.request('refs/list', { repoId: repo.repoId });
          const candidates = branches.filter((branch) => !branch.current);
          if (candidates.length === 0) {
            void vscode.window.showInformationMessage('GitGlasses: no other branches.');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            candidates.map((branch) => ({
              label: branch.name,
              description: shortSha(branch.sha),
            })),
            { placeHolder: 'Branch to switch to' },
          );
          if (!picked) return;
          await engine.request('mutate/switch', { repoId: repo.repoId, ref: picked.label });
          setStatus(`Switched to '${picked.label}'`);
        },
        { guardConflicts: true },
      ),
    ),
    vscode.commands.registerCommand('gitglasses.home.createBranch', () =>
      onRepo(
        'create branch',
        async (repo) => {
          const name = await vscode.window.showInputBox({
            prompt: 'Branch name',
            validateInput: (value) => (value.trim() ? undefined : 'Branch name is required'),
          });
          if (!name) return;
          await engine.request('mutate/branchCreate', {
            repoId: repo.repoId,
            name: name.trim(),
            checkout: true,
          });
          setStatus(`Created branch '${name.trim()}'`);
        },
        { guardConflicts: true },
      ),
    ),
    vscode.commands.registerCommand('gitglasses.home.dismissGetStarted', async () => {
      await globalState.update(GET_STARTED_DISMISSED_KEY, true);
      view.refresh();
    }),
  ];
}
