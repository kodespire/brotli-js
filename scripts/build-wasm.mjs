// Builds out/wasm/brotli.wasm from the same C sources as the native addon.
// Requires Emscripten (emcc) on PATH: https://emscripten.org/docs/getting_started/
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sources } = require('./brotli-sources.cjs');

const exported = [
  'malloc',
  'free',
  'bjs_buf_free',
  'bjs_compress',
  'bjs_decompress',
  'bjs_cstream_create',
  'bjs_cstream_push',
  'bjs_cstream_free',
  'bjs_dstream_create',
  'bjs_dstream_push',
  'bjs_dstream_finish',
  'bjs_dstream_free',
  'bjs_version',
].map((name) => `_${name}`);

const out = join(root, 'out', 'wasm', 'brotli.wasm');
mkdirSync(dirname(out), { recursive: true });

const args = [
  '-O3',
  '-flto',
  '-DNDEBUG',
  // brotli's default is to exit() when the encoder cannot allocate.
  '-DBROTLI_ENCODER_CLEANUP_ON_OOM',
  '-Ideps/brotli/c/include',
  'csrc/bjs.c',
  ...sources(),
  '--no-entry',
  // A plain .wasm with no Emscripten JS glue; src/wasm-backend.ts is the loader.
  '-sSTANDALONE_WASM=1',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=2MB',
  '-sMAXIMUM_MEMORY=4GB',
  '-sSTACK_SIZE=256KB',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-o',
  out,
];

try {
  execFileSync('emcc', args, { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('emcc not found. Install Emscripten and run `source <emsdk>/emsdk_env.sh` first.');
    process.exit(1);
  }
  throw error;
}
console.log(`built ${out} (${statSync(out).size} bytes)`);
