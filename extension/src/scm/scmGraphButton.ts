// The Commit Graph button in Source Control's title bar. VS Code runs it
// with the source control whose title bar holds the button, so in a
// workspace with several repositories the graph opens on that one. It
// becomes the repository the GitGlasses views follow too, since the graph
// and the sidebar always describe the same repository.

import * as vscode from 'vscode';

export const SCM_SHOW_GRAPH_COMMAND = 'gitglasses.scm.showGraph';

/** A child name that never exists: the repository lookup asks about a
 *  file's directory, so asking about this child asks about the root. */
const PROBE = '.gitglasses';

/** The root of the source control a Source Control title action ran on. A
 *  host that passes no source control, or one from another extension host
 *  (which arrives as a bare handle), gives none. */
export function sourceControlRoot(arg: unknown): vscode.Uri | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined;
  const rootUri = (arg as { rootUri?: unknown }).rootUri;
  if (typeof rootUri !== 'object' || rootUri === null) return undefined;
  const { scheme, fsPath } = rootUri as Partial<vscode.Uri>;
  return typeof scheme === 'string' && typeof fsPath === 'string'
    ? (rootUri as vscode.Uri)
    : undefined;
}

export interface ScmGraphDeps {
  /** The repository at a file's location, discovering it if needed. */
  locateOrDiscover(uri: vscode.Uri): Promise<{ repoId: string; rootPath: string } | undefined>;
  /** The repository the views follow. */
  activeRepoId(): Promise<string | undefined>;
  /** Makes the repository at `rootPath` the one the views follow. */
  setActive(rootPath: string): Promise<void>;
  log(line: string): void;
}

/** Opens the Commit Graph on the source control's repository, or on the
 *  views' repository when the host does not say which one was clicked. */
export async function showGraphForSourceControl(arg: unknown, deps: ScmGraphDeps): Promise<void> {
  const root = sourceControlRoot(arg);
  if (root) {
    try {
      const repo = await deps.locateOrDiscover(vscode.Uri.joinPath(root, PROBE));
      if (!repo) {
        deps.log(`Source Control graph button: no repository at ${root.fsPath}`);
      } else if (repo.repoId !== (await deps.activeRepoId())) {
        await deps.setActive(repo.rootPath);
      }
    } catch (error) {
      deps.log(`Source Control graph button: could not open ${root.fsPath}: ${String(error)}`);
    }
  }
  await vscode.commands.executeCommand('gitglasses.showGraph');
}

export function registerScmGraphButton(deps: ScmGraphDeps): vscode.Disposable {
  return vscode.commands.registerCommand(SCM_SHOW_GRAPH_COMMAND, (arg?: unknown) =>
    showGraphForSourceControl(arg, deps),
  );
}
