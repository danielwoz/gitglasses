import type { HostingProvider } from './hostingProvider.js';
import type { RepoDescriptor } from './models.js';

/** Host/owner/name parsed out of a git remote URL (provider not yet known). */
export interface ParsedRemote {
  host: string;
  owner: string;
  name: string;
}

const URL_STYLE = /^[a-z][a-z0-9+.-]*:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.+)$/i;
const SCP_STYLE = /^(?:([^@/]+)@)?([^:/]+):(.+)$/;

function cleanPath(path: string): string {
  let p = path.replace(/\/+$/, '');
  if (p.toLowerCase().endsWith('.git')) {
    p = p.slice(0, -4);
  }
  return p;
}

function splitOwnerName(host: string, path: string): ParsedRemote | undefined {
  // Azure DevOps https form: org/project/_git/repo
  const gitMarker = path.indexOf('/_git/');
  if (gitMarker !== -1) {
    const owner = path.slice(0, gitMarker);
    const name = path.slice(gitMarker + '/_git/'.length);
    if (!owner || !name || name.includes('/')) {
      return undefined;
    }
    return { host, owner, name };
  }

  // Azure DevOps ssh form: v3/org/project/repo on *vs-ssh.visualstudio.com
  if (host.endsWith('vs-ssh.visualstudio.com')) {
    const segments = path.split('/').filter(Boolean);
    if (segments[0] === 'v3' && segments.length === 4) {
      return {
        host: 'dev.azure.com',
        owner: `${segments[1]}/${segments[2]}`,
        name: segments[3],
      };
    }
    return undefined;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  // Multi-segment owners cover nested groups (GitLab) and org/project (ADO).
  return {
    host,
    owner: segments.slice(0, -1).join('/'),
    name: segments[segments.length - 1],
  };
}

/**
 * Parse a git remote URL into host/owner/name. Supports:
 * - https://host[:port]/owner/repo(.git)
 * - git@host:owner/repo.git (scp-like)
 * - ssh://git@host[:port]/owner/repo(.git)
 * - Azure DevOps: https://dev.azure.com/org/project/_git/repo and
 *   org@vs-ssh.visualstudio.com:v3/org/project/repo (owner becomes "org/project")
 */
export function parseRemoteUrl(remoteUrl: string): ParsedRemote | undefined {
  const url = remoteUrl.trim();
  if (!url) {
    return undefined;
  }

  const urlMatch = URL_STYLE.exec(url);
  if (urlMatch) {
    const host = urlMatch[2].toLowerCase();
    return splitOwnerName(host, cleanPath(urlMatch[4]));
  }

  if (!url.includes('://')) {
    const scpMatch = SCP_STYLE.exec(url);
    if (scpMatch) {
      const host = scpMatch[2].toLowerCase();
      // Reject things that are clearly not hostnames (e.g. windows paths "C:...").
      if (!host.includes('.') && host !== 'localhost') {
        return undefined;
      }
      return splitOwnerName(host, cleanPath(scpMatch[3]));
    }
  }

  return undefined;
}

/** Default well-known host to provider-id mapping. */
export const DEFAULT_HOSTS: ReadonlyMap<string, string> = new Map([
  ['github.com', 'github'],
  ['gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
  ['dev.azure.com', 'azuredevops'],
]);

export interface HostConfiguration {
  /** Domain of a (usually self-hosted) instance, e.g. "git.corp.example". */
  domain: string;
  /** Provider id that handles this domain, e.g. "github-enterprise". */
  providerId: string;
}

export interface ResolvedRemote {
  providerId: string;
  /** The registered provider instance, when one has been registered for the id. */
  provider?: HostingProvider;
  repo: RepoDescriptor;
}

/**
 * Maps git remotes to hosting providers. Knows the public hosts by default and
 * accepts user-declared self-hosted domains via `configureHosts`.
 */
export class ProviderRegistry {
  private readonly hosts = new Map<string, string>(DEFAULT_HOSTS);
  private readonly providers = new Map<string, HostingProvider>();

  register(provider: HostingProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): HostingProvider | undefined {
    return this.providers.get(providerId);
  }

  /** Declare additional domains (self-hosted instances) and which provider serves them. */
  configureHosts(hosts: readonly HostConfiguration[]): void {
    for (const { domain, providerId } of hosts) {
      this.hosts.set(domain.toLowerCase(), providerId);
    }
  }

  providerIdForHost(host: string): string | undefined {
    return this.hosts.get(host.toLowerCase());
  }

  /** Resolve a remote URL to its provider and repo descriptor, if the host is known. */
  resolveRemote(remoteUrl: string): ResolvedRemote | undefined {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed) {
      return undefined;
    }
    const providerId = this.providerIdForHost(parsed.host);
    if (!providerId) {
      return undefined;
    }
    return {
      providerId,
      provider: this.providers.get(providerId),
      repo: { provider: providerId, ...parsed },
    };
  }
}
