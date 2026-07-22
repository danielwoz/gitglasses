// Emits the committed JSON Schema artifact for the wire protocol.
// Run via `pnpm --filter @gitglasses/protocol build` (tsx executes it after tsc).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSchemaArtifact } from '../src/schema/index.js';

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'protocol.schema.json');
writeFileSync(outPath, renderSchemaArtifact());
console.log(`wrote ${outPath}`);
