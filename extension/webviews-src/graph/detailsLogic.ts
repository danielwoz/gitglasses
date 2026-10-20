// Pure helpers behind the details view (no DOM), so they are unit-testable.

import type { CommitFileChange, DetailsView, FileChange } from './ipc';

/** One row of a changed-file list. */
export interface FileEntry {
  path: string;
  origPath?: string;
  status: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  /** "+3 −1", for screen readers. */
  stats?: string;
  /** What opening the entry needs. */
  file: CommitFileChange | FileChange | { path: string; status: string; origPath?: string };
}

export interface ChangeSummary {
  text: string;
  additions: number;
  deletions: number;
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked',
};

/** Spoken name of a status letter. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** A path split into its file name and the directory holding it ('' at the
 *  repository root). */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** "Name <email>". */
export function signatureLine(signature: { name: string; email: string }): string {
  return signature.email ? `${signature.name} <${signature.email}>` : signature.name;
}

/** "3 files changed" plus the line totals of the listed files. `total` counts
 *  every changed file, which can exceed the listed ones. */
export function changeSummary(
  files: readonly { additions: number; deletions: number }[],
  total: number,
): ChangeSummary {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const text = total === 0 ? 'No files changed' : `${total} file${total === 1 ? '' : 's'} changed`;
  return { text, additions, deletions };
}

function entry(file: FileChange | CommitFileChange): FileEntry {
  const binary = 'binary' in file ? file.binary : false;
  return {
    path: file.path,
    origPath: file.origPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary,
    stats: binary ? 'binary' : `+${file.additions} −${file.deletions}`,
    file,
  };
}

export function commitFileEntries(files: readonly CommitFileChange[]): FileEntry[] {
  return files.map(entry);
}

export function compareFileEntries(files: readonly FileChange[]): FileEntry[] {
  return files.map(entry);
}

/** A working-tree change. status/summary counts no lines, so the entry shows
 *  none. */
function wipEntry(file: FileChange): FileEntry {
  return { path: file.path, origPath: file.origPath, status: file.status, file };
}

export interface FileGroup {
  title: string;
  /** Untracked files have no committed side to diff against. */
  untracked: boolean;
  entries: FileEntry[];
}

/** The uncommitted changes in the order Source Control lists them; empty
 *  groups are left out. */
export function wipFileEntries(view: Extract<DetailsView, { kind: 'wip' }>): FileGroup[] {
  const groups: FileGroup[] = [
    {
      title: 'Merge Changes',
      untracked: false,
      entries: view.conflicted.map((path) => ({ path, status: 'U', file: { path, status: 'U' } })),
    },
    { title: 'Staged Changes', untracked: false, entries: view.staged.map(wipEntry) },
    { title: 'Changes', untracked: false, entries: view.unstaged.map(wipEntry) },
    {
      title: 'Untracked',
      untracked: true,
      entries: view.untracked.map((path) => ({ path, status: '?', file: { path, status: '?' } })),
    },
  ];
  return groups.filter((group) => group.entries.length > 0);
}
