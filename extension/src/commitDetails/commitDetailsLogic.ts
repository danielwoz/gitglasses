// Pure logic behind the commit details views (no vscode imports, so it stays
// unit-testable): which revisions and paths the two sides of a file's diff
// show, the editor titles, and how a host reports a command it lacks.

import type { CommitFileChange, FileChange } from '@gitglasses/protocol';

/** One side of a file diff: the path at a revision. */
export interface ChangeSide {
  path: string;
  rev: string;
}

/** Both sides of one file's diff. A side is undefined where the file does not
 *  exist: the old side of an added file, the new side of a deleted one. */
export interface DiffSides {
  left?: ChangeSide;
  right?: ChangeSide;
}

function sides(
  file: Pick<FileChange, 'path' | 'status' | 'origPath'>,
  leftRev: string,
  rightRev: string,
): DiffSides {
  return {
    left: file.status === 'A' ? undefined : { path: file.origPath ?? file.path, rev: leftRev },
    right: file.status === 'D' ? undefined : { path: file.path, rev: rightRev },
  };
}

/** A commit's change to one file, against its first parent (`sha^`), as
 *  commit/details lists it. A root commit lists every file as added, so its
 *  missing parent is never read. */
export function commitDiffSides(
  sha: string,
  file: Pick<CommitFileChange, 'path' | 'status' | 'origPath'>,
): DiffSides {
  return sides(file, `${sha}^`, sha);
}

/** One file between two commits, `base` on the left. */
export function compareDiffSides(
  base: string,
  head: string,
  file: Pick<FileChange, 'path' | 'status' | 'origPath'>,
): DiffSides {
  return sides(file, base, head);
}

/** "src/a.ts (abc1234^ ↔ abc1234)", naming both paths of a rename. */
export function diffTitle(
  file: Pick<FileChange, 'path' | 'origPath'>,
  leftLabel: string,
  rightLabel: string,
): string {
  const name = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
  return `${name} (${leftLabel} ↔ ${rightLabel})`;
}

/** Title of the multi-file diff editor for a commit or comparison. */
export function changeTitle(label: string): string {
  return `Changes in ${label}`;
}

/** Whether `error` is a host's refusal to run `command` because nothing
 *  registered it: VS Code says "command 'x' not found", Theia that it
 *  "cannot be executed" for lack of a handler. */
export function isMissingCommand(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`'${command}'`) &&
    /not found|cannot be executed|no (active )?handler/i.test(message)
  );
}
