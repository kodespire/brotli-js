import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as constants from '../src/version.js';

const c = join(import.meta.dirname, '..', 'deps', 'brotli', 'c');
const versionHeader = readFileSync(join(c, 'common', 'version.h'), 'utf8');
const encodeHeader = readFileSync(join(c, 'include', 'brotli', 'encode.h'), 'utf8');
const define = (header: string, name: string) => Number(new RegExp(`#define ${name}\\s+(\\d+)`).exec(header)![1]);

describe('version constants', () => {
  it('BROTLI_VERSION matches deps/brotli/c/common/version.h', () => {
    const v = (name: string) => define(versionHeader, `BROTLI_VERSION_${name}`);
    expect(constants.BROTLI_VERSION).toBe(`${v('MAJOR')}.${v('MINOR')}.${v('PATCH')}`);
  });

  it('quality and window constants match brotli/encode.h', () => {
    expect(constants.MIN_QUALITY).toBe(define(encodeHeader, 'BROTLI_MIN_QUALITY'));
    expect(constants.MAX_QUALITY).toBe(define(encodeHeader, 'BROTLI_MAX_QUALITY'));
    expect(constants.DEFAULT_QUALITY).toBe(define(encodeHeader, 'BROTLI_DEFAULT_QUALITY'));
    expect(constants.MIN_LGWIN).toBe(define(encodeHeader, 'BROTLI_MIN_WINDOW_BITS'));
    expect(constants.MAX_LGWIN).toBe(define(encodeHeader, 'BROTLI_MAX_WINDOW_BITS'));
    expect(constants.LARGE_MAX_LGWIN).toBe(define(encodeHeader, 'BROTLI_LARGE_MAX_WINDOW_BITS'));
    expect(constants.DEFAULT_LGWIN).toBe(define(encodeHeader, 'BROTLI_DEFAULT_WINDOW'));
  });

  it('the compiled library reports the same version (native addon)', () => {
    const require = createRequire(import.meta.url);
    const addon = require('node-gyp-build')(join(import.meta.dirname, '..'));
    expect(addon.version).toBe(constants.BROTLI_VERSION);
  });
});
