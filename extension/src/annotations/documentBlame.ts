import * as vscode from 'vscode';
import type { CancellationLike } from '@gitglasses/rpc';
import { BlameModel, FileBlame, ON_DISK_VERSION, StaleBlameError } from '../model/blameModel';
import { RepositoryService } from '../model/repositoryService';
import type { BufferState } from '../engine/documentSync';
import { decodeRevisionUri } from '../scm/revisionContentProvider';
import {
  BLAME_SETTINGS,
  BlameSettings,
  parseBlameSettings,
  ATTRIBUTION_SETTINGS,
} from './blameSettings';

/** The scheme of revision documents (see revisionContentProvider). */
const REVISION_SCHEME = 'gitglasses';

/** What a blame of a document is about. */
export interface BlameTarget {
  repoId: string;
  /** Repository root; empty when the host cannot tell. */
  rootPath: string;
  relativePath: string;
  /** The revision a revision document shows; absent for the working tree. */
  rev?: string;
}

export type DocumentBlameResult =
  | { kind: 'blame'; blame: FileBlame; target: BlameTarget }
  /** Unsaved changes too large for the engine to hold: blame is paused
   *  until the document is saved. */
  | { kind: 'tooLarge'; target: BlameTarget }
  /** Nothing to show: no repository, an untracked file, or a failure (which
   *  BlameModel logs). */
  | { kind: 'none' };

/** The part of DocumentSync blame needs. */
export interface BufferSync {
  serves(document: vscode.TextDocument): boolean;
  sync(document: vscode.TextDocument): Promise<BufferState>;
  forget(document: vscode.TextDocument): void;
}

function readSettings(): BlameSettings {
  const config = vscode.workspace.getConfiguration('gitglasses');
  return parseBlameSettings((key) => config.get(key));
}

// The one way every blame surface (current line, hover, file annotations,
// CodeLens, status bar) gets the blame of a document: it locates the
// repository, makes sure the engine holds the exact buffer shown when the
// document has unsaved changes, and asks for that buffer by version, so no
// surface can describe one buffer with the blame of another. Revision
// documents blame at their revision.
export class DocumentBlameService implements vscode.Disposable {
  private current = readSettings();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when a blame setting changes; attribution changes have already
   *  dropped the cached blame by then. */
  readonly onDidChangeSettings = this.emitter.event;
  private readonly configListener: vscode.Disposable;

  constructor(
    private readonly model: BlameModel,
    private readonly repos: RepositoryService,
    private readonly buffers: BufferSync,
  ) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!BLAME_SETTINGS.some((section) => e.affectsConfiguration(section))) return;
      this.current = readSettings();
      if (ATTRIBUTION_SETTINGS.some((section) => e.affectsConfiguration(section))) {
        this.model.invalidate();
      }
      this.emitter.fire();
    });
  }

  /** Whether blame can describe the document: a working-tree file the host
   *  serves, or a revision document. */
  supports(document: vscode.TextDocument): boolean {
    return document.uri.scheme === REVISION_SCHEME || this.buffers.serves(document);
  }

  get settings(): BlameSettings {
    return this.current;
  }

  async blameDocument(
    document: vscode.TextDocument,
    token?: CancellationLike,
  ): Promise<DocumentBlameResult> {
    try {
      if (document.uri.scheme === REVISION_SCHEME) return await this.blameRevision(document, token);
      if (!this.buffers.serves(document)) return { kind: 'none' };
      return await this.blameWorkingTree(document, token);
    } catch {
      return { kind: 'none' };
    }
  }

  private async blameRevision(
    document: vscode.TextDocument,
    token?: CancellationLike,
  ): Promise<DocumentBlameResult> {
    const decoded = decodeRevisionUri(document.uri);
    if (!decoded) return { kind: 'none' };
    const target: BlameTarget = {
      repoId: decoded.repoId,
      rootPath: this.repos.rootOf(decoded.repoId) ?? '',
      relativePath: decoded.relativePath,
      rev: decoded.rev,
    };
    const blame = await this.model.getBlame(
      {
        repoId: target.repoId,
        path: target.relativePath,
        version: ON_DISK_VERSION,
        rev: target.rev,
        options: this.current.options,
      },
      token,
    );
    return { kind: 'blame', blame, target };
  }

  private async blameWorkingTree(
    document: vscode.TextDocument,
    token?: CancellationLike,
  ): Promise<DocumentBlameResult> {
    const located = await this.repos.locateOrDiscover(document.uri);
    if (!located || token?.isCancellationRequested) return { kind: 'none' };
    const target: BlameTarget = {
      repoId: located.repoId,
      rootPath: located.rootPath,
      relativePath: located.relativePath,
    };
    // One retry: an answer for another buffer means the engine lost the one
    // pushed (evicted under its memory budget), so it is pushed again.
    for (let attempt = 0; ; attempt++) {
      const state = await this.buffers.sync(document);
      if (state.kind === 'unavailable') return { kind: 'none' };
      if (state.kind === 'tooLarge') return { kind: 'tooLarge', target };
      try {
        const blame = await this.model.getBlame(
          {
            repoId: target.repoId,
            path: target.relativePath,
            version: state.kind === 'buffer' ? state.version : ON_DISK_VERSION,
            options: this.current.options,
          },
          token,
        );
        return { kind: 'blame', blame, target };
      } catch (error) {
        if (!(error instanceof StaleBlameError) || attempt > 0) throw error;
        this.buffers.forget(document);
      }
    }
  }

  dispose(): void {
    this.configListener.dispose();
    this.emitter.dispose();
  }
}
