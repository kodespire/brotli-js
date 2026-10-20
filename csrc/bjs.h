/*
 * bjs: the C layer shared by the Node-API addon and the WebAssembly build.
 *
 * Every compress/decompress loop lives here, once. Both bindings are thin
 * wrappers that move bytes in and out, so a fix or a test here covers both.
 *
 * Conventions:
 *   - Functions return BJS_OK (0) or a BJS_ERR_* code.
 *   - On error, *detail (when non-NULL) points to a static, NUL-terminated
 *     message. It is never freed and is safe to read from any thread.
 *   - Output is appended to a caller-owned bjs_buf, which the caller frees
 *     with bjs_buf_free (also on error).
 *
 * Brotli streams have no magic number, frame header or checksum, so the
 * decoder rules are defined here:
 *   - Input that ends before the stream's final meta-block (the decoder still
 *     wants more input), including empty input, is BJS_ERR_TRUNCATED.
 *   - Any byte after the end of the stream is BJS_ERR_LIBRARY.
 *   - Input the decoder rejects is BJS_ERR_LIBRARY with the decoder's error
 *     string as detail (allocation failures are BJS_ERR_NOMEM).
 */
#ifndef BJS_H
#define BJS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  BJS_OK = 0,
  BJS_ERR_LIBRARY = 1,      /* brotli rejected the data; detail is the decoder's error */
  BJS_ERR_TRUNCATED = 2,    /* input ended before the end of the stream (or was empty) */
  BJS_ERR_OUTPUT_LIMIT = 3, /* decompressed size would exceed max_output */
  BJS_ERR_NOMEM = 4,        /* allocation failed */
  BJS_ERR_ARG = 5           /* invalid argument */
};

enum { BJS_MODE_CONTINUE = 0, BJS_MODE_FLUSH = 1, BJS_MODE_END = 2 };

typedef struct bjs_buf {
  uint8_t* data;
  size_t size;
  size_t cap;
} bjs_buf;

void bjs_buf_free(bjs_buf* buf);

/*
 * Encoder settings, shared by bjs_compress and bjs_cstream_create:
 *   quality       0..11
 *   lgwin         10..24, or 10..30 with large_window
 *   mode          BROTLI_MODE_GENERIC (0), BROTLI_MODE_TEXT (1) or BROTLI_MODE_FONT (2)
 *   large_window  0 or 1; needs quality >= 3, where the encoder honours it
 *   size_hint     expected total input size, 0 = unknown; capped at 2^30
 * Out-of-range values fail with BJS_ERR_ARG rather than being clamped.
 */

/* One-shot compression of src into a single brotli stream. */
int bjs_compress(const uint8_t* src, size_t src_size, int quality, int lgwin,
                 int mode, int large_window, size_t size_hint, bjs_buf* out,
                 const char** detail);

/*
 * One-shot decompression of one brotli stream. Fails unless src holds exactly
 * one complete stream. max_output = SIZE_MAX means no limit.
 */
int bjs_decompress(const uint8_t* src, size_t src_size, int large_window,
                   size_t max_output, bjs_buf* out, const char** detail);

typedef struct bjs_cstream bjs_cstream;
typedef struct bjs_dstream bjs_dstream;

int bjs_cstream_create(int quality, int lgwin, int mode, int large_window,
                       size_t size_hint, bjs_cstream** stream,
                       const char** detail);
/* mode: BJS_MODE_CONTINUE, BJS_MODE_FLUSH (emit everything so far) or BJS_MODE_END. */
int bjs_cstream_push(bjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, bjs_buf* out, const char** detail);
void bjs_cstream_free(bjs_cstream* stream);

int bjs_dstream_create(int large_window, size_t max_output,
                       bjs_dstream** stream, const char** detail);
/* Decodes all of src. Returns only once every byte decodable so far is in out. */
int bjs_dstream_push(bjs_dstream* stream, const uint8_t* src, size_t src_size,
                     bjs_buf* out, const char** detail);
/* Call at end of input: fails with BJS_ERR_TRUNCATED if the stream is unfinished. */
int bjs_dstream_finish(bjs_dstream* stream, const char** detail);
void bjs_dstream_free(bjs_dstream* stream);

/* "major.minor.patch" of the compiled library. */
const char* bjs_version(void);

#ifdef __cplusplus
}
#endif

#endif /* BJS_H */
