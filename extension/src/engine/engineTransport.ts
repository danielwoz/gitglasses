// Transport abstraction between EngineClient and a concrete engine host.
// Payloads are complete JSON-RPC message strings; framing (Content-Length,
// worker postMessage, …) is the transport's concern. EngineClient takes a
// transport factory so every respawn gets a fresh transport instance.

export interface EngineTransport {
  /** Sends one complete JSON-RPC payload to the engine. */
  send(payload: string): void;
  /** Registers the handler receiving complete JSON-RPC payloads. */
  onMessage(handler: (payload: string) => void): void;
  /** Registers the handler called once when the engine goes away. */
  onExit(handler: (info: { code: number | null }) => void): void;
  /** Brings the engine up; safe to call send() after this resolves. */
  start(): Promise<void>;
  /** Tears the engine down; no further messages are expected. */
  kill(): void;
}
