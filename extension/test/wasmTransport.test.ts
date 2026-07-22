import { describe, expect, it } from 'vitest';
import {
  createWasmTransportFactory,
  WasmEngineModule,
  WasmTransport,
} from '../src/engine/wasmTransport';

// Fake Emscripten module: gg_wasm_handle round-trips a JSON-RPC response
// through the host-installed gg_wasm_emit callback, mirroring the real
// synchronous dispatch (GG_SINGLE_THREADED) and string marshaling contract.
function fakeModule(options?: {
  onHandle?: (module: WasmEngineModule, payload: string) => void;
}): { module: WasmEngineModule; calls: string[] } {
  const calls: string[] = [];
  const module: WasmEngineModule = {
    ccall(ident, returnType, argTypes, args) {
      calls.push(ident);
      if (ident === 'gg_wasm_init') {
        expect(returnType).toBeNull();
        expect(argTypes).toEqual([]);
        return undefined;
      }
      if (ident === 'gg_wasm_handle') {
        expect(returnType).toBeNull();
        expect(argTypes).toEqual(['string']);
        expect(typeof args[0]).toBe('string');
        const handler = options?.onHandle ?? defaultHandle;
        handler(module, args[0] as string);
        return undefined;
      }
      throw new Error(`unexpected ccall: ${ident}`);
    },
    FS: {
      mkdir: () => undefined,
      writeFile: () => undefined,
      unlink: () => undefined,
      rmdir: () => undefined,
    },
  };
  return { module, calls };
}

function defaultHandle(module: WasmEngineModule, payload: string): void {
  const request = JSON.parse(payload) as { id?: number; method: string };
  const emit = module['gg_wasm_emit'] as (json: string) => void;
  emit(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { echoed: request.method } }));
}

describe('WasmTransport', () => {
  it('installs gg_wasm_emit before setup and init, in that order', async () => {
    const { module, calls } = fakeModule();
    const events: string[] = [];
    const transport = new WasmTransport({
      loadModule: async () => {
        events.push('load');
        return module;
      },
      setup: (m) => {
        events.push('setup');
        expect(typeof m['gg_wasm_emit']).toBe('function');
        expect(calls).toEqual([]); // init must not have run yet
      },
    });
    transport.onMessage(() => undefined);
    await transport.start();
    expect(events).toEqual(['load', 'setup']);
    expect(calls).toEqual(['gg_wasm_init']);
  });

  it('round-trips a request payload through gg_wasm_handle and emit', async () => {
    const { module } = fakeModule();
    const transport = new WasmTransport({ loadModule: async () => module });
    const received: string[] = [];
    transport.onMessage((payload) => received.push(payload));
    await transport.start();

    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'repo/state' }));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { echoed: 'repo/state' },
    });
  });

  it('treats a throw from gg_wasm_handle as a crash: one exit, then inert', async () => {
    const { module } = fakeModule({
      onHandle: () => {
        throw new Error('unreachable executed');
      },
    });
    const logs: string[] = [];
    const transport = new WasmTransport({
      loadModule: async () => module,
      onLog: (line) => logs.push(line),
    });
    const exits: Array<{ code: number | null }> = [];
    transport.onMessage(() => undefined);
    transport.onExit((info) => exits.push(info));
    await transport.start();

    transport.send('{"jsonrpc":"2.0","id":1,"method":"x"}');
    transport.send('{"jsonrpc":"2.0","id":2,"method":"y"}'); // dropped: module gone
    expect(exits).toEqual([{ code: null }]);
    expect(logs.some((line) => line.includes('unreachable executed'))).toBe(true);
  });

  it('kill drops the module without firing onExit', async () => {
    const { module, calls } = fakeModule();
    const transport = new WasmTransport({ loadModule: async () => module });
    const exits: unknown[] = [];
    transport.onMessage(() => undefined);
    transport.onExit((info) => exits.push(info));
    await transport.start();

    transport.kill();
    transport.send('{"jsonrpc":"2.0","id":1,"method":"x"}');
    expect(exits).toEqual([]);
    expect(calls).toEqual(['gg_wasm_init']); // no handle call after kill
  });

  it('factory produces a fresh transport (and module) per respawn', async () => {
    let loads = 0;
    const factory = createWasmTransportFactory({
      loadModule: async () => {
        loads += 1;
        return fakeModule().module;
      },
    });
    const first = factory();
    const second = factory();
    expect(first).not.toBe(second);
    first.onMessage(() => undefined);
    second.onMessage(() => undefined);
    await first.start();
    await second.start();
    expect(loads).toBe(2);
  });
});
