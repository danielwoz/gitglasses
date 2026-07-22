// Schema-first definition of the wire protocol. The TypeBox objects here are
// plain JSON Schema at runtime; buildSchemaArtifact() assembles the committed
// protocol.schema.json from them.

import type { TSchema } from '@sinclair/typebox';

import { PROTOCOL_VERSION } from '../version.js';
import {
  ClientNotificationSchemas,
  EngineNotificationSchemas,
} from './notifications.js';
import { RequestSchemas } from './requests.js';

export * from './models.js';
export { EmptyObject, RequestSchemas } from './requests.js';
export { ClientNotificationSchemas, EngineNotificationSchemas } from './notifications.js';

/** Drops TypeBox's symbol bookkeeping, leaving pure JSON Schema. */
function toJson(schema: TSchema): unknown {
  return JSON.parse(JSON.stringify(schema));
}

export interface SchemaArtifact {
  $comment: string;
  protocolVersion: string;
  methods: Record<string, { params: unknown; result: unknown }>;
  notifications: Record<string, { direction: 'client' | 'engine'; params: unknown }>;
}

/** Builds the exact contents of protocol.schema.json. */
export function buildSchemaArtifact(): SchemaArtifact {
  const methods: SchemaArtifact['methods'] = {};
  for (const [method, schemas] of Object.entries(RequestSchemas)) {
    methods[method] = { params: toJson(schemas.params), result: toJson(schemas.result) };
  }
  const notifications: SchemaArtifact['notifications'] = {};
  for (const [method, schemas] of Object.entries(ClientNotificationSchemas)) {
    notifications[method] = { direction: 'client', params: toJson(schemas.params) };
  }
  for (const [method, schemas] of Object.entries(EngineNotificationSchemas)) {
    notifications[method] = { direction: 'engine', params: toJson(schemas.params) };
  }
  return {
    $comment:
      'Generated from packages/protocol/src/schema by scripts/emit-schema.ts. Do not edit by hand; run `pnpm --filter @gitglasses/protocol build`.',
    protocolVersion: PROTOCOL_VERSION,
    methods,
    notifications,
  };
}

/** Serialized artifact, byte-identical to the committed protocol.schema.json. */
export function renderSchemaArtifact(): string {
  return JSON.stringify(buildSchemaArtifact(), null, 2) + '\n';
}
