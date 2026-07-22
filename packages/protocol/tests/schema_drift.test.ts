// Drift guard: the committed protocol.schema.json must match the artifact
// freshly generated from the TypeBox schemas.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../src/version.js';
import { renderSchemaArtifact } from '../src/schema/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = join(packageRoot, 'protocol.schema.json');

it('committed protocol.schema.json matches the TypeBox schemas', () => {
  const committed = readFileSync(artifactPath, 'utf8');
  expect(
    committed,
    'protocol.schema.json is stale; run `pnpm --filter @gitglasses/protocol build` and commit the result',
  ).toBe(renderSchemaArtifact());
});

it('artifact carries the exported protocol version', () => {
  const committed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  expect(committed.protocolVersion).toBe(PROTOCOL_VERSION);
});
