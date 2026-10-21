import { describe, expect, it } from 'vitest';
import {
  describeQuery,
  inDateWindow,
  isoDateSeconds,
  needsGitLog,
  parseSearchInput,
  resolveDay,
  tokenize,
} from '../src/views/searchQuery';

// A fixed local "now": Wednesday 2026-10-21, mid-afternoon.
const NOW = new Date(2026, 9, 21, 15, 30);

function parse(input: string) {
  const parsed = parseSearchInput(input, NOW);
  if (!parsed.ok) throw new Error(`unexpected parse error: ${parsed.error}`);
  return parsed.query;
}

function parseError(input: string): string {
  const parsed = parseSearchInput(input, NOW);
  if (parsed.ok) throw new Error(`expected an error for ${input}`);
  return parsed.error;
}

describe('tokenize', () => {
  it('keeps quoted runs together and splits key prefixes off', () => {
    expect(tokenize('fix "login crash" author:"Jane Doe" file:src/a.ts')).toEqual([
      { value: 'fix' },
      { value: 'login crash' },
      { key: 'author', value: 'Jane Doe' },
      { key: 'file', value: 'src/a.ts' },
    ]);
  });

  it('leaves a colon inside quotes as part of the phrase', () => {
    expect(tokenize('"fix: crash"')).toEqual([{ value: 'fix: crash' }]);
  });
});

describe('parseSearchInput', () => {
  it('searches messages with free words, as before', () => {
    expect(parse('login crash')).toEqual({ text: 'login crash' });
    expect(parse('fix: crash')).toEqual({ text: 'fix: crash' });
    expect(parse('see https://example.com/x')).toEqual({ text: 'see https://example.com/x' });
  });

  it('treats a lone hex string as a sha', () => {
    expect(parse('1a2b3c4d')).toEqual({ sha: '1a2b3c4d' });
    expect(parse('sha:1a2b')).toEqual({ sha: '1a2b' });
    expect(parseError('sha:zzzz')).toMatch(/not a commit id/);
  });

  it('reads author from author: and @', () => {
    expect(parse('author:alice crash')).toEqual({ author: 'alice', text: 'crash' });
    expect(parse('@bob')).toEqual({ author: 'bob' });
    expect(parse('author:"Jane Doe"')).toEqual({ author: 'Jane Doe' });
  });

  it('maps change: to an exact pickaxe and diff: to a regex', () => {
    expect(parse('change:validateUser')).toEqual({
      content: 'validateUser',
      contentMode: 'string',
    });
    expect(parse('diff:"function \\w+User"')).toEqual({
      content: 'function \\w+User',
      contentMode: 'regex',
    });
  });

  it('reads file: and path: as a pathspec', () => {
    expect(parse('file:src/app.ts')).toEqual({ path: 'src/app.ts' });
    expect(parse('path:"docs/*.md"')).toEqual({ path: 'docs/*.md' });
  });

  it('resolves absolute, named and relative dates to local days', () => {
    expect(parse('after:2025-01-01 before:2025-02-01')).toEqual({
      since: '2025-01-01',
      until: '2025-02-01',
    });
    expect(parse('after:today')).toEqual({ since: '2026-10-21' });
    expect(parse('after:yesterday')).toEqual({ since: '2026-10-20' });
    expect(parse('after:30d')).toEqual({ since: '2026-09-21' });
    expect(parse('after:2w')).toEqual({ since: '2026-10-07' });
    expect(parse('since:6m')).toEqual({ since: '2026-04-21' });
    expect(parse('after:1y')).toEqual({ since: '2025-10-21' });
  });

  it('rejects dates it cannot read, and empty windows', () => {
    expect(parseError('after:lastmonth')).toMatch(/not a date/);
    expect(parseError('after:2025-02-30')).toMatch(/not a date/);
    expect(parseError('after:2025-03-01 before:2025-02-01')).toMatch(/earlier/);
  });

  it('refuses a sha combined with git log criteria', () => {
    expect(parseError('sha:1a2b change:x')).toMatch(/cannot be combined/);
  });

  it('combines every criterion', () => {
    expect(parse('crash @alice change:foo file:src after:2025-01-01')).toEqual({
      text: 'crash',
      author: 'alice',
      content: 'foo',
      contentMode: 'string',
      path: 'src',
      since: '2025-01-01',
    });
  });

  it('keeps unknown key-like words as message text', () => {
    expect(parse('docs: update')).toEqual({ text: 'docs: update' });
    expect(parse('ticket:123')).toEqual({ text: 'ticket:123' });
  });

  it('reports empty input', () => {
    expect(parseError('   ')).toMatch(/Type something/);
  });
});

describe('resolveDay', () => {
  it('rejects malformed values', () => {
    expect(resolveDay('2025-1-1', NOW)).toBeUndefined();
    expect(resolveDay('soon', NOW)).toBeUndefined();
  });
});

describe('needsGitLog', () => {
  it('routes only content, path and date criteria to git log', () => {
    expect(needsGitLog({ text: 'a', author: 'b', sha: 'abcd' })).toBe(false);
    expect(needsGitLog({ content: 'x' })).toBe(true);
    expect(needsGitLog({ path: 'src' })).toBe(true);
    expect(needsGitLog({ since: '2025-01-01' })).toBe(true);
    expect(needsGitLog({ until: '2025-01-01' })).toBe(true);
  });
});

describe('inDateWindow', () => {
  const at = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

  it('reads a bare day as its start in local time, as git log does', () => {
    expect(isoDateSeconds('2025-02-01')).toBe(at('2025-02-01T00:00:00'));
    expect(isoDateSeconds('2025-02-01T10:30:00')).toBe(at('2025-02-01T10:30:00'));
    expect(isoDateSeconds('2025-02-01T10:30:00Z')).toBe(Date.UTC(2025, 1, 1, 10, 30) / 1000);
    expect(isoDateSeconds('2025-02-01T10:30:00+02:00')).toBe(Date.UTC(2025, 1, 1, 8, 30) / 1000);
  });

  it('keeps commits from the start of since through until', () => {
    const query = { since: '2025-02-01', until: '2025-03-01' };
    expect(inDateWindow(query, at('2025-01-31T23:59:59'))).toBe(false);
    expect(inDateWindow(query, at('2025-02-01T00:00:00'))).toBe(true);
    expect(inDateWindow(query, at('2025-02-28T23:59:59'))).toBe(true);
    expect(inDateWindow(query, at('2025-03-01T00:00:01'))).toBe(false);
    expect(inDateWindow({ since: '2025-02-01' }, at('2030-01-01T00:00:00'))).toBe(true);
    expect(inDateWindow({}, 0)).toBe(true);
  });
});

describe('describeQuery', () => {
  it('summarises the criteria for the results header', () => {
    expect(
      describeQuery({
        text: 'crash',
        author: 'alice',
        content: 'foo',
        contentMode: 'string',
        path: 'src',
        since: '2025-01-01',
        until: '2025-02-01',
      }),
    ).toBe(
      'matching "crash" by alice adding or removing "foo" in src since 2025-01-01 before 2025-02-01',
    );
    expect(describeQuery({ content: 'a+', contentMode: 'regex' })).toBe(
      'changing lines matching /a+/',
    );
    expect(describeQuery({})).toBe('in all history');
  });
});
