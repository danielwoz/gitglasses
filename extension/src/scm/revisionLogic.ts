// Pure revision classification for the gitglasses: documents (no vscode
// imports).

/** A full SHA-1 or SHA-256 object id, optionally followed by ancestry steps
 *  (`~2`, `^`, `^2`), which can only ever name the same commit. */
const FIXED_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:[~^]\d*)*$/i;

/**
 * Whether a revision always names the same content. HEAD, branches, tags,
 * the index (`:0`, `:path`), reflog entries and abbreviated ids can come to
 * name something else after a commit, checkout, reset, stash or fetch, so
 * documents showing them must be read again when the repository changes.
 */
export function isFixedRevision(rev: string): boolean {
  return FIXED_REVISION.test(rev.trim());
}
