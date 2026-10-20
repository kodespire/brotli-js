// Tests run against the built package in dist/ (what users get), once per backend.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as nodeEntry from '../dist/entry-node.js';
import * as wasmEntry from '../dist/entry-wasm.js';

export type Brotli = typeof nodeEntry;

export const backends: [name: 'native' | 'wasm', api: Brotli][] = [
  ['native', nodeEntry],
  ['wasm', wasmEntry as Brotli],
];

const fixturesDir = join(import.meta.dirname, 'fixtures');
export const fixture = (name: string): Buffer => readFileSync(join(fixturesDir, name));
export const fixturePath = (name: string): string => join(fixturesDir, name);

const cliCandidate = process.env['BROTLI_CLI'] ?? join(import.meta.dirname, '..', 'out', 'brotli-cli', 'brotli');
/** Path to the official brotli CLI, if built (`node scripts/build-brotli-cli.mjs`). */
export const brotliCli: string | undefined = existsSync(cliCandidate) ? cliCandidate : undefined;

/** Deterministic pseudo-random bytes (incompressible). */
export function randomBytes(length: number, seed = 1): Uint8Array {
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

/** Deterministic, moderately compressible bytes. */
export function textBytes(length: number, seed = 1): Uint8Array {
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

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Runs bytes through a TransformStream, writing them in the given chunk sizes. */
export async function pipeChunks(
  stream: TransformStream<Uint8Array, Uint8Array>,
  data: Uint8Array,
  chunkSizes: (i: number) => number = () => 65536,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for await (const part of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  })();
  const writer = stream.writable.getWriter();
  try {
    for (let offset = 0, i = 0; offset < data.length; i++) {
      const size = Math.max(1, chunkSizes(i));
      await writer.write(data.subarray(offset, offset + size));
      offset += size;
    }
    await writer.close();
  } catch (error) {
    await reading.catch(() => {});
    throw error;
  }
  await reading;
  return concat(...parts);
}

/** Resolves to the BrotliError code thrown by fn, or 'no error'. */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

export function syncErrorCode(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

/** "CODE: message" of the error thrown by fn, or 'no error'. */
export function syncError(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return `${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
}
