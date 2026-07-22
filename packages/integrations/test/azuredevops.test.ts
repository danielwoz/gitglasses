import { describe, expect, it } from 'vitest';
import { AuthError, RateLimitError } from '../src/errors.js';
import type { Issue, RepoDescriptor } from '../src/models.js';
import { AzureDevOpsProvider } from '../src/providers/azuredevops.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'pat' };
const repo: RepoDescriptor = {
  provider: 'azuredevops',
  host: 'dev.azure.com',
  owner: 'contoso/Web',
  name: 'widgets',
};

const connectionData = { authenticatedUser: { id: 'user-guid', providerDisplayName: 'Alice' } };

function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 9,
    title: 'Add widgets',
    status: 'active',
    isDraft: false,
    createdBy: { id: 'user-guid', displayName: 'Alice', uniqueName: 'alice@contoso.example' },
    sourceRefName: 'refs/heads/feat/widgets',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: 'cafe1234' },
    mergeStatus: 'succeeded',
    reviewers: [{ id: 'rev-guid', vote: 10, isRequired: true }],
    repository: { name: 'widgets', project: { name: 'Web' } },
    creationDate: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function adoStub(created: unknown[], reviewing: unknown[] = []): ReturnType<typeof stubFetch> {
  return stubFetch((url) => {
    if (url.includes('/_apis/connectionData')) {
      return jsonResponse(connectionData);
    }
    if (url.includes('searchCriteria.creatorId=')) {
      return jsonResponse({ value: created });
    }
    return jsonResponse({ value: reviewing });
  });
}

describe('AzureDevOpsProvider.getMyPullRequests', () => {
  it('resolves the caller through connectionData and maps active PRs', async () => {
    const { fetchFn, requests } = adoStub([pr()]);
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    const prs = await provider.getMyPullRequests(auth);

    expect(requests[0].url).toBe('https://dev.azure.com/contoso/_apis/connectionData');
    // PAT sent as basic auth with an empty username (":pat").
    expect(requests[0].init?.headers?.authorization).toBe('Basic OnBhdA==');
    const prUrls = requests.slice(1).map((r) => r.url).sort();
    expect(prUrls).toEqual([
      'https://dev.azure.com/contoso/_apis/git/pullrequests?searchCriteria.status=active' +
        '&$top=50&api-version=7.1&searchCriteria.creatorId=user-guid',
      'https://dev.azure.com/contoso/_apis/git/pullrequests?searchCriteria.status=active' +
        '&$top=50&api-version=7.1&searchCriteria.reviewerId=user-guid',
    ]);

    expect(prs).toHaveLength(1);
    const mapped = prs[0];
    expect(mapped.number).toBe(9);
    expect(mapped.url).toBe('https://dev.azure.com/contoso/Web/_git/widgets/pullrequest/9');
    expect(mapped.state).toBe('open');
    expect(mapped.draft).toBe(false);
    expect(mapped.author.username).toBe('alice@contoso.example');
    expect(mapped.baseRef).toBe('main');
    expect(mapped.headRef).toBe('feat/widgets');
    expect(mapped.headSha).toBe('cafe1234');
    expect(mapped.repo).toEqual({
      provider: 'azuredevops',
      host: 'dev.azure.com',
      owner: 'contoso/Web',
      name: 'widgets',
    });
    expect(mapped.mergeable).toBe('mergeable');
    expect(mapped.reviewDecision).toBe('approved');
    expect(mapped.viewerRole).toBe('author');
  });

  it('caches the profile id across calls and dedupes PRs across the two queries', async () => {
    const shared = pr({ pullRequestId: 1 });
    const { fetchFn, requests } = adoStub([shared], [shared, pr({ pullRequestId: 2 })]);
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    const first = await provider.getMyPullRequests(auth);
    await provider.getMyPullRequests(auth);

    expect(first).toHaveLength(2);
    expect(first.find((p) => p.number === 1)?.viewerRole).toBe('author');
    expect(first.find((p) => p.number === 2)?.viewerRole).toBe('reviewer');
    const connectionCalls = requests.filter((r) => r.url.includes('connectionData'));
    expect(connectionCalls).toHaveLength(1);
  });

  it('maps reviewer votes to reviewDecision', async () => {
    const rejected = pr({
      pullRequestId: 1,
      reviewers: [
        { id: 'a', vote: 10, isRequired: true },
        { id: 'b', vote: -5 },
      ],
    });
    const waiting = pr({
      pullRequestId: 2,
      reviewers: [
        { id: 'a', vote: 10 },
        { id: 'b', vote: 0, isRequired: true },
      ],
    });
    const optionalApproved = pr({ pullRequestId: 3, reviewers: [{ id: 'a', vote: 5 }] });
    const noReviewers = pr({ pullRequestId: 4, reviewers: [] });
    const { fetchFn } = adoStub([rejected, waiting, optionalApproved, noReviewers]);
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    const [r, w, o, n] = await provider.getMyPullRequests(auth);
    expect(r.reviewDecision).toBe('changes_requested');
    expect(w.reviewDecision).toBe('review_required');
    expect(o.reviewDecision).toBe('approved');
    expect(n.reviewDecision).toBeUndefined();
  });

  it('maps merge statuses, draft flags, and terminal states', async () => {
    const conflicted = pr({ pullRequestId: 1, mergeStatus: 'conflicts', isDraft: true });
    const queued = pr({ pullRequestId: 2, mergeStatus: 'queued' });
    const completed = pr({ pullRequestId: 3, status: 'completed' });
    const abandoned = pr({ pullRequestId: 4, status: 'abandoned' });
    const { fetchFn } = adoStub([conflicted, queued, completed, abandoned]);
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    const [c, q, m, a] = await provider.getMyPullRequests(auth);
    expect(c.mergeable).toBe('conflicts');
    expect(c.draft).toBe(true);
    expect(q.mergeable).toBe('unknown');
    expect(m.state).toBe('merged');
    expect(a.state).toBe('closed');
  });
});

describe('AzureDevOpsProvider.getPullRequestForBranch', () => {
  it('queries the repository by source ref', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ value: [pr()] }));
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    const found = await provider.getPullRequestForBranch(auth, repo, 'feat/widgets');
    expect(requests[0].url).toBe(
      'https://dev.azure.com/contoso/Web/_apis/git/repositories/widgets/pullrequests' +
        '?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeat%2Fwidgets' +
        '&api-version=7.1'
    );
    expect(found?.number).toBe(9);
    expect(found?.viewerRole).toBe('none');
  });

  it('returns undefined when no PR matches', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ value: [] }));
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    expect(await provider.getPullRequestForBranch(auth, repo, 'nope')).toBeUndefined();
  });
});

describe('AzureDevOpsProvider.getIssueOrPr', () => {
  it('resolves numeric refs to work items', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({
        id: 123,
        fields: {
          'System.Title': 'Widget crashes',
          'System.State': 'Active',
          'System.TeamProject': 'Web',
          'System.WorkItemType': 'Bug',
          'System.AssignedTo': { id: 'u2', displayName: 'Carol', uniqueName: 'carol@x' },
          'System.ChangedDate': '2026-07-03T00:00:00Z',
        },
      })
    );
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    const issue = (await provider.getIssueOrPr(auth, repo, '#123')) as Issue;
    expect(requests[0].url).toBe(
      'https://dev.azure.com/contoso/_apis/wit/workitems/123?api-version=7.1'
    );
    expect(issue).toMatchObject({
      id: '123',
      key: 'AB#123',
      title: 'Widget crashes',
      url: 'https://dev.azure.com/contoso/Web/_workitems/edit/123',
      state: 'Active',
      type: 'Bug',
      updatedAt: '2026-07-03T00:00:00Z',
    });
    expect(issue.assignee?.username).toBe('carol@x');
  });

  it('returns undefined for 404s and non-numeric refs', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}, 404));
    const provider = new AzureDevOpsProvider({ organization: 'contoso', fetchFn });
    expect(await provider.getIssueOrPr(auth, repo, '9999')).toBeUndefined();
    expect(await provider.getIssueOrPr(auth, repo, 'abc')).toBeUndefined();
  });
});

describe('AzureDevOpsProvider errors and remotes', () => {
  it('throws AuthError on 401 and RateLimitError on 429', async () => {
    const unauthorized = new AzureDevOpsProvider({
      organization: 'contoso',
      fetchFn: stubFetch(() => jsonResponse({}, 401)).fetchFn,
    });
    await expect(unauthorized.getMyPullRequests(auth)).rejects.toBeInstanceOf(AuthError);

    const limited = new AzureDevOpsProvider({
      organization: 'contoso',
      fetchFn: stubFetch(() => jsonResponse({}, 429, { 'Retry-After': '5' })).fetchFn,
    });
    await expect(limited.getMyPullRequests(auth)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('matches dev.azure.com remotes in both https and ssh forms', () => {
    const provider = new AzureDevOpsProvider({
      organization: 'contoso',
      fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
    });
    expect(
      provider.matchesRemote('https://dev.azure.com/contoso/Web/_git/widgets')
    ).toEqual({
      provider: 'azuredevops',
      host: 'dev.azure.com',
      owner: 'contoso/Web',
      name: 'widgets',
    });
    expect(
      provider.matchesRemote('contoso@vs-ssh.visualstudio.com:v3/contoso/Web/widgets')
    ).toEqual({
      provider: 'azuredevops',
      host: 'dev.azure.com',
      owner: 'contoso/Web',
      name: 'widgets',
    });
    expect(provider.matchesRemote('git@github.com:acme/widgets.git')).toBeUndefined();
  });
});
