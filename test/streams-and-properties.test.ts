import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backends, errorCode, pipeChunks, randomBytes, syncErrorCode, textBytes } from './helpers.js';

const KNOWN_CODES = ['ERR_BROTLI_LIBRARY', 'ERR_BROTLI_TRUNCATED', 'ERR_BROTLI_OUTPUT_LIMIT'];

describe.each(backends)('%s backend: streams', (_name, b) => {
  it('compress stream output decodes with one-shot decompress, for many chunk sizes', async () => {
    const src = textBytes(1_000_000, 21);
    for (const chunk of [1_000, 64 * 1024, 262_144, 300_000, 2_000_000]) {
      const stream = await pipeChunks(b.createCompressStream(5), src, () => chunk);
      expect(b.decompressSync(stream), `chunk ${chunk}`).toEqualBytes(src);
    }
  });

  it('compress stream at the default quality', async () => {
    const src = textBytes(100_000, 2);
    const stream = await pipeChunks(b.createCompressStream(), src, () => 10_000);
    expect(b.decompressSync(stream)).toEqualBytes(src);
    expect(stream.length).toBeLessThan(b.compressSync(src, 5).length);
  });

  it('decompress stream handles input split at every kind of boundary', async () => {
    const src = textBytes(400_000, 22);
    const stream = b.compressSync(src, 7);
    for (const chunk of [1, 3, 4096, 65_536, stream.length]) {
      const out = await pipeChunks(b.createDecompressStream(), stream, () => chunk);
      expect(out, `chunk ${chunk}`).toEqualBytes(src);
    }
  });

  it('decompress stream errors on input that ends early', async () => {
    const stream = b.compressSync(textBytes(100_000, 3), 5);
    expect(await errorCode(() => pipeChunks(b.createDecompressStream(), stream.subarray(0, stream.length - 1)))).toBe('ERR_BROTLI_TRUNCATED');
  });

  it('decompress stream errors when no input arrives at all', async () => {
    expect(await errorCode(() => pipeChunks(b.createDecompressStream(), new Uint8Array(0)))).toBe('ERR_BROTLI_TRUNCATED');
  });

  it('decompress stream enforces maxOutputSize across chunks', async () => {
    const stream = b.compressSync(new Uint8Array(5 << 20), 5);
    expect(await errorCode(() => pipeChunks(b.createDecompressStream({ maxOutputSize: 1 << 20 }), stream, () => 10)))
      .toBe('ERR_BROTLI_OUTPUT_LIMIT');
    expect((await pipeChunks(b.createDecompressStream({ maxOutputSize: 5 << 20 }), stream, () => 10)).length).toBe(5 << 20);
  });

  it('decompress stream errors on corrupt input', async () => {
    expect(await errorCode(() => pipeChunks(b.createDecompressStream(), new Uint8Array([0x1c, 0, 0, 0])))).toBe('ERR_BROTLI_LIBRARY');
  });

  it('streams with large windows', async () => {
    const src = textBytes(300_000, 5);
    const stream = await pipeChunks(b.createCompressStream({ quality: 5, lgwin: 26, largeWindow: true }), src);
    expect(stream[0]).toBe(0x11);
    expect(await errorCode(() => pipeChunks(b.createDecompressStream(), stream, () => 100))).toBe('ERR_BROTLI_LIBRARY');
    expect(await pipeChunks(b.createDecompressStream({ largeWindow: true }), stream, () => 100)).toEqualBytes(src);
  });

  it('cancelling a stream while a chunk is being processed is clean', async () => {
    const big = textBytes(4 << 20, 31);
    const stream = b.compressSync(big, 1);
    const cases: [TransformStream<Uint8Array, Uint8Array>, Uint8Array][] = [
      [b.createCompressStream(11), big],
      [b.createDecompressStream(), stream],
    ];
    for (const [s, chunk] of cases) {
      // transform() only runs once the readable side has demand, so read first.
      const reader = s.readable.getReader();
      const read = reader.read().catch(() => {});
      const pending = s.writable.getWriter().write(chunk).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5)); // the push is now in flight
      await expect(reader.cancel('stop')).resolves.toBeUndefined();
      await Promise.all([read, pending]);
    }
    // The backend still works afterwards.
    expect(b.decompressSync(b.compressSync('after cancel'))).toEqualBytes(new TextEncoder().encode('after cancel'));
  });

  it('many concurrent async calls return the right results', async () => {
    const inputs = Array.from({ length: 64 }, (_, i) => textBytes(20_000 + i * 997, i));
    const streams = await Promise.all(inputs.map((src, i) => b.compress(src, i % 12)));
    const outputs = await Promise.all(streams.map((s) => b.decompress(s)));
    outputs.forEach((out, i) => expect(out).toEqualBytes(inputs[i]!));
  });
});

describe.each(backends)('%s backend: properties', (_name, b) => {
  const options = fc
    .record({
      quality: fc.integer({ min: 0, max: 11 }),
      lgwin: fc.integer({ min: 10, max: 24 }),
      mode: fc.constantFrom('generic' as const, 'text' as const, 'font' as const),
      sizeHint: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1 << 22 })),
      largeWindow: fc.boolean(),
    })
    .map((o) => ({ ...o, largeWindow: o.largeWindow && o.quality >= 3 }));

  it('decompress(compress(x)) === x for arbitrary bytes and options', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 10_000 }), options, (src, o) => {
        expect(b.decompressSync(b.compressSync(src, o), { largeWindow: o.largeWindow })).toEqualBytes(src);
      }),
      { numRuns: 200 },
    );
  });

  it('every proper prefix of a valid stream is ERR_BROTLI_TRUNCATED, and any appended byte is ERR_BROTLI_LIBRARY', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 3_000 }).map((a) => a.map((x, i) => (i % 3 ? x & 0x07 : x))), options, fc.nat(), fc.integer({ min: 0, max: 255 }), (src, o, cutSeed, extra) => {
        const stream = b.compressSync(src, o);
        const cut = cutSeed % stream.length;
        const lw = { largeWindow: o.largeWindow };
        expect(syncErrorCode(() => b.decompressSync(stream.subarray(0, cut), lw))).toBe('ERR_BROTLI_TRUNCATED');
        const longer = new Uint8Array(stream.length + 1);
        longer.set(stream);
        longer[stream.length] = extra;
        expect(syncErrorCode(() => b.decompressSync(longer, lw))).toBe('ERR_BROTLI_LIBRARY');
      }),
      { numRuns: 300 },
    );
  });

  it('arbitrary input either decodes or throws a documented BrotliError, the same way in one shot and in a stream', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 64 }), fc.boolean(), async (input, largeWindow) => {
        let oneShot: string;
        try {
          oneShot = `ok:${b.decompressSync(input, { largeWindow, maxOutputSize: 1 << 20 }).join()}`;
        } catch (error) {
          expect(KNOWN_CODES).toContain((error as { code?: string }).code);
          oneShot = (error as { code: string }).code;
        }
        let streamed: string;
        try {
          streamed = `ok:${(await pipeChunks(b.createDecompressStream({ largeWindow, maxOutputSize: 1 << 20 }), input, () => 3)).join()}`;
        } catch (error) {
          streamed = (error as { code?: string }).code ?? String(error);
        }
        expect(streamed).toBe(oneShot);
      }),
      { numRuns: 500 },
    );
  });

  it('chunked streaming matches one-shot for arbitrary splits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200_000 }).map((a) => a.map((x, i) => (i % 4 ? x & 0x0f : x))),
        fc.array(fc.integer({ min: 1, max: 70_000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 9 }),
        async (src, sizes, quality) => {
          const stream = await pipeChunks(b.createCompressStream(quality), src, (i) => sizes[i % sizes.length]!);
          expect(b.decompressSync(stream)).toEqualBytes(src);
          const out = await pipeChunks(b.createDecompressStream(), stream, (i) => sizes[(i + 1) % sizes.length]!);
          expect(out).toEqualBytes(src);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('native and wasm agree', () => {
  const [[, native], [, wasm]] = backends;

  it('produce the same bytes for the same options', async () => {
    // Same C code on both; the addon is built without floating-point contraction so
    // the encoder's cost model rounds the same way as in WebAssembly.
    const src = textBytes(300_000, 50);
    for (let quality = 0; quality <= 11; quality++) {
      expect(native.compressSync(src, { quality }), `quality ${quality}`).toEqualBytes(wasm.compressSync(src, { quality }));
    }
    for (const o of [{ quality: 9, mode: 'font' as const }, { quality: 5, sizeHint: 1 << 21 }, { quality: 11, lgwin: 16 }, { quality: 6, lgwin: 26, largeWindow: true }]) {
      expect(native.compressSync(src, o), JSON.stringify(o)).toEqualBytes(wasm.compressSync(src, o));
    }
    const a = await pipeChunks(native.createCompressStream(7), src, () => 12_345);
    const c = await pipeChunks(wasm.createCompressStream(7), src, () => 12_345);
    expect(a).toEqualBytes(c);
  });

  it('each decodes the other’s output', async () => {
    for (const quality of [0, 1, 5, 9, 11]) {
      const src = textBytes(300_000, quality + 50);
      expect(wasm.decompressSync(native.compressSync(src, { quality }))).toEqualBytes(src);
      expect(native.decompressSync(wasm.compressSync(src, { quality }))).toEqualBytes(src);
      const streamed = await pipeChunks(native.createCompressStream({ quality }), src, () => 50_000);
      expect(await pipeChunks(wasm.createDecompressStream(), streamed, () => 1234)).toEqualBytes(src);
    }
  });

  it('report the same brotli version as the bundled source', () => {
    expect(native.BROTLI_VERSION).toBe(wasm.BROTLI_VERSION);
  });

  it('give the same errors for the same bad input', () => {
    const stream = native.compressSync(textBytes(20_000, 1), 5);
    const inputs = [new Uint8Array(0), stream.subarray(0, 100), new Uint8Array([...stream, 0]), new Uint8Array([0x1c, 0]), randomBytes(500, 3)];
    for (const input of inputs) {
      const message = (b: typeof native) => {
        try {
          return `ok ${b.decompressSync(input).length}`;
        } catch (error) {
          return `${(error as { code: string }).code} ${(error as Error).message}`;
        }
      };
      expect(message(wasm)).toBe(message(native));
    }
  });
});
