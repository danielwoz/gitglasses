// Workspace trust and the engine. In an untrusted workspace (Restricted Mode)
// the engine is started with --restricted and runs no git process, so nothing
// a repository's config, attributes or hooks name can run. Granting trust
// restarts it as a full engine. Pure logic (no vscode imports) so the restart
// sequencing is unit-testable.

import type { EngineCapabilities } from '@gitglasses/protocol';

/** The slice of EngineClient the trust wiring drives. */
export interface TrustEngine {
  start(): Promise<void>;
  restart(): Promise<void>;
  capabilities(): EngineCapabilities | undefined;
}

/**
 * The handler for a trust grant: waits for any start in progress, then
 * replaces a restricted engine with a full one and reloads what the old one
 * served. The transport reads the workspace's trust at each spawn, so the
 * restart is what lifts the restriction. Concurrent grants share one restart,
 * and an engine that is already unrestricted is left alone.
 */
export function createTrustGrantHandler(
  engine: TrustEngine,
  reload: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    try {
      await engine.start();
    } catch {
      // A failed start leaves no engine to replace; restart() spawns afresh.
    }
    if (engine.capabilities()?.restricted === false) return;
    await engine.restart();
    await reload();
  };
  return () => {
    pending ??= run().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
