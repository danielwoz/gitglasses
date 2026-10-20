// Neutralises AI output before the Markdown preview renders it. The model
// reads repository text (commit messages, diffs) that anyone can write, so an
// injected instruction could make it emit an image or HTML whose URL carries
// the context off the machine when the preview loads it.
//
// Nothing here parses Markdown, because a parser of its own would have to
// agree with the preview's on every escape, code span, fence and container to
// be safe. Instead every character sequence that could open an image, raw
// HTML, an autolink or a link to anything but a web or mail address is broken
// with an invisible word joiner, wherever it appears: no Markdown parser can
// then read one into the result. Inside code, where the sequence did no harm,
// the joiner is invisible and the code reads the same.

const JOINER = '⁠';

const SAFE_LINK = /^(https?:|mailto:|#)/i;

/** Makes text from a repository read literally as Markdown inline text:
 *  every ASCII punctuation character is backslash-escaped. */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

export function sanitizeAiMarkdown(markdown: string): string {
  return (
    markdown
      // Inline images read as their alt text.
      .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (_match, alt: string) =>
        alt.trim() ? `[image: ${alt.trim()}]` : '[image]',
      )
      // Any other image opener (reference style, nested, split over lines).
      .replace(/!\[/g, `!${JOINER}[`)
      // Links, inline or through a reference definition, keep only web and
      // mail targets. A destination may follow on the next line.
      .replace(/\](\(|:)(\s*<?)([^\s)>]*)/g, (match, opener: string, _gap, target: string) =>
        (opener === '(' && target === '') || SAFE_LINK.test(target)
          ? match
          : `]${JOINER}${match.slice(1)}`,
      )
      // Raw HTML, comments, declarations and autolinks show as text.
      .replace(/<(?=[A-Za-z/!?])/g, `<${JOINER}`)
  );
}
