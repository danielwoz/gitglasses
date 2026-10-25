// Commands the blame hover links to: a commit's change to the hovered file,
// and the file as it was before that commit, where blame continues further
// back. Both are hidden from the palette; their arguments come from the
// hover (see blameHoverLogic).

import * as vscode from 'vscode';
import { shortSha } from '@gitglasses/protocol/sha';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import {
  DiffWithHeadArgs,
  OPEN_CHANGES_COMMAND,
  OpenChangesArgs,
  PREVIOUS_REVISION_COMMAND,
  PreviousRevisionArgs,
} from './blameHoverLogic';

function isOpenChangesArgs(value: unknown): value is OpenChangesArgs {
  const args = value as Partial<OpenChangesArgs> | undefined;
  return (
    typeof args?.repoId === 'string' &&
    typeof args.sha === 'string' &&
    args.sha !== '' &&
    typeof args.path === 'string' &&
    args.path !== '' &&
    (args.previousSha === undefined || typeof args.previousSha === 'string') &&
    (args.previousPath === undefined || typeof args.previousPath === 'string')
  );
}

/** Scheme of the empty document a file's change is diffed against when the
 *  commit added the file. */
export const EMPTY_DOCUMENT_SCHEME = 'gitglasses-empty';

/** The empty left side of an added file's diff; its path keeps the file's
 *  name, so both sides get the same language. */
export function emptyDocumentUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_DOCUMENT_SCHEME, path: `/${path}` });
}

/** The revision and path the lines came from, when the file existed before
 *  the commit. */
function previousOf(args: OpenChangesArgs): { rev: string; path: string } | undefined {
  if (!args.previousSha) return undefined;
  return { rev: args.previousSha, path: args.previousPath || args.path };
}

async function openChanges(args: unknown): Promise<void> {
  if (!isOpenChangesArgs(args)) return;
  const previous = previousOf(args);
  const right = encodeRevisionUri(args.repoId, args.path, args.sha);
  const name = args.path.split('/').pop() ?? args.path;
  const short = shortSha(args.sha);
  // A commit that added the file (a root commit, say) changed all of it, so
  // its change is diffed against an empty document.
  const left = previous
    ? encodeRevisionUri(args.repoId, previous.path, previous.rev)
    : emptyDocumentUri(args.path);
  const title = previous
    ? `${name} (${shortSha(previous.rev)} ↔ ${short})`
    : `${name} (added in ${short})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

async function previousRevision(args: unknown): Promise<void> {
  if (!isOpenChangesArgs(args)) return;
  const previous = previousOf(args);
  if (!previous) {
    void vscode.window.showInformationMessage(
      `${shortSha(args.sha)} added ${args.path}, so there is no earlier revision to blame.`,
    );
    return;
  }
  const line = (args as Partial<PreviousRevisionArgs>).line;
  const uri = encodeRevisionUri(args.repoId, previous.path, previous.rev);
  const document = await vscode.workspace.openTextDocument(uri);
  const target = Math.min(
    Math.max(typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : 0, 0),
    Math.max(document.lineCount - 1, 0),
  );
  const position = new vscode.Position(target, 0);
  await vscode.window.showTextDocument(document, {
    preview: true,
    selection: new vscode.Range(position, position),
  });
}

/** The document gitglasses.diffWithHead compares: the resource a menu passes,
 *  or the one a hover link names (DiffWithHeadArgs). Undefined means the
 *  active editor's. */
export function diffWithHeadTarget(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const uri = (arg as Partial<DiffWithHeadArgs> | undefined)?.uri;
  if (typeof uri !== 'string' || uri === '') return undefined;
  try {
    return vscode.Uri.parse(uri, true);
  } catch {
    return undefined;
  }
}

export function registerBlameCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(OPEN_CHANGES_COMMAND, openChanges),
    vscode.commands.registerCommand(PREVIOUS_REVISION_COMMAND, previousRevision),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_DOCUMENT_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
  ];
}
