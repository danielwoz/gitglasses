// Neutralises AI output before the Markdown preview renders it. The model
// reads repository text (commit messages, diffs) that anyone can write, so an
// injected instruction could make it emit an image or HTML whose URL carries
// the context off the machine when the preview loads it. Nothing here loads
// anything: images become their alt text, raw HTML shows as text, and links
// keep only web and mail targets. Code blocks and code spans are left alone,
// since the preview never renders their contents.

const SAFE_LINK = /^(https?:|mailto:|#)/i;

/** Escapes what a line of Markdown text (outside code) could render as an
 *  image, HTML or a non-web link. */
function sanitizeText(text: string): string {
  return (
    text
      // Inline images: keep the alt text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) =>
        alt.trim() ? `[image: ${alt.trim()}]` : '[image]',
      )
      // Anything else that would start an image (reference style, nested).
      .replace(/!\[/g, '!\\[')
      // Raw HTML and autolinks show as text.
      .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
      // Links whose target is not a web or mail address lose their target.
      .replace(/\]\(\s*<?([^)\s>]*)>?([^)]*)\)/g, (match, target: string) =>
        target === '' || SAFE_LINK.test(target) ? match : `] (${target})`,
      )
  );
}

/** Splits a line into code spans (kept) and text (sanitized). */
function sanitizeLine(line: string): string {
  // A reference definition can point a link anywhere; keep it only when
  // its target is a web or mail address.
  const definition = /^( {0,3})\[([^\]]+)\]:\s*<?(\S*?)>?(\s.*)?$/.exec(line);
  if (definition && !SAFE_LINK.test(definition[3])) {
    return `${definition[1]}\\[${definition[2]}]: ${definition[3]}`;
  }
  let out = '';
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick < 0) {
      out += sanitizeText(line.slice(i));
      break;
    }
    out += sanitizeText(line.slice(i, tick));
    let run = tick;
    while (run < line.length && line[run] === '`') run++;
    const fence = line.slice(tick, run);
    const close = line.indexOf(fence, run);
    if (close < 0) {
      out += fence;
      i = run;
      continue;
    }
    out += line.slice(tick, close + fence.length);
    i = close + fence.length;
  }
  return out;
}

export function sanitizeAiMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  let fence: string | undefined;
  return lines
    .map((line) => {
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) {
          fence = undefined;
        }
        return line;
      }
      if (opener) {
        fence = opener[1];
        return line;
      }
      return sanitizeLine(line);
    })
    .join('\n');
}
