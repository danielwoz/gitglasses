// The patch a suggestion shares holds the suggested lines and nothing else,
// and it has to apply where the engine applies patches: `git apply --3way` in
// a checkout of the pull request head. Each case applies it to a real
// repository and compares the result.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSuggestionPatch,
  fallbackButtons,
  fallbackConfirmDetail,
  firstMismatchedLine,
  patchUploadFor,
  PREVIEW_PATCH,
} from '../src/reviews/suggestLogic';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    // stderr is kept off the test output: without blob ids in the patch,
    // --3way says so before applying directly.
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Commits `content` at `file` in a new repository and applies `patch` to it. */
function applyToCommitted(file: string, content: string, patch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-suggest-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'suggestion.patch'), patch);
  git(dir, 'apply', '--3way', 'suggestion.patch');
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('buildSuggestionPatch', () => {
  it('replaces only the selected lines, with three lines of context', () => {
    const result = buildSuggestionPatch({
      path: 'src/a.ts',
      headText: TEN,
      startLine: 5,
      endLine: 6,
      replacement: 'five\nsix\n',
    });
    expect(result).toMatchObject({ added: 2, removed: 2 });
    expect(result?.patch).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -2,8 +2,8 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '-line 6',
        '+five',
        '+six',
        ' line 7',
        ' line 8',
        ' line 9',
        '',
      ].join('\n'),
    );
    expect(applyToCommitted('src/a.ts', TEN, result!.patch)).toBe(
      TEN.replace('line 5\nline 6', 'five\nsix'),
    );
  });

  it.each([
    ['the first line', 1, 1, 'first', TEN.replace('line 1\n', 'first\n')],
    ['the last line', 10, 10, 'last', TEN.replace('line 10\n', 'last\n')],
    ['lines, removing them', 3, 4, '', TEN.replace('line 3\nline 4\n', '')],
    ['one line with three', 2, 2, 'a\nb\nc', TEN.replace('line 2\n', 'a\nb\nc\n')],
  ])('applies when replacing %s', (_what, startLine, endLine, replacement, expected) => {
    const result = buildSuggestionPatch({
      path: 'a.txt',
      headText: TEN,
      startLine,
      endLine,
      replacement,
    });
    expect(applyToCommitted('a.txt', TEN, result!.patch)).toBe(expected);
  });

  it('keeps a missing final newline missing', () => {
    const head = 'one\ntwo\nthree';
    for (const [start, end, replacement, expected] of [
      [3, 3, 'THREE', 'one\ntwo\nTHREE'],
      [2, 2, 'TWO', 'one\nTWO\nthree'],
      [3, 3, '', 'one\ntwo\n'],
    ] as const) {
      const result = buildSuggestionPatch({
        path: 'a.txt',
        headText: head,
        startLine: start,
        endLine: end,
        replacement,
      });
      expect(result?.patch).toContain('\\ No newline at end of file');
      expect(applyToCommitted('a.txt', head, result!.patch)).toBe(expected);
    }
  });

  it('writes LF lines for a head read with CRLF endings', () => {
    const result = buildSuggestionPatch({
      path: 'a.txt',
      headText: 'one\r\ntwo\r\nthree\r\n',
      startLine: 2,
      endLine: 2,
      replacement: 'TWO',
    });
    expect(result?.patch).not.toContain('\r');
    expect(applyToCommitted('a.txt', 'one\ntwo\nthree\n', result!.patch)).toBe('one\nTWO\nthree\n');
  });

  it('quotes a path git would quote, and still applies', () => {
    const file = 'dir with space/naïve "x".txt';
    const result = buildSuggestionPatch({
      path: file,
      headText: 'a\nb\n',
      startLine: 1,
      endLine: 1,
      replacement: 'A',
    });
    expect(result?.patch.split('\n')[1]).toBe('--- "a/dir with space/na\\303\\257ve \\"x\\".txt"');
    expect(applyToCommitted(file, 'a\nb\n', result!.patch)).toBe('A\nb\n');
  });

  it('has nothing to share when the replacement changes nothing or misses the file', () => {
    const base = { path: 'a.txt', headText: TEN };
    expect(
      buildSuggestionPatch({ ...base, startLine: 2, endLine: 3, replacement: 'line 2\nline 3\n' }),
    ).toBeUndefined();
    const outside = { ...base, startLine: 11, endLine: 11, replacement: 'x' };
    expect(buildSuggestionPatch(outside)).toBeUndefined();
    const backwards = { ...base, startLine: 4, endLine: 3, replacement: 'x' };
    expect(buildSuggestionPatch(backwards)).toBeUndefined();
  });
});

describe('firstMismatchedLine', () => {
  it('accepts a selection whose lines and everything above match the head', () => {
    expect(firstMismatchedLine(TEN, TEN, 6)).toBeUndefined();
    // Edits below the selection do not move it.
    expect(firstMismatchedLine(TEN.replace('line 9', 'changed'), TEN, 6)).toBeUndefined();
    expect(firstMismatchedLine(TEN.replace(/\n/g, '\r\n'), TEN, 6)).toBeUndefined();
  });

  it('reports the first differing line at or above the selection', () => {
    // An uncommitted line above the selection shifts every line below it.
    const local = TEN.replace('line 2\n', 'line 2\ninserted\n');
    expect(firstMismatchedLine(local, TEN, 6)).toBe(3);
    expect(firstMismatchedLine(TEN.replace('line 6', 'edited'), TEN, 6)).toBe(6);
  });

  it('reports a selection past the end of the head file', () => {
    expect(firstMismatchedLine(`${TEN}line 11\n`, TEN, 11)).toBe(11);
  });
});

describe('patchUploadFor', () => {
  it('offers a secret gist on GitHub and GitHub Enterprise Server', () => {
    expect(patchUploadFor('github', 'github.com')?.where).toBe('a secret gist on github.com');
    expect(patchUploadFor('github-enterprise', 'ghe.corp')?.where).toBe(
      'a secret gist on ghe.corp',
    );
    expect(patchUploadFor('github', 'github.com')?.visibility).toMatch(/anyone with its link/);
  });

  it('offers no upload where the link would be unreadable or public', () => {
    expect(patchUploadFor('gitlab', 'gitlab.com')).toBeUndefined();
    expect(patchUploadFor('bitbucket', 'bitbucket.org')).toBeUndefined();
  });
});

describe('fallbackConfirmDetail', () => {
  const pr = { repo: { owner: 'acme', name: 'widgets' }, number: 7, title: 'Fix login' };
  const patch = buildSuggestionPatch({
    path: 'a.txt',
    headText: TEN,
    startLine: 5,
    endLine: 5,
    replacement: 'five',
  });

  it('names the pull request, the file, the upload and who can read it, and shows the diff', () => {
    const detail = fallbackConfirmDetail({
      pr,
      path: 'a.txt',
      startLine: 5,
      endLine: 5,
      patch,
      upload: patchUploadFor('github', 'github.com'),
    });
    expect(detail).toContain('acme/widgets#7 "Fix login"');
    expect(detail).toContain('a.txt, line 5 (+1 -1)');
    expect(detail).toContain('Nothing else from your working tree is included');
    expect(detail).toContain('a secret gist on github.com');
    expect(detail).toContain('anyone with its link can read it');
    expect(detail).toContain('-line 5\n+five');
  });

  it('describes the comment, the default, before the upload', () => {
    const detail = fallbackConfirmDetail({
      pr,
      path: 'a.txt',
      startLine: 5,
      endLine: 5,
      patch,
      upload: patchUploadFor('github', 'github.com'),
    });
    expect(detail.indexOf('Comment Only')).toBeGreaterThan(-1);
    expect(detail.indexOf('Comment Only')).toBeLessThan(detail.indexOf('Upload Secret Gist'));
  });

  it('says nothing is uploaded when the patch goes in the comment', () => {
    const detail = fallbackConfirmDetail({ pr, path: 'a.txt', startLine: 5, endLine: 5, patch });
    expect(detail).toContain('nothing is uploaded anywhere else');
    expect(detail).not.toContain('gist');
  });
});

describe('fallbackButtons', () => {
  it('puts posting in the comment first, so the default uploads nothing', () => {
    const upload = patchUploadFor('github', 'github.com');
    expect(fallbackButtons(upload, true)).toEqual([
      'Comment Only',
      'Upload Secret Gist and Comment',
      PREVIEW_PATCH,
    ]);
    expect(fallbackButtons(undefined, true)).toEqual(['Post Comment', PREVIEW_PATCH]);
    expect(fallbackButtons(undefined, false)).toEqual(['Post Comment']);
  });
});
