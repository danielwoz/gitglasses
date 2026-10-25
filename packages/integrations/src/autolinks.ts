/**
 * Autolink matching: finds the issue references in plain text that a set of
 * patterns turns into links. Pure string work, safe wherever text is shown;
 * how a match is rendered (a Markdown link, a list entry) is the caller's.
 */

import type { AutolinkPattern } from './models.js';

/** One reference found in a text, with the link a pattern made of it. */
export interface AutolinkMatch {
  /** Offset of the match in the text. */
  start: number;
  /** Offset just past the match. */
  end: number;
  /** The matched text, e.g. "#12" or "PROJ-7". */
  text: string;
  url: string;
  /** The pattern's title, e.g. "Jira issue". */
  title?: string;
}

/**
 * Fills $1, $2, ... in a URL template from regex capture groups ($0 = whole
 * match). Group values come from repository text, so they are percent-encoded
 * and land in one path/query segment of the template's URL.
 */
function fillTemplate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$(\d+)/g, (_all, index: string) =>
    encodeURIComponent(match[Number(index)] ?? ''),
  );
}

/**
 * Every match of `patterns` in `text`, in text order. Patterns are applied in
 * order; when matches overlap, the earlier pattern in the list wins and later
 * overlapping matches are skipped. Invalid regexes are ignored so one bad
 * user-configured pattern never breaks the rest.
 */
export function matchAutolinks(
  text: string,
  patterns: readonly AutolinkPattern[],
): AutolinkMatch[] {
  const matches: AutolinkMatch[] = [];
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
      if (match[0].length === 0) {
        continue;
      }
      if (matches.some((taken) => start < taken.end && end > taken.start)) {
        continue;
      }
      matches.push({
        start,
        end,
        text: match[0],
        url: fillTemplate(pattern.urlTemplate, match),
        title: pattern.title,
      });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
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
