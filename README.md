# brotli-js

[![CI](https://github.com/kodespire/brotli-js/actions/workflows/ci.yml/badge.svg)](https://github.com/kodespire/brotli-js/actions/workflows/ci.yml)

Brotli compression for Node.js, Bun, Deno, browsers and edge runtimes, with one API everywhere.

- **The official library.** Compiled from [google/brotli](https://github.com/google/brotli) v1.2.0, pinned as a git submodule. A weekly job opens a PR when upstream releases.
- **Native where possible, WebAssembly everywhere else.** Node.js and Bun use a Node-API addon. Browsers, Deno and Workers use WebAssembly built from the same C code, and both produce the same bytes. If no prebuilt binary matches your platform, the package switches to WebAssembly on its own.
- **No install scripts.** Prebuilt binaries ship inside the package. `npm install` never downloads or compiles anything.
- **Never returns partial data.** Cut-off input, bytes after the end of the stream and output over your size limit all throw. They never return what was decoded so far.

Part of the [compression-js](https://github.com/kodespire/compression-js) family.

```sh
npm install @kodespire/brotli-js
```

## Usage

```js
import { compress, decompress } from '@kodespire/brotli-js';

const packed = await compress(data, { quality: 5 }); // or compress(data, 5)
const unpacked = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
```

`data` can be a `Uint8Array`, a Node `Buffer`, an `ArrayBuffer`, any typed array or `DataView`, or a string (encoded as UTF-8). Results are always `Uint8Array`.

### Choosing a quality

The default quality is **11**, the same as the `brotli` command-line tool and the brotli library. It gives the smallest output, but it is slow: well under 1 MB/s. Lower qualities trade size for speed. Here is what we measured on mixed source code and text (native addon, Apple M-series):

| Quality | Compress | Output vs. quality 11 |
| --- | --- | --- |
| 11 (default) | 0.7 MB/s | — |
| 9 | 22 MB/s | about 10% larger |
| 5 | 51 MB/s | about 20% larger |
| 1 | 200 MB/s | about 40% larger |

Decompression runs at a few hundred MB/s whatever the quality. Use 11 for files compressed once and served many times, such as static assets at build time. Use 4 to 6 for data compressed on the fly, such as HTTP responses. WebAssembly compresses at a third to half of the native speed.

### Streams

`createCompressStream()` and `createDecompressStream()` return standard [`TransformStream`](https://developer.mozilla.org/docs/Web/API/TransformStream)s, which work in every runtime:

```js
const response = await fetch(url);
const body = response.body.pipeThrough(createDecompressStream());
```

In Node.js, wrap them with `Duplex.fromWeb` to use them in a pipeline:

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCompressStream } from '@kodespire/brotli-js';

await pipeline(
  createReadStream('data.json'),
  Duplex.fromWeb(createCompressStream({ quality: 9 })),
  createWriteStream('data.json.br'),
);
```

### Synchronous calls

`compressSync` and `decompressSync` behave like their async versions.

- **Node.js and Bun:** they work right away.
- **Browsers, Deno and Workers:** the WebAssembly module loads asynchronously, so call `await init()` once first.

The async functions load the module on demand.

```js
import { init, compressSync } from '@kodespire/brotli-js';

await init();
const packed = compressSync('hello');
```

### Untrusted input

A few KB of brotli can expand to gigabytes: at quality 5, 1 GiB of zeros compresses to about 1.6 KB. Always pass `maxOutputSize` when decompressing data you don't control. Decoding stops as soon as the limit is crossed:

```js
try {
  await decompress(upload, { maxOutputSize: 10 * 1024 * 1024 });
} catch (error) {
  if (error.code === 'ERR_BROTLI_OUTPUT_LIMIT') rejectUpload();
}
```

## What counts as an error

A brotli stream has no magic number, no header recording its size and no checksum. So the decoder rules are defined here, and the tests check each of them on both backends:

- **Input that ends before the stream's final meta-block is `ERR_BROTLI_TRUNCATED`.** That is, the decoder ran out of input while still asking for more. Every proper prefix of a valid stream is rejected this way. That includes a cut right after a flush, where everything so far has been decoded but the stream has not ended. **Empty input** is also `ERR_BROTLI_TRUNCATED`, as with the `brotli` command-line tool. Compressing empty input gives a valid 1-byte stream, which decompresses back to empty.
- **Bytes after the end of the stream are an error** (`ERR_BROTLI_LIBRARY`, "extra input after the end of the stream"). A single trailing zero byte counts. **Concatenated brotli streams are rejected** too, as the `brotli` tool does by default. This is unlike zstd, where concatenated frames are valid. Decompression streams accept empty chunks after the end, but not data.
- **Corrupt input is `ERR_BROTLI_LIBRARY`**, and the message carries the decoder's error string, for example `brotli: _ERROR_FORMAT_PADDING_1`.

**Brotli cannot detect all corruption.** Without a checksum, some damaged streams are still valid brotli and decode to wrong bytes without an error. In our tests, about a fifth of single-byte corruptions decoded that way. If you need integrity, check a hash of the data separately, or use [zstd-js](https://github.com/kodespire/zstd-js), whose checksum is on by default.

## Large windows

Standard brotli ([RFC 7932](https://www.rfc-editor.org/rfc/rfc7932)) windows go up to 16 MiB (`lgwin: 24`). `largeWindow: true` turns on brotli's large-window extension, which allows `lgwin` up to 30 (1 GiB):

```js
const packed = await compress(data, { quality: 9, lgwin: 28, largeWindow: true });
const unpacked = await decompress(packed, { largeWindow: true });
```

- **The output is not standard brotli.** It is marked as large-window even when `lgwin` is 24 or less. Most decoders reject it: browsers, `node:zlib` unless `BROTLI_DECODER_PARAM_LARGE_WINDOW` is set, and this package without `largeWindow: true`. The `brotli` command-line tool accepts it. Never send it as `Content-Encoding: br`.
- **The encoder ignores the extension below quality 3**, so `largeWindow: true` with quality 0 to 2 throws a `RangeError` instead of quietly writing a standard stream.
- **`largeWindow: true` on decompress lets a few bytes of input ask for a window of up to 1 GiB.** Only enable it for input you trust, and set `maxOutputSize`. WebAssembly memory grows to fit and never shrinks.
- **On WebAssembly, quality 10 and 11 with `lgwin` 29 or 30 throw `ERR_BROTLI_OUT_OF_MEMORY`.** The encoder's match finder needs 4 to 8 GiB, more than WebAssembly can address. The native addon accepts these settings.

## API

| Function | Description |
| --- | --- |
| `compress(data, options?)` | Compresses into one brotli stream. Returns `Promise<Uint8Array>`. |
| `decompress(data, options?)` | Decompresses one brotli stream. Returns `Promise<Uint8Array>`. |
| `compressSync` / `decompressSync` | Synchronous versions (see above). |
| `createCompressStream(options?)` | `TransformStream` that compresses its input into one stream. |
| `createDecompressStream(options?)` | `TransformStream` that decompresses. Errors on cut-off, corrupt, trailing or oversized input. |
| `init(source?)` | Loads the backend. `source` can be a URL, `Response`, bytes or `WebAssembly.Module` for `brotli.wasm`. |
| `activeBackend()` | `'native'` or `'wasm'`. |
| `BROTLI_VERSION` | `'1.2.0'` |
| `MIN_QUALITY`, `MAX_QUALITY`, `DEFAULT_QUALITY` | `0`, `11`, `11` |
| `MIN_LGWIN`, `MAX_LGWIN`, `LARGE_MAX_LGWIN`, `DEFAULT_LGWIN` | `10`, `24`, `30`, `22` |

**Compress options**

| Option | Default | |
| --- | --- | --- |
| `quality` | `11` | `0` (fastest) to `11` (smallest). A number in place of the options object sets just the quality. |
| `lgwin` | `22` | Window size as a power of two: the window is `2 ** lgwin - 16` bytes. `10` to `24`, or up to `30` with `largeWindow`. 22 (4 MiB) is the brotli library default. The `brotli` tool uses 24 when reading standard input. |
| `mode` | `'generic'` | `'font'` tunes the encoder for WOFF 2.0 font data, from quality 4. `'text'` is accepted for compatibility with brotli and `node:zlib`. brotli 1.2.0 compresses it exactly like `'generic'`. |
| `largeWindow` | `false` | Use the large-window extension (see above). Needs quality 3 or higher. |
| `sizeHint` | `0` | Expected total input size in bytes (`0` = unknown). It helps a stream choose its strategy; one-shot calls already know the size. Only qualities 4 to 9 use it. Values above 2³⁰ count as 2³⁰. |

**Decompress options**

| Option | Default | |
| --- | --- | --- |
| `maxOutputSize` | `Infinity` | Throw `ERR_BROTLI_OUTPUT_LIMIT` rather than produce more bytes than this. |
| `largeWindow` | `false` | Accept large-window streams as well as standard ones. |

An unknown option name throws a `TypeError`. A typo like `{ level: 5 }` fails loudly, and the message suggests `quality`, instead of quietly compressing at quality 11.

**Errors** are `BrotliError` instances, each with a `code`:

| Code | Meaning |
| --- | --- |
| `ERR_BROTLI_TRUNCATED` | The input ended before the end of the stream, or was empty. |
| `ERR_BROTLI_OUTPUT_LIMIT` | The output would exceed `maxOutputSize`. |
| `ERR_BROTLI_LIBRARY` | brotli rejected the data (the message carries the decoder's error), or bytes followed the end of the stream. |
| `ERR_BROTLI_OUT_OF_MEMORY` | An allocation failed, or the settings need more memory than WebAssembly can address. |
| `ERR_BROTLI_NOT_INITIALIZED` | A sync function was called in a browser or Worker before `await init()`. |
| `ERR_BROTLI_INVALID_ARGUMENT` | As named. |

## Behaviour details

- **Native and WebAssembly output are identical**, byte for byte, for the same options. CI checks this on Linux, macOS and Windows.
- **The async functions use separate threads only on the native addon**, which runs them on Node's thread pool. The WebAssembly backend runs on the calling thread, so for large inputs in a browser, call it from a Web Worker.
- **Forcing WebAssembly:** set `BROTLI_JS_BACKEND=wasm` in Node.js, or import `@kodespire/brotli-js/wasm` in any runtime.
- **Not included:** custom dictionaries, and `node:zlib`'s flush modes. Streams emit compressed output as the encoder produces it and finish the stream when the writable side closes.

## Runtimes

| Runtime | Backend | Tested in CI |
| --- | --- | --- |
| Node.js 22.12+, 24, 26 | native | Linux x64/arm64, macOS, Windows |
| Bun | native | Linux |
| Deno 2 | WebAssembly | Linux |
| Chromium, Firefox, WebKit | WebAssembly | Playwright, through Vite |
| Cloudflare Workers (`workerd` condition) | WebAssembly | `wrangler dev` (workerd) |

Prebuilt native binaries cover:
- macOS arm64 and x64
- Linux x64 and arm64 (glibc 2.28+ and musl)
- Windows x64 and arm64

Bundlers that understand `new URL('./brotli.wasm', import.meta.url)`, such as Vite, webpack 5 and Parcel, pick up the WebAssembly file automatically. For anything else, serve `@kodespire/brotli-js/brotli.wasm` yourself and pass its URL to `init()`.

## Development

```sh
git clone --recursive https://github.com/kodespire/brotli-js
npm install
npm run build:native   # Node-API addon (needs Python 3 and a C/C++ compiler)
npm run build:wasm     # brotli.wasm (needs Emscripten; see .emsdk-version)
npm run build:ts       # dist/
node scripts/build-brotli-cli.mjs   # official brotli CLI, built with plain cc, for the interop tests
npm test
BROWSERS=chromium npx vitest run -c vitest.browser.config.ts
```

All compression logic is in `csrc/bjs.c`, which both builds share. `csrc/addon.cc` (Node-API) and `src/wasm-backend.ts` (WebAssembly) only move bytes in and out. The tests run every case against both backends. They also check:
- decoding of output from the official CLI, and the CLI decoding ours
- two-way round trips with `node:zlib`, including large windows
- input cut at every byte offset, including right after a flush
- streaming split at random points

## License

MIT. The bundled brotli library is also MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
