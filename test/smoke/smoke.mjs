// Smoke test for an installed copy of the package, runnable under Node, Bun and Deno:
//   EXPECT_BACKEND=native node smoke.mjs
//   EXPECT_BACKEND=native bun smoke.mjs
//   EXPECT_BACKEND=wasm deno run -A --node-modules-dir=manual smoke.mjs
// Copy it next to a node_modules that has @kodespire/brotli-js installed.
import * as b from '@kodespire/brotli-js';

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  globalThis.process?.exit?.(1);
  globalThis.Deno?.exit?.(1);
  throw new Error(message);
};
const equal = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const codeOf = async (fn) => {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return error.code;
  }
};

const runtime = globalThis.Deno ? `deno ${Deno.version.deno}` : globalThis.Bun ? `bun ${Bun.version}` : `node ${process.version}`;
const src = new TextEncoder().encode('smoke test '.repeat(50_000));

const stream = await b.compress(src);
if (!equal(await b.decompress(stream), src)) fail('async round trip');
await b.init();
if (!equal(b.decompressSync(b.compressSync(src, 5)), src)) fail('sync round trip');

const truncated = await codeOf(() => b.decompress(stream.subarray(0, stream.length - 1)));
if (truncated !== 'ERR_BROTLI_TRUNCATED') fail(`truncated input gave ${truncated}`);
const trailing = await codeOf(() => b.decompress(new Uint8Array([...stream, 0])));
if (trailing !== 'ERR_BROTLI_LIBRARY') fail(`trailing byte gave ${trailing}`);

const streamed = await new Response(new Blob([src]).stream().pipeThrough(b.createCompressStream(5)).pipeThrough(b.createDecompressStream())).arrayBuffer();
if (!equal(new Uint8Array(streamed), src)) fail('stream round trip');

const backend = b.activeBackend();
const expected = globalThis.process?.env?.EXPECT_BACKEND ?? globalThis.Deno?.env.get('EXPECT_BACKEND');
if (expected && backend !== expected) fail(`backend is ${backend}, expected ${expected}`);

// This prebuild must produce the same bytes as WebAssembly: the encoder's
// floating-point cost model has to round the same way in both builds.
const wasm = await import('@kodespire/brotli-js/wasm');
await wasm.init();
const words = 'the quick brown fox jumps over a lazy dog brotli window block literal distance'.split(' ');
let x = 1;
const varied = new TextEncoder().encode(Array.from({ length: 40_000 }, () => {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  return words[x % words.length] + (x % 13 === 0 ? ` ${x % 1000}\n` : '');
}).join(' '));
for (const quality of [1, 5, 9, 11]) {
  if (!equal(b.compressSync(varied, quality), wasm.compressSync(varied, quality))) {
    fail(`${backend} and WebAssembly output differ at quality ${quality}`);
  }
}

console.log(`ok: ${runtime}, backend=${backend} (same bytes as wasm), brotli ${b.BROTLI_VERSION}, ${src.length} -> ${stream.length} bytes`);
