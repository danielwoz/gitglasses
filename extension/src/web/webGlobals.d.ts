// Minimal WebAssembly typings for the web loader. The project's tsconfig lib
// is ES2022 without DOM, so the browser/worker WebAssembly global is declared
// here with just the surface wasmModuleLoader uses.
declare namespace WebAssembly {
  type Imports = Record<string, Record<string, unknown>>;

  class Module {
    private __wasmModuleBrand: never;
  }

  class Instance {
    readonly exports: Record<string, unknown>;
  }

  function instantiate(
    bytes: ArrayBuffer | ArrayBufferView,
    imports?: Imports,
  ): Promise<{ instance: Instance; module: Module }>;
}
