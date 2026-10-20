// The trailer paragraph that closes a commit message body: the `Key: value`
// lines commit/details parses into `trailers`. Views that list the trailers
// on their own show the body without them.

/** One trailer, as commit/details reports it. */
export interface Trailer {
  key: string;
  value: string;
}

/** One line of the trailer paragraph. */
export interface TrailerLine {
  /** The line as written, with the lines that continue it. */
  text: string;
  /** False for a line among the trailers that is not one, such as
   *  "(cherry picked from commit …)". */
  trailer: boolean;
}

export interface TrailerBlock {
  /** Index of the paragraph's first line among the body's lines. */
  start: number;
  lines: TrailerLine[];
}

/** A trailer line as libgit2 reads one: a key of letters, digits and
 *  hyphens, optional blanks, the colon, optional blanks, the value. */
const TRAILER_LINE = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/;

/** The body's lines, whatever its line endings. */
export function bodyLines(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split('\n');
}

/** Whitespace runs folded to one space, so values compare however they wrap. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The closing paragraph of `body` when it is the one `trailers` were parsed
 * from: its trailer lines, each with the lines that continue it (those
 * starting with a space), are exactly `trailers` in order. Undefined
 * otherwise, so text that merely looks like a trailer, or a closing
 * paragraph the trailers did not come from, is never taken for one.
 */
export function trailerBlock(body: string, trailers: readonly Trailer[]): TrailerBlock | undefined {
  if (trailers.length === 0) return undefined;
  const lines = bodyLines(body);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  if (start === end) return undefined;

  const block: Array<TrailerLine & { key?: string; value?: string }> = [];
  for (const line of lines.slice(start, end)) {
    const last = block[block.length - 1];
    if (last && line.startsWith(' ')) {
      last.text += `\n${line}`;
      if (last.value !== undefined) last.value += ` ${line}`;
      continue;
    }
    const match = TRAILER_LINE.exec(line);
    block.push(
      match
        ? { text: line, trailer: true, key: match[1], value: match[2] }
        : { text: line, trailer: false },
    );
  }
  const parsed = block.filter((line) => line.trailer);
  const same =
    parsed.length === trailers.length &&
    parsed.every(
      (line, i) =>
        line.key === trailers[i].key && fold(line.value ?? '') === fold(trailers[i].value),
    );
  return same ? { start, lines: block.map(({ text, trailer }) => ({ text, trailer })) } : undefined;
}

/**
 * `body` for a view that lists `trailers` on their own: without the trailer
 * lines of the paragraph they were parsed from. Other lines of that
 * paragraph stay, and a body whose trailers cannot be placed is returned
 * whole.
 */
export function bodyWithoutTrailers(body: string, trailers: readonly Trailer[]): string {
  const block = trailerBlock(body, trailers);
  if (!block) return body;
  const before = bodyLines(body).slice(0, block.start).join('\n').trimEnd();
  const kept = block.lines.filter((line) => !line.trailer).map((line) => line.text);
  return [before, kept.join('\n')].filter((part) => part !== '').join('\n\n');
}
