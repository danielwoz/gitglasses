// Declared provenance on the commit rows of the Commits and File History
// views: a sparkle icon and "AI-assisted (declared)" after the description
// for a commit that declares an AI agent, and every declaration in the
// tooltip.

import * as vscode from 'vscode';
import type { CommitProvenance } from '@gitglasses/protocol';
import { provenanceLines, summarizeProvenance } from './provenanceLogic';

/** Where the history views read what commits declare. */
export interface ProvenanceLookup {
  lookup(repoId: string, shas: readonly string[]): Promise<Map<string, CommitProvenance>>;
}

/** `item` marked with what its commit declares; unchanged when it declares
 *  nothing. */
export function decorateCommitItem(
  item: vscode.TreeItem,
  provenance: CommitProvenance | undefined,
): void {
  const summary = summarizeProvenance(provenance);
  if (!summary) return;
  if (summary.agent) {
    item.iconPath = new vscode.ThemeIcon('sparkle');
    item.description = `${typeof item.description === 'string' ? item.description : ''} · ${summary.label} (declared)`;
  }
  const lines = provenanceLines(provenance).join('\n');
  item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${lines}` : lines;
}

/** What the commits in `shas` declare, or an empty map when there is no
 *  lookup or it fails. */
export async function lookupProvenance(
  source: ProvenanceLookup | undefined,
  repoId: string,
  shas: readonly string[],
): Promise<Map<string, CommitProvenance>> {
  if (!source || shas.length === 0) return new Map();
  return source.lookup(repoId, shas).catch(() => new Map<string, CommitProvenance>());
}
