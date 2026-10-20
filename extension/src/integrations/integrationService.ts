import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  AuthError,
  CredentialScopeError,
  parseRemoteUrl,
  type AuthContext,
  type AutolinkPattern,
  type HostingProvider,
  type PullRequest,
  type RepoDescriptor,
} from '@gitglasses/integrations';
import { AuthManager, type AuthInfo } from './auth';
import { applyAutolinks, jiraPattern, repoIssuePatterns, userPatterns } from './autolinks';
import {
  orderedRemoteUrls,
  parseGitConfig,
  parseGitConfigRemotes,
  pullRequestRemotes,
  type RemoteConfig,
} from './gitConfig';
import {
  addHostSetting,
  addIssueSetting,
  describeIssueSetting,
  HOSTING_PROVIDER_CHOICES,
  ISSUE_PROVIDER_CHOICES,
  isValidDomain,
  normalizeDomain,
  removeHostSetting,
  removeIssueSetting,
} from './integrationSettings';
import {
  buildHostingEntries,
  buildIssueEntries,
  toAuthContext,
  type HostingEntry,
  type HostSetting,
  type IssueProviderEntry,
  type IssueSetting,
} from './providerSetup';

export type { HostingEntry, HostSetting, IssueProviderEntry, IssueSetting } from './providerSetup';

export interface HostingInfo {
  providerId: string;
  host: string;
  provider: HostingProvider;
  repo: RepoDescriptor;
}

export interface ConnectedHosting extends HostingInfo {
  auth: AuthContext;
  username?: string;
}

/** A branch's open pull request and the connection that found it. */
export interface BranchPullRequest {
  /** The repository the pull request lives in, with its credentials. */
  hosting: ConnectedHosting;
  pr: PullRequest;
}

/**
 * Locate the git config file for a repo root, following worktree/gitdir
 * indirection. The engine's refs/list reports remote names without URLs, so
 * the URLs are read from the repository's config file.
 */
async function findGitConfigPath(repoRoot: string): Promise<string | undefined> {
  const dotGit = path.join(repoRoot, '.git');
  try {
    const stat = await fs.stat(dotGit);
    let gitDir = dotGit;
    if (!stat.isDirectory()) {
      const content = await fs.readFile(dotGit, 'utf8');
      const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
      if (!match) return undefined;
      gitDir = path.resolve(repoRoot, match[1].trim());
    }
    // Worktree gitdirs keep the shared config next to the common dir.
    try {
      const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
      gitDir = path.resolve(gitDir, commonDir);
    } catch {
      // No commondir file: gitDir already is the main .git directory.
    }
    return path.join(gitDir, 'config');
  } catch {
    return undefined;
  }
}

/** The text of a repository's git config file, or undefined when unreadable. */
async function readGitConfig(repoRoot: string): Promise<string | undefined> {
  const configPath = await findGitConfigPath(repoRoot);
  if (!configPath) return undefined;
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The array to edit and the scope to write it back to: the narrowest scope
 * that actually defines the setting, global for one nothing defines yet.
 *
 * These arrays do not merge element-wise — the most specific scope wins
 * outright — so an edit has to stay within the scope it read from. Writing
 * `get()`'s merged value to the workspace would copy global entries into a
 * committed .vscode/settings.json, and a workspace array written where global
 * defines one shadows global from then on.
 */
function settingScope<T>(
  section: string,
): { values: T[]; target: vscode.ConfigurationTarget } {
  const inspected = vscode.workspace.getConfiguration('gitglasses').inspect<T[]>(section);
  if (inspected?.workspaceFolderValue !== undefined) {
    return {
      values: inspected.workspaceFolderValue,
      target: vscode.ConfigurationTarget.WorkspaceFolder,
    };
  }
  if (inspected?.workspaceValue !== undefined) {
    return { values: inspected.workspaceValue, target: vscode.ConfigurationTarget.Workspace };
  }
  return {
    values: inspected?.globalValue ?? [],
    target: vscode.ConfigurationTarget.Global,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IntegrationService implements vscode.Disposable {
  private hostingEntries = new Map<string, HostingEntry>();
  private issueEntries: IssueProviderEntry[] = [];
  private autolinkSettings: AutolinkPattern[] = [];
  private hostingCache = new Map<string, Promise<HostingInfo | undefined>>();
  /** Problems last reported for the settings, so a reload does not repeat them. */
  private reportedProblems = '';
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when connections or integration configuration change. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly auth: AuthManager) {
    this.reloadConfiguration();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('gitglasses.integrations') ||
          e.affectsConfiguration('gitglasses.autolinks')
        ) {
          this.reloadConfiguration();
        }
      }),
      auth.onDidChange(() => this.emitter.fire()),
    );
  }

  reloadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('gitglasses');
    this.autolinkSettings = userPatterns(config.get('autolinks'));

    // Rebuild from scratch so hosts removed from settings actually disappear.
    const hosting = buildHostingEntries(asArray(config.get('integrations.hosts')));
    const issues = buildIssueEntries(asArray(config.get('integrations.issues')));
    this.hostingEntries = hosting.entries;
    this.issueEntries = issues.entries;
    this.reportProblems([...hosting.problems, ...issues.problems]);

    this.hostingCache.clear();
    this.emitter.fire();
  }

  /** Tells the user once about settings entries that were left out. */
  private reportProblems(problems: string[]): void {
    const key = problems.join('\n');
    if (key === this.reportedProblems) return;
    this.reportedProblems = key;
    if (problems.length === 0) return;
    void vscode.window
      .showWarningMessage(
        `GitGlasses: ignoring integration settings — ${problems.join('; ')}`,
        'Open Settings',
      )
      .then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'gitglasses.integrations',
          );
        }
      });
  }

  /** All hosting endpoints with a provider: github.com plus configured hosts. */
  getHostingEntries(): HostingEntry[] {
    return [...this.hostingEntries.values()];
  }

  /** Configured issue-tracker integrations from settings. */
  getIssueProviders(): IssueProviderEntry[] {
    return [...this.issueEntries];
  }

  /** Resolve the hosting provider + repo for a repo root via its remotes. */
  getHostingFor(repoRoot: string): Promise<HostingInfo | undefined> {
    let cached = this.hostingCache.get(repoRoot);
    if (!cached) {
      cached = this.resolveHosting(repoRoot);
      this.hostingCache.set(repoRoot, cached);
      // A miss is only true for .git/config as it stands, so it is dropped and
      // re-resolved on the next ask.
      void cached.then((resolved) => {
        if (!resolved && this.hostingCache.get(repoRoot) === cached) {
          this.hostingCache.delete(repoRoot);
        }
      });
    }
    return cached;
  }

  private async resolveHosting(repoRoot: string): Promise<HostingInfo | undefined> {
    const text = await readGitConfig(repoRoot);
    if (text === undefined) return undefined;
    for (const url of orderedRemoteUrls(parseGitConfigRemotes(text))) {
      const hosting = this.hostingForUrl(url);
      if (hosting) return hosting;
    }
    return undefined;
  }

  /** The provider serving a remote URL's host, with the repository it names. */
  private hostingForUrl(url: string): HostingInfo | undefined {
    const parsed = parseRemoteUrl(url);
    const entry = parsed && this.hostingEntries.get(parsed.host);
    if (!parsed || !entry) return undefined;
    return {
      providerId: entry.providerId,
      host: entry.host,
      provider: entry.provider,
      repo: entry.provider.matchesRemote(url) ?? { provider: entry.providerId, ...parsed },
    };
  }

  /** Like getHostingFor, but only when credentials are available. */
  async getConnectedHostingFor(
    repoRoot: string,
    interactive = false,
  ): Promise<ConnectedHosting | undefined> {
    const hosting = await this.getHostingFor(repoRoot);
    if (!hosting) return undefined;
    const auth = await this.auth.getAuth(hosting.providerId, hosting.host, { interactive });
    if (!auth) return undefined;
    return { ...hosting, auth: toAuthContext(auth, hosting.host), username: auth.username };
  }

  /**
   * The open pull request for `branch`, opened from the remote the branch is
   * pushed to. A fork's pull request lives in the repository it was forked
   * from, so `upstream` is asked before the push remote's own repository; a
   * pull request whose head is in any other fork never matches.
   */
  async findPullRequestForBranch(
    repoRoot: string,
    branch: string,
    interactive = false,
  ): Promise<BranchPullRequest | undefined> {
    const text = await readGitConfig(repoRoot);
    if (text === undefined) return undefined;
    const plan = pullRequestRemotes(parseGitConfig(text), branch);
    const headUrl = plan && (plan.headRemote.pushUrl ?? plan.headRemote.url);
    const head = headUrl ? this.hostingForUrl(headUrl) : undefined;
    if (!plan || !head) return undefined;

    const credential = await this.auth.getAuth(head.providerId, head.host, { interactive });
    if (!credential) return undefined;
    const auth = toAuthContext(credential, head.host);

    let failure: unknown;
    for (const remote of plan.baseRemotes) {
      const base = this.baseHostingFor(remote);
      if (!base || base.host !== head.host) continue;
      try {
        const pr = await base.provider.getPullRequestForBranch(auth, base.repo, plan.headBranch, {
          owner: head.repo.owner,
          name: head.repo.name,
        });
        if (pr) {
          return { hosting: { ...base, auth, username: credential.username }, pr };
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return undefined;
  }

  private baseHostingFor(remote: RemoteConfig): HostingInfo | undefined {
    const url = remote.url ?? remote.pushUrl;
    return url ? this.hostingForUrl(url) : undefined;
  }

  /** All hosting endpoints that currently have stored credentials. */
  async getConnectedHostingEntries(): Promise<Array<HostingEntry & { auth: AuthInfo }>> {
    const connected: Array<HostingEntry & { auth: AuthInfo }> = [];
    for (const entry of this.getHostingEntries()) {
      const auth = await this.auth.getAuth(entry.providerId, entry.host);
      if (auth) connected.push({ ...entry, auth });
    }
    return connected;
  }

  /** The configured Jira host, which drives the Jira autolink pattern. */
  private jiraHost(): string | undefined {
    return this.issueEntries.find((entry) => entry.providerId === 'jira' && entry.host)?.host;
  }

  /**
   * Autolink issue references in `text` as markdown links. Pure substitution:
   * never touches the network, safe on the hover path. The result is markdown
   * with everything outside a link escaped.
   */
  async autolinkText(text: string, repoRoot: string): Promise<string> {
    const patterns: AutolinkPattern[] = [];
    const hosting = await this.getHostingFor(repoRoot).catch(() => undefined);
    if (hosting) patterns.push(...repoIssuePatterns(hosting.repo));
    const jira = this.jiraHost();
    if (jira) patterns.push(jiraPattern(jira));
    patterns.push(...this.autolinkSettings);
    return applyAutolinks(text, patterns);
  }

  /**
   * Adds an integration to settings through prompts, so a self-hosted forge or
   * issue tracker can be set up without hand-editing settings.json. The scope
   * written to is the one settingScope resolves.
   */
  async addIntegration(): Promise<void> {
    const kind = await vscode.window.showQuickPick(
      [
        {
          label: '$(repo) Git hosting instance',
          detail: 'GitHub Enterprise, GitLab, Bitbucket, Azure DevOps',
          itemKind: 'hosting' as const,
        },
        {
          label: '$(issues) Issue tracker',
          detail: 'Jira, Linear',
          itemKind: 'issues' as const,
        },
      ],
      { placeHolder: 'What would you like to add?' },
    );
    if (!kind) return;

    const choices =
      kind.itemKind === 'hosting' ? HOSTING_PROVIDER_CHOICES : ISSUE_PROVIDER_CHOICES;
    const provider = await vscode.window.showQuickPick(
      choices.map((choice) => ({ label: choice.label, detail: choice.detail, choice })),
      { placeHolder: 'Which provider?' },
    );
    if (!provider) return;

    let host = '';
    if (provider.choice.needsHost) {
      const entered = await vscode.window.showInputBox({
        prompt: `Hostname for ${provider.choice.label}`,
        placeHolder: 'git.example.com',
        validateInput: (value) =>
          value.trim() === '' || isValidDomain(value)
            ? undefined
            : 'Enter a hostname such as git.example.com',
      });
      if (entered === undefined) return;
      if (!isValidDomain(entered)) return;
      host = normalizeDomain(entered);
    }

    if (kind.itemKind === 'hosting') {
      const scope = settingScope<HostSetting>('integrations.hosts');
      await vscode.workspace
        .getConfiguration('gitglasses')
        .update(
          'integrations.hosts',
          addHostSetting(scope.values, { domain: host, provider: provider.choice.id }),
          scope.target,
        );
    } else {
      const scope = settingScope<IssueSetting>('integrations.issues');
      await vscode.workspace
        .getConfiguration('gitglasses')
        .update(
          'integrations.issues',
          addIssueSetting(scope.values, {
            provider: provider.choice.id,
            ...(host ? { host } : {}),
          }),
          scope.target,
        );
    }

    this.reloadConfiguration();
    const added = host ? `${provider.choice.label} (${host})` : provider.choice.label;
    const next = await vscode.window.showInformationMessage(
      `GitGlasses: added ${added}.`,
      'Connect Now',
    );
    if (next === 'Connect Now') await this.connectIntegration();
  }

  /** Removes a configured integration from settings. */
  async removeIntegration(): Promise<void> {
    // Read through the same scope resolution the write uses, so the list can
    // never offer an entry the removal would not actually touch.
    const hosts = settingScope<HostSetting>('integrations.hosts').values;
    const issues = settingScope<IssueSetting>('integrations.issues').values;

    const items = [
      ...hosts.map((host) => ({
        label: `$(repo) ${host.domain}`,
        description: host.provider,
        entry: { itemKind: 'hosting' as const, host },
      })),
      ...issues.map((issue) => ({
        label: `$(issues) ${describeIssueSetting(issue)}`,
        description: 'issue tracker',
        entry: { itemKind: 'issues' as const, issue },
      })),
    ];
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        'GitGlasses: no configured integrations to remove.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Remove which integration?',
    });
    if (!picked) return;

    if (picked.entry.itemKind === 'hosting') {
      const scope = settingScope<HostSetting>('integrations.hosts');
      await vscode.workspace
        .getConfiguration('gitglasses')
        .update(
          'integrations.hosts',
          removeHostSetting(scope.values, picked.entry.host.domain),
          scope.target,
        );
    } else {
      const scope = settingScope<IssueSetting>('integrations.issues');
      await vscode.workspace
        .getConfiguration('gitglasses')
        .update(
          'integrations.issues',
          removeIssueSetting(scope.values, picked.entry.issue.provider, picked.entry.issue.host),
          scope.target,
        );
    }
    this.reloadConfiguration();
    void vscode.window.showInformationMessage('GitGlasses: integration removed.');
  }

  /** Connect flow: pick an integration, authenticate, validate, greet. */
  async connectIntegration(): Promise<void> {
    interface Candidate extends vscode.QuickPickItem {
      itemKind: 'hosting' | 'issues';
      providerId: string;
      host: string;
    }
    const candidates: Candidate[] = this.getHostingEntries().map((entry) => ({
      itemKind: 'hosting' as const,
      providerId: entry.providerId,
      host: entry.host,
      label: `$(repo) ${entry.host}`,
      description: entry.providerId,
    }));
    for (const entry of this.issueEntries) {
      candidates.push({
        itemKind: 'issues',
        providerId: entry.providerId,
        host: entry.host ?? '',
        label: `$(issues) ${entry.providerId}${entry.host ? ` (${entry.host})` : ''}`,
        description: 'issue tracker',
      });
    }
    if (candidates.length === 0) {
      const add = await vscode.window.showInformationMessage(
        'GitGlasses: no integrations configured yet.',
        'Add Integration…',
      );
      if (add === 'Add Integration…') await this.addIntegration();
      return;
    }
    const picked = await vscode.window.showQuickPick(candidates, {
      placeHolder: 'Connect which integration?',
    });
    if (!picked) return;

    const credential = await this.auth.getAuth(picked.providerId, picked.host, {
      interactive: true,
      needsUsername: picked.providerId === 'jira',
    });
    if (!credential) return;
    const auth = toAuthContext(credential, picked.host);

    try {
      if (picked.itemKind === 'hosting') {
        const provider = this.hostingEntries.get(picked.host)?.provider;
        await provider?.getMyPullRequests(auth, { limit: 1 });
      } else {
        const provider = this.issueEntries.find(
          (entry) =>
            entry.providerId === picked.providerId && (entry.host ?? '') === picked.host,
        )?.provider;
        await provider?.getMyIssues(auth, { limit: 1 });
      }
    } catch (error) {
      if (error instanceof CredentialScopeError) {
        void vscode.window.showErrorMessage(`GitGlasses: ${errorText(error)}`);
        return;
      }
      if (error instanceof AuthError) {
        await this.auth.signOut(picked.providerId, picked.host);
        const retry = await vscode.window.showErrorMessage(
          `GitGlasses: authentication with ${picked.host || picked.providerId} failed — the token was rejected.`,
          'Try Again',
        );
        if (retry === 'Try Again') await this.connectIntegration();
        return;
      }
      void vscode.window.showWarningMessage(
        `GitGlasses: connected, but validation failed: ${errorText(error)}`,
      );
    }
    this.emitter.fire();
    void vscode.window.showInformationMessage(
      `GitGlasses: connected to ${picked.host || picked.providerId}. Welcome aboard!`,
    );
  }

  async disconnectIntegration(): Promise<void> {
    interface Candidate extends vscode.QuickPickItem {
      providerId: string;
      host: string;
    }
    const candidates: Candidate[] = [];
    for (const entry of this.getHostingEntries()) {
      if (await this.auth.isConnected(entry.providerId, entry.host)) {
        candidates.push({ providerId: entry.providerId, host: entry.host, label: entry.host });
      }
    }
    for (const entry of this.issueEntries) {
      if (await this.auth.isConnected(entry.providerId, entry.host ?? '')) {
        candidates.push({
          providerId: entry.providerId,
          host: entry.host ?? '',
          label: `${entry.providerId}${entry.host ? ` (${entry.host})` : ''}`,
        });
      }
    }
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('GitGlasses: no connected integrations.');
      return;
    }
    const picked = await vscode.window.showQuickPick(candidates, {
      placeHolder: 'Disconnect which integration?',
    });
    if (!picked) return;
    await this.auth.signOut(picked.providerId, picked.host);
    this.emitter.fire();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}

/** A setting value as an array, whatever a hand-edited settings file holds. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
