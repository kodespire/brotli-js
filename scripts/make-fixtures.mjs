// Regenerates test/fixtures with the official brotli CLI built from deps/brotli.
// The fixtures are committed; rerun this only when changing them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCli } from './build-brotli-cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures');
const brotli = buildCli();
mkdirSync(out, { recursive: true });

// Deterministic, compressible text.
function corpus(seed, words) {
  const vocab = 'the quick brown fox jumps over lazy dog brotli stream meta block window literal insert copy distance context huffman prefix code dictionary transform'.split(' ');
  let x = seed >>> 0;
  const parts = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(vocab[x % vocab.length]);
    if (x % 17 === 0) parts.push(`${x % 100000}\n`);
  }
  return Buffer.from(parts.join(' '));
}

const run = (args, input) => execFileSync(brotli, args, { input, maxBuffer: 1 << 30 });
const write = (name, data) => writeFileSync(join(out, name), data);

const text = corpus(1, 30000);
write('corpus.txt', text);
// From stdin the CLI does not know the size: it uses lgwin 24 and no size hint.
write('corpus.stdin.br', run(['-c'], text));
for (const q of [0, 1, 5, 9]) write(`corpus.q${q}.br`, run(['-c', '-q', String(q)], text));
write('corpus.w10.br', run(['-c', '-w', '10'], text));
// Large-window extension (not RFC 7932): needs largeWindow on the decoder.
write('corpus.large26.br', run(['-c', '-q', '9', '--large_window=26'], text));
// A metadata block (the CLI's --comment) before the data, which decoders skip.
write('corpus.comment.br', run(['-c', '-q', '5', `--comment=${Buffer.from('fixture comment').toString('base64')}`], text));

// Same input from a file: the CLI shrinks lgwin to fit and passes the size as a hint.
const tmp = mkdtempSync(join(tmpdir(), 'brotli-js-fixtures-'));
try {
  const file = join(tmp, 'corpus.txt');
  writeFileSync(file, text);
  write('corpus.file.br', run(['-c', file]));

  // A valid stream holding zero bytes (unlike zero bytes of input, which is not a stream).
  const empty = join(tmp, 'empty');
  writeFileSync(empty, '');
  write('empty.br', run(['-c', empty]));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`fixtures written to ${out} with ${run(['--version']).toString().trim()}`);
