/** Helpers shared by the concrete provider implementations. */

import { AuthError, ProviderError, RateLimitError } from '../errors.js';
import type { HttpResponseLike } from '../http.js';
import { readRateLimitSignals } from '../rateLimitHeaders.js';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encode a UTF-8 string without relying on Buffer or btoa globals. */
export function base64Encode(input: string): string {
  const bytes: number[] = [];
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Rate-limit reset time from the common header spellings, when present. */
export function rateLimitResetTime(response: HttpResponseLike): Date | undefined {
  const { resetAt, retryAfterUntil } = readRateLimitSignals(response.headers, Date.now());
  const at = resetAt ?? retryAfterUntil;
  return at === undefined ? undefined : new Date(at);
}

/**
 * Map non-2xx responses to the typed provider errors: 401 becomes AuthError,
 * 429 (and rate-limited 403s) become RateLimitError, everything else
 * ProviderError. No-op for successful responses.
 */
export function throwForStatus(providerName: string, response: HttpResponseLike): void {
  if (response.ok) {
    return;
  }
  if (response.status === 401) {
    throw new AuthError(
      `${providerName} authentication failed (401): check the token and its scopes`
    );
  }
  if (response.status === 429) {
    throw new RateLimitError(
      `${providerName} rate limit exceeded`,
      rateLimitResetTime(response),
      429
    );
  }
  if (response.status === 403) {
    const remaining =
      response.headers.get('x-ratelimit-remaining') ?? response.headers.get('ratelimit-remaining');
    if (remaining === '0' || response.headers.get('retry-after') !== null) {
      throw new RateLimitError(
        `${providerName} rate limit exceeded`,
        rateLimitResetTime(response),
        403
      );
    }
    throw new ProviderError(`${providerName} request forbidden (403)`, 403);
  }
  throw new ProviderError(
    `${providerName} request failed with status ${response.status}`,
    response.status
  );
}

/**
 * Turn free text into a git-branch-safe slug: lowercase, non-alphanumerics
 * collapsed to single dashes, trimmed to `maxLength` without a trailing dash.
 */
export function slugify(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}

/** Hostname portion of an http(s) base URL, e.g. "gitlab.example.com". */
export function hostOfUrl(baseUrl: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/:]+)/i.exec(baseUrl);
  return (match?.[1] ?? baseUrl).toLowerCase();
}

/** True when both URLs share scheme, host and port. */
export function isSameOriginAs(candidate: string, reference: string): boolean {
  try {
    const a = new URL(candidate);
    const b = new URL(reference);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

/**
 * The origin github.com serves raw gist content from. Gist file bodies name it
 * in raw_url, and it is a different host from the API, so same-origin alone
 * would reject a legitimate response.
 */
export function isGistRawOrigin(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.host === 'gist.githubusercontent.com';
  } catch {
    return false;
  }
}

/** Escapes a value for use inside a double-quoted BBQL string literal. */
export function escapeBbqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * A bare hostname (no scheme, userinfo, path or whitespace), optionally with a
 * port. Config values reaching a base URL go through this: a value like
 * "api.example.com@attacker.example" reads as the real host but resolves
 * elsewhere, and would carry credentials there.
 */
export function assertPlainHost(value: string, what: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(value)) {
    throw new Error(`${what} must be a plain hostname, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A base URL that carries credentials: https, or http on loopback for a local
 * test instance. Plaintext elsewhere puts the token on the wire in the clear.
 */
export function assertSecureBaseUrl(baseUrl: string, what: string): string {
  const isHttps = /^https:\/\//i.test(baseUrl);
  const isLoopbackHttp = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
  if (!isHttps && !isLoopbackHttp) {
    throw new Error(
      `${what} must use https (loopback may use http), got ${JSON.stringify(baseUrl)}`
    );
  }
  return baseUrl;
}

/**
 * A short non-reversible fingerprint of a token, for use as a cache key.
 *
 * Keying a cache on the raw token keeps the secret resident in a long-lived
 * instance field and puts it in any heap dump. Only equality matters here, so
 * a digest does the same job.
 */
export function tokenFingerprint(token: string): string {
  // FNV-1a, 32-bit: not cryptographic, and it does not need to be — it never
  // leaves the process and only ever answers "is this the same token".
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
