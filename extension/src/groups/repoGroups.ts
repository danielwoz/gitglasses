import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  RepoGroup,
  parseRepoGroups,
  serializeRepoGroups,
  workspaceFileContents,
  workspaceFileName,
} from './groupsLogic';

const STORAGE_KEY = 'gitglasses.repoGroups';

// Named repo groups persisted in globalState (Settings Sync enabled). A group
// opens as a generated multi-root .code-workspace in a new window, which
// leaves the current window's folder set untouched.
export class RepoGroupsManager {
  constructor(private readonly context: vscode.ExtensionContext) {
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
