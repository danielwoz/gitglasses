// Pure logic behind the Open Patches commands: envelope validation and
// serialization, diffstat extraction, and snippet-URL classification.
// No vscode imports — everything here is unit-tested directly.

import type { PatchEnvelope } from '@gitglasses/protocol';

export type EnvelopeParseResult =
  | { ok: true; envelope: PatchEnvelope }
  | { ok: false; error: string };

/** Parse and validate a .ggpatch envelope, returning friendly errors. */
export function parseEnvelope(text: string): EnvelopeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the content is not valid JSON (expected a .ggpatch envelope)' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'the JSON is not a patch envelope object' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.format !== 'gitglasses-patch') {
    return { ok: false, error: 'not a GitGlasses patch — missing "format": "gitglasses-patch"' };
  }
  if (obj.version !== 1) {
    return {
      ok: false,
      error: `unsupported patch version ${JSON.stringify(obj.version)} — this build understands version 1`,
    };
  }
  if (typeof obj.baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(obj.baseSha)) {
    return { ok: false, error: 'the envelope has no valid 40-character base SHA' };
  }
  if (typeof obj.patch !== 'string' || obj.patch.trim() === '') {
    return { ok: false, error: 'the envelope contains no patch content' };
  }
  return {
    ok: true,
    envelope: {
      format: 'gitglasses-patch',
      version: 1,
      baseSha: obj.baseSha,
      branch: typeof obj.branch === 'string' ? obj.branch : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      patch: obj.patch,
      remoteFingerprint:
        typeof obj.remoteFingerprint === 'string' ? obj.remoteFingerprint : undefined,
      createdAtIso: typeof obj.createdAtIso === 'string' ? obj.createdAtIso : '',
    },
  };
}

/** Pretty-printed envelope JSON (the on-disk .ggpatch format). */
export function envelopeToJson(envelope: PatchEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export interface DiffStatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  renamedFrom?: string;
}

function stripPrefix(rawPath: string): string {
  const unquoted =
    rawPath.startsWith('"') && rawPath.endsWith('"') ? rawPath.slice(1, -1) : rawPath;
  return unquoted.replace(/^[ab]\//, '');
}

/** Per-file additions/deletions (and rename/binary flags) from unified diff text. */
export function extractDiffStat(patch: string): DiffStatEntry[] {
  const entries: DiffStatEntry[] = [];
  let current: DiffStatEntry | undefined;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const header = /^diff --git (?:"?a\/[^"]*"?|a\/\S*) ("?b\/[^"]*"?|b\/\S*)$/.exec(line);
    if (header) {
      current = { path: stripPrefix(header[1]), additions: 0, deletions: 0, binary: false };
      entries.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('rename from ')) {
      current.renamedFrom = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    // The +++ side names the post-image; deletions show /dev/null there.
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target !== '/dev/null') current.path = stripPrefix(target);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
  }
  return entries;
}

export type SnippetUrlClass =
  | { kind: 'gist'; host: string }
  | { kind: 'gitlab-snippet'; host: string }
  | { kind: 'raw' };

/**
 * Classify a patch URL: a known snippet host (fetched via the provider API
 * when connected) or a plain raw URL. Undefined when not an http(s) URL.
 */
export function classifySnippetUrl(url: string): SnippetUrlClass | undefined {
  const match = /^https?:\/\/([^/?#]+)((?:\/[^?#]*)?)$/i.exec(url.trim().split(/[?#]/)[0]);
  if (!match) return undefined;
  const host = match[1].toLowerCase();
  const path = match[2];
  if (host.startsWith('gist.')) return { kind: 'gist', host };
  if (/\/-\/snippets\/\d+|^\/snippets\/\d+/.test(path)) return { kind: 'gitlab-snippet', host };
  return { kind: 'raw' };
}

/**
 * The hosting-entry domain a snippet host serves, e.g. "gist.github.com" is
 * served by the "github.com" integration; GitLab snippet URLs live on the
 * instance host itself.
 */
export function snippetProviderHost(cls: SnippetUrlClass): string | undefined {
  if (cls.kind === 'gist') return cls.host.replace(/^gist\./, '');
  if (cls.kind === 'gitlab-snippet') return cls.host;
  return undefined;
}

/** Detail text for the apply-patch confirmation modal. */
export function confirmDetail(envelope: PatchEnvelope, stat: DiffStatEntry[]): string {
  const additions = stat.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = stat.reduce((sum, entry) => sum + entry.deletions, 0);
  const lines = [
    envelope.summary === '' ? '(no summary)' : envelope.summary,
    `Base: ${envelope.baseSha.slice(0, 7)}${envelope.branch ? ` (branch ${envelope.branch})` : ''}`,
  ];
  if (envelope.createdAtIso !== '') lines.push(`Created: ${envelope.createdAtIso}`);
  lines.push(
    `${stat.length} file${stat.length === 1 ? '' : 's'} changed, +${additions} −${deletions}`,
  );
  return lines.join('\n');
}

/** Suggested save-dialog file name derived from the patch summary. */
export function patchFileName(summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${slug === '' ? 'patch' : slug}.ggpatch`;
}
