// Integration settings to provider instances (no vscode imports). The
// integration service builds every provider through these functions, so the
// tests that drive them with a stub transport exercise the same path the
// extension takes.

import {
  createHostingProvider,
  createIssueProvider,
  DEFAULT_HOSTING_HOSTS,
  type AuthContext,
  type FetchLike,
  type HostingProvider,
  type IssueProvider,
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
 * Hosting providers keyed by host: github.com out of the box, then one per
 * settings entry, an entry replacing the default for its host. Entries no
 * provider can serve are left out and described in `problems`.
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
