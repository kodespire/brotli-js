// React Native backend: the C++ TurboModule in cpp/ (the bjs C layer, as in the
// Node-API addon), reached through JSI. It returns ArrayBuffers that own the
// native output, and throws or rejects with errors carrying `bjsCode`.
import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle, EncoderParams } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): ArrayBuffer;
  pushAsync(chunk: Uint8Array, mode: number): Promise<ArrayBuffer>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): ArrayBuffer;
  pushAsync(chunk: Uint8Array): Promise<ArrayBuffer>;
  finish(): void;
  close(): void;
}

type EncoderArgs = [quality: number, lgwin: number, mode: number, largeWindow: boolean, sizeHint: number];

/** @internal What cpp/KodespireBrotliModule.cpp exposes. */
export interface NativeModule {
  version(): string;
  compressSync(data: Uint8Array, ...params: EncoderArgs): ArrayBuffer;
  compress(data: Uint8Array, ...params: EncoderArgs): Promise<ArrayBuffer>;
  decompressSync(data: Uint8Array, largeWindow: boolean, maxOutput: number): ArrayBuffer;
  decompress(data: Uint8Array, largeWindow: boolean, maxOutput: number): Promise<ArrayBuffer>;
  createCStream(...params: EncoderArgs): NativeCStream;
  createDStream(largeWindow: boolean, maxOutput: number): NativeDStream;
}

const args = (p: EncoderParams): EncoderArgs => [p.quality, p.lgwin, p.mode, p.largeWindow, p.sizeHint];

const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

export function createJsiBackend(m: NativeModule): Backend {
  return {
    kind: 'native',
    version: m.version(),
    compressSync: wrapSync((data, params) => bytes(m.compressSync(data, ...args(params)))),
    compress: (data, params) => m.compress(data, ...args(params)).then(bytes, rethrowNative),
    decompressSync: wrapSync((data, largeWindow, maxOutput) => bytes(m.decompressSync(data, largeWindow, maxOutput))),
    decompress: (data, largeWindow, maxOutput) => m.decompress(data, largeWindow, maxOutput).then(bytes, rethrowNative),
    // The stream methods are plain functions bound to their native context.
    createCStream: wrapSync((params): CStreamHandle => {
      const { push, pushAsync, close } = m.createCStream(...args(params));
      return {
        push: wrapSync((chunk, mode) => bytes(push(chunk, mode))),
        pushAsync: (chunk, mode) => pushAsync(chunk, mode).then(bytes, rethrowNative),
        close: wrapSync(() => close()),
      };
    }),
    createDStream: wrapSync((largeWindow, maxOutput): DStreamHandle => {
      const { push, pushAsync, finish, close } = m.createDStream(largeWindow, maxOutput);
      return {
        push: wrapSync((chunk) => bytes(push(chunk))),
        pushAsync: (chunk) => pushAsync(chunk).then(bytes, rethrowNative),
        finish: wrapSync(() => finish()),
        close: wrapSync(() => close()),
      };
    }),
  };
}
