// Pure editing of the integration settings arrays (no vscode imports): the
// quick-pick flows build gitglasses.integrations.hosts and .issues entries
// through these, which keeps validation and de-duplication testable.

import type { HostSetting, IssueSetting } from './providerSetup';

export interface ProviderChoice {
  id: string;
  label: string;
  /** Whether a host/domain must be supplied for this provider. */
  needsHost: boolean;
  /** Host a provider that needs none is served from. */
  defaultHost?: string;
  /** Whether an Azure DevOps organization must be supplied. */
  needsOrganization?: boolean;
  detail?: string;
}

/**
 * Git hosts a connection can be set up for. Cloud services need no hostname;
 * only the self-hosted servers ask for one.
 */
export const HOSTING_PROVIDER_CHOICES: readonly ProviderChoice[] = [
  { id: 'github', label: 'GitHub', needsHost: false, defaultHost: 'github.com' },
  { id: 'gitlab', label: 'GitLab.com', needsHost: false, defaultHost: 'gitlab.com' },
  { id: 'bitbucket', label: 'Bitbucket Cloud', needsHost: false, defaultHost: 'bitbucket.org' },
  {
    id: 'azuredevops',
    label: 'Azure DevOps',
    needsHost: false,
    defaultHost: 'dev.azure.com',
    needsOrganization: true,
    detail: 'dev.azure.com organization',
  },
  {
    id: 'github-enterprise',
    label: 'GitHub Enterprise Server',
    needsHost: true,
    detail: 'Self-hosted',
  },
  { id: 'gitlab', label: 'GitLab self-managed', needsHost: true, detail: 'Self-hosted' },
  { id: 'bitbucketDC', label: 'Bitbucket Data Center', needsHost: true, detail: 'Self-hosted' },
];

/** Issue trackers that can be attached independently of the git host. */
export const ISSUE_PROVIDER_CHOICES: readonly ProviderChoice[] = [
  { id: 'jira', label: 'Jira Cloud', needsHost: true, detail: 'yoursite.atlassian.net' },
  { id: 'linear', label: 'Linear', needsHost: false },
  { id: 'github', label: 'GitHub Issues', needsHost: false, defaultHost: 'github.com' },
];

/** Display name for a provider id, as settings and the pickers name it. */
export function providerLabel(providerId: string, host?: string): string {
  switch (providerId) {
    case 'github':
      return host === undefined || host === '' || host === 'github.com'
        ? 'GitHub'
        : 'GitHub Enterprise Server';
    case 'github-enterprise':
      return 'GitHub Enterprise Server';
    case 'gitlab':
      return host === undefined || host === '' || host === 'gitlab.com'
        ? 'GitLab'
        : 'GitLab self-managed';
    case 'bitbucket':
      return 'Bitbucket Cloud';
    case 'bitbucketDC':
      return 'Bitbucket Data Center';
    case 'azuredevops':
      return 'Azure DevOps';
    case 'jira':
      return 'Jira Cloud';
    case 'linear':
      return 'Linear';
    default:
      return providerId;
  }
}

/** Display name for an issue tracker entry. */
export function issueTrackerLabel(providerId: string, host?: string): string {
  if (providerId === 'github' || providerId === 'github-enterprise') {
    return providerLabel(providerId, host) === 'GitHub'
      ? 'GitHub Issues'
      : 'GitHub Enterprise Server issues';
  }
  return providerLabel(providerId, host);
}

/** What to ask for when a provider's credential is entered by hand. */
export interface CredentialSpec {
  tokenPrompt: string;
  /** Asked for alongside the token, when the provider pairs it with an account. */
  usernamePrompt?: string;
  /** False when an empty answer is acceptable (the token then stands alone). */
  usernameRequired?: boolean;
}

/** Prompts naming the kind of token each provider expects. */
export function credentialSpec(providerId: string, host: string): CredentialSpec {
  switch (providerId) {
    case 'github':
    case 'github-enterprise':
      return { tokenPrompt: `GitHub personal access token for ${host} (scope: repo)` };
    case 'gitlab':
      return { tokenPrompt: `GitLab personal access token for ${host} (scope: api)` };
    case 'bitbucket':
      return {
        tokenPrompt: 'Bitbucket API token, or a workspace/repository access token',
        usernamePrompt:
          'Atlassian account email the API token belongs to (leave empty for an access token)',
        usernameRequired: false,
      };
    case 'bitbucketDC':
      return { tokenPrompt: `Bitbucket Data Center HTTP access token for ${host}` };
    case 'azuredevops':
      return {
        tokenPrompt: `Azure DevOps personal access token for ${host} (Code: Read; Work Items: Read)`,
      };
    case 'jira':
      return {
        tokenPrompt: `Jira API token for ${host}`,
        usernamePrompt: `Atlassian account email for ${host}`,
        usernameRequired: true,
      };
    case 'linear':
      return { tokenPrompt: 'Linear personal API key' };
    default:
      return { tokenPrompt: `Personal access token for ${providerId} (${host})` };
  }
}

/**
 * An Azure DevOps organization as typed or pasted: a bare name, or a
 * dev.azure.com / <org>.visualstudio.com URL. Undefined when it is neither.
 */
export function normalizeAzureOrganization(input: string): string | undefined {
  const value = input.trim();
  const fromUrl =
    /^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)/i.exec(value)?.[1] ??
    /^(?:https?:\/\/)?([^./]+)\.visualstudio\.com(?:[/?#]|$)/i.exec(value)?.[1];
  const name = fromUrl ?? value;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(name) ? name : undefined;
}

/**
 * A Jira Cloud site as typed or pasted: "acme", "acme.atlassian.net" or a URL
 * on it. Undefined for anything that is not an atlassian.net site.
 */
export function normalizeJiraSite(input: string): string | undefined {
  const trimmed = input.trim();
  const host = /^[a-z0-9-]+$/i.test(trimmed)
    ? `${trimmed}.atlassian.net`
    : normalizeDomain(trimmed);
  return isValidDomain(host) && host.endsWith('.atlassian.net') && host !== 'atlassian.net'
    ? host.toLowerCase()
    : undefined;
}

/**
 * Reduce user input to a bare hostname. People paste full URLs, and only the
 * host matches what is recorded against a remote.
 */
export function normalizeDomain(input: string): string {
  let value = input.trim();
  if (value === '') return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  value = value.replace(/\/.*$/, '');
  value = value.replace(/^[^@]*@/, '');
  // The remote matcher parses the port off separately and discards it, so a
  // stored domain only matches without one.
  value = value.replace(/:\d+$/, '');
  return value.toLowerCase();
}

/** True when the value looks like a hostname we can match a remote against. */
export function isValidDomain(input: string): boolean {
  const domain = normalizeDomain(input);
  if (domain === '') return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
}

/** Appends a hosting entry, replacing any existing entry for the same domain. */
export function addHostSetting(
  existing: readonly HostSetting[],
  entry: HostSetting,
): HostSetting[] {
  const domain = normalizeDomain(entry.domain);
  const kept = existing.filter((host) => normalizeDomain(host.domain) !== domain);
  const next: HostSetting = { domain, provider: entry.provider };
  if (entry.organization) next.organization = entry.organization;
  return [...kept, next];
}

export function removeHostSetting(
  existing: readonly HostSetting[],
  domain: string,
): HostSetting[] {
  const wanted = normalizeDomain(domain);
  return existing.filter((host) => normalizeDomain(host.domain) !== wanted);
}

/** Appends an issue entry, replacing any existing entry for the same pair. */
export function addIssueSetting(
  existing: readonly IssueSetting[],
  entry: IssueSetting,
): IssueSetting[] {
  // An empty host normalises to '' but is written as "no host", so treat the
  // two as the same entry or add() can leave a duplicate behind.
  const normalized = entry.host === undefined ? undefined : normalizeDomain(entry.host);
  const host = normalized === '' ? undefined : normalized;
  const kept = existing.filter(
    (issue) =>
      !(
        issue.provider === entry.provider &&
        (issue.host === undefined ? undefined : normalizeDomain(issue.host)) === host
      ),
  );
  const next: IssueSetting = host ? { provider: entry.provider, host } : { provider: entry.provider };
  return [...kept, next];
}

export function removeIssueSetting(
  existing: readonly IssueSetting[],
  provider: string,
  host?: string,
): IssueSetting[] {
  const wanted = host === undefined ? undefined : normalizeDomain(host);
  return existing.filter(
    (issue) =>
      !(
        issue.provider === provider &&
        (issue.host === undefined ? undefined : normalizeDomain(issue.host)) === wanted
      ),
  );
}

/** Stable label for an issue entry in pick lists and messages. */
export function describeIssueSetting(entry: IssueSetting): string {
  return entry.host ? `${entry.provider} (${entry.host})` : entry.provider;
}
