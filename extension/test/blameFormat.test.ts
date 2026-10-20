import { describe, expect, it } from 'vitest';
import { UNCOMMITTED_SHA, type BlameCommit, type BlameHunk } from '@gitglasses/protocol';
import {
  clip,
  DEFAULT_TEXT_SETTINGS,
  escapeStatusBarIcons,
  formatDate,
  lfsLastChange,
  lineBlameText,
  MAX_INLINE_LENGTH,
  originalLineOf,
  parseDateStyle,
  parseFormat,
  renderTemplate,
} from '../src/annotations/blameFormat';
import { parseBlameSettings, statusBarVisible } from '../src/annotations/blameSettings';
import type { FileBlame } from '../src/model/blameModel';

const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function commit(name: string, time: number, summary: string): BlameCommit {
  return {
    author: { name, email: `${name.toLowerCase()}@example.invalid`, time },
    committer: { name, email: `${name.toLowerCase()}@example.invalid`, time },
    summary,
    boundary: false,
  };
}

function hunk(sha: string, resultLine: number, lineCount: number): BlameHunk {
  return { sha, resultLine, originalLine: resultLine + 10, lineCount, path: 'src/a.ts' };
}

const blame: FileBlame = {
  hunks: [hunk(SHA_A, 1, 2), hunk(UNCOMMITTED_SHA, 3, 1), hunk(SHA_B, 4, 1)],
  commits: {
    [SHA_A]: commit('Ada', NOW - 3 * DAY, 'add parser'),
    [SHA_B]: commit('Grace', NOW - DAY, 'fix $(alert) handling'),
  },
  totalLines: 4,
  lfs: false,
};

describe('current-line blame text', () => {
  it('renders the default templates', () => {
    expect(lineBlameText(blame, 2, DEFAULT_TEXT_SETTINGS, NOW)).toEqual({
      inline: 'Ada, 3 days ago • add parser',
      statusBar: '$(git-commit) Ada, 3 days ago',
      sha: SHA_A,
    });
  });

  it('marks uncommitted lines', () => {
    expect(lineBlameText(blame, 3, DEFAULT_TEXT_SETTINGS, NOW)).toEqual({
      inline: 'You • Uncommitted changes',
      statusBar: '$(edit) Uncommitted changes',
    });
  });

  it('has nothing past the last blamed line', () => {
    expect(lineBlameText(blame, 9, DEFAULT_TEXT_SETTINGS, NOW)).toBeUndefined();
  });

  it('follows custom templates and date styles', () => {
    const text = lineBlameText(
      blame,
      1,
      {
        inlineFormat: '${sha} ${email} ${ago} [${date}] ${unknown}',
        statusBarFormat: '${summary}',
        dateStyle: 'iso',
      },
      NOW,
    );
    const iso = formatDate(NOW - 3 * DAY, 'iso');
    expect(text?.inline).toBe(`aaaaaaa ada@example.invalid 3 days ago [${iso}] \${unknown}`);
    expect(text?.statusBar).toBe('$(git-commit) add parser');
  });

  it('keeps repository text from turning into status bar icons', () => {
    const text = lineBlameText(
      blame,
      4,
      { ...DEFAULT_TEXT_SETTINGS, statusBarFormat: '${summary}' },
      NOW,
    );
    expect(text?.statusBar).toBe('$(git-commit) fix $​(alert) handling');
    expect(escapeStatusBarIcons('$(x) and $(y)')).toBe('$​(x) and $​(y)');
  });

  it('clips long annotations to one line', () => {
    const long = {
      ...blame,
      commits: { ...blame.commits, [SHA_A]: commit('Ada', NOW, 'x'.repeat(400)) },
    };
    const text = lineBlameText(long, 1, DEFAULT_TEXT_SETTINGS, NOW);
    expect(text?.inline.length).toBe(MAX_INLINE_LENGTH);
    expect(text?.inline.endsWith('…')).toBe(true);
    expect(clip('one\r\ntwo\n  three', 100)).toBe('one two three');
  });

  it('describes an LFS file by the last change to its content on every line', () => {
    const lfs: FileBlame = {
      hunks: [hunk(SHA_A, 1, 1), hunk(SHA_B, 2, 2)],
      commits: blame.commits,
      totalLines: 3,
      lfs: true,
    };
    expect(lfsLastChange(lfs)?.sha).toBe(SHA_B);
    const text = lineBlameText(lfs, 120, DEFAULT_TEXT_SETTINGS, NOW);
    expect(text?.inline).toBe('LFS file • Grace, 1 day ago • fix $(alert) handling');
    expect(text?.statusBar.startsWith('$(file-binary) ')).toBe(true);
    expect(text?.sha).toBe(SHA_B);

    const pending = { ...lfs, hunks: [...lfs.hunks, hunk(UNCOMMITTED_SHA, 3, 1)] };
    expect(lineBlameText(pending, 1, DEFAULT_TEXT_SETTINGS, NOW)?.inline).toMatch(
      /^LFS file \(uncommitted changes\) • /,
    );
  });

  it('maps a line to the line the commit wrote', () => {
    expect(originalLineOf(hunk(SHA_A, 5, 3), 7)).toBe(17);
  });
});

describe('templates and dates', () => {
  it('replaces known tokens only', () => {
    expect(
      renderTemplate('${author}/${nope}/${sha}', {
        author: 'A',
        email: '',
        date: '',
        ago: '',
        summary: '',
        sha: 'abc',
      }),
    ).toBe('A/${nope}/abc');
  });

  it('formats relative, ISO and absolute dates', () => {
    expect(formatDate(NOW - 2 * DAY, 'relative', NOW)).toBe('2 days ago');
    expect(formatDate(NOW, 'iso')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDate(NOW, 'absolute', NOW, 'en-US')).toMatch(/\d{4}/);
  });

  it('falls back to defaults for unusable settings', () => {
    expect(parseDateStyle('fancy')).toBe('relative');
    expect(parseDateStyle('iso')).toBe('iso');
    expect(parseFormat('   ', 'fallback')).toBe('fallback');
    expect(parseFormat(42, 'fallback')).toBe('fallback');
    expect(parseFormat('${sha}', 'fallback')).toBe('${sha}');
  });
});

describe('blame settings', () => {
  it('reads defaults when nothing is set', () => {
    expect(parseBlameSettings(() => undefined)).toEqual({
      currentLineEnabled: true,
      statusBar: 'auto',
      hoversEnabled: true,
      text: DEFAULT_TEXT_SETTINGS,
      options: { ignoreWhitespace: false, moves: 'off', ignoreRevs: true },
    });
  });

  it('reads every setting', () => {
    const values: Record<string, unknown> = {
      'currentLine.enabled': false,
      'currentLine.format': '${sha}',
      'statusBar.blame': 'show',
      'statusBar.format': '${author}',
      'hovers.enabled': false,
      'blame.dateStyle': 'absolute',
      'blame.ignoreWhitespace': true,
      'blame.detectMovedLines': 'acrossFiles',
      'blame.useIgnoreRevsFile': false,
    };
    expect(parseBlameSettings((key) => values[key])).toEqual({
      currentLineEnabled: false,
      statusBar: 'show',
      hoversEnabled: false,
      text: { inlineFormat: '${sha}', statusBarFormat: '${author}', dateStyle: 'absolute' },
      options: { ignoreWhitespace: true, moves: 'acrossFiles', ignoreRevs: false },
    });
  });

  it('steps aside for the built-in status bar blame only in auto', () => {
    expect(statusBarVisible('auto', true)).toBe(false);
    expect(statusBarVisible('auto', false)).toBe(true);
    expect(statusBarVisible('auto', undefined)).toBe(true);
    expect(statusBarVisible('show', true)).toBe(true);
    expect(statusBarVisible('hide', false)).toBe(false);
  });
});
