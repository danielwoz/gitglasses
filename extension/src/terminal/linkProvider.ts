import * as vscode from 'vscode';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { activeWorkspaceRepo } from '../views/viewBase';
import { findShaMatches } from '../views/viewLogic';
import { openCommitDoc } from '../views/nodes';

interface ShaTerminalLink extends vscode.TerminalLink {
  sha: string;
}

// Turns hex runs in terminal output into links that open the commit's
// plain-text summary (resolved via search/commits with a sha query).
export class ShaTerminalLinkProvider implements vscode.TerminalLinkProvider<ShaTerminalLink> {
  private streamCounter = 0;

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext): ShaTerminalLink[] {
    return findShaMatches(context.line).map((match) => ({
      startIndex: match.startIndex,
      length: match.length,
      tooltip: 'Show commit (GitGlasses)',
      sha: match.sha,
    }));
  }

  async handleTerminalLink(link: ShaTerminalLink): Promise<void> {
    let repo;
    try {
      repo = await activeWorkspaceRepo(this.repos);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
      return;
    }

    const streamId = `termsha-${this.streamCounter++}`;
    const matches: CommitSummaryInfo[] = [];
    const sub = this.engine.onNotification('search/matches', (params) => {
      if (params.streamId === streamId) matches.push(...params.matches);
    });
    try {
      await this.engine.request('search/commits', {
        repoId: repo.repoId,
        streamId,
        limit: 1,
        query: { sha: link.sha },
      });
    } catch {
      void vscode.window.showWarningMessage('GitGlasses: engine unavailable.');
      return;
    } finally {
      sub.dispose();
    }

    const commit = matches[0];
    if (!commit) {
      void vscode.window.showWarningMessage(`GitGlasses: no commit found for ${link.sha}.`);
      return;
    }
    await openCommitDoc(commit);
  }
}
