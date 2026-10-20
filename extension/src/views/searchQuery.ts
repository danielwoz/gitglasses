// Pure parsing of the Search Commits input into engine search criteria.
// Free words search commit messages; `key:value` tokens narrow the search:
//   author:alice  @alice           author name or email
//   change:fooBar                  commits adding or removing that exact code
//   diff:"foo.*bar"                commits whose changed lines match a regex
//   file:src/app.ts  path:src/*    commits touching a path (git glob rules)
//   after:2025-01-01  after:2w     on or after a day (or N days/weeks/months/years ago)
//   before:2025-02-01              before a day
//   sha:1a2b3c4                    a commit id prefix
// Values with spaces take double quotes, and a lone hex string is a sha.

import { isFullOrAbbreviatedSha } from './viewLogic';

export interface CommitSearchQuery {
  text?: string;
  author?: string;
  sha?: string;
  content?: string;
  contentMode?: 'string' | 'regex';
  path?: string;
  /** Start of the commit-date window, inclusive (engine IsoDate). */
  since?: string;
  /** End of the commit-date window, exclusive (engine IsoDate). */
  until?: string;
}

export type ParsedSearch = { ok: true; query: CommitSearchQuery } | { ok: false; error: string };

type Key = 'author' | 'sha' | 'change' | 'diff' | 'path' | 'after' | 'before' | 'message';

const KEYS: Record<string, Key> = {
  author: 'author',
  sha: 'sha',
  commit: 'sha',
  change: 'change',
  code: 'change',
  diff: 'diff',
  file: 'path',
  path: 'path',
  after: 'after',
  since: 'after',
  before: 'before',
  until: 'before',
  message: 'message',
  msg: 'message',
};

export interface SearchToken {
  /** The `key:` prefix, lowercased and without the colon, when present. */
  key?: string;
  value: string;
}

/** Splits on whitespace into tokens, keeping double-quoted runs together. A
 *  `key:` prefix is split off unless the colon sits inside the quotes, so
 *  "fix: crash" stays a phrase. */
export function tokenize(input: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  const pattern = /(?:([A-Za-z]+):)?(?:"([^"]*)"?|(\S+))/g;
  for (const match of input.matchAll(pattern)) {
    const [, key, quoted, bare] = match;
    const value = quoted ?? bare ?? '';
    tokens.push(key !== undefined ? { key: key.toLowerCase(), value } : { value });
  }
  return tokens;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A local calendar day as YYYY-MM-DD. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Resolves a date value: YYYY-MM-DD, today, yesterday, or a relative
 *  N[d|w|m|y] counted back from `now`. Returns a local YYYY-MM-DD day. */
export function resolveDay(value: string, now: Date): string | undefined {
  const lower = value.toLowerCase();
  if (lower === 'today') return isoDay(now);
  if (lower === 'yesterday') {
    return isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  }
  const relative = /^(\d{1,4})([dwmy])$/.exec(lower);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2];
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (unit === 'd') day.setDate(day.getDate() - count);
    else if (unit === 'w') day.setDate(day.getDate() - 7 * count);
    else if (unit === 'm') day.setMonth(day.getMonth() - count);
    else day.setFullYear(day.getFullYear() - count);
    return isoDay(day);
  }
  const absolute = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!absolute) return undefined;
  const [year, month, dayOfMonth] = absolute.slice(1).map(Number);
  const check = new Date(year, month - 1, dayOfMonth);
  if (check.getMonth() !== month - 1 || check.getDate() !== dayOfMonth) return undefined;
  return value;
}

export function parseSearchInput(input: string, now: Date = new Date()): ParsedSearch {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Type something to search for.' };
  if (isFullOrAbbreviatedSha(trimmed)) return { ok: true, query: { sha: trimmed } };

  const query: CommitSearchQuery = {};
  const words: string[] = [];
  for (const token of tokenize(trimmed)) {
    let key = token.key !== undefined ? KEYS[token.key] : undefined;
    let value = token.value;
    if (token.key === undefined && value.startsWith('@') && value.length > 1) {
      key = 'author';
      value = value.slice(1);
    }
    if (!key) {
      const text = token.key !== undefined ? `${token.key}:${value}` : value;
      if (text !== '') words.push(text);
      continue;
    }
    if (value === '') return { ok: false, error: `"${token.key}:" needs a value.` };
    switch (key) {
      case 'author':
        query.author = value;
        break;
      case 'sha':
        if (!/^[0-9a-f]{4,64}$/i.test(value)) {
          return { ok: false, error: `"${value}" is not a commit id.` };
        }
        query.sha = value;
        break;
      case 'change':
        query.content = value;
        query.contentMode = 'string';
        break;
      case 'diff':
        query.content = value;
        query.contentMode = 'regex';
        break;
      case 'path':
        query.path = value;
        break;
      case 'message':
        words.push(value);
        break;
      case 'after':
      case 'before': {
        const day = resolveDay(value, now);
        if (!day) {
          return {
            ok: false,
            error: `"${value}" is not a date: use YYYY-MM-DD, today, yesterday, or a span such as 30d, 2w, 6m or 1y.`,
          };
        }
        if (key === 'after') query.since = day;
        else query.until = day;
        break;
      }
    }
  }
  if (words.length > 0) query.text = words.join(' ');
  if (query.sha && needsGitLog(query)) {
    return {
      ok: false,
      error: 'A commit id cannot be combined with change, diff, file or date criteria.',
    };
  }
  if (query.since && query.until && query.since >= query.until) {
    return { ok: false, error: 'The "after" date must be earlier than the "before" date.' };
  }
  return { ok: true, query };
}

/** Whether the query needs `git log` (search/log) rather than the libgit2
 *  walk of search/commits, which serves only text, author and sha. */
export function needsGitLog(query: CommitSearchQuery): boolean {
  return (
    query.content !== undefined ||
    query.path !== undefined ||
    query.since !== undefined ||
    query.until !== undefined
  );
}

/** A short description of the criteria that reads after "commits", for
 *  result headers: 'matching "crash" by alice since 2025-01-01'. */
export function describeQuery(query: CommitSearchQuery): string {
  const parts: string[] = [];
  if (query.text) parts.push(`matching "${query.text}"`);
  if (query.author) parts.push(`by ${query.author}`);
  if (query.content) {
    parts.push(
      query.contentMode === 'regex'
        ? `changing lines matching /${query.content}/`
        : `adding or removing "${query.content}"`,
    );
  }
  if (query.path) parts.push(`in ${query.path}`);
  if (query.since) parts.push(`since ${query.since}`);
  if (query.until) parts.push(`before ${query.until}`);
  if (query.sha) parts.push(`sha ${query.sha}`);
  return parts.length > 0 ? parts.join(' ') : 'in all history';
}
