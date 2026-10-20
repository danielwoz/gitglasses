// Pure parsing of a model's natural-language-search reply into the commit
// search criteria (search/commits, or search/log for content, path and
// dates). Models wrap JSON in fences and prose; the extractor takes the first
// balanced {...} block, string-aware.

import type { CommitSearchQuery } from '../views/searchQuery';

export type NlSearchQuery = CommitSearchQuery;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the first balanced top-level JSON object in the text, or undefined. */
export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export type NlParseResult = { ok: true; query: NlSearchQuery } | { ok: false; error: string };

/** Tolerant parse of a model reply into search criteria. Fields that are
 *  malformed (a non-hex sha, a date that is not YYYY-MM-DD) are dropped
 *  rather than sent; a reply left with nothing usable is an error. */
export function parseNlSearchQuery(raw: string): NlParseResult {
  const block = extractFirstJsonObject(raw);
  if (!block) return { ok: false, error: 'no JSON object found in the reply' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'reply is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const query: NlSearchQuery = {};
  for (const key of ['text', 'author', 'sha', 'content', 'path', 'since', 'until'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') query[key] = value.trim();
  }
  if (query.sha && !/^[0-9a-f]{4,40}$/i.test(query.sha)) delete query.sha;
  if (query.since && !DAY.test(query.since)) delete query.since;
  if (query.until && !DAY.test(query.until)) delete query.until;
  if (query.content) query.contentMode = 'string';
  // A sha names one commit; other criteria would only hide it.
  if (query.sha) {
    for (const key of ['content', 'contentMode', 'path', 'since', 'until'] as const) {
      delete query[key];
    }
  }
  if (Object.keys(query).length === 0) {
    return { ok: false, error: 'no usable search fields in the reply' };
  }
  return { ok: true, query };
}
