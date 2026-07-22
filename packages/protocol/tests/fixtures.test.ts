// Drift guard: every golden message fixture in fixtures/ must validate
// against its schema. Fixture files carry { method, kind, payload } where
// kind is 'params' | 'result' for requests and 'notification' for one-way
// messages.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  ClientNotificationSchemas,
  EngineNotificationSchemas,
  RequestSchemas,
} from '../src/schema/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Fixture {
  method: string;
  kind: 'params' | 'result' | 'notification';
  payload: unknown;
}

function schemaFor(fixture: Fixture): TSchema | undefined {
  if (fixture.kind === 'notification') {
    const known = {
      ...ClientNotificationSchemas,
      ...EngineNotificationSchemas,
    } as Record<string, { params: TSchema }>;
    return known[fixture.method]?.params;
  }
  const requests = RequestSchemas as Record<string, { params: TSchema; result: TSchema }>;
  return requests[fixture.method]?.[fixture.kind];
}

const files = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

it('carries a representative fixture corpus', () => {
  expect(files.length).toBeGreaterThanOrEqual(12);
});

describe('golden fixtures validate against their schemas', () => {
  for (const file of files) {
    it(file, () => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture;
      expect(['params', 'result', 'notification']).toContain(fixture.kind);
      const schema = schemaFor(fixture);
      expect(schema, `${fixture.method} (${fixture.kind}) has no schema`).toBeDefined();
      const errors = [...Value.Errors(schema as TSchema, fixture.payload)].map(
        (error) => `${error.path}: ${error.message}`,
      );
      expect(errors).toEqual([]);
      expect(Value.Check(schema as TSchema, fixture.payload)).toBe(true);
    });
  }
});
