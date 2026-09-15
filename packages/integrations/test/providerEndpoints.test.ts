// Every provider interpolates configuration into the base URL it then sends a
// credential to. These tests pin what each constructor accepts and assert the
// URL the token actually reaches.

import { describe, expect, it } from 'vitest';
import { AzureDevOpsProvider } from '../src/providers/azuredevops.js';
import { BitbucketDCProvider } from '../src/providers/bitbucketDC.js';
import { createGitHubEnterpriseProvider, GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { JiraProvider } from '../src/providers/jira.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'test-token', username: 'alice@example.com' };

const REDIRECTING_HOSTS = [
  'api.github.com@attacker.example',
  'https://attacker.example',
  'corp.example/../attacker.example',
  'corp.example/path',
  'has space',
  '',
];

describe('GitHub host validation', () => {
  for (const host of REDIRECTING_HOSTS) {
    it(`createGitHubEnterpriseProvider rejects ${JSON.stringify(host)}`, () => {
      expect(() => createGitHubEnterpriseProvider(host)).toThrow(/plain hostname/);
    });

    it(`GitHubProvider rejects host ${JSON.stringify(host)}`, () => {
      expect(() => new GitHubProvider({ host })).toThrow(/plain hostname/);
    });
  }

  it('sends the token only to the configured enterprise host', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ data: { search: { nodes: [] } } })
    );
    const provider = createGitHubEnterpriseProvider('github.corp.example', fetchFn);
    await provider.getMyPullRequests(auth);
    expect(requests.map((r) => new URL(r.url).host)).toEqual(['github.corp.example']);
  });

  it('accepts a hostname with a port', () => {
    expect(new GitHubProvider({ host: 'github.corp.example:8443' }).host).toBe(
      'github.corp.example:8443'
    );
  });
});

describe('Azure DevOps organization and base URL validation', () => {
  for (const organization of REDIRECTING_HOSTS) {
    it(`rejects organization ${JSON.stringify(organization)}`, () => {
      expect(() => new AzureDevOpsProvider({ organization })).toThrow(/plain hostname/);
    });
  }

  it('rejects a plaintext base URL', () => {
    expect(
      () => new AzureDevOpsProvider({ organization: 'contoso', baseUrl: 'http://ado.corp.example' })
    ).toThrow(/must use https/);
  });

  it('allows http on loopback', () => {
    expect(
      () => new AzureDevOpsProvider({ organization: 'contoso', baseUrl: 'http://localhost:8080' })
    ).not.toThrow();
  });

  it('keeps the organization in the first path segment', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ authenticatedUser: { id: 'u' } }));
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    await provider.getMyPullRequests(auth).catch(() => undefined);
    expect(requests[0].url.startsWith('https://dev.azure.com/contoso/')).toBe(true);
  });
});

describe('Bitbucket Data Center base URL validation', () => {
  it('rejects a plaintext base URL', () => {
    expect(() => new BitbucketDCProvider({ baseUrl: 'http://git.corp.example' })).toThrow(
      /must use https/
    );
  });

  it('allows https and http on loopback', () => {
    expect(() => new BitbucketDCProvider({ baseUrl: 'https://git.corp.example' })).not.toThrow();
    expect(() => new BitbucketDCProvider({ baseUrl: 'http://127.0.0.1:7990' })).not.toThrow();
  });
});

describe('Jira base URL validation', () => {
  it('rejects a plaintext base URL, which basic auth would send a reversible credential to', () => {
    expect(() => new JiraProvider({ baseUrl: 'http://jira.corp.example' })).toThrow(
      /must use https/
    );
  });

  it('allows https and http on loopback', () => {
    expect(() => new JiraProvider({ baseUrl: 'https://jira.corp.example' })).not.toThrow();
    expect(() => new JiraProvider({ baseUrl: 'http://localhost:2990/jira' })).not.toThrow();
  });

  it('sends basic auth only to the configured site', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ issues: [] }));
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    await provider.getMyIssues(auth);
    expect(requests.map((r) => new URL(r.url).origin)).toEqual([
      'https://acme.atlassian.net',
    ]);
    expect(requests[0].init?.headers?.authorization).toMatch(/^Basic /);
  });
});

describe('GitLab base URL validation', () => {
  it('rejects a plaintext base URL', () => {
    expect(() => new GitLabProvider({ baseUrl: 'http://git.corp.example' })).toThrow(
      /must use https/
    );
  });

  it('allows http on loopback', () => {
    expect(() => new GitLabProvider({ baseUrl: 'http://localhost:8929' })).not.toThrow();
  });
});
