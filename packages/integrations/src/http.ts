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
  /** Aborts the request; defaultFetch supplies one when none is given. */
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** Ceiling on a single provider request. Node's fetch has no total timeout. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Largest response body accepted. Provider payloads are pages of PRs and
 * issues; 16 MiB is far above any legitimate one.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The runtime's global fetch, with a total timeout and a response size bound.
 * A declared content-length over the bound fails the request before the body
 * is read. Redirects keep the runtime default ('follow'), which strips
 * Authorization on a cross-origin hop.
 */
export const defaultFetch: FetchLike = async (url, init) => {
  const rawFetch = (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch;

  // Only owned when we create it, so a caller-supplied signal is not cancelled.
  const controller = init?.signal ? undefined : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(new Error('request timed out')), DEFAULT_HTTP_TIMEOUT_MS)
    : undefined;
  // Node returns a Timeout with unref(); browsers return a number without it.
  (timer as unknown as { unref?: () => void } | undefined)?.unref?.();

  try {
    const response = await rawFetch(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal ?? controller?.signal,
    } as RequestInit);

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`response too large: ${declared} bytes`);
    }
    return boundedResponse(response as unknown as HttpResponseLike);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Wraps a response so json()/text() refuse an oversized body even when no
 * content-length was declared (chunked responses omit it). The runtime has
 * buffered the whole body by the time its length is known, so the bound
 * governs what reaches the caller and what gets parsed as JSON.
 */
function boundedResponse(response: HttpResponseLike): HttpResponseLike {
  let cached: string | undefined;
  const readText = async (): Promise<string> => {
    if (cached !== undefined) return cached;
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new Error(`response too large: ${body.length} bytes`);
    }
    cached = body;
    return body;
  };
  return {
    get ok() {
      return response.ok;
    },
    get status() {
      return response.status;
    },
    headers: response.headers,
    text: readText,
    json: async () => JSON.parse(await readText()) as unknown,
  };
}

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
