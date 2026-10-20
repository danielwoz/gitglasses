// Shared non-streaming HTTP completion execution for the API providers.
// Cancellation aborts the underlying request via AbortController.

import { CancellationLike, FetchFn } from './aiProvider';
import { ExtractedCompletion, HttpRequestSpec } from './requestBuilders';

export const defaultFetch: FetchFn = (url, init) =>
  (globalThis as { fetch: FetchFn }).fetch(url, init);

/** Reads a fetch failure (no HTTP response at all) as something a user can
 *  act on: usually a server that is not running or not reachable. */
function connectionError(url: string, error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // keep the raw url
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`could not reach ${origin} (${reason})`, { cause: error });
}

export async function executeHttpCompletion(
  spec: HttpRequestSpec,
  extract: (response: unknown) => ExtractedCompletion,
  fetchFn: FetchFn,
  token?: CancellationLike,
): Promise<string> {
  const controller = new AbortController();
  const sub = token?.onCancellationRequested(() => controller.abort());
  if (token?.isCancellationRequested) {
    sub?.dispose();
    throw new Error('cancelled');
  }
  try {
    let response: Awaited<ReturnType<FetchFn>>;
    try {
      response = await fetchFn(spec.url, {
        method: 'POST',
        headers: spec.headers,
        body: JSON.stringify(spec.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw connectionError(spec.url, error);
    }
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`AI request failed (HTTP ${response.status}): ${raw.slice(0, 300)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`AI response was not JSON: ${raw.slice(0, 200)}`);
    }
    const { text, problem } = extract(json);
    if (problem) throw new Error(`No answer: ${problem}.`);
    if (!text) throw new Error('AI response contained no completion text');
    return text;
  } finally {
    sub?.dispose();
  }
}

/** GETs a JSON document with a timeout, for the reachability probes. */
export async function fetchJson(
  url: string,
  fetchFn: FetchFn,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(await response.text());
  } finally {
    clearTimeout(timer);
  }
}
