// The shared provider transport: path encoding, transport-failure wrapping and
// the single status mapping every provider now goes through.

import { describe, expect, it } from 'vitest';
import { ProviderError, RateLimitError } from '../src/errors.js';
import type { FetchLike } from '../src/http.js';
import { p, ProviderClient } from '../src/providers/client.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { FakeClock, jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'test-token' };
const repo = { provider: 'github', host: 'github.com', owner: 'acme', name: 'widgets' };

/** Fetch stub that rejects the way the runtime reports a transport failure. */
function failingFetch(cause: unknown): FetchLike {
  return async () => {
    throw new TypeError('fetch failed', { cause });
  };
}

function codedError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('path encoding', () => {
  it('encodes repository values interpolated into a path', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({}, 404));
    const provider = new GitHubProvider({ fetchFn });
    await provider.getIssueOrPr(auth, { ...repo, owner: '../../evil', name: 'a b' }, '#7');
    expect(requests[0].url).toBe(
      'https://api.github.com/repos/..%2F..%2Fevil/a%20b/issues/7'
    );
  });

  it('does not double-encode a project path GitLab wants as one segment', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse([]));
    const provider = new GitLabProvider({ fetchFn });
    await provider.getPullRequestForBranch(auth, { ...repo, owner: 'group/sub' }, 'feat/x');
    expect(requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fwidgets/merge_requests' +
        '?state=opened&source_branch=feat%2Fx'
    );
  });
});

describe('transport failures', () => {
  it('names the untrusted certificate and keeps the cause', async () => {
    const cause = codedError('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    const provider = new GitLabProvider({
      baseUrl: 'https://git.corp.example',
      fetchFn: failingFetch(cause),
    });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(
      /GitLab could not reach git\.corp\.example: its TLS certificate could not be verified/
    );
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('reports an unresolvable host', async () => {
    const provider = new GitLabProvider({
      baseUrl: 'https://git.corp.example',
      fetchFn: failingFetch(codedError('ENOTFOUND')),
    });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/the host does not resolve/);
  });

  it('reports a refused connection', async () => {
    const provider = new GitLabProvider({
      baseUrl: 'https://git.corp.example',
      fetchFn: failingFetch(codedError('ECONNREFUSED')),
    });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/the connection was refused/);
  });

  it('reports an aborted request as a timeout', async () => {
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const provider = new GitLabProvider({
      baseUrl: 'https://git.corp.example',
      fetchFn: failingFetch(aborted),
    });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/the request timed out/);
  });

  it('falls back to the innermost message for an unrecognized failure', async () => {
    const provider = new GitLabProvider({
      baseUrl: 'https://git.corp.example',
      fetchFn: failingFetch(codedError('ECONNRESET', 'read ECONNRESET')),
    });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/read ECONNRESET/);
  });
});

describe('response cache', () => {
  it('reuses an avatar lookup per email and keeps distinct emails apart', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ avatar_url: 'https://a/hash' }));
    const provider = new GitLabProvider({ fetchFn });
    await provider.getAvatarUrl(auth, 'alice@example.com');
    await provider.getAvatarUrl(auth, 'alice@example.com');
    expect(requests).toHaveLength(1);
    await provider.getAvatarUrl(auth, 'bob@example.com');
    expect(requests).toHaveLength(2);
  });

  it('coalesces concurrent lookups of the same reference into one request', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ id: 900, iid: 7, title: 'x', web_url: 'u', state: 'opened', updated_at: 't' })
    );
    const provider = new GitLabProvider({ fetchFn });
    await Promise.all([
      provider.getIssueOrPr(auth, repo, '#7'),
      provider.getIssueOrPr(auth, repo, '#7'),
    ]);
    expect(requests).toHaveLength(1);
  });

  it('never serves one token a response fetched for another', async () => {
    const { fetchFn, requests } = stubFetch((_, init) =>
      jsonResponse({ avatar_url: init?.headers?.authorization })
    );
    const provider = new GitLabProvider({ fetchFn });
    expect(await provider.getAvatarUrl({ token: 'first' }, 'alice@example.com')).toBe(
      'Bearer first'
    );
    expect(await provider.getAvatarUrl({ token: 'second' }, 'alice@example.com')).toBe(
      'Bearer second'
    );
    expect(requests).toHaveLength(2);
  });

  it('re-requests once the entry has expired', async () => {
    const clock = new FakeClock(0);
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ProviderClient({
      name: 'Test',
      baseUrl: 'https://api.example.com',
      baseUrlLabel: 'Test baseUrl',
      authorize: (a) => `Bearer ${a.token}`,
      fetchFn,
      clock,
    });
    await client.getJsonCached(auth, p`/thing`, 1000);
    clock.advance(999);
    await client.getJsonCached(auth, p`/thing`, 1000);
    expect(requests).toHaveLength(1);
    clock.advance(2);
    await client.getJsonCached(auth, p`/thing`, 1000);
    expect(requests).toHaveLength(2);
  });
});

describe('status mapping', () => {
  it('treats a GitHub 403 carrying the unprefixed remaining header as a rate limit', async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ message: 'rate limited' }, 403, {
        'ratelimit-remaining': '0',
        'ratelimit-reset': '1784000000',
      })
    );
    const provider = new GitHubProvider({ fetchFn });
    const error = await provider.getMyPullRequests(auth).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt?.getTime()).toBe(1_784_000_000_000);
  });
});
