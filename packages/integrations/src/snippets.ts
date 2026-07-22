/**
 * Snippet transport: create/read shareable text snippets (GitHub Gists,
 * GitLab snippets) so patch envelopes can be shared by URL. Providers opt in
 * by implementing SnippetHost; callers feature-detect with supportsSnippets.
 */

import type { AuthContext } from './hostingProvider.js';

export interface SnippetCreateOptions {
  /** File name inside the snippet, e.g. "patch.ggpatch". */
  filename: string;
  /** Full text content of the snippet file. */
  content: string;
  /** Human-readable description/title shown by the host. */
  description?: string;
  /**
   * Create the snippet unlisted (default true). On GitHub this maps to a
   * secret gist: not listed publicly, but readable by anyone with the URL.
   */
  secret?: boolean;
  /**
   * GitLab-only visibility level (default "private"). Note that a *private*
   * GitLab snippet is visible only to its author — the URL is NOT shareable
   * with arbitrary users (unlike a secret gist). Pass "internal" to share
   * within the instance or "public" for anyone with the link.
   */
  visibility?: 'private' | 'internal' | 'public';
}

export interface SnippetRef {
  /** Browser URL of the created snippet. */
  url: string;
  /** Host-native snippet id. */
  id: string;
}

/** Additive capability interface for providers that can host snippets. */
export interface SnippetHost {
  createSnippet(auth: AuthContext, options: SnippetCreateOptions): Promise<SnippetRef>;
  /** Fetch a snippet's raw text content by id or by any recognized URL form. */
  getSnippet(auth: AuthContext, idOrUrl: string): Promise<string>;
}

/** True when the provider implements the SnippetHost capability. */
export function supportsSnippets<T extends object>(provider: T): provider is T & SnippetHost {
  const candidate = provider as Partial<SnippetHost>;
  return (
    typeof candidate.createSnippet === 'function' && typeof candidate.getSnippet === 'function'
  );
}

const GIST_ID = /^[0-9a-f]{5,64}$/i;

/**
 * Extract a gist id from a raw id or any common gist URL form:
 * gist.github.com/<id>, gist.github.com/<user>/<id>[#file-...],
 * api.github.com/gists/<id>, gist.githubusercontent.com raw URLs.
 */
export function parseGistId(idOrUrl: string): string | undefined {
  const trimmed = idOrUrl.trim();
  if (GIST_ID.test(trimmed) && !trimmed.includes('.')) {
    return trimmed.toLowerCase();
  }
  const match = /^https?:\/\/([^/?#]+)\/([^?#]*)/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const host = match[1].toLowerCase();
  const segments = match[2].split('/').filter((s) => s !== '');
  // API URLs carry the id right after a "gists" segment.
  const gistsIndex = segments.indexOf('gists');
  if (gistsIndex >= 0) {
    const candidate = segments[gistsIndex + 1];
    return candidate !== undefined && GIST_ID.test(candidate)
      ? candidate.toLowerCase()
      : undefined;
  }
  if (!host.startsWith('gist.')) {
    return undefined;
  }
  // gist.github.com/<user>/<id> — the id is the second segment when present.
  const candidate =
    segments.length >= 2 && GIST_ID.test(segments[1]) ? segments[1] : segments[0];
  return candidate !== undefined && GIST_ID.test(candidate) ? candidate.toLowerCase() : undefined;
}

/**
 * Extract a GitLab snippet id from a raw numeric id or a snippet URL:
 * <host>/-/snippets/<id>, legacy <host>/snippets/<id>, or a project snippet
 * <host>/<group>/<project>/-/snippets/<id> (optionally with a /raw suffix).
 */
export function parseGitLabSnippetId(idOrUrl: string): string | undefined {
  const trimmed = idOrUrl.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  const match = /^https?:\/\/[^/?#]+\/([^?#]*)/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const segments = match[1].split('/').filter((s) => s !== '');
  const snippetsIndex = segments.lastIndexOf('snippets');
  if (snippetsIndex < 0) {
    return undefined;
  }
  const candidate = segments[snippetsIndex + 1];
  return candidate !== undefined && /^\d+$/.test(candidate) ? candidate : undefined;
}
