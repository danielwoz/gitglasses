// Wasm engine transport: drives the Emscripten-compiled engine inside the
// extension host itself — no child process, no framing. Outbound messages
// arrive through the module's gg_wasm_emit callback (installed before init);
// inbound payloads go through _gg_wasm_handle with Emscripten's 'string'
// marshaling, exactly like engine/wasm-test/run.mjs.
//
// The module loader is injected so this file never touches the bundled glue
// directly and stays unit-testable with a fake module object. Each transport
// instance owns one module instance; EngineClient's respawn path calls the
// factory again and gets a fresh module (the wasm engine has no persistent
// state outside the module, so a reload is a full engine restart).

import type { EngineTransport } from '@gitglasses/rpc';

/** In-memory filesystem surface of the Emscripten module. */
export interface WasmFs {
  mkdir(path: string): void;
  mkdirTree?(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  [key: string]: unknown;
}

/** The slice of an instantiated Emscripten module the transport needs. */
export interface WasmEngineModule {
  ccall(
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
  ): unknown;
  FS: WasmFs;
  /** Host-installed outbound callback plus other Emscripten members. */
  [key: string]: unknown;
}

export interface WasmTransportOptions {
  /** Instantiates a fresh engine module (glue import + wasmBinary). */
  loadModule(): Promise<WasmEngineModule>;
  /** Prepares the module (workspace → MEMFS mirror) after gg_wasm_emit is
   *  installed and before gg_wasm_init runs. */
  setup?(module: WasmEngineModule): Promise<void> | void;
  onLog?(line: string): void;
}

/** Factory for EngineClient: every respawn gets a fresh module instance. */
export function createWasmTransportFactory(
  options: WasmTransportOptions,
): () => EngineTransport {
  return () => new WasmTransport(options);
}

export class WasmTransport implements EngineTransport {
  private module: WasmEngineModule | undefined;
  private messageHandler: ((payload: string) => void) | undefined;
  private exitHandler: ((info: { code: number | null }) => void) | undefined;
  private down = false;

  constructor(private readonly options: WasmTransportOptions) {}

  onMessage(handler: (payload: string) => void): void {
    this.messageHandler = handler;
  }

  onExit(handler: (info: { code: number | null }) => void): void {
    this.exitHandler = handler;
  }

  async start(): Promise<void> {
    const module = await this.options.loadModule();
    // The engine pushes every response and notification through this
    // callback; it must exist before gg_wasm_init constructs the dispatcher.
    module['gg_wasm_emit'] = (json: string) => this.messageHandler?.(json);
    await this.options.setup?.(module);
    module.ccall('gg_wasm_init', null, [], []);
    this.module = module;
  }

  send(payload: string): void {
    const module = this.module;
    if (!module || this.down) return;
    try {
      // 'string' marshaling copies the payload into the wasm heap and frees
      // it after the call, mirroring the wasm-test harness contract.
      module.ccall('gg_wasm_handle', null, ['string'], [payload]);
    } catch (error) {
      // A throw that escapes the dispatcher means the module is in an
      // undefined state (heap corruption, unreachable, OOM). Treat it like a
      // process crash: drop the module and let EngineClient respawn a fresh
      // one through the factory.
      this.options.onLog?.(
        `wasm engine failed while handling a message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.emitExit();
    }
  }

  kill(): void {
    // No process to signal: dropping the reference releases the module (and
    // its heap) to the GC. Deliberate teardown emits no exit event.
    this.down = true;
    this.module = undefined;
  }

  private emitExit(): void {
    if (this.down) return;
    this.down = true;
    this.module = undefined;
    this.exitHandler?.({ code: null });
  }
}
