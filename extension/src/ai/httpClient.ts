// Shared non-streaming HTTP completion execution for the API providers.
// Cancellation aborts the underlying request via AbortController.

import { CancellationLike, FetchFn } from './aiProvider';
import { HttpRequestSpec } from './requestBuilders';

export const defaultFetch: FetchFn = (url, init) =>
  (globalThis as { fetch: FetchFn }).fetch(url, init);

export async function executeHttpCompletion(
  spec: HttpRequestSpec,
  extractText: (response: unknown) => string | undefined,
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
    const response = await fetchFn(spec.url, {
      method: 'POST',
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      signal: controller.signal,
    });
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
    const text = extractText(json);
    if (!text) throw new Error('AI response contained no completion text');
    return text;
  } finally {
    sub?.dispose();
  }
}
