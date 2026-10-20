// Interoperability with two other brotli implementations:
//   - the official brotli CLI, built from the same deps/brotli. Fixtures in
//     test/fixtures were produced by it (scripts/make-fixtures.mjs); the CLI
//     round-trip tests run when out/brotli-cli exists (or BROTLI_CLI is set).
//   - node:zlib's brotli, which Node.js builds from its own copy of the library.
import { execFileSync } from 'node:child_process';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { backends, brotliCli, fixture, pipeChunks, syncError, textBytes } from './helpers.js';

const corpus = new Uint8Array(fixture('corpus.txt'));

describe.each(backends)('%s backend: decodes official CLI output', (_name, b) => {
  it.each([
    'corpus.stdin.br',
    'corpus.file.br',
    'corpus.q0.br',
    'corpus.q1.br',
    'corpus.q5.br',
    'corpus.q9.br',
    'corpus.w10.br',
    'corpus.comment.br',
  ])('%s', async (name) => {
    expect(b.decompressSync(fixture(name))).toEqualBytes(corpus);
    expect(await b.decompress(fixture(name))).toEqualBytes(corpus);
    expect(await pipeChunks(b.createDecompressStream(), fixture(name), () => 999)).toEqualBytes(corpus);
  });

  it('large-window stream, only with largeWindow', () => {
    expect(syncError(() => b.decompressSync(fixture('corpus.large26.br')))).toBe('ERR_BROTLI_LIBRARY: brotli: _ERROR_FORMAT_WINDOW_BITS');
    expect(b.decompressSync(fixture('corpus.large26.br'), { largeWindow: true })).toEqualBytes(corpus);
  });

  it('empty stream', () => {
    expect(b.decompressSync(fixture('empty.br'))).toEqualBytes(new Uint8Array(0));
  });
});

describe.skipIf(!brotliCli).each(backends)('%s backend: official CLI decodes our output', (_name, b) => {
  // The CLI's decoder accepts large-window streams and rejects trailing bytes, as ours does.
  const cliDecompress = (data: Uint8Array) =>
    new Uint8Array(execFileSync(brotliCli!, ['-d', '-c'], { input: data, maxBuffer: 1 << 30 }));
  const cliCompress = (data: Uint8Array, args: string[]) =>
    new Uint8Array(execFileSync(brotliCli!, ['-c', ...args], { input: data, maxBuffer: 1 << 30 }));

  it.each([0, 1, 2, 5, 9, 11])('quality %i', (quality) => {
    const src = textBytes(300_000, quality + 100);
    expect(cliDecompress(b.compressSync(src, { quality }))).toEqualBytes(src);
  });

  it.each([
    { quality: 5, lgwin: 10 },
    { quality: 5, lgwin: 24 },
    { quality: 9, mode: 'font' as const },
    { quality: 5, sizeHint: 1 << 22 },
    { quality: 5, lgwin: 26, largeWindow: true },
  ])('options %o', (options) => {
    const src = textBytes(200_000, 7);
    expect(cliDecompress(b.compressSync(src, options))).toEqualBytes(src);
  });

  it('streamed output', async () => {
    const src = textBytes(800_000, 5);
    const stream = await pipeChunks(b.createCompressStream(5), src, () => 77_777);
    expect(cliDecompress(stream)).toEqualBytes(src);
  });

  it('we decode the CLI at each quality and window, including the large window', () => {
    const src = textBytes(200_000, 9);
    for (const args of [['-q', '0'], ['-q', '3'], ['-q', '7'], ['-q', '10'], ['-w', '12'], ['-q', '5', '--large_window=28']]) {
      const largeWindow = args.some((a) => a.startsWith('--large_window'));
      expect(b.decompressSync(cliCompress(src, args), { largeWindow }), args.join(' ')).toEqualBytes(src);
    }
  });

  it('the CLI rejects what we reject: trailing bytes and truncation', () => {
    const stream = b.compressSync(textBytes(1000, 1), 5);
    const cliRejects = (data: Uint8Array) => {
      try {
        execFileSync(brotliCli!, ['-d', '-c'], { input: data, stdio: ['pipe', 'pipe', 'ignore'] });
        return false;
      } catch {
        return true;
      }
    };
    expect(cliRejects(Buffer.concat([stream, Buffer.from([0])]))).toBe(true);
    expect(cliRejects(stream.subarray(0, stream.length - 1))).toBe(true);
    expect(cliRejects(new Uint8Array(0))).toBe(true);
    expect(cliRejects(stream)).toBe(false);
  });
});

describe.each(backends)('%s backend: node:zlib brotli', (_name, b) => {
  const zlibParams = (quality: number, extra: Record<number, number> = {}) => ({
    params: { [constants.BROTLI_PARAM_QUALITY]: quality, ...extra },
  });

  it.each([0, 1, 4, 9, 11])('node:zlib decodes ours, and we decode node:zlib, at quality %i', (quality) => {
    const src = textBytes(250_000, quality + 3);
    expect(new Uint8Array(brotliDecompressSync(b.compressSync(src, { quality })))).toEqualBytes(src);
    expect(b.decompressSync(brotliCompressSync(src, zlibParams(quality)))).toEqualBytes(src);
  });

  it('every option, both ways', () => {
    const src = textBytes(200_000, 21);
    const cases: [Parameters<typeof b.compressSync>[1], Record<number, number>][] = [
      [{ quality: 5, lgwin: 10 }, { [constants.BROTLI_PARAM_LGWIN]: 10 }],
      [{ quality: 5, lgwin: 24 }, { [constants.BROTLI_PARAM_LGWIN]: 24 }],
      [{ quality: 9, mode: 'font' }, { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT }],
      [{ quality: 9, mode: 'text' }, { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT }],
      [{ quality: 5, sizeHint: src.length }, { [constants.BROTLI_PARAM_SIZE_HINT]: src.length }],
    ];
    for (const [ours, theirs] of cases) {
      const quality = (ours as { quality: number }).quality;
      expect(new Uint8Array(brotliDecompressSync(b.compressSync(src, ours)))).toEqualBytes(src);
      expect(b.decompressSync(brotliCompressSync(src, zlibParams(quality, theirs)))).toEqualBytes(src);
    }
  });

  it('large window: node:zlib needs its flag for our stream, and we need ours for its stream', () => {
    const src = textBytes(100_000, 8);
    const ours = b.compressSync(src, { quality: 5, lgwin: 27, largeWindow: true });
    expect(() => brotliDecompressSync(ours)).toThrow();
    const decoderFlag = { params: { [constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } };
    expect(new Uint8Array(brotliDecompressSync(ours, decoderFlag))).toEqualBytes(src);

    const theirs = brotliCompressSync(src, zlibParams(5, { [constants.BROTLI_PARAM_LARGE_WINDOW]: 1, [constants.BROTLI_PARAM_LGWIN]: 27 }));
    expect(syncError(() => b.decompressSync(theirs))).toBe('ERR_BROTLI_LIBRARY: brotli: _ERROR_FORMAT_WINDOW_BITS');
    expect(b.decompressSync(theirs, { largeWindow: true })).toEqualBytes(src);
  });

  it('streamed output, both ways', async () => {
    const src = textBytes(600_000, 4);
    const ours = await pipeChunks(b.createCompressStream(6), src, () => 33_333);
    expect(new Uint8Array(brotliDecompressSync(ours))).toEqualBytes(src);
    const theirs = brotliCompressSync(src, zlibParams(6));
    expect(await pipeChunks(b.createDecompressStream(), theirs, () => 1111)).toEqualBytes(src);
  });
});
