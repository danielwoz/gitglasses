// Launchpad's first run offers ways to connect a provider, and using any of
// them completes the walkthrough's integrations step.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { LaunchpadViewProvider } from '../src/views/launchpadView';
import type { LaunchpadService } from '../src/integrations/launchpadService';

const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    walkthroughs: Array<{ steps: Array<{ id: string; completionEvents?: string[] }> }>;
  };
};

describe('Launchpad first run', () => {
  it('completes the walkthrough’s integrations step from every way to connect it offers', async () => {
    const service = {
      getModel: async () => ({ connected: false, groups: [], attentionCount: 0 }),
    } as unknown as LaunchpadService;
    const provider = new LaunchpadViewProvider(service, () => undefined);
    await provider.reload();

    const actions = provider
      .getChildren()
      .map((node) => node.item.command?.command)
      .filter((command): command is string => command !== undefined);
    expect(actions).toEqual([
      'gitglasses.launchpad.connectGitHub',
      'gitglasses.connectIntegration',
    ]);
    const step = manifest.contributes.walkthroughs[0].steps.find(
      (candidate) => candidate.id === 'integrations',
    );
    for (const command of actions) {
      expect(step?.completionEvents, command).toContain(`onCommand:${command}`);
    }
    provider.dispose();
  });
});
