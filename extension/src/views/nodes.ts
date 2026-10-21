import * as vscode from 'vscode';
import { CommitProvenance, CommitSummaryInfo, FileHistoryEntry } from '@gitglasses/protocol';
import { relativeTime } from '../system/dates';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import {
  commitDescription,
  formatCommitDoc,
  historyEntryDiffSpec,
} from './viewLogic';
import { ViewNode, requireRepo } from './viewBase';
import type { RepositoryService } from '../model/repositoryService';
import { SHOW_COMMIT_DETAILS_COMMAND } from '../commitDetails/commitDetails';
import { decorateCommitItem } from '../provenance/provenanceView';

/** Commit node: click shows the commit's details. */
export function commitNode(commit: CommitSummaryInfo, provenance?: CommitProvenance): ViewNode {
  const item = new vscode.TreeItem(commit.summary, vscode.TreeItemCollapsibleState.None);
  item.description = commitDescription(commit);
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'gitglassesCommit';
  item.tooltip = `${commit.sha}\n${commit.author.name} <${commit.author.email}>\n${commit.summary}`;
  decorateCommitItem(item, provenance);
  const node: ViewNode = { item, sha: commit.sha, commit };
  item.command = {
    command: 'gitglasses.openCommitDiff',
    title: 'Open Commit',
    arguments: [node],
  };
  return node;
}

/** File-history node: click diffs the file sha~1 ↔ sha (rename-aware path). */
export function fileHistoryNode(
  repoId: string,
  entry: FileHistoryEntry,
  provenance?: CommitProvenance,
): ViewNode {
  const item = new vscode.TreeItem(entry.summary, vscode.TreeItemCollapsibleState.None);
  item.description = commitDescription(entry);
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'gitglassesFileHistoryEntry';
  item.tooltip = `${entry.sha}\n${entry.author.name} <${entry.author.email}>\n${
    entry.path
  }  +${entry.additions} −${entry.deletions}\n${relativeTime(entry.author.time)}`;
  decorateCommitItem(item, provenance);
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

/** Handler for gitglasses.openCommitDiff (tree clicks and context menus). A
 *  commit node carries no repository of its own; it came from a view of the
 *  active one. */
export async function openCommitDiff(node?: ViewNode, repos?: RepositoryService): Promise<void> {
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
    const repo = repos && (await requireRepo(repos));
    if (!repo) {
      await openCommitDoc(node.commit);
      return;
    }
    await vscode.commands.executeCommand(SHOW_COMMIT_DETAILS_COMMAND, {
      repoPath: repo.rootPath,
      sha: node.commit.sha,
    });
  }
}
