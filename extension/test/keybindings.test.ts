// The contributed keyboard shortcuts must never take over one the editor
// ships: VS Code's defaults on Linux, Windows and macOS, and Eclipse
// Theia's. The snapshots in fixtures/keybindings hold the first chord of
// every default binding; regenerate them with the scripts beside them when
// raising the VS Code the e2e suite pins.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { SHORTCUT_COMMANDS } from '../src/commands/keyboardShortcuts';

interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

interface Defaults {
  source: string;
  firstChords: Record<'linux' | 'win' | 'mac', string[]>;
}

const read = <T>(...segments: string[]): T =>
  JSON.parse(readFileSync(path.join(__dirname, ...segments), 'utf8')) as T;

const manifest = read<{
  contributes: {
    commands: Array<{ command: string; enablement?: string }>;
    keybindings: Keybinding[];
    configuration: { properties: Record<string, { type: string; default: unknown }> };
  };
}>('..', 'package.json');
const vscodeDefaults = read<Defaults>('fixtures', 'keybindings', 'vscode-defaults.json');
const theiaDefaults = read<Defaults>('fixtures', 'keybindings', 'theia-defaults.json');

const PLATFORMS = ['linux', 'win', 'mac'] as const;
const ORDER = ['ctrl', 'shift', 'alt', 'cmd', 'meta'];
const OPT_IN = 'config.gitglasses.keyboardShortcuts.enabled';

/** The first chord of a keybindings.json key, modifiers in the snapshots'
 *  order. */
function firstChord(key: string): string {
  const parts = key.trim().toLowerCase().split(/\s+/)[0].split('+');
  const name = parts.pop() ?? '';
  const mods = parts
    .map((mod) => (mod === 'win' ? 'meta' : mod))
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return [...mods, name].join('+');
}

function keyFor(binding: Keybinding, platform: (typeof PLATFORMS)[number]): string {
  return binding[platform] ?? binding.key;
}

/**
 * Default bindings a contributed chord may share its first key with, because
 * their when clauses cannot hold at the same time as ours.
 */
const DISJOINT: Array<{ chord: string; platforms: string[]; ours: RegExp; why: string }> = [
  {
    chord: 'ctrl+alt+g',
    platforms: ['linux', 'win'],
    ours: /!terminalFocus|\beditorTextFocus\b/,
    why: 'the terminal sends BEL for Ctrl+Alt+G only while it has focus',
  },
];

describe('contributed keyboard shortcuts', () => {
  const bindings = manifest.contributes.keybindings;

  it('are off until the user turns them on', () => {
    const setting =
      manifest.contributes.configuration.properties['gitglasses.keyboardShortcuts.enabled'];
    expect(setting).toMatchObject({ type: 'boolean', default: false });
    for (const binding of bindings) {
      expect(binding.when ?? '', binding.command).toContain(OPT_IN);
    }
  });

  it('run stand-ins, so the real commands never advertise a shortcut that is off', () => {
    const commands = new Map(manifest.contributes.commands.map((c) => [c.command, c]));
    for (const binding of bindings) {
      const target = SHORTCUT_COMMANDS[binding.command];
      expect(target, binding.command).toBeDefined();
      expect(commands.has(binding.command), binding.command).toBe(true);
      expect(commands.has(target), target).toBe(true);
      expect(commands.get(binding.command)?.enablement, binding.command).toBe(
        commands.get(target)?.enablement,
      );
    }
  });

  it('are two-key chords', () => {
    for (const binding of bindings) {
      for (const platform of PLATFORMS) {
        expect(keyFor(binding, platform).trim().split(/\s+/), binding.command).toHaveLength(2);
      }
    }
  });

  for (const defaults of [vscodeDefaults, theiaDefaults]) {
    it(`never start with a key ${defaults.source} binds by default`, () => {
      for (const binding of bindings) {
        for (const platform of PLATFORMS) {
          const chord = firstChord(keyFor(binding, platform));
          if (!defaults.firstChords[platform].includes(chord)) continue;
          const allowed = DISJOINT.find(
            (entry) => entry.chord === chord && entry.platforms.includes(platform),
          );
          expect(allowed, `${binding.command} on ${platform}: ${chord}`).toBeDefined();
          expect(binding.when ?? '', `${binding.command}: ${allowed?.why}`).toMatch(allowed!.ours);
        }
      }
    });
  }

  it('leave Show Source Control and Find Previous alone', () => {
    // The shortcuts an earlier prefix took over: Ctrl+Shift+G opens Source
    // Control on Windows and Linux (and in Theia), Cmd+Shift+G is Find
    // Previous on macOS.
    expect(vscodeDefaults.firstChords.linux).toContain('ctrl+shift+g');
    expect(vscodeDefaults.firstChords.mac).toContain('shift+cmd+g');
    for (const binding of bindings) {
      for (const platform of PLATFORMS) {
        expect(['ctrl+shift+g', 'shift+cmd+g']).not.toContain(
          firstChord(keyFor(binding, platform)),
        );
      }
    }
  });
});
