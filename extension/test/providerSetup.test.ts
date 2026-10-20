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
  buildHostingEntries,
  buildIssueEntries,
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

const HOSTING_SETTINGS = [
  { domain: 'github.com', provider: 'github' },
  { domain: 'ghe.corp.example', provider: 'github-enterprise' },
  { domain: 'gitlab.com', provider: 'gitlab' },
  { domain: 'gitlab.corp.example', provider: 'gitlab' },
  { domain: 'bitbucket.org', provider: 'bitbucket' },
  { domain: 'bitbucket.corp.example', provider: 'bitbucketDC' },
  { domain: 'dev.azure.com', provider: 'azuredevops', organization: 'contoso' },
];

describe('hosting integrations', () => {
  for (const setting of HOSTING_SETTINGS) {
    const { domain } = setting;
    it(`${setting.provider} on ${domain} sends its token to ${domain} only`, async () => {
      const { fetchFn, requests } = recordingFetch();
      const { entries, problems } = buildHostingEntries([setting], fetchFn);
      expect(problems).toEqual([]);
      const entry = entries.get(domain);
      expect(entry?.providerId).toBe(setting.provider);
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

  it('refuses to send a credential stored for another host', async () => {
    const { fetchFn, requests } = recordingFetch();
    const { entries } = buildHostingEntries(
      [{ domain: 'gitlab.com', provider: 'gitlab' }],
      fetchFn,
    );
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
      { domain: 'github.com', provider: 'nonsense' },
      { provider: 'gitlab' },
    ]);
    expect(entries.has('git.corp.example')).toBe(false);
    expect(entries.has('dev.azure.com')).toBe(false);
    // A bad entry for a public host keeps the built-in provider for it.
    expect(entries.get('github.com')?.providerId).toBe('github');
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
  const ISSUE_SETTINGS = [
    { setting: { provider: 'jira', host: 'acme.atlassian.net' }, expected: 'acme.atlassian.net' },
    { setting: { provider: 'linear' }, expected: 'api.linear.app' },
  ];

  for (const { setting, expected } of ISSUE_SETTINGS) {
    it(`${setting.provider} sends its token to ${expected} only`, async () => {
      const { fetchFn, requests } = recordingFetch();
      const { entries, problems } = buildIssueEntries([setting], fetchFn);
      expect(problems).toEqual([]);
      const entry = entries[0];
      await entry.provider.getMyIssues(toAuthContext(credential, entry.host), { limit: 1 });
      expect(credentialedHosts(requests)).toEqual([expected]);
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
