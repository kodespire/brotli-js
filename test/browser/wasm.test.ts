// Runs in real browsers (see vitest.browser.config.ts) against the built dist/.
import { describe, expect, it } from 'vitest';

import * as b from '../../dist/entry-wasm.js';

const text = (n: number) => new TextEncoder().encode('browser brotli test '.repeat(Math.ceil(n / 20))).subarray(0, n);

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, data: Uint8Array, chunk: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (let i = 0; i < data.length; i += chunk) await writer.write(data.subarray(i, i + chunk));
  await writer.close();
  await reading;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Chromium ships brotli in the Compression Streams API; other engines may not yet.
const browserBrotli = (() => {
  try {
    new DecompressionStream('brotli' as CompressionFormat);
    return true;
  } catch {
    return false;
  }
})();

describe('brotli-js in the browser', () => {
  // Must run first: nothing has loaded the module yet.
  it('sync calls before init() throw ERR_BROTLI_NOT_INITIALIZED', () => {
    expect(() => b.compressSync('x')).toThrow(expect.objectContaining({ code: 'ERR_BROTLI_NOT_INITIALIZED' }));
  });

  it('async calls load the WebAssembly module on demand', async () => {
    const src = text(500_000);
    const stream = await b.compress(src);
    expect(stream.length).toBeLessThan(2_000);
    expect(await b.decompress(stream)).toEqual(src);
    expect(b.activeBackend()).toBe('wasm');
  });

  it('sync calls work after init()', async () => {
    await b.init();
    const src = text(100_000);
    expect(b.decompressSync(b.compressSync(src, 5))).toEqual(src);
  });

  it.skipIf(!browserBrotli)('the built-in DecompressionStream("brotli") decodes our output', async () => {
    const src = text(200_000);
    const stream = await b.compress(src, 9);
    const native = new DecompressionStream('brotli' as CompressionFormat);
    const out = new Uint8Array(await new Response(new Blob([stream as Uint8Array<ArrayBuffer>]).stream().pipeThrough(native)).arrayBuffer());
    expect(out).toEqual(src);
  });

  it('truncated input and trailing bytes are errors', async () => {
    const stream = await b.compress(new Uint8Array(1_000_000));
    await expect(b.decompress(stream.subarray(0, stream.length - 1))).rejects.toMatchObject({ code: 'ERR_BROTLI_TRUNCATED' });
    const longer = new Uint8Array(stream.length + 1);
    longer.set(stream);
    await expect(b.decompress(longer)).rejects.toMatchObject({ code: 'ERR_BROTLI_LIBRARY' });
  });

  it('maxOutputSize is enforced', async () => {
    const stream = await b.compress(new Uint8Array(8 << 20), 5);
    await expect(b.decompress(stream, { maxOutputSize: 1 << 20 })).rejects.toMatchObject({ code: 'ERR_BROTLI_OUTPUT_LIMIT' });
  });

  it('streams round-trip', async () => {
    const src = text(2_000_000);
    const stream = await pipe(b.createCompressStream({ quality: 5 }), src, 100_000);
    expect(await pipe(b.createDecompressStream(), stream, 777)).toEqual(src);
  });

  it('grows WebAssembly memory past 256 MiB and keeps working', async () => {
    const src = new Uint8Array(300 << 20);
    src[src.length - 1] = 7;
    const stream = await b.compress(src, 1);
    const out = await b.decompress(stream);
    expect(out.length).toBe(src.length);
    expect(out[out.length - 1]).toBe(7);
    expect(b.decompressSync(b.compressSync('still fine'))).toEqual(new TextEncoder().encode('still fine'));
  });
});
