// Runtime validation against the TypeBox schemas, for payloads that cross a
// trust boundary: an agent-supplied patch envelope, an engine response.

import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import * as models from './schema/models.js';

/** A human-readable reason, or undefined when `value` matches `schema`. */
export function schemaError(schema: TSchema, value: unknown): string | undefined {
  if (Value.Check(schema, value)) return undefined;
  const [first] = [...Value.Errors(schema, value)];
  return first ? `${first.path || '/'}: ${first.message}` : 'does not match the schema';
}

/**
 * Validates a patch envelope. Callers accepting one from an untrusted source
 * get a precise local error instead of the engine's round-tripped -32602.
 */
export function patchEnvelopeError(value: unknown): string | undefined {
  return schemaError(models.PatchEnvelope, value);
}
