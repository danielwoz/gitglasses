// Repository service for the web host. The engine sees the MEMFS mirror
// (mount path), while VS Code documents live in the workspace folder's URI
// space, so location is a straight prefix mapping instead of fsPath walking.
//
// Matching is scheme-agnostic on purpose: real documents carry the workspace
// folder's scheme (file: on vscode.dev local folders, vscode-test-web: under
// the test harness), while shared helpers like firstWorkspaceRepo probe with
// synthetic file:// URIs built from fsPath — both share the same path space.

import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { LocatedFile, RepositoryService } from '../model/repositoryService';

export class WebRepositoryService extends RepositoryService {
  private readonly folderPath: string;
  private repoId: string | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly client: EngineClient,
    folderPath: string,
    private readonly mountPath: string,
  ) {
    super(client);
    this.folderPath = folderPath.endsWith('/')
      ? folderPath.slice(0, -1)
      : folderPath;
  }

  private relativeOf(uri: vscode.Uri): string | undefined {
    const p = uri.path;
    if (p === this.folderPath) return '';
    if (!p.startsWith(`${this.folderPath}/`)) return undefined;
    return p.slice(this.folderPath.length + 1);
  }

  override locate(uri: vscode.Uri): LocatedFile | undefined {
    if (!this.repoId) return undefined;
    const relativePath = this.relativeOf(uri);
    if (relativePath === undefined) return undefined;
    return { repoId: this.repoId, rootPath: this.mountPath, relativePath };
  }

  override async locateOrDiscover(
    uri: vscode.Uri,
  ): Promise<LocatedFile | undefined> {
    if (this.relativeOf(uri) === undefined) return undefined;
    await this.discover();
    return this.locate(uri);
  }

  /** Discovers the mirrored repo once; concurrent callers coalesce. */
  async discover(): Promise<void> {
    if (this.repoId) return;
    this.inflight ??= this.client
      .request('repo/discover', { path: this.mountPath })
      .then((info) => {
        this.repoId = info.repoId;
      })
      .catch(() => undefined)
      .finally(() => {
        this.inflight = undefined;
      });
    await this.inflight;
  }

  /** After an engine respawn the fresh module re-mirrors the workspace and
   *  repo ids reset; discover again against the same mount. */
  override async rediscoverAll(): Promise<void> {
    this.repoId = undefined;
    this.inflight = undefined;
    await this.discover();
  }
}
