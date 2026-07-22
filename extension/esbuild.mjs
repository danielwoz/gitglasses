import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const root = dirname(fileURLToPath(import.meta.url));

// Wasm engine artifacts (built by `cmake --preset wasm`): the glue .mjs is
// inlined into the web bundle via the 'gitglasses-engine-wasm' alias, and the
// .wasm ships in dist/web as an asset the loader reads at runtime. When the
// artifacts are absent (native-only checkouts) the web bundle is skipped.
const wasmArtifacts = ['gitglasses-engine-wasm.mjs', 'gitglasses-engine-wasm.wasm'];
const wasmSourceDir = join(root, '..', 'build', 'wasm', 'engine');
const webDistDir = join(root, 'dist', 'web');
const hasWasm = wasmArtifacts.every((name) => existsSync(join(wasmSourceDir, name)));
if (hasWasm) {
  mkdirSync(webDistDir, { recursive: true });
  for (const name of wasmArtifacts) {
    copyFileSync(join(wasmSourceDir, name), join(webDistDir, name));
  }
} else {
  console.warn(
    '[esbuild] wasm engine artifacts not found under build/wasm/engine; ' +
      'skipping the web bundle (build them: cmake --preset wasm && cmake --build --preset wasm)',
  );
}

// Extension host bundle (node) and the webview bundles (browser).
const configs = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: !watch,
  },
  {
    entryPoints: ['webviews-src/graph/main.ts'],
    bundle: true,
    outfile: 'dist/webviews/graph.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !watch,
  },
  {
    entryPoints: ['webviews-src/rebase/main.ts'],
    bundle: true,
    outfile: 'dist/webviews/rebase.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !watch,
  },
  {
    entryPoints: ['webviews-src/timeline/main.ts'],
    bundle: true,
    outfile: 'dist/webviews/timeline.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !watch,
  },
];

if (hasWasm) {
  // Web extension host bundle (vscode.dev): single cjs file, browser
  // platform. Node builtins used by shared sources are aliased to web shims;
  // node:* imports that remain (inside the Emscripten glue, behind is-node
  // guards that never pass in a browser worker) stay external.
  configs.push({
    entryPoints: ['src/web/extensionWeb.ts'],
    bundle: true,
    outfile: 'dist/web/extension.js',
    external: ['vscode', 'node:*'],
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !watch,
    alias: {
      'node:path': './src/web/pathUtils.ts',
      path: './src/web/pathUtils.ts',
      'node:crypto': './src/web/shims/crypto.ts',
      crypto: './src/web/shims/crypto.ts',
      'node:fs/promises': './src/web/shims/fsPromises.ts',
      'gitglasses-engine-wasm': './dist/web/gitglasses-engine-wasm.mjs',
    },
    // The glue references import.meta.url for path-based wasm loading, which
    // cjs lowers to undefined; the loader always passes wasmBinary instead.
    logOverride: { 'empty-import-meta': 'silent' },
  });
}

const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
