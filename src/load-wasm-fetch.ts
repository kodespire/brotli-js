// Loads brotli.wasm with fetch(). Used by browsers, Deno and other non-Node runtimes.
// Bundlers (Vite, webpack, Parcel) recognise `new URL('./brotli.wasm', import.meta.url)`
// and emit the file as an asset.
import { BrotliError } from './errors.js';
import type { WasmSource } from './types.js';
import { compileFrom } from './wasm-source.js';

export async function compileWasm(source?: WasmSource): Promise<WebAssembly.Module> {
  const s = source ?? new URL('./brotli.wasm', import.meta.url);
  if (s instanceof URL || typeof s === 'string') return compileFrom(fetch(s));
  return compileFrom(s);
}

export function compileWasmSync(): WebAssembly.Module {
  throw new BrotliError(
    'ERR_BROTLI_NOT_INITIALIZED',
    'brotli-js: call `await init()` before using synchronous functions in this runtime',
  );
}
