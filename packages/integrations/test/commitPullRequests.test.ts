// getPullRequestsForCommit against responses recorded from the real APIs:
// GitHub's GET /repos/{o}/{r}/commits/{sha}/pulls plus the full pull request,
// and GitLab's GET /projects/:id/repository/commits/:sha/merge_requests.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CredentialScopeError, RateLimitError } from '../src/errors.js';
import { orderCommitPullRequests, supportsCommitPullRequests } from '../src/hostingProvider.js';
import type { RepoDescriptor } from '../src/models.js';
import { BitbucketProvider } from '../src/providers/bitbucket.js';
import { createGitHubEnterpriseProvider, GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { jsonResponse, makePr, stubFetch } from './helpers.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const auth = { token: 'test-token', host: 'github.com' };
const click: RepoDescriptor = {
  provider: 'github',
  host: 'github.com',
  owner: 'pallets',
  name: 'click',
};
/** A commit of pallets/click#3820, merged as be13b152. */
const SHA = 'bb86cdea6e83bc8e2711290eeffb4c8654baa7a3';

function gitHubRoutes(overrides: Record<string, () => ReturnType<typeof jsonResponse>> = {}) {
  return stubFetch((url) => {
    for (const [suffix, respond] of Object.entries(overrides)) {
      if (url.includes(suffix)) return respond();
    }
    if (url.includes(`/commits/${SHA}/pulls`))
      return jsonResponse(fixture('github-commit-pulls.json'));
    if (url.endsWith('/pulls/3820')) return jsonResponse(fixture('github-pull.json'));
    return jsonResponse({ message: 'Not Found' }, 404);
  });
}

describe('GitHubProvider.getPullRequestsForCommit', () => {
  it('maps the pull request that merged the commit, with its counts', async () => {
    const { fetchFn, requests } = gitHubRoutes();
    const provider = new GitHubProvider({ fetchFn });

    const prs = await provider.getPullRequestsForCommit(auth, click, SHA);

    expect(requests.map((request) => request.url)).toEqual([
      `https://api.github.com/repos/pallets/click/commits/${SHA}/pulls?per_page=5`,
      'https://api.github.com/repos/pallets/click/pulls/3820',
    ]);
    expect(requests[0].init?.headers?.authorization).toBe('Bearer test-token');
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 3820,
      title: 'Document calling a command as a regular function',
      url: 'https://github.com/pallets/click/pull/3820',
      state: 'merged',
      mergedAt: '2026-09-02T00:20:14Z',
      reviewCommentCount: 2,
      commentCount: 5,
      repo: click,
    });
    expect(prs[0].body).toContain('Closes #1054.');
    expect(prs[0].author.username).toBeTruthy();
  });

  it('asks once per commit and token', async () => {
    const { fetchFn, requests } = gitHubRoutes();
    const provider = new GitHubProvider({ fetchFn });

    await provider.getPullRequestsForCommit(auth, click, SHA);
    await provider.getPullRequestsForCommit(auth, click, SHA);
    expect(requests).toHaveLength(2);

    // Another account may see other pull requests.
    await provider.getPullRequestsForCommit({ ...auth, token: 'other' }, click, SHA);
    expect(requests).toHaveLength(4);
  });

  it('finds none for a commit GitHub does not have', async () => {
    const { fetchFn, requests } = gitHubRoutes({
      '/pulls?per_page': () =>
        jsonResponse({ message: `No commit found for SHA: ${SHA}`, status: '422' }, 422),
    });
    const provider = new GitHubProvider({ fetchFn });

    expect(await provider.getPullRequestsForCommit(auth, click, SHA)).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('asks nothing for an abbreviated or malformed sha', async () => {
    const { fetchFn, requests } = gitHubRoutes();
    const provider = new GitHubProvider({ fetchFn });

    expect(await provider.getPullRequestsForCommit(auth, click, 'bb86cde')).toEqual([]);
    expect(await provider.getPullRequestsForCommit(auth, click, '../../user')).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('keeps the listed pull request when its full record cannot be read', async () => {
    const { fetchFn } = gitHubRoutes({
      '/pulls/3820': () => jsonResponse({ message: 'Forbidden' }, 403),
    });
    const provider = new GitHubProvider({ fetchFn });

    const prs = await provider.getPullRequestsForCommit(auth, click, SHA);
    expect(prs[0]).toMatchObject({ number: 3820, state: 'merged' });
    expect(prs[0].reviewCommentCount).toBeUndefined();
  });

  it('fails on an exhausted rate limit rather than guessing', async () => {
    const { fetchFn } = gitHubRoutes({
      '/pulls?per_page': () =>
        jsonResponse({ message: 'API rate limit exceeded' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '2000000000',
        }),
    });
    const provider = new GitHubProvider({ fetchFn });

    await expect(provider.getPullRequestsForCommit(auth, click, SHA)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('never sends another host its credential', async () => {
    const { fetchFn, requests } = gitHubRoutes();
    const provider = new GitHubProvider({ fetchFn });

    await expect(
      provider.getPullRequestsForCommit({ token: 't', host: 'gitlab.com' }, click, SHA),
    ).rejects.toBeInstanceOf(CredentialScopeError);
    expect(requests).toHaveLength(0);
  });

  it('asks a GitHub Enterprise Server on its own host', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse([]));
    const provider = createGitHubEnterpriseProvider('ghe.corp.example', fetchFn);

    const prs = await provider.getPullRequestsForCommit(
      { token: 't', host: 'ghe.corp.example' },
      { ...click, provider: 'github-enterprise', host: 'ghe.corp.example' },
      SHA,
    );
    expect(prs).toEqual([]);
    expect(requests[0].url).toBe(
      `https://ghe.corp.example/api/v3/repos/pallets/click/commits/${SHA}/pulls?per_page=5`,
    );
  });
});

describe('GitLabProvider.getPullRequestsForCommit', () => {
  const runner: RepoDescriptor = {
    provider: 'gitlab',
    host: 'gitlab.com',
    owner: 'gitlab-org',
    name: 'gitlab-runner',
  };
  /** The squash commit of gitlab-org/gitlab-runner!7650. */
  const squash = 'add94e521cb381d417e8ef2e810547faa890fb7b';

  it('maps the merge requests the commit belongs to in one call', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse(fixture('gitlab-commit-merge-requests.json')),
    );
    const provider = new GitLabProvider({ fetchFn });

    const prs = await provider.getPullRequestsForCommit(
      { token: 't', host: 'gitlab.com' },
      runner,
      squash,
    );

    expect(requests.map((request) => request.url)).toEqual([
      `https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/repository/commits/${squash}/merge_requests`,
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 7650,
      state: 'merged',
      url: 'https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7650',
      mergedAt: '2026-10-15T18:11:41.366Z',
      commentCount: 3,
      repo: runner,
    });
    expect(prs[0].body).toContain('## What does this MR do?');
  });

  it('finds none for a commit GitLab does not have', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: '404 Commit Not Found' }, 404));
    const provider = new GitLabProvider({ fetchFn });

    expect(
      await provider.getPullRequestsForCommit({ token: 't', host: 'gitlab.com' }, runner, squash),
    ).toEqual([]);
  });
});

describe('commit pull request support', () => {
  it('is offered by GitHub and GitLab only', () => {
    const fetchFn = stubFetch(() => jsonResponse({})).fetchFn;
    expect(supportsCommitPullRequests(new GitHubProvider({ fetchFn }))).toBe(true);
    expect(supportsCommitPullRequests(new GitLabProvider({ fetchFn }))).toBe(true);
    expect(supportsCommitPullRequests(new BitbucketProvider({ fetchFn }))).toBe(false);
  });

  it('orders merged first by merge date, then open, then closed', () => {
    const ordered = orderCommitPullRequests([
      makePr({ number: 1, state: 'closed', updatedAt: '2026-01-05T00:00:00Z' }),
      makePr({ number: 2, state: 'open', updatedAt: '2026-01-01T00:00:00Z' }),
      makePr({ number: 3, state: 'merged', mergedAt: '2026-01-04T00:00:00Z' }),
      makePr({ number: 4, state: 'merged', mergedAt: '2026-01-02T00:00:00Z' }),
      makePr({ number: 5, state: 'open', updatedAt: '2026-01-03T00:00:00Z' }),
    ]);
    expect(ordered.map((pr) => pr.number)).toEqual([4, 3, 5, 2, 1]);
  });
});
