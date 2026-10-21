// list_my_prs across hosting services: which hosts the environment
// configures, that each token reaches only its own host, and how several
// answers (and failures) are reported together.

import { describe, expect, it } from 'vitest';
import { createToolHandlers } from '../src/server.js';
import { configuredHosts } from '../src/tools/myPrs.js';

const gitlabUser = { id: 1, username: 'alice', name: 'Alice', avatar_url: 'https://a/alice' };
const gitlabMergeRequest = {
  id: 101,
  iid: 5,
  project_id: 77,
  source_project_id: 77,
  target_project_id: 77,
  title: 'Add widgets',
  web_url: 'https://gitlab.example/acme/widgets/-/merge_requests/5',
  state: 'opened',
  draft: false,
  author: gitlabUser,
  assignees: [],
  reviewers: [],
  source_branch: 'feat/widgets',
  target_branch: 'main',
  sha: 'cafe1234',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-02T00:00:00Z',
  merge_status: 'can_be_merged',
  detailed_merge_status: 'mergeable',
  head_pipeline: { status: 'success' },
  references: { full: 'acme/widgets!5' },
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * GitHub answers with no pull requests; GitLab (at `gitlab`) with one merge
 * request, or 401 when `gitlabDown`. Every request is recorded.
 */
function hostingFetch(options: { gitlab: string; gitlabDown?: boolean }) {
  const sent: { host: string; auth?: string }[] = [];
  const fetchFn = async (url: string, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(url);
    sent.push({ host: parsed.host, auth: init?.headers?.authorization });
    if (parsed.host === 'api.github.com') {
      return response(200, { data: { viewer: { pullRequests: { nodes: [] } } } });
    }
    if (parsed.host === options.gitlab) {
      if (options.gitlabDown) return response(401, { message: '401 Unauthorized' });
      if (parsed.pathname === '/api/v4/user') return response(200, gitlabUser);
      if (parsed.searchParams.has('author_username')) return response(200, [gitlabMergeRequest]);
      if (parsed.pathname.endsWith('/approvals')) return response(200, { approved: false });
      return response(200, []);
    }
    return response(404, {});
  };
  return { sent, fetchFn };
}

describe('configuredHosts', () => {
  it('builds one host per token in the environment, each scoped to its host', () => {
    expect(configuredHosts({})).toEqual([]);
    const hosts = configuredHosts({
      GITHUB_TOKEN: 'ghp_x',
      GITLAB_TOKEN: 'glpat_x',
      GITGLASSES_GITLAB_HOST: 'gitlab.example',
      GITGLASSES_BITBUCKET_TOKEN: 'bb_x',
      GITGLASSES_BITBUCKET_USERNAME: 'alice',
      GITGLASSES_BITBUCKET_DC_TOKEN: 'dc_x',
      GITGLASSES_BITBUCKET_DC_HOST: 'bitbucket.corp.example',
      GITGLASSES_AZURE_DEVOPS_TOKEN: 'ado_x',
      GITGLASSES_AZURE_DEVOPS_ORG: 'acme',
    });
    expect(hosts.map((host) => [host.label, host.provider.id, host.auth])).toEqual([
      ['github.com', 'github', { token: 'ghp_x', host: 'github.com' }],
      ['gitlab.example', 'gitlab', { token: 'glpat_x', host: 'gitlab.example' }],
      ['bitbucket.org', 'bitbucket', { token: 'bb_x', username: 'alice', host: 'bitbucket.org' }],
      ['bitbucket.corp.example', 'bitbucketDC', { token: 'dc_x', host: 'bitbucket.corp.example' }],
      ['dev.azure.com/acme', 'azuredevops', { token: 'ado_x', host: 'dev.azure.com' }],
    ]);
  });

  it('defaults GitLab to gitlab.com and takes GitHub Enterprise from its host setting', () => {
    const hosts = configuredHosts({
      GITGLASSES_GITHUB_TOKEN: 'ghp_x',
      GITGLASSES_GITHUB_HOST: 'ghe.corp.example',
      GITGLASSES_GITLAB_TOKEN: 'glpat_x',
    });
    expect(hosts.map((host) => host.label)).toEqual(['ghe.corp.example', 'gitlab.com']);
  });

  it('refuses a host setting that is not a plain hostname, or a token without its host', () => {
    expect(() =>
      configuredHosts({ GITLAB_TOKEN: 'x', GITGLASSES_GITLAB_HOST: 'gitlab.com@attacker.example' }),
    ).toThrow(/GITGLASSES_GITLAB_HOST is not a plain hostname/);
    expect(() => configuredHosts({ GITGLASSES_BITBUCKET_DC_TOKEN: 'x' })).toThrow(
      /needs GITGLASSES_BITBUCKET_DC_HOST/,
    );
    expect(() => configuredHosts({ GITGLASSES_AZURE_DEVOPS_TOKEN: 'x' })).toThrow(
      /needs GITGLASSES_AZURE_DEVOPS_ORG/,
    );
  });
});

describe('list_my_prs on several hosts', () => {
  const env = {
    GITHUB_TOKEN: 'ghp_SECRET',
    GITLAB_TOKEN: 'glpat_SECRET',
    GITGLASSES_GITLAB_HOST: 'gitlab.example',
  };

  it('lists each host under its name, and sends each token only to its own host', async () => {
    const { sent, fetchFn } = hostingFetch({ gitlab: 'gitlab.example' });
    const handlers = createToolHandlers({ client: {} as never, env, fetchFn: fetchFn as never });
    const text = await handlers.list_my_prs();
    expect(text.split('\n')).toEqual([
      'github.com:',
      '  No open pull requests involve you',
      '',
      'gitlab.example:',
      '  waiting (1):',
      '    #5 "Add widgets" [acme/widgets] by alice https://gitlab.example/acme/widgets/-/merge_requests/5',
    ]);
    for (const request of sent) {
      expect(request.auth, request.host).toBe(
        request.host === 'api.github.com' ? 'Bearer ghp_SECRET' : 'Bearer glpat_SECRET',
      );
      expect(['api.github.com', 'gitlab.example']).toContain(request.host);
    }
  });

  it('reports a host that failed in its place and still lists the others', async () => {
    const { fetchFn } = hostingFetch({ gitlab: 'gitlab.example', gitlabDown: true });
    const handlers = createToolHandlers({ client: {} as never, env, fetchFn: fetchFn as never });
    const text = await handlers.list_my_prs();
    expect(text).toBe(
      'github.com:\n  No open pull requests involve you\n\n' +
        'gitlab.example: failed: GitLab authentication failed (401): check the token and its scopes',
    );
  });

  it('fails when every host fails', async () => {
    const { fetchFn } = hostingFetch({ gitlab: 'gitlab.example', gitlabDown: true });
    const handlers = createToolHandlers({
      client: {} as never,
      env: { GITLAB_TOKEN: 'glpat_SECRET', GITGLASSES_GITLAB_HOST: 'gitlab.example' },
      fetchFn: fetchFn as never,
    });
    await expect(handlers.list_my_prs()).rejects.toThrow(
      /^GitLab authentication failed \(401\): check the token and its scopes$/,
    );
  });

  it('names the variables to set when no host is configured', async () => {
    const handlers = createToolHandlers({ client: {} as never, env: {} });
    await expect(handlers.list_my_prs()).rejects.toThrow(
      /No hosting service is configured; set GITHUB_TOKEN .*GITLAB_TOKEN .*GITGLASSES_AZURE_DEVOPS_ORG/,
    );
  });
});
