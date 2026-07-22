import { describe, expect, it } from 'vitest';
import { orderedRemoteUrls, parseGitConfigRemotes } from '../src/integrations/gitConfig';

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
