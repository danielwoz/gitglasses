import { describe, expect, it } from 'vitest';
import { AuthError, RateLimitError } from '../src/errors.js';
import type { RepoDescriptor } from '../src/models.js';
import { BitbucketProvider } from '../src/providers/bitbucket.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'app-password', username: 'alice' };
const repo: RepoDescriptor = {
  provider: 'bitbucket',
  host: 'bitbucket.org',
  owner: 'acme',
  name: 'widgets',
};

function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    title: 'Add widgets',
    state: 'OPEN',
    draft: false,
    author: {
      uuid: '{u-1}',
      nickname: 'alice',
      display_name: 'Alice',
      links: { avatar: { href: 'https://a/alice' } },
    },
    links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/12' } },
    source: { branch: { name: 'feat/widgets' }, commit: { hash: 'cafe1234' } },
    destination: { branch: { name: 'main' }, repository: { full_name: 'acme/widgets' } },
    created_on: '2026-07-01T00:00:00Z',
    updated_on: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

describe('BitbucketProvider.getMyPullRequests', () => {
  it('lists authored PRs for the user and maps the normalized fields', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ values: [pr()] }));
    const provider = new BitbucketProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth);

    expect(requests[0].url).toBe(
      'https://api.bitbucket.org/2.0/pullrequests/alice?state=OPEN&pagelen=50'
    );
    // username:app-password basic auth
    expect(requests[0].init?.headers?.authorization).toBe('Basic YWxpY2U6YXBwLXBhc3N3b3Jk');

    expect(prs).toHaveLength(1);
    const mapped = prs[0];
    expect(mapped.number).toBe(12);
    expect(mapped.state).toBe('open');
    expect(mapped.draft).toBe(false);
    expect(mapped.author).toEqual({
      id: '{u-1}',
      username: 'alice',
      name: 'Alice',
      avatarUrl: 'https://a/alice',
    });
    expect(mapped.baseRef).toBe('main');
    expect(mapped.headRef).toBe('feat/widgets');
    expect(mapped.headSha).toBe('cafe1234');
    expect(mapped.repo).toEqual({
      provider: 'bitbucket',
      host: 'bitbucket.org',
      owner: 'acme',
      name: 'widgets',
    });
    // The Cloud API exposes neither mergeability nor cheap per-PR statuses.
    expect(mapped.mergeable).toBe('unknown');
    expect(mapped.checksStatus).toBe('none');
    expect(mapped.viewerRole).toBe('author');
  });

  it('maps MERGED and DECLINED states', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ values: [pr({ id: 1, state: 'MERGED' }), pr({ id: 2, state: 'DECLINED' })] })
    );
    const provider = new BitbucketProvider({ fetchFn });
    const [merged, declined] = await provider.getMyPullRequests(auth);
    expect(merged.state).toBe('merged');
    expect(declined.state).toBe('closed');
  });

  it('resolves the username via /user (with bearer auth) when not supplied, and caches it', async () => {
    const { fetchFn, requests } = stubFetch((url) =>
      url.endsWith('/user') ? jsonResponse({ username: 'alice' }) : jsonResponse({ values: [] })
    );
    const provider = new BitbucketProvider({ fetchFn });
    await provider.getMyPullRequests({ token: 'oauth-token' });
    await provider.getMyPullRequests({ token: 'oauth-token' });
    const userCalls = requests.filter((r) => r.url.endsWith('/user'));
    expect(userCalls).toHaveLength(1);
    expect(userCalls[0].init?.headers?.authorization).toBe('Bearer oauth-token');
  });
});

describe('BitbucketProvider.getPullRequestForBranch', () => {
  it('queries the repository with an encoded source-branch filter', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ values: [pr()] }));
    const provider = new BitbucketProvider({ fetchFn });
    const found = await provider.getPullRequestForBranch(auth, repo, 'feat/widgets');
    expect(requests[0].url).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests?q=' +
        encodeURIComponent('source.branch.name = "feat/widgets" AND state = "OPEN"')
    );
    expect(found?.number).toBe(12);
    expect(found?.viewerRole).toBe('author');
  });

  it('returns undefined when no PR matches', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ values: [] }));
    const provider = new BitbucketProvider({ fetchFn });
    expect(await provider.getPullRequestForBranch(auth, repo, 'nope')).toBeUndefined();
  });
});

describe('BitbucketProvider.getIssueOrPr', () => {
  it('maps a repository issue payload', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({
        id: 7,
        title: 'Widget crashes',
        state: 'new',
        assignee: { uuid: '{u-2}', nickname: 'carol' },
        links: { html: { href: 'https://bitbucket.org/acme/widgets/issues/7' } },
        updated_on: '2026-07-03T00:00:00Z',
      })
    );
    const provider = new BitbucketProvider({ fetchFn });
    const issue = await provider.getIssueOrPr(auth, repo, '#7');
    expect(issue).toMatchObject({
      id: '7',
      key: 'acme/widgets#7',
      title: 'Widget crashes',
      state: 'new',
      url: 'https://bitbucket.org/acme/widgets/issues/7',
    });
  });

  it('falls back to the pull request endpoint when the issue tracker 404s', async () => {
    const { fetchFn, requests } = stubFetch((url) =>
      url.includes('/issues/') ? jsonResponse({}, 404) : jsonResponse(pr())
    );
    const provider = new BitbucketProvider({ fetchFn });
    const result = await provider.getIssueOrPr(auth, repo, '12');
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.bitbucket.org/2.0/repositories/acme/widgets/issues/12',
      'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/12',
    ]);
    expect(result).toMatchObject({ number: 12, state: 'open' });
  });
});

describe('BitbucketProvider.getMyPullRequests reviewer merge', () => {
  /** Routes the authored, reviewer, statuses, and /user endpoints. */
  function reviewerStub(reviewerValues: Record<string, unknown>[]) {
    return stubFetch((url) => {
      if (url.endsWith('/user')) {
        return jsonResponse({ username: 'alice', uuid: '{me-uuid}' });
      }
      if (url.includes('/pullrequests/') && url.includes('/statuses')) {
        return jsonResponse({ values: [] });
      }
      if (url.includes('/repositories/acme/widgets/pullrequests?q=')) {
        return jsonResponse({ values: reviewerValues });
      }
      return jsonResponse({ values: [pr()] });
    });
  }

  it('adds repo-scoped review requests with viewerRole "reviewer" when a repo is given', async () => {
    const reviewerPr = pr({ id: 30, author: { uuid: '{u-2}', nickname: 'bob' } });
    const { fetchFn, requests } = reviewerStub([reviewerPr]);
    const provider = new BitbucketProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth, { repo });

    const reviewerQuery = requests.find((r) => r.url.includes('pullrequests?q='));
    expect(reviewerQuery?.url).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests?q=' +
        encodeURIComponent('state="OPEN" AND reviewers.uuid="{me-uuid}"')
    );
    expect(prs).toHaveLength(2);
    const authored = prs.find((p) => p.number === 12);
    const reviewing = prs.find((p) => p.number === 30);
    expect(authored?.viewerRole).toBe('author');
    expect(authored?.reviewRequestedFromViewer).toBe(false);
    expect(reviewing?.viewerRole).toBe('reviewer');
    expect(reviewing?.reviewRequestedFromViewer).toBe(true);
  });

  it('dedupes by id, keeping the authored role for PRs in both lists', async () => {
    const { fetchFn } = reviewerStub([pr()]); // id 12 appears in both queries
    const provider = new BitbucketProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth, { repo });
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(12);
    expect(prs[0].viewerRole).toBe('author');
  });

  it('resolves the own uuid via a single cached /user call across both queries', async () => {
    const { fetchFn, requests } = reviewerStub([]);
    const provider = new BitbucketProvider({ fetchFn });
    // No auth.username: the authored query needs the username and the
    // reviewer query needs the uuid, both from the same cached /user call.
    await provider.getMyPullRequests({ token: 'oauth-token' }, { repo });
    await provider.getMyPullRequests({ token: 'oauth-token' }, { repo });
    expect(requests.filter((r) => r.url.endsWith('/user'))).toHaveLength(1);
  });

  it('skips the reviewer query when no repo context is provided', async () => {
    const { fetchFn, requests } = reviewerStub([pr({ id: 99 })]);
    const provider = new BitbucketProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth);
    expect(requests.some((r) => r.url.includes('pullrequests?q='))).toBe(false);
    expect(prs.map((p) => p.number)).toEqual([12]);
  });
});

describe('BitbucketProvider.getMyPullRequests checksStatus', () => {
  /** Authored list of `count` PRs; every statuses call returns `statuses`. */
  function checksStub(statuses: Array<Record<string, unknown>>, count = 1) {
    const values = Array.from({ length: count }, (_, i) => pr({ id: i + 1 }));
    return stubFetch((url) =>
      url.includes('/statuses') ? jsonResponse({ values: statuses }) : jsonResponse({ values })
    );
  }

  it('fetches the per-PR statuses page and marks all-SUCCESSFUL as passing', async () => {
    const { fetchFn, requests } = checksStub([{ state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }]);
    const provider = new BitbucketProvider({ fetchFn });
    const [mapped] = await provider.getMyPullRequests(auth);
    expect(requests.some((r) =>
      r.url.endsWith('/repositories/acme/widgets/pullrequests/1/statuses')
    )).toBe(true);
    expect(mapped.checksStatus).toBe('passing');
  });

  it('marks any FAILED as failing, even alongside successes', async () => {
    const { fetchFn } = checksStub([{ state: 'SUCCESSFUL' }, { state: 'FAILED' }]);
    const provider = new BitbucketProvider({ fetchFn });
    const [mapped] = await provider.getMyPullRequests(auth);
    expect(mapped.checksStatus).toBe('failing');
  });

  it('marks any INPROGRESS (without failures) as pending', async () => {
    const { fetchFn } = checksStub([{ state: 'SUCCESSFUL' }, { state: 'INPROGRESS' }]);
    const provider = new BitbucketProvider({ fetchFn });
    const [mapped] = await provider.getMyPullRequests(auth);
    expect(mapped.checksStatus).toBe('pending');
  });

  it('reports none when there are no statuses or a non-terminal mix', async () => {
    const empty = new BitbucketProvider({ fetchFn: checksStub([]).fetchFn });
    expect((await empty.getMyPullRequests(auth))[0].checksStatus).toBe('none');
    const stopped = new BitbucketProvider({
      fetchFn: checksStub([{ state: 'SUCCESSFUL' }, { state: 'STOPPED' }]).fetchFn,
    });
    expect((await stopped.getMyPullRequests(auth))[0].checksStatus).toBe('none');
  });

  it('only enriches the first 10 PRs; later ones stay none', async () => {
    const { fetchFn, requests } = checksStub([{ state: 'SUCCESSFUL' }], 12);
    const provider = new BitbucketProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth);
    expect(prs).toHaveLength(12);
    expect(requests.filter((r) => r.url.includes('/statuses'))).toHaveLength(10);
    expect(prs.slice(0, 10).every((p) => p.checksStatus === 'passing')).toBe(true);
    expect(prs.slice(10).every((p) => p.checksStatus === 'none')).toBe(true);
  });
});

describe('BitbucketProvider errors and remotes', () => {
  it('throws AuthError on 401', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    const provider = new BitbucketProvider({ fetchFn });
    await expect(provider.getMyPullRequests(auth)).rejects.toBeInstanceOf(AuthError);
  });

  it('throws RateLimitError on 429 using Retry-After', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '30' })
    );
    const provider = new BitbucketProvider({ fetchFn });
    const before = Date.now();
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    const resetAt = (error as RateLimitError).resetAt?.getTime() ?? 0;
    expect(resetAt).toBeGreaterThanOrEqual(before + 29_000);
    expect(resetAt).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('matches bitbucket.org remotes only', () => {
    const provider = new BitbucketProvider({
      fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
    });
    expect(provider.matchesRemote('git@bitbucket.org:acme/widgets.git')).toEqual({
      provider: 'bitbucket',
      host: 'bitbucket.org',
      owner: 'acme',
      name: 'widgets',
    });
    expect(provider.matchesRemote('git@github.com:acme/widgets.git')).toBeUndefined();
  });
});
