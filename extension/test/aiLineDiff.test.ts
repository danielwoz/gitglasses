// The line diff Explain Commit uses where git cannot run: every result must
// apply back to the new text, and be as small as git's own minimal diff.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diffLines, splitLines, unifiedDiff } from '../src/ai/lineDiff';

/** Applies unified hunks to `before`, checking every context and removed line. */
function applyHunks(before: string, hunks: string): string {
  const source = splitLines(before);
  const out: string[] = [];
  let cursor = 0;
  const lines = hunks === '' ? [] : hunks.split('\n');
  for (let i = 0; i < lines.length;) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]);
    if (!header) throw new Error(`bad hunk header: ${lines[i]}`);
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2]);
    const from = oldCount === 0 ? oldStart : oldStart - 1;
    while (cursor < from) out.push(source[cursor++]);
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const kind = lines[i][0];
      const text = lines[i].slice(1);
      if (kind === '+') out.push(text);
      else {
        if (source[cursor] !== text) throw new Error(`mismatch at ${cursor}: ${text}`);
        if (kind === ' ') out.push(text);
        cursor++;
      }
      i++;
    }
  }
  while (cursor < source.length) out.push(source[cursor++]);
  return out.join('\n') + (out.length > 0 ? '\n' : '');
}

function changedLineCount(hunks: string): number {
  return hunks.split('\n').filter((line) => /^[+-]/.test(line) && !line.startsWith('@@')).length;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'gg-linediff-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** git's own minimal diff of the two texts, hunks only. */
function gitHunks(before: string, after: string): string {
  const a = path.join(scratch, 'a');
  const b = path.join(scratch, 'b');
  writeFileSync(a, before);
  writeFileSync(b, after);
  try {
    execFileSync('git', ['diff', '--no-index', '--minimal', '--no-color', '-U3', a, b], {
      encoding: 'utf8',
    });
    return '';
  } catch (error) {
    const stdout = (error as { stdout: string }).stdout;
    // Drop the function-name context git appends to hunk headers.
    return stdout
      .slice(stdout.indexOf('@@'))
      .replace(/^(@@ [^@]+ @@).*$/gm, '$1')
      .trimEnd();
  }
}

/** A deterministic pseudo-random generator, so failures reproduce. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function mutate(lines: string[], random: () => number): string[] {
  const out = [...lines];
  const edits = 1 + Math.floor(random() * 6);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(random() * (out.length + 1));
    const roll = random();
    if (roll < 0.35 && out.length > 0) out.splice(at, 1 + Math.floor(random() * 3));
    else if (roll < 0.7) out.splice(at, 0, `inserted ${e} ${Math.floor(random() * 5)}`);
    else if (out.length > 0) out[Math.min(at, out.length - 1)] = `changed ${e}`;
  }
  return out;
}

describe('unifiedDiff', () => {
  it('renders a small change with context and correct line numbers', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'a\nb\nc\nD\ne\nf\ng\nh\ni\n';
    expect(unifiedDiff(before, after)).toBe(
      '@@ -1,8 +1,9 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n h\n+i',
    );
  });

  it('is empty for equal texts and handles empty sides', () => {
    expect(unifiedDiff('x\n', 'x\n')).toBe('');
    expect(unifiedDiff('', 'one\ntwo\n')).toBe('@@ -0,0 +1,2 @@\n+one\n+two');
    expect(unifiedDiff('one\n', '')).toBe('@@ -1,1 +0,0 @@\n-one');
  });

  it('separates distant changes into hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = before.replace('line 2\n', 'LINE 2\n').replace('line 25\n', 'LINE 25\n');
    const hunks = unifiedDiff(before, after);
    expect(hunks.match(/^@@/gm)).toHaveLength(2);
    expect(hunks).toBe(gitHunks(before, after));
  });

  it('applies back and is as small as git --minimal on generated edits', () => {
    const random = rng(42);
    for (let round = 0; round < 150; round++) {
      const base = Array.from(
        { length: Math.floor(random() * 40) },
        (_, i) => `l${Math.floor(random() * 8)} ${i % 3}`,
      );
      const before = base.length > 0 ? base.join('\n') + '\n' : '';
      const changed = mutate(base, random);
      const after = changed.length > 0 ? changed.join('\n') + '\n' : '';
      const ours = unifiedDiff(before, after);
      expect(applyHunks(before, ours), `round ${round}`).toBe(after);
      expect(changedLineCount(ours), `round ${round}`).toBe(
        changedLineCount(gitHunks(before, after)),
      );
    }
  });

  it('falls back to a replacement, still correct, when the edit distance is huge', () => {
    const before = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n') + '\n';
    const after = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n') + '\n';
    const ops = diffLines(splitLines(before), splitLines(after));
    expect(ops.filter((op) => op.kind === '-')).toHaveLength(1500);
    expect(applyHunks(before, unifiedDiff(before, after))).toBe(after);
  });
});
