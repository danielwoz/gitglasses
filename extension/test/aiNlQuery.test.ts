import { describe, expect, it } from 'vitest';
import { extractFirstJsonObject, parseNlSearchQuery } from '../src/ai/nlQuery';

describe('extractFirstJsonObject', () => {
  it('returns a clean JSON object as-is', () => {
    expect(extractFirstJsonObject('{"text": "login crash"}')).toBe('{"text": "login crash"}');
  });

  it('unwraps fenced code blocks', () => {
    const raw = '```json\n{"author": "alice"}\n```';
    expect(extractFirstJsonObject(raw)).toBe('{"author": "alice"}');
  });

  it('finds the object inside surrounding prose', () => {
    const raw = 'Sure! Here is the query: {"text": "memory leak"} — hope that helps.';
    expect(extractFirstJsonObject(raw)).toBe('{"text": "memory leak"}');
  });

  it('handles nested braces and braces inside strings', () => {
    const raw = 'x {"text": "fn() { return; }", "extra": {"a": 1}} y';
    expect(extractFirstJsonObject(raw)).toBe('{"text": "fn() { return; }", "extra": {"a": 1}}');
  });

  it('returns undefined when there is no object', () => {
    expect(extractFirstJsonObject('no json here')).toBeUndefined();
    expect(extractFirstJsonObject('unbalanced { "text": "x"')).toBeUndefined();
  });
});

describe('parseNlSearchQuery', () => {
  it('parses text/author/sha fields', () => {
    const result = parseNlSearchQuery('{"text": "login crash", "author": "alice"}');
    expect(result).toEqual({ ok: true, query: { text: 'login crash', author: 'alice' } });
  });

  it('accepts a fenced reply with a sha', () => {
    const result = parseNlSearchQuery('```json\n{"sha": "1a2b3c4d"}\n```');
    expect(result).toEqual({ ok: true, query: { sha: '1a2b3c4d' } });
  });

  it('ignores unknown fields, non-strings, and invalid shas', () => {
    const result = parseNlSearchQuery(
      '{"text": "fix", "limit": 5, "author": 42, "sha": "not-hex"}',
    );
    expect(result).toEqual({ ok: true, query: { text: 'fix' } });
  });

  it('fails on invalid JSON with an error message', () => {
    const result = parseNlSearchQuery('{"text": broken}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid JSON');
  });

  it('fails when no usable fields remain', () => {
    expect(parseNlSearchQuery('{"limit": 10}').ok).toBe(false);
    expect(parseNlSearchQuery('the model rambled with no json').ok).toBe(false);
    expect(parseNlSearchQuery('{"text": "   "}').ok).toBe(false);
  });
});
