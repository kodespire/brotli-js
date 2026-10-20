// The decompression loop is where brotli bindings usually go wrong: output that
// fills a buffer exactly, output the decoder holds back while asking for more
// input, input that stops early, and bytes after the end of the stream. Brotli
// has no magic number, frame header or checksum, so these rules are ours:
//   - input that ends before the final meta-block (or is empty) is ERR_BROTLI_TRUNCATED
//   - any byte after the end of the stream is ERR_BROTLI_LIBRARY
//   - input the decoder rejects is ERR_BROTLI_LIBRARY with the decoder's error string
// Every case runs on both backends.
import { once } from 'node:events';
import { constants, createBrotliCompress } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, pipeChunks, randomBytes, syncError, syncErrorCode, textBytes } from './helpers.js';

// Sizes around the binding's 64 KiB minimum allocation and 1.5x growth steps
// (64, 96, 144, 216 KiB...), brotli's 64 KiB minimum input block and 16 MiB
// meta-blocks, and the window size (2^lgwin - 16) for lgwin 16 and 18.
const BOUNDARY_SIZES = [
  0, 1, 2, 65519, 65520, 65521, 65535, 65536, 65537, 98303, 98304, 98305, 131071, 131072, 131073,
  147456, 221183, 221184, 221185, 262127, 262128, 262129, 262144, 1 << 20, (1 << 20) + 1,
];

/** Compresses parts with node:zlib, flushing after each one. Returns the offsets after each flush. */
async function flushedStream(parts: Uint8Array[]): Promise<{ stream: Uint8Array; flushPoints: number[] }> {
  const encoder = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  const chunks: Uint8Array[] = [];
  encoder.on('data', (chunk: Buffer) => chunks.push(chunk));
  const flushPoints: number[] = [];
  for (const part of parts.slice(0, -1)) {
    encoder.write(part);
    await new Promise<void>((resolve) => encoder.flush(constants.BROTLI_OPERATION_FLUSH, () => resolve()));
    flushPoints.push(chunks.reduce((n, c) => n + c.length, 0));
  }
  encoder.end(parts.at(-1));
  await once(encoder, 'end');
  return { stream: concat(...chunks), flushPoints };
}

// Quality 11 is slow (about 1 MB/s, slower in WebAssembly), so the sweeps use
// faster qualities; quality only changes which encoder path made the stream.
const SWEEP_QUALITIES = [1, 5];

describe.each(backends)('%s backend: decompression edge cases', (name, b) => {
  it('reports the expected backend', () => {
    expect(b.activeBackend()).toBe(name);
  });

  it.each(BOUNDARY_SIZES)('one-shot stream, %i bytes', async (size) => {
    const src = textBytes(size, size + 1);
    for (const quality of SWEEP_QUALITIES) {
      const stream = b.compressSync(src, { quality, lgwin: 16 });
      expect(b.decompressSync(stream)).toEqualBytes(src);
      expect(await b.decompress(stream)).toEqualBytes(src);
      // A limit equal to the exact size must pass; one byte less must not.
      expect(b.decompressSync(stream, { maxOutputSize: size })).toEqualBytes(src);
      if (size > 0) expect(syncErrorCode(() => b.decompressSync(stream, { maxOutputSize: size - 1 }))).toBe('ERR_BROTLI_OUTPUT_LIMIT');
    }
  });

  it.each(BOUNDARY_SIZES)('streamed, partly compressible, %i bytes', async (size) => {
    const src = randomBytes(size, size + 7).map((x, i) => (i % 3 === 0 ? x : 0x61));
    const stream = await pipeChunks(b.createCompressStream({ quality: 5 }), src, () => 50_000);
    expect(b.decompressSync(stream)).toEqualBytes(src);
    expect(await b.decompress(stream, { maxOutputSize: size })).toEqualBytes(src);
    // Decoding in small pieces makes the decoder stop for input mid-meta-block,
    // with decoded bytes still in its ring buffer.
    expect(await pipeChunks(b.createDecompressStream({ maxOutputSize: size }), stream, () => 4093)).toEqualBytes(src);
  });

  it('incompressible input (stored meta-blocks) round-trips at every quality', () => {
    const src = randomBytes(300_000, 3);
    for (let quality = 0; quality <= 11; quality++) {
      const stream = b.compressSync(src, quality);
      expect(stream.length).toBeLessThan(src.length + 64);
      expect(b.decompressSync(stream), `quality ${quality}`).toEqualBytes(src);
    }
  });

  it('highly compressible input: 64 MiB of zeros from a few KB', async () => {
    const src = new Uint8Array(64 << 20);
    const stream = await b.compress(src, 5);
    expect(stream.length).toBeLessThan(10_000);
    const out = await b.decompress(stream);
    expect(out.length).toBe(src.length);
    expect(out.every((x) => x === 0)).toBe(true);
  });

  it('a valid stream holding zero bytes decodes to nothing', () => {
    const empty = b.compressSync(new Uint8Array(0));
    expect(empty.length).toBe(1);
    expect(b.decompressSync(empty)).toEqualBytes(new Uint8Array(0));
    expect(b.decompressSync(empty, { maxOutputSize: 0 })).toEqualBytes(new Uint8Array(0));
  });
});

describe.each(backends)('%s backend: truncated input', (_name, b) => {
  it('empty input is an error, as with the brotli CLI', async () => {
    expect(syncError(() => b.decompressSync(new Uint8Array(0)))).toBe('ERR_BROTLI_TRUNCATED: brotli input is empty');
    expect(await errorCode(() => b.decompress(new Uint8Array(0)))).toBe('ERR_BROTLI_TRUNCATED');
  });

  // Every byte offset, for streams from each encoder path: quality 0 and 1 have
  // their own one-pass encoders, 2 to 9 the greedy/lazy ones, 10 and 11 the
  // optimal parser; plus stored (incompressible) data, a large-window header
  // and the one-byte empty stream.
  const cases: [label: string, src: Uint8Array, options: { quality: number; lgwin?: number; largeWindow?: boolean }][] = [
    ['quality 0', textBytes(3000, 9), { quality: 0 }],
    ['quality 1', textBytes(3000, 9), { quality: 1 }],
    ['quality 5', textBytes(3000, 9), { quality: 5 }],
    ['quality 11', textBytes(3000, 9), { quality: 11 }],
    ['quality 11, lgwin 10, several meta-blocks', textBytes(40_000, 4), { quality: 11, lgwin: 10 }],
    ['stored', randomBytes(2000, 5), { quality: 5 }],
    ['large window', textBytes(3000, 9), { quality: 5, lgwin: 26, largeWindow: true }],
    ['empty', new Uint8Array(0), { quality: 11 }],
  ];

  it.each(cases)('every proper prefix is rejected as truncated: %s', (_label, src, options) => {
    const largeWindow = options.largeWindow ?? false;
    const stream = b.compressSync(src, options);
    for (let cut = 0; cut < stream.length; cut++) {
      const code = syncErrorCode(() => b.decompressSync(stream.subarray(0, cut), { largeWindow }));
      expect(code, `cut at ${cut}/${stream.length}`).toBe('ERR_BROTLI_TRUNCATED');
    }
    expect(b.decompressSync(stream, { largeWindow })).toEqualBytes(src);
  });

  it('a stream with flush points is truncated at every offset, including right after a flush', async () => {
    // After a flush the decoder has emitted everything so far and sits between
    // meta-blocks. Input cut there looks complete to a careless binding.
    const parts = [textBytes(5000, 1), textBytes(5000, 2), textBytes(5000, 3)];
    const { stream, flushPoints } = await flushedStream(parts);
    expect(b.decompressSync(stream)).toEqualBytes(concat(...parts));
    for (let cut = 0; cut < stream.length; cut++) {
      expect(syncErrorCode(() => b.decompressSync(stream.subarray(0, cut))), `cut at ${cut}`).toBe('ERR_BROTLI_TRUNCATED');
    }
    // The decompress stream emits everything up to each flush point before more input arrives.
    for (const [i, point] of flushPoints.entries()) {
      const s = b.createDecompressStream();
      const reader = s.readable.getReader();
      const writer = s.writable.getWriter();
      void writer.write(stream.subarray(0, point)).catch(() => {});
      const expected = concat(...parts.slice(0, i + 1));
      const got: Uint8Array[] = [];
      while (got.reduce((n, p) => n + p.length, 0) < expected.length) got.push((await reader.read()).value!);
      expect(concat(...got)).toEqualBytes(expected);
      void writer.close().catch(() => {});
      expect(await errorCode(() => reader.read())).toBe('ERR_BROTLI_TRUNCATED');
    }
  });

  it('truncating a large stream is rejected (sampled offsets)', async () => {
    const src = textBytes(3 << 20, 10);
    const stream = await b.compress(src, 5);
    for (const cut of [1, 2, 3, 100, stream.length >> 2, stream.length >> 1, stream.length - 3, stream.length - 2, stream.length - 1]) {
      expect(await errorCode(() => b.decompress(stream.subarray(0, cut))), `cut at ${cut}`).toBe('ERR_BROTLI_TRUNCATED');
    }
  });

  it('regression: 1 MB of zeros with the last 3 bytes cut is an error, not partial output', async () => {
    const stream = await b.compress(new Uint8Array(1_000_000));
    expect(await errorCode(() => b.decompress(stream.subarray(0, stream.length - 3)))).toBe('ERR_BROTLI_TRUNCATED');
  });
});

describe.each(backends)('%s backend: trailing bytes and corrupt input', (_name, b) => {
  const extra = 'ERR_BROTLI_LIBRARY: brotli: extra input after the end of the stream';

  it('any byte after the end of the stream is rejected', () => {
    const stream = b.compressSync(textBytes(1000, 1));
    for (const tail of [[0], [1], [0xff], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      expect(syncError(() => b.decompressSync(concat(stream, new Uint8Array(tail))))).toBe(extra);
    }
    expect(syncError(() => b.decompressSync(new Uint8Array([0x3b, 0x00])))).toBe(extra);
  });

  it('concatenated streams are rejected (unlike zstd frames)', () => {
    const a = b.compressSync(textBytes(1000, 1));
    const c = b.compressSync(textBytes(1000, 2));
    expect(syncError(() => b.decompressSync(concat(a, c)))).toBe(extra);
  });

  it('the decompress stream rejects trailing bytes in the same chunk and in a later one', async () => {
    const src = textBytes(20_000, 1);
    const stream = b.compressSync(src, 5);
    const withTail = concat(stream, new Uint8Array([7]));
    expect(await errorCode(() => pipeChunks(b.createDecompressStream(), withTail))).toBe('ERR_BROTLI_LIBRARY');
    expect(await errorCode(() => pipeChunks(b.createDecompressStream(), withTail, (i) => (i === 0 ? stream.length : 1))))
      .toBe('ERR_BROTLI_LIBRARY');
    // Empty chunks after the end are fine.
    const s = b.createDecompressStream();
    const reading = new Response(s.readable).arrayBuffer();
    const writer = s.writable.getWriter();
    await writer.write(stream);
    await writer.write(new Uint8Array(0));
    await writer.close();
    expect(new Uint8Array(await reading)).toEqualBytes(src);
  });

  // Hand-made streams that break one rule each. The error carries the decoder's string.
  it.each([
    ['nonzero padding after the last meta-block', [0xbb], '_ERROR_FORMAT_PADDING_2'],
    ['reserved bit set in a metadata header', [0x1c, 0x00], '_ERROR_FORMAT_RESERVED'],
    ['large-window header without largeWindow', [0x11, 0x56], '_ERROR_FORMAT_WINDOW_BITS'],
    ['text that is not brotli', [...new TextEncoder().encode('definitely not brotli')], '_ERROR_FORMAT_PADDING_1'],
  ])('%s', (_label, bytes, decoderError) => {
    expect(syncError(() => b.decompressSync(new Uint8Array(bytes)))).toBe(`ERR_BROTLI_LIBRARY: brotli: ${decoderError}`);
  });

  it('corrupted bytes are rejected or, without a checksum, may decode to other bytes', () => {
    // Brotli has no checksum: a flipped byte can still form a valid stream. Every
    // outcome must be a documented error or a successful decode, never a crash or
    // a partial result; most flips are caught.
    const src = textBytes(200_000, 11);
    const stream = b.compressSync(src, 9);
    const outcomes = new Map<string, number>();
    for (let i = 1; i < stream.length; i += Math.max(1, Math.floor(stream.length / 120))) {
      const bad = stream.slice();
      bad[i]! ^= 0x5a;
      const code = syncErrorCode(() => b.decompressSync(bad));
      outcomes.set(code, (outcomes.get(code) ?? 0) + 1);
    }
    expect([...outcomes.keys()].every((c) => ['ERR_BROTLI_LIBRARY', 'ERR_BROTLI_TRUNCATED', 'no error'].includes(c)), JSON.stringify([...outcomes])).toBe(true);
    const total = [...outcomes.values()].reduce((x, y) => x + y, 0);
    expect(total - (outcomes.get('no error') ?? 0)).toBeGreaterThan(total * 0.6);
  });
});

describe.each(backends)('%s backend: maxOutputSize', (_name, b) => {
  it('stops a decompression bomb early', async () => {
    // 1 GiB of zeros, compressed by streaming 16 MiB chunks, is about 1.6 KB.
    const zeros = new Uint8Array(16 << 20);
    const parts: Uint8Array[] = [];
    const stream = b.createCompressStream(5);
    const writer = stream.writable.getWriter();
    const reading = (async () => {
      for await (const p of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
    })();
    for (let i = 0; i < 64; i++) await writer.write(zeros);
    await writer.close();
    await reading;
    const bomb = concat(...parts);
    expect(bomb.length).toBeLessThan(10_000);

    const started = performance.now();
    expect(await errorCode(() => b.decompress(bomb, { maxOutputSize: 10 << 20 }))).toBe('ERR_BROTLI_OUTPUT_LIMIT');
    expect(await errorCode(() => pipeChunks(b.createDecompressStream({ maxOutputSize: 10 << 20 }), bomb, () => 100))).toBe('ERR_BROTLI_OUTPUT_LIMIT');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('maxOutputSize: 0 accepts only empty output', () => {
    expect(b.decompressSync(b.compressSync(new Uint8Array(0)), { maxOutputSize: 0 })).toEqualBytes(new Uint8Array(0));
    expect(syncErrorCode(() => b.decompressSync(b.compressSync('x'), { maxOutputSize: 0 }))).toBe('ERR_BROTLI_OUTPUT_LIMIT');
  });
});
