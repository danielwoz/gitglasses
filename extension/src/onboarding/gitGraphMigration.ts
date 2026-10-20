// "GitGlasses: Coming from Git Graph?": copies the Git Graph settings that
// have a GitGlasses equivalent, after asking, and reports what happened to
// every Git Graph setting the user had set. Git Graph's own values are left
// in place, so it keeps working if it stays installed.

import * as vscode from 'vscode';
import {
  GIT_GRAPH_SETTINGS,
  MigrationPlan,
  SetValue,
  planGitGraphMigration,
  renderMigrationReport,
} from './gitGraphSettings';

export const COMING_FROM_GIT_GRAPH = 'gitglasses.comingFromGitGraph';

const REPORT_URI = vscode.Uri.from({
  scheme: 'gitglasses-report',
  path: '/Coming from Git Graph.md',
});

/** The Git Graph values set in user and workspace settings. Settings files
 *  keep values for extensions that are not installed, so this works after
 *  Git Graph is uninstalled too. */
function setGitGraphValues(): SetValue[] {
  const config = vscode.workspace.getConfiguration('git-graph');
  const values: SetValue[] = [];
  for (const key of Object.keys(GIT_GRAPH_SETTINGS)) {
    const inspected = config.inspect(key);
    if (inspected?.globalValue !== undefined) {
      values.push({ key, level: 'user', value: inspected.globalValue });
    }
    if (inspected?.workspaceValue !== undefined) {
      values.push({ key, level: 'workspace', value: inspected.workspaceValue });
    }
  }
  return values;
}

/** The settings this build of GitGlasses contributes. */
function contributedSettings(context: vscode.ExtensionContext): Set<string> {
  const properties = (
    context.extension.packageJSON as {
      contributes?: { configuration?: { properties?: Record<string, unknown> } };
    }
  ).contributes?.configuration?.properties;
  return new Set(Object.keys(properties ?? {}));
}

export function currentMigrationPlan(context: vscode.ExtensionContext): MigrationPlan {
  return planGitGraphMigration(setGitGraphValues(), contributedSettings(context));
}

async function showReport(provider: ReportProvider, markdown: string): Promise<void> {
  provider.set(markdown);
  try {
    await vscode.commands.executeCommand('markdown.showPreview', REPORT_URI);
  } catch {
    // No Markdown preview on this host: show the source.
    await vscode.window.showTextDocument(REPORT_URI, { preview: true });
  }
}

class ReportProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private text = '';

  set(text: string): void {
    this.text = text;
    this.emitter.fire(REPORT_URI);
  }

  provideTextDocumentContent(): string {
    return this.text;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

async function migrate(context: vscode.ExtensionContext, provider: ReportProvider): Promise<void> {
  const plan = currentMigrationPlan(context);
  let applied = false;
  if (plan.apply.length > 0) {
    const detail = plan.apply
      .map((entry) => `${entry.from} → ${entry.to} = ${JSON.stringify(entry.value)}`)
      .join('\n');
    const choice = await vscode.window.showInformationMessage(
      `Copy ${plan.apply.length} Git Graph setting${plan.apply.length === 1 ? '' : 's'} to GitGlasses?`,
      { modal: true, detail },
      'Copy Settings',
    );
    if (choice === 'Copy Settings') {
      for (const entry of plan.apply) {
        await vscode.workspace
          .getConfiguration()
          .update(
            entry.to,
            entry.value,
            entry.level === 'user'
              ? vscode.ConfigurationTarget.Global
              : vscode.ConfigurationTarget.Workspace,
          );
      }
      applied = true;
    }
  }
  await showReport(provider, renderMigrationReport(plan, applied));
}

export function registerGitGraphMigration(context: vscode.ExtensionContext): vscode.Disposable[] {
  const provider = new ReportProvider();
  return [
    provider,
    vscode.workspace.registerTextDocumentContentProvider(REPORT_URI.scheme, provider),
    vscode.commands.registerCommand(COMING_FROM_GIT_GRAPH, () => migrate(context, provider)),
    // Internal: the plan for the current settings, without asking or
    // writing anything, so a test can check how settings are read.
    vscode.commands.registerCommand('_gitglasses.gitGraphMigrationPlan', () =>
      currentMigrationPlan(context),
    ),
  ];
}
