import { describe, expect, it } from 'vitest';
import {
  RepoGroup,
  parseRepoGroups,
  serializeRepoGroups,
  workspaceFileContents,
  workspaceFileName,
} from '../src/groups/groupsLogic';

const groups: RepoGroup[] = [
  { id: 'a1b2c3d4', name: 'frontend + api', repos: [{ path: '/srv/web' }, { path: '/srv/api' }] },
  { id: 'e5f6a7b8', name: 'solo', repos: [{ path: '/srv/tool' }] },
];

describe('repo group serialization', () => {
  it('round-trips through JSON (globalState storage shape)', () => {
    const stored = JSON.parse(JSON.stringify(serializeRepoGroups(groups)));
    expect(parseRepoGroups(stored)).toEqual(groups);
  });

  it('serialization produces independent copies', () => {
    const copy = serializeRepoGroups(groups);
    copy[0].repos.push({ path: '/mutated' });
    copy[0].name = 'mutated';
    expect(groups[0].repos).toHaveLength(2);
    expect(groups[0].name).toBe('frontend + api');
  });

  it('drops malformed entries and repos on parse', () => {
    const parsed = parseRepoGroups([
      null,
      'nope',
      { id: 42, name: 'bad id', repos: [] },
      { id: 'ok', name: 'good', repos: [{ path: '/a' }, { nope: true }, null, { path: 7 }] },
      { id: 'ok2', name: 'no repos array', repos: 'x' },
    ]);
    expect(parsed).toEqual([{ id: 'ok', name: 'good', repos: [{ path: '/a' }] }]);
  });

  it('parses non-array storage as empty', () => {
    expect(parseRepoGroups(undefined)).toEqual([]);
    expect(parseRepoGroups({})).toEqual([]);
  });
});

describe('workspace file generation', () => {
  it('emits a multi-root folders document', () => {
    const parsed = JSON.parse(workspaceFileContents(groups[0]));
    expect(parsed).toEqual({ folders: [{ path: '/srv/web' }, { path: '/srv/api' }] });
  });

  it('builds a filesystem-safe, id-unique file name', () => {
    expect(workspaceFileName(groups[0])).toBe('frontend-api-a1b2c3d4.code-workspace');
    expect(workspaceFileName({ id: 'x1', name: '///', repos: [] })).toBe(
      'group-x1.code-workspace',
    );
  });
});
