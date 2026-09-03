// Pure editing of the integration settings arrays (no vscode imports).
//
// gitglasses.integrations.hosts and .issues were previously only editable by
// hand in settings.json. These helpers let a quick-pick flow build the same
// entries, keeping validation and de-duplication testable.

import type { HostSetting, IssueSetting } from './integrationService';

export interface ProviderChoice {
  id: string;
  label: string;
  /** Whether a host/domain must be supplied for this provider. */
  needsHost: boolean;
  detail?: string;
}

/** Self-hostable git forges the integrations package ships a provider for. */
export const HOSTING_PROVIDER_CHOICES: readonly ProviderChoice[] = [
  {
    id: 'github-enterprise',
    label: 'GitHub Enterprise Server',
    needsHost: true,
    detail: 'Self-hosted GitHub',
  },
  { id: 'gitlab', label: 'GitLab', needsHost: true, detail: 'gitlab.com or self-hosted' },
  { id: 'bitbucket', label: 'Bitbucket Cloud', needsHost: true },
  { id: 'bitbucketDC', label: 'Bitbucket Data Center', needsHost: true, detail: 'Self-hosted' },
  { id: 'azuredevops', label: 'Azure DevOps', needsHost: true },
];

/** Issue trackers that can be attached independently of the git host. */
export const ISSUE_PROVIDER_CHOICES: readonly ProviderChoice[] = [
  { id: 'jira', label: 'Jira', needsHost: true, detail: 'e.g. mycompany.atlassian.net' },
  { id: 'linear', label: 'Linear', needsHost: false },
];

/**
 * Reduce user input to a bare hostname: people paste full URLs, and a scheme,
 * port-less path or trailing slash would not match the host recorded against a
 * remote.
 */
export function normalizeDomain(input: string): string {
  let value = input.trim();
  if (value === '') return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  value = value.replace(/\/.*$/, '');
  value = value.replace(/^[^@]*@/, '');
  return value.toLowerCase();
}

/** True when the value looks like a hostname we can match a remote against. */
export function isValidDomain(input: string): boolean {
  const domain = normalizeDomain(input);
  if (domain === '') return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/.test(domain);
}

/** Appends a hosting entry, replacing any existing entry for the same domain. */
export function addHostSetting(
  existing: readonly HostSetting[],
  entry: HostSetting,
): HostSetting[] {
  const domain = normalizeDomain(entry.domain);
  const kept = existing.filter((host) => normalizeDomain(host.domain) !== domain);
  return [...kept, { domain, provider: entry.provider }];
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
  const host = entry.host === undefined ? undefined : normalizeDomain(entry.host);
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
