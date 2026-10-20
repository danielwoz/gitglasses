// Fetch git-ai Notes with Every Fetch…: the refspec is added only after the
// user confirms, to the remote they chose, and a fetch runs only when they
// ask for one.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscodeUi'));

import { ui } from './support/fakeVscodeUi';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../src/model/repositoryService';
import {
  FETCH_NOTES_COMMAND,
  preferredRemotes,
  registerProvenanceCommands,
  remoteNotesRef,
} from '../src/provenance/provenanceCommands';
import { setActiveRepoResolver } from '../src/views/viewBase';

function engine(remotes: string[], added = true, fail = false) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fake = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      switch (method) {
        case 'remote/list':
          return { remotes: remotes.map((name) => ({ name, fetchUrl: `https://x/${name}` })) };
        case 'notes/addFetchRefspec':
          if (fail) throw new Error('git config failed');
          return { added, trackingRef: `refs/notes/ai-remote/${String(params.remote)}` };
        case 'mutate/fetch':
          return {};
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { engine: fake as unknown as EngineClient, calls };
}

async function run(fake: ReturnType<typeof engine>, log = vi.fn()): Promise<void> {
  registerProvenanceCommands(fake.engine, {} as RepositoryService, log);
  await ui.commands.get(FETCH_NOTES_COMMAND)?.();
}

const methods = (fake: ReturnType<typeof engine>) => fake.calls.map((call) => call.method);

beforeEach(() => {
  ui.reset();
  setActiveRepoResolver(async () => ({ repoId: 'r1', rootPath: '/work/repo' }));
});

describe('Fetch git-ai Notes with Every Fetch…', () => {
  it('changes nothing until the user confirms', async () => {
    const fake = engine(['origin']);
    ui.messageChoices = [undefined];
    await run(fake);
    expect(methods(fake)).toEqual(['remote/list']);
    expect(ui.messages[0]).toMatchObject({
      text: 'Fetch git-ai notes from origin?',
      buttons: ['Add Refspec', 'Add and Fetch Now'],
    });
  });

  it('says the notes are fetched beside the local ones, which are never overwritten', async () => {
    const fake = engine(['origin']);
    ui.messageChoices = [undefined];
    await run(fake);
    const detail = ui.messages[0].detail ?? '';
    expect(detail).toContain('+refs/notes/ai:refs/notes/ai-remote/origin');
    expect(detail).toMatch(/own refs\/notes\/ai is never overwritten/);
    expect(detail).not.toMatch(/nothing else changes/);
  });

  it('adds the refspec to the remote the user picks, offering origin first', async () => {
    const fake = engine(['upstream', 'origin']);
    ui.quickPickChoices = ['upstream'];
    ui.messageChoices = ['Add Refspec'];
    await run(fake);
    expect((ui.shown[0].items ?? []).map((item) => item.label)).toEqual(['origin', 'upstream']);
    expect(fake.calls.at(-1)).toEqual({
      method: 'notes/addFetchRefspec',
      params: { repoId: 'r1', remote: 'upstream', ref: 'refs/notes/ai' },
    });
    expect(ui.messages.at(-1)?.text).toBe(
      'GitGlasses: fetches from upstream now bring git-ai notes.',
    );
  });

  it('fetches right away only when asked to', async () => {
    const fake = engine(['origin'], false);
    ui.messageChoices = ['Add and Fetch Now'];
    await run(fake);
    expect(methods(fake)).toEqual(['remote/list', 'notes/addFetchRefspec', 'mutate/fetch']);
  });

  it('names the tracking ref as git-ai does', () => {
    expect(remoteNotesRef('origin')).toBe('refs/notes/ai-remote/origin');
    expect(remoteNotesRef('my.fork/x')).toBe('refs/notes/ai-remote/my_fork_x');
  });

  it('says so when there is no remote, and when adding fails', async () => {
    const none = engine([]);
    await run(none);
    expect(methods(none)).toEqual(['remote/list']);
    expect(ui.messages[0].text).toMatch(/no remote/);

    ui.reset();
    const failing = engine(['origin'], true, true);
    ui.messageChoices = ['Add Refspec'];
    const log = vi.fn();
    await run(failing, log);
    expect(ui.messages.at(-1)).toMatchObject({ level: 'error' });
    expect(ui.messages.at(-1)?.text).toMatch(/git config failed/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/git config failed/));
  });

  it('orders origin first', () => {
    expect(preferredRemotes(['b', 'origin', 'a'])).toEqual(['origin', 'a', 'b']);
  });
});
