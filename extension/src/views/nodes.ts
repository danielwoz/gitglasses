import * as vscode from 'vscode';
import { CommitSummaryInfo, FileHistoryEntry } from '@gitglasses/protocol';
import { relativeTime } from '../system/dates';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import {
  commitDescription,
  formatCommitDoc,
  historyEntryDiffSpec,
  shortSha,
} from './viewLogic';
import { ViewNode } from './viewBase';

/** Commit node: click copies the sha and opens the plain-text summary doc. */
export function commitNode(commit: CommitSummaryInfo): ViewNode {
  const item = new vscode.TreeItem(commit.summary, vscode.TreeItemCollapsibleState.None);
  item.description = commitDescription(commit);
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'gitglassesCommit';
  item.tooltip = `${commit.sha}\n${commit.author.name} <${commit.author.email}>\n${commit.summary}`;
  const node: ViewNode = { item, sha: commit.sha, commit };
  item.command = {
    command: 'gitglasses.openCommitDiff',
    title: 'Open Commit',
    arguments: [node],
  };
  return node;
}

/** File-history node: click diffs the file sha~1 ↔ sha (rename-aware path). */
export function fileHistoryNode(repoId: string, entry: FileHistoryEntry): ViewNode {
  const item = new vscode.TreeItem(entry.summary, vscode.TreeItemCollapsibleState.None);
  item.description = commitDescription(entry);
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'gitglassesFileHistoryEntry';
  item.tooltip = `${entry.sha}\n${entry.author.name} <${entry.author.email}>\n${
    entry.path
  }  +${entry.additions} −${entry.deletions}\n${relativeTime(entry.author.time)}`;
  const node: ViewNode = { item, sha: entry.sha, diff: historyEntryDiffSpec(repoId, entry) };
  item.command = {
    command: 'gitglasses.openCommitDiff',
    title: 'Open Changes',
    arguments: [node],
  };
  return node;
}

/** Opens an untitled plain-text document with the commit summary. */
export async function openCommitDoc(commit: CommitSummaryInfo): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: formatCommitDoc(commit),
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Handler for gitglasses.openCommitDiff (tree clicks and context menus). */
export async function openCommitDiff(node?: ViewNode): Promise<void> {
  if (node?.diff) {
    const left = encodeRevisionUri(node.diff.left.repoId, node.diff.left.path, node.diff.left.rev);
    const right = encodeRevisionUri(
      node.diff.right.repoId,
      node.diff.right.path,
      node.diff.right.rev,
    );
    await vscode.commands.executeCommand('vscode.diff', left, right, node.diff.title);
    return;
  }
  if (node?.commit) {
    await vscode.env.clipboard.writeText(node.commit.sha);
    await openCommitDoc(node.commit);
    void vscode.window.setStatusBarMessage(`Copied ${shortSha(node.commit.sha)}`, 3000);
  }
}
