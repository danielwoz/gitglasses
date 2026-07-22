import * as vscode from 'vscode';
import { RepositoryService } from '../model/repositoryService';
import { encodeRevisionUri } from './revisionContentProvider';

// Supplies the "original" (HEAD) version of files so VS Code renders its
// native gutter change indicators from our engine instead of the built-in
// git extension (both can coexist; VS Code dedupes providers by URI).
export class GitGlassesQuickDiffProvider implements vscode.QuickDiffProvider {
  constructor(private readonly repos: RepositoryService) {}

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined;
    const located = this.repos.locate(uri);
    if (!located) return undefined;
    return encodeRevisionUri(located.repoId, located.relativePath, 'HEAD');
  }
}
