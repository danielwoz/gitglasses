#!/usr/bin/env node
// Regenerates vscode-defaults.json: the first chord of every keybinding VS
// Code ships by default, per platform, read from an installed build.
//
//   node extract-vscode-defaults.mjs <vscode install dir> > vscode-defaults.json
//
// The install dir is the one @vscode/test-electron unpacks into
// extension/.vscode-test (it holds resources/app). Two sources are read:
//
//  - The workbench bundle, where every built-in rule is a literal object such
//    as {primary:3109,mac:{primary:1317},when:…}. Key codes are VS Code's
//    KeyCode values with the KeyMod bits on top (CtrlCmd 2048, Shift 1024,
//    Alt 512, WinCtrl 256); a chord keeps its second part in the upper 16
//    bits or is built by a call such as no(2089,2079). A mac/win/linux block
//    replaces the generic keys on that platform.
//  - The keybindings the built-in extensions contribute in their manifests.
//
// Rules whose keys are computed at runtime (focus the Nth editor group and
// the like) are not literal and are skipped; they bind digits only.

import * as fs from 'node:fs';
import * as path from 'node:path';

const PLATFORMS = ['linux', 'win', 'mac'];

const KEY_NAMES = (() => {
  const names = {
    1: 'backspace',
    2: 'tab',
    3: 'enter',
    7: 'pausebreak',
    8: 'capslock',
    9: 'escape',
    10: 'space',
    11: 'pageup',
    12: 'pagedown',
    13: 'end',
    14: 'home',
    15: 'left',
    16: 'up',
    17: 'right',
    18: 'down',
    19: 'insert',
    20: 'delete',
    57: 'meta',
    58: 'contextmenu',
    83: 'numlock',
    84: 'scrolllock',
    85: ';',
    86: '=',
    87: ',',
    88: '-',
    89: '.',
    90: '/',
    91: '`',
    92: '[',
    93: '\\',
    94: ']',
    95: "'",
    96: 'oem_8',
    97: 'oem_102',
    108: 'numpad_multiply',
    109: 'numpad_add',
    110: 'numpad_separator',
    111: 'numpad_subtract',
    112: 'numpad_decimal',
    113: 'numpad_divide',
  };
  for (let i = 0; i <= 9; i++) names[21 + i] = String(i);
  for (let i = 0; i < 26; i++) names[31 + i] = String.fromCharCode(97 + i);
  for (let i = 1; i <= 24; i++) names[58 + i] = `f${i}`;
  for (let i = 0; i <= 9; i++) names[98 + i] = `numpad${i}`;
  return names;
})();

const CTRL_CMD = 2048;
const SHIFT = 1024;
const ALT = 512;
const WIN_CTRL = 256;

/** One chord of a key code as VS Code writes it in keybindings.json. */
function chordName(code, platform) {
  const key = KEY_NAMES[code & 0xff] ?? `keycode${code & 0xff}`;
  const ctrl = platform === 'mac' ? code & WIN_CTRL : code & CTRL_CMD;
  const meta = platform === 'mac' ? code & CTRL_CMD : code & WIN_CTRL;
  const parts = [];
  if (ctrl) parts.push('ctrl');
  if (code & SHIFT) parts.push('shift');
  if (code & ALT) parts.push('alt');
  if (meta) parts.push(platform === 'mac' ? 'cmd' : 'meta');
  parts.push(key);
  return parts.join('+');
}

/** The opening brace of the object literal that encloses `index`. */
function enclosingBrace(text, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The matching close brace of the object that opens at `open`. */
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** First chords of a primary value or secondary list as written in the
 *  bundle: integer literals and KeyChord calls with literal arguments. */
function firstChords(expression) {
  const codes = [];
  const pattern = /(?:\b[A-Za-z_$][\w$]*\((\d+),\s*\d+\))|(?:(?<![\w$.])(\d+)(?![\w$(]))/g;
  for (const match of expression.matchAll(pattern)) {
    const value = Number(match[1] ?? match[2]);
    if (!Number.isFinite(value) || value === 0) continue;
    codes.push(value > 0xffff ? value & 0xffff : value);
  }
  return codes;
}

/** The value expression that starts at `start`: everything up to the next
 *  comma or closing brace outside brackets and parentheses. A key can be
 *  chosen at load time (`isWeb?void 0:3118`), and every literal in it counts. */
function valueAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if ((ch === ',' || ch === '}') && depth === 0) return text.slice(start, i);
    if (depth < 0) return text.slice(start, i);
  }
  return text.slice(start);
}

function fromBundle(source, found) {
  const pattern = /\b(primary|secondary):/g;
  for (const match of source.matchAll(pattern)) {
    const codes = firstChords(valueAt(source, match.index + match[0].length));
    if (codes.length === 0) continue;
    const open = enclosingBrace(source, match.index);
    if (open < 0) continue;
    const owner = /(mac|win|linux):$/.exec(source.slice(Math.max(0, open - 6), open))?.[1];
    let platforms;
    if (owner) {
      platforms = [owner];
    } else {
      // A generic key applies wherever the same object has no override.
      const body = source.slice(open, closingBrace(source, open) + 1);
      platforms = PLATFORMS.filter((platform) => !new RegExp(`[{,]${platform}:\\{`).test(body));
    }
    for (const platform of platforms) {
      for (const code of codes) found[platform].add(chordName(code, platform));
    }
  }
}

/** The first chord of a keybindings.json key, modifiers in chordName's order. */
function normalize(key) {
  const chord = key.trim().toLowerCase().split(/\s+/)[0];
  const parts = chord.split('+');
  const name = parts.pop();
  const order = ['ctrl', 'shift', 'alt', 'cmd', 'meta'];
  const mods = parts
    .map((mod) => (mod === 'win' ? 'meta' : mod))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, name].join('+');
}

function fromExtensions(extensionsDir, found) {
  for (const name of fs.readdirSync(extensionsDir)) {
    const manifest = path.join(extensionsDir, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const bindings = json.contributes?.keybindings ?? [];
    for (const binding of Array.isArray(bindings) ? bindings : [bindings]) {
      for (const platform of PLATFORMS) {
        const key = binding[platform] ?? binding.key;
        if (typeof key === 'string' && key) found[platform].add(normalize(key));
      }
    }
  }
}

function main() {
  const installDir = process.argv[2];
  if (!installDir) {
    console.error('usage: extract-vscode-defaults.mjs <vscode install dir>');
    process.exit(2);
  }
  const app = path.join(installDir, 'resources', 'app');
  const product = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  const bundle = fs.readFileSync(
    path.join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    'utf8',
  );
  const found = Object.fromEntries(PLATFORMS.map((platform) => [platform, new Set()]));
  fromBundle(bundle, found);
  fromExtensions(path.join(app, 'extensions'), found);
  const output = {
    source: `VS Code ${product.version}`,
    firstChords: Object.fromEntries(
      PLATFORMS.map((platform) => [platform, [...found[platform]].sort()]),
    ),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
