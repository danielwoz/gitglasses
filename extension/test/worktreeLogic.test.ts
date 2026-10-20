import { describe, expect, it } from 'vitest';
import type { WorktreeEntry, WorktreeStatus } from '@gitglasses/protocol';
import {
  WorktreeStatusCache,
  confirmDiscardWorktreeChanges,
  confirmWorktreeAndBranchRemove,
  defaultWorktreePath,
  statusKey,
  worktreeContext,
  worktreeDescription,
  worktreeLabel,
  worktreeRowLabel,
  worktreeTooltip,
} from '../src/views/worktreeLogic';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const BASE_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

function entry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: '/repos/app-agent',
    branch: 'feature',
    sha: SHA,
    bare: false,
    locked: false,
    prunable: false,
    current: false,
    ...overrides,
  };
}

function status(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return { path: '/repos/app-agent', dirty: 0, ...overrides };
}

function base(overrides: Partial<NonNullable<WorktreeStatus['base']>> = {}) {
  return {
    ref: 'main',
    sha: BASE_SHA,
    ahead: 2,
    behind: 0,
    mergesCleanly: true as boolean | null,
    ...overrides,
  };
}

describe('worktreeLabel', () => {
  it('uses the directory basename', () => {
    expect(worktreeLabel('/home/user/repos/app')).toBe('app');
  });

  it('ignores trailing separators', () => {
    expect(worktreeLabel('/home/user/repos/app/')).toBe('app');
  });

  it('handles Windows-style separators', () => {
    expect(worktreeLabel('C:\\repos\\app-feature')).toBe('app-feature');
  });
});

describe('worktreeRowLabel', () => {
  it('names the row after its branch, or its folder without one', () => {
    expect(worktreeRowLabel(entry())).toBe('feature');
    expect(worktreeRowLabel(entry({ branch: undefined }))).toBe('app-agent');
    expect(worktreeRowLabel(entry({ bare: true, path: '/repos/app.git' }))).toBe('app.git');
  });
});

describe('worktreeDescription', () => {
  it('is empty until the status arrives', () => {
    expect(worktreeDescription(entry())).toBe('');
  });

  it('marks the current worktree', () => {
    expect(worktreeDescription(entry({ branch: 'main', current: true }))).toBe('current');
  });

  it('labels detached, bare, missing and locked worktrees', () => {
    expect(worktreeDescription(entry({ branch: undefined }))).toBe('detached@1234567');
    expect(worktreeDescription(entry({ bare: true, sha: '' }))).toBe('bare');
    expect(worktreeDescription(entry({ prunable: true, locked: true }))).toBe('missing · locked');
  });

  it('shows the status at a glance', () => {
    const described = worktreeDescription(
      entry(),
      status({ dirty: 3, base: base(), agent: { name: 'Claude Code', evidence: 'path' } }),
    );
    expect(described).toBe('3 changed · ↑2 ↓0 · merges cleanly · Claude Code');
  });

  it('counts conflicting files', () => {
    const described = worktreeDescription(
      entry(),
      status({ base: base({ behind: 4, mergesCleanly: false, conflicts: ['a.ts', 'b.ts'] }) }),
    );
    expect(described).toBe('↑2 ↓4 · conflicts in 2 files');
  });

  it('gives no merge verdict when nothing is ahead or the check was skipped', () => {
    expect(worktreeDescription(entry(), status({ base: base({ ahead: 0, behind: 3 }) }))).toBe(
      '↑0 ↓3',
    );
    expect(
      worktreeDescription(
        entry(),
        status({ base: base({ behind: 1, mergesCleanly: null, mergeSkipped: 'gitVersion' }) }),
      ),
    ).toBe('↑2 ↓1');
  });

  it('marks the worktree on the base branch as the base', () => {
    expect(
      worktreeDescription(
        entry({ branch: 'main', current: true }),
        status({ dirty: 1, base: base({ ahead: 0 }) }),
      ),
    ).toBe('current · 1 changed · base');
  });
});

describe('worktreeTooltip', () => {
  const now = 1_800_000_000;

  it('spells out everything the status reports', () => {
    const tooltip = worktreeTooltip(
      entry(),
      status({
        dirty: 1,
        lastActivity: now - 300,
        upstream: { ref: 'origin/feature', ahead: 1, behind: 0 },
        base: base({ behind: 1, mergesCleanly: false, conflicts: ['src/a.ts'] }),
        agent: { name: 'Cursor', evidence: 'trailer' },
      }),
      { nowSeconds: now },
    );
    expect(tooltip.split('\n')).toEqual([
      '/repos/app-agent',
      'Branch: feature at 1234567',
      'Agent: Cursor (going by a commit trailer)',
      'Uncommitted: 1 changed path',
      'Upstream origin/feature: 1 ahead, 0 behind',
      'Against main: 2 ahead, 1 behind',
      'Conflicts with main in src/a.ts',
      'Last activity: 5 minutes ago',
    ]);
  });

  it('says why a merge was not checked', () => {
    const tooltip = worktreeTooltip(
      entry(),
      status({ base: base({ behind: 1, mergesCleanly: null, mergeSkipped: 'restricted' }) }),
    );
    expect(tooltip).toContain('Merge into main: not checked in Restricted Mode');
    expect(tooltip).toContain('No uncommitted changes');
  });

  it('bounds the conflicts it names', () => {
    const conflicts = Array.from({ length: 13 }, (_, i) => `f${i}.ts`);
    const tooltip = worktreeTooltip(
      entry(),
      status({ base: base({ behind: 1, mergesCleanly: false, conflicts }) }),
    );
    expect(tooltip).toContain('f9.ts and 3 more');
    expect(tooltip).not.toContain('f10.ts');
  });

  it('explains a missing directory and a failed status', () => {
    const tooltip = worktreeTooltip(entry({ prunable: true }), undefined, { error: 'boom' });
    expect(tooltip).toContain('git worktree prune');
    expect(tooltip).toContain('Status unavailable: boom');
  });
});

describe('worktreeContext', () => {
  it('tells apart the rows each action applies to', () => {
    expect(worktreeContext(entry({ current: true }), 0)).toBe('gitglassesCurrentWorktree');
    expect(worktreeContext(entry(), 0)).toBe('gitglassesMainWorktree');
    expect(worktreeContext(entry(), 2)).toBe('gitglassesWorktree');
    expect(worktreeContext(entry({ bare: true }), 0)).toBe('gitglassesBareWorktree');
    expect(worktreeContext(entry({ prunable: true }), 1)).toBe('gitglassesMissingWorktree');
  });
});

describe('remove worktree and branch confirmations', () => {
  it('names the directory, the branch and the commits that go with it', () => {
    const confirmation = confirmWorktreeAndBranchRemove(
      entry(),
      status({ dirty: 2, base: base({ ahead: 3 }) }),
    );
    expect(confirmation.message).toBe("Remove worktree 'app-agent' and delete branch 'feature'?");
    expect(confirmation.detail.split('\n')).toEqual([
      'Worktree: /repos/app-agent',
      'Branch: feature (3 commits not on main will be lost)',
      '2 uncommitted changes — you will be asked again before they are discarded.',
      '',
      'git worktree remove /repos/app-agent',
      'git branch -D feature',
    ]);
  });

  it('leaves out what does not apply', () => {
    const merged = confirmWorktreeAndBranchRemove(entry(), status({ base: base({ ahead: 0 }) }));
    expect(merged.detail).toContain('Branch: feature\n');
    expect(merged.detail).not.toContain('uncommitted');
    const detached = confirmWorktreeAndBranchRemove(entry({ branch: undefined }), status());
    expect(detached.message).toBe("Remove worktree 'app-agent'?");
    expect(detached.detail).not.toContain('git branch');
  });

  it('asks again before discarding uncommitted work', () => {
    const confirmation = confirmDiscardWorktreeChanges(entry(), 1);
    expect(confirmation.message).toBe("Discard 1 uncommitted change in 'app-agent'?");
    expect(confirmation.detail).toContain('git worktree remove --force /repos/app-agent');
  });
});

describe('defaultWorktreePath', () => {
  it('suggests a repo-branch sibling directory', () => {
    expect(defaultWorktreePath('/home/user/repos/app', 'main')).toBe('../app-main');
  });

  it('sanitizes ref characters unsafe in paths', () => {
    expect(defaultWorktreePath('/repos/app', 'feature/new-ui')).toBe('../app-feature-new-ui');
  });
});

/** A load the test settles by hand. */
interface Deferred {
  path: string;
  resolve: (status: WorktreeStatus) => void;
  reject: (error: Error) => void;
}

function harness(concurrency = 2) {
  const started: Deferred[] = [];
  const loaded: string[] = [];
  const cache = new WorktreeStatusCache(
    (path) =>
      new Promise<WorktreeStatus>((resolve, reject) => started.push({ path, resolve, reject })),
    (path) => loaded.push(path),
    concurrency,
  );
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { cache, started, loaded, settle };
}

describe('WorktreeStatusCache', () => {
  it('loads a few worktrees at a time, in order', async () => {
    const { cache, started, loaded, settle } = harness(2);
    for (const path of ['/a', '/b', '/c', '/d']) expect(cache.get(path, 'k')).toBeUndefined();
    expect(started.map((d) => d.path)).toEqual(['/a', '/b']);
    expect(cache.busy).toBe(4);

    started[0].resolve(status({ path: '/a', dirty: 1 }));
    await settle();
    expect(loaded).toEqual(['/a']);
    expect(started.map((d) => d.path)).toEqual(['/a', '/b', '/c']);
    expect(cache.get('/a', 'k')?.status?.dirty).toBe(1);
    // A fresh answer is served without another load.
    expect(started).toHaveLength(3);
  });

  it('asks once per worktree however often it is rendered', () => {
    const { cache, started } = harness(4);
    cache.get('/a', 'k');
    cache.get('/a', 'k');
    cache.get('/a', 'k');
    expect(started).toHaveLength(1);
  });

  it('keeps the old answer on screen while a newer one loads', async () => {
    const { cache, started, settle } = harness(1);
    cache.get('/a', 'k');
    started[0].resolve(status({ dirty: 1 }));
    await settle();

    cache.invalidate();
    expect(cache.get('/a', 'k')?.status?.dirty).toBe(1);
    expect(started).toHaveLength(2);
    started[1].resolve(status({ dirty: 5 }));
    await settle();
    expect(cache.get('/a', 'k')?.status?.dirty).toBe(5);
    expect(started).toHaveLength(2);
  });

  it('reloads when the commit or base changes', async () => {
    const { cache, started, settle } = harness(1);
    cache.get('/a', statusKey({ ...entry(), sha: SHA }, undefined));
    started[0].resolve(status());
    await settle();
    cache.get('/a', statusKey({ ...entry(), sha: BASE_SHA }, undefined));
    expect(started).toHaveLength(2);
    started[1].resolve(status());
    await settle();
    cache.get('/a', statusKey({ ...entry(), sha: BASE_SHA }, 'develop'));
    expect(started).toHaveLength(3);
  });

  it('reports a failed load once, keeping the last answer', async () => {
    const { cache, started, loaded, settle } = harness(1);
    cache.get('/a', 'k');
    started[0].resolve(status({ dirty: 2 }));
    await settle();
    cache.invalidate();
    cache.get('/a', 'k');
    started[1].reject(new Error('worktree is gone'));
    await settle();
    const known = cache.get('/a', 'k');
    expect(known?.error).toBe('worktree is gone');
    expect(known?.status?.dirty).toBe(2);
    expect(loaded).toEqual(['/a', '/a']);
    // No retry loop: the next attempt waits for the next invalidate().
    expect(started).toHaveLength(2);
  });

  it('forgets worktrees that are gone', async () => {
    const { cache, started, settle } = harness(2);
    cache.get('/a', 'k');
    cache.get('/b', 'k');
    started[0].resolve(status());
    started[1].resolve(status());
    await settle();
    cache.retain(new Set(['/b']));
    expect(cache.get('/b', 'k')).toBeDefined();
    expect(started).toHaveLength(2);
    expect(cache.get('/a', 'k')).toBeUndefined();
    expect(started).toHaveLength(3);
  });

  it('drops a queued load that a newer request replaced', async () => {
    const { cache, started, settle } = harness(1);
    cache.get('/a', 'k');
    cache.get('/b', 'old');
    cache.get('/b', 'new');
    started[0].resolve(status());
    await settle();
    // Only the newer request for /b ran.
    expect(started.map((d) => d.path)).toEqual(['/a', '/b']);
    started[1].resolve(status({ dirty: 9 }));
    await settle();
    expect(cache.get('/b', 'new')?.status?.dirty).toBe(9);
    expect(cache.busy).toBe(0);
  });
});
