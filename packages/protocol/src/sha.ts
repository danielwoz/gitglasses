// Commit-sha vocabulary shared by the extension UI, the webviews and the MCP
// server, so the same commit renders identically everywhere. Its own entry
// point (@gitglasses/protocol/sha) keeps consumers off the schema barrel.

/** Hex characters in an abbreviated sha; matches git's default abbreviation. */
export const SHORT_SHA_LENGTH = 7;

/** SHA git uses for uncommitted (working tree / dirty buffer) lines. */
export const UNCOMMITTED_SHA = '0'.repeat(40);

/** `sha` abbreviated to SHORT_SHA_LENGTH characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}
