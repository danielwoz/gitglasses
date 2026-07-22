import { describe, expect, it } from 'vitest';
import { buildPatchCommentBody } from '../src/reviews/suggestLogic';

describe('buildPatchCommentBody', () => {
  it('links the shared patch URL with the file and line range', () => {
    const body = buildPatchCommentBody({
      path: 'src/auth/login.ts',
      startLine: 10,
      endLine: 12,
      replacement: 'const ok = true;',
      comment: 'Simplify the retry logic.',
      patchUrl: 'https://gist.github.com/abc123',
    });
    expect(body).toContain('`src/auth/login.ts`');
    expect(body).toContain('lines 10-12');
    expect(body).toContain('Simplify the retry logic.');
    expect(body).toContain('```\nconst ok = true;\n```');
    expect(body).toContain('https://gist.github.com/abc123');
    expect(body).toContain('Apply Patch');
  });

  it('uses singular "line N" for a one-line range', () => {
    const body = buildPatchCommentBody({
      path: 'a.txt',
      startLine: 7,
      endLine: 7,
      replacement: 'x',
      patchUrl: 'https://example.com/p',
    });
    expect(body).toContain('(line 7)');
    expect(body).not.toContain('lines 7');
  });

  it('falls back to naming the patch file when there is no URL', () => {
    const body = buildPatchCommentBody({
      path: 'a.txt',
      startLine: 1,
      endLine: 2,
      replacement: 'x',
      patchFileName: 'fix-login.ggpatch',
    });
    expect(body).toContain('`fix-login.ggpatch`');
    expect(body).toContain('shared separately');
    expect(body).not.toContain('http');
  });

  it('omits the prose paragraph when no comment is given', () => {
    const withComment = buildPatchCommentBody({
      path: 'a.txt',
      startLine: 1,
      endLine: 1,
      replacement: 'x',
      comment: 'PROSE-MARKER',
      patchUrl: 'https://example.com/p',
    });
    const withoutComment = buildPatchCommentBody({
      path: 'a.txt',
      startLine: 1,
      endLine: 1,
      replacement: 'x',
      comment: '   ',
      patchUrl: 'https://example.com/p',
    });
    expect(withComment).toContain('PROSE-MARKER');
    expect(withoutComment).not.toContain('   \n');
  });

  it('grows the code fence past backtick runs in the replacement', () => {
    const body = buildPatchCommentBody({
      path: 'a.md',
      startLine: 1,
      endLine: 1,
      replacement: 'text with ```三 fences``` inside',
      patchUrl: 'https://example.com/p',
    });
    expect(body).toContain('````\ntext with ```三 fences``` inside\n````');
  });
});
