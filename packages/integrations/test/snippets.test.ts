import { describe, expect, it } from 'vitest';
import { AuthError, ProviderError } from '../src/errors.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { BitbucketProvider } from '../src/providers/bitbucket.js';
import { parseGistId, parseGitLabSnippetId, supportsSnippets } from '../src/snippets.js';
import { jsonResponse, stubFetch } from './helpers.js';

const auth = { token: 'test-token' };

describe('parseGistId', () => {
  it('accepts a raw hex gist id', () => {
    expect(parseGistId('aa5a315d61ae9438b18d')).toBe('aa5a315d61ae9438b18d');
  });

  it('parses gist.github.com/<user>/<id> URLs', () => {
    expect(parseGistId('https://gist.github.com/octocat/aa5a315d61ae9438b18d')).toBe(
      'aa5a315d61ae9438b18d'
    );
  });

  it('parses gist.github.com/<id> URLs and ignores #file fragments', () => {
    expect(parseGistId('https://gist.github.com/aa5a315d61ae9438b18d')).toBe(
      'aa5a315d61ae9438b18d'
    );
    expect(
      parseGistId('https://gist.github.com/octocat/aa5a315d61ae9438b18d#file-patch-ggpatch')
    ).toBe('aa5a315d61ae9438b18d');
  });

  it('parses api.github.com/gists/<id> URLs', () => {
    expect(parseGistId('https://api.github.com/gists/aa5a315d61ae9438b18d')).toBe(
      'aa5a315d61ae9438b18d'
    );
  });

  it('rejects non-gist URLs and non-id text', () => {
    expect(parseGistId('https://github.com/acme/widgets/pull/1')).toBeUndefined();
    expect(parseGistId('not a gist')).toBeUndefined();
  });
});

describe('parseGitLabSnippetId', () => {
  it('accepts a raw numeric id', () => {
    expect(parseGitLabSnippetId('12345')).toBe('12345');
  });

  it('parses <host>/-/snippets/<id> URLs', () => {
    expect(parseGitLabSnippetId('https://gitlab.com/-/snippets/12345')).toBe('12345');
  });

  it('parses legacy <host>/snippets/<id> URLs', () => {
    expect(parseGitLabSnippetId('https://gitlab.com/snippets/12345')).toBe('12345');
  });

  it('parses project snippet URLs, including /raw suffixes', () => {
    expect(
      parseGitLabSnippetId('https://gitlab.example.com/group/sub/proj/-/snippets/7/raw')
    ).toBe('7');
  });

  it('rejects URLs without a snippet id', () => {
    expect(parseGitLabSnippetId('https://gitlab.com/acme/widgets')).toBeUndefined();
    expect(parseGitLabSnippetId('https://gitlab.com/-/snippets/')).toBeUndefined();
  });
});

describe('supportsSnippets', () => {
  it('detects the capability on GitHub and GitLab providers', () => {
    expect(supportsSnippets(new GitHubProvider())).toBe(true);
    expect(supportsSnippets(new GitLabProvider())).toBe(true);
  });

  it('is false for providers without snippet support', () => {
    expect(supportsSnippets(new BitbucketProvider())).toBe(false);
    expect(supportsSnippets({})).toBe(false);
  });
});

describe('GitHubProvider snippets (gists)', () => {
  it('creates a secret gist with the expected body shape', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ id: 'aa5a315d61ae9438b18d', html_url: 'https://gist.github.com/o/aa5a315d61ae9438b18d' })
    );
    const provider = new GitHubProvider({ fetchFn });
    const ref = await provider.createSnippet(auth, {
      filename: 'patch.ggpatch',
      content: '{"format":"gitglasses-patch"}',
      description: 'Fix the widget',
      secret: true,
    });

    expect(requests[0].url).toBe('https://api.github.com/gists');
    expect(requests[0].init?.method).toBe('POST');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body).toEqual({
      description: 'Fix the widget',
      public: false,
      files: { 'patch.ggpatch': { content: '{"format":"gitglasses-patch"}' } },
    });
    expect(ref).toEqual({
      id: 'aa5a315d61ae9438b18d',
      url: 'https://gist.github.com/o/aa5a315d61ae9438b18d',
    });
  });

  it('creates a public gist only when secret is explicitly false', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ id: 'x', html_url: 'u' }));
    const provider = new GitHubProvider({ fetchFn });
    await provider.createSnippet(auth, { filename: 'a.txt', content: 'hi', secret: false });
    expect(JSON.parse(requests[0].init?.body ?? '{}').public).toBe(true);
  });

  it('fetches gist content from a gist URL, preferring the .ggpatch file', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({
        files: {
          'readme.md': { content: 'docs' },
          'patch.ggpatch': { content: 'envelope-json' },
        },
      })
    );
    const provider = new GitHubProvider({ fetchFn });
    const content = await provider.getSnippet(
      auth,
      'https://gist.github.com/octocat/aa5a315d61ae9438b18d'
    );
    expect(requests[0].url).toBe('https://api.github.com/gists/aa5a315d61ae9438b18d');
    expect(content).toBe('envelope-json');
  });

  it('follows raw_url when the gist file is truncated', async () => {
    const { fetchFn, requests } = stubFetch((url) => {
      if (url.includes('/gists/')) {
        return jsonResponse({
          files: {
            'patch.ggpatch': {
              content: 'cut',
              truncated: true,
              raw_url: 'https://gist.githubusercontent.com/u/aa5a/raw/x',
            },
          },
        });
      }
      const full = 'the full content';
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => full,
        text: async () => full,
      };
    });
    const provider = new GitHubProvider({ fetchFn });
    const content = await provider.getSnippet(auth, 'aa5a315d61ae9438b18d');
    expect(requests[1].url).toBe('https://gist.githubusercontent.com/u/aa5a/raw/x');
    expect(content).toBe('the full content');
    // raw_url is body-supplied, so it must never carry the token.
    expect(requests[1].headers?.authorization ?? requests[1].headers?.Authorization).toBeUndefined();
  });

  // The body could name any host; following it with credentials attached was
  // an exfiltration path that the runtime's redirect protection cannot catch,
  // because this is a fresh request rather than a redirect.
  it('refuses a raw_url pointing at an unexpected host', async () => {
    const { fetchFn, requests } = stubFetch((url) => {
      if (url.includes('/gists/')) {
        return jsonResponse({
          files: {
            'patch.ggpatch': {
              content: 'cut',
              truncated: true,
              raw_url: 'https://attacker.example/collect',
            },
          },
        });
      }
      return jsonResponse({});
    });
    const provider = new GitHubProvider({ fetchFn });
    await expect(provider.getSnippet(auth, 'aa5a315d61ae9438b18d')).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(requests.map((r) => r.url)).not.toContain('https://attacker.example/collect');
  });

  it('throws AuthError on 401 and ProviderError on malformed references', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'bad' }, 401));
    const provider = new GitHubProvider({ fetchFn });
    await expect(
      provider.createSnippet(auth, { filename: 'a', content: 'b' })
    ).rejects.toBeInstanceOf(AuthError);
    await expect(provider.getSnippet(auth, 'https://example.com/nope')).rejects.toBeInstanceOf(
      ProviderError
    );
  });
});

describe('GitLabProvider snippets', () => {
  it('creates a private snippet by default with the files array shape', async () => {
    const { fetchFn, requests } = stubFetch(() =>
      jsonResponse({ id: 42, web_url: 'https://gitlab.com/-/snippets/42' })
    );
    const provider = new GitLabProvider({ fetchFn });
    const ref = await provider.createSnippet(auth, {
      filename: 'patch.ggpatch',
      content: 'envelope',
      description: 'Fix the widget',
    });

    expect(requests[0].url).toBe('https://gitlab.com/api/v4/snippets');
    expect(requests[0].init?.method).toBe('POST');
    const body = JSON.parse(requests[0].init?.body ?? '{}');
    expect(body.visibility).toBe('private');
    expect(body.files).toEqual([{ file_path: 'patch.ggpatch', content: 'envelope' }]);
    expect(ref).toEqual({ id: '42', url: 'https://gitlab.com/-/snippets/42' });
  });

  it('honors an explicit visibility override', async () => {
    const { fetchFn, requests } = stubFetch(() => jsonResponse({ id: 1, web_url: 'u' }));
    const provider = new GitLabProvider({ fetchFn });
    await provider.createSnippet(auth, { filename: 'a', content: 'b', visibility: 'public' });
    expect(JSON.parse(requests[0].init?.body ?? '{}').visibility).toBe('public');
  });

  it('fetches raw snippet content from any recognized URL form', async () => {
    const { fetchFn, requests } = stubFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => 'raw',
      text: async () => 'raw text',
    }));
    const provider = new GitLabProvider({ fetchFn });
    const content = await provider.getSnippet(auth, 'https://gitlab.com/-/snippets/42');
    expect(requests[0].url).toBe('https://gitlab.com/api/v4/snippets/42/raw');
    expect(requests[0].init?.headers?.authorization).toBe('Bearer test-token');
    expect(content).toBe('raw text');
  });

  it('throws AuthError on 401', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ message: 'bad' }, 401));
    const provider = new GitLabProvider({ fetchFn });
    await expect(provider.getSnippet(auth, '42')).rejects.toBeInstanceOf(AuthError);
  });
});
