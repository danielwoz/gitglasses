// Declared provenance of commits, asked of the engine (commit/provenance) in
// batches and kept per repository, for every surface that shows commits. It
// asks nothing while gitglasses.provenance.enabled is off, so turning the
// setting off hides provenance everywhere at once.

import * as vscode from 'vscode';
import { UNCOMMITTED_SHA, type CommitProvenance } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import { isMethodAvailable } from '../engine/capabilityGate';
import { PROVENANCE_SETTING, batches } from './provenanceLogic';

/** Commits per commit/provenance request; the engine takes up to 1000. */
const BATCH_SIZE = 500;
/** Commits whose provenance is kept, across repositories. */
const MAX_CACHED = 5000;

const FULL_SHA = /^[0-9a-f]{40}$/;

export class ProvenanceService implements vscode.Disposable {
  /** repoId\0sha -> provenance, or null for a sha the repository lacks. */
  private readonly cache = new Map<string, CommitProvenance | null>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private reportedFailure = false;

  /** Fires when the setting is turned on or off. */
  readonly onDidChangeEnabled = this.changed.event;

  constructor(
    private readonly engine: EngineClient,
    private readonly log: (line: string) => void,
  ) {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`gitglasses.${PROVENANCE_SETTING}`)) this.changed.fire();
      }),
      // A fetch can bring git-ai notes for commits already shown.
      engine.onNotification('repo/didChange', (params) => {
        if (Array.isArray(params?.changed) && params.changed.includes('refs')) {
          this.forget(params.repoId);
        }
      }),
    );
  }

  /** Whether provenance is shown at all. */
  enabled(): boolean {
    return (
      vscode.workspace.getConfiguration('gitglasses').get<boolean>(PROVENANCE_SETTING, true) !==
      false
    );
  }

  /** What the commits in `shas` declare, for those the repository has. Empty
   *  while the setting is off, or when the engine cannot answer (the failure
   *  is logged once). */
  async lookup(repoId: string, shas: readonly string[]): Promise<Map<string, CommitProvenance>> {
    const found = new Map<string, CommitProvenance>();
    if (!this.enabled() || !isMethodAvailable(this.engine.capabilities(), 'commit/provenance')) {
      return found;
    }
    const missing: string[] = [];
    for (const sha of shas) {
      if (!FULL_SHA.test(sha) || sha === UNCOMMITTED_SHA) continue;
      const cached = this.cache.get(this.key(repoId, sha));
      if (cached === undefined) missing.push(sha);
      else if (cached !== null) found.set(sha, cached);
    }
    for (const batch of batches(missing, BATCH_SIZE)) {
      let commits: Record<string, CommitProvenance>;
      try {
        ({ commits } = await this.engine.request('commit/provenance', { repoId, shas: batch }));
      } catch (error) {
        if (!this.reportedFailure) {
          this.reportedFailure = true;
          this.log(
            `provenance: reading what commits declare failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return found;
      }
      for (const sha of batch) {
        const provenance = commits[sha] ?? null;
        // A note whose content a partial clone left out is read once the
        // content arrives, which moves no ref, so that answer is not kept.
        if (!provenance?.note?.missing) this.remember(this.key(repoId, sha), provenance);
        if (provenance) found.set(sha, provenance);
      }
    }
    return found;
  }

  /** What one commit declares, or undefined. */
  async get(repoId: string, sha: string): Promise<CommitProvenance | undefined> {
    return (await this.lookup(repoId, [sha])).get(sha);
  }

  /** Drops what is kept for a repository, or for every repository. */
  forget(repoId?: string): void {
    if (repoId === undefined) {
      this.cache.clear();
      return;
    }
    const prefix = `${repoId}\0`;
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private key(repoId: string, sha: string): string {
    return `${repoId}\0${sha}`;
  }

  private remember(key: string, provenance: CommitProvenance | null): void {
    this.cache.delete(key);
    this.cache.set(key, provenance);
    if (this.cache.size > MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
