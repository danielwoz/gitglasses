import { describe, expect, it } from 'vitest';
import { AuthError, NotSupportedError, RateLimitError } from '../src/errors.js';
import type { Issue } from '../src/models.js';
import { JiraProvider } from '../src/providers/jira.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'api-token', username: 'alice@example.com' };

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10001',
    key: 'PROJ-42',
    fields: {
      summary: 'Crash on login',
      status: { name: 'In Progress' },
      assignee: {
        accountId: 'acct-1',
        displayName: 'Alice',
        emailAddress: 'alice@example.com',
        avatarUrls: { '48x48': 'https://a/alice' },
      },
      updated: '2026-07-02T00:00:00Z',
      issuetype: { name: 'Bug' },
    },
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '10001',
    key: 'PROJ-42',
    title: 'Crash on login',
    url: 'https://acme.atlassian.net/browse/PROJ-42',
    state: 'In Progress',
    updatedAt: '2026-07-02T00:00:00Z',
    type: 'Bug',
    ...overrides,
  };
}

describe('JiraProvider.getMyIssues', () => {
  it('POSTs the JQL search and maps issues', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ issues: [issuePayload()] })
    );
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    const issues = await provider.getMyIssues(auth, { limit: 10 });

    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(requests[0].init?.method).toBe('POST');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body.jql).toBe(
      'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
    );
    expect(body.fields).toEqual(['summary', 'status', 'assignee', 'updated', 'issuetype']);
    expect(body.maxResults).toBe(10);
    // email:token basic auth
    expect(requests[0].init?.headers?.authorization).toBe(
      'Basic YWxpY2VAZXhhbXBsZS5jb206YXBpLXRva2Vu'
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: '10001',
      key: 'PROJ-42',
      title: 'Crash on login',
      url: 'https://acme.atlassian.net/browse/PROJ-42',
      state: 'In Progress',
      assignee: {
        id: 'acct-1',
        username: 'alice@example.com',
        name: 'Alice',
        avatarUrl: 'https://a/alice',
      },
      updatedAt: '2026-07-02T00:00:00Z',
      type: 'Bug',
    });
  });

  it('throws AuthError without the account email in AuthContext.username', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ issues: [] }));
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    await expect(provider.getMyIssues({ token: 'api-token' })).rejects.toBeInstanceOf(AuthError);
    expect(requests).toHaveLength(0);
  });
});

describe('JiraProvider.getIssue', () => {
  it('fetches an issue by key with the mapped fields', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse(issuePayload()));
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    const issue = await provider.getIssue(auth, 'PROJ-42');
    expect(requests[0].url).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/PROJ-42?fields=summary,status,assignee,updated,issuetype'
    );
    expect(issue?.key).toBe('PROJ-42');
    expect(issue?.type).toBe('Bug');
  });

  it('returns undefined on 404', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ errorMessages: ['not found'] }, 404));
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    expect(await provider.getIssue(auth, 'PROJ-999')).toBeUndefined();
  });
});

describe('JiraProvider.suggestBranchName', () => {
  const provider = new JiraProvider({
    site: 'acme',
    fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
  });

  it('uses fix/ for bugs and feat/ otherwise', () => {
    expect(provider.suggestBranchName(makeIssue())).toBe('fix/PROJ-42-crash-on-login');
    expect(provider.suggestBranchName(makeIssue({ type: 'Story' }))).toBe(
      'feat/PROJ-42-crash-on-login'
    );
    expect(provider.suggestBranchName(makeIssue({ type: undefined }))).toBe(
      'feat/PROJ-42-crash-on-login'
    );
  });

  it('trims long summaries to 40 chars without a trailing dash', () => {
    const issue = makeIssue({
      type: 'Task',
      title: 'Refactor the authentication middleware to support rotating refresh tokens',
    });
    const name = provider.suggestBranchName(issue);
    const slug = name.replace('feat/PROJ-42-', '');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(name).toBe('feat/PROJ-42-refactor-the-authentication-middleware-t');
  });

  it('collapses unicode and punctuation into single dashes', () => {
    const issue = makeIssue({ type: 'Story', title: 'Café löschen — 100% (again!)' });
    expect(provider.suggestBranchName(issue)).toBe('feat/PROJ-42-caf-l-schen-100-again');
  });

  it('falls back to the bare key when the summary has no usable characters', () => {
    const issue = makeIssue({ type: 'Story', title: '!!! ***' });
    expect(provider.suggestBranchName(issue)).toBe('feat/PROJ-42');
  });
});

describe('JiraProvider errors and autolinks', () => {
  it('throws AuthError on 401 and RateLimitError on 429', async () => {
    const unauthorized = new JiraProvider({
      site: 'acme',
      fetchFn: stubFetch(() => jsonResponse({}, 401)).fetchFn,
    });
    await expect(unauthorized.getMyIssues(auth)).rejects.toBeInstanceOf(AuthError);

    const limited = new JiraProvider({
      site: 'acme',
      fetchFn: stubFetch(() => jsonResponse({}, 429, { 'Retry-After': '12' })).fetchFn,
    });
    await expect(limited.getMyIssues(auth)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('exposes an issue-key autolink pattern bound to the site', () => {
    const provider = new JiraProvider({
      baseUrl: 'https://jira.corp.example',
      fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
    });
    expect(provider.autolinkPattern).toEqual({
      regex: '([A-Z][A-Z0-9]+-\\d+)',
      urlTemplate: 'https://jira.corp.example/browse/$1',
      title: 'Jira issue',
    });
    const regex = new RegExp(provider.autolinkPattern.regex);
    expect(regex.test('PROJ-42')).toBe(true);
    expect(regex.test('A2X-9')).toBe(true);
    expect(regex.test('lowercase-42')).toBe(false);
  });
});

describe('JiraProvider.createBranchLink', () => {
  it('POSTs a remote link titled after the branch to the issue', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ id: 10000 }, 201));
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    await provider.createBranchLink(auth, makeIssue(), {
      name: 'fix/PROJ-42-crash-on-login',
      url: 'https://github.com/acme/widgets/tree/fix/PROJ-42-crash-on-login',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-42/remotelink');
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(requests[0].init?.body ?? '{}')).toEqual({
      object: {
        url: 'https://github.com/acme/widgets/tree/fix/PROJ-42-crash-on-login',
        title: 'branch: fix/PROJ-42-crash-on-login',
      },
    });
  });

  it('throws NotSupportedError without calling the API when the branch has no URL', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({}));
    const provider = new JiraProvider({ site: 'acme', fetchFn });
    const attempt = provider.createBranchLink(auth, makeIssue(), { name: 'fix/PROJ-42' });
    await expect(attempt).rejects.toBeInstanceOf(NotSupportedError);
    await expect(attempt).rejects.toMatchObject({ message: 'branch URL required' });
    expect(requests).toHaveLength(0);
  });
});
