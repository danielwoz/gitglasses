// The gitglasses-mcp npm package as published: its manifest, its files and
// the README npm shows. The repository README describes running the server
// from a clone; npm users get mcp-server/npm-readme.md instead.
//
// The engine ships the way esbuild ships its binary: one package per
// platform (@gitglasses/engine-<os>-<cpu>[-musl]), each restricted to its
// platform with os, cpu and libc, all listed as optional dependencies of
// gitglasses-mcp. npm installs only the one that matches, and the server
// finds it there (mcp-server/src/engine.ts) without GITGLASSES_ENGINE.

import { engineBinaryName } from './targets.mjs';

/** Path of the npm README template, relative to the repository root. */
export const NPM_README_TEMPLATE = 'mcp-server/npm-readme.md';

/** Every file the published package contains. */
export const PACKAGE_FILES = ['LICENSE', 'README.md', 'dist/cli.js', 'package.json'];

/**
 * The engine packages, one per release engine build (the VSIX target it is
 * built for). The Alpine engines are static musl binaries.
 */
export const ENGINE_PACKAGES = Object.freeze(
  [
    ['linux-x64', 'linux', 'x64', 'glibc'],
    ['linux-arm64', 'linux', 'arm64', 'glibc'],
    ['alpine-x64', 'linux', 'x64', 'musl'],
    ['alpine-arm64', 'linux', 'arm64', 'musl'],
    ['darwin-x64', 'darwin', 'x64'],
    ['darwin-arm64', 'darwin', 'arm64'],
    ['win32-x64', 'win32', 'x64'],
    ['win32-arm64', 'win32', 'arm64'],
  ].map(([target, os, cpu, libc]) =>
    Object.freeze({
      target,
      os,
      cpu,
      libc,
      name: `@gitglasses/engine-${os}-${cpu}${libc === 'musl' ? '-musl' : ''}`,
      binary: `bin/${engineBinaryName(target)}`,
    }),
  ),
);

/** The npm tarball name of a package, as `npm pack` writes it. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * The manifest as published. The build scripts and the development
 * dependencies, which name unpublished workspace packages, mean nothing to
 * an npm user and are left out. The engine packages of the same version are
 * optional dependencies: npm installs the one for its platform.
 */
export function publishedManifest(manifest) {
  const { scripts, devDependencies, ...published } = manifest;
  return {
    ...published,
    optionalDependencies: Object.fromEntries(
      ENGINE_PACKAGES.map((engine) => [engine.name, manifest.version]),
    ),
  };
}

/** Every file a published engine package contains. */
export function enginePackageFiles(engine) {
  return ['LICENSE', 'NOTICE', 'README.md', engine.binary, 'package.json'].sort();
}

/** The manifest of an engine package, restricted to its platform. */
export function engineManifest(engine, mcpManifest) {
  const libc = engine.libc === 'musl' ? ', musl libc (Alpine)' : '';
  return {
    name: engine.name,
    version: mcpManifest.version,
    description: `The gitglasses-engine binary for ${engine.os} ${engine.cpu}${libc}, used by gitglasses-mcp`,
    license: mcpManifest.license,
    homepage: mcpManifest.homepage,
    bugs: mcpManifest.bugs,
    repository: { ...mcpManifest.repository, directory: 'engine' },
    os: [engine.os],
    cpu: [engine.cpu],
    ...(engine.libc ? { libc: [engine.libc] } : {}),
    files: [engine.binary, 'NOTICE'],
    preferUnplugged: true,
    publishConfig: { access: 'public', provenance: true },
  };
}

/** The README of an engine package. */
export function engineReadme(engine, version) {
  return [
    `# ${engine.name}`,
    '',
    `The \`gitglasses-engine\` binary for ${engine.os} ${engine.cpu}${
      engine.libc === 'musl' ? ' with musl libc (Alpine, statically linked)' : ''
    }, version ${version}.`,
    '',
    'It is an optional dependency of [gitglasses-mcp](https://www.npmjs.com/package/gitglasses-mcp),',
    'which finds it on its own; there is no need to install it directly.',
    'NOTICE lists the third-party software the binary contains and their licenses.',
    '',
  ].join('\n');
}

/** The npm README for `version`: the template without its leading comment, with the version filled in. */
export function renderNpmReadme(template, version) {
  return template.replace(/^<!--[\s\S]*?-->\s*/, '').replaceAll('{{version}}', version);
}

/** What would make `readme` wrong on the npm page of gitglasses-mcp `version`. */
export function npmReadmeProblems(readme, version) {
  const problems = [];
  if (readme.includes('{{') || readme.startsWith('<!--'))
    problems.push('README still has template markup');
  if (!readme.includes(`gitglasses-mcp@${version}`))
    problems.push(`README does not show how to run gitglasses-mcp@${version}`);
  if (/not on npm yet/i.test(readme)) problems.push('README says the package is not on npm');
  if (/git clone|pnpm (install|--filter)/.test(readme))
    problems.push('README tells readers to build from a clone');
  if (/\/path\/to\/gitglasses\/|mcp-server\/dist|build\/release/.test(readme)) {
    problems.push('README gives paths inside a clone');
  }
  return problems;
}
