import { describe, expect, it } from 'vitest';
import { createDefaultProviders } from '../src/defaults.js';
import { DEFAULT_HOSTS, ProviderRegistry } from '../src/remoteMatcher.js';
import { jsonResponse, stubFetch } from './helpers.js';

describe('createDefaultProviders', () => {
  it('returns zero-config providers keyed by id, matching DEFAULT_HOSTS ids', () => {
    const providers = createDefaultProviders();
    expect([...providers.keys()].sort()).toEqual(['bitbucket', 'github', 'gitlab']);
    for (const [id, provider] of providers) {
      expect(provider.id).toBe(id);
      expect([...DEFAULT_HOSTS.values()]).toContain(id);
    }
  });

  it('passes the injected fetchFn through to the providers', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ data: { viewer: { login: 'alice' }, search: { nodes: [] } } })
    );
    const providers = createDefaultProviders(fetchFn);
    await providers.get('github')?.getMyPullRequests({ token: 't' });
    expect(requests).toHaveLength(1);
  });

  it('registers cleanly into a ProviderRegistry and resolves public-host remotes', () => {
    const registry = new ProviderRegistry();
    for (const provider of createDefaultProviders().values()) {
      registry.register(provider);
    }
    const resolved = registry.resolveRemote('git@gitlab.com:acme/widgets.git');
    expect(resolved?.providerId).toBe('gitlab');
    expect(resolved?.provider?.id).toBe('gitlab');
    expect(registry.resolveRemote('git@bitbucket.org:acme/widgets.git')?.provider?.id).toBe(
      'bitbucket'
    );
  });
});
