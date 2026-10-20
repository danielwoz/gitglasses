// Pure autolink substitution (no vscode imports): turns issue references in
// plain text into markdown links. Used by the commit hover, which must stay
// cheap and offline-safe, so everything here is string work only.

import { matchAutolinks, type AutolinkPattern } from '@gitglasses/integrations';
import { escapeMarkdown, markdownLinkDestination } from '../system/markdown';

export { jiraPattern, repoIssuePatterns } from '@gitglasses/integrations';

/**
 * Render `text` as markdown, replacing every pattern match with a link
 * `[match](url)`. Text outside a match is escaped and so is the link text, so
 * the result carries no markup the repository put there.
 *
 * Patterns are applied in order; when matches overlap, the earlier pattern in
 * the list wins and later overlapping matches are skipped. Invalid regexes are
 * ignored so one bad user-configured pattern never breaks the rest.
 */
export function applyAutolinks(text: string, patterns: readonly AutolinkPattern[]): string {
  const matches = matchAutolinks(text, patterns);
  if (matches.length === 0) return escapeMarkdown(text);
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    result +=
      escapeMarkdown(text.slice(cursor, match.start)) +
      `[${escapeMarkdown(match.text)}](${markdownLinkDestination(match.url)})`;
    cursor = match.end;
  }
  return result + escapeMarkdown(text.slice(cursor));
}

/**
 * Validate user-configured autolink settings into safe patterns. A template is
 * kept only when it is an http(s) URL: the template becomes the target of a
 * link the user clicks, and any other scheme is a different kind of action.
 */
export function userPatterns(raw: unknown): AutolinkPattern[] {
  if (!Array.isArray(raw)) return [];
  const patterns: AutolinkPattern[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { regex, urlTemplate } = entry as Record<string, unknown>;
    if (typeof regex !== 'string' || typeof urlTemplate !== 'string' || regex === '') continue;
    if (!/^https?:\/\/\S/i.test(urlTemplate)) continue;
    patterns.push({ regex, urlTemplate });
  }
  return patterns;
}
