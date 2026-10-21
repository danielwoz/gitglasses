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

  it('folds the patch into the comment when nothing was uploaded', () => {
    const envelope = '{\n  "format": "gitglasses-patch"\n}\n';
    const body = buildPatchCommentBody({
      path: 'a.txt',
      startLine: 1,
      endLine: 2,
      replacement: 'x',
      inlineEnvelope: envelope,
    });
    expect(body).toContain('<details><summary>');
    expect(body).toContain('```json\n{\n  "format": "gitglasses-patch"\n}\n```');
    expect(body).toContain('From Clipboard');
    expect(body).not.toContain('http');
  });

  it('carries only the replacement when there is no patch at all', () => {
    const body = buildPatchCommentBody({
      path: 'a.txt',
      startLine: 1,
      endLine: 1,
      replacement: 'x',
    });
    expect(body).toContain('Proposed replacement');
    expect(body).not.toContain('Apply Patch');
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
