import { describe, expect, it } from 'vitest';
import {
  biggestFirstCap,
  buildDiffContext,
  categorizeFile,
  estimateTokens,
  isGeneratedPath,
  rankFiles,
} from '../src/ai/contextBuilder';

describe('categorizeFile', () => {
  it('classifies source, config, and docs paths', () => {
    expect(categorizeFile('src/engine/engineClient.ts')).toBe('source');
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
});
