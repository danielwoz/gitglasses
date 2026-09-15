// Pure worktree presentation helpers (no vscode imports) so the tree labels
// and default paths stay unit-testable.

import { shortSha } from '@gitglasses/protocol/sha';

function stripTrailingSeparators(p: string): string {
  const stripped = p.replace(/[\\/]+$/, '');
  return stripped === '' ? p : stripped;
}

/** Directory basename of a worktree path (either separator style). */
export function worktreeLabel(worktreePath: string): string {
  const trimmed = stripTrailingSeparators(worktreePath);
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** `branch@sha7` (or `detached@sha7`), with the current worktree marked. */
export function worktreeDescription(
  worktree: { branch?: string; sha: string },
  current: boolean,
): string {
  const base = `${worktree.branch ?? 'detached'}@${shortSha(worktree.sha)}`;
  return current ? `${base} (current)` : base;
}

/** Path equality ignoring trailing separators and separator style. */
export function isSameWorktreePath(a: string, b: string): boolean {
  const normalize = (p: string): string =>
    stripTrailingSeparators(p).replace(/\\/g, '/');
  return normalize(a) === normalize(b);
}

/** Suggested location for a new worktree: a `<repo>-<ref>` sibling directory
 *  of the repository root, with ref characters unsafe in paths replaced. */
export function defaultWorktreePath(repoRoot: string, ref: string): string {
  const name = worktreeLabel(repoRoot);
  const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `../${name}-${safeRef}`;
}
