/**
 * Builds providers from integration settings: a provider id plus the host the
 * user configured it for. Each provider takes its endpoint under a different
 * option name, so this is the one place that maps a configured host onto the
 * option a provider actually reads. A configuration a provider cannot serve
 * from that host is rejected rather than built against a public default,
 * which would send the host's credential somewhere else.
 */

import type { FetchLike } from './http.js';
import type { HostingProvider, IssueProvider } from './hostingProvider.js';
import { AzureDevOpsProvider } from './providers/azuredevops.js';
import { BitbucketProvider } from './providers/bitbucket.js';
import { BitbucketDCProvider } from './providers/bitbucketDC.js';
import { createGitHubEnterpriseProvider, GitHubProvider } from './providers/github.js';
import { GitLabProvider } from './providers/gitlab.js';
import { JiraProvider } from './providers/jira.js';
import { LinearProvider } from './providers/linear.js';
import { assertPlainHost } from './providers/shared.js';

/** Hosting provider ids a settings entry may name. */
export const HOSTING_PROVIDER_IDS = [
  'github',
  'github-enterprise',
  'gitlab',
  'bitbucket',
  'bitbucketDC',
  'azuredevops',
] as const;

/** Issue tracker ids a settings entry may name. */
export const ISSUE_PROVIDER_IDS = ['jira', 'linear', 'github', 'github-enterprise'] as const;

/** Public hosts that need no configuration, and the provider serving each. */
export const DEFAULT_HOSTING_HOSTS: ReadonlyArray<{ providerId: string; domain: string }> = [
  { providerId: 'github', domain: 'github.com' },
  { providerId: 'gitlab', domain: 'gitlab.com' },
  { providerId: 'bitbucket', domain: 'bitbucket.org' },
];

/** The one host Azure DevOps Services serves every organization from. */
export const AZURE_DEVOPS_HOST = 'dev.azure.com';

export interface HostingProviderConfig {
  /** Provider id from settings, e.g. "gitlab"; also the built provider's id. */
  providerId: string;
  /** Host the instance is reached at, e.g. "gitlab.corp.example". */
  domain: string;
  /** Azure DevOps organization the account-wide queries run in. */
  organization?: string;
  fetchFn?: FetchLike;
}

export interface IssueProviderConfig {
  /** Provider id from settings, e.g. "jira". */
  providerId: string;
  /** Tracker host, e.g. "acme.atlassian.net"; unused by Linear. */
  host?: string;
  fetchFn?: FetchLike;
}

/** A settings entry no provider can serve; the message says why. */
export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConfigError';
  }
}

function plainHost(value: string | undefined, what: string): string {
  try {
    return assertPlainHost(value as string, what).toLowerCase();
  } catch (error) {
    throw new IntegrationConfigError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The hosting provider for `config`, with `config.providerId` as its id so
 * credentials stored under that id are the ones it is given. Throws
 * IntegrationConfigError when the provider cannot serve the host.
 */
export function createHostingProvider(config: HostingProviderConfig): HostingProvider {
  const domain = plainHost(config.domain, 'Integration host');
  const { fetchFn } = config;
  switch (config.providerId) {
    case 'github':
      // github on any other host is a GitHub Enterprise Server instance; the
      // provider then serves that host's own API, under the "github" id.
      return domain === 'github.com'
        ? new GitHubProvider({ fetchFn })
        : new GitHubProvider({ id: 'github', host: domain, fetchFn });
    case 'github-enterprise':
      if (domain === 'github.com') {
        throw new IntegrationConfigError(
          'github.com is GitHub, not GitHub Enterprise Server; use the "github" provider'
        );
      }
      return createGitHubEnterpriseProvider(domain, fetchFn);
    case 'gitlab':
      return new GitLabProvider({ baseUrl: `https://${domain}`, fetchFn });
    case 'bitbucket':
      if (domain !== 'bitbucket.org') {
        throw new IntegrationConfigError(
          `Bitbucket Cloud only serves bitbucket.org; use Bitbucket Data Center ("bitbucketDC") for ${domain}`
        );
      }
      return new BitbucketProvider({ fetchFn });
    case 'bitbucketDC':
      if (domain === 'bitbucket.org') {
        throw new IntegrationConfigError(
          'bitbucket.org is Bitbucket Cloud; use the "bitbucket" provider'
        );
      }
      return new BitbucketDCProvider({ id: 'bitbucketDC', baseUrl: `https://${domain}`, fetchFn });
    case 'azuredevops': {
      if (domain !== AZURE_DEVOPS_HOST) {
        throw new IntegrationConfigError(
          `Azure DevOps Server (${domain}) is not supported yet; only ${AZURE_DEVOPS_HOST} is`
        );
      }
      if (!config.organization) {
        throw new IntegrationConfigError(
          'Azure DevOps needs the organization (the first path segment after dev.azure.com)'
        );
      }
      const organization = plainHost(config.organization, 'Azure DevOps organization');
      return new AzureDevOpsProvider({ organization, fetchFn });
    }
    default:
      throw new IntegrationConfigError(
        `Unknown hosting provider "${config.providerId}" (expected one of ${HOSTING_PROVIDER_IDS.join(', ')})`
      );
  }
}

/**
 * The issue tracker for `config`, with `config.providerId` as its id. Throws
 * IntegrationConfigError when the tracker cannot serve the host.
 */
export function createIssueProvider(config: IssueProviderConfig): IssueProvider {
  const { fetchFn } = config;
  const host = config.host === undefined || config.host === '' ? undefined : config.host;
  switch (config.providerId) {
    case 'jira': {
      const site = plainHost(host, 'Jira site');
      // The search and auth calls are Jira Cloud's; Server and Data Center
      // speak an older API with different credentials.
      if (!site.endsWith('.atlassian.net')) {
        throw new IntegrationConfigError(
          `Jira Server and Data Center (${site}) are not supported yet; use a *.atlassian.net site`
        );
      }
      return new JiraProvider({ baseUrl: `https://${site}`, fetchFn });
    }
    case 'linear':
      if (host !== undefined && host.toLowerCase() !== 'linear.app') {
        throw new IntegrationConfigError(`Linear is only served from linear.app, not ${host}`);
      }
      return new LinearProvider({ fetchFn });
    case 'github': {
      const domain = host === undefined ? 'github.com' : plainHost(host, 'GitHub host');
      return domain === 'github.com'
        ? new GitHubProvider({ fetchFn })
        : new GitHubProvider({ id: 'github', host: domain, fetchFn });
    }
    case 'github-enterprise': {
      const domain = plainHost(host, 'GitHub Enterprise host');
      if (domain === 'github.com') {
        throw new IntegrationConfigError(
          'github.com is GitHub, not GitHub Enterprise Server; use the "github" provider'
        );
      }
      return createGitHubEnterpriseProvider(domain, fetchFn);
    }
    default:
      throw new IntegrationConfigError(
        `Unknown issue provider "${config.providerId}" (expected one of ${ISSUE_PROVIDER_IDS.join(', ')})`
      );
  }
}
