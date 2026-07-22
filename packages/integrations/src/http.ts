/**
 * Minimal structural HTTP types so the package needs neither DOM lib types nor
 * any HTTP library. The Node 20+ global fetch satisfies these shapes.
 */

export interface HttpHeadersLike {
  get(name: string): string | null;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: HttpHeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** The runtime's global fetch, typed to the minimal shape above. */
export const defaultFetch: FetchLike = (
  globalThis as unknown as { fetch: FetchLike }
).fetch;

/** Header lookup over either a Headers-like object or a plain record (case-insensitive). */
export function headerGetter(
  headers: HttpHeadersLike | Record<string, string>
): (name: string) => string | undefined {
  if (typeof (headers as HttpHeadersLike).get === 'function') {
    const h = headers as HttpHeadersLike;
    return (name) => h.get(name) ?? undefined;
  }
  const record = headers as Record<string, string>;
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    lowered.set(key.toLowerCase(), value);
  }
  return (name) => lowered.get(name.toLowerCase());
}
