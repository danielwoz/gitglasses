import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
    entryPoints: ['webviews-src/graph/commitPanel.ts'],
    bundle: true,
    outfile: 'dist/webviews/commitDetails.js',
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

// The MCP server the extension registers with the editor's agents
// (src/mcp/), as one self-contained CommonJS script that the editor's own
// Node runs: everything it imports is bundled, and the version it reports is
// compiled in. The npm package (mcp-server/esbuild.mjs) is built separately.
const mcpVersion = JSON.parse(
  readFileSync(join(root, '..', 'mcp-server', 'package.json'), 'utf8'),
).version;
const mcpConfig = {
  entryPoints: ['../mcp-server/src/cli.ts'],
  bundle: true,
  outfile: 'dist/mcp/cli.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  minify: !watch,
  metafile: true,
  define: {
    GITGLASSES_MCP_VERSION: JSON.stringify(mcpVersion),
    'import.meta.dirname': '__dirname',
    // Read only when no version is compiled in.
    'import.meta.url': 'undefined',
  },
  plugins: [
    {
      name: 'notice-check',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0 || !result.metafile) return;
          const problems = unnoticedPackages(result.metafile);
          if (problems.length === 0) return;
          return {
            errors: problems.map((name) => ({
              text: `${name} is bundled into dist/mcp/cli.js but NOTICE does not name it; add its license to NOTICE`,
            })),
          };
        });
      },
    },
  ],
};
configs.push(mcpConfig);

// Third-party packages inlined into a bundle that NOTICE does not name. The
// workspace's own packages need no notice.
function unnoticedPackages(metafile) {
  const notice = readFileSync(join(root, '..', 'NOTICE'), 'utf8');
  const packages = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
      input,
    );
    if (match && !match[1].startsWith('@gitglasses/')) packages.add(match[1]);
  }
  return [...packages].filter((name) => !notice.includes(name)).sort();
}

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
      'node:os': './src/web/shims/os.ts',
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
