// A credential may only travel to the host it was issued for. These tests pin
// both halves of that: providers built for one host never point at another,
// and the shared transport refuses a request that would carry a credential
// anywhere else, before anything is sent.

import { describe, expect, it } from 'vitest';
import { CredentialScopeError } from '../src/errors.js';
import { AzureDevOpsProvider } from '../src/providers/azuredevops.js';
import { BitbucketProvider } from '../src/providers/bitbucket.js';
import { BitbucketDCProvider } from '../src/providers/bitbucketDC.js';
import { p, ProviderClient } from '../src/providers/client.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { JiraProvider } from '../src/providers/jira.js';
import { LinearProvider } from '../src/providers/linear.js';
import { assertPlainHost, credentialAllowsUrl } from '../src/providers/shared.js';
import { jsonResponse, stubFetch } from './helpers.js';

describe('credentialAllowsUrl', () => {
  it('allows the credential host and its api subdomain over https', () => {
    const corp = 'gitlab.corp.example';
    expect(credentialAllowsUrl('https://gitlab.corp.example/api/v4/user', corp)).toBe(true);
    expect(credentialAllowsUrl('https://api.github.com/graphql', 'github.com')).toBe(true);
    expect(credentialAllowsUrl('https://api.bitbucket.org/2.0/user', 'bitbucket.org')).toBe(true);
  });

  it('refuses every other host', () => {
    expect(credentialAllowsUrl('https://gitlab.com/api/v4/user', 'gitlab.corp.example')).toBe(
      false
    );
    expect(credentialAllowsUrl('https://api.github.com/graphql', 'ghe.corp.example')).toBe(false);
    expect(credentialAllowsUrl('https://evil.example/?github.com', 'github.com')).toBe(false);
    expect(credentialAllowsUrl('https://github.com.evil.example/', 'github.com')).toBe(false);
  });

  it('refuses userinfo, plaintext and a different port', () => {
    expect(credentialAllowsUrl('https://github.com@evil.example/', 'github.com')).toBe(false);
    expect(credentialAllowsUrl('http://gitlab.corp.example/', 'gitlab.corp.example')).toBe(false);
    expect(credentialAllowsUrl('https://ghe.example:8443/', 'ghe.example')).toBe(false);
    expect(credentialAllowsUrl('https://ghe.example:8443/', 'ghe.example:8443')).toBe(true);
    expect(credentialAllowsUrl('https://ghe.example/', 'ghe.example:443')).toBe(true);
  });

  it('allows plaintext only on loopback', () => {
    expect(credentialAllowsUrl('http://localhost:8929/api/v4', 'localhost:8929')).toBe(true);
  });
});

describe('assertPlainHost', () => {
  it('rejects a missing value instead of testing the string "undefined"', () => {
    expect(() => assertPlainHost(undefined as unknown as string, 'Host')).toThrow(/plain hostname/);
  });
});

describe('ProviderClient credential guard', () => {
  function client(fetchFn = stubFetch(() => jsonResponse({})).fetchFn) {
    return new ProviderClient({
      name: 'Test',
      baseUrl: 'https://git.corp.example',
      baseUrlLabel: 'Test baseUrl',
      credentialHost: 'git.corp.example',
      authorize: (auth) => `Bearer ${auth.token}`,
      fetchFn,
    });
  }

  it('sends a credential issued for its own host', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ ok: true }));
    await client(fetchFn).getJson({ token: 't', host: 'git.corp.example' }, p`/thing`);
    expect(requests).toHaveLength(1);
  });

  it('refuses a credential issued for another host and sends nothing', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({}));
    const error = await client(fetchFn)
      .getJson({ token: 'secret', host: 'gitlab.com' }, p`/thing`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialScopeError);
    expect(requests).toHaveLength(0);
  });

  it('refuses at construction an endpoint off the credential host', () => {
    expect(
      () =>
        new ProviderClient({
          name: 'Test',
          baseUrl: 'https://gitlab.com',
          baseUrlLabel: 'Test baseUrl',
          credentialHost: 'gitlab.corp.example',
          authorize: (auth) => auth.token,
          fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
        })
    ).toThrow(/not on gitlab\.corp\.example/);
  });
});

describe('providers never send a credential off its host', () => {
  it('a gitlab.com provider refuses a self-managed instance token', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ username: 'alice' }));
    const provider = new GitLabProvider({ fetchFn });
    const error = await provider
      .getMyPullRequests({ token: 'CORP-SECRET', host: 'gitlab.corp.example' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialScopeError);
    expect(requests).toHaveLength(0);
  });

  it("GitHub on another host talks to that host's own API", async () => {
    const { fetchFn, requests } = stubFetch((url) =>
      url.endsWith('/graphql')
        ? jsonResponse({ data: { viewer: { login: 'a' }, search: { nodes: [] } } })
        : jsonResponse([])
    );
    const provider = new GitHubProvider({ host: 'ghe.corp.example', fetchFn });
    await provider.getMyPullRequests({ token: 't', host: 'ghe.corp.example' });
    await provider.getIssueOrPr(
      { token: 't', host: 'ghe.corp.example' },
      { provider: 'github', host: 'ghe.corp.example', owner: 'acme', name: 'widgets' },
      '#7'
    );
    await provider.getMyIssues({ token: 't', host: 'ghe.corp.example' });
    expect(requests.map((r) => r.url)).toEqual([
      'https://ghe.corp.example/api/graphql',
      'https://ghe.corp.example/api/v3/repos/acme/widgets/issues/7',
      'https://ghe.corp.example/api/v3/issues?filter=assigned&state=open&sort=updated&per_page=50',
    ]);
  });

  it('GitHub refuses an enterprise host paired with the public API', () => {
    expect(
      () => new GitHubProvider({ host: 'ghe.corp.example', apiBaseUrl: 'https://api.github.com' })
    ).toThrow(/not on ghe\.corp\.example/);
  });

  it('every provider refuses an option it does not read', () => {
    const host = { host: 'git.corp.example' } as never;
    expect(() => new GitLabProvider(host)).toThrow(/does not take a "host" option/);
    expect(() => new BitbucketProvider(host)).toThrow(/does not take a "host" option/);
    expect(() => new LinearProvider(host)).toThrow(/does not take a "host" option/);
    expect(() => new JiraProvider(host)).toThrow(/does not take a "host" option/);
    expect(
      () => new BitbucketDCProvider({ baseUrl: 'https://git.corp.example', host: 'x' } as never)
    ).toThrow(/does not take a "host" option/);
    expect(
      () => new AzureDevOpsProvider({ organization: 'contoso', host: 'x' } as never)
    ).toThrow(/does not take a "host" option/);
    expect(() => new GitHubProvider({ baseUrl: 'https://x' } as never)).toThrow(
      /does not take a "baseUrl" option/
    );
  });

  it('Bitbucket Data Center requires its base URL', () => {
    expect(() => new BitbucketDCProvider({} as never)).toThrow(/requires a baseUrl/);
  });
});
