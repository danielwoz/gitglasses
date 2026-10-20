// The trailer paragraph of a commit message body, its last before any
// patch: the `Key: value` lines commit/details parses into `trailers`. Views
// that list the trailers on their own show the body without them; the blame
// hover keeps them, one per line.

/** One trailer, as commit/details reports it. */
export interface Trailer {
  key: string;
  value: string;
}

/** One line of the trailer paragraph. */
export interface TrailerLine {
  /** The line as written, with the lines that continue it. */
  text: string;
  /** False for a line among the trailers that views do not list as one:
   *  "(cherry picked from commit …)", say, or a URL git took for a trailer. */
  trailer: boolean;
}

export interface TrailerBlock {
  /** Index of the paragraph's first line among the body's lines. */
  start: number;
  /** Index just past its last line. */
  end: number;
  lines: TrailerLine[];
}

/** A trailer line as libgit2 reads one: a key of letters, digits and
 *  hyphens, optional blanks, the colon, optional blanks, the value. */
const TRAILER_LINE = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/;

/** A line where git takes a patch to start: "---", then a blank or nothing. */
const PATCH_START = /^---(?:[ \t\v\f\r]|$)/;

/** The body's lines, whatever its line endings. */
export function bodyLines(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split('\n');
}

/** Blank as git sees a line: nothing but ASCII whitespace. */
function isBlank(line: string): boolean {
  return /^[ \t\v\f\r]*$/.test(line);
}

/**
 * Index just past the lines git searches for trailers: those before a patch,
 * less the comment lines, empty lines and "Conflicts:" block after them.
 */
function trailerSearchEnd(lines: readonly string[]): number {
  let end = lines.findIndex((line) => PATCH_START.test(line));
  if (end === -1) end = lines.length;
  let tail: number | undefined;
  let conflicts = false;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) {
      tail ??= i;
    } else if (line === 'Conflicts:') {
      conflicts = true;
      tail ??= i;
    } else if (!(conflicts && line.startsWith('\t'))) {
      tail = undefined;
      conflicts = false;
    }
  }
  return tail ?? end;
}

/**
 * Whether views that list trailers on their own list `trailer`. A URL alone
 * on a line is not listed: git reads it as a trailer keyed by its scheme
 * ("https", "//example.com/…"), and it stays in the message instead.
 */
export function isListedTrailer(trailer: Trailer): boolean {
  return !trailer.value.startsWith('//');
}

/** Whitespace runs folded to one space, so values compare however they wrap. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The paragraph of `body` git reads trailers from, the last one before any
 * patch, when it is the one `trailers` were parsed from: its trailer lines,
 * each with the lines that continue it (those starting with a space), are
 * exactly `trailers` in order. Undefined otherwise, so text that merely
 * looks like a trailer, or a paragraph the trailers did not come from, is
 * never taken for one.
 */
export function trailerBlock(body: string, trailers: readonly Trailer[]): TrailerBlock | undefined {
  if (trailers.length === 0) return undefined;
  const lines = bodyLines(body);
  let end = trailerSearchEnd(lines);
  while (end > 0 && isBlank(lines[end - 1])) end--;
  let start = end;
  while (start > 0 && !isBlank(lines[start - 1])) start--;
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
  return same
    ? {
        start,
        end,
        lines: block.map(({ text, trailer, key = '', value = '' }) => ({
          text,
          trailer: trailer && isListedTrailer({ key, value }),
        })),
      }
    : undefined;
}

/** `text` without the blank lines around it. */
function withoutBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

/** A paragraph that is only a line of dashes, as GitHub puts between a squash
 *  merge's commit list and its co-authors. */
const RULE = /^-{3,}$/;

/** `text` without a closing paragraph that is only a rule. */
function withoutClosingRule(text: string): string {
  const lines = text.split('\n');
  const last = lines.length - 1;
  if (!RULE.test(lines[last].trim()) || (last > 0 && !isBlank(lines[last - 1]))) return text;
  return withoutBlankEdges(lines.slice(0, last).join('\n'));
}

/**
 * `body` for a view that lists `trailers` on their own: without the listed
 * trailer lines of the paragraph they were parsed from, or a rule that set
 * them off at the end. Other lines of that paragraph, and anything after
 * it, stay; a body whose trailers cannot be placed is returned whole.
 */
export function bodyWithoutTrailers(body: string, trailers: readonly Trailer[]): string {
  const block = trailerBlock(body, trailers);
  if (!block) return body;
  const lines = bodyLines(body);
  const kept = block.lines.filter((line) => !line.trailer).map((line) => line.text);
  const [before, rest, after] = [lines.slice(0, block.start), kept, lines.slice(block.end)].map(
    (part) => withoutBlankEdges(part.join('\n')),
  );
  // A rule left closing the message only set off the trailers.
  const message = rest === '' && after === '' ? withoutClosingRule(before) : before;
  return [message, rest, after].filter((part) => part !== '').join('\n\n');
}
