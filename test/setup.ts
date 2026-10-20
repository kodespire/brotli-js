// toEqualBytes: byte-for-byte comparison of binary data. Vitest's toEqual walks
// typed arrays element by element, which takes seconds for a few MB.
import { expect } from 'vitest';

function asBuffer(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

expect.extend({
  toEqualBytes(received: unknown, expected: Uint8Array) {
    const a = asBuffer(received);
    const b = asBuffer(expected);
    if (!a || !b) return { pass: false, message: () => 'toEqualBytes compares two Uint8Arrays' };
    const pass = a.equals(b);
    let first = 0;
    while (!pass && first < Math.min(a.length, b.length) && a[first] === b[first]) first++;
    return {
      pass,
      message: () =>
        pass
          ? `expected bytes to differ (${a.length} bytes)`
          : `expected ${b.length} bytes, received ${a.length}; first difference at offset ${first}`,
    };
  },
});

declare module 'vitest' {
  interface Matchers<T = unknown> {
    toEqualBytes(expected: Uint8Array): T;
  }
}
