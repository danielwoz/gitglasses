// What the manifest promises the user before any code runs: palette entries
// only where a command can act, one category for every command, a focused
// default sidebar, and view states the extension renders itself.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Command {
  command: string;
  title: string;
  category?: string;
}

interface MenuItem {
  command?: string;
  when?: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: Command[];
    menus: Record<string, MenuItem[]>;
    views: Record<string, Array<{ id: string; name: string; visibility?: string }>>;
    viewsWelcome?: unknown[];
    walkthroughs: Array<{ steps: Array<{ description: string; completionEvents?: string[] }> }>;
  };
}

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as Manifest;
const { commands, menus, views, walkthroughs } = manifest.contributes;

/** Commands that act anywhere: no repository, file or trust needed. */
const ALWAYS_AVAILABLE = new Set([
  'gitglasses.restartEngine',
  'gitglasses.groups.open',
  'gitglasses.groups.delete',
  'gitglasses.groups.export',
  'gitglasses.groups.import',
  'gitglasses.connectIntegration',
  'gitglasses.disconnectIntegration',
  'gitglasses.removeIntegration',
  'gitglasses.launchpad.refresh',
  'gitglasses.ai.setApiKey',
  'gitglasses.ai.clearApiKey',
  'gitglasses.switchMode',
  'gitglasses.openWalkthrough',
]);

describe('command palette', () => {
  const palette = new Map((menus.commandPalette ?? []).map((item) => [item.command, item.when]));

  it('puts every command under the GitGlasses category, without repeating it in the title', () => {
    for (const command of commands) {
      expect(command.category, command.command).toBe('GitGlasses');
      expect(command.title, command.command).not.toMatch(/^GitGlasses:/);
    }
  });

  it('says where each command can act, unless it can act anywhere', () => {
    for (const command of commands) {
      if (ALWAYS_AVAILABLE.has(command.command)) {
        expect(palette.has(command.command), command.command).toBe(false);
      } else {
        expect(palette.get(command.command), command.command).toBeTruthy();
      }
    }
  });

  it('offers repository commands only with a repository open', () => {
    for (const [command, when] of palette) {
      if (when === 'false') continue;
      if (command === 'gitglasses.groups.create' || command === 'gitglasses.selectRepository') {
        continue;
      }
      expect(when, command).toMatch(/\bgitglasses\.hasRepository\b/);
    }
  });

  it('hides commands that need a tree item or a file editor where they have none', () => {
    for (const nodeOnly of [
      'gitglasses.copySha',
      'gitglasses.openCommitDiff',
      'gitglasses.openCommitOnRemote',
      'gitglasses.worktrees.open',
      'gitglasses.launchpad.open',
    ]) {
      expect(palette.get(nodeOnly), nodeOnly).toBe('false');
    }
    for (const fileOnly of [
      'gitglasses.toggleFileBlame',
      'gitglasses.diffWithHead',
      'gitglasses.openOnRemote',
      'gitglasses.stageSelectedHunks',
    ]) {
      expect(palette.get(fileOnly), fileOnly).toMatch(/\bresourceScheme == file\b/);
    }
  });
});

describe('sidebar', () => {
  const sidebar = views.gitglasses;

  it('opens on a focused set of views and keeps the rest a click away', () => {
    const expanded = sidebar.filter((view) => !view.visibility || view.visibility === 'visible');
    const collapsed = sidebar.filter((view) => view.visibility === 'collapsed');
    const hidden = sidebar.filter((view) => view.visibility === 'hidden');
    expect(expanded.map((view) => view.name)).toEqual(['Home', 'Commits', 'File History']);
    expect(collapsed.map((view) => view.name)).toEqual([
      'Branches',
      'Worktrees',
      'Search & Compare',
      'Launchpad',
    ]);
    expect(hidden.map((view) => view.name).sort()).toEqual(
      ['Contributors', 'Remotes', 'Stashes', 'Tags'].sort(),
    );
  });

  it('contributes no welcome content, which some hosts show in place of the tree', () => {
    expect(manifest.contributes.viewsWelcome).toBeUndefined();
  });
});
