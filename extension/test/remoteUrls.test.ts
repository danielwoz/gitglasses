import { describe, expect, it } from 'vitest';
import type { RepoDescriptor } from '@gitglasses/integrations';
import { buildRemoteUrl, supportsRemoteUrls } from '../src/integrations/remoteUrls';

const gh: RepoDescriptor = {
  provider: 'github',
  host: 'github.com',
  owner: 'danielwoz',
  name: 'gitglasses',
};
const gl: RepoDescriptor = { ...gh, provider: 'gitlab', host: 'gitlab.com' };
const bb: RepoDescriptor = { ...gh, provider: 'bitbucket', host: 'bitbucket.org' };

describe('supportsRemoteUrls', () => {
  // Every id that can actually reach buildRemoteUrl: DEFAULT_HOSTS, the ids
  // Add Integration writes, and the service's github-enterprise special case.
  it('covers every provider id that can reach it', () => {
    for (const id of [
      'github',
      'github-enterprise',
      'gitlab',
      'bitbucket',
      'bitbucketDC',
      'azuredevops',
    ]) {
      expect(supportsRemoteUrls(id), `${id} should be supported`).toBe(true);
    }
  });

  it('does not carry ids nothing emits', () => {
    expect(supportsRemoteUrls('gitlab-self-hosted')).toBe(false);
    expect(supportsRemoteUrls('bitbucket-server')).toBe(false);
    expect(supportsRemoteUrls('nonsense')).toBe(false);
  });
});

describe('buildRemoteUrl', () => {
  it('returns undefined for an unknown provider rather than guessing', () => {
    expect(buildRemoteUrl('nonsense', gh, { kind: 'repo' })).toBeUndefined();
  });

  it('builds repo, branch and commit urls for github', () => {
    expect(buildRemoteUrl('github', gh, { kind: 'repo' })).toBe(
      'https://github.com/danielwoz/gitglasses',
    );
    expect(buildRemoteUrl('github', gh, { kind: 'branch', branch: 'main' })).toBe(
      'https://github.com/danielwoz/gitglasses/tree/main',
    );
    expect(buildRemoteUrl('github', gh, { kind: 'commit', sha: 'abc123' })).toBe(
      'https://github.com/danielwoz/gitglasses/commit/abc123',
    );
  });

  it('inserts gitlab’s /- infix', () => {
    expect(buildRemoteUrl('gitlab', gl, { kind: 'commit', sha: 'abc123' })).toBe(
      'https://gitlab.com/danielwoz/gitglasses/-/commit/abc123',
    );
    expect(
      buildRemoteUrl('gitlab', gl, { kind: 'file', path: 'src/a.ts', ref: 'main' }),
    ).toBe('https://gitlab.com/danielwoz/gitglasses/-/blob/main/src/a.ts');
  });

  it('uses each forge’s line-fragment syntax', () => {
    const file = { kind: 'file', path: 'src/a.ts', ref: 'main' } as const;
    expect(buildRemoteUrl('github', gh, { ...file, startLine: 5, endLine: 9 })).toMatch(
      /#L5-L9$/,
    );
    expect(buildRemoteUrl('gitlab', gl, { ...file, startLine: 5, endLine: 9 })).toMatch(
      /#L5-9$/,
    );
    expect(buildRemoteUrl('bitbucket', bb, { ...file, startLine: 5, endLine: 9 })).toMatch(
      /#lines-5:9$/,
    );
  });

  it('collapses a single-line range', () => {
    const file = { kind: 'file', path: 'a.ts', ref: 'main', startLine: 7, endLine: 7 } as const;
    expect(buildRemoteUrl('github', gh, file)).toMatch(/#L7$/);
    expect(buildRemoteUrl('bitbucket', bb, file)).toMatch(/#lines-7$/);
  });

  it('treats a start line without an end as a single line', () => {
    expect(
      buildRemoteUrl('github', gh, { kind: 'file', path: 'a.ts', ref: 'main', startLine: 3 }),
    ).toMatch(/#L3$/);
  });

  it('orders an inverted range and floors below one', () => {
    const base = { kind: 'file', path: 'a.ts', ref: 'main' } as const;
    expect(buildRemoteUrl('github', gh, { ...base, startLine: 9, endLine: 5 })).toMatch(/#L9$/);
    expect(buildRemoteUrl('github', gh, { ...base, startLine: 0, endLine: 0 })).toMatch(/#L1$/);
  });

  it('omits the fragment when no range is given', () => {
    expect(buildRemoteUrl('github', gh, { kind: 'file', path: 'a.ts', ref: 'main' })).toBe(
      'https://github.com/danielwoz/gitglasses/blob/main/a.ts',
    );
  });

  it('encodes segments but keeps path separators', () => {
    expect(
      buildRemoteUrl('github', gh, { kind: 'file', path: 'src/my file.ts', ref: 'feat/a b' }),
    ).toBe('https://github.com/danielwoz/gitglasses/blob/feat/a%20b/src/my%20file.ts');
  });

  it('keeps a multi-segment owner intact', () => {
    const nested: RepoDescriptor = { ...gl, owner: 'group/subgroup' };
    expect(buildRemoteUrl('gitlab', nested, { kind: 'repo' })).toBe(
      'https://gitlab.com/group/subgroup/gitglasses',
    );
  });

  it('falls back to the repo url when the target is empty', () => {
    const base = 'https://github.com/danielwoz/gitglasses';
    expect(buildRemoteUrl('github', gh, { kind: 'branch', branch: '' })).toBe(base);
    expect(buildRemoteUrl('github', gh, { kind: 'commit', sha: '' })).toBe(base);
    expect(buildRemoteUrl('github', gh, { kind: 'file', path: '', ref: 'main' })).toBe(base);
  });

  it('defaults an empty ref to HEAD', () => {
    expect(buildRemoteUrl('github', gh, { kind: 'file', path: 'a.ts', ref: '' })).toBe(
      'https://github.com/danielwoz/gitglasses/blob/HEAD/a.ts',
    );
  });

  it('routes github-enterprise to the github shape on its own host', () => {
    const ghe: RepoDescriptor = { ...gh, host: 'git.example.com' };
    expect(buildRemoteUrl('github-enterprise', ghe, { kind: 'commit', sha: 'a1' })).toBe(
      'https://git.example.com/danielwoz/gitglasses/commit/a1',
    );
  });

  // Data Center's layout is /projects/<KEY>/repos/<slug>/browse, not Cloud's
  // /<owner>/<repo>/src.
  describe('bitbucket data center', () => {
    const dc: RepoDescriptor = {
      provider: 'bitbucketDC',
      host: 'git.corp.example',
      owner: 'ENG',
      name: 'gitglasses',
    };

    it('uses the projects/repos/browse layout', () => {
      expect(buildRemoteUrl('bitbucketDC', dc, { kind: 'repo' })).toBe(
        'https://git.corp.example/projects/ENG/repos/gitglasses/browse',
      );
    });

    it('puts the ref in ?at= and the line in the fragment', () => {
      expect(
        buildRemoteUrl('bitbucketDC', dc, {
          kind: 'file',
          path: 'src/a.ts',
          ref: 'main',
          startLine: 5,
          endLine: 9,
        }),
      ).toBe(
        'https://git.corp.example/projects/ENG/repos/gitglasses/browse/src/a.ts?at=main#5-9',
      );
    });

    it('links a commit under /commits', () => {
      expect(buildRemoteUrl('bitbucketDC', dc, { kind: 'commit', sha: 'abc123' })).toBe(
        'https://git.corp.example/projects/ENG/repos/gitglasses/commits/abc123',
      );
    });
  });

  describe('azure devops', () => {
    const az: RepoDescriptor = {
      provider: 'azuredevops',
      host: 'dev.azure.com',
      owner: 'contoso/ProjectX',
      name: 'gitglasses',
    };

    it('addresses the repo through _git', () => {
      expect(buildRemoteUrl('azuredevops', az, { kind: 'repo' })).toBe(
        'https://dev.azure.com/contoso/ProjectX/_git/gitglasses',
      );
    });

    it('passes path, version and line range as query parameters', () => {
      const url = buildRemoteUrl('azuredevops', az, {
        kind: 'file',
        path: 'src/a.ts',
        ref: 'main',
        startLine: 5,
        endLine: 9,
      });
      expect(url).toContain('/_git/gitglasses?');
      expect(url).toContain('path=%2Fsrc%2Fa.ts');
      expect(url).toContain('version=GBmain');
      expect(url).toContain('line=5');
      expect(url).toContain('lineEnd=9');
    });
  });
});
