// Markdown escaping for text that comes out of a repository. Commit messages,
// author names and file paths are attacker-controlled in any repository a user
// opens, and they are rendered by MarkdownString in hovers.

/** ASCII punctuation CommonMark lets a backslash escape, plus the ones that matter here. */
const METACHARACTERS = /[\\`*_{}[\]()#+\-.!|<>~&]/g;

/**
 * `text` with Markdown metacharacters backslash-escaped and line breaks
 * collapsed to spaces, so it renders as literal inline text.
 *
 * Escaping `(` and `)` also neutralises the `$(icon)` theme-icon syntax that
 * MarkdownString.supportThemeIcons enables.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(METACHARACTERS, '\\$&');
}

/**
 * `text` wrapped in a code span. Backslash escapes do not apply inside a code
 * span, so the fence is made longer than the longest backtick run in `text`
 * and line breaks are collapsed.
 */
export function codeSpan(text: string): string {
  const flat = text.replace(/\s*[\r\n]+\s*/g, ' ');
  let longestRun = 0;
  for (const run of flat.match(/`+/g) ?? []) {
    longestRun = Math.max(longestRun, run.length);
  }
  const fence = '`'.repeat(longestRun + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') || flat === '' ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * A Markdown link destination for `url`. The angle-bracket form keeps spaces
 * and parentheses inside the destination; the characters that would close it
 * are percent-encoded.
 */
export function markdownLinkDestination(url: string): string {
  return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
}
