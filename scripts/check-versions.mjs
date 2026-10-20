#!/usr/bin/env node
// Checks that the release version agrees everywhere it appears.
// Usage:
//   node scripts/check-versions.mjs [--tag v0.2.0]
// Prints `version=<v>` and `prerelease=<true|false>` (GITHUB_OUTPUT format)
// on success; lists every disagreement on stderr and exits 1 otherwise.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseVersionProblems } from './lib/versions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
if ((tagIndex >= 0 && !tag) || args.length !== (tagIndex >= 0 ? 2 : 0)) {
  console.error('usage: check-versions.mjs [--tag v<version>]');
  process.exit(2);
}

const { version, prerelease, problems } = releaseVersionProblems(root, { tag });
if (problems.length > 0) {
  console.error(`check-versions: the release version does not agree:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`version=${version}`);
console.log(`prerelease=${prerelease}`);
