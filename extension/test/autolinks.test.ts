import { describe, expect, it } from 'vitest';
import {
  applyAutolinks,
  jiraPattern,
  repoIssuePatterns,
  userPatterns,
} from '../src/integrations/autolinks';

const repo = { host: 'github.com', owner: 'acme', name: 'widgets' };

describe('applyAutolinks', () => {
  it('links a repo issue reference with $1 substitution', () => {
    expect(applyAutolinks('Fix crash (#123)', repoIssuePatterns(repo))).toBe(
      'Fix crash \\([\\#123](<https://github.com/acme/widgets/issues/123>)\\)',
    );
  });

  it('returns text unchanged when nothing matches', () => {
    const text = 'no references here';
    expect(applyAutolinks(text, repoIssuePatterns(repo))).toBe(text);
  });

  it('applies multiple patterns in one pass', () => {
    const patterns = [...repoIssuePatterns(repo), jiraPattern('acme.atlassian.net')];
    expect(applyAutolinks('PROJ-42 fixed by #7', patterns)).toBe(
      '[PROJ\\-42](<https://acme.atlassian.net/browse/PROJ-42>) fixed by ' +
        '[\\#7](<https://github.com/acme/widgets/issues/7>)',
    );
  });

  it('lets the earlier pattern win on overlapping matches', () => {
    const patterns = [
      { regex: 'ABC-(\\d+)', urlTemplate: 'https://first.example/$1' },
      { regex: '[A-Z]+-\\d+', urlTemplate: 'https://second.example/$0' },
    ];
    expect(applyAutolinks('see ABC-9', patterns)).toBe(
      'see [ABC\\-9](<https://first.example/9>)',
    );
  });

  it('links repeated references independently', () => {
    expect(applyAutolinks('#1 and #2', repoIssuePatterns(repo))).toBe(
      '[\\#1](<https://github.com/acme/widgets/issues/1>) and ' +
        '[\\#2](<https://github.com/acme/widgets/issues/2>)',
    );
  });

  it('ignores invalid regexes instead of failing the whole set', () => {
    const patterns = [
      { regex: '([unclosed', urlTemplate: 'https://broken.example/$1' },
      ...repoIssuePatterns(repo),
    ];
    expect(applyAutolinks('#5', patterns)).toBe(
      '[\\#5](<https://github.com/acme/widgets/issues/5>)',
    );
  });

  it('escapes markup the commit message carries', () => {
    expect(applyAutolinks('![](https://attacker.example/b.png)', [])).toBe(
      '\\!\\[\\]\\(https://attacker\\.example/b\\.png\\)',
    );
    expect(applyAutolinks('[text](https://evil.example)', repoIssuePatterns(repo))).toBe(
      '\\[text\\]\\(https://evil\\.example\\)',
    );
  });

  it('escapes the link text so a match cannot carry markup', () => {
    const patterns = [{ regex: '!\\[x\\]\\(y\\)', urlTemplate: 'https://t.example/' }];
    expect(applyAutolinks('![x](y)', patterns)).toBe(
      '[\\!\\[x\\]\\(y\\)](<https://t.example/>)',
    );
  });

  it('percent-encodes capture groups substituted into the URL', () => {
    const patterns = [{ regex: 'T-(\\S+)', urlTemplate: 'https://t.example/$1' }];
    expect(applyAutolinks('T-a/b?c=d', patterns)).toBe(
      '[T\\-a/b?c=d](<https://t.example/a%2Fb%3Fc%3Dd>)',
    );
  });
});

describe('userPatterns', () => {
  it('keeps only well-formed entries', () => {
    const raw = [
      { regex: 'T-(\\d+)', urlTemplate: 'https://t.example/$1' },
      { regex: '', urlTemplate: 'https://t.example' },
      { regex: 42, urlTemplate: 'https://t.example' },
      'nonsense',
      null,
    ];
    expect(userPatterns(raw)).toEqual([{ regex: 'T-(\\d+)', urlTemplate: 'https://t.example/$1' }]);
    expect(userPatterns('not an array')).toEqual([]);
  });

  it('keeps only http(s) link targets', () => {
    const raw = [
      { regex: 'a', urlTemplate: 'javascript:alert(1)' },
      { regex: 'b', urlTemplate: 'command:workbench.action.terminal.new' },
      { regex: 'c', urlTemplate: 'file:///etc/passwd' },
      { regex: 'd', urlTemplate: 'vscode://x' },
      { regex: 'e', urlTemplate: 'http://intranet.example/$1' },
    ];
    expect(userPatterns(raw)).toEqual([
      { regex: 'e', urlTemplate: 'http://intranet.example/$1' },
    ]);
  });
});
