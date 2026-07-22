import type { FetchLike } from './http.js';
import type { HostingProvider } from './hostingProvider.js';
import { BitbucketProvider } from './providers/bitbucket.js';
import { GitHubProvider } from './providers/github.js';
import { GitLabProvider } from './providers/gitlab.js';

/**
 * Instances for the public hosts that need no per-instance configuration
 * (github.com, gitlab.com, bitbucket.org), keyed by provider id and matching
 * the ids in remoteMatcher's DEFAULT_HOSTS map. Providers requiring instance
 * config (GitHub Enterprise, self-managed GitLab, Bitbucket Data Center,
 * Azure DevOps organizations, Jira sites) are constructed and registered by
 * the host application.
 */
export function createDefaultProviders(fetchFn?: FetchLike): Map<string, HostingProvider> {
  const providers: HostingProvider[] = [
    new GitHubProvider({ fetchFn }),
    new GitLabProvider({ fetchFn }),
    new BitbucketProvider({ fetchFn }),
  ];
  return new Map(providers.map((provider) => [provider.id, provider]));
}
