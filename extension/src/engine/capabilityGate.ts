// Capability-based feature gating. Pure logic (no vscode imports) so the
// method matrix and the watch-fallback change detection are unit-testable.

import { EngineCapabilities, RESTRICTED_MODE_METHODS } from '@gitglasses/protocol';

/** User-facing explanation for gitCli-gated features. */
export const CLI_UNAVAILABLE_MESSAGE =
  'Requires the git CLI — not available in this engine build';

/** User-facing explanation for features Restricted Mode turns off. */
export const RESTRICTED_MESSAGE =
  'Not available in Restricted Mode — trust this folder to let GitGlasses run git';

const RESTRICTED_MODE_SERVED: ReadonlySet<string> = new Set(RESTRICTED_MODE_METHODS);

// Method families the engine can only serve by shelling out to git.
const CLI_METHOD_PREFIXES = ['mutate/', 'rebase/', 'patch/', 'branch/', 'tag/'];
const CLI_METHODS = new Set([
  'remote/add',
  'remote/remove',
  'stash/push',
  'stash/apply',
  'stash/drop',
  'worktree/add',
  'worktree/remove',
  'history/file',
  'history/line',
]);

/** True when the method needs the gitCli capability to work. */
export function requiresGitCli(method: string): boolean {
  if (CLI_METHODS.has(method)) return true;
  return CLI_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/** Whether the engine can serve `method`. A Restricted Mode engine serves
 *  only RESTRICTED_MODE_METHODS. Unknown capabilities (before the initialize
 *  handshake) mean "allow" — the engine's -32003 or -32004 answer is the
 *  backstop. */
export function isMethodAvailable(
  caps: EngineCapabilities | undefined,
  method: string,
): boolean {
  if (caps === undefined) return true;
  if (caps.restricted === true) return RESTRICTED_MODE_SERVED.has(method);
  if (!requiresGitCli(method)) return true;
  return caps.gitCli !== false;
}

/** Why isMethodAvailable() said no, for the user. */
export function unavailableMessage(caps: EngineCapabilities | undefined): string {
  return caps?.restricted === true ? RESTRICTED_MESSAGE : CLI_UNAVAILABLE_MESSAGE;
}

/** HEAD-oid change detection for the watch:false fallback poller. Records the
 *  latest observed oid per repo; update() is true only when a repo's oid
 *  differs from a previously observed one (first sight is not a change). */
export class HeadChangeTracker {
  private lastOids = new Map<string, string>();

  update(repoId: string, oid: string): boolean {
    const previous = this.lastOids.get(repoId);
    this.lastOids.set(repoId, oid);
    return previous !== undefined && previous !== oid;
  }

  reset(): void {
    this.lastOids.clear();
  }
}
