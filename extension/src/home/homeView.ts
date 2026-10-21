import * as vscode from 'vscode';
import type { PullRequest } from '@gitglasses/integrations';
import { EngineClient } from '@gitglasses/rpc';
import { shortSha } from '@gitglasses/protocol/sha';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, ViewBase, ViewNode, messageNode, withRepo } from '../views/viewBase';
import type { LaunchpadService } from '../integrations/launchpadService';
import { BUCKET_LABELS } from '../integrations/launchpadLogic';
import { setStatus } from '../commands/ui';
import { relativeTime } from '../system/dates';
import {
  BranchAction,
  BranchStatus,
  HeadInfo,
  branchActionLabel,
  branchCardActions,
  branchCardDescription,
  branchCardTitle,
  glimpsePrs,
  showGetStarted,
} from './homeLogic';
import { conflictLabel } from '../model/conflictLogic';
import { allowedDespiteConflicts } from '../commands/conflictGuard';
import * as sync from '../sync/syncCommands';

const REFRESH_DEBOUNCE_MS = 300;

/** The command and icon behind each branch card action. */
const BRANCH_ACTIONS: Record<BranchAction, { command: string; icon: string }> = {
  commit: { command: 'gitglasses.gitCommands', icon: 'check' },
  push: { command: 'gitglasses.home.push', icon: 'arrow-up' },
  publish: { command: 'gitglasses.home.push', icon: 'cloud-upload' },
  pull: { command: 'gitglasses.home.pull', icon: 'arrow-down' },
  switchBranch: { command: 'gitglasses.home.switchBranch', icon: 'arrow-swap' },
  createBranch: { command: 'gitglasses.home.createBranch', icon: 'add' },
};

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
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repo.workspacePath ?? repo.rootPath), file);
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
// and a dismissible get-started section. Recent commits are the Commits
// view's job, right below.
export class HomeViewProvider extends ViewBase {
  private refreshTimer: NodeJS.Timeout | undefined;
  private extraSections: (() => ViewNode[]) | undefined;

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

  /** Sections a host adds below the launchpad glimpse, re-read on refresh. */
  setExtraSections(sections: () => ViewNode[]): void {
    this.extraSections = sections;
    this.refresh();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    // The sections read independent sources, so they are fetched together:
    // the view renders one round trip after the repo resolves.
    const [status, state, remotes, glimpse] = await Promise.all([
      this.engine.request('status/summary', { repoId: repo.repoId }),
      this.engine.request('repo/state', { repoId: repo.repoId }),
      this.engine.request('remote/list', { repoId: repo.repoId }),
      this.launchpadGlimpse(),
    ]);
    const nodes: ViewNode[] = [this.branchCard(status, state.head, remotes.remotes.length > 0)];
    if (status.conflicted.length > 0) nodes.push(conflictsSection(repo, status.conflicted));
    nodes.push(glimpse);
    nodes.push(...(this.extraSections?.() ?? []));
    if (showGetStarted(this.globalState.get<boolean>(GET_STARTED_DISMISSED_KEY))) {
      nodes.push(this.getStarted());
    }
    return nodes;
  }

  private branchCard(status: BranchStatus, head: HeadInfo, hasRemote: boolean): ViewNode {
    const actions = branchCardActions(status, head, hasRemote).map((action) =>
      actionNode(
        branchActionLabel(action, status),
        BRANCH_ACTIONS[action].icon,
        BRANCH_ACTIONS[action].command,
      ),
    );
    const node = sectionNode(
      branchCardTitle(status, head),
      head.detached ? 'git-commit' : 'git-branch',
      actions,
      branchCardDescription(status, head),
    );
    const branchLine = head.unborn
      ? `Branch: ${head.branch || '(unnamed)'}, no commits yet`
      : head.detached
        ? `HEAD detached at ${head.oid}`
        : `Branch: ${status.branch}`;
    const upstreamLines = head.unborn || head.detached
      ? []
      : [`Upstream: ${status.upstream ?? 'none'}`, `Ahead ${status.ahead} / behind ${status.behind}`];
    node.item.tooltip = [
      branchLine,
      ...upstreamLines,
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
  // A failure report's next step passes the repository the failed action
  // ran on (`target`); otherwise the action runs on the active repository.
  const onRepo = (
    label: string,
    action: (repo: ActiveRepo) => Promise<void>,
    options: { guardConflicts?: boolean; target?: unknown } = {},
  ): Promise<void> =>
    withRepo(
      repos,
      label,
      async (repo) => {
        if (
          options.guardConflicts &&
          !(await allowedDespiteConflicts(engine, repo.repoId, label))
        ) {
          return;
        }
        await action(repo);
        view.refresh();
      },
      sync.repoArgument(options.target),
    );

  return [
    vscode.commands.registerCommand('gitglasses.home.push', (target?: unknown) =>
      onRepo('push', (repo) => sync.push(engine, repo), { target }),
    ),
    vscode.commands.registerCommand('gitglasses.home.pull', (target?: unknown) =>
      onRepo('pull', (repo) => sync.pull(engine, repo), { guardConflicts: true, target }),
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
