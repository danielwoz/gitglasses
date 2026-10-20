import { describe, expect, it } from 'vitest';
import {
  orderedRemoteUrls,
  parseGitConfig,
  parseGitConfigRemotes,
  pullRequestRemotes,
} from '../src/integrations/gitConfig';

describe('parseGitConfigRemotes', () => {
  it('parses multiple remotes with their urls', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = git@github.com:acme/widgets.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "upstream"]',
      '\turl = https://github.com/other/widgets.git',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\n');
    expect(parseGitConfigRemotes(config)).toEqual([
      { name: 'origin', url: 'git@github.com:acme/widgets.git' },
      { name: 'upstream', url: 'https://github.com/other/widgets.git' },
    ]);
  });

  it('records pushurl separately and keeps the first fetch url', () => {
    const config = [
      '[remote "origin"]',
      '\turl = https://github.com/acme/widgets.git',
      '\turl = https://mirror.example/acme/widgets.git',
      '\tpushurl = git@github.com:acme/widgets.git',
    ].join('\n');
    expect(parseGitConfigRemotes(config)).toEqual([
      {
        name: 'origin',
        url: 'https://github.com/acme/widgets.git',
        pushUrl: 'git@github.com:acme/widgets.git',
      },
    ]);
  });

  it('returns nothing for a config without remotes', () => {
    expect(parseGitConfigRemotes('[core]\n\tbare = false\n')).toEqual([]);
    expect(parseGitConfigRemotes('')).toEqual([]);
  });

  it('ignores comments and unquotes quoted values', () => {
    const config = [
      '[remote "origin"]',
      '\t# a comment',
      '\t; another comment',
      '\turl = "https://github.com/acme/widgets.git"',
    ].join('\n');
    expect(parseGitConfigRemotes(config)).toEqual([
      { name: 'origin', url: 'https://github.com/acme/widgets.git' },
    ]);
  });
});

describe('orderedRemoteUrls', () => {
  it('prefers origin, then upstream, then the rest', () => {
    const remotes = [
      { name: 'fork', url: 'https://example.com/fork.git' },
      { name: 'upstream', url: 'https://example.com/upstream.git' },
      { name: 'origin', url: 'https://example.com/origin.git' },
    ];
    expect(orderedRemoteUrls(remotes)).toEqual([
      'https://example.com/origin.git',
      'https://example.com/upstream.git',
      'https://example.com/fork.git',
    ]);
  });

  it('falls back to pushurl and skips remotes with no url at all', () => {
    const remotes = [
      { name: 'origin', pushUrl: 'git@example.com:a/b.git' },
      { name: 'broken' },
    ];
    expect(orderedRemoteUrls(remotes)).toEqual(['git@example.com:a/b.git']);
  });
});

describe('parseGitConfig', () => {
  it('reads branch tracking and remote.pushDefault', () => {
    const config = [
      '[remote "origin"]',
      '\turl = git@github.com:alice/widgets.git',
      '[remote]',
      '\tpushDefault = origin',
      '[branch "feature/x"]',
      '\tremote = upstream',
      '\tmerge = refs/heads/main',
      '\tpushRemote = fork',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\n');
    const summary = parseGitConfig(config);
    expect(summary.pushDefault).toBe('origin');
    expect(summary.branches.get('feature/x')).toEqual({
      remote: 'upstream',
      merge: 'refs/heads/main',
      pushRemote: 'fork',
    });
    expect(summary.branches.get('main')).toEqual({ remote: 'origin' });
    expect(summary.remotes).toEqual([{ name: 'origin', url: 'git@github.com:alice/widgets.git' }]);
  });
});

describe('pullRequestRemotes', () => {
  const remotes = (...names: string[]) =>
    names.map((name) => ({ name, url: `https://github.com/${name}/widgets.git` }));

  it('looks in origin for a branch pushed there, when there is no upstream', () => {
    const plan = pullRequestRemotes(
      {
        remotes: remotes('origin'),
        branches: new Map([['fix', { remote: 'origin', merge: 'refs/heads/fix' }]]),
      },
      'fix',
    );
    expect(plan?.headRemote.name).toBe('origin');
    expect(plan?.headBranch).toBe('fix');
    expect(plan?.baseRemotes.map((r) => r.name)).toEqual(['origin']);
  });

  it('asks upstream first for a fork contributor pushing to origin', () => {
    const plan = pullRequestRemotes(
      { remotes: remotes('origin', 'upstream'), branches: new Map() },
      'fix',
    );
    expect(plan?.headRemote.name).toBe('origin');
    expect(plan?.baseRemotes.map((r) => r.name)).toEqual(['upstream', 'origin']);
  });

  it("follows git's push precedence and the tracked branch name", () => {
    const config = {
      remotes: remotes('origin', 'upstream', 'fork'),
      branches: new Map([
        ['local-name', { remote: 'fork', merge: 'refs/heads/remote-name' }],
        ['triangular', { remote: 'upstream', merge: 'refs/heads/main', pushRemote: 'fork' }],
      ]),
      pushDefault: 'origin',
    };
    const tracked = pullRequestRemotes({ ...config, pushDefault: undefined }, 'local-name');
    expect(tracked?.headRemote.name).toBe('fork');
    expect(tracked?.headBranch).toBe('remote-name');

    // Pushes go to the push remote under the local name, not to the branch
    // it pulls from.
    const triangular = pullRequestRemotes(config, 'triangular');
    expect(triangular?.headRemote.name).toBe('fork');
    expect(triangular?.headBranch).toBe('triangular');
    expect(triangular?.baseRemotes.map((r) => r.name)).toEqual(['upstream', 'fork']);

    expect(pullRequestRemotes(config, 'untracked')?.headRemote.name).toBe('origin');
  });

  it('has nothing to look in without remotes', () => {
    expect(pullRequestRemotes({ remotes: [], branches: new Map() }, 'main')).toBeUndefined();
  });
});
