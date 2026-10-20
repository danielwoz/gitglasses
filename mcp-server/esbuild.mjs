// Bundles the CLI into a single dist/cli.js, the file the gitglasses-mcp npm
// package ships. The workspace packages (@gitglasses/*) are not published, so
// they are inlined; third-party packages stay external and are installed from
// the package's dependencies.

import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const { dependencies } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const external = Object.keys(dependencies).flatMap((name) => [name, `${name}/*`]);

const result = await esbuild.build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  metafile: true,
  logLevel: 'warning',
});

// Anything else under node_modules would be shipped without its license.
const inlined = Object.keys(result.metafile.inputs).filter(
  (input) => input.includes('node_modules') && !input.includes('/@gitglasses/'),
);
if (inlined.length > 0) {
  console.error(
    `esbuild: third-party code would be inlined into dist/cli.js:\n  ${inlined.join('\n  ')}`,
  );
  process.exit(1);
}
