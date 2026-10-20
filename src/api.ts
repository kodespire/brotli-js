import {
  resolveCompressOptions,
  resolveDecompressOptions,
  toBytes,
  toInputBytes,
} from './options.js';
import {
  MODE_CONTINUE,
  MODE_END,
  type BackendKind,
  type BackendProvider,
  type Bytes,
  type CompressOptions,
  type CStreamHandle,
  type DecompressOptions,
  type DStreamHandle,
  type WasmSource,
} from './types.js';

const EMPTY = new Uint8Array(0);

export function createApi(provider: BackendProvider) {
  /** Compresses `data` into one brotli stream. Strings are encoded as UTF-8. */
  async function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array> {
    const params = resolveCompressOptions(options, 'compress');
    const input = toInputBytes(data);
    const backend = await provider.get();
    return backend.compress(input, params);
  }

  /** Synchronous `compress`. In browsers and edge runtimes, call `await init()` first. */
  function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array {
    const params = resolveCompressOptions(options, 'compressSync');
    return provider.getSync().compressSync(toInputBytes(data), params);
  }

  /**
   * Decompresses one brotli stream. Throws BrotliError if the data is corrupt or has bytes after
   * the end of the stream (ERR_BROTLI_LIBRARY), ends early (ERR_BROTLI_TRUNCATED) or would exceed
   * `maxOutputSize` (ERR_BROTLI_OUTPUT_LIMIT).
   */
  async function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array> {
    const o = resolveDecompressOptions(options, 'decompress');
    const input = toBytes(data, 'data');
    const backend = await provider.get();
    return backend.decompress(input, o.largeWindow, o.maxOutputSize);
  }

  /** Synchronous `decompress`. In browsers and edge runtimes, call `await init()` first. */
  function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array {
    const o = resolveDecompressOptions(options, 'decompressSync');
    return provider.getSync().decompressSync(toBytes(data, 'data'), o.largeWindow, o.maxOutputSize);
  }

  /** A TransformStream that compresses its input into one brotli stream. */
  function createCompressStream(options?: CompressOptions | number): TransformStream<Bytes, Uint8Array> {
    const params = resolveCompressOptions(options, 'createCompressStream');
    let handle: CStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      async start() {
        handle = (await provider.get()).createCStream(params);
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'), MODE_CONTINUE);
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      async flush(controller) {
        try {
          const out = await handle!.pushAsync(EMPTY, MODE_END);
          if (out.length > 0) controller.enqueue(out);
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * A TransformStream that decompresses one brotli stream. Errors if the input is corrupt, ends
   * early, continues past the end of the stream or exceeds `maxOutputSize` in total.
   */
  function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array> {
    const o = resolveDecompressOptions(options, 'createDecompressStream');
    let handle: DStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      async start() {
        handle = (await provider.get()).createDStream(o.largeWindow, o.maxOutputSize);
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'));
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      flush() {
        try {
          handle!.finish();
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * Loads the backend ahead of time. Required before synchronous calls in browsers and edge
   * runtimes. `source` overrides where the WebAssembly module is loaded from; it is ignored
   * when the native addon is in use.
   */
  async function init(source?: WasmSource): Promise<void> {
    await provider.init(source);
  }

  /** Which implementation is running: the native addon or WebAssembly. */
  function activeBackend(): BackendKind {
    return provider.kind();
  }

  return {
    compress,
    compressSync,
    decompress,
    decompressSync,
    createCompressStream,
    createDecompressStream,
    init,
    activeBackend,
  };
}
