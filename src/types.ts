/** Binary input accepted everywhere: any ArrayBuffer, typed array, DataView or Node Buffer. */
export type Bytes = ArrayBuffer | ArrayBufferView;

/** Encoder tuning for the kind of input. */
export type BrotliMode = 'generic' | 'text' | 'font';

export interface CompressOptions {
  /**
   * Compression quality, from 0 (fastest) to 11 (smallest, and much slower). Defaults to 11,
   * the same as the brotli command-line tool and library.
   */
  quality?: number;
  /**
   * Window size as a power of two, from 10 to 24 (up to 30 with `largeWindow`). The window is
   * `2 ** lgwin - 16` bytes. Defaults to 22 (4 MiB), the brotli library default.
   */
  lgwin?: number;
  /**
   * `'font'` tunes the encoder for WOFF 2.0 font data (quality 4 and up). `'text'` is accepted
   * for compatibility; brotli 1.2.0 compresses it exactly like `'generic'`. Defaults to `'generic'`.
   */
  mode?: BrotliMode;
  /**
   * Write the large-window extension, which allows `lgwin` up to 30. The output is not standard
   * brotli (RFC 7932): decompressing it needs `largeWindow: true`, and browsers reject it.
   * Needs quality 3 or higher. Defaults to false.
   */
  largeWindow?: boolean;
  /**
   * Expected total input size in bytes, or 0 for unknown. Helps a stream pick its strategy;
   * one-shot calls already know the size. Only qualities 4 to 9 use it. Defaults to 0.
   */
  sizeHint?: number;
}

export interface DecompressOptions {
  /**
   * Throw ERR_BROTLI_OUTPUT_LIMIT instead of producing more than this many bytes.
   * Set it whenever the input is untrusted. Defaults to Infinity.
   */
  maxOutputSize?: number;
  /**
   * Accept streams written with the large-window extension (windows up to 1 GiB).
   * Defaults to false, which accepts only standard brotli.
   */
  largeWindow?: boolean;
}

/** Where the WebAssembly module comes from, for `init()`. */
export type WasmSource =
  | WebAssembly.Module
  | Bytes
  | URL
  | string
  | Response
  | PromiseLike<Response>;

export type BackendKind = 'native' | 'wasm';

/** @internal Mode values match BJS_MODE_* in csrc/bjs.h. */
export const MODE_CONTINUE = 0;
/** @internal */
export const MODE_END = 2;

/** @internal Validated encoder settings, in the form the C layer takes. */
export interface EncoderParams {
  quality: number;
  lgwin: number;
  /** BROTLI_MODE_GENERIC (0), BROTLI_MODE_TEXT (1) or BROTLI_MODE_FONT (2). */
  mode: number;
  largeWindow: boolean;
  sizeHint: number;
}

/** @internal */
export interface CStreamHandle {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

/** @internal */
export interface DStreamHandle {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

/** @internal What each backend (native addon, WebAssembly) implements. Errors are BrotliError. */
export interface Backend {
  readonly kind: BackendKind;
  readonly version: string;
  compressSync(data: Uint8Array, params: EncoderParams): Uint8Array;
  compress(data: Uint8Array, params: EncoderParams): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, largeWindow: boolean, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, largeWindow: boolean, maxOutput: number): Promise<Uint8Array>;
  createCStream(params: EncoderParams): CStreamHandle;
  createDStream(largeWindow: boolean, maxOutput: number): DStreamHandle;
}

/** @internal How an entry point supplies its backend to the public API. */
export interface BackendProvider {
  get(): Promise<Backend>;
  getSync(): Backend;
  /** The backend if it is already loaded, without loading it. */
  ready(): Backend | undefined;
  init(source?: WasmSource): Promise<void>;
  kind(): BackendKind;
}
