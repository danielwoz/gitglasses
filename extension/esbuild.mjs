import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Extension host bundle (node) and the graph webview bundle (browser).
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
];

const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
