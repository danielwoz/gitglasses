// Pure parsing of a model's natural-language-search reply into the engine's
// search/commits query shape. Models wrap JSON in fences and prose; the
// extractor takes the first balanced {...} block, string-aware.

export interface NlSearchQuery {
  text?: string;
  author?: string;
  sha?: string;
}

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

/** Tolerant parse of a model reply into {text?, author?, sha?}. */
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
  for (const key of ['text', 'author', 'sha'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') query[key] = value.trim();
  }
  if (query.sha && !/^[0-9a-f]{4,40}$/i.test(query.sha)) delete query.sha;
  if (!query.text && !query.author && !query.sha) {
    return { ok: false, error: 'no usable text/author/sha fields in the reply' };
  }
  return { ok: true, query };
}
