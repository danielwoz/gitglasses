// Instantiates the Emscripten engine module in the worker extension host.
// The glue JS is inlined into the web bundle (esbuild alias), while the
// .wasm ships as an extension asset read through vscode.workspace.fs. The
// glue's incoming-module API is pruned (it never reads Module["wasmBinary"]),
// so instantiation goes through the Module["instantiateWasm"] hook — the one
// path that never fetches by URL.

import * as vscode from 'vscode';
import type { WasmEngineModule } from '../engine/wasmTransport';

export function createWasmModuleLoader(
  extensionUri: vscode.Uri,
  onLog?: (line: string) => void,
): () => Promise<WasmEngineModule> {
  let wasmBytes: Uint8Array | undefined;
  return async () => {
    // The binary is immutable for the lifetime of the extension host; cache
    // it so engine respawns skip the asset read.
    wasmBytes ??= await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(extensionUri, 'dist', 'web', 'gitglasses-engine-wasm.wasm'),
    );
    const bytes = wasmBytes;
    const factory = (await import('gitglasses-engine-wasm')).default;
    return factory({
      instantiateWasm: (
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance) => void,
      ) => {
        void WebAssembly.instantiate(bytes, imports)
          .then((result) => receiveInstance(result.instance))
          .catch((error: unknown) => onLog?.(`[wasm] instantiation failed: ${String(error)}`));
        return {}; // exports arrive via receiveInstance
      },
      print: (line: string) => onLog?.(`[wasm] ${line}`),
      printErr: (line: string) => onLog?.(`[wasm] ${line}`),
    });
  };
}
