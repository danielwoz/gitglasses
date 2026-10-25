// What the graph's details pane and the Commit Details panel show, fetched
// from the engine, and the diff editors their file lists open.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { shortSha } from '@gitglasses/protocol/sha';
import { EngineClient } from '@gitglasses/rpc';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import { errorMessage } from '../commands/ui';
import type { ChangesTarget, DetailsView, FileTarget } from '../../webviews-src/graph/ipc';
import {
  ChangeSide,
  changeTitle,
  commitDiffSides,
  compareDiffSides,
  diffTitle,
  isMissingCommand,
} from './commitDetailsLogic';

/** One commit in full. `stashIndex` marks a stash entry. */
export async function loadCommitView(
  engine: EngineClient,
  repoId: string,
  sha: string,
  stashIndex?: number,
): Promise<DetailsView> {
  const details = await engine.request('commit/details', { repoId, sha });
  return stashIndex === undefined
    ? { kind: 'commit', details }
    : { kind: 'commit', details, stash: { index: stashIndex } };
}

/** The files that differ between two commits, `base` older than `head`. */
export async function loadCompareView(
  engine: EngineClient,
  repoId: string,
  base: string,
  head: string,
): Promise<DetailsView> {
  const [diff, baseCommit, headCommit] = await Promise.all([
    engine.request('diff/refs', { repoId, base, head }),
    engine.request('log/commits', { repoId, ref: base, limit: 1 }),
    engine.request('log/commits', { repoId, ref: head, limit: 1 }),
  ]);
  return {
    kind: 'compare',
    base: { sha: base, subject: baseCommit.commits[0]?.summary ?? '' },
    head: { sha: head, subject: headCommit.commits[0]?.summary ?? '' },
    files: diff.files,
  };
}

/** The working tree and index against HEAD. */
export async function loadWipView(engine: EngineClient, repoId: string): Promise<DetailsView> {
  const status = await engine.request('status/summary', { repoId });
  return {
    kind: 'wip',
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    conflicted: status.conflicted,
  };
}

/** The view to show when loading failed. */
export function errorView(what: string, error: unknown): DetailsView {
  return { kind: 'error', message: `Could not load ${what}: ${errorMessage(error)}` };
}

function sideUri(repoId: string, side: ChangeSide | undefined): vscode.Uri | undefined {
  return side ? encodeRevisionUri(repoId, side.path, side.rev) : undefined;
}

/** Scheme of the empty documents that stand in for the missing side of an
 *  added or deleted file, where vscode.diff needs a document on both sides. */
export const EMPTY_SCHEME = 'gitglasses-empty';

/** An empty document named like `filePath`, so the diff editor picks the
 *  file's language and title. */
function emptySide(filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${filePath}` });
}

/** Serves the empty documents. */
export function registerEmptyDocuments(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
    provideTextDocumentContent: () => '',
  });
}

/** Opens one changed file in a diff editor: parent ↔ commit, base ↔ head, or
 *  HEAD ↔ working tree. `workspaceRoot` is the repository root in the
 *  editor's spelling, for working-tree files. */
export async function openFileDiff(
  repoId: string,
  workspaceRoot: string,
  target: FileTarget,
): Promise<void> {
  if (target.kind === 'wip') {
    const fileUri = vscode.Uri.file(path.join(workspaceRoot, ...target.path.split('/')));
    if (target.untracked || target.status === 'A' || target.status === '?') {
      await vscode.commands.executeCommand('vscode.open', fileUri);
      return;
    }
    const original = encodeRevisionUri(repoId, target.origPath ?? target.path, 'HEAD');
    const modified = target.status === 'D' ? emptySide(target.path) : fileUri;
    await vscode.commands.executeCommand(
      'vscode.diff',
      original,
      modified,
      `${target.path} (HEAD ↔ Working Tree)`,
    );
    return;
  }
  const sides =
    target.kind === 'commit'
      ? commitDiffSides(target.sha, target.file)
      : compareDiffSides(target.base, target.head, target.file);
  const left = sideUri(repoId, sides.left) ?? emptySide(target.file.origPath ?? target.file.path);
  const right = sideUri(repoId, sides.right) ?? emptySide(target.file.path);
  const title =
    target.kind === 'commit'
      ? diffTitle(target.file, `${shortSha(target.sha)}^`, shortSha(target.sha))
      : diffTitle(target.file, shortSha(target.base), shortSha(target.head));
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

/** Opens every file of a commit or comparison in VS Code's multi-file diff
 *  editor. Hosts without that editor get the first file's diff instead, and
 *  are told so; any other failure is the caller's to report. */
export async function openAllChanges(
  engine: EngineClient,
  repoId: string,
  target: ChangesTarget,
  log: (line: string) => void,
): Promise<void> {
  const files =
    target.kind === 'commit'
      ? (await engine.request('commit/details', { repoId, sha: target.sha })).files
      : (await engine.request('diff/refs', { repoId, base: target.base, head: target.head })).files;
  if (files.length === 0) {
    void vscode.window.showInformationMessage('GitGlasses: no files changed.');
    return;
  }
  const resources = files.map((file) => {
    const sides =
      target.kind === 'commit'
        ? commitDiffSides(target.sha, file)
        : compareDiffSides(target.base, target.head, file);
    const label = vscode.Uri.file(`/${file.path}`);
    return [label, sideUri(repoId, sides.left), sideUri(repoId, sides.right)] as const;
  });
  const title =
    target.kind === 'commit'
      ? changeTitle(shortSha(target.sha))
      : changeTitle(`${shortSha(target.base)} ↔ ${shortSha(target.head)}`);
  try {
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  } catch (error) {
    // vscode.changes is missing on some hosts (older VS Code builds, Theia).
    if (!isMissingCommand(error, 'vscode.changes')) throw error;
    log(`multi-file diff editor unavailable, opening the first file: ${errorMessage(error)}`);
    void vscode.window.showInformationMessage(
      `GitGlasses: this editor cannot show several diffs at once, so only ${files[0].path} was opened.`,
    );
    const first = files[0];
    await openFileDiff(
      repoId,
      '',
      target.kind === 'commit'
        ? { kind: 'commit', sha: target.sha, file: { ...first, binary: false } }
        : { kind: 'compare', base: target.base, head: target.head, file: first },
    );
  }
}

/** Copies text the user asked for, confirming in the status bar. */
export async function copyText(text: string, label: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`Copied ${label}`, 3000);
}
