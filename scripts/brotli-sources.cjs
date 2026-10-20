// Prints the brotli C sources that both builds compile, one per line: every
// .c file in deps/brotli/c/{common,dec,enc} (the MIT-licensed library; tools,
// fuzzers and bindings are left out).
// Used by binding.gyp (via <!@(...)), scripts/build-wasm.mjs and scripts/build-brotli-cli.mjs.
//
// Object files are named after the source basename, so two sources with the
// same basename collide in MSBuild. Each such file is compiled through a
// wrapper in csrc/ instead; a new collision (after a brotli update) fails here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lib = path.join('deps', 'brotli', 'c');

const WRAPPERS = {
  'deps/brotli/c/enc/static_init.c': 'csrc/brotli_enc_static_init.c',
  'deps/brotli/c/dec/static_init.c': 'csrc/brotli_dec_static_init.c',
};

function sources() {
  const out = [];
  for (const dir of ['common', 'dec', 'enc']) {
    const abs = path.join(root, lib, dir);
    if (!fs.existsSync(abs)) {
      throw new Error(`${abs} is missing. Run: git submodule update --init`);
    }
    for (const name of fs.readdirSync(abs).sort()) {
      if (!name.endsWith('.c')) continue;
      const file = path.posix.join('deps/brotli/c', dir, name);
      out.push(WRAPPERS[file] ?? file);
    }
  }
  const seen = new Map();
  for (const file of out) {
    const base = path.posix.basename(file);
    if (seen.has(base)) {
      throw new Error(`${seen.get(base)} and ${file} share a basename; add a wrapper in csrc/ (see WRAPPERS)`);
    }
    seen.set(base, file);
  }
  for (const [original, wrapper] of Object.entries(WRAPPERS)) {
    if (!fs.existsSync(path.join(root, original))) throw new Error(`${original} no longer exists; remove its wrapper ${wrapper}`);
  }
  return out;
}

module.exports = { sources };

if (require.main === module) {
  process.stdout.write(sources().join('\n') + '\n');
}
