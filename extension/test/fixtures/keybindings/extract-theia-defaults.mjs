#!/usr/bin/env node
// Regenerates theia-defaults.json: the first chord of every keybinding the
// Eclipse Theia framework registers, per platform, read from the frontend
// bundle's source map of a Theia application (the theia-ide image keeps it at
// /home/theia/applications/browser/lib/frontend/bundle.js.map).
//
//   node extract-theia-defaults.mjs <bundle.js.map> <theia version> > theia-defaults.json
//
// Theia also runs VS Code's built-in extensions and Monaco's editor actions;
// their keys are in vscode-defaults.json.

import * as fs from 'node:fs';

const PLATFORMS = ['linux', 'win', 'mac'];
const ORDER = ['ctrl', 'shift', 'alt', 'cmd', 'meta'];

/** A Theia key sequence's first chord, in the order vscode-defaults.json
 *  writes modifiers. Theia's ctrlcmd is Cmd on macOS and Ctrl elsewhere. */
function firstChord(sequence, platform) {
  const chord = sequence.trim().toLowerCase().split(/\s+/)[0];
  const parts = chord.split(/\+|-(?=.)/);
  const key = parts.pop();
  const mods = parts.map((mod) => {
    if (mod === 'ctrlcmd') return platform === 'mac' ? 'cmd' : 'ctrl';
    if (mod === 'meta' || mod === 'cmd') return platform === 'mac' ? 'cmd' : 'meta';
    return mod;
  });
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return [...new Set(mods), key].join('+');
}

function main() {
  const [mapPath, version] = process.argv.slice(2);
  if (!mapPath || !version) {
    console.error('usage: extract-theia-defaults.mjs <bundle.js.map> <theia version>');
    process.exit(2);
  }
  const text = fs.readFileSync(mapPath, 'utf8');
  const sequences = new Set();
  // The sources are embedded as JSON strings, so quotes may be escaped.
  for (const match of text.matchAll(/(?:toggleKeybinding|keybinding):\s?\\?['"]([^'"\\]{1,40})/g)) {
    if (/[a-z0-9`]$/i.test(match[1].trim())) sequences.add(match[1]);
  }
  const output = {
    source: `Eclipse Theia ${version}`,
    firstChords: Object.fromEntries(
      PLATFORMS.map((platform) => [
        platform,
        [...new Set([...sequences].map((sequence) => firstChord(sequence, platform)))].sort(),
      ]),
    ),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
