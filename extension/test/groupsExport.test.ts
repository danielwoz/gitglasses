import { describe, expect, it } from 'vitest';
import {
  groupExportFileName,
  parseGroupExport,
  repoDirNameFromUrl,
  serializeGroupExport,
  uniqueGroupName,
} from '../src/groups/groupsLogic';

describe('repo group export serialization', () => {
  it('round-trips a group through serialize/parse', () => {
    const repos = [
      { remoteUrl: 'https://github.com/acme/web.git' },
      { path: '/srv/tools/internal' },
    ];
    const text = serializeGroupExport('frontend + api', repos);
    const parsed = parseGroupExport(text);
    expect(parsed).toEqual({ ok: true, name: 'frontend + api', repos });
  });

  it('prefers remoteUrl over path when both are present', () => {
    const text = serializeGroupExport('g', [
      { remoteUrl: 'git@github.com:acme/api.git', path: '/srv/api' },
    ]);
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: 'gitglasses-group', version: 1, name: 'g' });
    expect(file.repos).toEqual([{ remoteUrl: 'git@github.com:acme/api.git' }]);
  });

  it('rejects non-JSON, wrong format, and wrong version', () => {
    expect(parseGroupExport('not json')).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
    expect(parseGroupExport('{"format":"other","version":1}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('gitglasses-group'),
    });
    expect(
      parseGroupExport('{"format":"gitglasses-group","version":2,"name":"x","repos":[]}'),
    ).toMatchObject({ ok: false, error: expect.stringContaining('version') });
  });

  it('rejects a missing name or missing/empty repos', () => {
    expect(
      parseGroupExport('{"format":"gitglasses-group","version":1,"repos":[{"path":"/a"}]}'),
    ).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(
      parseGroupExport('{"format":"gitglasses-group","version":1,"name":"x"}'),
    ).toMatchObject({ ok: false, error: expect.stringContaining('repos') });
    expect(
      parseGroupExport('{"format":"gitglasses-group","version":1,"name":"x","repos":[]}'),
    ).toMatchObject({ ok: false, error: expect.stringContaining('no usable repos') });
  });

  it('drops malformed repo entries but keeps usable ones', () => {
    const parsed = parseGroupExport(
      JSON.stringify({
        format: 'gitglasses-group',
        version: 1,
        name: ' team ',
        repos: [null, 'nope', {}, { remoteUrl: '  ' }, { path: '/keep' }, { remoteUrl: ' https://x/y ' }],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      name: 'team',
      repos: [{ path: '/keep' }, { remoteUrl: 'https://x/y' }],
    });
  });
});

describe('uniqueGroupName', () => {
  it('keeps a name with no collision', () => {
    expect(uniqueGroupName('team', ['other'])).toBe('team');
  });

  it('suffixes " (2)" on a collision and counts past taken suffixes', () => {
    expect(uniqueGroupName('team', ['team'])).toBe('team (2)');
    expect(uniqueGroupName('team', ['team', 'team (2)', 'team (3)'])).toBe('team (4)');
  });
});

describe('repoDirNameFromUrl', () => {
  it('derives the clone directory from common URL shapes', () => {
    expect(repoDirNameFromUrl('https://github.com/acme/web.git')).toBe('web');
    expect(repoDirNameFromUrl('git@github.com:acme/api.git')).toBe('api');
    expect(repoDirNameFromUrl('https://gitlab.example.com/group/sub/tool')).toBe('tool');
    expect(repoDirNameFromUrl('https://github.com/acme/web.git/')).toBe('web');
    expect(repoDirNameFromUrl('')).toBe('repository');
  });
});

describe('groupExportFileName', () => {
  it('produces a filesystem-safe .ggworkspace name', () => {
    expect(groupExportFileName('frontend + api')).toBe('frontend-api.ggworkspace');
    expect(groupExportFileName('///')).toBe('group.ggworkspace');
  });
});
