// WebAssembly entry: browsers, Deno, and anything without the native addon.
// Keep the export list in sync with entry-node.ts, entry-workerd.js and entry-react-native.ts.
import { compileWasm, compileWasmSync } from '#load-wasm';

import { createApi } from './api.js';
import { createWasmProvider } from './wasm-provider.js';

export const {
  compress,
  compressSync,
  decompress,
  decompressSync,
  createCompressStream,
  createDecompressStream,
  init,
  activeBackend,
} = createApi(createWasmProvider(compileWasm, compileWasmSync));

export { BrotliError, type BrotliErrorCode } from './errors.js';
export type { BackendKind, BrotliMode, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';
export { BROTLI_VERSION, DEFAULT_LGWIN, DEFAULT_QUALITY, LARGE_MAX_LGWIN, MAX_LGWIN, MAX_QUALITY, MIN_LGWIN, MIN_QUALITY } from './version.js';
