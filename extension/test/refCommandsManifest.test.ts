// The view and rebase commands as the manifest contributes them: each one the
// code registers is declared, the ones that change the repository or contact
// a remote need a trusted workspace and the git CLI, and their menu entries
// disappear in Restricted Mode.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Manifest {
  contributes: {
    commands: { command: string; title: string; enablement?: string }[];
    menus: Record<string, { command?: string; when?: string; group?: string }[]>;
  };
}

const extensionRoot = path.join(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'),
) as Manifest;

function registeredIds(file: string): string[] {
  const source = readFileSync(path.join(extensionRoot, file), 'utf8');
  return [
    ...source.matchAll(/'(gitglasses\.(?:branch|ref|tag|stash|remote|rebase)\.[A-Za-z]+)'/g),
  ].map((match) => match[1]);
}

const REGISTERED = [
  ...new Set([
    ...registeredIds('src/views/refCommands.ts'),
    ...registeredIds('src/views/refsViews.ts'),
    ...registeredIds('src/webviews/rebaseHost.ts'),
  ]),
];

// Read-only: comparisons, showing a stash, opening a web page, copying a name.
const READ_ONLY = new Set([
  'gitglasses.branch.openOnRemote',
  'gitglasses.ref.compareWithHead',
  'gitglasses.ref.compareWithWorkingTree',
  'gitglasses.ref.copyName',
  'gitglasses.stash.show',
  'gitglasses.remote.openOnHost',
  'gitglasses.rebase.show',
]);

describe('view and rebase command contributions', () => {
  const commands = new Map(manifest.contributes.commands.map((c) => [c.command, c]));

  it('declares every command the views and the rebase editor register', () => {
    expect(REGISTERED.length).toBeGreaterThan(25);
    for (const id of REGISTERED) expect(commands.has(id), id).toBe(true);
  });

  it('requires trust and the git CLI for every command that runs git', () => {
    for (const id of REGISTERED) {
      if (READ_ONLY.has(id)) continue;
      expect(commands.get(id)?.enablement, id).toBe(
        'isWorkspaceTrusted && gitglasses.engineFullCapabilities',
      );
    }
  });

  it('hides those commands from the views in Restricted Mode', () => {
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      for (const item of items) {
        if (!item.command || !REGISTERED.includes(item.command) || READ_ONLY.has(item.command)) {
          continue;
        }
        if (item.when === 'false') continue;
        if (menu === 'commandPalette') continue;
        expect(item.when ?? '', `${menu}: ${item.command}`).toMatch(/\bisWorkspaceTrusted\b/);
      }
    }
  });

  it('puts actions on every kind of node in the four views', () => {
    const itemMenus = manifest.contributes.menus['view/item/context'];
    for (const viewItem of [
      'gitglassesBranch',
      'gitglassesCurrentBranch',
      'gitglassesRemoteBranch',
      'gitglassesRemote',
      'gitglassesTag',
      'gitglassesStash',
    ]) {
      const actions = itemMenus.filter((item) => {
        const when = item.when ?? '';
        const regex = /viewItem =~ \/(.*?)\/(?:\s|$)/.exec(when);
        if (regex) return new RegExp(regex[1]).test(viewItem);
        return new RegExp(`viewItem == ${viewItem}(\\s|$)`).test(when);
      });
      const own = actions.filter((item) => item.command !== 'gitglasses.copySha');
      expect(own.length, viewItem).toBeGreaterThanOrEqual(3);
    }
  });
});
