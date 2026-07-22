/** Wire protocol version, single-sourced: the TS package exports it, the
 * generated protocol.schema.json artifact carries it, and the engine's
 * contract test asserts its own constant matches the artifact. */
export const PROTOCOL_VERSION = '0.1.0';
