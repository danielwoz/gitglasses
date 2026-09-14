import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';

const DEBOUNCE_MS = 150;

// Pushes unsaved buffer contents to the engine's overlay store so blame
// reflects what the user sees. Full-content push, debounced; incremental
// sync can replace it behind the same interface later.
export class DocumentSync implements vscode.Disposable {
  private timers = new Map<string, NodeJS.Timeout>();
  private dirtyDocs = new Set<string>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onChanged(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.onClosed(d)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSaved(d)),
    );
  }

  /** Re-push all dirty overlays (after an engine respawn). */
  resync(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty) this.onChanged(doc);
    }
  }

  private onChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' || !document.isDirty) return;
    const located = this.repos.locate(document.uri);
    if (!located) return;

    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.dirtyDocs.add(key);
        this.engine.notify('doc/didChange', {
          repoId: located.repoId,
          path: located.relativePath,
          contents: document.getText(),
          version: document.version,
        });
      }, DEBOUNCE_MS),
    );
  }

  private onClosed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (!this.dirtyDocs.delete(key)) return;
    const located = this.repos.locate(document.uri);
    if (!located) return;
    this.engine.notify('doc/didClose', {
      repoId: located.repoId,
      path: located.relativePath,
    });
  }

  private onSaved(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.dirtyDocs.delete(key);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
  }
}
