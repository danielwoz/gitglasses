import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.js';
import { supportsReviewSuggestions } from '../src/hostingProvider.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { jsonResponse, makePr, stubFetch } from './helpers.js';

const auth = { token: 'test-token' };

describe('supportsReviewSuggestions', () => {
  it('detects the capability on GitHub and GitLab providers', () => {
    expect(supportsReviewSuggestions(new GitHubProvider())).toBe(true);
    expect(supportsReviewSuggestions(new GitLabProvider())).toBe(true);
  });

  it('is false for plain objects', () => {
    expect(supportsReviewSuggestions({})).toBe(false);
  });
});

describe('GitHubProvider.createReviewSuggestion', () => {
  it('posts a single-line REST review comment anchored to the head sha', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ html_url: 'https://github.com/acme/widgets/pull/1#discussion_r9' })
    );
    const provider = new GitHubProvider({ fetchFn });
    const pr = makePr({ headSha: 'headsha123' });
    const result = await provider.createReviewSuggestion(auth, pr, {
      path: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      body: '```suggestion\nfixed line\n```',
    });

    expect(requests[0].url).toBe('https://api.github.com/repos/acme/widgets/pulls/1/comments');
    expect(requests[0].init?.method).toBe('POST');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body).toEqual({
      body: '```suggestion\nfixed line\n```',
      commit_id: 'headsha123',
      path: 'src/app.ts',
      line: 10,
      side: 'RIGHT',
    });
    expect(result.url).toBe('https://github.com/acme/widgets/pull/1#discussion_r9');
  });

  it('adds start_line/start_side for multi-line ranges', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ html_url: 'u' }));
    const provider = new GitHubProvider({ fetchFn });
    await provider.createReviewSuggestion(auth, makePr(), {
      path: 'src/app.ts',
      startLine: 4,
      endLine: 7,
      body: 'b',
    });
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body.start_line).toBe(4);
    expect(body.start_side).toBe('RIGHT');
    expect(body.line).toBe(7);
  });

  it('surfaces a 422 (lines not in the PR diff) as a ProviderError with status', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'Validation Failed' }, 422));
    const provider = new GitHubProvider({ fetchFn });
    const attempt = provider.createReviewSuggestion(auth, makePr(), {
      path: 'src/app.ts',
      startLine: 1,
      endLine: 1,
      body: 'b',
    });
    await expect(attempt).rejects.toMatchObject({ name: 'ProviderError', status: 422 });
  });
});

describe('GitLabProvider.createReviewSuggestion', () => {
  const glPr = makePr({
    number: 5,
    url: 'https://gitlab.com/acme/widgets/-/merge_requests/5',
    repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'acme', name: 'widgets' },
  });
  const diffRefs = { base_sha: 'base1', start_sha: 'start1', head_sha: 'head1' };

  it('fetches diff refs, then posts a discussion with a text position', async () => {
    const { fetchFn, requests } = stubFetch((url) => {
      if (url.endsWith('/merge_requests/5')) {
        return jsonResponse({ diff_refs: diffRefs });
      }
      return jsonResponse({ id: 'disc1', notes: [{ id: 99 }] });
    });
    const provider = new GitLabProvider({ fetchFn });
    const result = await provider.createReviewSuggestion(auth, glPr, {
      path: 'src/app.ts',
      startLine: 4,
      endLine: 7,
      body: '```suggestion:-3+0\nfixed\n```',
    });

    expect(requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/5'
    );
    expect(requests[1].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/5/discussions'
    );
    const body = JSON.parse(requests[1].init?.body ?? '{}');
    expect(body.body).toBe('```suggestion:-3+0\nfixed\n```');
    expect(body.position).toEqual({
      position_type: 'text',
      base_sha: 'base1',
      start_sha: 'start1',
      head_sha: 'head1',
      old_path: 'src/app.ts',
      new_path: 'src/app.ts',
      new_line: 7,
    });
    expect(result.url).toBe('https://gitlab.com/acme/widgets/-/merge_requests/5#note_99');
  });

  it('fails cleanly when the MR has no diff refs', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}));
    const provider = new GitLabProvider({ fetchFn });
    await expect(
      provider.createReviewSuggestion(auth, glPr, {
        path: 'a',
        startLine: 1,
        endLine: 1,
        body: 'b',
      })
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('surfaces a 400 (line not in the MR diff) as a ProviderError with status', async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.endsWith('/merge_requests/5')) {
        return jsonResponse({ diff_refs: diffRefs });
      }
      return jsonResponse({ message: 'line_code is invalid' }, 400);
    });
    const provider = new GitLabProvider({ fetchFn });
    const attempt = provider.createReviewSuggestion(auth, glPr, {
      path: 'a',
      startLine: 1,
      endLine: 1,
      body: 'b',
    });
    await expect(attempt).rejects.toMatchObject({ name: 'ProviderError', status: 400 });
  });
});
