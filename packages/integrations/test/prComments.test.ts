import { describe, expect, it } from 'vitest';
import { supportsPrComments } from '../src/hostingProvider.js';
import { BitbucketProvider } from '../src/providers/bitbucket.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'test-token' };
const pr = {
  repo: { provider: 'github', host: 'github.com', owner: 'acme', name: 'widgets' },
  number: 7,
};

describe('supportsPrComments', () => {
  it('detects the capability on GitHub and GitLab providers', () => {
    expect(supportsPrComments(new GitHubProvider())).toBe(true);
    expect(supportsPrComments(new GitLabProvider())).toBe(true);
  });

  it('is false for providers without the method and for plain objects', () => {
    expect(supportsPrComments(new BitbucketProvider())).toBe(false);
    expect(supportsPrComments({})).toBe(false);
  });
});

describe('GitHubProvider.createPullRequestComment', () => {
  it('POSTs the body to the issue-comments endpoint and returns the comment URL', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-99' })
    );
    const provider = new GitHubProvider({ fetchFn });
    const result = await provider.createPullRequestComment(auth, pr, 'Open this patch: link');

    expect(requests[0].url).toBe('https://api.github.com/repos/acme/widgets/issues/7/comments');
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(requests[0].init?.body ?? '{}')).toEqual({ body: 'Open this patch: link' });
    expect(result.url).toBe('https://github.com/acme/widgets/pull/7#issuecomment-99');
  });

  it('falls back to the PR URL when the response has no html_url', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}));
    const provider = new GitHubProvider({ fetchFn });
    const result = await provider.createPullRequestComment(auth, pr, 'b');
    expect(result.url).toBe('https://github.com/acme/widgets/pull/7');
  });
});

describe('GitLabProvider.createPullRequestComment', () => {
  const glPr = {
    repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'acme', name: 'widgets' },
    number: 5,
  };

  it('POSTs the body as an MR note and returns a note-anchored URL', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ id: 42 }));
    const provider = new GitLabProvider({ fetchFn });
    const result = await provider.createPullRequestComment(auth, glPr, 'Open this patch: link');

    expect(requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/5/notes'
    );
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(requests[0].init?.body ?? '{}')).toEqual({ body: 'Open this patch: link' });
    expect(result.url).toBe('https://gitlab.com/acme/widgets/-/merge_requests/5#note_42');
  });

  it('falls back to the MR URL when the response has no note id', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}));
    const provider = new GitLabProvider({ fetchFn });
    const result = await provider.createPullRequestComment(auth, glPr, 'b');
    expect(result.url).toBe('https://gitlab.com/acme/widgets/-/merge_requests/5');
  });
});
