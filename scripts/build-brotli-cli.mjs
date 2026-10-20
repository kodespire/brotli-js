// Builds the official brotli command-line tool from deps/brotli into out/brotli-cli/brotli,
// for generating fixtures and for interop tests. Needs a C compiler (cc, or $CC); no cmake.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sources } = require('./brotli-sources.cjs');

export const cliPath = join(root, 'out', 'brotli-cli', process.platform === 'win32' ? 'brotli.exe' : 'brotli');

export function buildCli() {
  if (existsSync(cliPath)) return cliPath;
  mkdirSync(dirname(cliPath), { recursive: true });
  // The library's own defaults: this is the reference tool, not our build of it.
  const args = ['-O2', '-DNDEBUG', '-Ideps/brotli/c/include', ...sources(), 'deps/brotli/c/tools/brotli.c', '-lm', '-o', cliPath];
  execFileSync(process.env['CC'] ?? 'cc', args, { cwd: root, stdio: 'inherit' });
  return cliPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(buildCli());
}
