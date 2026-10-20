// The documented public API. This file only declares; each entry point
// (entry-node.ts, entry-wasm.ts, entry-workerd.js) implements it, and
// test/types.test-d.ts checks that they match. package.json points "types" here.
import type { BackendKind, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';

/**
 * Compresses `data` into one brotli stream.
 *
 * The default quality is 11, the brotli CLI default: the smallest output, but slow (under
 * 1 MB/s). For data compressed on the fly, quality 4 to 6 is roughly 50 to 100 times faster,
 * with output around 20% larger.
 *
 * @param data Bytes to compress. Strings are encoded as UTF-8.
 * @param options Options, or just a quality (`compress(data, 5)`).
 * @example
 * const packed = await compress(data, { quality: 5 });
 */
export declare function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link compress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array;

/**
 * Decompresses one brotli stream.
 *
 * Throws a {@link BrotliError} with code `ERR_BROTLI_TRUNCATED` if the input is empty or ends
 * before the end of the stream, `ERR_BROTLI_OUTPUT_LIMIT` if the output would exceed
 * `maxOutputSize`, and `ERR_BROTLI_LIBRARY` if the decoder rejects the data or bytes follow the
 * end of the stream. It never returns partial output. Brotli has no checksum, so some
 * corruption decodes to wrong bytes without an error.
 *
 * @example
 * const data = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
 */
export declare function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array>;

/**
 * Synchronous {@link decompress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array;

/**
 * A TransformStream that compresses everything written to it into one brotli stream.
 *
 * @example
 * const compressed = file.stream().pipeThrough(createCompressStream({ quality: 5 }));
 */
export declare function createCompressStream(options?: CompressOptions | number): TransformStream<Bytes, Uint8Array>;

/**
 * A TransformStream that decompresses one brotli stream. The stream errors if the input is
 * corrupt, ends before the end of the stream, continues after it, or exceeds `maxOutputSize`
 * in total.
 *
 * @example
 * const body = response.body.pipeThrough(createDecompressStream());
 */
export declare function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array>;

/**
 * Loads the backend ahead of time. Needed before the synchronous functions in browsers, Deno and
 * Workers; optional elsewhere.
 *
 * @param source Where to load `brotli.wasm` from (URL, path, `Response`, bytes or a compiled
 *   `WebAssembly.Module`). Ignored when the native addon is in use.
 */
export declare function init(source?: WasmSource): Promise<void>;

/** Which implementation is running: `'native'` (Node-API addon) or `'wasm'`. */
export declare function activeBackend(): BackendKind;

export { BrotliError, type BrotliErrorCode } from './errors.js';
export type { BackendKind, BrotliMode, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';
export {
  BROTLI_VERSION,
  DEFAULT_LGWIN,
  DEFAULT_QUALITY,
  LARGE_MAX_LGWIN,
  MAX_LGWIN,
  MAX_QUALITY,
  MIN_LGWIN,
  MIN_QUALITY,
} from './version.js';
