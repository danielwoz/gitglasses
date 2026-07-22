import { describe, expect, it } from 'vitest';
import { EngineCapabilities } from '@gitglasses/protocol';
import {
  HeadChangeTracker,
  isMethodAvailable,
  requiresGitCli,
} from '../src/engine/capabilityGate';

const caps = (gitCli: boolean): EngineCapabilities => ({
  gitCli,
  watch: true,
  threads: true,
});

const CLI_METHODS = [
  'mutate/commit',
  'mutate/branchCreate',
  'mutate/branchDelete',
  'mutate/switch',
  'mutate/merge',
  'mutate/cherryPick',
  'mutate/revert',
  'mutate/reset',
  'mutate/fetch',
  'mutate/pull',
  'mutate/push',
  'rebase/preview',
  'rebase/start',
  'rebase/continue',
  'rebase/abort',
  'stash/push',
  'stash/apply',
  'stash/drop',
  'worktree/add',
  'worktree/remove',
  'patch/create',
  'patch/apply',
  'history/file',
  'history/line',
];

const PURE_METHODS = [
  'initialize',
  'shutdown',
  'repo/discover',
  'repo/list',
  'repo/state',
  'blame/file',
  'log/commits',
  'search/commits',
  'rev/fileAtRev',
  'refs/list',
  'stash/list',
  'status/summary',
  'graph/rows',
  'diff/commit',
  'diff/refs',
  'diff/fileHunks',
  'stage/files',
  'stage/hunks',
  'worktree/list',
  'remote/list',
];

describe('isMethodAvailable', () => {
  it('blocks every CLI-dependent method when gitCli is false', () => {
    for (const method of CLI_METHODS) {
      expect(isMethodAvailable(caps(false), method), method).toBe(false);
      expect(requiresGitCli(method), method).toBe(true);
    }
  });

  it('allows every CLI-dependent method when gitCli is true', () => {
    for (const method of CLI_METHODS) {
      expect(isMethodAvailable(caps(true), method), method).toBe(true);
    }
  });

  it('allows CLI-independent methods regardless of gitCli', () => {
    for (const method of PURE_METHODS) {
      expect(requiresGitCli(method), method).toBe(false);
      expect(isMethodAvailable(caps(false), method), method).toBe(true);
      expect(isMethodAvailable(caps(true), method), method).toBe(true);
    }
  });

  it('treats unknown capabilities (before initialize) as allow', () => {
    expect(isMethodAvailable(undefined, 'mutate/commit')).toBe(true);
    expect(isMethodAvailable(undefined, 'blame/file')).toBe(true);
  });

  it('distinguishes gated from ungated methods within the same family', () => {
    expect(isMethodAvailable(caps(false), 'stash/list')).toBe(true);
    expect(isMethodAvailable(caps(false), 'stash/push')).toBe(false);
    expect(isMethodAvailable(caps(false), 'worktree/list')).toBe(true);
    expect(isMethodAvailable(caps(false), 'worktree/add')).toBe(false);
  });
});

describe('HeadChangeTracker', () => {
  it('does not report a change on the first observation', () => {
    const tracker = new HeadChangeTracker();
    expect(tracker.update('r1', 'a'.repeat(40))).toBe(false);
  });

  it('does not report a change while the oid is stable', () => {
    const tracker = new HeadChangeTracker();
    tracker.update('r1', 'a'.repeat(40));
    expect(tracker.update('r1', 'a'.repeat(40))).toBe(false);
    expect(tracker.update('r1', 'a'.repeat(40))).toBe(false);
  });

  it('reports a change when the oid moves, then settles', () => {
    const tracker = new HeadChangeTracker();
    tracker.update('r1', 'a'.repeat(40));
    expect(tracker.update('r1', 'b'.repeat(40))).toBe(true);
    expect(tracker.update('r1', 'b'.repeat(40))).toBe(false);
  });

  it('tracks repos independently', () => {
    const tracker = new HeadChangeTracker();
    tracker.update('r1', 'a'.repeat(40));
    expect(tracker.update('r2', 'b'.repeat(40))).toBe(false); // first sight of r2
    expect(tracker.update('r1', 'c'.repeat(40))).toBe(true);
    expect(tracker.update('r2', 'b'.repeat(40))).toBe(false);
  });

  it('reset() forgets history so the next observation is a first sight', () => {
    const tracker = new HeadChangeTracker();
    tracker.update('r1', 'a'.repeat(40));
    tracker.reset();
    expect(tracker.update('r1', 'b'.repeat(40))).toBe(false);
  });
});
