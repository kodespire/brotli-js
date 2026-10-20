import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, fixture, pipeChunks, randomBytes, syncError, textBytes } from './helpers.js';

describe.each(backends)('%s backend: options', (_name, b) => {
  const corpus = new Uint8Array(fixture('corpus.txt'));

  // Regression for mongodb-js/zstd NODE-6586, where the level argument was
  // dropped and every call compressed at the default level.
  it('the quality changes the output', () => {
    const sizes = new Map<number, number>();
    for (const quality of [0, 1, 3, 5, 9, 11]) sizes.set(quality, b.compressSync(corpus, { quality }).length);
    expect(new Set(sizes.values()).size).toBe(sizes.size);
    expect(sizes.get(11)!).toBeLessThan(sizes.get(9)!);
    expect(sizes.get(9)!).toBeLessThan(sizes.get(5)!);
    expect(sizes.get(5)!).toBeLessThan(sizes.get(1)!);
    expect(sizes.get(1)!).toBeLessThan(sizes.get(0)!);
  });

  it('the quality shorthand matches the options form, and the defaults are quality 11, lgwin 22, generic', async () => {
    const small = corpus.subarray(0, 50_000);
    expect(b.compressSync(small, 4)).toEqualBytes(b.compressSync(small, { quality: 4 }));
    expect(await b.compress(small, 4)).toEqualBytes(b.compressSync(small, { quality: 4 }));
    const explicit = b.compressSync(small, { quality: 11, lgwin: 22, mode: 'generic', largeWindow: false, sizeHint: 0 });
    expect(b.compressSync(small)).toEqualBytes(explicit);
    expect(b.compressSync(small, {})).toEqualBytes(explicit);
    expect(b.DEFAULT_QUALITY).toBe(11);
    expect(b.DEFAULT_LGWIN).toBe(22);
  });

  it('options reach streaming compression too', async () => {
    const stream = (options: Parameters<typeof b.createCompressStream>[0]) =>
      pipeChunks(b.createCompressStream(options), corpus, () => 30_000);
    const q1 = await stream({ quality: 1 });
    const q9 = await stream({ quality: 9 });
    expect(q9.length).toBeLessThan(q1.length);
    expect(await stream({ quality: 5, mode: 'font' })).not.toEqualBytes(await stream({ quality: 5 }));
    expect((await stream({ quality: 5, lgwin: 16 }))[0]).not.toBe((await stream({ quality: 5 }))[0]);
    for (const s of [q1, q9]) expect(b.decompressSync(s)).toEqualBytes(corpus);
  });

  it('lgwin sets the window: a repeat farther back than the window is not found', () => {
    // 200 KB of random bytes, twice: the second copy is 200 KB back.
    const block = randomBytes(200_000, 8);
    const src = concat(block, block);
    const small = b.compressSync(src, { quality: 5, lgwin: 17 }); // 128 KiB window
    const large = b.compressSync(src, { quality: 5, lgwin: 18 }); // 256 KiB window
    expect(small.length).toBeGreaterThan(390_000);
    expect(large.length).toBeLessThan(210_000);
    for (const s of [small, large]) expect(b.decompressSync(s)).toEqualBytes(src);
    // The window size is in the stream header, so every lgwin gives a different first byte or two.
    const headers = new Set<string>();
    for (let lgwin = 10; lgwin <= 24; lgwin++) headers.add(b.compressSync(src.subarray(0, 100), { quality: 5, lgwin }).subarray(0, 2).join());
    expect(headers.size).toBe(15);
  });

  it('mode "font" changes the output from quality 4; "text" is the same as "generic"', () => {
    for (const quality of [4, 5, 9, 11]) {
      const generic = b.compressSync(corpus, { quality, mode: 'generic' });
      const font = b.compressSync(corpus, { quality, mode: 'font' });
      expect(font, `quality ${quality}`).not.toEqualBytes(generic);
      expect(b.decompressSync(font)).toEqualBytes(corpus);
      // brotli 1.2.0's encoder does not read BROTLI_MODE_TEXT. If a new version starts
      // using it, this fails and the README needs updating.
      expect(b.compressSync(corpus, { quality, mode: 'text' }), `quality ${quality}`).toEqualBytes(generic);
    }
  });

  it('sizeHint changes the output at qualities 4 to 9', async () => {
    // Under 1 MiB of input, a hint of at least 1 MiB selects a different match finder.
    for (const quality of [4, 5, 9]) {
      const plain = b.compressSync(corpus, { quality });
      const hinted = b.compressSync(corpus, { quality, sizeHint: 2 << 20 });
      expect(hinted, `quality ${quality}`).not.toEqualBytes(plain);
      expect(b.decompressSync(hinted)).toEqualBytes(corpus);
    }
    // In a stream the encoder cannot see the total size, so the hint is the only source.
    const big = textBytes(3 << 20, 5);
    const streamed = await pipeChunks(b.createCompressStream({ quality: 5 }), big, () => 100_000);
    const hinted = await pipeChunks(b.createCompressStream({ quality: 5, sizeHint: big.length }), big, () => 100_000);
    expect(hinted).not.toEqualBytes(streamed);
    expect(b.decompressSync(hinted)).toEqualBytes(big);
    // Hints above brotli's own 2^30 cap behave like the cap.
    expect(b.compressSync(corpus, { quality: 5, sizeHint: Number.MAX_SAFE_INTEGER })).toEqualBytes(b.compressSync(corpus, { quality: 5, sizeHint: 2 ** 30 }));
  });

  it('largeWindow writes a stream that only a large-window decoder accepts', () => {
    const src = corpus.subarray(0, 20_000);
    for (const lgwin of [16, 24, 25, 30]) {
      const stream = b.compressSync(src, { quality: 5, lgwin, largeWindow: true });
      expect(stream[0]).toBe(0x11); // the large-window marker
      expect(stream.subarray(0, 2)).not.toEqualBytes(b.compressSync(src, { quality: 5, lgwin: Math.min(lgwin, 24) }).subarray(0, 2));
      expect(syncError(() => b.decompressSync(stream))).toBe('ERR_BROTLI_LIBRARY: brotli: _ERROR_FORMAT_WINDOW_BITS');
      expect(b.decompressSync(stream, { largeWindow: true })).toEqualBytes(src);
    }
    // A large-window decoder also accepts standard streams.
    expect(b.decompressSync(b.compressSync(src, 5), { largeWindow: true })).toEqualBytes(src);
  });

  it('largeWindow with lgwin 25 finds a repeat more than 16 MiB back', async () => {
    // A random block, 17 MiB of zeros, then the block again.
    const block = randomBytes(256 << 10, 12);
    const src = concat(block, new Uint8Array(17 << 20), block);
    const standard = await b.compress(src, { quality: 5, lgwin: 24 });
    const large = await b.compress(src, { quality: 5, lgwin: 25, largeWindow: true });
    expect(standard.length).toBeGreaterThan(2 * block.length);
    expect(large.length).toBeLessThan(block.length + 20_000);
    expect(await b.decompress(large, { largeWindow: true })).toEqualBytes(src);
  });

  it('quality 10 and 11 with lgwin 29 or 30 are out of memory on WebAssembly, and work natively', async () => {
    // The match finder needs 8 << lgwin bytes: more than a 32-bit address space holds.
    const src = textBytes(300_000, 13);
    for (const [quality, lgwin] of [[10, 29], [11, 30]] as const) {
      const options = { quality, lgwin, largeWindow: true };
      if (_name === 'wasm') {
        expect(syncError(() => b.compressSync(src, options))).toMatch(/^ERR_BROTLI_OUT_OF_MEMORY: .*need more memory than WebAssembly can address/);
        expect(await errorCode(() => pipeChunks(b.createCompressStream(options), src))).toBe('ERR_BROTLI_OUT_OF_MEMORY');
      } else {
        expect(b.decompressSync(b.compressSync(src, options), { largeWindow: true })).toEqualBytes(src);
      }
    }
    // The backend keeps working afterwards.
    expect(b.decompressSync(b.compressSync(src, { quality: 11, lgwin: 28, largeWindow: true }), { largeWindow: true })).toEqualBytes(src);
  });

  it('accepts every binary input type', () => {
    const src = textBytes(10_000);
    const stream = b.compressSync(src, 5);
    const padded = new Uint8Array(stream.length + 10);
    padded.set(stream, 5);
    const inputs: unknown[] = [
      stream,
      Buffer.from(stream),
      stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.byteLength),
      padded.subarray(5, 5 + stream.length),
      new DataView(padded.buffer, 5, stream.length),
    ];
    for (const input of inputs) expect(b.decompressSync(input as Uint8Array)).toEqualBytes(src);
    expect(b.decompressSync(b.compressSync('héllo ✓'))).toEqualBytes(new TextEncoder().encode('héllo ✓'));
  });

  it('rejects unknown option names instead of ignoring them', () => {
    expect(() => b.compressSync('x', { level: 9 } as never)).toThrow(/unknown option "level".*Did you mean "quality"/);
    expect(() => b.compressSync('x', { windowBits: 20 } as never)).toThrow(/unknown option "windowBits".*Did you mean "lgwin"/);
    expect(() => b.createCompressStream({ params: {} } as never)).toThrow(/unknown option "params"/);
    expect(() => b.decompressSync(b.compressSync('x'), { maxOutput: 10 } as never)).toThrow(/unknown option "maxOutput"/);
    expect(() => b.createDecompressStream({ lgwin: 22 } as never)).toThrow(/unknown option "lgwin"/);
  });

  it('validates option values', () => {
    expect(() => b.compressSync('x', { quality: 12 })).toThrow(RangeError);
    expect(() => b.compressSync('x', { quality: -1 })).toThrow(RangeError);
    expect(() => b.compressSync('x', { quality: 1.5 })).toThrow(RangeError);
    expect(() => b.compressSync('x', { quality: '5' as never })).toThrow(RangeError);
    expect(() => b.compressSync('x', 12)).toThrow(RangeError);
    expect(() => b.compressSync('x', { lgwin: 9 })).toThrow(RangeError);
    expect(() => b.compressSync('x', { lgwin: 25 })).toThrow(/lgwin must be an integer from 10 to 24 \(up to 30 with largeWindow: true\)/);
    expect(() => b.compressSync('x', { lgwin: 31, largeWindow: true })).toThrow(RangeError);
    expect(() => b.compressSync('x', { mode: 'binary' as never })).toThrow(/mode must be "generic", "text" or "font", got "binary"/);
    expect(() => b.compressSync('x', { mode: 1 as never })).toThrow(TypeError);
    expect(() => b.compressSync('x', { largeWindow: 1 as never })).toThrow(TypeError);
    expect(() => b.compressSync('x', { sizeHint: -1 })).toThrow(RangeError);
    expect(() => b.compressSync('x', { sizeHint: 0.5 })).toThrow(RangeError);
    expect(() => b.compressSync('x', { sizeHint: Infinity })).toThrow(RangeError);
    expect(() => b.decompressSync(new Uint8Array(1), { maxOutputSize: -1 })).toThrow(RangeError);
    expect(() => b.decompressSync(new Uint8Array(1), { maxOutputSize: 1.5 })).toThrow(RangeError);
    expect(() => b.decompressSync(new Uint8Array(1), { largeWindow: 'yes' as never })).toThrow(TypeError);
    expect(() => b.decompressSync('abc' as never)).toThrow(TypeError);
    expect(() => b.compressSync(123 as never)).toThrow(TypeError);
    expect(() => b.compressSync('x', null as never)).toThrow(TypeError);
  });

  it('refuses largeWindow below quality 3, where the encoder would silently drop it', () => {
    for (const quality of [0, 1, 2]) {
      expect(() => b.compressSync('x', { quality, largeWindow: true })).toThrow(/largeWindow needs quality 3 or higher/);
      expect(() => b.createCompressStream({ quality, largeWindow: true })).toThrow(RangeError);
    }
    expect(b.compressSync('x', { quality: 3, largeWindow: true })[0]).toBe(0x11);
  });

  it('accepts the extreme qualities and windows', () => {
    const src = corpus.subarray(0, 40_000);
    for (const quality of [b.MIN_QUALITY, b.MAX_QUALITY]) {
      for (const lgwin of [b.MIN_LGWIN, b.MAX_LGWIN]) {
        expect(b.decompressSync(b.compressSync(src, { quality, lgwin }))).toEqualBytes(src);
      }
    }
    expect(b.decompressSync(b.compressSync(src, { quality: 9, lgwin: b.LARGE_MAX_LGWIN, largeWindow: true }), { largeWindow: true })).toEqualBytes(src);
  });
});
