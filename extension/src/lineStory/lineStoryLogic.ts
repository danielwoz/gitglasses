// Pure logic behind "Why this line?" (no vscode imports, so it stays
// unit-testable): the command's arguments, the blame of the asked-about line
// as a story describes it, and the engine's line history as story versions.

import { UNCOMMITTED_SHA, type BlameHunk, type LineHistoryEntry } from '@gitglasses/protocol';
import type { StoryBlame, StoryVersion } from '@gitglasses/integrations';
import type { FileBlame } from '../model/blameModel';
import { lfsLastChange, originalLineOf } from '../annotations/blameFormat';

export const LINE_STORY_COMMAND = 'gitglasses.showLineStory';

/** The panel type, also its serializer's key. */
export const LINE_STORY_VIEW_TYPE = 'gitglasses.lineStory';

/** Arguments of gitglasses.showLineStory. Without them the command tells the
 *  story of the active editor's cursor line. */
export interface LineStoryArgs {
  /** The document, as a URI string. */
  uri: string;
  /** 1-based line. */
  line: number;
}

export function isLineStoryArgs(value: unknown): value is LineStoryArgs {
  const args = value as Partial<LineStoryArgs> | undefined;
  return (
    typeof args?.uri === 'string' &&
    args.uri !== '' &&
    typeof args.line === 'number' &&
    Number.isInteger(args.line) &&
    args.line >= 1
  );
}

/** Characters of the line itself a story shows. */
export const MAX_LINE_TEXT = 500;

/** The line's text as the story header shows it. */
export function storyLineText(text: string): string {
  return text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT)}…` : text;
}

const NOBODY = { name: '', email: '', time: 0 };

/**
 * The blame of 1-based `line` as a story describes it, or undefined past the
 * end of the file. A Git LFS file's blame describes its pointer, so its story
 * is the commit that last changed the content, as the hover shows.
 */
export function storyBlameOf(blame: FileBlame, line: number): StoryBlame | undefined {
  let hunk: BlameHunk | undefined;
  let blamedLine = line;
  if (blame.lfs) {
    const last = lfsLastChange(blame);
    hunk = last && blame.hunks.find((candidate) => candidate.sha === last.sha);
    if (hunk) blamedLine = hunk.resultLine;
  } else {
    hunk = blame.hunks.find(
      (candidate) =>
        line >= candidate.resultLine && line < candidate.resultLine + candidate.lineCount,
    );
  }
  if (!hunk) return undefined;
  const commit = blame.commits[hunk.sha];
  return {
    sha: hunk.sha,
    line,
    hunkStart: hunk.resultLine,
    hunkLines: hunk.lineCount,
    path: hunk.path,
    originalLine: originalLineOf(hunk, blamedLine),
    previous: hunk.previous ? { ...hunk.previous } : undefined,
    author: commit?.author ?? NOBODY,
    committer: commit?.committer ?? NOBODY,
    summary: commit?.summary ?? (hunk.sha === UNCOMMITTED_SHA ? 'Not committed yet' : ''),
    boundary: commit?.boundary ?? false,
  };
}

/** One history/line entry as a story version. */
export function storyVersionOf(entry: LineHistoryEntry): StoryVersion {
  return {
    sha: entry.sha,
    author: entry.author,
    summary: entry.summary,
    path: entry.path,
    additions: entry.additions,
    deletions: entry.deletions,
    patch: entry.patch,
    patchTruncated: entry.patchTruncated,
  };
}

/** The panel's tab title: the file's name and the line. */
export function lineStoryTitle(relativePath: string, line: number): string {
  const name = relativePath.split('/').pop() || relativePath;
  return `Why ${name}:${line}?`;
}

/** A URL the panel may hand to the browser: http or https only. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A full or abbreviated commit id, as the panel's messages carry them. */
export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{4,64}$/.test(value);
}
