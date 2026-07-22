import { describe, expect, it } from 'vitest';
import { AuthError, ProviderError, RateLimitError } from '../src/errors.js';
import type { Issue } from '../src/models.js';
import { LinearProvider } from '../src/providers/linear.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'lin_api_key' };

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'uuid-1',
    identifier: 'ENG-42',
    title: 'Fix login',
    url: 'https://linear.app/acme/issue/ENG-42/fix-login',
    branchName: 'alice/eng-42-fix-login',
    updatedAt: '2026-07-02T00:00:00Z',
    state: { name: 'In Progress', type: 'started' },
    assignee: { id: 'u1', name: 'Alice A', displayName: 'alice' },
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'uuid-1',
    key: 'ENG-42',
    title: 'Fix login',
    url: 'https://linear.app/acme/issue/ENG-42/fix-login',
    state: 'In Progress',
    assignee: { id: 'u1', username: 'alice', name: 'Alice A' },
    updatedAt: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

describe('LinearProvider.getMyIssues', () => {
  it('queries viewer.assignedIssues filtering out finished states and maps nodes', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ data: { viewer: { assignedIssues: { nodes: [issueNode()] } } } })
    );
    const provider = new LinearProvider({ fetchFn });
    const issues = await provider.getMyIssues(auth, { limit: 25 });

    expect(requests[0].url).toBe('https://api.linear.app/graphql');
    // Personal API keys go in the Authorization header verbatim.
    expect(requests[0].init?.headers?.authorization).toBe('lin_api_key');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body.query).toContain('assignedIssues');
    expect(body.query).toContain('nin: ["completed", "canceled"]');
    expect(body.query).toContain('branchName');
    expect(body.variables).toEqual({ first: 25 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: 'uuid-1',
      key: 'ENG-42',
      title: 'Fix login',
      url: 'https://linear.app/acme/issue/ENG-42/fix-login',
      state: 'In Progress',
      assignee: { id: 'u1', username: 'alice', name: 'Alice A' },
      updatedAt: '2026-07-02T00:00:00Z',
      branchName: 'alice/eng-42-fix-login',
    });
  });

  it('leaves branchName unset when the API returns null', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({
        data: { viewer: { assignedIssues: { nodes: [issueNode({ branchName: null })] } } },
      })
    );
    const provider = new LinearProvider({ fetchFn });
    const [issue] = await provider.getMyIssues(auth);
    expect(issue.branchName).toBeUndefined();
  });
});

describe('LinearProvider.getIssue', () => {
  it('resolves an issue by identifier', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ data: { issue: issueNode() } })
    );
    const provider = new LinearProvider({ fetchFn });
    const issue = await provider.getIssue(auth, 'ENG-42');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body.variables).toEqual({ id: 'ENG-42' });
    expect(issue?.key).toBe('ENG-42');
  });

  it('returns undefined when the issue is null or reported as not found', async () => {
    const missing = new LinearProvider({
      fetchFn: stubFetch(() => jsonResponse({ data: { issue: null } })).fetchFn,
    });
    expect(await missing.getIssue(auth, 'ENG-999')).toBeUndefined();

    const notFound = new LinearProvider({
      fetchFn: stubFetch(() =>
        jsonResponse({ errors: [{ message: 'Entity not found: Issue' }] })
      ).fetchFn,
    });
    expect(await notFound.getIssue(auth, 'ENG-999')).toBeUndefined();
  });

  it('surfaces other GraphQL errors as ProviderError', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ errors: [{ message: 'Something exploded' }] })
    );
    const provider = new LinearProvider({ fetchFn });
    const error = await provider.getIssue(auth, 'ENG-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/Something exploded/);
  });
});

describe('LinearProvider.suggestBranchName', () => {
  const provider = new LinearProvider({
    fetchFn: stubFetch(() => jsonResponse({})).fetchFn,
  });

  it('uses the API-provided branchName verbatim when present', () => {
    const issue = makeIssue({ branchName: 'alice/eng-42-fix-login' });
    expect(provider.suggestBranchName(issue)).toBe('alice/eng-42-fix-login');
  });

  it('falls back to <username>/<identifier>-<slug>', () => {
    const issue = makeIssue({ branchName: undefined, title: 'Fix Login: OAuth!' });
    expect(provider.suggestBranchName(issue)).toBe('alice/eng-42-fix-login-oauth');
  });

  it('omits the username segment when there is no assignee', () => {
    const issue = makeIssue({ branchName: undefined, assignee: undefined });
    expect(provider.suggestBranchName(issue)).toBe('eng-42-fix-login');
  });
});

describe('LinearProvider errors', () => {
  it('throws AuthError on 401', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    const provider = new LinearProvider({ fetchFn });
    await expect(provider.getMyIssues(auth)).rejects.toBeInstanceOf(AuthError);
  });

  it('throws RateLimitError on 429 with the reset timestamp header', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ error: 'ratelimited' }, 429, {
        'X-RateLimit-Requests-Reset': '1784000000000',
      })
    );
    const provider = new LinearProvider({ fetchFn });
    const error = await provider.getMyIssues(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt?.getTime()).toBe(1_784_000_000_000);
  });
});

describe('LinearProvider.createBranchLink', () => {
  it('resolves without any API call (Linear auto-links by branch name)', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({}));
    const provider = new LinearProvider({ fetchFn });
    await expect(
      provider.createBranchLink(auth, makeIssue(), { name: 'alice/eng-42-fix-login' })
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
