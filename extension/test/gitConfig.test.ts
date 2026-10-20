import { describe, expect, it } from 'vitest';
import {
  globalGitConfigPaths,
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

  it('reads the pull request the GitHub Pull Requests extension recorded', () => {
    const summary = parseGitConfig(
      [
        '[branch "pr/alice/7"]',
        '\tremote = alice',
        '\tgithub-pr-owner-number = acme#widgets#7',
      ].join('\n'),
    );
    expect(summary.branches.get('pr/alice/7')?.pullRequest).toEqual({
      owner: 'acme',
      name: 'widgets',
      number: 7,
    });
  });
});

describe('globalGitConfigPaths', () => {
  it('reads the XDG file, then ~/.gitconfig over it', () => {
    expect(globalGitConfigPaths({}, '/home/a')).toEqual([
      '/home/a/.config/git/config',
      '/home/a/.gitconfig',
    ]);
    expect(globalGitConfigPaths({ XDG_CONFIG_HOME: '/xdg/' }, '/home/a')).toEqual([
      '/xdg/git/config',
      '/home/a/.gitconfig',
    ]);
  });

  it('reads only $GIT_CONFIG_GLOBAL when it is set', () => {
    expect(globalGitConfigPaths({ GIT_CONFIG_GLOBAL: '/etc/x' }, '/home/a')).toEqual(['/etc/x']);
  });
});

describe('pullRequestRemotes', () => {
  const remotes = (...names: string[]) =>
    names.map((name) => ({ name, url: `https://github.com/${name}/widgets.git` }));
  const asked = (plan: ReturnType<typeof pullRequestRemotes>) =>
    plan?.lookups.map((lookup) => `${lookup.base.name}:${lookup.branch}`);

  it('looks in origin for a branch pushed there, when there is no upstream', () => {
    const plan = pullRequestRemotes(
      {
        remotes: remotes('origin'),
        branches: new Map([['fix', { remote: 'origin', merge: 'refs/heads/fix' }]]),
      },
      'fix',
    );
    expect(plan?.headRemote.name).toBe('origin');
    expect(asked(plan)).toEqual(['origin:fix']);
  });

  it('asks upstream, then origin, for a fork contributor pushing to origin', () => {
    const plan = pullRequestRemotes(
      { remotes: remotes('origin', 'upstream'), branches: new Map() },
      'fix',
    );
    expect(plan?.headRemote.name).toBe('origin');
    expect(asked(plan)).toEqual(['upstream:fix', 'origin:fix']);
  });

  it("follows git's push precedence", () => {
    const config = {
      remotes: remotes('origin', 'upstream', 'fork'),
      branches: new Map([
        ['triangular', { remote: 'upstream', merge: 'refs/heads/main', pushRemote: 'fork' }],
      ]),
      pushDefault: 'origin',
    };
    // Pushes go to the push remote under the local name, not to the branch
    // it pulls from.
    const triangular = pullRequestRemotes(config, 'triangular');
    expect(triangular?.headRemote.name).toBe('fork');
    expect(asked(triangular)).toEqual([
      'upstream:triangular',
      'origin:triangular',
      'fork:triangular',
    ]);
    expect(pullRequestRemotes(config, 'untracked')?.headRemote.name).toBe('origin');
    const noDefault = pullRequestRemotes({ ...config, pushDefault: undefined }, 'untracked');
    expect(noDefault?.headRemote.name).toBe('origin');
  });

  it('asks for the local name, not a differently named branch it was started from', () => {
    // git checkout -b my-fix origin/develop, before the first push.
    const plan = pullRequestRemotes(
      {
        remotes: remotes('origin', 'upstream'),
        branches: new Map([['my-fix', { remote: 'origin', merge: 'refs/heads/develop' }]]),
      },
      'my-fix',
    );
    expect(asked(plan)).toEqual(['upstream:my-fix', 'origin:my-fix']);
  });

  it('always asks origin, so a reviewer finds a fork tracked by its own remote', () => {
    const plan = pullRequestRemotes(
      {
        remotes: remotes('origin', 'alice'),
        branches: new Map([['feature', { remote: 'alice', merge: 'refs/heads/feature' }]]),
      },
      'feature',
    );
    expect(plan?.headRemote.name).toBe('alice');
    expect(asked(plan)).toEqual(['origin:feature', 'alice:feature']);
  });

  it("takes a remote given as a URL, and the fork's branch name from it", () => {
    const fork = 'git@github.com:alice/widgets.git';
    const plan = pullRequestRemotes(
      {
        remotes: remotes('origin'),
        branches: new Map([
          ['alice/main', { remote: fork, pushRemote: fork, merge: 'refs/heads/main' }],
        ]),
      },
      'alice/main',
    );
    expect(plan?.headRemote.url).toBe(fork);
    expect(asked(plan)).toEqual(['origin:main', `${fork}:alice/main`]);
  });

  it('names the pull request a branch tracks by its ref or recorded number', () => {
    const viaRef = pullRequestRemotes(
      {
        remotes: remotes('origin'),
        branches: new Map([
          ['feature', { remote: 'origin', pushRemote: 'origin', merge: 'refs/pull/12/head' }],
        ]),
      },
      'feature',
    );
    expect(viaRef?.lookups).toEqual([]);
    expect(viaRef?.trackedPullRequest).toEqual({ remote: remotes('origin')[0], number: 12 });

    const recorded = pullRequestRemotes(
      {
        remotes: [
          { name: 'origin', url: 'git@github.com:Acme/Widgets.git' },
          ...remotes('alice'),
        ],
        branches: new Map([
          [
            'pr/alice/7',
            {
              remote: 'alice',
              merge: 'refs/heads/feature',
              pullRequest: { owner: 'acme', name: 'widgets', number: 7 },
            },
          ],
        ]),
      },
      'pr/alice/7',
    );
    expect(recorded?.trackedPullRequest?.remote.name).toBe('origin');
    expect(recorded?.trackedPullRequest?.number).toBe(7);
  });

  it('asks each repository once, whatever its remotes are called', () => {
    const plan = pullRequestRemotes(
      {
        remotes: [
          { name: 'origin', url: 'https://github.com/acme/widgets.git' },
          { name: 'github', url: 'git@github.com:acme/widgets' },
        ],
        branches: new Map([['my-fix', { remote: 'github', merge: 'refs/heads/develop' }]]),
      },
      'my-fix',
    );
    expect(asked(plan)).toEqual(['origin:my-fix']);
  });

  it('has nothing to look in without remotes', () => {
    expect(pullRequestRemotes({ remotes: [], branches: new Map() }, 'main')).toBeUndefined();
  });
});
