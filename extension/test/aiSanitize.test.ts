import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { escapeMarkdownText, sanitizeAiMarkdown } from '../src/ai/sanitize';

// The Markdown preview renders with markdown-it and raw HTML enabled, so
// sanitized output is checked against markdown-it itself, configured the
// same way. It is resolved through @vscode/vsce, which depends on it.
const vsceRequire = createRequire(
  createRequire(import.meta.url).resolve('@vscode/vsce/package.json'),
);
interface Token {
  type: string;
  attrGet(name: string): string | null;
  children: Token[] | null;
}
const MarkdownIt = vsceRequire('markdown-it') as new (options: object) => {
  parse(src: string, env: object): Token[];
  render(src: string): string;
};
const markdown = new MarkdownIt({ html: true, linkify: true });

const JOINER = '\u2060';
const visible = (text: string): string => text.split(JOINER).join('');

/** What the preview would load or follow from the sanitized text. */
function unsafeParts(text: string): string[] {
  const found: string[] = [];
  const visit = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (token.type === 'image' || token.type === 'html_inline' || token.type === 'html_block') {
        found.push(token.type);
      }
      if (token.type === 'link_open') {
        const href = token.attrGet('href') ?? '';
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
        if (scheme && !['http', 'https', 'mailto'].includes(scheme)) found.push(`link ${href}`);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(sanitizeAiMarkdown(text), {}));
  if (/<img\b/i.test(markdown.render(sanitizeAiMarkdown(text)))) found.push('<img>');
  return found;
}

describe('sanitizeAiMarkdown', () => {
  it('turns images into their alt text, so nothing is fetched', () => {
    expect(sanitizeAiMarkdown('See ![diagram](https://evil.example/x.png?d=secret) here')).toBe(
      'See [image: diagram] here',
    );
    expect(sanitizeAiMarkdown('![](https://evil.example/p)')).toBe('[image]');
    // Reference-style and nested images cannot form either.
    expect(sanitizeAiMarkdown('![x][ref]\n\n[ref]: https://evil.example/p')).toBe(
      `!${JOINER}[x][ref]\n\n[ref]: https://evil.example/p`,
    );
    expect(unsafeParts('![x][ref]\n\n[ref]: https://evil.example/p')).toEqual([]);
    expect(unsafeParts('![![x](https://a.example/1)](https://a.example/2)')).toEqual([]);
    expect(unsafeParts('![x](\nhttps://evil.example/p)')).toEqual([]);
  });

  it('shows raw HTML and autolinks as text', () => {
    expect(visible(sanitizeAiMarkdown('<img src="https://evil.example/p">'))).toBe(
      '<img src="https://evil.example/p">',
    );
    for (const html of [
      '<img src="https://evil.example/p">',
      'a <style>body{background:url(https://evil.example/p)}</style> b',
      '<div>\n\n![x](https://evil.example/p)\n\n</div>',
      '<!-- x --><?php ?><!DOCTYPE html>',
      '<https://example.com>',
      '<picture><source srcset="https://evil.example/p"></picture>',
    ]) {
      expect(unsafeParts(html)).toEqual([]);
    }
    // A comparison is not a tag and is left alone.
    expect(sanitizeAiMarkdown('if a < b and 2<3')).toBe('if a < b and 2<3');
  });

  it('keeps web and mail links, and disarms every other target', () => {
    expect(sanitizeAiMarkdown('[docs](https://example.com/a "t")')).toBe(
      '[docs](https://example.com/a "t")',
    );
    expect(sanitizeAiMarkdown('[mail](mailto:a@b.c)')).toBe('[mail](mailto:a@b.c)');
    expect(sanitizeAiMarkdown('[top](#summary)')).toBe('[top](#summary)');
    for (const link of [
      '[run](command:workbench.action.terminal.new)',
      '[x](javascript:alert(1))',
      '[x](<command:evil>)',
      '[x](\ncommand:evil)',
      '[x](command\\:evil)',
      '[x]\n\n[x]: command:evil',
      '> [x]: command:evil\n\n[x]',
      '- [x]:\n  command:evil\n\n[x]',
    ]) {
      expect(unsafeParts(link)).toEqual([]);
    }
  });

  it('cannot be fooled by text that only looks like code', () => {
    // Each of these once kept an image or raw HTML out of the sanitizer's
    // reach while the preview still rendered it.
    for (const text of [
      'see \\`![x](https://evil.example/a.png)` here',
      'see \\`<img src="https://evil.example/b.png">` here',
      '```js`\n![x](https://evil.example/c.png)\n',
      '- item\n  ```\n![x](https://evil.example/d.png)\n',
      '> ```\n> code\n\n![x](https://evil.example/e.png)\n',
      'a `b\nc` ![x](https://evil.example/f.png) `d`',
      '| `a | ![x](https://evil.example/g.png) ` |\n| - | - |',
      '[x](https://a.example/`) ![y](https://evil.example/h.png) `',
      '$$\n```\n$$\n![x](https://evil.example/i.png)\n```',
      '    ```\n![x](https://evil.example/j.png)',
      '<div>\n```\n</div>\n![x](https://evil.example/k.png)\n```',
    ]) {
      expect(unsafeParts(text), text).toEqual([]);
    }
  });

  it('leaves code reading exactly as written', () => {
    const fenced = '```html\n<img src="x"> <b>bold</b>\n```';
    expect(visible(sanitizeAiMarkdown(fenced))).toBe(fenced);
    const span = 'use `<div>` and `List<String>` but not <div>';
    expect(visible(sanitizeAiMarkdown(span))).toBe(span);
    expect(markdown.render(sanitizeAiMarkdown(span))).toContain(
      `<code>&lt;${JOINER}div&gt;</code>`,
    );
  });

  it('leaves ordinary explanations untouched', () => {
    const text =
      '# Fix crash\n\n- **What changed:** `parse()` now checks bounds.\n- Why: see [#12](https://github.com/o/r/issues/12).';
    expect(sanitizeAiMarkdown(text)).toBe(text);
  });

  it('holds for any mix of Markdown punctuation', () => {
    const pieces = [
      '`',
      '``',
      '```',
      '~~~',
      '\\',
      '!',
      '[',
      ']',
      '(',
      ')',
      '<',
      '>',
      ':',
      '|',
      '$$',
      '$',
      '*',
      '-',
      '#',
      ' ',
      '    ',
      '\n',
      '\n\n',
      '> ',
      '- ',
      'img src="https://evil.example/p"',
      '<img src="https://evil.example/p">',
      '![x](https://evil.example/p.png)',
      '[x](command:evil)',
      '\\`',
      'https://evil.example/p.png',
      'command:evil',
      'x',
      '"t"',
      '&#33;',
      '&lt;',
    ];
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 3000; round++) {
      const text = Array.from({ length: 4 + random(40) }, () => pieces[random(pieces.length)]).join(
        '',
      );
      const sanitized = sanitizeAiMarkdown(text);
      expect(sanitized, text).not.toMatch(/!\[|<[A-Za-z/!?]/);
      expect(unsafeParts(text), text).toEqual([]);
    }
  });
});

describe('escapeMarkdownText', () => {
  it('makes a commit subject read literally, whatever it contains', () => {
    const subject = 'fix: tidy \\`![x](https://evil.example/t.png?r=REPO)` <b>*now*</b>';
    const heading = sanitizeAiMarkdown(`# ${escapeMarkdownText(subject)}\n\nBody.`);
    expect(unsafeParts(`# ${escapeMarkdownText(subject)}`)).toEqual([]);
    const html = markdown.render(heading);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<em>');
    expect(html.split('\n')[0]).toBe(
      `<h1>fix: tidy \\\`![x](https://evil.example/t.png?r=REPO)\` &lt;${JOINER}b&gt;*now*&lt;/b&gt;</h1>`,
    );
  });
});
