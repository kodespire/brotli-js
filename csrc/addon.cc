// Node-API binding. Moves bytes between JavaScript and the bjs C layer; all
// compression logic lives in bjs.c.
//
// Errors are thrown (or rejected) as Error objects carrying a numeric
// `bjsCode` property; the TypeScript layer turns them into BrotliError.

#include <napi.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "bjs.h"

namespace {

Napi::Error MakeError(Napi::Env env, int code, const char* detail) {
  Napi::Error error = Napi::Error::New(env, detail ? detail : "brotli error");
  error.Value().Set("bjsCode", Napi::Number::New(env, code));
  return error;
}

// Hands a bjs_buf to JavaScript without copying when the runtime allows
// external buffers, and copies otherwise (e.g. Electron's V8 sandbox).
// Leaves `buf` empty either way.
Napi::Buffer<uint8_t> TakeBuffer(Napi::Env env, bjs_buf* buf) {
  if (buf->size == 0) {
    bjs_buf_free(buf);
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  if (buf->cap - buf->size > 4096) {
    void* shrunk = realloc(buf->data, buf->size);
    if (shrunk) {
      buf->data = static_cast<uint8_t*>(shrunk);
      buf->cap = buf->size;
    }
  }
  uint8_t* data = buf->data;
  size_t size = buf->size;
  buf->data = nullptr;
  buf->size = 0;
  buf->cap = 0;
  return Napi::Buffer<uint8_t>::NewOrCopy(env, data, size,
                                          [](Napi::Env, uint8_t* p) { free(p); });
}

Napi::Uint8Array BytesArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  Napi::Value v = info[index];
  if (!v.IsTypedArray() || v.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a Uint8Array");
  }
  return v.As<Napi::Uint8Array>();
}

int32_t IntArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  return info[index].As<Napi::Number>().Int32Value();
}

bool BoolArg(const Napi::CallbackInfo& info, size_t index) {
  return info[index].ToBoolean().Value();
}

// Number -> size_t. Infinity (and anything >= SIZE_MAX) means SIZE_MAX: no limit
// for maxOutputSize; size hints are capped by the C layer.
size_t LimitArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  double d = info[index].As<Napi::Number>().DoubleValue();
  if (std::isnan(d) || d < 0) {
    throw Napi::RangeError::New(info.Env(), std::string(name) + " must be a non-negative number");
  }
  if (std::isinf(d) || d >= static_cast<double>(SIZE_MAX)) return SIZE_MAX;
  return static_cast<size_t>(d);
}

const uint8_t* DataOrNull(const std::vector<uint8_t>& v) {
  return v.empty() ? nullptr : v.data();
}

// ---- async one-shot ------------------------------------------------------

class BufferWorker : public Napi::AsyncWorker {
 public:
  explicit BufferWorker(Napi::Env env)
      : Napi::AsyncWorker(env, "brotli-js"), deferred_(Napi::Promise::Deferred::New(env)) {}
  ~BufferWorker() override { bjs_buf_free(&out_); }

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  virtual int Run(bjs_buf* out, const char** detail) = 0;
  virtual void Done() {}

  void Execute() override { rc_ = Run(&out_, &detail_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Done();
    if (rc_ != BJS_OK) {
      deferred_.Reject(MakeError(env, rc_, detail_).Value());
    } else {
      deferred_.Resolve(TakeBuffer(env, &out_));
    }
  }

  void OnError(const Napi::Error& e) override {
    Done();
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  bjs_buf out_{};
  int rc_ = BJS_OK;
  const char* detail_ = nullptr;
};

// Encoder settings as passed from JavaScript: (quality, lgwin, mode, largeWindow, sizeHint).
struct EncoderArgs {
  int quality;
  int lgwin;
  int mode;
  bool large_window;
  size_t size_hint;
};

EncoderArgs EncoderArgsAt(const Napi::CallbackInfo& info, size_t index) {
  return EncoderArgs{IntArg(info, index, "quality"), IntArg(info, index + 1, "lgwin"),
                     IntArg(info, index + 2, "mode"), BoolArg(info, index + 3),
                     LimitArg(info, index + 4, "sizeHint")};
}

// Inputs are copied: JavaScript may modify or transfer (detach) the source
// ArrayBuffer while the worker runs on another thread.
class CompressWorker : public BufferWorker {
 public:
  CompressWorker(Napi::Env env, std::vector<uint8_t> src, EncoderArgs args)
      : BufferWorker(env), src_(std::move(src)), args_(args) {}

 protected:
  int Run(bjs_buf* out, const char** detail) override {
    return bjs_compress(DataOrNull(src_), src_.size(), args_.quality, args_.lgwin, args_.mode,
                        args_.large_window ? 1 : 0, args_.size_hint, out, detail);
  }

 private:
  std::vector<uint8_t> src_;
  EncoderArgs args_;
};

class DecompressWorker : public BufferWorker {
 public:
  DecompressWorker(Napi::Env env, std::vector<uint8_t> src, bool large_window, size_t max_output)
      : BufferWorker(env), src_(std::move(src)), large_window_(large_window),
        max_output_(max_output) {}

 protected:
  int Run(bjs_buf* out, const char** detail) override {
    return bjs_decompress(DataOrNull(src_), src_.size(), large_window_ ? 1 : 0, max_output_,
                          out, detail);
  }

 private:
  std::vector<uint8_t> src_;
  bool large_window_;
  size_t max_output_;
};

std::vector<uint8_t> CopyBytes(const Napi::Uint8Array& a) {
  return std::vector<uint8_t>(a.Data(), a.Data() + a.ByteLength());
}

// compressSync(data, quality, lgwin, mode, largeWindow, sizeHint): Buffer
Napi::Value CompressSync(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  EncoderArgs args = EncoderArgsAt(info, 1);
  bjs_buf out{};
  const char* detail = nullptr;
  int rc = bjs_compress(src.Data(), src.ByteLength(), args.quality, args.lgwin, args.mode,
                        args.large_window ? 1 : 0, args.size_hint, &out, &detail);
  if (rc != BJS_OK) {
    bjs_buf_free(&out);
    throw MakeError(info.Env(), rc, detail);
  }
  return TakeBuffer(info.Env(), &out);
}

// compress(data, quality, lgwin, mode, largeWindow, sizeHint): Promise<Buffer>
Napi::Value Compress(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  EncoderArgs args = EncoderArgsAt(info, 1);
  auto* worker = new CompressWorker(info.Env(), CopyBytes(src), args);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// decompressSync(data, largeWindow, maxOutput): Buffer
Napi::Value DecompressSync(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  bool large_window = BoolArg(info, 1);
  size_t max_output = LimitArg(info, 2, "maxOutputSize");
  bjs_buf out{};
  const char* detail = nullptr;
  int rc = bjs_decompress(src.Data(), src.ByteLength(), large_window ? 1 : 0, max_output, &out,
                          &detail);
  if (rc != BJS_OK) {
    bjs_buf_free(&out);
    throw MakeError(info.Env(), rc, detail);
  }
  return TakeBuffer(info.Env(), &out);
}

// decompress(data, largeWindow, maxOutput): Promise<Buffer>
Napi::Value Decompress(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  bool large_window = BoolArg(info, 1);
  size_t max_output = LimitArg(info, 2, "maxOutputSize");
  auto* worker = new DecompressWorker(info.Env(), CopyBytes(src), large_window, max_output);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// ---- streams ---------------------------------------------------------------

// Shared by CStream and DStream: one operation at a time, and the JS object
// stays referenced while a worker uses the native context, so the garbage
// collector cannot free the context underneath it. T provides FreeContext().
template <typename T>
class StreamBase : public Napi::ObjectWrap<T> {
 public:
  using Napi::ObjectWrap<T>::ObjectWrap;

  void Acquire(Napi::Env env) {
    if (closed_) throw MakeError(env, BJS_ERR_ARG, "stream is closed");
    if (busy_) throw MakeError(env, BJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    busy_ = true;
  }
  void Release() {
    busy_ = false;
    if (closed_) static_cast<T*>(this)->FreeContext();
  }

 protected:
  // close(): frees the context now, or as soon as an in-flight push finishes
  // (a stream cancelled mid-push, e.g. an aborted fetch, must not throw).
  Napi::Value Close(const Napi::CallbackInfo& info) {
    closed_ = true;
    if (!busy_) static_cast<T*>(this)->FreeContext();
    return info.Env().Undefined();
  }

  bool busy_ = false;
  bool closed_ = false;
};

class StreamPushWorker : public BufferWorker {
 public:
  using Job = int (*)(void* ctx, const uint8_t* src, size_t size, int mode, bjs_buf* out,
                      const char** detail);
  StreamPushWorker(Napi::Env env, Napi::Object owner, void* ctx, Job job,
                   std::vector<uint8_t> src, int mode, void (*release)(Napi::Object))
      : BufferWorker(env), ctx_(ctx), job_(job), src_(std::move(src)), mode_(mode),
        release_(release) {
    owner_ = Napi::Persistent(owner);
  }

 protected:
  int Run(bjs_buf* out, const char** detail) override {
    return job_(ctx_, DataOrNull(src_), src_.size(), mode_, out, detail);
  }
  void Done() override {
    release_(owner_.Value());
    owner_.Reset();
  }

 private:
  void* ctx_;
  Job job_;
  std::vector<uint8_t> src_;
  int mode_;
  void (*release_)(Napi::Object);
  Napi::ObjectReference owner_;
};

class CStream : public StreamBase<CStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "CStream",
                       {InstanceMethod("push", &CStream::Push),
                        InstanceMethod("pushAsync", &CStream::PushAsync),
                        InstanceMethod("close", &CStream::Close)});
  }

  // new CStream(quality, lgwin, mode, largeWindow, sizeHint)
  explicit CStream(const Napi::CallbackInfo& info) : StreamBase<CStream>(info) {
    EncoderArgs args = EncoderArgsAt(info, 0);
    const char* detail = nullptr;
    int rc = bjs_cstream_create(args.quality, args.lgwin, args.mode, args.large_window ? 1 : 0,
                                args.size_hint, &stream_, &detail);
    if (rc != BJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~CStream() override { bjs_cstream_free(stream_); }

 private:
  static int Job(void* ctx, const uint8_t* src, size_t size, int mode, bjs_buf* out,
                 const char** detail) {
    return bjs_cstream_push(static_cast<bjs_cstream*>(ctx), src, size, mode, out, detail);
  }
  static void ReleaseOwner(Napi::Object owner) { CStream::Unwrap(owner)->Release(); }

  // push(chunk, mode): Buffer
  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    int mode = IntArg(info, 1, "mode");
    Acquire(info.Env());
    bjs_buf out{};
    const char* detail = nullptr;
    int rc = bjs_cstream_push(stream_, chunk.Data(), chunk.ByteLength(), mode, &out, &detail);
    Release();
    if (rc != BJS_OK) {
      bjs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk, mode): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    int mode = IntArg(info, 1, "mode");
    Acquire(info.Env());
    auto* worker = new StreamPushWorker(info.Env(), info.This().As<Napi::Object>(), stream_, Job,
                                        CopyBytes(chunk), mode, ReleaseOwner);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  friend class StreamBase<CStream>;
  void FreeContext() {
    bjs_cstream_free(stream_);
    stream_ = nullptr;
  }

  bjs_cstream* stream_ = nullptr;
};

class DStream : public StreamBase<DStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "DStream",
                       {InstanceMethod("push", &DStream::Push),
                        InstanceMethod("pushAsync", &DStream::PushAsync),
                        InstanceMethod("finish", &DStream::Finish),
                        InstanceMethod("close", &DStream::Close)});
  }

  // new DStream(largeWindow, maxOutput)
  explicit DStream(const Napi::CallbackInfo& info) : StreamBase<DStream>(info) {
    bool large_window = BoolArg(info, 0);
    size_t max_output = LimitArg(info, 1, "maxOutputSize");
    const char* detail = nullptr;
    int rc = bjs_dstream_create(large_window ? 1 : 0, max_output, &stream_, &detail);
    if (rc != BJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~DStream() override { bjs_dstream_free(stream_); }

 private:
  static int Job(void* ctx, const uint8_t* src, size_t size, int /*mode*/, bjs_buf* out,
                 const char** detail) {
    return bjs_dstream_push(static_cast<bjs_dstream*>(ctx), src, size, out, detail);
  }
  static void ReleaseOwner(Napi::Object owner) { DStream::Unwrap(owner)->Release(); }

  // push(chunk): Buffer
  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    bjs_buf out{};
    const char* detail = nullptr;
    int rc = bjs_dstream_push(stream_, chunk.Data(), chunk.ByteLength(), &out, &detail);
    Release();
    if (rc != BJS_OK) {
      bjs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    auto* worker = new StreamPushWorker(info.Env(), info.This().As<Napi::Object>(), stream_, Job,
                                        CopyBytes(chunk), 0, ReleaseOwner);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  // finish(): throws if the input ended before the end of the stream
  Napi::Value Finish(const Napi::CallbackInfo& info) {
    Acquire(info.Env());
    const char* detail = nullptr;
    int rc = bjs_dstream_finish(stream_, &detail);
    Release();
    if (rc != BJS_OK) throw MakeError(info.Env(), rc, detail);
    return info.Env().Undefined();
  }

  friend class StreamBase<DStream>;
  void FreeContext() {
    bjs_dstream_free(stream_);
    stream_ = nullptr;
  }

  bjs_dstream* stream_ = nullptr;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compressSync", Napi::Function::New(env, CompressSync));
  exports.Set("compress", Napi::Function::New(env, Compress));
  exports.Set("decompressSync", Napi::Function::New(env, DecompressSync));
  exports.Set("decompress", Napi::Function::New(env, Decompress));
  exports.Set("version", Napi::String::New(env, bjs_version()));
  exports.Set("CStream", CStream::Init(env));
  exports.Set("DStream", DStream::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(brotli_js, Init)
