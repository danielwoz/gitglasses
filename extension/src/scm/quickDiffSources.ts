import * as vscode from 'vscode';
import { RepositoryService, defaultCaseInsensitive } from '../model/repositoryService';
import type { WorkspaceRepo } from '../model/activeRepo';
import { GitGlassesQuickDiffProvider } from './quickDiffProvider';
import { planQuickDiffSources } from './quickDiffPlan';

// Quick diff (the gutter's change markers and "Open Changes" peek) for hosts
// that run without VS Code's Git extension, such as the web. Where that
// extension runs it already provides quick diff, and a second source control
// would compete with it for the SCM view: the Source Control Graph, the
// repository picker and the status bar's branch and sync items follow the
// selected provider. So nothing is registered there.

export const BUILTIN_GIT_EXTENSION_ID = 'vscode.git';

/** Whether VS Code's own Git extension is installed (it may still be turned
 *  off with git.enabled, in which case it registers no quick diff either,
 *  but a user who switched it off does not want another provider). */
export function hasBuiltinGit(): boolean {
  return vscode.extensions.getExtension(BUILTIN_GIT_EXTENSION_ID) !== undefined;
}

function rootKey(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return defaultCaseInsensitive() ? slashed.toLowerCase() : slashed;
}

/** One source control per repository, each scoped to its root and carrying
 *  nothing but the quick diff provider. */
export class QuickDiffSources implements vscode.Disposable {
  private readonly controls = new Map<string, vscode.SourceControl>();
  private readonly provider: GitGlassesQuickDiffProvider;
  private readonly subscription: vscode.Disposable;
  private disposed = false;

  constructor(
    repos: RepositoryService,
    private readonly listRepos: () => Promise<readonly WorkspaceRepo[]>,
    onDidChangeRepos: vscode.Event<void>,
    private readonly log: (line: string) => void,
  ) {
    this.provider = new GitGlassesQuickDiffProvider(repos);
    this.subscription = onDidChangeRepos(() => void this.sync());
  }

  /** Brings the source controls in line with the workspace's repositories. */
  async sync(): Promise<void> {
    let list: readonly WorkspaceRepo[];
    try {
      list = await this.listRepos();
    } catch (error) {
      this.log(`quick diff: could not list repositories: ${String(error)}`);
      return;
    }
    if (this.disposed) return;
    const plan = planQuickDiffSources(this.controls.keys(), list, (repo) =>
      rootKey(repo.workspacePath),
    );
    for (const key of plan.remove) {
      this.controls.get(key)?.dispose();
      this.controls.delete(key);
    }
    for (const repo of plan.add) {
      const control = vscode.scm.createSourceControl(
        'gitglasses',
        'GitGlasses',
        vscode.Uri.file(repo.workspacePath),
      );
      control.quickDiffProvider = this.provider;
      control.inputBox.visible = false;
      this.controls.set(rootKey(repo.workspacePath), control);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    for (const control of this.controls.values()) control.dispose();
    this.controls.clear();
  }
}
