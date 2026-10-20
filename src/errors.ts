export type BrotliErrorCode =
  /**
   * brotli rejected the data: corrupt input (the message carries the decoder's error, such as
   * `_ERROR_FORMAT_PADDING_1`) or bytes after the end of the stream.
   */
  | 'ERR_BROTLI_LIBRARY'
  /** The input ended before the end of the stream, or was empty. */
  | 'ERR_BROTLI_TRUNCATED'
  /** Decompressed output would exceed `maxOutputSize`. */
  | 'ERR_BROTLI_OUTPUT_LIMIT'
  | 'ERR_BROTLI_OUT_OF_MEMORY'
  | 'ERR_BROTLI_INVALID_ARGUMENT'
  /** A synchronous call was made before the WebAssembly module was loaded with `init()`. */
  | 'ERR_BROTLI_NOT_INITIALIZED';

export class BrotliError extends Error {
  readonly code: BrotliErrorCode;

  constructor(code: BrotliErrorCode, message: string) {
    super(message);
    this.name = 'BrotliError';
    this.code = code;
  }
}

// Indexed by the BJS_ERR_* values in csrc/bjs.h.
const CODES: readonly (BrotliErrorCode | undefined)[] = [
  undefined,
  'ERR_BROTLI_LIBRARY',
  'ERR_BROTLI_TRUNCATED',
  'ERR_BROTLI_OUTPUT_LIMIT',
  'ERR_BROTLI_OUT_OF_MEMORY',
  'ERR_BROTLI_INVALID_ARGUMENT',
];

export function errorFromCore(rc: number, detail: string): BrotliError {
  const code = CODES[rc] ?? 'ERR_BROTLI_LIBRARY';
  return new BrotliError(code, code === 'ERR_BROTLI_LIBRARY' ? `brotli: ${detail}` : detail);
}

/** Converts an error thrown by the native addon into a BrotliError with a JavaScript stack. */
export function rethrowNative(error: unknown): never {
  if (error !== null && typeof error === 'object' && typeof (error as { bjsCode?: unknown }).bjsCode === 'number') {
    throw errorFromCore((error as { bjsCode: number }).bjsCode, (error as Error).message);
  }
  throw error;
}
