import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle, EncoderParams } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

type EncoderArgs = [quality: number, lgwin: number, mode: number, largeWindow: boolean, sizeHint: number];

interface NativeAddon {
  version: string;
  compressSync(data: Uint8Array, ...params: EncoderArgs): Uint8Array;
  compress(data: Uint8Array, ...params: EncoderArgs): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, largeWindow: boolean, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, largeWindow: boolean, maxOutput: number): Promise<Uint8Array>;
  CStream: new (...params: EncoderArgs) => NativeCStream;
  DStream: new (largeWindow: boolean, maxOutput: number) => NativeDStream;
}

const args = (p: EncoderParams): EncoderArgs => [p.quality, p.lgwin, p.mode, p.largeWindow, p.sizeHint];

// The addon returns Node Buffers; expose plain Uint8Array views (no copy) so results
// behave the same in every runtime.
const view = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

/** Loads the prebuilt (or locally built) addon. Throws if none matches this platform. */
export function loadNativeBackend(): Backend {
  const require = createRequire(import.meta.url);
  const nodeGypBuild = require('node-gyp-build') as (dir: string) => NativeAddon;
  const addon = nodeGypBuild(fileURLToPath(new URL('..', import.meta.url)));

  return {
    kind: 'native',
    version: addon.version,
    compressSync: wrapSync((data, params) => view(addon.compressSync(data, ...args(params)))),
    compress: (data, params) => addon.compress(data, ...args(params)).then(view, rethrowNative),
    decompressSync: wrapSync((data, largeWindow, maxOutput) => view(addon.decompressSync(data, largeWindow, maxOutput))),
    decompress: (data, largeWindow, maxOutput) =>
      addon.decompress(data, largeWindow, maxOutput).then(view, rethrowNative),
    createCStream: wrapSync((params): CStreamHandle => {
      const s = new addon.CStream(...args(params));
      return {
        push: wrapSync((chunk, mode) => view(s.push(chunk, mode))),
        pushAsync: (chunk, mode) => s.pushAsync(chunk, mode).then(view, rethrowNative),
        close: wrapSync(() => s.close()),
      };
    }),
    createDStream: wrapSync((largeWindow, maxOutput): DStreamHandle => {
      const s = new addon.DStream(largeWindow, maxOutput);
      return {
        push: wrapSync((chunk) => view(s.push(chunk))),
        pushAsync: (chunk) => s.pushAsync(chunk).then(view, rethrowNative),
        finish: wrapSync(() => s.finish()),
        close: wrapSync(() => s.close()),
      };
    }),
  };
}
