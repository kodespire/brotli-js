// Self-test of @kodespire/brotli-js on a device or simulator. Each result is logged as
// one `BROTLI_SELFTEST ...` line, which scripts/selftest.mjs reads from the device log,
// and the last line is `BROTLI_SELFTEST DONE passed=N failed=M`.
import {
  activeBackend,
  BROTLI_VERSION,
  BrotliError,
  compress,
  compressSync,
  createCompressStream,
  createDecompressStream,
  decompress,
  decompressSync,
  init,
} from '@kodespire/brotli-js';

// @ts-ignore generated plain JS
import generated from './fixtures.generated';

declare const require: (id: string) => unknown;

type Log = (line: string) => void;

const { fixtures, wasmFingerprints } = generated as {
  fixtures: Record<string, string>;
  wasmFingerprints: Record<string, { length: number; fnv1a: number }>;
};

function fixture(name: string): Uint8Array {
  const binary = atob(fixtures[name]!);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic pseudo-random bytes (the same generator as test/helpers.ts). */
function randomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Deterministic, moderately compressible bytes (the same generator as test/helpers.ts). */
function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'brotli ', 'window ', 'block ', '\n'];
  const out = new Uint8Array(length);
  const r = randomBytes(length, seed);
  let i = 0;
  let k = 0;
  while (i < length) {
    const w = words[r[k++ % length]! % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

/** The input test/smoke/smoke.mjs compares between the native and WebAssembly builds. */
function smokeText(): Uint8Array {
  const words = 'the quick brown fox jumps over a lazy dog brotli window block literal distance'.split(' ');
  let x = 1;
  return new TextEncoder().encode(
    Array.from({ length: 40_000 }, () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return words[x % words.length] + (x % 13 === 0 ? ` ${x % 1000}\n` : '');
    }).join(' '),
  );
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(actual instanceof Uint8Array, `${what}: not a Uint8Array`);
  assert(actual.length === expected.length, `${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: differs at byte ${i}`);
  }
}

async function assertCode(run: () => unknown, code: string, what: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof BrotliError, `${what}: threw ${String(error)}, expected a BrotliError`);
    assert(error.code === code, `${what}: code ${error.code}, expected ${code}`);
    return;
  }
  throw new Error(`${what}: did not throw ${code}`);
}

function assertThrows(run: () => unknown, type: ErrorConstructor, pattern: RegExp, what: string): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof type, `${what}: threw ${String(error)}, expected a ${type.name}`);
    assert(pattern.test((error as Error).message), `${what}: message ${JSON.stringify((error as Error).message)}`);
    return;
  }
  throw new Error(`${what}: did not throw`);
}

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, chunks: Uint8Array[]): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
    }
  })();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();
  await Promise.all([reading, writing]);
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return chunks;
}

const tests: [name: string, run: (log: Log) => Promise<void>][] = [
  ['native backend', async (log) => {
    await init();
    assert(activeBackend() === 'native', `activeBackend() is ${activeBackend()}`);
    log(`info brotli ${BROTLI_VERSION}`);
  }],

  ['round trip at each quality and option', async () => {
    const data = textBytes(256 << 10);
    for (const options of [
      undefined, // quality 11, the default
      0,
      { quality: 5 },
      { quality: 9, lgwin: 16 },
      { quality: 5, mode: 'font' as const },
      { quality: 5, lgwin: 24, sizeHint: data.length },
    ]) {
      const what = `options ${JSON.stringify(options)}`;
      assertBytes(await decompress(await compress(data, options)), data, `async, ${what}`);
      assertBytes(decompressSync(compressSync(data, options)), data, `sync, ${what}`);
    }
    assert(compressSync(data, 11).length < compressSync(data, 5).length, 'quality 11 is not smaller than quality 5');
    const text = 'héllo € 😀 '.repeat(100);
    assertBytes(decompressSync(compressSync(text, 5)), new TextEncoder().encode(text), 'string input');
    assertBytes(await decompress(await compress(new Uint8Array(0))), new Uint8Array(0), 'empty input');
    // A view into a larger buffer: only the viewed bytes are compressed.
    const view = new Uint8Array(data.buffer, 1000, 5000);
    assertBytes(await decompress(await compress(view, 5)), data.subarray(1000, 6000), 'subarray input');
  }],

  ['same bytes as the brotli CLI and WebAssembly', async () => {
    // The encoder's cost model is floating point; the native build must round like
    // every other build (-ffp-contract=off) to produce these exact bytes.
    const corpus = fixture('corpus.txt');
    for (const quality of [0, 1, 5, 9]) {
      assertBytes(compressSync(corpus, { quality, lgwin: 24 }), fixture(`corpus.q${quality}.br`), `quality ${quality}`);
    }
    assertBytes(compressSync(corpus, { lgwin: 24 }), fixture('corpus.stdin.br'), 'quality 11');
    assertBytes(compressSync(corpus, { lgwin: 10 }), fixture('corpus.w10.br'), 'lgwin 10');
    assertBytes(compressSync(corpus, { quality: 9, lgwin: 26, largeWindow: true }), fixture('corpus.large26.br'), 'large window');
    const text = smokeText();
    for (const [quality, expected] of Object.entries(wasmFingerprints)) {
      const out = compressSync(text, Number(quality));
      assert(out.length === expected.length && fnv1a(out) === expected.fnv1a, `quality ${quality}: differs from WebAssembly`);
    }
  }],

  ['decodes the brotli CLI', async () => {
    const corpus = fixture('corpus.txt');
    for (const name of ['corpus.stdin.br', 'corpus.file.br', 'corpus.q0.br', 'corpus.q5.br', 'corpus.w10.br', 'corpus.comment.br']) {
      assertBytes(await decompress(fixture(name)), corpus, name);
      assertBytes(decompressSync(fixture(name)), corpus, `${name} (sync)`);
    }
    assertBytes(decompressSync(fixture('empty.br')), new Uint8Array(0), 'empty.br');
  }],

  ['large window', async () => {
    const corpus = fixture('corpus.txt');
    const large = fixture('corpus.large26.br');
    await assertCode(() => decompress(large), 'ERR_BROTLI_LIBRARY', 'without largeWindow');
    assertBytes(await decompress(large, { largeWindow: true }), corpus, 'with largeWindow');
    const data = textBytes(300_000, 5);
    const packed = await compress(data, { quality: 5, lgwin: 26, largeWindow: true });
    assertBytes(decompressSync(packed, { largeWindow: true }), data, 'round trip');
    await assertCode(() => decompressSync(packed), 'ERR_BROTLI_LIBRARY', 'round trip without largeWindow');
  }],

  ['truncated input', async () => {
    const packed = compressSync(textBytes(100_000), 5);
    for (const end of [1, 4, packed.length >> 1, packed.length - 1]) {
      const cut = packed.subarray(0, end);
      await assertCode(() => decompress(cut), 'ERR_BROTLI_TRUNCATED', `decompress, ${end} bytes`);
      await assertCode(() => decompressSync(cut), 'ERR_BROTLI_TRUNCATED', `decompressSync, ${end} bytes`);
    }
    await assertCode(() => decompress(new Uint8Array(0)), 'ERR_BROTLI_TRUNCATED', 'empty input');
    await assertCode(() => decompressSync(new Uint8Array(0)), 'ERR_BROTLI_TRUNCATED', 'empty input (sync)');
    await assertCode(() => decompress(new Uint8Array([0x1c, 0, 0, 0])), 'ERR_BROTLI_LIBRARY', 'invalid input');
  }],

  ['trailing data', async () => {
    const data = textBytes(50_000, 3);
    const packed = compressSync(data, 5);
    for (const extra of [[0], [0xff], [...packed.subarray(0, 8)]]) {
      const input = concat([packed, new Uint8Array(extra)]);
      const what = `${extra.length} trailing byte(s)`;
      await assertCode(() => decompress(input), 'ERR_BROTLI_LIBRARY', what);
      await assertCode(() => decompressSync(input), 'ERR_BROTLI_LIBRARY', `${what} (sync)`);
    }
    await assertCode(() => decompress(concat([packed, packed])), 'ERR_BROTLI_LIBRARY', 'two streams');
  }],

  ['maxOutputSize', async () => {
    const data = textBytes(200_000);
    const packed = await compress(data, 5);
    await assertCode(() => decompress(packed, { maxOutputSize: data.length - 1 }), 'ERR_BROTLI_OUTPUT_LIMIT', 'async, one byte short');
    await assertCode(() => decompressSync(packed, { maxOutputSize: 0 }), 'ERR_BROTLI_OUTPUT_LIMIT', 'sync, limit 0');
    assertBytes(await decompress(packed, { maxOutputSize: data.length }), data, 'exact limit');
    await assertCode(() => decompress(new Uint8Array(0), { maxOutputSize: 10 }), 'ERR_BROTLI_TRUNCATED', 'empty input with a limit');
  }],

  ['async work runs off the JS thread', async (log) => {
    // Grow the input until one async compress at quality 11 (the slowest) takes long
    // enough to measure, then check the JS thread kept running timers the whole time.
    let size = 512 << 10;
    for (;;) {
      const data = textBytes(size);
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const start = performance.now();
      const packed = await compress(data, 11);
      const elapsed = performance.now() - start;
      clearInterval(timer);
      if (elapsed < 400 && size < 16 << 20) {
        size *= 2;
        continue;
      }
      assertBytes(decompressSync(packed), data, 'output');
      log(`info compress(${size >> 10} KiB, 11): ${elapsed.toFixed(0)} ms, ${ticks} timer ticks, longest JS stall ${maxGap.toFixed(0)} ms`);
      assert(ticks >= 10, `only ${ticks} timer ticks in ${elapsed.toFixed(0)} ms`);
      assert(maxGap < elapsed / 2, `JS thread stalled for ${maxGap.toFixed(0)} ms of ${elapsed.toFixed(0)} ms`);
      break;
    }
    // Several jobs at once, and inputs captured at call time.
    const inputs = [1, 2, 3, 4].map((seed) => textBytes(500_000, seed));
    const expected = inputs.map((input) => input.slice());
    const pending = inputs.map((input) => compress(input, 5));
    for (const input of inputs) input.fill(0);
    const outputs = await Promise.all(pending);
    for (let i = 0; i < outputs.length; i++) assertBytes(decompressSync(outputs[i]!), expected[i]!, `job ${i}`);
    const packed = compressSync(expected[0]!, 5);
    const pendingDecompress = decompress(packed);
    packed.fill(0);
    assertBytes(await pendingDecompress, expected[0]!, 'decompress input captured at call time');
  }],

  ['options are checked', async () => {
    const one = new Uint8Array(1);
    assertThrows(() => compressSync(one, { level: 5 } as never), TypeError, /Did you mean "quality"/, 'unknown option');
    assertThrows(() => compressSync(one, 12), RangeError, /quality must be an integer from 0 to 11/, 'quality 12');
    assertThrows(() => compressSync(one, { lgwin: 25 }), RangeError, /up to 30 with largeWindow/, 'lgwin 25');
    assertThrows(() => compressSync(one, { quality: 2, largeWindow: true }), RangeError, /largeWindow needs quality 3/, 'largeWindow at quality 2');
    assertThrows(() => decompressSync(one, { maxOutputSize: -1 }), RangeError, /maxOutputSize/, 'negative maxOutputSize');
  }],

  ['streams', async (log) => {
    if (typeof TransformStream === 'undefined') {
      let message = '';
      try {
        createCompressStream();
      } catch (error) {
        message = String(error);
      }
      assert(/TransformStream/.test(message), `without a TransformStream: ${message || 'no error'}`);
      require('web-streams-polyfill/polyfill');
      log('info no global TransformStream: using web-streams-polyfill');
    }
    const data = textBytes(1 << 20, 5);
    const packed = await pipe(createCompressStream({ quality: 5 }), split(data, 65_536));
    assertBytes(decompressSync(packed), data, 'compress stream');
    assertBytes(await pipe(createDecompressStream(), split(packed, 7_000)), data, 'decompress stream');
    const hinted = await pipe(createCompressStream({ quality: 9, mode: 'font', sizeHint: data.length }), split(data, 100_000));
    assertBytes(decompressSync(hinted), data, 'font mode with a size hint');
    const small = textBytes(100_000, 6);
    assertBytes(decompressSync(await pipe(createCompressStream(), [small])), small, 'default quality');
    await assertCode(() => pipe(createDecompressStream(), [packed.subarray(0, packed.length - 3)]), 'ERR_BROTLI_TRUNCATED', 'truncated stream');
    await assertCode(() => pipe(createDecompressStream(), []), 'ERR_BROTLI_TRUNCATED', 'no input');
    await assertCode(() => pipe(createDecompressStream(), [packed, new Uint8Array([0])]), 'ERR_BROTLI_LIBRARY', 'trailing byte');
    await assertCode(() => pipe(createDecompressStream({ maxOutputSize: 1000 }), [packed]), 'ERR_BROTLI_OUTPUT_LIMIT', 'stream over maxOutputSize');
    const large = await pipe(createCompressStream({ quality: 5, lgwin: 26, largeWindow: true }), [small]);
    await assertCode(() => pipe(createDecompressStream(), [large]), 'ERR_BROTLI_LIBRARY', 'large window without largeWindow');
    assertBytes(await pipe(createDecompressStream({ largeWindow: true }), split(large, 100)), small, 'large window stream');
  }],

  ['speed', async (log) => {
    const data = textBytes(8 << 20);
    const mbps = (bytes: number, ms: number) => (bytes / 1e6 / (ms / 1000)).toFixed(1);
    for (const quality of [5, 11]) {
      // Quality 11 runs at about 1 MB/s: time it on 1 MiB.
      const input = quality === 11 ? data.subarray(0, 1 << 20) : data;
      let start = performance.now();
      const packed = compressSync(input, quality);
      const compressMs = performance.now() - start;
      start = performance.now();
      decompressSync(packed);
      const decompressMs = performance.now() - start;
      log(`info quality ${quality}, ${input.length >> 20} MiB: compress ${mbps(input.length, compressMs)} MB/s, decompress ${mbps(input.length, decompressMs)} MB/s, ratio ${(input.length / packed.length).toFixed(2)}`);
    }
  }],
];

export async function runSelfTest(log: Log): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  for (const [name, run] of tests) {
    const start = performance.now();
    try {
      await run(log);
      passed++;
      log(`ok ${name} (${(performance.now() - start).toFixed(0)} ms)`);
    } catch (error) {
      failed++;
      log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`DONE passed=${passed} failed=${failed}`);
  return failed === 0;
}
