// Runtime validation against the TypeBox schemas.
//
// The schemas were previously used only as compile-time types, so payloads
// crossing a trust boundary — an agent-supplied patch envelope, an engine
// response — were cast rather than checked. A cast turns a malformed value
// into a lying type that surfaces as a crash far from the cause.

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
