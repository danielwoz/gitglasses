// Pure text for the current-line blame and the status bar item: the
// customisable templates, the date styles and the special cases (uncommitted
// lines, Git LFS files). No vscode imports, so it stays unit-testable.

import { BlameCommit, BlameHunk, UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { relativeTime } from '../system/dates';
import type { FileBlame } from '../model/blameModel';

/** How `${date}` renders. `${ago}` is always relative. */
export type DateStyle = 'relative' | 'absolute' | 'iso';

export const DATE_STYLES: readonly DateStyle[] = ['relative', 'absolute', 'iso'];

export const DEFAULT_INLINE_FORMAT = '${author}, ${date} • ${summary}';
export const DEFAULT_STATUS_BAR_FORMAT = '${author}, ${date}';

/** Longest inline annotation; a longer one ends in an ellipsis. */
export const MAX_INLINE_LENGTH = 160;
/** Longest status bar text. */
export const MAX_STATUS_BAR_LENGTH = 80;

export interface BlameTextSettings {
  inlineFormat: string;
  statusBarFormat: string;
  dateStyle: DateStyle;
}

export const DEFAULT_TEXT_SETTINGS: BlameTextSettings = {
  inlineFormat: DEFAULT_INLINE_FORMAT,
  statusBarFormat: DEFAULT_STATUS_BAR_FORMAT,
  dateStyle: 'relative',
};

/** Reads a date style setting, falling back to relative. */
export function parseDateStyle(value: unknown): DateStyle {
  return DATE_STYLES.includes(value as DateStyle) ? (value as DateStyle) : 'relative';
}

/** A template setting, or the default when it is empty or not a string. */
export function parseFormat(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `unixSeconds` in the given style. Absolute dates use the local time zone
 *  and the host's locale; ISO dates are local calendar dates (YYYY-MM-DD). */
export function formatDate(
  unixSeconds: number,
  style: DateStyle,
  nowUnixSeconds: number = Date.now() / 1000,
  locale?: string,
): string {
  if (style === 'relative') return relativeTime(unixSeconds, nowUnixSeconds);
  const date = new Date(unixSeconds * 1000);
  if (style === 'iso') {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Full local date and time, for hovers next to the relative date. */
export function formatDateTime(unixSeconds: number, locale?: string): string {
  return new Date(unixSeconds * 1000).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface TemplateFields {
  author: string;
  email: string;
  date: string;
  ago: string;
  summary: string;
  sha: string;
}

/** `template` with every `${token}` replaced; unknown tokens stay as written. */
export function renderTemplate(template: string, fields: TemplateFields): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(fields, name)
      ? fields[name as keyof TemplateFields]
      : whole,
  );
}

/** Collapses line breaks and clips to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The status bar renders `$(name)` as an icon; repository text must not. */
export function escapeStatusBarIcons(text: string): string {
  return text.replace(/\$\(/g, '$​(');
}

export function templateFields(
  sha: string,
  commit: BlameCommit,
  dateStyle: DateStyle,
  nowUnixSeconds?: number,
): TemplateFields {
  return {
    author: commit.author.name,
    email: commit.author.email,
    date: formatDate(commit.author.time, dateStyle, nowUnixSeconds),
    ago: relativeTime(commit.author.time, nowUnixSeconds),
    summary: commit.summary,
    sha: shortSha(sha),
  };
}

/** The commit standing for an LFS file: the newest commit among the pointer
 *  lines, which is the last one that changed the content. */
export function lfsLastChange(blame: FileBlame): { sha: string; commit: BlameCommit } | undefined {
  let newest: { sha: string; commit: BlameCommit } | undefined;
  for (const hunk of blame.hunks) {
    if (hunk.sha === UNCOMMITTED_SHA) continue;
    const commit = blame.commits[hunk.sha];
    if (!commit) continue;
    if (!newest || commit.author.time > newest.commit.author.time) {
      newest = { sha: hunk.sha, commit };
    }
  }
  return newest;
}

/** Whether an LFS file's pointer differs from the committed one. */
export function lfsHasUncommittedChange(blame: FileBlame): boolean {
  return blame.hunks.some((hunk) => hunk.sha === UNCOMMITTED_SHA);
}

export interface LineBlameText {
  /** Text after the end of the current line. */
  inline: string;
  /** Status bar text, theme icons included. */
  statusBar: string;
  /** The commit described, when there is one. */
  sha?: string;
}

/** What the current-line annotation and the status bar show for one line,
 *  or undefined when the line has no blame (past the end of the file). */
export function lineBlameText(
  blame: FileBlame,
  line1Based: number,
  settings: BlameTextSettings,
  nowUnixSeconds?: number,
): LineBlameText | undefined {
  if (blame.lfs) {
    const last = lfsLastChange(blame);
    if (!last) return undefined;
    const fields = templateFields(last.sha, last.commit, settings.dateStyle, nowUnixSeconds);
    const pending = lfsHasUncommittedChange(blame) ? ' (uncommitted changes)' : '';
    return {
      inline: clip(
        `LFS file${pending} • ${renderTemplate(settings.inlineFormat, fields)}`,
        MAX_INLINE_LENGTH,
      ),
      statusBar: `$(file-binary) ${escapeStatusBarIcons(
        clip(renderTemplate(settings.statusBarFormat, fields), MAX_STATUS_BAR_LENGTH),
      )}`,
      sha: last.sha,
    };
  }
  const hunk = blame.hunks.find(
    (h) => line1Based >= h.resultLine && line1Based < h.resultLine + h.lineCount,
  );
  if (!hunk) return undefined;
  if (hunk.sha === UNCOMMITTED_SHA) {
    return { inline: 'You • Uncommitted changes', statusBar: '$(edit) Uncommitted changes' };
  }
  const commit = blame.commits[hunk.sha];
  if (!commit) return undefined;
  const fields = templateFields(hunk.sha, commit, settings.dateStyle, nowUnixSeconds);
  return {
    inline: clip(renderTemplate(settings.inlineFormat, fields), MAX_INLINE_LENGTH),
    statusBar: `$(git-commit) ${escapeStatusBarIcons(
      clip(renderTemplate(settings.statusBarFormat, fields), MAX_STATUS_BAR_LENGTH),
    )}`,
    sha: hunk.sha,
  };
}

/** Where a hunk's line came from: the line in the commit that wrote it. */
export function originalLineOf(hunk: BlameHunk, line1Based: number): number {
  return hunk.originalLine + (line1Based - hunk.resultLine);
}
