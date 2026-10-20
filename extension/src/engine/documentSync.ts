import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';

/** Largest buffer the engine keeps (kMaxDocBytes in the engine's
 *  doc_overlay.h); a larger one is dropped there, so it is never sent. */
export const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Which contents a blame of the document should describe. */
export type BufferState =
  /** The document matches the file on disk. */
  | { kind: 'disk' }
  /** The engine holds this buffer version. */
  | { kind: 'buffer'; version: number }
  /** The unsaved buffer is over MAX_BUFFER_BYTES: nothing describes it. */
  | { kind: 'tooLarge' }
  /** Not a document of a repository this host serves. */
  | { kind: 'unavailable' };

/** UTF-8 length of `text`, counted without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte character.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Whether `text` fits MAX_BUFFER_BYTES (or `limit`) once encoded. The
 *  length bounds settle most documents without a scan: a UTF-16 unit takes
 *  one to three UTF-8 bytes. */
export function fitsBufferLimit(text: string, limit: number = MAX_BUFFER_BYTES): boolean {
  if (text.length > limit) return false;
  if (text.length * 3 <= limit) return true;
  return utf8ByteLength(text) <= limit;
}

interface Pushed {
  repoId: string;
  path: string;
  version: number;
}

export interface DocumentSyncOptions {
  /** Documents this host serves. The node host serves file-scheme documents;
   *  the web host serves whatever its repository service locates. */
  accepts?(document: vscode.TextDocument): boolean;
  /** Largest buffer pushed; tests lower it. */
  maxBytes?: number;
}

// Keeps the engine's copy of unsaved editor buffers (doc/didChange) in step
// with what blame asks about. A buffer is pushed when a blame of it is about
// to be requested, never on a timer, so editing a file nobody blames costs
// nothing and a blame request always follows the push of the exact version
// it names. A buffer the engine holds is dropped (doc/didClose) as soon as
// the document matches the disk again: on save, on revert, on undo back to
// the saved text, and on close.
export class DocumentSync implements vscode.Disposable {
  /** Buffers the engine holds, by document uri. */
  private pushed = new Map<string, Pushed>();
  /** Pushes on their way, by document uri and version. */
  private inflight = new Map<string, Promise<BufferState>>();
  /** The last version of each document found too large to push, so asking
   *  again about the same version does not read the whole buffer again. */
  private tooLarge = new Map<string, number>();
  private disposables: vscode.Disposable[] = [];
  private readonly accepts: (document: vscode.TextDocument) => boolean;
  private readonly maxBytes: number;

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
    options: DocumentSyncOptions = {},
  ) {
    this.accepts = options.accepts ?? ((document) => document.uri.scheme === 'file');
    this.maxBytes = options.maxBytes ?? MAX_BUFFER_BYTES;
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onChanged(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.release(d)),
      vscode.workspace.onDidSaveTextDocument((d) => this.release(d)),
    );
  }

  /** Whether this host blames the document's working-tree file. */
  serves(document: vscode.TextDocument): boolean {
    return this.accepts(document);
  }

  /**
   * Makes sure the engine can blame what the document shows, and says which
   * contents to ask for: the file on disk for a clean document, or the buffer
   * version just pushed for a dirty one.
   */
  async sync(document: vscode.TextDocument): Promise<BufferState> {
    if (!this.accepts(document) || document.isClosed) return { kind: 'unavailable' };
    if (!document.isDirty) {
      this.release(document);
      return { kind: 'disk' };
    }
    const key = document.uri.toString();
    const version = document.version;
    if (this.pushed.get(key)?.version === version) return { kind: 'buffer', version };
    if (this.tooLarge.get(key) === version) return { kind: 'tooLarge' };
    const flightKey = `${key}\0${version}`;
    let flight = this.inflight.get(flightKey);
    if (!flight) {
      flight = this.push(document, key).finally(() => this.inflight.delete(flightKey));
      this.inflight.set(flightKey, flight);
    }
    return flight;
  }

  /** Forgets that the engine holds the document's buffer, so the next sync
   *  pushes it again (the engine answered for another version). */
  forget(document: vscode.TextDocument): void {
    this.pushed.delete(document.uri.toString());
  }

  /** After an engine respawn: the new engine holds no buffers. */
  resync(): void {
    this.pushed.clear();
  }

  // The repository is looked up when the buffer is sent, asking the engine
  // if the file's directory is new to it, so an edit in a submodule or nested
  // clone reaches that repository rather than the enclosing one.
  private async push(document: vscode.TextDocument, key: string): Promise<BufferState> {
    const located = await this.repos.locateOrDiscover(document.uri);
    if (!located || document.isClosed) return { kind: 'unavailable' };
    // Saved or reverted while the lookup ran: the disk is current again.
    if (!document.isDirty) {
      this.release(document);
      return { kind: 'disk' };
    }
    const contents = document.getText();
    const version = document.version;
    if (!fitsBufferLimit(contents, this.maxBytes)) {
      // The engine would drop it and blame the disk instead, which does not
      // describe these lines.
      this.release(document);
      this.tooLarge.set(key, version);
      return { kind: 'tooLarge' };
    }
    this.tooLarge.delete(key);
    this.engine.notify('doc/didChange', {
      repoId: located.repoId,
      path: located.relativePath,
      contents,
      version,
    });
    this.pushed.set(key, { repoId: located.repoId, path: located.relativePath, version });
    return { kind: 'buffer', version };
  }

  private onChanged(document: vscode.TextDocument): void {
    // Undo back to the saved text and Revert File leave a clean document.
    if (!document.isDirty) this.release(document);
  }

  /** Drops the engine's copy of the document's buffer, if it holds one. */
  private release(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.tooLarge.delete(key);
    const pushed = this.pushed.get(key);
    if (!pushed) return;
    this.pushed.delete(key);
    this.engine.notify('doc/didClose', { repoId: pushed.repoId, path: pushed.path });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.pushed.clear();
    this.inflight.clear();
    this.tooLarge.clear();
  }
}
