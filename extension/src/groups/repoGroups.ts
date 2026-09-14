import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import {
  ExportedRepo,
  RepoGroup,
  groupExportFileName,
  parseGroupExport,
  parseRepoGroups,
  repoDirNameFromUrl,
  serializeGroupExport,
  serializeRepoGroups,
  uniqueGroupName,
  workspaceFileContents,
  workspaceFileName,
} from './groupsLogic';

const STORAGE_KEY = 'gitglasses.repoGroups';

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

// Named repo groups persisted in globalState (Settings Sync enabled). A group
// opens as a generated multi-root .code-workspace in a new window, which
// leaves the current window's folder set untouched. Groups can be shared as
// .ggworkspace files carrying remote URLs (portable) with path fallbacks.
export class RepoGroupsManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {
    context.globalState.setKeysForSync([STORAGE_KEY]);
  }

  private load(): RepoGroup[] {
    return parseRepoGroups(this.context.globalState.get(STORAGE_KEY));
  }

  private save(groups: readonly RepoGroup[]): Thenable<void> {
    return this.context.globalState.update(STORAGE_KEY, serializeRepoGroups(groups));
  }

  async create(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === 'file',
    );
    if (folders.length === 0) {
      void vscode.window.showWarningMessage(
        'GitGlasses: open a folder before creating a repo group.',
      );
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: 'Repo group name',
      placeHolder: 'e.g. frontend + api',
      validateInput: (value) => (value.trim() ? undefined : 'Name is required'),
    });
    if (!name) return;

    const groups = this.load();
    groups.push({
      id: randomUUID().slice(0, 8),
      name: name.trim(),
      repos: folders.map((folder) => ({ path: folder.uri.fsPath })),
    });
    await this.save(groups);
    void vscode.window.showInformationMessage(
      `GitGlasses: created repo group "${name.trim()}" with ${folders.length} folder${
        folders.length === 1 ? '' : 's'
      }.`,
    );
  }

  async open(): Promise<void> {
    const group = await this.pickGroup('Open repo group');
    if (!group) return;

    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const fileUri = vscode.Uri.joinPath(this.context.globalStorageUri, workspaceFileName(group));
    await vscode.workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(workspaceFileContents(group)),
    );
    await vscode.commands.executeCommand('vscode.openFolder', fileUri, { forceNewWindow: true });
  }

  async delete(): Promise<void> {
    const group = await this.pickGroup('Delete repo group');
    if (!group) return;
    await this.save(this.load().filter((candidate) => candidate.id !== group.id));
    void vscode.window.showInformationMessage(`GitGlasses: deleted repo group "${group.name}".`);
  }

  /** The repo's origin fetch URL via engine remote/list, when discoverable. */
  private async remoteUrlFor(repoPath: string): Promise<string | undefined> {
    try {
      // locateOrDiscover keys discovery on the parent directory, so a
      // synthetic child path discovers the folder itself.
      const probe = vscode.Uri.file(path.join(repoPath, '.gitglasses'));
      const located = await this.repos.locateOrDiscover(probe);
      if (!located) return undefined;
      const { remotes } = await this.engine.request('remote/list', { repoId: located.repoId });
      const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
      return origin?.fetchUrl || undefined;
    } catch {
      return undefined;
    }
  }

  /** Export a group as a shareable .ggworkspace file (remote URLs preferred). */
  async export(): Promise<void> {
    const group = await this.pickGroup('Export repo group');
    if (!group) return;

    const exported: ExportedRepo[] = [];
    for (const repo of group.repos) {
      const remoteUrl = await this.remoteUrlFor(repo.path);
      exported.push(remoteUrl ? { remoteUrl } : { path: repo.path });
    }

    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', groupExportFileName(group.name))),
      filters: { 'GitGlasses Repo Group': ['ggworkspace'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(serializeGroupExport(group.name, exported)),
    );
    void vscode.window.showInformationMessage(
      `GitGlasses: exported repo group "${group.name}" to ${target.fsPath}.`,
    );
  }

  /** Resolve one imported repo entry to a local path (clone/locate/skip). */
  private async resolveImportedRepo(repo: ExportedRepo): Promise<string | undefined> {
    if (repo.path && (await pathExists(repo.path))) return repo.path;

    const what = repo.remoteUrl ?? repo.path ?? '';
    interface Action extends vscode.QuickPickItem {
      id: 'clone' | 'locate' | 'skip';
    }
    const actions: Action[] = [];
    if (repo.remoteUrl) {
      actions.push({ id: 'clone', label: '$(repo-clone) Clone…', description: repo.remoteUrl });
    }
    actions.push(
      { id: 'locate', label: '$(folder-opened) Locate…', description: 'pick an existing local copy' },
      { id: 'skip', label: '$(close) Skip', description: 'leave this repo out of the group' },
    );
    const action = await vscode.window.showQuickPick(actions, {
      placeHolder: `Repo not found locally: ${what}`,
      ignoreFocusOut: true,
    });
    if (!action || action.id === 'skip') return undefined;

    if (action.id === 'clone' && repo.remoteUrl) {
      const parent = await vscode.window.showInputBox({
        prompt: `Directory to clone ${repo.remoteUrl} into`,
        value: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          ? path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath)
          : '',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Enter a directory'),
      });
      if (!parent) return undefined;
      // The engine has no clone method; delegate to the built-in git
      // extension's clone command, which clones <parent>/<repo-name>.
      try {
        await vscode.commands.executeCommand('git.clone', repo.remoteUrl, parent.trim());
      } catch {
        void vscode.window.showWarningMessage(
          `GitGlasses: cloning ${repo.remoteUrl} failed or was cancelled; the repo was skipped.`,
        );
        return undefined;
      }
      return path.join(parent.trim(), repoDirNameFromUrl(repo.remoteUrl));
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: `Locate the local copy of ${what}`,
    });
    return picked?.[0]?.fsPath;
  }

  /** Import a .ggworkspace file, resolving each repo to a local folder. */
  async import(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'GitGlasses Repo Group': ['ggworkspace', 'json'], 'All Files': ['*'] },
    });
    if (!picked?.[0]) return;
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(picked[0]));

    const parsed = parseGroupExport(text);
    if (!parsed.ok) {
      void vscode.window.showErrorMessage(`GitGlasses: cannot import group — ${parsed.error}.`);
      return;
    }

    const resolvedPaths: string[] = [];
    for (const repo of parsed.repos) {
      const resolved = await this.resolveImportedRepo(repo);
      if (resolved) resolvedPaths.push(resolved);
    }
    if (resolvedPaths.length === 0) {
      void vscode.window.showWarningMessage(
        'GitGlasses: no repos were resolved, so the group was not created.',
      );
      return;
    }

    const groups = this.load();
    const name = uniqueGroupName(parsed.name, groups.map((group) => group.name));
    groups.push({
      id: randomUUID().slice(0, 8),
      name,
      repos: resolvedPaths.map((repoPath) => ({ path: repoPath })),
    });
    await this.save(groups);
    void vscode.window.showInformationMessage(
      `GitGlasses: imported repo group "${name}" with ${resolvedPaths.length} repo${
        resolvedPaths.length === 1 ? '' : 's'
      }${resolvedPaths.length < parsed.repos.length ? ` (${parsed.repos.length - resolvedPaths.length} skipped)` : ''}.`,
    );
  }

  private async pickGroup(placeHolder: string): Promise<RepoGroup | undefined> {
    const groups = this.load();
    if (groups.length === 0) {
      void vscode.window.showInformationMessage('GitGlasses: no repo groups yet.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: group.name,
        description: `${group.repos.length} folder${group.repos.length === 1 ? '' : 's'}`,
        detail: group.repos.map((repo) => repo.path).join(', '),
        group,
      })),
      { placeHolder },
    );
    return picked?.group;
  }
}
