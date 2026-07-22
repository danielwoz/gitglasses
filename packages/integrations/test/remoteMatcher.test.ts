import { describe, expect, it } from 'vitest';
import type { HostingProvider } from '../src/hostingProvider.js';
import { parseRemoteUrl, ProviderRegistry } from '../src/remoteMatcher.js';

describe('parseRemoteUrl', () => {
  it('parses https URLs with .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('parses https URLs without .git and with trailing slash', () => {
    expect(parseRemoteUrl('https://gitlab.com/acme/widgets/')).toEqual({
      host: 'gitlab.com',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('parses scp-like ssh remotes', () => {
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('parses ssh:// remotes', () => {
    expect(parseRemoteUrl('ssh://git@bitbucket.org/acme/widgets.git')).toEqual({
      host: 'bitbucket.org',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('parses ssh:// remotes with a port', () => {
    expect(parseRemoteUrl('ssh://git@git.corp.example:2222/team/tool.git')).toEqual({
      host: 'git.corp.example',
      owner: 'team',
      name: 'tool',
    });
  });

  it('parses https remotes with a port on self-hosted instances', () => {
    expect(parseRemoteUrl('https://git.corp.example:8443/team/tool.git')).toEqual({
      host: 'git.corp.example',
      owner: 'team',
      name: 'tool',
    });
  });

  it('parses nested-group paths keeping the last segment as the repo name', () => {
    expect(parseRemoteUrl('https://gitlab.com/group/subgroup/tool.git')).toEqual({
      host: 'gitlab.com',
      owner: 'group/subgroup',
      name: 'tool',
    });
  });

  it('parses Azure DevOps https remotes with owner org/project', () => {
    expect(parseRemoteUrl('https://dev.azure.com/contoso/webapp/_git/frontend')).toEqual({
      host: 'dev.azure.com',
      owner: 'contoso/webapp',
      name: 'frontend',
    });
  });

  it('parses Azure DevOps https remotes with a user prefix', () => {
    expect(parseRemoteUrl('https://contoso@dev.azure.com/contoso/webapp/_git/frontend')).toEqual({
      host: 'dev.azure.com',
      owner: 'contoso/webapp',
      name: 'frontend',
    });
  });

  it('parses Azure DevOps ssh remotes and normalizes the host', () => {
    expect(parseRemoteUrl('contoso@vs-ssh.visualstudio.com:v3/contoso/webapp/frontend')).toEqual({
      host: 'dev.azure.com',
      owner: 'contoso/webapp',
      name: 'frontend',
    });
  });

  it('returns undefined for non-remote strings', () => {
    expect(parseRemoteUrl('not a url')).toBeUndefined();
    expect(parseRemoteUrl('')).toBeUndefined();
    expect(parseRemoteUrl('https://github.com/only-owner')).toBeUndefined();
  });
});

function stubProvider(id: string): HostingProvider {
  return {
    id,
    capabilities: new Set(),
    matchesRemote: () => undefined,
    getMyPullRequests: async () => [],
    getPullRequestForBranch: async () => undefined,
    getIssueOrPr: async () => undefined,
  };
}

describe('ProviderRegistry', () => {
  it('maps well-known hosts to default provider ids', () => {
    const registry = new ProviderRegistry();
    expect(registry.providerIdForHost('github.com')).toBe('github');
    expect(registry.providerIdForHost('gitlab.com')).toBe('gitlab');
    expect(registry.providerIdForHost('bitbucket.org')).toBe('bitbucket');
    expect(registry.providerIdForHost('dev.azure.com')).toBe('azuredevops');
  });

  it('resolves a remote to a registered provider and repo descriptor', () => {
    const registry = new ProviderRegistry();
    const github = stubProvider('github');
    registry.register(github);
    const resolved = registry.resolveRemote('git@github.com:acme/widgets.git');
    expect(resolved?.provider).toBe(github);
    expect(resolved?.repo).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('supports user-declared self-hosted domains', () => {
    const registry = new ProviderRegistry();
    registry.register(stubProvider('github-enterprise'));
    registry.configureHosts([{ domain: 'GitHub.Corp.Example', providerId: 'github-enterprise' }]);
    const resolved = registry.resolveRemote('https://github.corp.example/team/tool.git');
    expect(resolved?.providerId).toBe('github-enterprise');
    expect(resolved?.repo.host).toBe('github.corp.example');
  });

  it('returns undefined for unknown hosts', () => {
    const registry = new ProviderRegistry();
    expect(registry.resolveRemote('https://example.com/a/b.git')).toBeUndefined();
  });
});
