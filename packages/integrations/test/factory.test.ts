// Settings name a provider id and a host; the factory turns that pair into a
// provider whose every request goes to that host. Each case below drives a
// real call through a stub transport and checks where the token went.

import { describe, expect, it } from 'vitest';
import {
  createHostingProvider,
  createIssueProvider,
  DEFAULT_HOSTING_HOSTS,
  HOSTING_PROVIDER_IDS,
  IntegrationConfigError,
  ISSUE_PROVIDER_IDS,
} from '../src/factory.js';
import type { HttpRequestInit } from '../src/http.js';
import { jsonResponse, stubFetch } from './helpers.js';

/** Canned answers good enough for each provider's "my items" call. */
function anyProviderFetch() {
  return stubFetch((url: string, _init?: HttpRequestInit) => {
    if (url.includes('graphql')) {
      return jsonResponse({
        data: {
          viewer: { login: 'alice', assignedIssues: { nodes: [] } },
          search: { nodes: [] },
        },
      });
    }
    if (url.endsWith('/user')) {
      return jsonResponse({ id: 1, username: 'alice', uuid: '{u-1}' });
    }
    if (url.includes('connectionData')) {
      return jsonResponse({ authenticatedUser: { id: 'me' } });
    }
    if (url.includes('/search/jql')) {
      return jsonResponse({ issues: [] });
    }
    if (url.includes('/issues?') || url.includes('/merge_requests?')) {
      return jsonResponse([]);
    }
    return jsonResponse({ values: [], value: [] });
  });
}

/** Hosts a request with an Authorization header went to. */
function credentialedHosts(requests: Array<{ url: string; init?: HttpRequestInit }>): string[] {
  return [
    ...new Set(
      requests.filter((r) => r.init?.headers?.authorization).map((r) => new URL(r.url).host)
    ),
  ];
}

const HOSTING_CASES = [
  { providerId: 'github', domain: 'github.com', expected: ['api.github.com'] },
  { providerId: 'github', domain: 'ghe.corp.example', expected: ['ghe.corp.example'] },
  { providerId: 'github-enterprise', domain: 'ghe.corp.example', expected: ['ghe.corp.example'] },
  { providerId: 'gitlab', domain: 'gitlab.com', expected: ['gitlab.com'] },
  { providerId: 'gitlab', domain: 'gitlab.corp.example', expected: ['gitlab.corp.example'] },
  { providerId: 'bitbucket', domain: 'bitbucket.org', expected: ['api.bitbucket.org'] },
  {
    providerId: 'bitbucketDC',
    domain: 'bitbucket.corp.example',
    expected: ['bitbucket.corp.example'],
  },
  {
    providerId: 'azuredevops',
    domain: 'dev.azure.com',
    organization: 'contoso',
    expected: ['dev.azure.com'],
  },
];

describe('createHostingProvider', () => {
  for (const { providerId, domain, organization, expected } of HOSTING_CASES) {
    it(`${providerId} on ${domain} sends its token only to ${expected.join(', ')}`, async () => {
      const { fetchFn, requests } = anyProviderFetch();
      const provider = createHostingProvider({ providerId, domain, organization, fetchFn });
      expect(provider.id).toBe(providerId);
      await provider.getMyPullRequests({ token: 'secret', host: domain }, { limit: 5 });
      expect(requests.length).toBeGreaterThan(0);
      expect(credentialedHosts(requests)).toEqual(expected);
    });
  }

  it('covers every hosting provider id', () => {
    expect(new Set(HOSTING_CASES.map((c) => c.providerId))).toEqual(new Set(HOSTING_PROVIDER_IDS));
  });

  it('serves each default public host with the provider registered for it', () => {
    for (const { providerId, domain } of DEFAULT_HOSTING_HOSTS) {
      const provider = createHostingProvider({ providerId, domain });
      expect(provider.matchesRemote(`https://${domain}/acme/widgets.git`)?.host).toBe(domain);
    }
  });

  it('matches remotes on the configured host', () => {
    const provider = createHostingProvider({ providerId: 'gitlab', domain: 'gitlab.corp.example' });
    expect(provider.matchesRemote('git@gitlab.corp.example:team/tool.git')).toEqual({
      provider: 'gitlab',
      host: 'gitlab.corp.example',
      owner: 'team',
      name: 'tool',
    });
    expect(provider.matchesRemote('git@gitlab.com:team/tool.git')).toBeUndefined();
  });

  it.each([
    [{ providerId: 'bitbucket', domain: 'bitbucket.corp.example' }, /only serves bitbucket\.org/],
    [{ providerId: 'bitbucketDC', domain: 'bitbucket.org' }, /Bitbucket Cloud/],
    [{ providerId: 'github-enterprise', domain: 'github.com' }, /not GitHub Enterprise/],
    [{ providerId: 'azuredevops', domain: 'dev.azure.com' }, /needs the organization/],
    [
      { providerId: 'azuredevops', domain: 'ado.corp.example', organization: 'c' },
      /not supported yet/,
    ],
    [{ providerId: 'gitlab', domain: 'gitlab.com@evil.example' }, /plain hostname/],
    [{ providerId: 'gitlab', domain: undefined as unknown as string }, /plain hostname/],
    [{ providerId: 'gitea', domain: 'git.corp.example' }, /Unknown hosting provider/],
  ])('rejects %j', (config, message) => {
    expect(() => createHostingProvider(config)).toThrow(IntegrationConfigError);
    expect(() => createHostingProvider(config)).toThrow(message);
  });
});

const ISSUE_CASES = [
  { providerId: 'jira', host: 'acme.atlassian.net', expected: ['acme.atlassian.net'] },
  { providerId: 'linear', host: undefined, expected: ['api.linear.app'] },
];

describe('createIssueProvider', () => {
  for (const { providerId, host, expected } of ISSUE_CASES) {
    it(`${providerId} sends its token only to ${expected.join(', ')}`, async () => {
      const { fetchFn, requests } = anyProviderFetch();
      const provider = createIssueProvider({ providerId, host, fetchFn });
      expect(provider.id).toBe(providerId);
      await provider.getMyIssues({ token: 'secret', username: 'alice@example.com', host }, {});
      expect(requests.length).toBeGreaterThan(0);
      expect(credentialedHosts(requests)).toEqual(expected);
    });
  }

  it('covers every issue provider id', () => {
    expect(new Set(ISSUE_CASES.map((c) => c.providerId))).toEqual(new Set(ISSUE_PROVIDER_IDS));
  });

  it.each([
    [{ providerId: 'jira' }, /plain hostname/],
    [{ providerId: 'jira', host: 'jira.corp.example' }, /not supported yet/],
    [{ providerId: 'linear', host: 'linear.corp.example' }, /only served from linear\.app/],
    [{ providerId: 'youtrack', host: 'x.example' }, /Unknown issue provider/],
  ])('rejects %j', (config, message) => {
    expect(() => createIssueProvider(config)).toThrow(IntegrationConfigError);
    expect(() => createIssueProvider(config)).toThrow(message);
  });
});
