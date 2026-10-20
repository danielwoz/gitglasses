import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthError,
  CredentialScopeError,
  DEFAULT_HOSTING_HOSTS,
  type AuthContext,
  type AutolinkPattern,
  type HostingProvider,
  type RepoDescriptor,
} from '@gitglasses/integrations';
import { AuthManager, type AuthInfo } from './auth';
import { applyAutolinks, jiraPattern, repoIssuePatterns, userPatterns } from './autolinks';
import { findBranchPullRequest, type FoundPullRequest } from './branchPullRequest';
import {
  globalGitConfigPaths,
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
  issueTrackerLabel,
  isValidDomain,
  normalizeAzureOrganization,
  normalizeDomain,
  normalizeJiraSite,
  providerLabel,
  removeHostSetting,
  removeIssueSetting,
  type ProviderChoice,
} from './integrationSettings';
import {
  buildHostingEntries,
  buildIssueEntries,
  detectHosts,
  hostingForUrl,
  issueCredentialHost,
  toAuthContext,
  type DetectedHost,
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
export type BranchPullRequest = FoundPullRequest;

/** What a connection is being set up for. */
interface ConnectTarget {
  kind: 'hosting' | 'issues';
  providerId: string;
  /** Host the credential is stored under ('' for Linear). */
  host: string;
  /** Settings entry the connection needs, when it has none yet. */
  setting?: HostSetting | IssueSetting;
}

interface ConnectItem extends vscode.QuickPickItem {
  /** Resolves to the connection to set up, after any follow-up prompts. */
  choose?: () => Promise<ConnectTarget | undefined>;
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
 * `remote.pushDefault` from the user's own git config files, which a
 * repository's config overrides. Git reads the later file over the earlier.
 */
async function userPushDefault(): Promise<string | undefined> {
  let pushDefault: string | undefined;
  // The web extension host has no process environment.
  const env = typeof process === 'undefined' ? {} : process.env;
  for (const file of globalGitConfigPaths(env, env.HOME || os.homedir())) {
    try {
      pushDefault = parseGitConfig(await fs.readFile(file, 'utf8')).pushDefault ?? pushDefault;
    } catch {
      // A missing user config file sets nothing.
    }
  }
  return pushDefault;
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
function settingScope<T>(section: string): { values: T[]; target: vscode.ConfigurationTarget } {
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

  /** All hosting endpoints with a provider: the public hosts plus configured ones. */
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
    return hostingForUrl(this.hostingEntries, url);
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
   * pushed to, or the one its config says it was checked out for. A fork's
   * pull request lives in the repository it was forked from, so `upstream`
   * and `origin` are asked before the branch's own remotes; a pull request
   * whose head is in any other fork never matches.
   */
  async findPullRequestForBranch(
    repoRoot: string,
    branch: string,
    interactive = false,
  ): Promise<BranchPullRequest | undefined> {
    const text = await readGitConfig(repoRoot);
    if (text === undefined) return undefined;
    const config = parseGitConfig(text);
    config.pushDefault ??= await userPushDefault();
    const plan = pullRequestRemotes(config, branch);
    if (!plan) return undefined;
    return findBranchPullRequest(plan, {
      hostingFor: (remote) => this.baseHostingFor(remote),
      credentialFor: (providerId, host) => this.auth.getAuth(providerId, host, { interactive }),
    });
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
    return applyAutolinks(text, await this.autolinkPatterns(repoRoot));
  }

  /** The patterns that link issue references in a repository's text: its
   *  forge's #123, the Jira site's keys, then the user's own. No network. */
  async autolinkPatterns(repoRoot: string): Promise<AutolinkPattern[]> {
    const patterns: AutolinkPattern[] = [];
    const hosting = await this.getHostingFor(repoRoot).catch(() => undefined);
    if (hosting) patterns.push(...repoIssuePatterns(hosting.repo));
    const jira = this.jiraHost();
    if (jira) patterns.push(jiraPattern(jira));
    patterns.push(...this.autolinkSettings);
    return patterns;
  }

  /** Adding and connecting are one flow; the command names both. */
  async addIntegration(): Promise<void> {
    await this.connectIntegration();
  }

  /** Connects github.com directly, the provider most workspaces use, without
   *  the full picker. */
  async connectGitHub(): Promise<void> {
    await this.authenticate({ kind: 'hosting', providerId: 'github', host: 'github.com' });
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

  /**
   * Hosts found among the remotes of the workspace folders and of the
   * repositories integrations have already resolved.
   */
  private async detectWorkspaceHosts(): Promise<DetectedHost[]> {
    const roots = new Set<string>([
      ...(vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => folder.uri.fsPath),
      ...this.hostingCache.keys(),
    ]);
    const remotes: RemoteConfig[] = [];
    for (const root of roots) {
      const text = await readGitConfig(root);
      if (text !== undefined) remotes.push(...parseGitConfigRemotes(text));
    }
    const configured = new Map(
      [...this.hostingEntries.values()].map((entry) => [entry.host, entry.providerId]),
    );
    return detectHosts(remotes, configured);
  }

  /**
   * Connect flow: one list of the hosts detected in the workspace, the
   * integrations already set up, and every kind that can be added. Only a
   * self-hosted server asks for a hostname.
   */
  async connectIntegration(): Promise<void> {
    const items: ConnectItem[] = [];
    const offered = new Set<string>();
    const connectedLabel = async (providerId: string, host: string): Promise<string> =>
      (await this.auth.isConnected(providerId, host)) ? 'connected' : '';

    const detected = await this.detectWorkspaceHosts();
    const detectedItems: ConnectItem[] = [];
    for (const found of detected) {
      const item = this.detectedItem(found);
      if (!item) continue;
      offered.add(item.key);
      const status = await connectedLabel(found.providerId ?? '', found.domain);
      detectedItems.push({
        ...item.item,
        description: [item.item.description, status].filter(Boolean).join(' · '),
      });
    }
    if (detectedItems.length > 0) {
      items.push({ label: 'In this workspace', kind: vscode.QuickPickItemKind.Separator });
      items.push(...detectedItems);
    }

    const configured: ConnectItem[] = [];
    for (const entry of this.hostingEntries.values()) {
      const key = `${entry.providerId}:${entry.host}`;
      if (offered.has(key)) continue;
      const status = await connectedLabel(entry.providerId, entry.host);
      // The public hosts are listed under "Add" until they are connected.
      if (status === '' && isPublicHost(entry.host)) continue;
      offered.add(key);
      configured.push({
        label: `$(repo) ${entry.host}`,
        description: [providerLabel(entry.providerId, entry.host), status]
          .filter(Boolean)
          .join(' · '),
        choose: async () => ({ kind: 'hosting', providerId: entry.providerId, host: entry.host }),
      });
    }
    for (const entry of this.issueEntries) {
      const host = issueCredentialHost(entry);
      const status = await connectedLabel(entry.providerId, host);
      offered.add(`issues:${entry.providerId}:${host}`);
      configured.push({
        label: `$(issues) ${issueTrackerLabel(entry.providerId, entry.host)}`,
        description: [entry.host, status].filter(Boolean).join(' · '),
        choose: async () => ({ kind: 'issues', providerId: entry.providerId, host }),
      });
    }
    if (configured.length > 0) {
      items.push({ label: 'Set up', kind: vscode.QuickPickItemKind.Separator });
      items.push(...configured);
    }

    items.push({ label: 'Add', kind: vscode.QuickPickItemKind.Separator });
    for (const choice of HOSTING_PROVIDER_CHOICES) {
      if (choice.needsHost) continue;
      if (!choice.needsOrganization && offered.has(`${choice.id}:${choice.defaultHost}`)) continue;
      items.push({
        label: `$(repo) ${choice.label}${choice.needsOrganization ? '…' : ''}`,
        description: choice.detail ?? choice.defaultHost,
        choose: () => this.chooseHosting(choice),
      });
    }
    items.push({
      label: '$(server) Self-hosted server…',
      description: 'GitHub Enterprise Server, GitLab self-managed, Bitbucket Data Center',
      choose: () => this.chooseSelfHosted(),
    });
    items.push({
      label: '$(issues) Jira Cloud…',
      description: 'issue tracker',
      choose: () => this.chooseIssueTracker('jira'),
    });
    if (!offered.has('issues:linear:')) {
      items.push({
        label: '$(issues) Linear',
        description: 'issue tracker',
        choose: () => this.chooseIssueTracker('linear'),
      });
    }
    if (!offered.has('issues:github:github.com')) {
      items.push({
        label: '$(issues) GitHub Issues',
        description: 'issue tracker',
        choose: () => this.chooseIssueTracker('github'),
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Connect which integration?',
      matchOnDescription: true,
    });
    const target = picked?.choose ? await picked.choose() : undefined;
    if (!target) return;
    if (target.setting) await this.saveSetting(target.kind, target.setting);
    await this.authenticate(target);
  }

  /** A pick-list item for a host found among the remotes. */
  private detectedItem(found: DetectedHost): { key: string; item: ConnectItem } | undefined {
    const remote = `from remote "${found.remote}"`;
    if (found.providerId === 'azuredevops') {
      if (!found.organization) return undefined;
      // One organization is configured per host, so this one replaces any
      // other the entry names.
      const setting: HostSetting = {
        domain: found.domain,
        provider: 'azuredevops',
        organization: found.organization,
      };
      return {
        key: `azuredevops:${found.domain}`,
        item: {
          label: `$(repo) ${found.domain}/${found.organization}`,
          description: `Azure DevOps · ${remote}`,
          choose: async () => ({
            kind: 'hosting',
            providerId: 'azuredevops',
            host: found.domain,
            setting,
          }),
        },
      };
    }
    const providerId = found.providerId;
    const known = this.hostingEntries.get(found.domain);
    if (!known) {
      // A self-hosted server: the name only hints at what it runs, so the
      // user confirms the product, with the hinted one first.
      const hint =
        providerId === undefined ? 'self-hosted' : `${providerLabel(providerId, found.domain)}?`;
      return {
        key: `?:${found.domain}`,
        item: {
          label: `$(repo) ${found.domain}`,
          description: `${hint} · ${remote}`,
          choose: () => this.chooseSelfHosted(found.domain, providerId),
        },
      };
    }
    return {
      key: `${known.providerId}:${known.host}`,
      item: {
        label: `$(repo) ${found.domain}`,
        description: `${providerLabel(known.providerId, known.host)} · ${remote}`,
        choose: async () => ({ kind: 'hosting', providerId: known.providerId, host: known.host }),
      },
    };
  }

  /** A cloud hosting service; Azure DevOps also asks for the organization. */
  private async chooseHosting(choice: ProviderChoice): Promise<ConnectTarget | undefined> {
    const host = choice.defaultHost ?? '';
    if (!choice.needsOrganization) {
      return { kind: 'hosting', providerId: choice.id, host };
    }
    const entered = await vscode.window.showInputBox({
      prompt: 'Azure DevOps organization',
      placeHolder: 'contoso (from https://dev.azure.com/contoso)',
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() === '' || normalizeAzureOrganization(value)
          ? undefined
          : 'Enter the organization name, e.g. contoso',
    });
    const organization = entered === undefined ? undefined : normalizeAzureOrganization(entered);
    if (!organization) return undefined;
    return {
      kind: 'hosting',
      providerId: choice.id,
      host,
      setting: { domain: host, provider: choice.id, organization },
    };
  }

  /**
   * A self-hosted server: which product it runs, then its hostname unless it
   * came from a remote. `hint` is listed first.
   */
  private async chooseSelfHosted(
    knownHost?: string,
    hint?: string,
  ): Promise<ConnectTarget | undefined> {
    const kinds = HOSTING_PROVIDER_CHOICES.filter((choice) => choice.needsHost).sort(
      (a, b) => Number(b.id === hint) - Number(a.id === hint),
    );
    const kind = await vscode.window.showQuickPick(
      kinds.map((choice) => ({ label: choice.label, choice })),
      { placeHolder: knownHost ? `What does ${knownHost} run?` : 'Which server?' },
    );
    if (!kind) return undefined;
    let host = knownHost;
    if (host === undefined) {
      const entered = await vscode.window.showInputBox({
        prompt: `Hostname of your ${kind.choice.label}`,
        placeHolder: 'git.example.com',
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() === '' || isValidDomain(value)
            ? undefined
            : 'Enter a hostname such as git.example.com',
      });
      if (entered === undefined || !isValidDomain(entered)) return undefined;
      host = normalizeDomain(entered);
    }
    return {
      kind: 'hosting',
      providerId: kind.choice.id,
      host,
      setting: { domain: host, provider: kind.choice.id },
    };
  }

  private async chooseIssueTracker(providerId: string): Promise<ConnectTarget | undefined> {
    if (providerId === 'github') {
      return { kind: 'issues', providerId, host: 'github.com', setting: { provider: 'github' } };
    }
    if (providerId === 'linear') {
      return { kind: 'issues', providerId, host: '', setting: { provider: 'linear' } };
    }
    const entered = await vscode.window.showInputBox({
      prompt: 'Jira Cloud site',
      placeHolder: 'yoursite.atlassian.net',
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() === '' || normalizeJiraSite(value)
          ? undefined
          : 'Enter your Jira Cloud site, e.g. yoursite.atlassian.net',
    });
    const site = entered === undefined ? undefined : normalizeJiraSite(entered);
    if (!site) return undefined;
    return {
      kind: 'issues',
      providerId,
      host: site,
      setting: { provider: providerId, host: site },
    };
  }

  /** Writes a settings entry through the scope settingScope resolves. */
  private async saveSetting(
    kind: ConnectTarget['kind'],
    setting: HostSetting | IssueSetting,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitglasses');
    if (kind === 'hosting') {
      const scope = settingScope<HostSetting>('integrations.hosts');
      await config.update(
        'integrations.hosts',
        addHostSetting(scope.values, setting as HostSetting),
        scope.target,
      );
    } else {
      const scope = settingScope<IssueSetting>('integrations.issues');
      await config.update(
        'integrations.issues',
        addIssueSetting(scope.values, setting as IssueSetting),
        scope.target,
      );
    }
    this.reloadConfiguration();
  }

  /** Authenticate, then check the credential with one small request. */
  private async authenticate(target: ConnectTarget): Promise<void> {
    // A Jira site is named by its host; Linear and GitHub Issues by product.
    const name =
      target.kind === 'hosting' || target.providerId === 'jira'
        ? target.host
        : issueTrackerLabel(target.providerId, target.host);
    const hosting = target.kind === 'hosting' ? this.hostingEntries.get(target.host) : undefined;
    const issues =
      target.kind === 'issues'
        ? this.issueEntries.find(
            (entry) =>
              entry.providerId === target.providerId && issueCredentialHost(entry) === target.host,
          )
        : undefined;
    if (!hosting && !issues) {
      void vscode.window.showWarningMessage(
        `GitGlasses: ${name} could not be set up; check gitglasses.integrations in settings.`,
      );
      return;
    }

    const credential = await this.auth.getAuth(target.providerId, target.host, {
      interactive: true,
    });
    if (!credential) return;
    const auth = toAuthContext(credential, target.host);

    try {
      if (hosting) {
        await hosting.provider.getMyPullRequests(auth, { limit: 1 });
      } else {
        await issues?.provider.getMyIssues(auth, { limit: 1 });
      }
    } catch (error) {
      if (error instanceof AuthError) {
        await this.auth.signOut(target.providerId, target.host);
        const retry = await vscode.window.showErrorMessage(
          `GitGlasses: authentication with ${name} failed — the token was rejected.`,
          'Try Again',
        );
        if (retry === 'Try Again') await this.authenticate(target);
        return;
      }
      if (error instanceof CredentialScopeError) {
        void vscode.window.showErrorMessage(`GitGlasses: ${errorText(error)}`);
        return;
      }
      void vscode.window.showWarningMessage(
        `GitGlasses: connected, but validation failed: ${errorText(error)}`,
      );
    }
    this.emitter.fire();
    void vscode.window.showInformationMessage(`GitGlasses: connected to ${name}.`);
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
      const host = issueCredentialHost(entry);
      if (await this.auth.isConnected(entry.providerId, host)) {
        const label = issueTrackerLabel(entry.providerId, entry.host);
        candidates.push({
          providerId: entry.providerId,
          host,
          label: entry.host ? `${label} (${entry.host})` : label,
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

/** Hosts served out of the box, which need no settings entry. */
function isPublicHost(host: string): boolean {
  return DEFAULT_HOSTING_HOSTS.some((entry) => entry.domain === host);
}
