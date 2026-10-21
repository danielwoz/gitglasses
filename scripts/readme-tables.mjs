#!/usr/bin/env node
// Writes the settings and command tables of extension/README.md from
// extension/package.json, so the listing always shows every setting and
// every palette command. Usage:
//   node scripts/readme-tables.mjs           rewrite the tables in place
//   node scripts/readme-tables.mjs --check   exit 1 when they are out of date

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReadmeTables } from './lib/readme-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(root, 'extension', 'README.md');
const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'package.json'), 'utf8'));
const readme = readFileSync(readmePath, 'utf8');
const updated = renderReadmeTables(readme, manifest);

if (process.argv.includes('--check')) {
  if (updated !== readme) {
    console.error(
      'extension/README.md: the settings or commands tables are out of date; run `node scripts/readme-tables.mjs`',
    );
    process.exit(1);
  }
  console.log('extension/README.md tables are up to date');
} else if (updated !== readme) {
  writeFileSync(readmePath, updated);
  console.log('updated extension/README.md tables');
} else {
  console.log('extension/README.md tables are up to date');
}
