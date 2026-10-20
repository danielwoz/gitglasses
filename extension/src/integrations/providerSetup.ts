// Integration settings to provider instances (no vscode imports). The
// integration service builds every provider through these functions, so the
// tests that drive them with a stub transport exercise the same path the
// extension takes.

import {
  createHostingProvider,
  createIssueProvider,
  DEFAULT_HOSTING_HOSTS,
  parseRemoteUrl,
  type AuthContext,
  type FetchLike,
  type HostingProvider,
  type IssueProvider,
  type RepoDescriptor,
} from '@gitglasses/integrations';

/** One `gitglasses.integrations.hosts` entry. */
export interface HostSetting {
  domain: string;
  provider: string;
  /** Azure DevOps organization the Launchpad lists pull requests from. */
  organization?: string;
}

/** One `gitglasses.integrations.issues` entry. */
export interface IssueSetting {
  provider: string;
  host?: string;
}

export interface HostingEntry {
  providerId: string;
  /** Host the provider serves; also the host its credential is stored under. */
  host: string;
  provider: HostingProvider;
}

export interface IssueProviderEntry {
  providerId: string;
  /** Host from settings; credentials are stored under it ('' when absent). */
  host?: string;
  provider: IssueProvider;
}

/** A stored credential, as AuthManager hands it out. */
export interface StoredCredential {
  token: string;
  username?: string;
}

/**
 * The AuthContext for a credential stored under `host`. Naming the host lets
 * a provider refuse to send the credential anywhere else.
 */
export function toAuthContext(credential: StoredCredential, host: string | undefined): AuthContext {
  const context: AuthContext = { token: credential.token };
  if (credential.username) context.username = credential.username;
  if (host) context.host = host;
  return context;
}

function isHostSetting(value: unknown): value is HostSetting {
  const entry = value as Partial<HostSetting> | null;
  return typeof entry?.domain === 'string' && typeof entry.provider === 'string';
}

function isIssueSetting(value: unknown): value is IssueSetting {
  const entry = value as Partial<IssueSetting> | null;
  return (
    typeof entry?.provider === 'string' &&
    (entry.host === undefined || typeof entry.host === 'string')
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hosting providers keyed by host: github.com, gitlab.com and bitbucket.org
 * out of the box, then one per settings entry, an entry replacing the default
 * for its host. Entries no provider can serve are left out and described in
 * `problems`.
 */
export function buildHostingEntries(
  settings: readonly unknown[],
  fetchFn?: FetchLike,
): { entries: Map<string, HostingEntry>; problems: string[] } {
  const entries = new Map<string, HostingEntry>();
  const problems: string[] = [];
  for (const { providerId, domain } of DEFAULT_HOSTING_HOSTS) {
    entries.set(domain, {
      providerId,
      host: domain,
      provider: createHostingProvider({ providerId, domain, fetchFn }),
    });
  }
  for (const setting of settings) {
    if (!isHostSetting(setting)) {
      problems.push(`a hosts entry needs a "domain" and a "provider": ${JSON.stringify(setting)}`);
      continue;
    }
    const domain = setting.domain.trim().toLowerCase();
    try {
      const provider = createHostingProvider({
        providerId: setting.provider,
        domain,
        organization: setting.organization,
        fetchFn,
      });
      entries.set(domain, { providerId: setting.provider, host: domain, provider });
    } catch (error) {
      // The default for a public host stays, so a typo cannot silence it.
      problems.push(`${setting.provider} on ${setting.domain}: ${reason(error)}`);
    }
  }
  return { entries, problems };
}

/** The provider serving a remote URL's host, with the repository the URL names. */
export function hostingForUrl(
  entries: ReadonlyMap<string, HostingEntry>,
  url: string,
): { providerId: string; host: string; provider: HostingProvider; repo: RepoDescriptor } | undefined {
  const parsed = parseRemoteUrl(url);
  const entry = parsed && entries.get(parsed.host);
  if (!parsed || !entry) return undefined;
  return {
    providerId: entry.providerId,
    host: entry.host,
    provider: entry.provider,
    repo: entry.provider.matchesRemote(url) ?? { provider: entry.providerId, ...parsed },
  };
}

/** Issue trackers from settings; entries no tracker can serve go to `problems`. */
export function buildIssueEntries(
  settings: readonly unknown[],
  fetchFn?: FetchLike,
): { entries: IssueProviderEntry[]; problems: string[] } {
  const entries: IssueProviderEntry[] = [];
  const problems: string[] = [];
  for (const setting of settings) {
    if (!isIssueSetting(setting)) {
      problems.push(`an issues entry needs a "provider": ${JSON.stringify(setting)}`);
      continue;
    }
    try {
      const provider = createIssueProvider({
        providerId: setting.provider,
        host: setting.host,
        fetchFn,
      });
      entries.push({ providerId: setting.provider, host: setting.host, provider });
    } catch (error) {
      const where = setting.host ? ` on ${setting.host}` : '';
      problems.push(`${setting.provider}${where}: ${reason(error)}`);
    }
  }
  return { entries, problems };
}

/**
 * Host the credential for an issue entry is stored under. GitHub Issues
 * shares the github.com sign-in; other trackers keep their own entry.
 */
export function issueCredentialHost(entry: { providerId: string; host?: string }): string {
  if (entry.providerId === 'github' && !entry.host) return 'github.com';
  return entry.host ?? '';
}

/** A git host found among a workspace's remotes. */
export interface DetectedHost {
  /** Provider id that serves the host, when it could be told. */
  providerId?: string;
  domain: string;
  /** Azure DevOps organization the remote belongs to. */
  organization?: string;
  /** Name of the remote it was found on, e.g. "origin". */
  remote: string;
}

/** Hosts served without a settings entry, by provider id. */
const PUBLIC_HOSTS = new Map(
  DEFAULT_HOSTING_HOSTS.map(({ domain, providerId }) => [domain, providerId]),
);

/**
 * The provider a self-hosted instance most likely runs, from its hostname:
 * instances are commonly named after the product. Undefined when the name
 * says nothing.
 */
export function guessProviderFromHostname(host: string): string | undefined {
  const labels = host.toLowerCase().split(/[.-]/);
  if (labels.includes('gitlab')) return 'gitlab';
  if (labels.includes('github') || labels.includes('ghe')) return 'github-enterprise';
  if (labels.includes('bitbucket') || labels.includes('stash')) return 'bitbucketDC';
  return undefined;
}

/**
 * Hosts among `remotes` and the provider for each: the configured provider
 * for a host already in settings, the public provider for github.com,
 * gitlab.com, bitbucket.org and dev.azure.com, and a guess from the hostname
 * otherwise. Each host (and Azure DevOps organization) is reported once.
 */
export function detectHosts(
  remotes: ReadonlyArray<{ name: string; url?: string; pushUrl?: string }>,
  configured: ReadonlyMap<string, string>,
): DetectedHost[] {
  const found = new Map<string, DetectedHost>();
  for (const remote of remotes) {
    const url = remote.url ?? remote.pushUrl;
    const parsed = url === undefined ? undefined : parseRemoteUrl(url);
    if (!parsed) continue;
    const domain = parsed.host;
    const organization =
      domain === 'dev.azure.com' ? parsed.owner.split('/')[0] || undefined : undefined;
    const key = organization ? `${domain}/${organization.toLowerCase()}` : domain;
    if (found.has(key)) continue;
    const providerId =
      configured.get(domain) ??
      PUBLIC_HOSTS.get(domain) ??
      (domain === 'dev.azure.com' ? 'azuredevops' : guessProviderFromHostname(domain));
    found.set(key, { providerId, domain, organization, remote: remote.name });
  }
  return [...found.values()];
}
