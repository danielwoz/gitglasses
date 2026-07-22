/** Helpers shared by the concrete provider implementations. */

import { AuthError, ProviderError, RateLimitError } from '../errors.js';
import type { HttpResponseLike } from '../http.js';

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

function epochDate(value: string): Date | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  // Values above ~5000 AD in seconds are treated as millisecond timestamps.
  return new Date(n > 1e11 ? n : n * 1000);
}

/** Rate-limit reset time from the common header spellings, when present. */
export function rateLimitResetTime(response: HttpResponseLike): Date | undefined {
  for (const header of ['x-ratelimit-reset', 'ratelimit-reset', 'x-ratelimit-requests-reset']) {
    const value = response.headers.get(header);
    if (value !== null) {
      const date = epochDate(value);
      if (date) {
        return date;
      }
    }
  }
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return new Date(Date.now() + seconds * 1000);
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return new Date(dateMs);
    }
  }
  return undefined;
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
