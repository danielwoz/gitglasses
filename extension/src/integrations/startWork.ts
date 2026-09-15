import * as vscode from 'vscode';
import { AuthError, type Issue, type IssueProvider } from '@gitglasses/integrations';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import { activeWorkspaceRepo } from '../views/viewBase';
import type { IntegrationService, IssueProviderEntry } from './integrationService';
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
  const usable = entries.filter((entry) => entry.provider !== undefined);
  if (usable.length === 0) {
    void vscode.window.showWarningMessage(
      'GitGlasses: the configured issue providers are not available in this build.',
    );
    return undefined;
  }
  if (usable.length === 1) return usable[0];
  const picked = await vscode.window.showQuickPick(
    usable.map((entry) => ({
      label: entry.providerId,
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
      const open = await vscode.window.showInformationMessage(
        'GitGlasses: no issue providers configured. Add one to "gitglasses.integrations.issues".',
        'Open Settings',
      );
      if (open === 'Open Settings') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'gitglasses.integrations.issues',
        );
      }
      return;
    }

    const entry = await pickIssueProvider(entries);
    if (!entry?.provider) return;
    const provider = entry.provider;

    const auth = await integrations.auth.getAuth(entry.providerId, entry.host ?? '', {
      interactive: true,
      needsUsername: entry.providerId === 'jira',
    });
    if (!auth) return;

    let issues: Issue[];
    try {
      issues = await provider.getMyIssues({ token: auth.token }, { limit: 50 });
    } catch (error) {
      if (error instanceof AuthError) {
        const reconnect = await vscode.window.showErrorMessage(
          `GitGlasses: ${entry.providerId} rejected the stored credentials.`,
          'Reconnect',
        );
        if (reconnect === 'Reconnect') {
          await integrations.auth.signOut(entry.providerId, entry.host ?? '');
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
