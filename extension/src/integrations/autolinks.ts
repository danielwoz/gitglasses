// Pure autolink substitution (no vscode imports): turns issue references in
// plain text into markdown links. Used by the commit hover, which must stay
// cheap and offline-safe, so everything here is string work only.

import type { AutolinkPattern } from '@gitglasses/integrations';

interface LinkedRange {
  start: number;
  end: number;
  replacement: string;
}

/** Fills $1, $2, ... in a URL template from regex capture groups ($0 = whole match). */
function fillTemplate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$(\d+)/g, (_all, index: string) => match[Number(index)] ?? '');
}

/**
 * Replace every pattern match in `text` with a markdown link `[match](url)`.
 * Patterns are applied in order; when matches overlap, the earlier pattern in
 * the list wins and later overlapping matches are skipped. Invalid regexes are
 * ignored so one bad user-configured pattern never breaks the rest.
 */
export function applyAutolinks(text: string, patterns: readonly AutolinkPattern[]): string {
  const ranges: LinkedRange[] = [];
  for (const pattern of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern.regex, 'g');
    } catch {
      continue;
    }
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (match[0].length === 0) continue;
      if (ranges.some((taken) => start < taken.end && end > taken.start)) continue;
      ranges.push({
        start,
        end,
        replacement: `[${match[0]}](${fillTemplate(pattern.urlTemplate, match)})`,
      });
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const range of ranges) {
    result += text.slice(cursor, range.start) + range.replacement;
    cursor = range.end;
  }
  return result + text.slice(cursor);
}

/** Default #123 pattern for a GitHub/GitLab-style repo. */
export function repoIssuePatterns(repo: {
  host: string;
  owner: string;
  name: string;
}): AutolinkPattern[] {
  return [
    {
      regex: '#(\\d+)\\b',
      urlTemplate: `https://${repo.host}/${repo.owner}/${repo.name}/issues/$1`,
      title: `${repo.owner}/${repo.name} issue`,
    },
  ];
}

/** Jira issue-key pattern (PROJ-123) pointing at a Jira host's browse page. */
export function jiraPattern(host: string): AutolinkPattern {
  return {
    regex: '\\b([A-Z][A-Z0-9]+-\\d+)\\b',
    urlTemplate: `https://${host}/browse/$1`,
    title: 'Jira issue',
  };
}

/** Validate user-configured autolink settings into safe patterns. */
export function userPatterns(raw: unknown): AutolinkPattern[] {
  if (!Array.isArray(raw)) return [];
  const patterns: AutolinkPattern[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { regex, urlTemplate } = entry as Record<string, unknown>;
    if (typeof regex !== 'string' || typeof urlTemplate !== 'string' || regex === '') continue;
    patterns.push({ regex, urlTemplate });
  }
  return patterns;
}
