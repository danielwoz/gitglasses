// Commands the blame hover links to: a commit's change to the hovered file,
// and the file as it was before that commit, where blame continues further
// back. Both are hidden from the palette; their arguments come from the
// hover (see blameHoverLogic).

import * as vscode from 'vscode';
import { shortSha } from '@gitglasses/protocol/sha';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import {
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

/** The revision and path the lines came from, defaulting to the first
 *  parent and the same path. */
function previousOf(args: OpenChangesArgs): { rev: string; path: string } {
  return { rev: args.previousSha || `${args.sha}^`, path: args.previousPath || args.path };
}

async function openChanges(args: unknown): Promise<void> {
  if (!isOpenChangesArgs(args)) return;
  const previous = previousOf(args);
  const left = encodeRevisionUri(args.repoId, previous.path, previous.rev);
  const right = encodeRevisionUri(args.repoId, args.path, args.sha);
  const name = args.path.split('/').pop() ?? args.path;
  // A root commit has no parent; its left side opens empty.
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${name} (${shortSha(args.sha)}^ ↔ ${shortSha(args.sha)})`,
  );
}

async function previousRevision(args: unknown): Promise<void> {
  if (!isOpenChangesArgs(args)) return;
  const line = (args as Partial<PreviousRevisionArgs>).line;
  const previous = previousOf(args);
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

export function registerBlameCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(OPEN_CHANGES_COMMAND, openChanges),
    vscode.commands.registerCommand(PREVIOUS_REVISION_COMMAND, previousRevision),
  ];
}
