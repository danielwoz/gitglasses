import * as vscode from 'vscode';
import { RepositoryService } from '../model/repositoryService';
import { encodeRevisionUri } from './revisionContentProvider';

// Supplies the "original" (HEAD) version of files so VS Code renders its
// native gutter change indicators from our engine instead of the built-in
// git extension (both can coexist; VS Code dedupes providers by URI).
export class GitGlassesQuickDiffProvider implements vscode.QuickDiffProvider {
  constructor(private readonly repos: RepositoryService) {}

  // Asks the engine when the file's directory is new to it: before that, a
  // file in a submodule or nested clone would match the enclosing repository.
  async provideOriginalResource(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const located = await this.repos.locateOrDiscover(uri);
    if (!located) return undefined;
    return encodeRevisionUri(located.repoId, located.relativePath, 'HEAD');
  }
}
