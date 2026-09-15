import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES, defaultFetch } from '../src/http.js';

const realFetch = (globalThis as { fetch?: unknown }).fetch;

afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

/** Installs a stub global fetch returning `body`, with optional headers. */
function stubFetch(body: string, headers: Record<string, string> = {}): void {
  (globalThis as { fetch?: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  });
}

describe('response size bound', () => {
  it('rejects a declared content-length over the bound before reading', async () => {
    let read = false;
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length' ? String(MAX_RESPONSE_BYTES + 1) : null,
      },
      text: async () => {
        read = true;
        return '';
      },
    });
    await expect(defaultFetch('https://example.test')).rejects.toThrow(/response too large/);
    expect(read).toBe(false);
  });

  it('accepts a body at the bound', async () => {
    stubFetch('a'.repeat(MAX_RESPONSE_BYTES));
    const response = await defaultFetch('https://example.test');
    expect((await response.text()).length).toBe(MAX_RESPONSE_BYTES);
  });

  it('measures undeclared bodies in bytes, not UTF-16 code units', async () => {
    // Each "é" is one code unit but two UTF-8 bytes, so a string of half the
    // bound in code units is exactly at the bound in bytes.
    const body = 'é'.repeat(MAX_RESPONSE_BYTES / 2 + 1);
    expect(body.length).toBeLessThan(MAX_RESPONSE_BYTES);
    stubFetch(body);
    const response = await defaultFetch('https://example.test');
    await expect(response.text()).rejects.toThrow(/response too large: \d+ bytes/);
  });

  it('caches the body so a second read does not re-measure', async () => {
    let reads = 0;
    (globalThis as { fetch?: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => {
        reads += 1;
        return '{"ok":true}';
      },
    });
    const response = await defaultFetch('https://example.test');
    expect(await response.json()).toEqual({ ok: true });
    expect(await response.text()).toBe('{"ok":true}');
    expect(reads).toBe(1);
  });
});
