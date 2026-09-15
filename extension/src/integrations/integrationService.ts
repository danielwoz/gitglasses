import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as integrationsPackage from '@gitglasses/integrations';
import {
  AuthError,
  GitHubProvider,
  ProviderRegistry,
  createGitHubEnterpriseProvider,
  type AuthContext,
  type AutolinkPattern,
  type HostingProvider,
  type IssueProvider,
  type RepoDescriptor,
} from '@gitglasses/integrations';
import { AuthManager, type AuthInfo } from './auth';
import { applyAutolinks, jiraPattern, repoIssuePatterns, userPatterns } from './autolinks';
import { orderedRemoteUrls, parseGitConfigRemotes } from './gitConfig';
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

export interface HostSetting {
  domain: string;
  provider: string;
}

export interface IssueSetting {
  provider: string;
  host?: string;
}

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

export interface HostingEntry {
  providerId: string;
  host: string;
  provider: HostingProvider;
}

export interface IssueProviderEntry {
  providerId: string;
  host?: string;
  /** Undefined when the configured provider is not shipped in this build yet. */
  provider?: IssueProvider;
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

/**
 * Feature-detect a provider class exported by @gitglasses/integrations by id
 * (e.g. "gitlab" -> GitLabProvider), so the extension works with whatever
 * providers the installed package version ships.
 */
function findExportedProviderClass(providerId: string): (new (options: { host?: string }) => object) | undefined {
  const wanted = `${providerId.replace(/[^a-z0-9]/gi, '').toLowerCase()}provider`;
  const mod = integrationsPackage as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(mod)) {
    if (key.toLowerCase() === wanted && typeof value === 'function') {
      return value as new (options: { host?: string }) => object;
    }
  }
  return undefined;
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

export class IntegrationService implements vscode.Disposable {
  private registry = new ProviderRegistry();
  private readonly providersByHost = new Map<string, HostingProvider>();
  private issueEntries: IssueProviderEntry[] = [];
  private autolinkSettings: AutolinkPattern[] = [];
  private hostingCache = new Map<string, Promise<HostingInfo | undefined>>();
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
    const hosts = (config.get<HostSetting[]>('integrations.hosts') ?? []).filter(
      (entry) => typeof entry?.domain === 'string' && typeof entry?.provider === 'string',
    );
    this.autolinkSettings = userPatterns(config.get('autolinks'));

    // Rebuild from scratch so hosts removed from settings actually disappear.
    this.registry = new ProviderRegistry();
    this.providersByHost.clear();
    this.providersByHost.set('github.com', new GitHubProvider());
    this.registry.register(new GitHubProvider());
    this.registry.configureHosts(
      hosts.map((entry) => ({ domain: entry.domain, providerId: entry.provider })),
    );
    for (const entry of hosts) {
      const provider = this.createHostingProvider(entry.provider, entry.domain);
      if (provider) this.providersByHost.set(entry.domain.toLowerCase(), provider);
    }

    const issues = (config.get<IssueSetting[]>('integrations.issues') ?? []).filter(
      (entry) => typeof entry?.provider === 'string',
    );
    this.issueEntries = issues.map((entry) => ({
      providerId: entry.provider,
      host: entry.host,
      provider: this.createIssueProvider(entry.provider, entry.host),
    }));

    this.hostingCache.clear();
    this.emitter.fire();
  }

  private createHostingProvider(providerId: string, domain: string): HostingProvider | undefined {
    // A provider constructor rejects a domain it cannot safely put in a base
    // URL; one bad settings entry drops that entry, not the whole reload.
    try {
      if (providerId === 'github') {
        return new GitHubProvider(domain === 'github.com' ? {} : { host: domain });
      }
      if (providerId === 'github-enterprise') {
        return createGitHubEnterpriseProvider(domain);
      }
      const ctor = findExportedProviderClass(providerId);
      if (!ctor) return undefined;
      return new ctor({ host: domain }) as HostingProvider;
    } catch {
      return undefined;
    }
  }

  private createIssueProvider(providerId: string, host?: string): IssueProvider | undefined {
    const ctor = findExportedProviderClass(providerId);
    if (!ctor) return undefined;
    try {
      return new ctor(host ? { host } : {}) as unknown as IssueProvider;
    } catch {
      return undefined;
    }
  }

  /** All hosting endpoints (github.com + configured hosts) with a provider. */
  getHostingEntries(): HostingEntry[] {
    return [...this.providersByHost.entries()].map(([host, provider]) => ({
      host,
      providerId: provider.id,
      provider,
    }));
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
    const configPath = await findGitConfigPath(repoRoot);
    if (!configPath) return undefined;
    let text: string;
    try {
      text = await fs.readFile(configPath, 'utf8');
    } catch {
      return undefined;
    }
    for (const url of orderedRemoteUrls(parseGitConfigRemotes(text))) {
      const resolved = this.registry.resolveRemote(url);
      if (!resolved) continue;
      const provider = this.providersByHost.get(resolved.repo.host) ?? resolved.provider;
      if (!provider) continue;
      return {
        providerId: resolved.providerId,
        host: resolved.repo.host,
        provider,
        repo: resolved.repo,
      };
    }
    return undefined;
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
    return { ...hosting, auth: { token: auth.token }, username: auth.username };
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

    const auth = await this.auth.getAuth(picked.providerId, picked.host, {
      interactive: true,
      needsUsername: picked.providerId === 'jira',
    });
    if (!auth) return;

    try {
      if (picked.itemKind === 'hosting') {
        const provider = this.providersByHost.get(picked.host);
        await provider?.getMyPullRequests({ token: auth.token }, { limit: 1 });
      } else {
        const provider = this.issueEntries.find(
          (entry) => entry.providerId === picked.providerId,
        )?.provider;
        if (!provider) {
          void vscode.window.showWarningMessage(
            `GitGlasses: the "${picked.providerId}" provider is not available in this build.`,
          );
          return;
        }
        await provider.getMyIssues({ token: auth.token }, { limit: 1 });
      }
    } catch (error) {
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
        `GitGlasses: connected, but validation failed: ${String(
          error instanceof Error ? error.message : error,
        )}`,
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
