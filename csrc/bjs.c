#include "bjs.h"

#include <stdlib.h>

#include <brotli/decode.h>
#include <brotli/encode.h>

/* Builds must define BROTLI_ENCODER_CLEANUP_ON_OOM: brotli's default is to
 * call exit() when the encoder cannot allocate, which would end the host
 * process (or trap the WebAssembly instance) instead of returning an error. */
#if !defined(BROTLI_ENCODER_CLEANUP_ON_OOM)
#error "compile with -DBROTLI_ENCODER_CLEANUP_ON_OOM"
#endif

/* Upper bound for the first output allocation. Compressed sizes say little
 * about decompressed sizes, so we never allocate more than this up front;
 * the buffer grows as real output arrives. */
#define BJS_INITIAL_CAP_LIMIT ((size_t)64 << 20)
/* Minimum growth step for output buffers. */
#define BJS_OUT_CHUNK ((size_t)64 << 10)
/* brotli caps its own size estimate at 2^30; larger hints behave the same. */
#define BJS_SIZE_HINT_MAX ((size_t)1 << 30)

static const char bjs_extra_input[] = "extra input after the end of the stream";

/* Pointer handed to brotli for empty input, so it never sees NULL. */
static const uint8_t bjs_empty = 0;

static int bjs_fail(int code, const char* message, const char** detail) {
  if (detail) *detail = message;
  return code;
}

void bjs_buf_free(bjs_buf* buf) {
  if (!buf) return;
  free(buf->data);
  buf->data = NULL;
  buf->size = 0;
  buf->cap = 0;
}

/* Ensures at least min_free bytes of spare capacity, growing by ~1.5x. */
static int bjs_buf_reserve(bjs_buf* buf, size_t min_free, const char** detail) {
  size_t need, cap;
  uint8_t* data;
  if (buf->cap - buf->size >= min_free) return BJS_OK;
  if (min_free > SIZE_MAX - buf->size) return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  need = buf->size + min_free;
  cap = buf->cap + buf->cap / 2;
  if (cap < buf->cap || cap < need) cap = need;
  data = (uint8_t*)realloc(buf->data, cap);
  if (!data && cap != need) {
    cap = need;
    data = (uint8_t*)realloc(buf->data, cap);
  }
  if (!data) return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  buf->data = data;
  buf->cap = cap;
  return BJS_OK;
}

/* ---- streaming compression --------------------------------------------- */

/* The encoder reports failure as a bare BROTLI_FALSE. Its allocations go
 * through these functions so an allocation failure can be told apart. */
typedef struct bjs_mem {
  int failed;
} bjs_mem;

static void* bjs_alloc(void* opaque, size_t size) {
  void* p = malloc(size);
  if (!p) ((bjs_mem*)opaque)->failed = 1;
  return p;
}

static void bjs_free(void* opaque, void* p) {
  (void)opaque;
  free(p);
}

struct bjs_cstream {
  BrotliEncoderState* enc;
  bjs_mem mem;
};

static int bjs_check_params(int quality, int lgwin, int mode, int large_window,
                            const char** detail) {
  int max_lgwin = large_window ? BROTLI_LARGE_MAX_WINDOW_BITS : BROTLI_MAX_WINDOW_BITS;
  if (quality < BROTLI_MIN_QUALITY || quality > BROTLI_MAX_QUALITY) {
    return bjs_fail(BJS_ERR_ARG, "quality out of range", detail);
  }
  if (lgwin < BROTLI_MIN_WINDOW_BITS || lgwin > max_lgwin) {
    return bjs_fail(BJS_ERR_ARG, "lgwin out of range", detail);
  }
  if (mode != BROTLI_MODE_GENERIC && mode != BROTLI_MODE_TEXT && mode != BROTLI_MODE_FONT) {
    return bjs_fail(BJS_ERR_ARG, "invalid mode", detail);
  }
  /* Below quality 3 the encoder silently drops the large-window flag. */
  if (large_window && quality < 3) {
    return bjs_fail(BJS_ERR_ARG, "largeWindow needs quality 3 or higher", detail);
  }
  /* At quality 10 and 11 brotli sizes its match finder as 8 << lgwin bytes.
   * With a 32-bit size_t (WebAssembly) that wraps to almost nothing for lgwin
   * 29 and 30, and the encoder then writes past the allocation. The 4 or
   * 8 GiB it needs cannot exist in a 32-bit address space anyway. */
  if (sizeof(size_t) < 8 && quality >= 10 && lgwin >= 29) {
    return bjs_fail(BJS_ERR_NOMEM,
                    "quality 10 and 11 with lgwin 29 or 30 need more memory than WebAssembly can address",
                    detail);
  }
  return BJS_OK;
}

int bjs_cstream_create(int quality, int lgwin, int mode, int large_window,
                       size_t size_hint, bjs_cstream** stream,
                       const char** detail) {
  bjs_cstream* s;
  BrotliEncoderState* enc;
  int rc;
  *stream = NULL;
  rc = bjs_check_params(quality, lgwin, mode, large_window, detail);
  if (rc != BJS_OK) return rc;
  s = (bjs_cstream*)calloc(1, sizeof(*s));
  if (!s) return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  enc = BrotliEncoderCreateInstance(bjs_alloc, bjs_free, &s->mem);
  if (!enc) {
    free(s);
    return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  }
  s->enc = enc;
  if (size_hint > BJS_SIZE_HINT_MAX) size_hint = BJS_SIZE_HINT_MAX;
  /* SetParameter fails only for unknown parameters or a started encoder. */
  if (!BrotliEncoderSetParameter(enc, BROTLI_PARAM_QUALITY, (uint32_t)quality) ||
      !BrotliEncoderSetParameter(enc, BROTLI_PARAM_LGWIN, (uint32_t)lgwin) ||
      !BrotliEncoderSetParameter(enc, BROTLI_PARAM_MODE, (uint32_t)mode) ||
      !BrotliEncoderSetParameter(enc, BROTLI_PARAM_LARGE_WINDOW, large_window ? 1u : 0u) ||
      !BrotliEncoderSetParameter(enc, BROTLI_PARAM_SIZE_HINT, (uint32_t)size_hint)) {
    bjs_cstream_free(s);
    return bjs_fail(BJS_ERR_LIBRARY, "brotli encoder rejected a parameter", detail);
  }
  *stream = s;
  return BJS_OK;
}

int bjs_cstream_push(bjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, bjs_buf* out, const char** detail) {
  BrotliEncoderOperation op;
  size_t avail_in = src_size;
  const uint8_t* next_in = src_size ? src : &bjs_empty;
  int rc;

  if (!stream || !stream->enc) return bjs_fail(BJS_ERR_ARG, "stream is closed", detail);
  switch (mode) {
    case BJS_MODE_CONTINUE: op = BROTLI_OPERATION_PROCESS; break;
    case BJS_MODE_FLUSH: op = BROTLI_OPERATION_FLUSH; break;
    case BJS_MODE_END: op = BROTLI_OPERATION_FINISH; break;
    default: return bjs_fail(BJS_ERR_ARG, "invalid stream mode", detail);
  }
  if (BrotliEncoderIsFinished(stream->enc)) {
    return bjs_fail(BJS_ERR_ARG, "stream is already finished", detail);
  }

  for (;;) {
    size_t avail_out, in_before = avail_in;
    uint8_t* next_out;
    uint8_t* start;
    if (out->size == out->cap) {
      rc = bjs_buf_reserve(out, BJS_OUT_CHUNK, detail);
      if (rc != BJS_OK) return rc;
    }
    start = next_out = out->data + out->size;
    avail_out = out->cap - out->size;
    if (!BrotliEncoderCompressStream(stream->enc, op, &avail_in, &next_in,
                                     &avail_out, &next_out, NULL)) {
      /* The encoder is unusable after a failure. */
      BrotliEncoderDestroyInstance(stream->enc);
      stream->enc = NULL;
      return stream->mem.failed ? bjs_fail(BJS_ERR_NOMEM, "out of memory", detail)
                                : bjs_fail(BJS_ERR_LIBRARY, "brotli encoder failed", detail);
    }
    out->size += (size_t)(next_out - start);
    /* PROCESS: done once all input is taken and no output is waiting.
     * FLUSH: the same, as brotli documents. FINISH: once the stream is complete. */
    if (avail_in == 0 && !BrotliEncoderHasMoreOutput(stream->enc) &&
        (op != BROTLI_OPERATION_FINISH || BrotliEncoderIsFinished(stream->enc))) {
      break;
    }
    if (next_out == start && avail_in == in_before && avail_out > 0) {
      return bjs_fail(BJS_ERR_LIBRARY, "brotli encoder made no progress", detail);
    }
  }
  return BJS_OK;
}

void bjs_cstream_free(bjs_cstream* stream) {
  if (!stream) return;
  if (stream->enc) BrotliEncoderDestroyInstance(stream->enc);
  free(stream);
}

int bjs_compress(const uint8_t* src, size_t src_size, int quality, int lgwin,
                 int mode, int large_window, size_t size_hint, bjs_buf* out,
                 const char** detail) {
  bjs_cstream* s;
  size_t bound;
  int rc;

  rc = bjs_cstream_create(quality, lgwin, mode, large_window, size_hint, &s, detail);
  if (rc != BJS_OK) return rc;
  /* The bound is exact enough to avoid regrowing (it holds for quality >= 2;
   * below that the loop grows the buffer if needed). Capped, so compressible
   * input does not reserve its full size. */
  bound = BrotliEncoderMaxCompressedSize(src_size);
  if (bound == 0 || bound > BJS_INITIAL_CAP_LIMIT) bound = BJS_INITIAL_CAP_LIMIT;
  rc = bjs_buf_reserve(out, bound, detail);
  if (rc != BJS_OK) {
    /* Not fatal: start small and let real output drive growth. */
    if (detail) *detail = NULL;
  }
  rc = bjs_cstream_push(s, src, src_size, BJS_MODE_END, out, detail);
  bjs_cstream_free(s);
  return rc;
}

/* ---- streaming decompression ------------------------------------------- */

struct bjs_dstream {
  BrotliDecoderState* dec;
  size_t max_output;
  size_t total_out;
  int finished; /* the decoder reached the end of the stream */
  int seen_input;
};

static int bjs_decoder_fail(BrotliDecoderState* dec, const char** detail) {
  BrotliDecoderErrorCode code = BrotliDecoderGetErrorCode(dec);
  if (code <= BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES &&
      code >= BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES) {
    return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  }
  return bjs_fail(BJS_ERR_LIBRARY, BrotliDecoderErrorString(code), detail);
}

int bjs_dstream_create(int large_window, size_t max_output,
                       bjs_dstream** stream, const char** detail) {
  bjs_dstream* s;
  *stream = NULL;
  s = (bjs_dstream*)calloc(1, sizeof(*s));
  if (!s) return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  s->dec = BrotliDecoderCreateInstance(NULL, NULL, NULL);
  if (!s->dec) {
    free(s);
    return bjs_fail(BJS_ERR_NOMEM, "out of memory", detail);
  }
  s->max_output = max_output;
  if (!BrotliDecoderSetParameter(s->dec, BROTLI_DECODER_PARAM_LARGE_WINDOW,
                                 large_window ? 1u : 0u)) {
    bjs_dstream_free(s);
    return bjs_fail(BJS_ERR_LIBRARY, "brotli decoder rejected a parameter", detail);
  }
  *stream = s;
  return BJS_OK;
}

int bjs_dstream_push(bjs_dstream* stream, const uint8_t* src, size_t src_size,
                     bjs_buf* out, const char** detail) {
  size_t avail_in = src_size;
  const uint8_t* next_in = src_size ? src : &bjs_empty;
  int rc;

  if (!stream || !stream->dec) return bjs_fail(BJS_ERR_ARG, "stream is closed", detail);
  if (src_size) stream->seen_input = 1;
  if (stream->finished) {
    return src_size ? bjs_fail(BJS_ERR_LIBRARY, bjs_extra_input, detail) : BJS_OK;
  }

  for (;;) {
    BrotliDecoderResult r;
    size_t avail_out, allowed, produced, in_before = avail_in;
    uint8_t* next_out;
    uint8_t* start;

    if (out->size == out->cap) {
      rc = bjs_buf_reserve(out, BJS_OUT_CHUNK, detail);
      if (rc != BJS_OK) return rc;
    }
    /* Never let brotli write more than one byte past the limit: that byte
     * is how we detect "too big" without decoding the rest. */
    allowed = stream->max_output - stream->total_out;
    if (allowed < SIZE_MAX) allowed += 1;

    start = next_out = out->data + out->size;
    avail_out = out->cap - out->size;
    if (avail_out > allowed) avail_out = allowed;

    r = BrotliDecoderDecompressStream(stream->dec, &avail_in, &next_in,
                                      &avail_out, &next_out, NULL);
    produced = (size_t)(next_out - start);
    out->size += produced;
    stream->total_out += produced;
    if (stream->total_out > stream->max_output) {
      return bjs_fail(BJS_ERR_OUTPUT_LIMIT, "decompressed size exceeds maxOutputSize", detail);
    }

    switch (r) {
      case BROTLI_DECODER_RESULT_SUCCESS:
        /* The decoder stops at the end of the stream and hands back the
         * bytes it did not use. Any such byte is an error. */
        stream->finished = 1;
        return avail_in ? bjs_fail(BJS_ERR_LIBRARY, bjs_extra_input, detail) : BJS_OK;
      case BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT:
        /* All input is consumed, but the decoder can still hold decoded
         * bytes it had no room to write. Drain them before returning. */
        if (!BrotliDecoderHasMoreOutput(stream->dec)) return BJS_OK;
        break;
      case BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT:
        break;
      default:
        return bjs_decoder_fail(stream->dec, detail);
    }
    if (produced == 0 && avail_in == in_before && out->size < out->cap) {
      return bjs_fail(BJS_ERR_LIBRARY, "brotli decoder made no progress", detail);
    }
  }
}

int bjs_dstream_finish(bjs_dstream* stream, const char** detail) {
  if (!stream || !stream->dec) return bjs_fail(BJS_ERR_ARG, "stream is closed", detail);
  if (!stream->finished) {
    return bjs_fail(BJS_ERR_TRUNCATED,
                    stream->seen_input ? "brotli input ended before the end of the stream"
                                       : "brotli input is empty",
                    detail);
  }
  return BJS_OK;
}

void bjs_dstream_free(bjs_dstream* stream) {
  if (!stream) return;
  if (stream->dec) BrotliDecoderDestroyInstance(stream->dec);
  free(stream);
}

int bjs_decompress(const uint8_t* src, size_t src_size, int large_window,
                   size_t max_output, bjs_buf* out, const char** detail) {
  bjs_dstream* s;
  size_t hint;
  int rc;

  rc = bjs_dstream_create(large_window, max_output, &s, detail);
  if (rc != BJS_OK) return rc;

  /* Brotli records no decompressed size, so guess from the input size.
   * Capped, because ratios on untrusted input can be enormous. */
  hint = src_size > BJS_INITIAL_CAP_LIMIT / 4 ? BJS_INITIAL_CAP_LIMIT : src_size * 4;
  if (hint < BJS_OUT_CHUNK) hint = BJS_OUT_CHUNK;
  if (max_output < SIZE_MAX && hint > max_output + 1) hint = max_output + 1;
  if (bjs_buf_reserve(out, hint, detail) != BJS_OK) {
    /* Not fatal: start small and let real output drive growth. */
    if (detail) *detail = NULL;
  }

  rc = bjs_dstream_push(s, src, src_size, out, detail);
  if (rc == BJS_OK) rc = bjs_dstream_finish(s, detail);
  bjs_dstream_free(s);
  return rc;
}

static char* bjs_put_uint(char* p, unsigned v) {
  char digits[10];
  int n = 0;
  do {
    digits[n++] = (char)('0' + v % 10);
    v /= 10;
  } while (v);
  while (n) *p++ = digits[--n];
  return p;
}

const char* bjs_version(void) {
  /* Built from the decoder's version (the encoder is the same library), by
   * hand: printf would add several KB to the WebAssembly module. */
  static char version[40];
  if (!version[0]) {
    uint32_t v = BrotliDecoderVersion();
    char* p = bjs_put_uint(version, (unsigned)(v >> 24));
    *p++ = '.';
    p = bjs_put_uint(p, (unsigned)((v >> 12) & 0xfff));
    *p++ = '.';
    p = bjs_put_uint(p, (unsigned)(v & 0xfff));
    *p = 0;
  }
  return version;
}
