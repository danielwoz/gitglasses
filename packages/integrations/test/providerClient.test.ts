// The shared provider transport: path encoding, transport-failure wrapping and
// the single status mapping every provider now goes through.

import { describe, expect, it } from 'vitest';
import { ProviderError, RateLimitError } from '../src/errors.js';
import type { FetchLike } from '../src/http.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { jsonResponse, stubFetch } from './helpers.js';

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
