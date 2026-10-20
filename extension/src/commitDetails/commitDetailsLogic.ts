// Pure rendering of a commit/details result as the Markdown text of the
// read-only commit document (no vscode imports, so it stays unit-testable).
// Every value that comes out of the repository (message, names, paths, refs)
// is placed inside fenced code blocks, so it reads literally in the editor
// and the Markdown preview renders none of it as links, images or HTML.

import type {
  CommitDetails,
  CommitFileChange,
  CommitRef,
  CommitTrailer,
} from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';

/** Names longer than this are not padded to align the line counts. */
const MAX_NAME_COLUMN = 60;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** `text` with control characters (line breaks, tabs, escapes) written as
 *  `\uXXXX`, so one value stays on one line. */
function oneLine(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A fenced code block holding `text` verbatim. The fence is longer than the
 *  longest backtick run in `text`, so nothing inside can close it. */
export function fencedBlock(text: string): string {
  let longestRun = 0;
  for (const run of text.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

function formatRef(ref: CommitRef): string {
  return ref.kind === 'head' ? oneLine(ref.name) : `${oneLine(ref.name)} (${ref.kind})`;
}

function formatTrailer(trailer: CommitTrailer): string {
  return `${oneLine(trailer.key)}: ${oneLine(trailer.value)}`;
}

function fileName(file: CommitFileChange): string {
  return file.origPath ? `${oneLine(file.origPath)} → ${oneLine(file.path)}` : oneLine(file.path);
}

/** The changed-file list, one line per file: status letter, path (old → new
 *  for renames and copies) and line counts, or "binary". */
export function formatFileLines(files: readonly CommitFileChange[]): string[] {
  const names = files.map(fileName);
  const column = Math.min(MAX_NAME_COLUMN, Math.max(0, ...names.map((name) => name.length)));
  return files.map((file, i) => {
    const counts = file.binary ? 'binary' : `+${file.additions} −${file.deletions}`;
    return `${file.status}  ${names[i].padEnd(column)}  ${counts}`;
  });
}

/** The full message: subject, blank line, body. */
export function fullMessage(details: Pick<CommitDetails, 'subject' | 'body'>): string {
  return details.body ? `${details.subject}\n\n${details.body}` : details.subject;
}

/** Markdown text of the commit document. */
export function renderCommitDetails(details: CommitDetails): string {
  const { author, committer, stats } = details;
  const identity = [
    `commit     ${details.sha}`,
    `parents    ${details.parents.length > 0 ? details.parents.join(' ') : '(none)'}`,
    `author     ${oneLine(author.name)} <${oneLine(author.email)}>`,
    `date       ${formatDate(author.time)}`,
  ];
  if (committer.name !== author.name || committer.email !== author.email) {
    identity.push(`committer  ${oneLine(committer.name)} <${oneLine(committer.email)}>`);
  }
  if (committer.time !== author.time) {
    identity.push(`committed  ${formatDate(committer.time)}`);
  }
  if (details.refs.length > 0) {
    identity.push(`refs       ${details.refs.map(formatRef).join(', ')}`);
  }

  const sections = [
    `# Commit ${shortSha(details.sha)}`,
    fencedBlock(fullMessage(details)),
    '## Details',
    fencedBlock(identity.join('\n')),
  ];
  if (details.trailers.length > 0) {
    sections.push('## Trailers', fencedBlock(details.trailers.map(formatTrailer).join('\n')));
  }
  sections.push(
    `## Changed files (${stats.files}, +${stats.additions} −${stats.deletions})`,
    details.files.length > 0
      ? fencedBlock(formatFileLines(details.files).join('\n'))
      : 'No files changed.',
  );
  if (details.truncated) {
    sections.push(
      `Only the first ${details.files.length} of ${stats.files} changed files are listed, ` +
        'and the line counts cover only those.',
    );
  }
  return sections.join('\n\n') + '\n';
}
