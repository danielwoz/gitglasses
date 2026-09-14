/** Shared HTTP transport and small companions used by every provider. */

import { TtlCache, type Clock } from '../cache.js';
import { ProviderError } from '../errors.js';
import type { AuthContext } from '../hostingProvider.js';
import type { FetchLike, HttpResponseLike } from '../http.js';
import { assertSecureBaseUrl, hostOfUrl, throwForStatus, tokenFingerprint } from './shared.js';

const USER_AGENT = 'gitglasses';

/**
 * A request path whose interpolated values are percent-encoded. Only `p`
 * produces one, so a value cannot reach a URL without passing through the
 * encoder.
 */
export class Path {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

/** Values a path interpolates. A nested Path is already encoded. */
type PathValue = string | number | Path | readonly string[];

function encodeValue(value: PathValue): string {
  if (value instanceof Path) {
    return value.value;
  }
  if (Array.isArray(value)) {
    // A comma-separated list parameter: the commas separate, the items are data.
    return value.map((item: string) => encodeURIComponent(item)).join(',');
  }
  return encodeURIComponent(String(value));
}

/**
 * Builds a request path, percent-encoding every interpolated value. Values
 * that are themselves `p` results pass through verbatim, so paths compose
 * without double-encoding.
 */
export function p(strings: TemplateStringsArray, ...values: PathValue[]): Path {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += encodeValue(values[i]);
    out += strings[i + 1];
  }
  return new Path(out);
}

/**
 * Encodes a "/"-joined value as a run of path segments, so the separators
 * survive while the segments themselves are encoded.
 */
export function segments(value: string): Path {
  return new Path(value.split('/').map(encodeURIComponent).join('/'));
}


/** In-flight requests a provider keeps open while fanning out over results. */
export const FANOUT_CONCURRENCY = 6;

/** How long an avatar lookup is reused; a blame gutter asks once per author. */
export const AVATAR_TTL_MS = 30 * 60_000;

/** How long a resolved issue or pull request reference is reused. */
export const ISSUE_TTL_MS = 60_000;

/** Responses one client holds at once, bounding an open-ended key space. */
const RESPONSE_CACHE_MAX_ENTRIES = 512;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, preserving
 * result order. Unlike Promise.all the fan-out is bounded, so a page of
 * results cannot open a request per item at once.
 */
export async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export interface ProviderClientOptions {
  /** Provider name used in error messages, e.g. "GitLab". */
  name: string;
  /** Base URL every path hangs off. Trailing slashes are stripped. */
  baseUrl: string;
  /** Label naming the offending option in a base-URL validation error. */
  baseUrlLabel: string;
  /** Segment inserted between the base URL and each path, e.g. "/api/v4". */
  prefix?: string;
  /** Endpoint for graphql(); defaults to the base URL plus prefix. */
  graphqlUrl?: string;
  /** Authorization header value for a request. */
  authorize: (auth: AuthContext) => string;
  /** Headers sent on every request, e.g. accept. */
  headers?: Record<string, string>;
  fetchFn: FetchLike;
  /** Clock behind the response cache's ttls. Tests inject one. */
  clock?: Clock;
}

interface GraphQlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * The HTTP half of a provider: URL construction, headers, status mapping and
 * JSON decoding. Providers keep their endpoints, queries and payload mapping.
 */
export class ProviderClient {
  /** Validated base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** Hostname of the base URL. */
  readonly host: string;

  private readonly name: string;
  private readonly prefix: string;
  private readonly graphqlUrl: string;
  private readonly authorize: (auth: AuthContext) => string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchLike;
  private readonly responses: TtlCache<unknown>;

  constructor(options: ProviderClientOptions) {
    this.name = options.name;
    // The base URL carries the token on every request, so it must be
    // credential-safe before anything is sent to it.
    this.baseUrl = assertSecureBaseUrl(options.baseUrl.replace(/\/+$/, ''), options.baseUrlLabel);
    this.host = hostOfUrl(this.baseUrl);
    this.prefix = options.prefix ?? '';
    this.graphqlUrl = options.graphqlUrl
      ? assertSecureBaseUrl(options.graphqlUrl, `${options.name} GraphQL URL`)
      : `${this.baseUrl}${this.prefix}`;
    this.authorize = options.authorize;
    this.headers = options.headers ?? {};
    this.fetchFn = options.fetchFn;
    this.responses = new TtlCache<unknown>(options.clock, RESPONSE_CACHE_MAX_ENTRIES);
  }

  /** GET returning the decoded body, or undefined on 404. */
  async getJson<T>(auth: AuthContext, path: Path): Promise<T | undefined> {
    return this.requestJson<T>(auth, this.url(path));
  }

  /**
   * GET whose decoded body is reused for `ttlMs`, keyed by the URL and a
   * fingerprint of the token, so two accounts never read each other's
   * responses. Concurrent calls for one key share a single request.
   */
  async getJsonCached<T>(auth: AuthContext, path: Path, ttlMs: number): Promise<T | undefined> {
    const url = this.url(path);
    const key = `GET ${url}\n${tokenFingerprint(auth.token)}`;
    const { value } = await this.responses.getOrFetch(key, ttlMs, 0, () =>
      this.requestJson<T>(auth, url)
    );
    return value as T | undefined;
  }

  private async requestJson<T>(auth: AuthContext, url: string): Promise<T | undefined> {
    const response = await this.send(auth, 'GET', url);
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus(this.name, response);
    return (await response.json()) as T;
  }

  /** GET returning the raw body text. A 404 throws like any other failure. */
  async getText(auth: AuthContext, path: Path): Promise<string> {
    const response = await this.send(auth, 'GET', this.url(path));
    throwForStatus(this.name, response);
    return response.text();
  }

  /** POST a JSON body, returning the decoded response. */
  async postJson<T>(auth: AuthContext, path: Path, body: unknown): Promise<T> {
    const response = await this.send(auth, 'POST', this.url(path), body);
    throwForStatus(this.name, response);
    return (await response.json()) as T;
  }

  /** POST a JSON body, returning undefined on 404. */
  async postJsonOptional<T>(auth: AuthContext, path: Path, body: unknown): Promise<T | undefined> {
    const response = await this.send(auth, 'POST', this.url(path), body);
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus(this.name, response);
    return (await response.json()) as T;
  }

  /** GraphQL POST; rejects on a transport failure, an errors[] or a missing data. */
  async graphql<T>(
    auth: AuthContext,
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const response = await this.send(auth, 'POST', this.graphqlUrl, { query, variables });
    throwForStatus(this.name, response);
    const json = (await response.json()) as GraphQlEnvelope<T>;
    if (json.errors && json.errors.length > 0) {
      throw new ProviderError(`${this.name} GraphQL error: ${json.errors[0].message}`);
    }
    if (!json.data) {
      throw new ProviderError(`${this.name} GraphQL response had no data`);
    }
    return json.data;
  }

  /**
   * GET an absolute URL with no credentials, returning the body text. Serves
   * content a payload points at, which does not live under the base URL.
   */
  async getPublicText(url: string): Promise<string> {
    let response: HttpResponseLike;
    try {
      response = await this.fetchFn(url, { method: 'GET' });
    } catch (error) {
      throw transportError(this.name, url, error);
    }
    throwForStatus(this.name, response);
    return response.text();
  }

  private url(path: Path): string {
    return `${this.baseUrl}${this.prefix}${path.value}`;
  }

  private async send(
    auth: AuthContext,
    method: string,
    url: string,
    body?: unknown
  ): Promise<HttpResponseLike> {
    const headers: Record<string, string> = { ...this.headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    headers['user-agent'] = USER_AGENT;
    headers.authorization = this.authorize(auth);
    try {
      return await this.fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw transportError(this.name, url, error);
    }
  }
}

/** Actionable text for the transport failures a self-hosted instance produces. */
const TRANSPORT_HINTS: ReadonlyMap<string, string> = new Map([
  [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'its TLS certificate could not be verified; trust the issuing CA, e.g. via NODE_EXTRA_CA_CERTS',
  ],
  [
    'SELF_SIGNED_CERT_IN_CHAIN',
    'its TLS certificate chain is self-signed; trust the issuing CA, e.g. via NODE_EXTRA_CA_CERTS',
  ],
  [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'its TLS certificate is self-signed; trust the issuing CA, e.g. via NODE_EXTRA_CA_CERTS',
  ],
  ['ENOTFOUND', 'the host does not resolve; check the configured base URL'],
  [
    'ECONNREFUSED',
    'the connection was refused; check the base URL, the port, and that the instance is reachable',
  ],
  ['ETIMEDOUT', 'the connection timed out'],
]);

const TIMEOUT_HINT = 'the request timed out';

/**
 * Reads the cause chain for a recognized failure, falling back to the
 * innermost message. fetch reports everything as "fetch failed" and hangs the
 * real reason off `cause`.
 */
function transportReason(error: unknown): string {
  let reason = error instanceof Error ? error.message : String(error);
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    reason = current.message;
    if (current.name === 'AbortError' || current.name === 'TimeoutError') {
      return TIMEOUT_HINT;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      const hint = TRANSPORT_HINTS.get(code);
      if (hint) {
        return hint;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return reason;
}

/** Wraps a fetch rejection as a ProviderError naming the host and the reason. */
function transportError(name: string, url: string, cause: unknown): ProviderError {
  return new ProviderError(
    `${name} could not reach ${hostOfUrl(url)}: ${transportReason(cause)}`,
    undefined,
    { cause }
  );
}

/**
 * Merges two result lists into one, keyed by `keyOf`: an item present in both
 * keeps its `primary` form, and the result is capped at `limit`.
 */
export function mergeByRole<T>(
  primary: readonly T[],
  secondary: readonly T[],
  keyOf: (item: T) => string | number,
  limit: number
): T[] {
  const merged = new Map<string | number, T>();
  for (const item of [...primary, ...secondary]) {
    const key = keyOf(item);
    if (!merged.has(key)) {
      merged.set(key, item);
    }
  }
  return [...merged.values()].slice(0, limit);
}

/** How long a resolved identity is reused before the provider is asked again. */
export const IDENTITY_TTL_MS = 15 * 60_000;

/**
 * The account a token belongs to, cached per token for IDENTITY_TTL_MS so a
 * renamed or reassigned account is picked up without a restart. Concurrent
 * lookups for the same token share one request.
 */
export class CachedIdentity<T> {
  private readonly cache: TtlCache<T>;

  constructor(
    private readonly ttlMs: number = IDENTITY_TTL_MS,
    clock?: Clock
  ) {
    this.cache = new TtlCache<T>(clock);
  }

  async get(token: string, load: () => Promise<T>): Promise<T> {
    const { value } = await this.cache.getOrFetch(tokenFingerprint(token), this.ttlMs, 0, load);
    return value;
  }

  /** The identity already held for `token`, without asking the provider. */
  peek(token: string): T | undefined {
    return this.cache.get(tokenFingerprint(token));
  }
}
