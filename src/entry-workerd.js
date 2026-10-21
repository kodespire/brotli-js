// Cloudflare Workers entry. Workers cannot compile WebAssembly from bytes at
// runtime, so the module is imported statically and bundled by wrangler.
// Copied to dist/ as-is; types come from entry-wasm.d.ts.
// Keep the export list in sync with entry-wasm.ts, entry-node.ts and entry-react-native.ts.
import wasmModule from './brotli.wasm';

import { createApi } from './api.js';
import { compileFrom } from './wasm-source.js';
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
} = createApi(
  createWasmProvider(
    (source) => compileFrom(source ?? wasmModule),
    () => wasmModule,
  ),
);

export { BrotliError } from './errors.js';
export { BROTLI_VERSION, DEFAULT_LGWIN, DEFAULT_QUALITY, LARGE_MAX_LGWIN, MAX_LGWIN, MAX_QUALITY, MIN_LGWIN, MIN_QUALITY } from './version.js';
