// The listing README's settings and commands tables are generated from the
// extension manifest; the committed README must match it.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandsTable, renderReadmeTables, settingsTable } from '../lib/readme-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'package.json'), 'utf8'));
const readme = readFileSync(path.join(root, 'extension', 'README.md'), 'utf8');

describe('extension README tables', () => {
  it('match the manifest (run `node scripts/readme-tables.mjs` after changing settings or commands)', () => {
    expect(renderReadmeTables(readme, manifest)).toBe(readme);
  });

  it('list every setting and every palette command', () => {
    for (const key of Object.keys(manifest.contributes.configuration.properties)) {
      expect(readme).toContain(`| \`${key}\` |`);
    }
    const hidden = new Set(
      manifest.contributes.menus.commandPalette
        .filter((entry) => entry.when === 'false')
        .map((entry) => entry.command),
    );
    for (const command of manifest.contributes.commands) {
      if (!hidden.has(command.command)) expect(readme).toContain(`\`${command.command}\``);
    }
  });
});

describe('settingsTable', () => {
  it('renders defaults, enums, deprecations and escapes table syntax', () => {
    const table = settingsTable({
      contributes: {
        configuration: {
          properties: {
            'x.mode': { type: 'string', enum: ['a', 'b'], default: 'a', description: 'Mode' },
            'x.list': { type: 'array', default: [], description: 'A | B' },
            'x.old': {
              type: 'string',
              default: '',
              description: 'Old.',
              markdownDeprecationMessage: 'Use `#x.new#`.',
            },
          },
        },
      },
    });
    expect(table.split('\n')).toEqual([
      '| Setting | Default | Description |',
      '| --- | --- | --- |',
      '| `x.mode` | `"a"` | Mode. One of `a`, `b`. |',
      '| `x.list` | `[]` | A \\| B |',
      '| `x.old` | `""` | **Deprecated.** Use `x.new`. Old. |',
    ]);
  });
});

describe('commandsTable', () => {
  it('groups palette commands by area, skips hidden ones and marks trusted-only ones', () => {
    const table = commandsTable({
      contributes: {
        commands: [
          {
            command: 'gitglasses.toggleLineBlame',
            title: 'Toggle Inline Blame',
            category: 'GitGlasses',
          },
          { command: 'gitglasses.copySha', title: 'Copy SHA' },
          {
            command: 'gitglasses.ai.generateCommitMessage',
            title: 'GitGlasses: AI Generate Commit Message',
            enablement: 'isWorkspaceTrusted',
          },
        ],
        menus: { commandPalette: [{ command: 'gitglasses.copySha', when: 'false' }] },
      },
    });
    expect(table).toContain('#### Blame and annotations');
    expect(table).toContain(
      '| GitGlasses: Toggle Inline Blame | `gitglasses.toggleLineBlame` |  |',
    );
    expect(table).toContain(
      '| GitGlasses: AI Generate Commit Message | `gitglasses.ai.generateCommitMessage` | trusted workspace |',
    );
    expect(table).not.toContain('copySha');
  });
});
