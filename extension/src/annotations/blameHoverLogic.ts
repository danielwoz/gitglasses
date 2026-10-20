// Pure rendering of the blame hover (and the status bar tooltip, which shows
// the same thing): the commit, its full message, the pull request it came
// from when the message names one, and command links to dig further. No
// vscode imports, so it stays unit-testable.

import type { BlameCommit, BlameHunk } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { codeSpan, escapeMarkdown, markdownLinkDestination } from '../system/markdown';
import { relativeTime } from '../system/dates';
import { formatDateTime, originalLineOf } from './blameFormat';

export const OPEN_CHANGES_COMMAND = 'gitglasses.blame.openChanges';
export const PREVIOUS_REVISION_COMMAND = 'gitglasses.blame.previousRevision';
export const SHOW_COMMIT_DETAILS_COMMAND = 'gitglasses.showCommitDetails';
export const COPY_SHA_COMMAND = 'gitglasses.copySha';
export const OPEN_COMMIT_ON_REMOTE_COMMAND = 'gitglasses.openCommitOnRemote';
export const DIFF_WITH_HEAD_COMMAND = 'gitglasses.diffWithHead';

/** Commands the hover's links may run; MarkdownString trusts exactly these. */
export const BLAME_HOVER_COMMANDS: readonly string[] = [
  SHOW_COMMIT_DETAILS_COMMAND,
  OPEN_CHANGES_COMMAND,
  PREVIOUS_REVISION_COMMAND,
  COPY_SHA_COMMAND,
  OPEN_COMMIT_ON_REMOTE_COMMAND,
  DIFF_WITH_HEAD_COMMAND,
];

/** Most message lines a hover shows before it is cut short. */
export const MAX_BODY_LINES = 25;

/** Arguments of gitglasses.blame.openChanges: one file's change in one
 *  commit, against the version it came from. */
export interface OpenChangesArgs {
  repoId: string;
  sha: string;
  /** The file's path in `sha`. */
  path: string;
  /** The revision the commit changed the lines from and the file's path
   *  there. Absent when the commit added the file, whose change is then the
   *  whole file. */
  previousSha?: string;
  previousPath?: string;
}

/** Arguments of gitglasses.diffWithHead from a link: the document to compare
 *  with HEAD, rather than whichever editor is active when the link is
 *  clicked. */
export interface DiffWithHeadArgs {
  uri: string;
}

/** Arguments of gitglasses.blame.previousRevision: OpenChangesArgs plus the
 *  0-based line to reveal in the earlier revision. */
export interface PreviousRevisionArgs extends OpenChangesArgs {
  line: number;
}

/** Where the blamed document lives. */
export interface HoverTarget {
  repoId: string;
  /** The repository root; empty when unknown, which drops the links that
   *  need it. */
  repoPath: string;
  /** Repo-relative path of the blamed document. */
  path: string;
}

/** A markdown link running `command` with `args` as its single argument. */
export function commandLink(label: string, command: string, args: unknown, title: string): string {
  const uri = `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
  return `[${label}](${uri} "${title.replace(/"/g, "'")}")`;
}

export function openChangesArgs(repoId: string, hunk: BlameHunk): OpenChangesArgs {
  const args: OpenChangesArgs = { repoId, sha: hunk.sha, path: hunk.path };
  // Blame reports where the lines were before the commit only when the file
  // existed there; the commit's first parent may not have it at all.
  if (hunk.previous) {
    args.previousSha = hunk.previous.sha;
    args.previousPath = hunk.previous.path;
  }
  return args;
}

export function previousRevisionArgs(
  repoId: string,
  hunk: BlameHunk,
  line1Based: number,
): PreviousRevisionArgs {
  return { ...openChangesArgs(repoId, hunk), line: originalLineOf(hunk, line1Based) - 1 };
}

// --- Pull requests ----------------------------------------------------------

export { pullRequestNumber, pullRequestUrl } from '@gitglasses/integrations';

// --- Message body -----------------------------------------------------------

/** A run of message text rendered as one markdown block. */
export interface MessageBlock {
  text: string;
  /** A list item ("- x", "* x", "1. x"), kept on a line of its own. */
  listItem: boolean;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * The message body split into paragraphs and list items, at most `maxLines`
 * lines of it. Wrapped lines of one paragraph are joined, the way git's own
 * tools reflow them.
 */
export function messageBlocks(
  body: string,
  maxLines: number = MAX_BODY_LINES,
): { blocks: MessageBlock[]; truncated: boolean } {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const truncated = lines.length > maxLines;
  const blocks: MessageBlock[] = [];
  let current: MessageBlock | undefined;
  for (const line of lines.slice(0, maxLines)) {
    if (line.trim() === '') {
      current = undefined;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      current = { text: line.trim(), listItem: true };
      blocks.push(current);
      continue;
    }
    if (current) {
      current.text += ` ${line.trim()}`;
    } else {
      current = { text: line.trim(), listItem: false };
      blocks.push(current);
    }
  }
  return { blocks, truncated };
}

/** Rendered blocks joined: list items on consecutive lines, paragraphs
 *  apart. */
export function joinBlocks(rendered: { markdown: string; listItem: boolean }[]): string {
  let out = '';
  rendered.forEach((block, i) => {
    if (i > 0) out += block.listItem && rendered[i - 1].listItem ? '  \n' : '\n\n';
    out += block.markdown;
  });
  return out;
}

// --- Hover ------------------------------------------------------------------

export interface CommitHoverInput {
  hunk: BlameHunk;
  commit: BlameCommit;
  /** 1-based line hovered. */
  line: number;
  target: HoverTarget;
  /** The subject as markdown, already escaped (and autolinked). */
  subject: string;
  /** The rest of the message as markdown, already escaped (and autolinked). */
  body?: string;
  bodyTruncated?: boolean;
  stats?: { files: number; additions: number; deletions: number };
  pullRequest?: { number: number; url: string };
  /** The forge's web routes are known, so Open on Remote has somewhere to go. */
  remote: boolean;
  nowUnixSeconds?: number;
  locale?: string;
}

/** Markdown for one blamed line's commit. */
export function renderCommitHover(input: CommitHoverInput): string {
  const { hunk, commit, target } = input;
  const time = commit.author.time;
  const parts: string[] = [];
  parts.push(
    `$(git-commit) **${escapeMarkdown(commit.author.name)}** ` +
      `\\<${escapeMarkdown(commit.author.email)}\\> · ` +
      `${escapeMarkdown(relativeTime(time, input.nowUnixSeconds))} ` +
      `(${escapeMarkdown(formatDateTime(time, input.locale))})`,
  );
  parts.push(`**${input.subject}**`);
  if (input.body) parts.push(input.body + (input.bodyTruncated ? '\n\n…' : ''));
  if (input.pullRequest) {
    parts.push(
      `$(git-pull-request) [Pull request #${input.pullRequest.number}](` +
        `${markdownLinkDestination(input.pullRequest.url)})`,
    );
  }

  const facts = [codeSpan(shortSha(hunk.sha))];
  if (input.stats) {
    const files = input.stats.files === 1 ? '1 file' : `${input.stats.files} files`;
    facts.push(`${files} changed, +${input.stats.additions} −${input.stats.deletions}`);
  }
  if (hunk.path !== target.path) facts.push(`was ${codeSpan(hunk.path)}`);
  parts.push(facts.join(' · '));

  const links: string[] = [];
  if (target.repoPath !== '') {
    links.push(
      commandLink(
        '$(eye) Details',
        SHOW_COMMIT_DETAILS_COMMAND,
        { repoPath: target.repoPath, sha: hunk.sha },
        'Show Commit Details',
      ),
    );
  }
  links.push(
    commandLink(
      '$(diff) Changes',
      OPEN_CHANGES_COMMAND,
      openChangesArgs(target.repoId, hunk),
      "Open this file's changes in the commit",
    ),
  );
  // Lines from the commit that added the file (root commit or not) have no
  // earlier revision to blame.
  if (hunk.previous) {
    links.push(
      commandLink(
        '$(history) Blame Previous Revision',
        PREVIOUS_REVISION_COMMAND,
        previousRevisionArgs(target.repoId, hunk, input.line),
        'Open the file as it was before this commit, blamed',
      ),
    );
  }
  links.push(commandLink('$(copy) Copy SHA', COPY_SHA_COMMAND, { sha: hunk.sha }, 'Copy SHA'));
  if (input.remote && target.repoPath !== '') {
    links.push(
      commandLink(
        '$(globe) Open on Remote',
        OPEN_COMMIT_ON_REMOTE_COMMAND,
        { sha: hunk.sha, repoPath: target.repoPath },
        'Open the commit on the remote',
      ),
    );
  }
  return `${parts.join('\n\n')}\n\n---\n\n${links.join(' · ')}`;
}

/** Markdown for a line of `documentUri` that is not committed yet. */
export function renderUncommittedHover(documentUri: string): string {
  const args: DiffWithHeadArgs = { uri: documentUri };
  return (
    '$(edit) **Uncommitted changes**\n\n' +
    commandLink('$(diff) Open Changes', DIFF_WITH_HEAD_COMMAND, args, 'Compare with HEAD')
  );
}

/** Markdown heading the hover of a Git LFS file, whose blame describes the
 *  pointer git stores rather than the lines shown. */
export function renderLfsNotice(hasUncommittedChange: boolean): string {
  return (
    '$(file-binary) **Git LFS file**: git stores a small pointer for this file, so blame ' +
    "follows the pointer's history, not these lines. " +
    (hasUncommittedChange
      ? 'The content has uncommitted changes; it last changed in:'
      : 'The content last changed in:')
  );
}
