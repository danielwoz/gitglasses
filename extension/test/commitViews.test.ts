// Open All Changes: VS Code's multi-file diff editor, or the first file's
// diff on hosts without one, and never a silent fallback for other failures.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeWebviewVscode'));

import type { EngineClient } from '@gitglasses/rpc';
import { controls, recorded } from './support/fakeWebviewVscode';
import { openAllChanges } from '../src/commitDetails/commitViews';

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912345678';

const engine = {
  async request(method: string) {
    if (method !== 'commit/details') throw new Error(`unexpected ${method}`);
    return {
      files: [
        { path: 'src/a.ts', status: 'M', additions: 1, deletions: 1, binary: false },
        { path: 'src/b.ts', status: 'A', additions: 3, deletions: 0, binary: false },
      ],
    };
  },
} as unknown as EngineClient;

const executed = (): string[] => recorded.commands.map((call) => call.command);

beforeEach(() => recorded.reset());

describe('openAllChanges', () => {
  it('opens every file in the multi-file diff editor', async () => {
    const log = vi.fn();
    await openAllChanges(engine, 'r1', { kind: 'commit', sha: SHA }, log);
    expect(executed()).toEqual(['vscode.changes']);
    const [, resources] = recorded.commands[0].args as [string, unknown[]];
    expect(resources).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("opens the first file's diff, and says why, where the editor is missing", async () => {
    recorded.failing.set('vscode.changes', new Error("command 'vscode.changes' not found"));
    const log = vi.fn();
    await openAllChanges(engine, 'r1', { kind: 'commit', sha: SHA }, log);
    expect(executed()).toEqual(['vscode.changes', 'vscode.diff']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(controls.messages).toEqual([expect.stringContaining('src/a.ts')]);
  });

  it('passes any other failure on instead of opening one file', async () => {
    recorded.failing.set('vscode.changes', new Error('Unable to resolve resource'));
    const log = vi.fn();
    await expect(openAllChanges(engine, 'r1', { kind: 'commit', sha: SHA }, log)).rejects.toThrow(
      'Unable to resolve resource',
    );
    expect(executed()).toEqual(['vscode.changes']);
  });
});
