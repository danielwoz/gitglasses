import { describe, expect, it } from 'vitest';
import {
  addHostSetting,
  addIssueSetting,
  describeIssueSetting,
  HOSTING_PROVIDER_CHOICES,
  ISSUE_PROVIDER_CHOICES,
  isValidDomain,
  normalizeDomain,
  removeHostSetting,
  removeIssueSetting,
} from '../src/integrations/integrationSettings';

describe('normalizeDomain', () => {
  it('strips scheme, path and trailing slash', () => {
    expect(normalizeDomain('https://git.example.com/')).toBe('git.example.com');
    expect(normalizeDomain('https://git.example.com/some/path')).toBe('git.example.com');
  });

  it('strips userinfo and lowercases', () => {
    expect(normalizeDomain('ssh://git@Git.Example.COM')).toBe('git.example.com');
  });

  it('trims surrounding whitespace and passes a bare host through', () => {
    expect(normalizeDomain('  git.example.com  ')).toBe('git.example.com');
  });

  it('returns empty for empty input', () => {
    expect(normalizeDomain('   ')).toBe('');
  });
});

describe('isValidDomain', () => {
  it('accepts hostnames, including a port', () => {
    expect(isValidDomain('git.example.com')).toBe(true);
    expect(isValidDomain('https://git.example.com/x')).toBe(true);
    expect(isValidDomain('git.example.com:8443')).toBe(true);
  });

  it('rejects empty, single-label and malformed values', () => {
    expect(isValidDomain('')).toBe(false);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('not a host')).toBe(false);
    expect(isValidDomain('-bad.example.com')).toBe(false);
  });
});

describe('addHostSetting', () => {
  it('appends a normalized entry', () => {
    expect(
      addHostSetting([], { domain: 'https://git.example.com/', provider: 'gitlab' }),
    ).toEqual([{ domain: 'git.example.com', provider: 'gitlab' }]);
  });

  it('replaces rather than duplicates an existing domain', () => {
    const existing = [{ domain: 'git.example.com', provider: 'gitlab' }];
    expect(
      addHostSetting(existing, { domain: 'GIT.EXAMPLE.COM', provider: 'github-enterprise' }),
    ).toEqual([{ domain: 'git.example.com', provider: 'github-enterprise' }]);
  });

  it('leaves unrelated entries alone and does not mutate the input', () => {
    const existing = [{ domain: 'a.example.com', provider: 'gitlab' }];
    const next = addHostSetting(existing, { domain: 'b.example.com', provider: 'gitlab' });
    expect(next).toHaveLength(2);
    expect(existing).toHaveLength(1);
  });
});

describe('removeHostSetting', () => {
  it('removes by normalized domain', () => {
    const existing = [
      { domain: 'a.example.com', provider: 'gitlab' },
      { domain: 'b.example.com', provider: 'gitlab' },
    ];
    expect(removeHostSetting(existing, 'https://A.example.com/')).toEqual([
      { domain: 'b.example.com', provider: 'gitlab' },
    ]);
  });

  it('is a no-op for an unknown domain', () => {
    const existing = [{ domain: 'a.example.com', provider: 'gitlab' }];
    expect(removeHostSetting(existing, 'z.example.com')).toEqual(existing);
  });
});

describe('addIssueSetting', () => {
  it('records provider and normalized host', () => {
    expect(addIssueSetting([], { provider: 'jira', host: 'https://acme.atlassian.net' })).toEqual(
      [{ provider: 'jira', host: 'acme.atlassian.net' }],
    );
  });

  it('omits host entirely when the provider needs none', () => {
    expect(addIssueSetting([], { provider: 'linear' })).toEqual([{ provider: 'linear' }]);
  });

  it('replaces a matching provider+host pair', () => {
    const existing = [{ provider: 'jira', host: 'acme.atlassian.net' }];
    expect(
      addIssueSetting(existing, { provider: 'jira', host: 'ACME.atlassian.net' }),
    ).toHaveLength(1);
  });

  it('keeps the same provider on a different host', () => {
    const existing = [{ provider: 'jira', host: 'a.atlassian.net' }];
    expect(addIssueSetting(existing, { provider: 'jira', host: 'b.atlassian.net' })).toHaveLength(
      2,
    );
  });
});

describe('removeIssueSetting', () => {
  it('removes the matching provider+host', () => {
    const existing = [
      { provider: 'jira', host: 'a.atlassian.net' },
      { provider: 'linear' },
    ];
    expect(removeIssueSetting(existing, 'jira', 'a.atlassian.net')).toEqual([
      { provider: 'linear' },
    ]);
  });

  it('removes a hostless provider', () => {
    const existing = [{ provider: 'linear' }];
    expect(removeIssueSetting(existing, 'linear')).toEqual([]);
  });
});

describe('provider choices', () => {
  it('offers only providers the integrations package ships', () => {
    const ids = [...HOSTING_PROVIDER_CHOICES, ...ISSUE_PROVIDER_CHOICES].map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'github-enterprise',
        'gitlab',
        'bitbucket',
        'bitbucketDC',
        'azuredevops',
        'jira',
        'linear',
      ]),
    );
  });

  it('marks linear as not needing a host', () => {
    expect(ISSUE_PROVIDER_CHOICES.find((c) => c.id === 'linear')?.needsHost).toBe(false);
  });
});

describe('describeIssueSetting', () => {
  it('includes the host when there is one', () => {
    expect(describeIssueSetting({ provider: 'jira', host: 'acme.atlassian.net' })).toBe(
      'jira (acme.atlassian.net)',
    );
    expect(describeIssueSetting({ provider: 'linear' })).toBe('linear');
  });
});
