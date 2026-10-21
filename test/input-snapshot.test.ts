// Async calls must use the bytes as they were when the call was made, even if the
// caller changes its buffer before the promise settles. Regression: 0.1.0 awaited
// the backend before copying the input, so a change made right after the call
// (on any call, not only while the WebAssembly module was loading) was compressed.
// The wasm backend is first used in this file by these tests, so the loading path
// is covered too.
import { describe, expect, it } from 'vitest';

import { backends, textBytes } from './helpers.js';

describe.each(backends)('%s backend: async calls capture their input at call time', (_name, b) => {
  it('compress ignores changes made to the input after the call', async () => {
    const original = textBytes(200_000, 41);
    const buf = Buffer.from(original);
    const pending = b.compress(buf, 5);
    buf.fill(0);
    expect(b.decompressSync(await pending)).toEqualBytes(original);
  });

  it('decompress ignores changes made to the stream after the call', async () => {
    const original = textBytes(200_000, 42);
    const stream = Buffer.from(b.compressSync(original, 5));
    const pending = b.decompress(stream);
    stream.fill(0);
    expect(await pending).toEqualBytes(original);
  });
});
