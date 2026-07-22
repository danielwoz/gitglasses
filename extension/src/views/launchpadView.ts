import * as vscode from 'vscode';
import type { PullRequest } from '@gitglasses/integrations';
import { BUCKET_LABELS } from '../integrations/launchpadLogic';
import type { LaunchpadModel, LaunchpadService } from '../integrations/launchpadService';
import type { IntegrationService } from '../integrations/integrationService';
import { relativeTime } from '../system/dates';

const REFRESH_INTERVAL_MS = 60_000;

export interface LaunchpadNode {
  item: vscode.TreeItem;
  pr?: PullRequest;
  children?: LaunchpadNode[];
}

function messageNode(message: string): LaunchpadNode {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  return { item };
}

function prIcon(pr: PullRequest): vscode.ThemeIcon {
  if (pr.draft) return new vscode.ThemeIcon('git-pull-request-draft');
  if (pr.state === 'merged') return new vscode.ThemeIcon('git-merge');
  if (pr.state === 'closed') return new vscode.ThemeIcon('git-pull-request-closed');
  if (pr.checksStatus === 'failing') return new vscode.ThemeIcon('error');
  return new vscode.ThemeIcon('git-pull-request');
}

function prNode(pr: PullRequest, snoozed: boolean): LaunchpadNode {
  const item = new vscode.TreeItem(pr.title, vscode.TreeItemCollapsibleState.None);
  item.iconPath = prIcon(pr);
  const updatedSeconds = Date.parse(pr.updatedAt) / 1000;
  item.description = `#${pr.number} · ${pr.repo.owner}/${pr.repo.name} · ${relativeTime(
    Number.isFinite(updatedSeconds) ? updatedSeconds : Date.now() / 1000,
  )}`;
  item.tooltip = `${pr.title}\n${pr.repo.owner}/${pr.repo.name}#${pr.number} by ${pr.author.username}\n${pr.url}`;
  item.contextValue = snoozed ? 'gitglassesLaunchpadSnoozedPr' : 'gitglassesLaunchpadPr';
  const node: LaunchpadNode = { item, pr };
  item.command = {
    command: 'gitglasses.launchpad.open',
    title: 'Open Pull Request',
    arguments: [node],
  };
  return node;
}

class LaunchpadViewProvider implements vscode.TreeDataProvider<LaunchpadNode> {
  private readonly emitter = new vscode.EventEmitter<LaunchpadNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private model: LaunchpadModel | undefined;
  private loading = false;

  constructor(
    private readonly service: LaunchpadService,
    private readonly onModel: (model: LaunchpadModel) => void,
  ) {}

  /** Fetch (through the service's cache) and re-render. */
  async reload(force = false): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.model = await this.service.getModel(force);
      this.onModel(this.model);
    } catch {
      this.model = { connected: false, groups: [], attentionCount: 0 };
    } finally {
      this.loading = false;
      this.emitter.fire(undefined);
    }
  }

  getTreeItem(node: LaunchpadNode): vscode.TreeItem {
    return node.item;
  }

  getChildren(node?: LaunchpadNode): LaunchpadNode[] {
    if (node) return node.children ?? [];
    if (!this.model) {
      void this.reload();
      return [messageNode('Loading…')];
    }
    if (!this.model.connected) {
      return [messageNode('No integrations connected — run "GitGlasses: Connect Integration"')];
    }
    if (this.model.groups.length === 0) {
      return [messageNode('No open pull requests involving you')];
    }
    return this.model.groups.map((group) => {
      const item = new vscode.TreeItem(
        BUCKET_LABELS[group.bucket],
        group.bucket === 'snoozed'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(group.items.length);
      item.contextValue = 'gitglassesLaunchpadGroup';
      return {
        item,
        children: group.items.map((pr) => prNode(pr, group.bucket === 'snoozed')),
      };
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Launchpad tree view, status bar item, refresh loop, and commands. */
export function registerLaunchpad(
  service: LaunchpadService,
  integrations: IntegrationService,
): vscode.Disposable[] {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.name = 'GitGlasses Launchpad';
  statusBar.command = 'gitglasses.views.launchpad.focus';

  const provider = new LaunchpadViewProvider(service, (model) => {
    if (!model.connected) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(rocket) ${model.attentionCount}`;
    statusBar.tooltip = `GitGlasses Launchpad: ${model.attentionCount} PR${
      model.attentionCount === 1 ? '' : 's'
    } need attention`;
    statusBar.show();
  });

  const view = vscode.window.createTreeView('gitglasses.views.launchpad', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Refresh only while the view is visible, and back off when the window
  // itself is unfocused (avoid burning API quota in idle windows).
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const startTimer = (): void => {
    stopTimer();
    timer = setInterval(() => {
      if (!vscode.window.state.focused) return;
      void provider.reload();
    }, REFRESH_INTERVAL_MS);
  };
  const visibility = view.onDidChangeVisibility((e) => {
    if (e.visible) {
      void provider.reload();
      startTimer();
    } else {
      stopTimer();
    }
  });
  if (view.visible) startTimer();

  // One startup populate so the status bar count exists before the view is
  // ever opened; hidden entirely while nothing is connected.
  void provider.reload();

  return [
    view,
    statusBar,
    visibility,
    { dispose: () => stopTimer() },
    { dispose: () => provider.dispose() },
    integrations.onDidChange(() => void provider.reload(true)),
    vscode.commands.registerCommand('gitglasses.launchpad.refresh', () => provider.reload(true)),
    vscode.commands.registerCommand('gitglasses.launchpad.open', (node?: LaunchpadNode) => {
      if (node?.pr) void vscode.env.openExternal(vscode.Uri.parse(node.pr.url));
    }),
    vscode.commands.registerCommand('gitglasses.launchpad.copyUrl', async (node?: LaunchpadNode) => {
      if (!node?.pr) return;
      await vscode.env.clipboard.writeText(node.pr.url);
      vscode.window.setStatusBarMessage(`Copied ${node.pr.url}`, 3000);
    }),
    vscode.commands.registerCommand('gitglasses.launchpad.snooze', async (node?: LaunchpadNode) => {
      if (!node?.pr) return;
      await service.snooze(node.pr.id);
      await provider.reload();
    }),
    vscode.commands.registerCommand(
      'gitglasses.launchpad.unsnooze',
      async (node?: LaunchpadNode) => {
        if (!node?.pr) return;
        await service.unsnooze(node.pr.id);
        await provider.reload();
      },
    ),
  ];
}
