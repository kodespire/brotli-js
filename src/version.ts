// Must match deps/brotli (checked by test/version.test.ts).
/** Version of the bundled brotli library, the same for the native and WebAssembly builds. */
export const BROTLI_VERSION = '1.2.1';
/** Fastest (lowest-ratio) quality. */
export const MIN_QUALITY = 0;
/** Highest-ratio (slowest) quality. */
export const MAX_QUALITY = 11;
/** Quality used when none is given: the brotli CLI and library default. */
export const DEFAULT_QUALITY = 11;
/** Smallest `lgwin`. */
export const MIN_LGWIN = 10;
/** Largest standard `lgwin` (16 MiB window). */
export const MAX_LGWIN = 24;
/** Largest `lgwin` with `largeWindow: true` (1 GiB window). */
export const LARGE_MAX_LGWIN = 30;
/** `lgwin` used when none is given: the brotli library default (4 MiB window). */
export const DEFAULT_LGWIN = 22;
