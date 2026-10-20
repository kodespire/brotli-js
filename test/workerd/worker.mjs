// Cloudflare Workers smoke test: resolves the package through the "workerd"
// export condition, which imports brotli.wasm statically. Run with run.mjs.
import * as b from '@kodespire/brotli-js';

export default {
  async fetch() {
    const result = {};
    try {
      const src = new TextEncoder().encode('workerd '.repeat(20_000));
      const stream = await b.compress(src, 9);
      result.roundTrip = (await b.decompress(stream)).length === src.length;
      await b.init();
      result.sync = b.decompressSync(b.compressSync('abc')).length === 3;
      try {
        await b.decompress(stream.subarray(0, stream.length - 1));
        result.truncated = 'no error';
      } catch (error) {
        result.truncated = error.code;
      }
      const body = new Response(src).body.pipeThrough(b.createCompressStream(5)).pipeThrough(b.createDecompressStream());
      result.stream = (await new Response(body).arrayBuffer()).byteLength === src.length;
      result.backend = b.activeBackend();
      result.version = b.BROTLI_VERSION;
    } catch (error) {
      result.error = String(error?.stack ?? error);
    }
    return Response.json(result);
  },
};
