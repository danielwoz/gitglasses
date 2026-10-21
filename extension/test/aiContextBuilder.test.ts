import { describe, expect, it } from 'vitest';
import {
  biggestFirstCap,
  buildDiffContext,
  categorizeFile,
  estimateTokens,
  isGeneratedPath,
  pickFilesToShow,
  rankFiles,
  splitPatch,
  unquoteGitPath,
  wholePatchFits,
  WHOLE_PATCH_MAX_FILES,
  WHOLE_PATCH_MAX_LINES,
} from '../src/ai/contextBuilder';

describe('categorizeFile', () => {
  it('classifies source, config, and docs paths', () => {
    expect(categorizeFile('src/model/blameModel.ts')).toBe('source');
    expect(categorizeFile('lib/native/blame.cc')).toBe('source');
    expect(categorizeFile('tsconfig.json')).toBe('config');
    expect(categorizeFile('.eslintrc')).toBe('config');
    expect(categorizeFile('ci/deploy.yaml')).toBe('config');
    expect(categorizeFile('README.md')).toBe('docs');
    expect(categorizeFile('docs/architecture.html')).toBe('docs');
  });
});

describe('isGeneratedPath', () => {
  it('drops lockfiles and generated output', () => {
    expect(isGeneratedPath('package-lock.json')).toBe(true);
    expect(isGeneratedPath('pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedPath('deps/Cargo.lock')).toBe(true);
    expect(isGeneratedPath('vendor/lib.min.js')).toBe(true);
    expect(isGeneratedPath('dist/extension.js')).toBe(true);
    expect(isGeneratedPath('node_modules/pkg/index.js')).toBe(true);
    expect(isGeneratedPath('proto/generated/schema.ts')).toBe(true);
  });

  it('keeps ordinary files', () => {
    expect(isGeneratedPath('src/lockScreen.ts')).toBe(false);
    expect(isGeneratedPath('package.json')).toBe(false);
    expect(isGeneratedPath('distribution.md')).toBe(false);
  });
});

describe('rankFiles', () => {
  it('orders source before config before docs, stably within a category', () => {
    const ranked = rankFiles([
      { path: 'README.md' },
      { path: 'b.ts' },
      { path: 'settings.yaml' },
      { path: 'a.ts' },
      { path: 'CHANGELOG.md' },
    ]);
    expect(ranked.map((file) => file.path)).toEqual([
      'b.ts',
      'a.ts',
      'settings.yaml',
      'README.md',
      'CHANGELOG.md',
    ]);
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('biggestFirstCap', () => {
  it('returns an unbounded cap when everything fits', () => {
    expect(biggestFirstCap([100, 100], 1000)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('caps the biggest entries while smaller ones stay whole', () => {
    // 500 fits whole; the 5000-char entry is squeezed into the remainder.
    expect(biggestFirstCap([500, 5000], 1000)).toBe(500);
  });

  it('returns undefined when no useful allocation exists', () => {
    expect(biggestFirstCap([5000, 5000, 5000], 200)).toBeUndefined();
  });
});

describe('buildDiffContext', () => {
  it('returns a placeholder for an empty diff', () => {
    const context = buildDiffContext([], 1000);
    expect(context.text).toBe('(no changes)');
    expect(context.includedPaths).toEqual([]);
    expect(context.omittedPaths).toEqual([]);
    expect(context.truncated).toBe(false);
  });

  it('includes everything untouched when the budget is ample', () => {
    const context = buildDiffContext(
      [
        { path: 'a.ts', patch: '+one line' },
        { path: 'b.md', patch: '+docs line' },
      ],
      10_000,
    );
    expect(context.text).toContain('=== a.ts ===');
    expect(context.text).toContain('+one line');
    expect(context.text).toContain('+docs line');
    expect(context.truncated).toBe(false);
    expect(context.omittedPaths).toEqual([]);
  });

  it('excludes lockfiles and notes them as omitted', () => {
    const context = buildDiffContext(
      [
        { path: 'src/main.ts', patch: '+real change' },
        { path: 'package-lock.json', patch: 'x'.repeat(5000) },
      ],
      10_000,
    );
    expect(context.includedPaths).toEqual(['src/main.ts']);
    expect(context.omittedPaths).toEqual(['package-lock.json']);
    expect(context.text).toContain('… and 1 more file omitted: package-lock.json');
    expect(context.text).not.toContain('xxxx');
  });

  it('truncates the biggest patch first, keeping small files whole', () => {
    const small = '+small change';
    const context = buildDiffContext(
      [
        { path: 'big.ts', patch: 'y'.repeat(10_000) },
        { path: 'small.ts', patch: small },
      ],
      500,
    );
    expect(context.truncated).toBe(true);
    expect(context.text).toContain(small);
    expect(context.text).toContain('… [truncated]');
    // Budget respected: 500 tokens ≈ 2000 chars.
    expect(context.text.length).toBeLessThanOrEqual(500 * 4);
  });

  it('omits lowest-ranked files with a count note when the budget is tiny', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `file${i}.ts`,
      patch: 'z'.repeat(1000),
    }));
    const context = buildDiffContext(files, 150);
    expect(context.includedPaths.length).toBeGreaterThan(0);
    expect(context.omittedPaths.length).toBeGreaterThan(0);
    expect(context.text).toMatch(/… and \d+ more files? omitted:/);
    // Omission takes from the end of the ranking.
    expect(context.includedPaths[0]).toBe('file0.ts');
    expect(context.omittedPaths).toContain('file4.ts');
  });

  it('still reports generated omissions when nothing else changed', () => {
    const context = buildDiffContext([{ path: 'yarn.lock', patch: 'big' }], 1000);
    expect(context.includedPaths).toEqual([]);
    expect(context.text).toContain('(no changes)');
    expect(context.text).toContain('yarn.lock');
  });

  /** Keeps the longest run of top-ranked files that fits by dropping the
   *  last one at a time: the result the search must reproduce. */
  function includedByDroppingOneAtATime(files: { path: string; patch: string }[], budget: number) {
    const ranked = rankFiles(files.filter((file) => !isGeneratedPath(file.path)));
    const included = [...ranked];
    for (; included.length > 0; included.pop()) {
      const overhead = included.reduce(
        (sum, file) => sum + `=== ${file.path} ===\n`.length + '\n… [truncated]'.length + 1,
        0,
      );
      const cap = biggestFirstCap(
        included.map((file) => file.patch.length),
        budget * 4 - overhead,
      );
      if (cap !== undefined) break;
    }
    return included.map((file) => file.path);
  }

  it('keeps the same files as dropping the lowest-ranked one at a time', () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const names = ['src/a.ts', 'lib/b.c', 'conf.yaml', 'docs/x.md', 'README.md', 'pnpm-lock.yaml'];
    for (let round = 0; round < 300; round++) {
      const files = Array.from({ length: random(60) }, (_, i) => ({
        path: `${i}/${names[random(names.length)]}`,
        patch: 'p'.repeat(random(4) === 0 ? random(20_000) : random(600)),
      }));
      const budget = [50, 200, 1000, 6000][random(4)];
      expect(buildDiffContext(files, budget).includedPaths).toEqual(
        includedByDroppingOneAtATime(files, budget),
      );
    }
  });

  it('stays quick on a commit with tens of thousands of files', () => {
    const files = Array.from({ length: 40_000 }, (_, i) => ({
      path: `vendor/lib/module${i}/index.js`,
      patch: `diff --git a/vendor/lib/module${i}/index.js b/vendor/lib/module${i}/index.js\n+export const a${i} = 1;`,
    }));
    const started = performance.now();
    const context = buildDiffContext(files, 6000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(context.includedPaths.length).toBeGreaterThan(0);
    expect(context.includedPaths.length + context.omittedPaths.length).toBe(40_000);
    expect(context.text.length).toBeLessThanOrEqual(6000 * 4 + 1000);
  });
});

describe('pickFilesToShow', () => {
  it('takes the best-ranked files and lists generated ones last', () => {
    const picked = pickFilesToShow(
      [
        { path: 'pnpm-lock.yaml' },
        { path: 'README.md' },
        { path: 'src/b.ts' },
        { path: 'config.json' },
        { path: 'src/a.ts' },
      ],
      4,
    );
    expect(picked.map((file) => file.path)).toEqual([
      'src/b.ts',
      'src/a.ts',
      'config.json',
      'README.md',
    ]);
    expect(pickFilesToShow([{ path: 'yarn.lock' }], 30).map((file) => file.path)).toEqual([
      'yarn.lock',
    ]);
  });
});

describe('wholePatchFits', () => {
  const commit = (files: number, lines: number, truncated = false) => ({
    truncated,
    files: Array.from({ length: files }),
    stats: { additions: lines, deletions: 0 },
  });

  it('reads an ordinary commit whole', () => {
    expect(wholePatchFits(commit(12, 400))).toBe(true);
    expect(wholePatchFits(commit(WHOLE_PATCH_MAX_FILES, WHOLE_PATCH_MAX_LINES))).toBe(true);
  });

  it('does not read a vendor drop or an initial import whole', () => {
    expect(wholePatchFits(commit(WHOLE_PATCH_MAX_FILES + 1, 10))).toBe(false);
    expect(wholePatchFits(commit(3, WHOLE_PATCH_MAX_LINES + 1))).toBe(false);
    expect(wholePatchFits(commit(2000, 10, true))).toBe(false);
  });
});

describe('splitPatch', () => {
  const patch = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' same',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/old name.md b/new name.md',
    'similarity index 100%',
    'rename from old name.md',
    'rename to new name.md',
    'diff --git "a/t\\303\\244st \\"q\\".txt" "b/t\\303\\244st \\"q\\".txt"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/t\\303\\244st \\"q\\".txt"',
    '@@ -0,0 +1 @@',
    '+hi',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');

  it('splits git diff output into one section per file, named by its path', () => {
    const files = splitPatch(patch);
    expect(files.map((file) => file.path)).toEqual([
      'src/app.ts',
      'gone.txt',
      'new name.md',
      'täst "q".txt',
      'logo.png',
    ]);
    expect(files[0].patch).toBe(
      'diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same',
    );
    expect(files[4].patch).toContain('Binary files');
  });

  it('copes with prefix-less output and no files', () => {
    expect(
      splitPatch('diff --git x.txt x.txt\n--- x.txt\n+++ x.txt\n@@ -1 +1 @@\n-a\n+b\n')[0].path,
    ).toBe('x.txt');
    expect(splitPatch('')).toEqual([]);
  });
});

describe('unquoteGitPath', () => {
  it('decodes octal UTF-8 bytes and escapes, and leaves plain paths alone', () => {
    expect(unquoteGitPath('"a/t\\303\\244st\\tx\\\\y"')).toBe('a/täst\tx\\y');
    expect(unquoteGitPath('plain/path.ts')).toBe('plain/path.ts');
  });
});
