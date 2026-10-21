// list_my_prs: the open pull requests that involve the user on each hosting
// service the server's environment holds a token for. A token and the host it
// authenticates to are inseparable, so both come from the environment and
// neither is a tool argument: an agent that could name the host could have a
// token sent anywhere.

import {
  createHostingProvider,
  groupItems,
  type AuthContext,
  type FetchLike,
  type HostingProvider,
  type LaunchpadGroup,
} from '@gitglasses/integrations';
import { formatLaunchpad } from '../format.js';

/**
 * A bare hostname, optionally with a port: letters, digits, hyphens and dots.
 *
 * Anything that could redirect an authenticated request elsewhere is rejected:
 * userinfo ("api.github.com@attacker.example" reads as GitHub but resolves to
 * the attacker), a scheme, a path, or whitespace.
 */
export function isPlainHostname(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(
    value,
  );
}

type Env = Record<string, string | undefined>;

/** A hostname setting, checked; `fallback` when it is unset. */
function hostSetting(env: Env, name: string, fallback?: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!isPlainHostname(value)) {
    throw new Error(`${name} is not a plain hostname: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The first of `names` set to a non-empty value. */
function setting(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The GitHub host this server talks to, from operator configuration only.
 * The host pairs with the token, so both come from the environment and
 * neither is something a caller can name.
 */
export function configuredGitHubHost(env: Env): string | undefined {
  const host = hostSetting(env, 'GITGLASSES_GITHUB_HOST');
  return host === 'github.com' ? undefined : host;
}

/** One hosting service the environment configures. */
export interface ConfiguredHost {
  /** The host, as the output names it. */
  label: string;
  provider: HostingProvider;
  /** The token, scoped to the host it was issued for. */
  auth: AuthContext;
}

/** The variables that configure a host, for the message when none is set. */
export const HOST_SETTINGS =
  'GITHUB_TOKEN (with GITGLASSES_GITHUB_HOST for GitHub Enterprise), GITLAB_TOKEN (with ' +
  'GITGLASSES_GITLAB_HOST for a self-managed GitLab), GITGLASSES_BITBUCKET_TOKEN (with ' +
  'GITGLASSES_BITBUCKET_USERNAME for an app password), GITGLASSES_BITBUCKET_DC_TOKEN with ' +
  'GITGLASSES_BITBUCKET_DC_HOST, or GITGLASSES_AZURE_DEVOPS_TOKEN with GITGLASSES_AZURE_DEVOPS_ORG';

/**
 * Every host the environment holds a token for, built through the provider
 * factory so each token is only ever sent to its own host. A token whose host
 * setting is missing or malformed throws, naming the variable.
 */
export function configuredHosts(env: Env, fetchFn?: FetchLike): ConfiguredHost[] {
  const hosts: ConfiguredHost[] = [];
  const add = (
    label: string,
    providerId: string,
    domain: string,
    auth: Omit<AuthContext, 'host'>,
    organization?: string,
  ): void => {
    hosts.push({
      label,
      provider: createHostingProvider({ providerId, domain, organization, fetchFn }),
      auth: { ...auth, host: domain },
    });
  };

  const github = setting(env, 'GITHUB_TOKEN', 'GITGLASSES_GITHUB_TOKEN');
  if (github) {
    const enterprise = configuredGitHubHost(env);
    if (enterprise) add(enterprise, 'github-enterprise', enterprise, { token: github });
    else add('github.com', 'github', 'github.com', { token: github });
  }

  const gitlab = setting(env, 'GITLAB_TOKEN', 'GITGLASSES_GITLAB_TOKEN');
  if (gitlab) {
    const domain = hostSetting(env, 'GITGLASSES_GITLAB_HOST', 'gitlab.com')!;
    add(domain, 'gitlab', domain, { token: gitlab });
  }

  const bitbucket = setting(env, 'GITGLASSES_BITBUCKET_TOKEN');
  if (bitbucket) {
    const username = setting(env, 'GITGLASSES_BITBUCKET_USERNAME');
    add('bitbucket.org', 'bitbucket', 'bitbucket.org', { token: bitbucket, username });
  }

  const dataCenter = setting(env, 'GITGLASSES_BITBUCKET_DC_TOKEN');
  if (dataCenter) {
    const domain = hostSetting(env, 'GITGLASSES_BITBUCKET_DC_HOST');
    if (!domain) {
      throw new Error('GITGLASSES_BITBUCKET_DC_TOKEN needs GITGLASSES_BITBUCKET_DC_HOST');
    }
    add(domain, 'bitbucketDC', domain, { token: dataCenter });
  }

  const azure = setting(env, 'GITGLASSES_AZURE_DEVOPS_TOKEN');
  if (azure) {
    const organization = setting(env, 'GITGLASSES_AZURE_DEVOPS_ORG');
    if (!organization) {
      throw new Error('GITGLASSES_AZURE_DEVOPS_TOKEN needs GITGLASSES_AZURE_DEVOPS_ORG');
    }
    add(
      `dev.azure.com/${organization}`,
      'azuredevops',
      'dev.azure.com',
      { token: azure },
      organization,
    );
  }
  return hosts;
}

/** One host's answer: its pull requests in launchpad buckets, or why not. */
export type HostResult =
  { label: string; groups: LaunchpadGroup[] } | { label: string; error: string };

/**
 * Asks every host at once. A host that fails is reported in its place, so one
 * expired token does not hide the others.
 */
export async function fetchMyPullRequests(hosts: readonly ConfiguredHost[]): Promise<HostResult[]> {
  return Promise.all(
    hosts.map(async ({ label, provider, auth }): Promise<HostResult> => {
      try {
        const prs = await provider.getMyPullRequests(auth);
        const viewer = prs.find((pr) => pr.viewerRole === 'author')?.author.username ?? '';
        return { label, groups: groupItems(prs, viewer) };
      } catch (error) {
        return { label, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/**
 * The answers as text: one host's launchpad as it is, several under their
 * host names, with a failed host saying why in its place.
 */
export function formatHostResults(results: readonly HostResult[]): string {
  if (results.length === 1 && 'groups' in results[0]) return formatLaunchpad(results[0].groups);
  return results
    .map((result) =>
      'error' in result
        ? `${result.label}: failed: ${result.error}`
        : `${result.label}:\n${formatLaunchpad(result.groups, '  ')}`,
    )
    .join('\n\n');
}
