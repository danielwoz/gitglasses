// Checks a packaged VSIX against what every GitGlasses release must carry:
// the right target platform, exactly the right engine for it, the bundled MCP
// server, the license, third-party notices, a changelog entry for the
// version, and the icon.

import { builtinModules } from 'node:module';
import { hasChangelogEntry } from './changelog.mjs';
import { readZipEntries, readZipEntry } from './zip.mjs';
import {
  ENGINE_HEADER_BYTES,
  WEB_TARGET,
  engineBinaryName,
  engineFormatProblem,
  isNativeTarget,
  wasmProblem,
} from './targets.mjs';

const MANIFEST = 'extension.vsixmanifest';
const PACKAGE_JSON = 'extension/package.json';
// vsce stores LICENSE as LICENSE.txt and lower-cases the changelog's name.
const LICENSE_NAMES = ['extension/license.txt', 'extension/license', 'extension/license.md'];
const NOTICE = 'extension/notice';
const CHANGELOG = 'extension/changelog.md';
const BIN_PREFIX = 'extension/bin/';
const WEB_BUNDLE = 'extension/dist/web/extension.js';
const WEB_WASM = 'extension/dist/web/gitglasses-engine-wasm.wasm';
/** The MCP server the extension registers with the editor's agents. */
export const MCP_BUNDLE = 'extension/dist/mcp/cli.js';
const MIN_ICON_SIZE = 128;

/**
 * Inspects a VSIX for `target`. Returns the problems found (empty when the
 * package is good), the extension manifest, and for native targets the
 * engine entry and its contents.
 */
export function inspectVsix(archive, { target, version } = {}) {
  const problems = [];
  let entries;
  try {
    entries = readZipEntries(archive);
  } catch (error) {
    return { problems: [error.message] };
  }
  const read = (name) => readZipEntry(archive, entries.get(name));
  // Top-level documents are looked up case-insensitively.
  const named = new Map([...entries.keys()].map((name) => [name.toLowerCase(), name]));
  const document = (name) => (named.has(name) ? entries.get(named.get(name)) : undefined);

  if (!entries.has(MANIFEST)) {
    problems.push(`${MANIFEST} is missing`);
  } else {
    const manifest = read(MANIFEST).toString('utf8');
    const platform = /<Identity\b[^>]*\bTargetPlatform="([^"]*)"/.exec(manifest)?.[1];
    if (platform !== target)
      problems.push(`target platform is ${platform ?? 'unset'}, expected ${target}`);
    if (!/<License>[^<]+<\/License>/.test(manifest))
      problems.push('manifest declares no license file');
  }

  let packageJson;
  if (!entries.has(PACKAGE_JSON)) {
    problems.push(`${PACKAGE_JSON} is missing`);
  } else {
    packageJson = JSON.parse(read(PACKAGE_JSON).toString('utf8'));
    if (version !== undefined && packageJson.version !== version) {
      problems.push(`package.json version is ${packageJson.version}, expected ${version}`);
    }
    problems.push(...iconProblems(entries, read, packageJson.icon));
  }
  const expectedVersion = version ?? packageJson?.version;

  if (!LICENSE_NAMES.some((name) => document(name))) problems.push('LICENSE is missing');
  if (!document(NOTICE)?.size) problems.push('NOTICE is missing');
  const changelog = document(CHANGELOG);
  if (!changelog) {
    problems.push('CHANGELOG.md is missing');
  } else if (
    expectedVersion !== undefined &&
    !hasChangelogEntry(readZipEntry(archive, changelog).toString('utf8'), expectedVersion)
  ) {
    problems.push(`CHANGELOG.md has no entry for ${expectedVersion}`);
  }

  const binEntries = [...entries.keys()].filter(
    (name) => name.startsWith(BIN_PREFIX) && !name.endsWith('/'),
  );
  let engine;
  let mcp;
  if (target === WEB_TARGET) {
    if (binEntries.length > 0)
      problems.push(`web package carries native files: ${binEntries.join(', ')}`);
    if (!entries.has(WEB_BUNDLE)) problems.push(`${WEB_BUNDLE} is missing`);
    if (!entries.has(WEB_WASM)) {
      problems.push(`${WEB_WASM} is missing`);
    } else {
      const problem = wasmProblem(read(WEB_WASM));
      if (problem) problems.push(`wasm engine: ${problem}`);
    }
    if (packageJson && !packageJson.browser)
      problems.push('package.json has no browser entry point');
  } else if (isNativeTarget(target)) {
    const expected = BIN_PREFIX + engineBinaryName(target);
    const extra = binEntries.filter((name) => name !== expected);
    if (extra.length > 0) problems.push(`unexpected files next to the engine: ${extra.join(', ')}`);
    if (!entries.has(expected)) {
      problems.push(`${expected} is missing`);
    } else {
      const entry = entries.get(expected);
      const data = read(expected);
      const problem = engineFormatProblem(data.subarray(0, ENGINE_HEADER_BYTES), target);
      if (problem) problems.push(`engine is not a ${target} executable: ${problem}`);
      if (!target.startsWith('win32-') && (entry.mode & 0o111) === 0)
        problems.push('engine is not marked executable');
      engine = { name: expected, size: entry.size, compressedSize: entry.compressedSize, data };
    }
    if (!entries.has(MCP_BUNDLE)) {
      problems.push(`${MCP_BUNDLE} is missing`);
    } else {
      const bundle = read(MCP_BUNDLE);
      problems.push(...mcpBundleProblems(bundle.toString('utf8'), expectedVersion));
      mcp = { name: MCP_BUNDLE, data: bundle };
    }
  } else {
    problems.push(`unknown target ${target}`);
  }

  return { problems, packageJson, engine, mcp, entries };
}

/**
 * What would stop the bundled MCP server from running on its own: the
 * editor's Node runs it straight from the extension directory, which has no
 * node_modules, so it may load nothing but Node's built-in modules. A
 * `require("…")` inside a string is code a library generates, not a load.
 */
export function mcpBundleProblems(source, version) {
  const problems = [];
  const builtins = new Set(builtinModules);
  const loaded = new Set();
  for (const match of source.matchAll(/(?<!['"`])\brequire\("([^"]+)"\)/g)) {
    const name = match[1];
    if (!name.startsWith('node:') && !builtins.has(name)) loaded.add(name);
  }
  if (loaded.size > 0) {
    problems.push(
      `${MCP_BUNDLE} loads modules that are not bundled: ${[...loaded].sort().join(', ')}`,
    );
  }
  if (/^\s*(import|export)\s/m.test(source)) {
    problems.push(`${MCP_BUNDLE} is an ES module; the editor's Node runs it as CommonJS`);
  }
  if (version !== undefined && !source.includes(JSON.stringify(version))) {
    problems.push(`${MCP_BUNDLE} does not report version ${version}`);
  }
  return problems;
}

function iconProblems(entries, read, icon) {
  if (!icon) return ['package.json has no icon'];
  const name = `extension/${icon.replace(/^\.\//, '')}`;
  if (!entries.has(name)) return [`icon ${icon} is missing`];
  const png = read(name);
  if (
    png.length < 24 ||
    png.toString('latin1', 1, 4) !== 'PNG' ||
    png.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return [`icon ${icon} is not a PNG`];
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== height || width < MIN_ICON_SIZE) {
    return [
      `icon ${icon} is ${width}x${height}; it must be square and at least ${MIN_ICON_SIZE}px`,
    ];
  }
  return [];
}
