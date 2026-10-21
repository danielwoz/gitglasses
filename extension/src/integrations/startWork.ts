import * as vscode from 'vscode';
import { AuthError, type Issue, type IssueProvider } from '@gitglasses/integrations';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import { activeWorkspaceRepo } from '../views/viewBase';
import type { IntegrationService } from './integrationService';
import { issueTrackerLabel } from './integrationSettings';
import { issueCredentialHost, toAuthContext, type IssueProviderEntry } from './providerSetup';
import { fallbackBranchName, sanitizeBranchName } from './startWorkLogic';

function suggestName(provider: IssueProvider, issue: Issue): string {
  try {
    const suggested = sanitizeBranchName(provider.suggestBranchName(issue));
    if (suggested !== '') return suggested;
  } catch {
    // Fall through to the generic derivation.
  }
  return fallbackBranchName(issue.key, issue.title);
}

async function pickIssueProvider(
  entries: IssueProviderEntry[],
): Promise<IssueProviderEntry | undefined> {
  if (entries.length === 1) return entries[0];
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: issueTrackerLabel(entry.providerId, entry.host),
      description: entry.host ?? '',
      entry,
    })),
    { placeHolder: 'Pick an issue tracker' },
  );
  return picked?.entry;
}

/** "Start Work": pick an issue, create (and check out) a branch named after it. */
export function registerStartWork(
  integrations: IntegrationService,
  engine: EngineClient,
  repos: RepositoryService,
): vscode.Disposable {
  return vscode.commands.registerCommand('gitglasses.startWork', async () => {
    const entries = integrations.getIssueProviders();
    if (entries.length === 0) {
      const add = await vscode.window.showInformationMessage(
        'GitGlasses: no issue tracker is set up. Connect Jira Cloud, Linear or GitHub Issues to start work from an issue.',
        'Connect Integration…',
      );
      if (add === 'Connect Integration…') {
        await vscode.commands.executeCommand('gitglasses.connectIntegration');
      }
      return;
    }

    const entry = await pickIssueProvider(entries);
    if (!entry) return;
    const provider = entry.provider;
    const host = issueCredentialHost(entry);
    const name = issueTrackerLabel(entry.providerId, entry.host);

    const auth = await integrations.auth.getAuth(entry.providerId, host, { interactive: true });
    if (!auth) return;

    let issues: Issue[];
    try {
      issues = await provider.getMyIssues(toAuthContext(auth, host), { limit: 50 });
    } catch (error) {
      if (error instanceof AuthError) {
        const reconnect = await vscode.window.showErrorMessage(
          `GitGlasses: ${name} rejected the stored credentials.`,
          'Reconnect',
        );
        if (reconnect === 'Reconnect') {
          await integrations.auth.signOut(entry.providerId, host);
          await vscode.commands.executeCommand('gitglasses.startWork');
        }
        return;
      }
      void vscode.window.showErrorMessage(
        `GitGlasses: fetching issues failed: ${String(error instanceof Error ? error.message : error)}`,
      );
      return;
    }
    if (issues.length === 0) {
      void vscode.window.showInformationMessage('GitGlasses: no issues assigned to you.');
      return;
    }

    const pickedIssue = await vscode.window.showQuickPick(
      issues.map((issue) => ({ label: issue.key, description: issue.title, issue })),
      { placeHolder: 'Start work on which issue?', matchOnDescription: true },
    );
    if (!pickedIssue) return;
    const issue = pickedIssue.issue;

    const branchName = await vscode.window.showInputBox({
      prompt: 'Branch name',
      value: suggestName(provider, issue),
      validateInput: (value) =>
        sanitizeBranchName(value) === '' ? 'Branch name is required' : undefined,
    });
    if (!branchName) return;

    const repo = await activeWorkspaceRepo(repos);
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
      return;
    }
    try {
      await engine.request('mutate/branchCreate', {
        repoId: repo.repoId,
        name: branchName,
        checkout: true,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: creating branch failed: ${String(error instanceof Error ? error.message : error)}`,
      );
      return;
    }

    const openIssue = await vscode.window.showInformationMessage(
      `GitGlasses: switched to "${branchName}" for ${issue.key}.`,
      'Open Issue',
    );
    if (openIssue === 'Open Issue') {
      void vscode.env.openExternal(vscode.Uri.parse(issue.url));
    }
  });
}
