#!/usr/bin/env node
// Prints a version's changelog section: the GitHub release notes.
// Usage:
//   node scripts/release-notes.mjs <version> [--changelog <file>]
// The changelog defaults to extension/CHANGELOG.md. Exits 1 when it has no
// section for the version, or the section is empty.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection } from './lib/changelog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const changelogIndex = args.indexOf('--changelog');
const changelogFile =
  changelogIndex >= 0 ? args[changelogIndex + 1] : path.join(root, 'extension', 'CHANGELOG.md');
const version = args.find((arg, index) => !arg.startsWith('--') && (changelogIndex < 0 || index !== changelogIndex + 1));
if (!version || !changelogFile || args.length !== (changelogIndex >= 0 ? 3 : 1)) {
  console.error('usage: release-notes.mjs <version> [--changelog <file>]');
  process.exit(2);
}

const notes = changelogSection(readFileSync(changelogFile, 'utf8'), version);
if (!notes) {
  console.error(`release-notes: ${changelogFile} has no ${notes === undefined ? '' : 'non-empty '}section for ${version}`);
  process.exit(1);
}
console.log(notes);
