import { describe, expect, it } from 'vitest';
import { AuthError, RateLimitError } from '../src/errors.js';
import type { RepoDescriptor } from '../src/models.js';
import { BitbucketDCProvider } from '../src/providers/bitbucketDC.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'http-access-token' };
const baseUrl = 'https://git.corp.example';
const repo: RepoDescriptor = {
  provider: 'bitbucket-dc',
  host: 'git.corp.example',
  owner: 'ACME',
  name: 'widgets',
};

function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    title: 'Add widgets',
    state: 'OPEN',
    draft: false,
    author: { user: { name: 'alice', slug: 'alice', displayName: 'Alice' } },
    reviewers: [{ user: { name: 'bob' }, approved: true, status: 'APPROVED' }],
    fromRef: {
      id: 'refs/heads/feat/widgets',
      displayId: 'feat/widgets',
      latestCommit: 'cafe1234',
      repository: { slug: 'widgets', project: { key: 'ACME' } },
    },
    toRef: { id: 'refs/heads/main', displayId: 'main' },
    createdDate: 1782864000000,
    updatedDate: 1782950400000,
    links: {
      self: [{ href: 'https://git.corp.example/projects/ACME/repos/widgets/pull-requests/42' }],
    },
    ...overrides,
  };
}

function dashboardStub(authored: unknown[], reviewing: unknown[] = []): ReturnType<typeof stubFetch> {
  return stubFetch((url) =>
    url.includes('role=AUTHOR')
      ? jsonResponse({ values: authored })
      : jsonResponse({ values: reviewing })
  );
}

describe('BitbucketDCProvider.getMyPullRequests', () => {
  it('queries the dashboard for both roles and maps normalized PullRequests', async () => {
    const { fetchFn, requests } = dashboardStub([pr()]);
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    const prs = await provider.getMyPullRequests(auth);

    expect(requests.map((r) => r.url).sort()).toEqual([
      'https://git.corp.example/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=AUTHOR&limit=50',
      'https://git.corp.example/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=REVIEWER&limit=50',
    ]);
    expect(requests[0].init?.headers?.authorization).toBe('Bearer http-access-token');

    expect(prs).toHaveLength(1);
    const mapped = prs[0];
    expect(mapped.number).toBe(42);
    expect(mapped.title).toBe('Add widgets');
    expect(mapped.url).toBe(
      'https://git.corp.example/projects/ACME/repos/widgets/pull-requests/42'
    );
    expect(mapped.state).toBe('open');
    expect(mapped.author).toEqual({ id: 'alice', username: 'alice', name: 'Alice' });
    expect(mapped.baseRef).toBe('main');
    expect(mapped.headRef).toBe('feat/widgets');
    expect(mapped.headSha).toBe('cafe1234');
    expect(mapped.repo).toEqual({
      provider: 'bitbucket-dc',
      host: 'git.corp.example',
      owner: 'ACME',
      name: 'widgets',
    });
    expect(mapped.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(mapped.updatedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(mapped.reviewDecision).toBe('approved');
    expect(mapped.mergeable).toBe('unknown');
    expect(mapped.viewerRole).toBe('author');
  });

  it('maps reviewer statuses to reviewDecision and reviewer role', async () => {
    const needsWork = pr({
      id: 1,
      reviewers: [
        { user: { name: 'me' }, status: 'APPROVED' },
        { user: { name: 'bob' }, status: 'NEEDS_WORK' },
      ],
    });
    const unreviewed = pr({
      id: 2,
      reviewers: [{ user: { name: 'me' }, approved: false, status: 'UNAPPROVED' }],
    });
    const { fetchFn } = dashboardStub([], [needsWork, unreviewed]);
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    const [n, u] = await provider.getMyPullRequests(auth);
    expect(n.reviewDecision).toBe('changes_requested');
    expect(u.reviewDecision).toBe('review_required');
    expect(n.viewerRole).toBe('reviewer');
    expect(n.reviewRequestedFromViewer).toBe(true);
  });

  it('dedupes PRs across roles preferring the author role, and maps end states', async () => {
    const both = pr({ id: 5 });
    const merged = pr({ id: 6, state: 'MERGED' });
    const declined = pr({ id: 7, state: 'DECLINED' });
    const { fetchFn } = dashboardStub([both, merged, declined], [both]);
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    const prs = await provider.getMyPullRequests(auth);
    expect(prs).toHaveLength(3);
    expect(prs.find((p) => p.number === 5)?.viewerRole).toBe('author');
    expect(prs.find((p) => p.number === 6)?.state).toBe('merged');
    expect(prs.find((p) => p.number === 7)?.state).toBe('closed');
  });
});

describe('BitbucketDCProvider.getPullRequestForBranch', () => {
  it('filters repo pull requests by outgoing ref', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ values: [pr()] }));
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    const found = await provider.getPullRequestForBranch(auth, repo, 'feat/widgets');
    expect(requests[0].url).toBe(
      'https://git.corp.example/rest/api/1.0/projects/ACME/repos/widgets/pull-requests' +
        '?state=OPEN&direction=OUTGOING&at=refs%2Fheads%2Ffeat%2Fwidgets'
    );
    expect(found?.number).toBe(42);
    expect(found?.viewerRole).toBe('none');
  });

  it('returns undefined when no PR matches', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ values: [] }));
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    expect(await provider.getPullRequestForBranch(auth, repo, 'nope')).toBeUndefined();
  });
});

describe('BitbucketDCProvider.getIssueOrPr', () => {
  it('resolves numeric refs to pull requests', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse(pr()));
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    const result = await provider.getIssueOrPr(auth, repo, '#42');
    expect(requests[0].url).toBe(
      'https://git.corp.example/rest/api/1.0/projects/ACME/repos/widgets/pull-requests/42'
    );
    expect(result).toMatchObject({ number: 42, state: 'open' });
  });

  it('returns undefined for 404s and non-numeric refs', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}, 404));
    const provider = new BitbucketDCProvider({ baseUrl, fetchFn });
    expect(await provider.getIssueOrPr(auth, repo, '9999')).toBeUndefined();
    expect(await provider.getIssueOrPr(auth, repo, 'abc')).toBeUndefined();
  });
});

describe('BitbucketDCProvider errors and remotes', () => {
  it('throws AuthError on 401 and RateLimitError on 429', async () => {
    const unauthorized = new BitbucketDCProvider({
      baseUrl,
      fetchFn: stubFetch(() => jsonResponse({}, 401)).fetchFn,
    });
    await expect(unauthorized.getMyPullRequests(auth)).rejects.toBeInstanceOf(AuthError);

    const limited = new BitbucketDCProvider({
      baseUrl,
      fetchFn: stubFetch(() => jsonResponse({}, 429, { 'Retry-After': '10' })).fetchFn,
    });
    await expect(limited.getMyPullRequests(auth)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('matches instance remotes, stripping the https scm/ path prefix', () => {
    const provider = new BitbucketDCProvider({
      baseUrl,
      fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
    });
    expect(provider.matchesRemote('https://git.corp.example/scm/acme/widgets.git')).toEqual({
      provider: 'bitbucket-dc',
      host: 'git.corp.example',
      owner: 'acme',
      name: 'widgets',
    });
    expect(provider.matchesRemote('ssh://git@git.corp.example:7999/acme/widgets.git')).toEqual({
      provider: 'bitbucket-dc',
      host: 'git.corp.example',
      owner: 'acme',
      name: 'widgets',
    });
    expect(provider.matchesRemote('git@github.com:acme/widgets.git')).toBeUndefined();
  });
});
