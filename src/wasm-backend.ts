// Loader and bindings for out/wasm/brotli.wasm (a standalone module with no
// Emscripten JS glue). Memory can grow during any call, which replaces
// memory.buffer, so views are created fresh after every call into WebAssembly
// and never cached. Pointers and sizes coming back are unsigned 32-bit (>>> 0).

import { BrotliError, errorFromCore } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle, EncoderParams } from './types.js';

interface BjsExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(size: number): number;
  free(ptr: number): void;
  bjs_buf_free(buf: number): void;
  bjs_compress(src: number, srcSize: number, quality: number, lgwin: number, mode: number, largeWindow: number, sizeHint: number, out: number, detail: number): number;
  bjs_decompress(src: number, srcSize: number, largeWindow: number, maxOutput: number, out: number, detail: number): number;
  bjs_cstream_create(quality: number, lgwin: number, mode: number, largeWindow: number, sizeHint: number, stream: number, detail: number): number;
  bjs_cstream_push(stream: number, src: number, srcSize: number, mode: number, out: number, detail: number): number;
  bjs_cstream_free(stream: number): void;
  bjs_dstream_create(largeWindow: number, maxOutput: number, stream: number, detail: number): number;
  bjs_dstream_push(stream: number, src: number, srcSize: number, out: number, detail: number): number;
  bjs_dstream_finish(stream: number, detail: number): number;
  bjs_dstream_free(stream: number): void;
  bjs_version(): number;
}

const imports = {
  env: {
    // Called by the module after memory.grow; views are rebuilt per call anyway.
    emscripten_notify_memory_growth() {},
  },
};

// Scratch block layout (allocated once per instance):
//   +0  bjs_buf { data, size, cap }   (3 x u32)
//   +12 const char* detail            (u32)
//   +16 stream pointer out-param      (u32)
const SCRATCH_SIZE = 20;
const BUF = 0;
const DETAIL = 12;
const STREAM = 16;

// wasm32 size_t: anything at or above 2^32 - 1 means "no limit".
const NO_LIMIT = 0xffffffff;

const decoder = new TextDecoder();

class Wasm {
  readonly e: BjsExports;
  readonly scratch: number;

  constructor(instance: WebAssembly.Instance) {
    this.e = instance.exports as unknown as BjsExports;
    this.e._initialize?.();
    this.scratch = this.e.malloc(SCRATCH_SIZE) >>> 0;
    if (this.scratch === 0) throw new BrotliError('ERR_BROTLI_OUT_OF_MEMORY', 'out of memory');
  }

  u8(): Uint8Array {
    return new Uint8Array(this.e.memory.buffer);
  }

  view(): DataView {
    return new DataView(this.e.memory.buffer);
  }

  resetScratch(): void {
    this.u8().fill(0, this.scratch, this.scratch + SCRATCH_SIZE);
  }

  /** Copies bytes into WebAssembly memory. Returns 0 for empty input. Caller frees. */
  copyIn(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0;
    const ptr = this.e.malloc(bytes.length) >>> 0;
    if (ptr === 0) throw new BrotliError('ERR_BROTLI_OUT_OF_MEMORY', 'out of memory');
    this.u8().set(bytes, ptr);
    return ptr;
  }

  free(ptr: number): void {
    if (ptr !== 0) this.e.free(ptr);
  }

  cString(ptr: number): string {
    if (ptr === 0) return 'brotli error';
    const mem = this.u8();
    let end = ptr;
    while (mem[end] !== 0) end++;
    return decoder.decode(mem.subarray(ptr, end));
  }

  /** Copies the scratch bjs_buf out to a new Uint8Array and frees it. */
  takeBuf(): Uint8Array {
    const view = this.view();
    const data = view.getUint32(this.scratch + BUF, true);
    const size = view.getUint32(this.scratch + BUF + 4, true);
    const out = this.u8().slice(data, data + size);
    this.e.bjs_buf_free(this.scratch + BUF);
    return out;
  }

  /** Frees the scratch bjs_buf and returns the error for rc. */
  fail(rc: number): BrotliError {
    const detail = this.cString(this.view().getUint32(this.scratch + DETAIL, true));
    this.e.bjs_buf_free(this.scratch + BUF);
    return errorFromCore(rc, detail);
  }

  readPointer(offset: number): number {
    return this.view().getUint32(this.scratch + offset, true);
  }
}

function limit(maxOutput: number): number {
  return maxOutput >= NO_LIMIT ? NO_LIMIT : maxOutput;
}

const registry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<() => void>((free) => free())
    : undefined;

function createBackend(w: Wasm): Backend {
  const { e } = w;

  function withInputs<T>(inputs: Uint8Array[], fn: (ptrs: number[]) => T): T {
    const ptrs: number[] = [];
    try {
      for (const input of inputs) ptrs.push(w.copyIn(input));
      w.resetScratch();
      return fn(ptrs);
    } finally {
      for (const p of ptrs) w.free(p);
    }
  }

  function compressSync(data: Uint8Array, p: EncoderParams): Uint8Array {
    return withInputs([data], ([src]) => {
      const rc = e.bjs_compress(src!, data.length, p.quality, p.lgwin, p.mode, p.largeWindow ? 1 : 0, p.sizeHint, w.scratch + BUF, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.takeBuf();
    });
  }

  function decompressSync(data: Uint8Array, largeWindow: boolean, maxOutput: number): Uint8Array {
    return withInputs([data], ([src]) => {
      const rc = e.bjs_decompress(src!, data.length, largeWindow ? 1 : 0, limit(maxOutput), w.scratch + BUF, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.takeBuf();
    });
  }

  function createCStream(p: EncoderParams): CStreamHandle {
    w.resetScratch();
    const rc = e.bjs_cstream_create(p.quality, p.lgwin, p.mode, p.largeWindow ? 1 : 0, p.sizeHint, w.scratch + STREAM, w.scratch + DETAIL);
    if (rc !== 0) throw w.fail(rc);
    let ptr = w.readPointer(STREAM);
    const token = {};
    registry?.register(token, ((s: number) => () => e.bjs_cstream_free(s))(ptr), token);
    const handle: CStreamHandle & { token: object } = {
      token,
      push(chunk, mode) {
        if (ptr === 0) throw new BrotliError('ERR_BROTLI_INVALID_ARGUMENT', 'stream is closed');
        return withInputs([chunk], ([src]) => {
          const rc = e.bjs_cstream_push(ptr, src!, chunk.length, mode, w.scratch + BUF, w.scratch + DETAIL);
          if (rc !== 0) throw w.fail(rc);
          return w.takeBuf();
        });
      },
      async pushAsync(chunk, mode) {
        return handle.push(chunk, mode);
      },
      close() {
        if (ptr === 0) return;
        registry?.unregister(token);
        e.bjs_cstream_free(ptr);
        ptr = 0;
      },
    };
    return handle;
  }

  function createDStream(largeWindow: boolean, maxOutput: number): DStreamHandle {
    w.resetScratch();
    const rc = e.bjs_dstream_create(largeWindow ? 1 : 0, limit(maxOutput), w.scratch + STREAM, w.scratch + DETAIL);
    if (rc !== 0) throw w.fail(rc);
    let ptr = w.readPointer(STREAM);
    const token = {};
    registry?.register(token, ((s: number) => () => e.bjs_dstream_free(s))(ptr), token);
    const closed = () => new BrotliError('ERR_BROTLI_INVALID_ARGUMENT', 'stream is closed');
    const handle: DStreamHandle & { token: object } = {
      token,
      push(chunk) {
        if (ptr === 0) throw closed();
        return withInputs([chunk], ([src]) => {
          const rc = e.bjs_dstream_push(ptr, src!, chunk.length, w.scratch + BUF, w.scratch + DETAIL);
          if (rc !== 0) throw w.fail(rc);
          return w.takeBuf();
        });
      },
      async pushAsync(chunk) {
        return handle.push(chunk);
      },
      finish() {
        if (ptr === 0) throw closed();
        w.resetScratch();
        const rc = e.bjs_dstream_finish(ptr, w.scratch + DETAIL);
        if (rc !== 0) throw w.fail(rc);
      },
      close() {
        if (ptr === 0) return;
        registry?.unregister(token);
        e.bjs_dstream_free(ptr);
        ptr = 0;
      },
    };
    return handle;
  }

  return {
    kind: 'wasm',
    version: w.cString(e.bjs_version() >>> 0),
    compressSync,
    compress: async (...args) => compressSync(...args),
    decompressSync,
    decompress: async (...args) => decompressSync(...args),
    createCStream,
    createDStream,
  };
}

export async function instantiateWasmBackend(module: WebAssembly.Module): Promise<Backend> {
  const instance = await WebAssembly.instantiate(module, imports);
  return createBackend(new Wasm(instance));
}

export function instantiateWasmBackendSync(module: WebAssembly.Module): Backend {
  return createBackend(new Wasm(new WebAssembly.Instance(module, imports)));
}
