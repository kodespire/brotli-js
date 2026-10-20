import type { BrotliMode, Bytes, CompressOptions, DecompressOptions, EncoderParams } from './types.js';
import { DEFAULT_LGWIN, DEFAULT_QUALITY, LARGE_MAX_LGWIN, MAX_LGWIN, MAX_QUALITY, MIN_LGWIN, MIN_QUALITY } from './version.js';

const encoder = new TextEncoder();

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** A Uint8Array view over the caller's bytes (no copy). */
export function toBytes(input: unknown, name: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  throw new TypeError(`${name} must be an ArrayBuffer, a typed array, a DataView or a Buffer`);
}

/** Like toBytes, and also accepts strings (encoded as UTF-8). */
export function toInputBytes(input: unknown): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : toBytes(input, 'data');
}

// Names people reach for from other APIs (zstd, zlib) and what they mean here.
const HINTS: [pattern: RegExp, option: string][] = [
  [/level/i, 'quality'],
  [/window/i, 'lgwin'],
];

// Unknown keys throw instead of being ignored, so a typo such as
// `{ level: 5 }` cannot silently compress at the default quality.
function checkKeys(options: object, allowed: readonly string[], fn: string): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      const hint = HINTS.find(([pattern, option]) => pattern.test(key) && allowed.includes(option));
      throw new TypeError(`${fn}: unknown option "${key}". Valid options: ${allowed.join(', ')}.${hint ? ` Did you mean "${hint[1]}"?` : ''}`);
    }
  }
}

function checkOptionsObject(options: unknown, fn: string): void {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError(`${fn}: options must be an object`);
  }
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// Values of BrotliEncoderMode in brotli/encode.h.
const MODES: Record<BrotliMode, number> = { generic: 0, text: 1, font: 2 };

// brotli caps its own size estimate at 2^30; larger hints behave the same.
const SIZE_HINT_CAP = 2 ** 30;

const COMPRESS_KEYS = ['quality', 'lgwin', 'mode', 'largeWindow', 'sizeHint'] as const;

export function resolveCompressOptions(options: CompressOptions | number | undefined, fn: string): EncoderParams {
  if (typeof options === 'number') options = { quality: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, COMPRESS_KEYS, fn);

  const quality = options?.quality ?? DEFAULT_QUALITY;
  if (!isIntegerIn(quality, MIN_QUALITY, MAX_QUALITY)) {
    throw new RangeError(`${fn}: quality must be an integer from ${MIN_QUALITY} to ${MAX_QUALITY}, got ${String(quality)}`);
  }
  const largeWindow = options?.largeWindow ?? false;
  if (typeof largeWindow !== 'boolean') throw new TypeError(`${fn}: largeWindow must be a boolean`);
  // The encoder ignores the flag below quality 3, so refuse rather than write a standard stream.
  if (largeWindow && quality < 3) {
    throw new RangeError(`${fn}: largeWindow needs quality 3 or higher, got quality ${quality}`);
  }
  const lgwin = options?.lgwin ?? DEFAULT_LGWIN;
  const maxLgwin = largeWindow ? LARGE_MAX_LGWIN : MAX_LGWIN;
  if (!isIntegerIn(lgwin, MIN_LGWIN, maxLgwin)) {
    const extra = !largeWindow && isIntegerIn(lgwin, MAX_LGWIN + 1, LARGE_MAX_LGWIN) ? ' (up to 30 with largeWindow: true)' : '';
    throw new RangeError(`${fn}: lgwin must be an integer from ${MIN_LGWIN} to ${maxLgwin}${extra}, got ${String(lgwin)}`);
  }
  const modeName = options?.mode ?? 'generic';
  if (typeof modeName !== 'string' || !Object.hasOwn(MODES, modeName)) {
    throw new TypeError(`${fn}: mode must be "generic", "text" or "font", got ${typeof modeName === 'string' ? JSON.stringify(modeName) : typeof modeName}`);
  }
  const sizeHint = options?.sizeHint ?? 0;
  if (typeof sizeHint !== 'number' || !Number.isSafeInteger(sizeHint) || sizeHint < 0) {
    throw new RangeError(`${fn}: sizeHint must be a non-negative integer`);
  }
  return { quality, lgwin, mode: MODES[modeName], largeWindow, sizeHint: Math.min(sizeHint, SIZE_HINT_CAP) };
}

export interface ResolvedDecompressOptions {
  maxOutputSize: number;
  largeWindow: boolean;
}

const DECOMPRESS_KEYS = ['maxOutputSize', 'largeWindow'] as const;

export function resolveDecompressOptions(options: DecompressOptions | undefined, fn: string): ResolvedDecompressOptions {
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, DECOMPRESS_KEYS, fn);
  const maxOutputSize = options?.maxOutputSize ?? Infinity;
  if (typeof maxOutputSize !== 'number' || Number.isNaN(maxOutputSize) || maxOutputSize < 0 ||
      (Number.isFinite(maxOutputSize) && !Number.isInteger(maxOutputSize))) {
    throw new RangeError(`${fn}: maxOutputSize must be a non-negative integer or Infinity`);
  }
  const largeWindow = options?.largeWindow ?? false;
  if (typeof largeWindow !== 'boolean') throw new TypeError(`${fn}: largeWindow must be a boolean`);
  return { maxOutputSize, largeWindow };
}

export type { Bytes };
