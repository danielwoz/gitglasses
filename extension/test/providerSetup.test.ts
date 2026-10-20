// IntegrationService builds every provider through buildHostingEntries and
// buildIssueEntries. These tests drive what they build with a stub
// transport and check that each credential reaches the host it belongs to.

import { describe, expect, it } from 'vitest';
import {
  CredentialScopeError,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponseLike,
} from '@gitglasses/integrations';
import {
  HOSTING_PROVIDER_CHOICES,
  ISSUE_PROVIDER_CHOICES,
} from '../src/integrations/integrationSettings';
import {
  buildHostingEntries,
  buildIssueEntries,
  detectHosts,
  guessProviderFromHostname,
  issueCredentialHost,
  toAuthContext,
} from '../src/integrations/providerSetup';

function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A transport answering every provider's "my items" call, recording requests. */
type Recorded = Array<{ url: string; init?: HttpRequestInit }>;

function recordingFetch(): { fetchFn: FetchLike; requests: Recorded } {
  const requests: Recorded = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('graphql')) {
      return jsonResponse({
        data: { viewer: { login: 'a', assignedIssues: { nodes: [] } }, search: { nodes: [] } },
      });
    }
    if (url.endsWith('/user')) return jsonResponse({ id: 1, username: 'a', uuid: '{u}' });
    if (url.includes('connectionData')) return jsonResponse({ authenticatedUser: { id: 'me' } });
    if (url.includes('/search/jql')) return jsonResponse({ issues: [] });
    if (url.includes('/issues?') || url.includes('/merge_requests?')) return jsonResponse([]);
    return jsonResponse({ values: [], value: [] });
  };
  return { fetchFn, requests };
}

/** Hosts that received an Authorization header. */
function credentialedHosts(requests: Recorded): string[] {
  return [
    ...new Set(
      requests.filter((r) => r.init?.headers?.authorization).map((r) => new URL(r.url).host),
    ),
  ];
}

const credential = { token: 'SECRET', username: 'alice@example.com' };

describe('hosting integrations', () => {
  // Every choice the connect flow offers, configured the way it writes it.
  for (const choice of HOSTING_PROVIDER_CHOICES) {
    const domain = choice.defaultHost ?? `${choice.id.toLowerCase()}.corp.example`;
    it(`${choice.label} on ${domain} sends its token to ${domain} only`, async () => {
      const { fetchFn, requests } = recordingFetch();
      const setting = {
        domain,
        provider: choice.id,
        ...(choice.needsOrganization ? { organization: 'contoso' } : {}),
      };
      const { entries, problems } = buildHostingEntries([setting], fetchFn);
      expect(problems).toEqual([]);
      const entry = entries.get(domain);
      expect(entry?.providerId).toBe(choice.id);
      await entry?.provider.getMyPullRequests(toAuthContext(credential, domain), { limit: 1 });
      expect(requests.length).toBeGreaterThan(0);
      expect(credentialedHosts(requests)).toEqual([
        domain === 'github.com' || domain === 'bitbucket.org' ? `api.${domain}` : domain,
      ]);
    });
  }

  it('sends a self-managed GitLab token to that instance, never gitlab.com', async () => {
    const { fetchFn, requests } = recordingFetch();
    const { entries } = buildHostingEntries(
      [{ domain: 'gitlab.corp.example', provider: 'gitlab' }],
      fetchFn,
    );
    const entry = entries.get('gitlab.corp.example');
    await entry?.provider.getMyPullRequests(toAuthContext(credential, entry.host));
    expect(credentialedHosts(requests)).toEqual(['gitlab.corp.example']);
  });

  it('treats "github" on a custom domain as that GitHub Enterprise Server', async () => {
    const { fetchFn, requests } = recordingFetch();
    const { entries } = buildHostingEntries([{ domain: 'ghe.corp', provider: 'github' }], fetchFn);
    const entry = entries.get('ghe.corp');
    expect(entry?.providerId).toBe('github');
    await entry?.provider.getMyPullRequests(toAuthContext(credential, entry.host));
    expect(requests.map((r) => r.url)).toEqual(['https://ghe.corp/api/graphql']);
  });

  it('serves gitlab.com and bitbucket.org with no settings at all', () => {
    const { entries } = buildHostingEntries([]);
    expect([...entries.keys()].sort()).toEqual(['bitbucket.org', 'github.com', 'gitlab.com']);
    const gitlab = entries.get('gitlab.com')?.provider;
    expect(gitlab?.matchesRemote('git@gitlab.com:a/b.git')).toBeTruthy();
    expect(entries.get('bitbucket.org')?.providerId).toBe('bitbucket');
  });

  it('refuses to send a credential stored for another host', async () => {
    const { fetchFn, requests } = recordingFetch();
    const { entries } = buildHostingEntries([], fetchFn);
    const gitlab = entries.get('gitlab.com');
    const error = await gitlab?.provider
      .getMyPullRequests(toAuthContext(credential, 'gitlab.corp.example'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialScopeError);
    expect(requests).toEqual([]);
  });

  it('leaves out and reports entries no provider can serve', () => {
    const { entries, problems } = buildHostingEntries([
      { domain: 'git.corp.example', provider: 'bitbucket' },
      { domain: 'dev.azure.com', provider: 'azuredevops' },
      { domain: 'gitlab.com', provider: 'nonsense' },
      { provider: 'gitlab' },
    ]);
    expect(entries.has('git.corp.example')).toBe(false);
    expect(entries.has('dev.azure.com')).toBe(false);
    // A bad entry for a public host keeps the built-in provider for it.
    expect(entries.get('gitlab.com')?.providerId).toBe('gitlab');
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/only serves bitbucket\.org/);
    expect(problems[1]).toMatch(/organization/);
  });

  it('matches a Bitbucket Data Center remote under the settings id', () => {
    const { entries } = buildHostingEntries([
      { domain: 'bitbucket.corp.example', provider: 'bitbucketDC' },
    ]);
    const repo = entries
      .get('bitbucket.corp.example')
      ?.provider.matchesRemote('https://bitbucket.corp.example/scm/acme/widgets.git');
    expect(repo).toEqual({
      provider: 'bitbucketDC',
      host: 'bitbucket.corp.example',
      owner: 'acme',
      name: 'widgets',
    });
  });
});

describe('issue integrations', () => {
  const HOSTS: Record<string, string | undefined> = {
    jira: 'acme.atlassian.net',
    linear: undefined,
    github: undefined,
  };
  const EXPECTED: Record<string, string> = {
    jira: 'acme.atlassian.net',
    linear: 'api.linear.app',
    github: 'api.github.com',
  };

  for (const choice of ISSUE_PROVIDER_CHOICES) {
    it(`${choice.label} sends its token to ${EXPECTED[choice.id]} only`, async () => {
      const { fetchFn, requests } = recordingFetch();
      const { entries, problems } = buildIssueEntries(
        [{ provider: choice.id, host: HOSTS[choice.id] }],
        fetchFn,
      );
      expect(problems).toEqual([]);
      const entry = entries[0];
      const host = issueCredentialHost(entry);
      await entry.provider.getMyIssues(toAuthContext(credential, host), { limit: 1 });
      expect(credentialedHosts(requests)).toEqual([EXPECTED[choice.id]]);
    });
  }

  it('gives Jira the account email its basic auth needs', async () => {
    const { fetchFn, requests } = recordingFetch();
    const { entries } = buildIssueEntries(
      [{ provider: 'jira', host: 'acme.atlassian.net' }],
      fetchFn,
    );
    await entries[0].provider.getMyIssues(toAuthContext(credential, 'acme.atlassian.net'));
    expect(requests[0].init?.headers?.authorization).toBe(
      `Basic ${Buffer.from('alice@example.com:SECRET').toString('base64')}`,
    );
  });

  it('reports Jira Server and unknown trackers instead of building them', () => {
    const { entries, problems } = buildIssueEntries([
      { provider: 'jira', host: 'jira.corp.example' },
      { provider: 'youtrack' },
    ]);
    expect(entries).toEqual([]);
    expect(problems[0]).toMatch(/not supported yet/);
    expect(problems[1]).toMatch(/Unknown issue provider/);
  });

  it('stores GitHub Issues under the github.com sign-in', () => {
    expect(issueCredentialHost({ providerId: 'github' })).toBe('github.com');
    expect(issueCredentialHost({ providerId: 'linear' })).toBe('');
    expect(issueCredentialHost({ providerId: 'jira', host: 'acme.atlassian.net' })).toBe(
      'acme.atlassian.net',
    );
  });
});

describe('toAuthContext', () => {
  it('names the host the credential is stored under', () => {
    expect(toAuthContext({ token: 't', username: 'u' }, 'gitlab.corp.example')).toEqual({
      token: 't',
      username: 'u',
      host: 'gitlab.corp.example',
    });
    expect(toAuthContext({ token: 't' }, '')).toEqual({ token: 't' });
  });
});

describe('detectHosts', () => {
  const configured = new Map([['git.corp.example', 'gitlab']]);

  it('names the provider for public, configured and Azure DevOps hosts', () => {
    const found = detectHosts(
      [
        { name: 'origin', url: 'git@gitlab.com:acme/widgets.git' },
        { name: 'corp', url: 'https://git.corp.example/team/tool.git' },
        { name: 'ado', url: 'https://contoso@dev.azure.com/contoso/Web/_git/widgets' },
        { name: 'mirror', url: 'git@gitlab.com:acme/other.git' },
      ],
      configured,
    );
    expect(found).toEqual([
      { providerId: 'gitlab', domain: 'gitlab.com', organization: undefined, remote: 'origin' },
      { providerId: 'gitlab', domain: 'git.corp.example', organization: undefined, remote: 'corp' },
      {
        providerId: 'azuredevops',
        domain: 'dev.azure.com',
        organization: 'contoso',
        remote: 'ado',
      },
    ]);
  });

  it('guesses a self-hosted server from its hostname', () => {
    const found = detectHosts(
      [
        { name: 'origin', url: 'git@gitlab.example.org:a/b.git' },
        { name: 'other', url: 'https://code.example.org/a/b.git' },
      ],
      new Map(),
    );
    expect(found.map((f) => f.providerId)).toEqual(['gitlab', undefined]);
  });

  it('reads the hostname hint', () => {
    expect(guessProviderFromHostname('github.corp.example')).toBe('github-enterprise');
    expect(guessProviderFromHostname('ghe.example.com')).toBe('github-enterprise');
    expect(guessProviderFromHostname('bitbucket.corp.example')).toBe('bitbucketDC');
    expect(guessProviderFromHostname('stash.example.com')).toBe('bitbucketDC');
    expect(guessProviderFromHostname('gitlab-ce.example.com')).toBe('gitlab');
    expect(guessProviderFromHostname('code.example.com')).toBeUndefined();
  });
});
