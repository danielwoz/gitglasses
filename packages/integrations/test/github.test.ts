import { describe, expect, it } from 'vitest';
import {
  AuthError,
  CredentialScopeError,
  ProviderError,
  RateLimitError,
} from '../src/errors.js';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../src/http.js';
import type { PullRequest, RepoDescriptor } from '../src/models.js';
import { createGitHubEnterpriseProvider, GitHubProvider } from '../src/providers/github.js';

const auth = { token: 'test-token' };
const repo: RepoDescriptor = {
  provider: 'github',
  host: 'github.com',
  owner: 'acme',
  name: 'widgets',
};

interface RecordedRequest {
  url: string;
  init?: HttpRequestInit;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): HttpResponseLike {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowered.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function stubFetch(
  handler: (url: string, init?: HttpRequestInit) => HttpResponseLike
): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, requests };
}

function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'PR_node1',
    number: 42,
    title: 'Fix the flux capacitor',
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.test/alice' },
    baseRefName: 'main',
    headRefName: 'fix/flux',
    headRefOid: 'deadbeef',
    repository: { name: 'widgets', owner: { login: 'acme' } },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
    ...overrides,
  };
}

function searchResponse(nodes: unknown[], viewerLogin = 'alice'): unknown {
  return { data: { viewer: { login: viewerLogin }, search: { nodes } } };
}

describe('GitHubProvider.getMyPullRequests', () => {
  it('maps GraphQL search nodes to normalized PullRequests', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse(searchResponse([prNode()])));
    const provider = new GitHubProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth);

    expect(requests[0].url).toBe('https://api.github.com/graphql');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body.variables.searchQuery).toBe('is:pr involves:@me state:open');
    expect(requests[0].init?.headers?.authorization).toBe('Bearer test-token');

    expect(prs).toHaveLength(1);
    const pr = prs[0];
    expect(pr.number).toBe(42);
    expect(pr.title).toBe('Fix the flux capacitor');
    expect(pr.state).toBe('open');
    expect(pr.draft).toBe(false);
    expect(pr.author.username).toBe('alice');
    expect(pr.baseRef).toBe('main');
    expect(pr.headRef).toBe('fix/flux');
    expect(pr.headSha).toBe('deadbeef');
    expect(pr.repo).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.checksStatus).toBe('passing');
    expect(pr.mergeable).toBe('mergeable');
  });

  it('derives viewerRole author for own PRs', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse(searchResponse([prNode()], 'alice')));
    const provider = new GitHubProvider({ fetchFn });
    const [pr] = await provider.getMyPullRequests(auth);
    expect(pr.viewerRole).toBe('author');
    expect(pr.reviewRequestedFromViewer).toBe(false);
  });

  it('derives viewerRole reviewer and reviewRequestedFromViewer from review requests', async () => {
    const node = prNode({
      author: { login: 'bob' },
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'alice' } }] },
    });
    const { fetchFn } = stubFetch(() => jsonResponse(searchResponse([node], 'alice')));
    const provider = new GitHubProvider({ fetchFn });
    const [pr] = await provider.getMyPullRequests(auth);
    expect(pr.viewerRole).toBe('reviewer');
    expect(pr.reviewRequestedFromViewer).toBe(true);
  });

  it('derives viewerRole assignee, then mentioned as fallback', async () => {
    const assigned = prNode({
      id: 'PR_a',
      author: { login: 'bob' },
      assignees: { nodes: [{ login: 'alice' }] },
    });
    const mentioned = prNode({ id: 'PR_m', author: { login: 'bob' } });
    const { fetchFn } = stubFetch(() =>
      jsonResponse(searchResponse([assigned, mentioned], 'alice'))
    );
    const provider = new GitHubProvider({ fetchFn });
    const [a, m] = await provider.getMyPullRequests(auth);
    expect(a.viewerRole).toBe('assignee');
    expect(m.viewerRole).toBe('mentioned');
  });

  it('maps failing and pending check rollups and conflicting mergeability', async () => {
    const failing = prNode({
      id: 'PR_f',
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
      mergeable: 'CONFLICTING',
      reviewDecision: 'CHANGES_REQUESTED',
    });
    const pending = prNode({
      id: 'PR_p',
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
      mergeable: 'UNKNOWN',
      reviewDecision: null,
    });
    const noChecks = prNode({
      id: 'PR_n',
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    const { fetchFn } = stubFetch(() =>
      jsonResponse(searchResponse([failing, pending, noChecks]))
    );
    const provider = new GitHubProvider({ fetchFn });
    const [f, p, n] = await provider.getMyPullRequests(auth);
    expect(f.checksStatus).toBe('failing');
    expect(f.mergeable).toBe('conflicts');
    expect(f.reviewDecision).toBe('changes_requested');
    expect(p.checksStatus).toBe('pending');
    expect(p.mergeable).toBe('unknown');
    expect(p.reviewDecision).toBeUndefined();
    expect(n.checksStatus).toBe('none');
  });

  it('maps draft and merged states', async () => {
    const draft = prNode({ id: 'PR_d', isDraft: true });
    const merged = prNode({ id: 'PR_g', state: 'MERGED' });
    const { fetchFn } = stubFetch(() => jsonResponse(searchResponse([draft, merged])));
    const provider = new GitHubProvider({ fetchFn });
    const [d, g] = await provider.getMyPullRequests(auth);
    expect(d.draft).toBe(true);
    expect(g.state).toBe('merged');
  });
});

describe('GitHubProvider.getViewerLogin', () => {
  const host = 'github.corp.example';

  it("reads the token's login from the enterprise host's GET /user", async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ login: 'octo', id: 7 }));
    const provider = createGitHubEnterpriseProvider(host, fetchFn);
    expect(await provider.getViewerLogin({ token: 'ghe-token', host })).toBe('octo');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://github.corp.example/api/v3/user');
    expect(requests[0].init?.method).toBe('GET');
    expect(requests[0].init?.headers?.authorization).toBe('Bearer ghe-token');
  });

  it('asks once per token', async () => {
    const { fetchFn, requests } = stubFetch((_url, init) =>
      jsonResponse({ login: init?.headers?.authorization === 'Bearer a' ? 'ann' : 'bob' })
    );
    const provider = createGitHubEnterpriseProvider(host, fetchFn);
    expect(await provider.getViewerLogin({ token: 'a', host })).toBe('ann');
    expect(await provider.getViewerLogin({ token: 'a', host })).toBe('ann');
    expect(await provider.getViewerLogin({ token: 'b', host })).toBe('bob');
    expect(requests).toHaveLength(2);
  });

  it("refuses another host's credential without sending it", async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ login: 'octo' }));
    const provider = createGitHubEnterpriseProvider(host, fetchFn);
    await expect(
      provider.getViewerLogin({ token: 'dotcom-token', host: 'github.com' })
    ).rejects.toBeInstanceOf(CredentialScopeError);
    expect(requests).toHaveLength(0);
  });

  it('fails on a profile without a login, and on a rate limit', async () => {
    const empty = createGitHubEnterpriseProvider(
      host,
      stubFetch(() => jsonResponse({})).fetchFn
    );
    await expect(empty.getViewerLogin({ token: 't', host })).rejects.toBeInstanceOf(
      ProviderError
    );
    const limited = createGitHubEnterpriseProvider(
      host,
      stubFetch(() =>
        jsonResponse({ message: 'API rate limit exceeded' }, 403, {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1784000000',
        })
      ).fetchFn
    );
    await expect(limited.getViewerLogin({ token: 't', host })).rejects.toBeInstanceOf(
      RateLimitError
    );
  });
});

describe('GitHubProvider.getPullRequestForBranch', () => {
  interface OpenPull {
    number: number;
    /** Owner of the head repository; null once that repository is deleted. */
    headOwner: string | null;
    branch: string;
  }

  /**
   * Answers like api.github.com for acme/widgets: the REST list applies its
   * "owner:branch" head filter on the server, GraphQL's headRefName matches
   * every fork's branch and pages, and a pull request reads back by number.
   */
  function fakeServer(pulls: OpenPull[], changed: Record<string, unknown> = {}) {
    const node = (pull: OpenPull) =>
      prNode({
        number: pull.number,
        headRefName: pull.branch,
        headRepositoryOwner: pull.headOwner === null ? null : { login: pull.headOwner },
        ...changed,
      });
    return stubFetch((url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/repos/acme/widgets/pulls') {
        const [owner, branch] = (parsed.searchParams.get('head') ?? '').split(/:(.*)/);
        return jsonResponse(
          pulls
            .filter((pull) => pull.headOwner?.toLowerCase() === owner.toLowerCase())
            .filter((pull) => pull.branch === branch)
            .map((pull) => ({
              number: pull.number,
              head: {
                ref: pull.branch,
                repo: pull.headOwner === null ? null : { owner: { login: pull.headOwner } },
              },
            }))
        );
      }
      const { variables } = JSON.parse(init?.body ?? '{}');
      if (variables.number !== undefined) {
        const pull = pulls.find((candidate) => candidate.number === variables.number);
        return jsonResponse({
          data: { viewer: { login: 'alice' }, repository: { pullRequest: pull ? node(pull) : null } },
        });
      }
      const nodes = pulls
        .filter((pull) => pull.branch === variables.branch)
        .slice(0, variables.first)
        .map(node);
      return jsonResponse({
        data: { viewer: { login: 'alice' }, repository: { pullRequests: { nodes } } },
      });
    });
  }

  it("asks for the head owner's branch, then reads that pull request", async () => {
    const { fetchFn, requests } = fakeServer([{ number: 42, headOwner: 'acme', branch: 'fix/flux' }]);
    const provider = new GitHubProvider({ fetchFn });
    const pr = await provider.getPullRequestForBranch(auth, repo, 'fix/flux');
    expect(requests[0].url).toBe(
      'https://api.github.com/repos/acme/widgets/pulls?state=open&head=acme%3Afix%2Fflux&per_page=10'
    );
    const body = JSON.parse(requests[1].init?.body ?? '{}');
    expect(body.variables).toEqual({ owner: 'acme', name: 'widgets', number: 42 });
    expect(body.query).toContain('headRepositoryOwner');
    expect(pr?.number).toBe(42);
    expect(pr?.checksStatus).toBe('passing');
  });

  it("never matches a stranger's fork with a same-named branch", async () => {
    // A maintainer on "main" must not get a contributor's "main" back.
    const { fetchFn } = fakeServer([{ number: 7, headOwner: 'mallory', branch: 'main' }]);
    const provider = new GitHubProvider({ fetchFn });
    expect(await provider.getPullRequestForBranch(auth, repo, 'main')).toBeUndefined();
  });

  it("finds the head fork's pull request among many forks' same-named branches", async () => {
    const strangers = Array.from({ length: 60 }, (_, i) => ({
      number: 100 + i,
      headOwner: `contributor${i}`,
      branch: 'main',
    }));
    const { fetchFn } = fakeServer([...strangers, { number: 9, headOwner: 'Alice', branch: 'main' }]);
    const provider = new GitHubProvider({ fetchFn });
    const pr = await provider.getPullRequestForBranch(auth, repo, 'main', {
      owner: 'alice',
      name: 'widgets',
    });
    expect(pr?.number).toBe(9);
  });

  it('ignores a listed pull request whose head is not the one asked for', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse([
        { number: 7, head: { ref: 'main', repo: { owner: { login: 'mallory' } } } },
        { number: 8, head: { ref: 'main', repo: null } },
        { number: 9, head: { ref: 'other', repo: { owner: { login: 'acme' } } } },
      ])
    );
    const provider = new GitHubProvider({ fetchFn });
    expect(await provider.getPullRequestForBranch(auth, repo, 'main')).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('drops a pull request that closed or changed head after it was listed', async () => {
    const pulls = [{ number: 42, headOwner: 'acme', branch: 'fix/flux' }];
    const provider = (changed: Record<string, unknown>) =>
      new GitHubProvider({ fetchFn: fakeServer(pulls, changed).fetchFn });
    expect(await provider({ state: 'CLOSED' }).getPullRequestForBranch(auth, repo, 'fix/flux'))
      .toBeUndefined();
    const moved = { headRepositoryOwner: { login: 'mallory' } };
    expect(await provider(moved).getPullRequestForBranch(auth, repo, 'fix/flux')).toBeUndefined();
  });

  it('returns undefined when no PR matches the branch', async () => {
    const { fetchFn, requests } = fakeServer([]);
    const provider = new GitHubProvider({ fetchFn });
    const pr = await provider.getPullRequestForBranch(auth, repo, 'no-such-branch');
    expect(pr).toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});

describe('GitHubProvider as an issue provider', () => {
  function restIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 7,
      node_id: 'I_7',
      number: 7,
      title: 'Widget crashes on start',
      html_url: 'https://github.com/acme/widgets/issues/7',
      state: 'open',
      assignee: { login: 'alice' },
      updated_at: '2026-07-03T00:00:00Z',
      repository: { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } },
      ...overrides,
    };
  }

  it('lists open issues assigned to the user, leaving out pull requests', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse([restIssue(), restIssue({ number: 8, pull_request: {} })])
    );
    const provider = new GitHubProvider({ fetchFn });
    const issues = await provider.getMyIssues(auth, { limit: 25 });
    expect(requests[0].url).toBe(
      'https://api.github.com/issues?filter=assigned&state=open&sort=updated&per_page=25'
    );
    expect(issues.map((issue) => issue.key)).toEqual(['acme/widgets#7']);
    expect(issues[0].title).toBe('Widget crashes on start');
  });

  it('suggests a "<number>-<slug>" branch name', () => {
    const provider = new GitHubProvider();
    const name = provider.suggestBranchName({
      id: 'I_7',
      key: 'acme/widgets#7',
      title: 'Widget crashes on start',
      url: '',
      state: 'open',
      updatedAt: '',
    });
    expect(name).toBe('7-widget-crashes-on-start');
  });

  it('resolves an owner/name#number key', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse(restIssue()));
    const provider = new GitHubProvider({ fetchFn });
    const issue = await provider.getIssue(auth, 'acme/widgets#7');
    expect(requests[0].url).toBe('https://api.github.com/repos/acme/widgets/issues/7');
    expect(issue?.key).toBe('acme/widgets#7');
  });
});

describe('GitHubProvider.getIssueOrPr', () => {
  it('maps a REST issue payload to a normalized Issue', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({
        id: 7,
        node_id: 'I_7',
        number: 7,
        title: 'Widget crashes',
        html_url: 'https://github.com/acme/widgets/issues/7',
        state: 'open',
        assignee: { login: 'carol', avatar_url: 'https://avatars.test/carol' },
        updated_at: '2026-07-03T00:00:00Z',
      })
    );
    const provider = new GitHubProvider({ fetchFn });
    const issue = await provider.getIssueOrPr(auth, repo, '#7');
    expect(requests[0].url).toBe('https://api.github.com/repos/acme/widgets/issues/7');
    expect(issue).toEqual({
      id: 'I_7',
      key: 'acme/widgets#7',
      title: 'Widget crashes',
      url: 'https://github.com/acme/widgets/issues/7',
      state: 'open',
      assignee: { id: 'carol', username: 'carol', avatarUrl: 'https://avatars.test/carol' },
      updatedAt: '2026-07-03T00:00:00Z',
    });
  });

  it('follows up on the pulls endpoint when the issue is a PR', async () => {
    const { fetchFn, requests } = stubFetch((url) => {
      if (url.endsWith('/issues/42')) {
        return jsonResponse({ number: 42, pull_request: { url: 'x' } });
      }
      return jsonResponse({
        id: 42,
        node_id: 'PR_42',
        number: 42,
        title: 'Fix the flux capacitor',
        html_url: 'https://github.com/acme/widgets/pull/42',
        state: 'open',
        merged_at: null,
        draft: false,
        user: { login: 'alice' },
        base: { ref: 'main' },
        head: { ref: 'fix/flux', sha: 'deadbeef' },
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
        mergeable: true,
      });
    });
    const provider = new GitHubProvider({ fetchFn });
    const result = (await provider.getIssueOrPr(auth, repo, '42')) as PullRequest;
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/42',
      'https://api.github.com/repos/acme/widgets/pulls/42',
    ]);
    expect(result.number).toBe(42);
    expect(result.headSha).toBe('deadbeef');
    expect(result.mergeable).toBe('mergeable');
    expect(result.state).toBe('open');
  });

  it('returns undefined for 404s and non-numeric refs', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    const provider = new GitHubProvider({ fetchFn });
    expect(await provider.getIssueOrPr(auth, repo, '9999')).toBeUndefined();
    expect(await provider.getIssueOrPr(auth, repo, 'abc')).toBeUndefined();
  });
});

describe('GitHubProvider error handling', () => {
  it('throws AuthError on 401', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'Bad credentials' }, 401));
    const provider = new GitHubProvider({ fetchFn });
    await expect(provider.getMyPullRequests(auth)).rejects.toBeInstanceOf(AuthError);
  });

  it('throws RateLimitError with reset time on 403 rate limits', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403, {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1784000000',
      })
    );
    const provider = new GitHubProvider({ fetchFn });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt?.getTime()).toBe(1_784_000_000_000);
  });

  it('throws plain ProviderError on non-rate-limit 403s', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'Forbidden' }, 403));
    const provider = new GitHubProvider({ fetchFn });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });

  it('surfaces GraphQL-level errors as ProviderError', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ errors: [{ message: 'Something went wrong' }] })
    );
    const provider = new GitHubProvider({ fetchFn });
    await expect(provider.getMyPullRequests(auth)).rejects.toThrow(/Something went wrong/);
  });
});

describe('GitHubProvider remotes and enterprise variant', () => {
  it('matches github.com remotes only', () => {
    const provider = new GitHubProvider({ fetchFn: stubFetch(() => jsonResponse({})).fetchFn });
    expect(provider.matchesRemote('git@github.com:acme/widgets.git')).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
    expect(provider.matchesRemote('https://gitlab.com/acme/widgets.git')).toBeUndefined();
  });

  it('enterprise variant targets the enterprise API endpoints and host', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse(searchResponse([prNode()])));
    const provider = createGitHubEnterpriseProvider('github.corp.example', fetchFn);
    const [pr] = await provider.getMyPullRequests(auth);
    expect(requests[0].url).toBe('https://github.corp.example/api/graphql');
    expect(pr.repo.host).toBe('github.corp.example');
    expect(pr.repo.provider).toBe('github-enterprise');
    expect(
      provider.matchesRemote('https://github.corp.example/acme/widgets.git')?.host
    ).toBe('github.corp.example');
  });
});
