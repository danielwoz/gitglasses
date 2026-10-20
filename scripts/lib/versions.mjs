// Release version consistency. extension/package.json is the source of the
// version: the engine takes it through CMake, and every other manifest that
// carries a version, the changelog and the release tag must agree with it.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { hasChangelogEntry } from './vsix.mjs';

const VERSIONED_MANIFESTS = ['package.json', 'mcp-server/package.json'];

/**
 * Checks the tree at `root` (and `tag`, when given) for a releasable version.
 * Returns the version, whether it ships on the pre-release channel (odd
 * minor versions do; the Marketplace has no semver pre-release suffixes),
 * and every problem found.
 */
export function releaseVersionProblems(root, { tag } = {}) {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const extension = JSON.parse(read('extension/package.json'));
  const { version } = extension;
  const problems = [];

  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) problems.push(`extension/package.json version ${version} is not MAJOR.MINOR.PATCH`);

  for (const file of VERSIONED_MANIFESTS) {
    const other = JSON.parse(read(file)).version;
    if (other !== version) problems.push(`${file} is ${other}, extension/package.json is ${version}`);
  }

  const cmake = read('CMakeLists.txt');
  const project = /project\(\s*gitglasses\s+VERSION\s+([^\s)]+)/.exec(cmake)?.[1];
  const derived = project === '${GG_VERSION}' && cmake.includes('extension/package.json');
  if (!derived && project !== version) {
    problems.push(`CMakeLists.txt project version is ${project}, extension/package.json is ${version}`);
  }

  if (!hasChangelogEntry(read('extension/CHANGELOG.md'), version)) {
    problems.push(`extension/CHANGELOG.md has no entry for ${version}`);
  }

  if (tag !== undefined && tag !== `v${version}`) {
    problems.push(`tag ${tag} does not match extension/package.json version ${version}`);
  }

  const typesProblem = vscodeTypesProblem(extension);
  if (typesProblem) problems.push(typesProblem);

  return { version, prerelease: match ? Number(match[2]) % 2 === 1 : false, problems };
}

/**
 * The @types/vscode range must stay on the engines.vscode floor's minor, or
 * code can compile against APIs that the oldest supported host lacks.
 */
export function vscodeTypesProblem(manifest) {
  const engine = manifest.engines?.vscode ?? '';
  const types = manifest.devDependencies?.['@types/vscode'] ?? '';
  const floor = /^\^?(\d+)\.(\d+)\.\d+$/.exec(engine);
  if (!floor) return `engines.vscode ${engine} is not a ^MAJOR.MINOR.PATCH floor`;
  const [, major, minor] = floor;
  const pinned = new RegExp(`^(~${major}\\.${minor}\\.\\d+|${major}\\.${minor}\\.(\\d+|x))$`);
  if (!pinned.test(types)) {
    return `@types/vscode ${types || '(missing)'} must stay on ${major}.${minor} to match engines.vscode ${engine}`;
  }
  return undefined;
}
