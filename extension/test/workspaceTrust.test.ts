// Workspace trust: the engine restart a trust grant triggers, and the manifest
// gates that keep commands which run git or change the repository out of reach
// in Restricted Mode.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineCapabilities } from '@gitglasses/protocol';
import { createTrustGrantHandler, type TrustEngine } from '../src/engine/workspaceTrust';

class FakeEngine implements TrustEngine {
  calls: string[] = [];
  caps: EngineCapabilities | undefined;
  startError: Error | undefined;

  constructor(restricted: boolean | undefined) {
    this.caps = { gitCli: !restricted, restricted, watch: true, threads: true };
  }

  async start(): Promise<void> {
    this.calls.push('start');
    if (this.startError) throw this.startError;
  }

  async restart(): Promise<void> {
    this.calls.push('restart');
    this.caps = { gitCli: true, restricted: false, watch: true, threads: true };
  }

  capabilities(): EngineCapabilities | undefined {
    return this.caps;
  }
}

describe('createTrustGrantHandler', () => {
  it('replaces a restricted engine with a full one, then reloads', async () => {
    const engine = new FakeEngine(true);
    const onGrant = createTrustGrantHandler(engine, async () => {
      engine.calls.push('reload');
    });
    await onGrant();
    expect(engine.calls).toEqual(['start', 'restart', 'reload']);
    expect(engine.capabilities()?.restricted).toBe(false);
  });

  it('leaves an engine that is already unrestricted alone', async () => {
    const engine = new FakeEngine(false);
    const onGrant = createTrustGrantHandler(engine, async () => {
      engine.calls.push('reload');
    });
    await onGrant();
    expect(engine.calls).toEqual(['start']);
  });

  it('restarts an engine too old to report the mode', async () => {
    const engine = new FakeEngine(undefined);
    const onGrant = createTrustGrantHandler(engine, async () => undefined);
    await onGrant();
    expect(engine.calls).toEqual(['start', 'restart']);
  });

  it('shares one restart between grants that overlap', async () => {
    const engine = new FakeEngine(true);
    const onGrant = createTrustGrantHandler(engine, async () => {
      engine.calls.push('reload');
    });
    await Promise.all([onGrant(), onGrant()]);
    expect(engine.calls.filter((call) => call === 'restart')).toHaveLength(1);
  });

  it('still restarts when the first start failed', async () => {
    const engine = new FakeEngine(true);
    engine.startError = new Error('spawn failed');
    engine.caps = undefined;
    const onGrant = createTrustGrantHandler(engine, async () => {
      engine.calls.push('reload');
    });
    await onGrant();
    expect(engine.calls).toEqual(['start', 'restart', 'reload']);
  });
});

interface Manifest {
  capabilities: {
    untrustedWorkspaces: {
      supported: boolean | 'limited';
      description: string;
      restrictedConfigurations: string[];
    };
  };
  contributes: {
    commands: { command: string; enablement?: string }[];
    menus: Record<string, { command?: string; when?: string }[]>;
  };
}

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as Manifest;

// Commands that change the repository, contact a remote, or need git to read.
const TRUST_REQUIRED = [
  'gitglasses.gitCommands',
  'gitglasses.interactiveRebase',
  'gitglasses.worktrees.add',
  'gitglasses.worktrees.remove',
  'gitglasses.startWork',
  'gitglasses.ai.generateCommitMessage',
  'gitglasses.createPatch',
  'gitglasses.applyPatch',
  'gitglasses.suggestChange',
  'gitglasses.home.push',
  'gitglasses.home.pull',
  'gitglasses.home.switchBranch',
  'gitglasses.home.createBranch',
  'gitglasses.stageSelectedHunks',
  'gitglasses.unstageSelectedHunks',
  'gitglasses.showLineHistory',
  'gitglasses.showFileHistory',
];

describe('manifest trust gates', () => {
  const commands = new Map(manifest.contributes.commands.map((c) => [c.command, c]));

  it('requires a trusted workspace for every command that runs git or changes the repository', () => {
    for (const id of TRUST_REQUIRED) {
      expect(commands.get(id)?.enablement ?? '', id).toMatch(/\bisWorkspaceTrusted\b/);
    }
  });

  it('requires trust wherever it requires the git CLI', () => {
    for (const command of commands.values()) {
      if (command.enablement?.includes('gitglasses.engineFullCapabilities')) {
        expect(command.enablement, command.command).toMatch(/\bisWorkspaceTrusted\b/);
      }
    }
  });

  it('hides those commands from menus in Restricted Mode', () => {
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      for (const item of items) {
        if (!item.command || !TRUST_REQUIRED.includes(item.command)) continue;
        if (item.when === 'false') continue;
        expect(item.when ?? '', `${menu}: ${item.command}`).toMatch(/\bisWorkspaceTrusted\b/);
      }
    }
  });

  it('keeps limited Restricted Mode support with user-only executable settings', () => {
    const untrusted = manifest.capabilities.untrustedWorkspaces;
    expect(untrusted.supported).toBe('limited');
    expect(untrusted.description).toMatch(/runs no git commands/);
    expect(untrusted.restrictedConfigurations).toContain('gitglasses.engine.path');
  });
});
