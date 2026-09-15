// Runtime-agnostic JSON-RPC client for gitglasses-engine. This entry point
// imports no node builtins, so browser and wasm hosts can use it; the child
// process transport lives behind the /node subpath and byte-stream framing
// behind /framing.

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  EngineClient,
  EngineError,
  EngineRestartedError,
  type CancellationLike,
  type EngineClientOptions,
} from './engineClient.js';
export type { EngineTransport } from './transport.js';
