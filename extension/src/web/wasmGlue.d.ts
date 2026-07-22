// Ambient module for the Emscripten glue. The id is virtual: the esbuild web
// config aliases it to dist/web/gitglasses-engine-wasm.mjs (copied from
// build/wasm/engine by esbuild.mjs), inlining the glue into the web bundle.
declare module 'gitglasses-engine-wasm' {
  const factory: (
    options?: Record<string, unknown>,
  ) => Promise<import('../engine/wasmTransport').WasmEngineModule>;
  export default factory;
}
