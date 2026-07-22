import { describe, expect, it } from 'vitest';
import { AuthError, RateLimitError } from '../src/errors.js';
import type { RepoDescriptor } from '../src/models.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'glpat-test' };
const repo: RepoDescriptor = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'acme',
  name: 'widgets',
};

const user = { id: 1, username: 'alice', name: 'Alice', avatar_url: 'https://a/alice' };

function mr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    iid: 5,
    project_id: 77,
    title: 'Add widgets',
    web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/5',
    state: 'opened',
    draft: false,
    author: user,
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
    ...overrides,
  };
}

/** Routes the standard getMyPullRequests call sequence to canned payloads. */
function glStub(options: {
  authored?: unknown[];
  reviewing?: unknown[];
  approvals?: unknown;
}): ReturnType<typeof stubFetch> {
  return stubFetch((url) => {
    if (url.endsWith('/api/v4/user')) {
      return jsonResponse(user);
    }
    if (url.includes('reviewer_username=')) {
      return jsonResponse(options.reviewing ?? []);
    }
    if (url.includes('author_username=')) {
      return jsonResponse(options.authored ?? []);
    }
    if (url.includes('/approvals')) {
      return jsonResponse(options.approvals ?? { approved: false, approved_by: [] });
    }
    return jsonResponse({ message: 'unexpected' }, 500);
  });
}

describe('GitLabProvider.getMyPullRequests', () => {
  it('merges author and reviewer queries and maps to normalized PullRequests', async () => {
    const { fetchFn, requests } = glStub({ authored: [mr()], approvals: { approved: true } });
    const provider = new GitLabProvider({ fetchFn });
    const prs = await provider.getMyPullRequests(auth);

    expect(requests[0].url).toBe('https://gitlab.com/api/v4/user');
    expect(requests[0].init?.headers?.authorization).toBe('Bearer glpat-test');
    const urls = requests.map((r) => r.url);
    expect(urls).toContain(
      'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened&per_page=50&reviewer_username=alice'
    );
    expect(urls).toContain(
      'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened&per_page=50&author_username=alice'
    );
    expect(urls).toContain('https://gitlab.com/api/v4/projects/77/merge_requests/5/approvals');

    expect(prs).toHaveLength(1);
    const pr = prs[0];
    expect(pr.id).toBe('101');
    expect(pr.number).toBe(5);
    expect(pr.state).toBe('open');
    expect(pr.draft).toBe(false);
    expect(pr.author.username).toBe('alice');
    expect(pr.baseRef).toBe('main');
    expect(pr.headRef).toBe('feat/widgets');
    expect(pr.headSha).toBe('cafe1234');
    expect(pr.repo).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'acme',
      name: 'widgets',
    });
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.checksStatus).toBe('passing');
    expect(pr.mergeable).toBe('mergeable');
    expect(pr.viewerRole).toBe('author');
  });

  it('dedupes MRs present in both result sets and caches the username lookup', async () => {
    const { fetchFn, requests } = glStub({ authored: [mr()], reviewing: [mr()] });
    const provider = new GitLabProvider({ fetchFn });
    expect(await provider.getMyPullRequests(auth)).toHaveLength(1);
    await provider.getMyPullRequests(auth);
    const userCalls = requests.filter((r) => r.url.endsWith('/api/v4/user'));
    expect(userCalls).toHaveLength(1);
  });

  it('marks reviewer-side MRs and unapproved reviews as review_required', async () => {
    const node = mr({ author: { id: 2, username: 'bob' } });
    const { fetchFn } = glStub({ reviewing: [node] });
    const provider = new GitLabProvider({ fetchFn });
    const [pr] = await provider.getMyPullRequests(auth);
    expect(pr.viewerRole).toBe('reviewer');
    expect(pr.reviewRequestedFromViewer).toBe(true);
    expect(pr.reviewDecision).toBe('review_required');
  });

  it('maps merge statuses to mergeability', async () => {
    const conflict = mr({ id: 1, iid: 1, detailed_merge_status: 'conflict' });
    const checking = mr({ id: 2, iid: 2, detailed_merge_status: 'checking' });
    const legacy = mr({
      id: 3,
      iid: 3,
      detailed_merge_status: undefined,
      merge_status: 'cannot_be_merged',
    });
    const { fetchFn } = glStub({ authored: [conflict, checking, legacy] });
    const provider = new GitLabProvider({ fetchFn });
    const [c, u, l] = await provider.getMyPullRequests(auth);
    expect(c.mergeable).toBe('conflicts');
    expect(u.mergeable).toBe('unknown');
    expect(l.mergeable).toBe('conflicts');
  });

  it('maps pipeline statuses to checksStatus, draft flags, and merged state', async () => {
    const failed = mr({ id: 1, iid: 1, head_pipeline: { status: 'failed' } });
    const running = mr({ id: 2, iid: 2, head_pipeline: { status: 'running' } });
    const none = mr({ id: 3, iid: 3, head_pipeline: null, draft: true });
    const merged = mr({ id: 4, iid: 4, state: 'merged' });
    const { fetchFn } = glStub({ authored: [failed, running, none, merged] });
    const provider = new GitLabProvider({ fetchFn });
    const [f, r, n, m] = await provider.getMyPullRequests(auth);
    expect(f.checksStatus).toBe('failing');
    expect(r.checksStatus).toBe('pending');
    expect(n.checksStatus).toBe('none');
    expect(n.draft).toBe(true);
    expect(m.state).toBe('merged');
  });

  it('serves self-managed instances via baseUrl', async () => {
    const { fetchFn, requests } = glStub({ authored: [] });
    const provider = new GitLabProvider({ baseUrl: 'https://git.corp.example', fetchFn });
    await provider.getMyPullRequests(auth);
    expect(requests[0].url).toBe('https://git.corp.example/api/v4/user');
    expect(provider.matchesRemote('git@git.corp.example:acme/widgets.git')).toEqual({
      provider: 'gitlab',
      host: 'git.corp.example',
      owner: 'acme',
      name: 'widgets',
    });
    expect(provider.matchesRemote('git@gitlab.com:acme/widgets.git')).toBeUndefined();
  });
});

describe('GitLabProvider.getPullRequestForBranch', () => {
  it('queries the project by source branch and maps the first result', async () => {
    const { fetchFn, requests } = stubFetch((url) => {
      if (url.endsWith('/api/v4/user')) {
        return jsonResponse(user);
      }
      if (url.includes('source_branch=')) {
        return jsonResponse([mr()]);
      }
      return jsonResponse({ approved: false });
    });
    const provider = new GitLabProvider({ fetchFn });
    const pr = await provider.getPullRequestForBranch(auth, repo, 'feat/widgets');
    expect(requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests?state=opened&source_branch=feat%2Fwidgets'
    );
    expect(pr?.number).toBe(5);
  });

  it('returns undefined when no MR matches the branch', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse([]));
    const provider = new GitLabProvider({ fetchFn });
    expect(await provider.getPullRequestForBranch(auth, repo, 'nope')).toBeUndefined();
  });
});

describe('GitLabProvider.getIssueOrPr', () => {
  it('maps a project issue payload', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({
        id: 900,
        iid: 7,
        title: 'Widget crashes',
        web_url: 'https://gitlab.com/acme/widgets/-/issues/7',
        state: 'opened',
        assignees: [user],
        updated_at: '2026-07-03T00:00:00Z',
      })
    );
    const provider = new GitLabProvider({ fetchFn });
    const issue = await provider.getIssueOrPr(auth, repo, '#7');
    expect(requests[0].url).toBe('https://gitlab.com/api/v4/projects/acme%2Fwidgets/issues/7');
    expect(issue).toEqual({
      id: '900',
      key: 'acme/widgets#7',
      title: 'Widget crashes',
      url: 'https://gitlab.com/acme/widgets/-/issues/7',
      state: 'opened',
      assignee: { id: '1', username: 'alice', name: 'Alice', avatarUrl: 'https://a/alice' },
      updatedAt: '2026-07-03T00:00:00Z',
    });
  });

  it('returns undefined for 404s and non-numeric refs', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    const provider = new GitLabProvider({ fetchFn });
    expect(await provider.getIssueOrPr(auth, repo, '9999')).toBeUndefined();
    expect(await provider.getIssueOrPr(auth, repo, 'abc')).toBeUndefined();
  });
});

describe('GitLabProvider errors and extras', () => {
  it('throws AuthError on 401', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: '401 Unauthorized' }, 401));
    const provider = new GitLabProvider({ fetchFn });
    await expect(provider.getMyPullRequests(auth)).rejects.toBeInstanceOf(AuthError);
  });

  it('throws RateLimitError with reset time on 429', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ message: 'Too many requests' }, 429, { 'RateLimit-Reset': '1784000000' })
    );
    const provider = new GitLabProvider({ fetchFn });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt?.getTime()).toBe(1_784_000_000_000);
  });

  it('looks up avatars by email and exposes static autolink patterns', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ avatar_url: 'https://a/hash' })
    );
    const provider = new GitLabProvider({ fetchFn });
    expect(await provider.getAvatarUrl(auth, 'alice@example.com')).toBe('https://a/hash');
    expect(requests[0].url).toBe('https://gitlab.com/api/v4/avatar?email=alice%40example.com');

    const patterns = await provider.getAutolinkPatterns(auth, repo);
    expect(patterns).toEqual([
      {
        regex: '#(\\d+)',
        urlTemplate: 'https://gitlab.com/acme/widgets/-/issues/$1',
        title: 'GitLab issue',
      },
      {
        regex: '!(\\d+)',
        urlTemplate: 'https://gitlab.com/acme/widgets/-/merge_requests/$1',
        title: 'GitLab merge request',
      },
    ]);
  });
});
