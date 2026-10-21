# React Native (iOS) build of the native binding: cpp/ over csrc/bjs.c and the
# bundled brotli sources, the same C code as the Node-API addon and the WebAssembly build.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
brotli = "deps/brotli/c"

Pod::Spec.new do |s|
  s.name         = "KodespireBrotli"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/kodespire/brotli-js.git", :tag => "v#{s.version}" }

  # brotli's enc/ and dec/ both have a static_init.c, and Xcode names object files
  # by basename, so those two compile through the wrappers in csrc/ (the same list
  # as scripts/brotli-sources.cjs).
  s.source_files = [
    "ios/*.{h,mm}",
    "cpp/*.{h,cpp}",
    "csrc/*.{h,c}",
    "#{brotli}/{common,dec,enc}/*.c",
  ]
  s.exclude_files = "#{brotli}/{dec,enc}/static_init.c"
  # brotli's headers stay out of the pod's header maps: CocoaPods would flatten
  # them, and names such as memory.h, types.h and version.h would then shadow
  # system headers. Its sources include them by relative path, and
  # HEADER_SEARCH_PATHS has include/ for <brotli/*.h>.
  s.preserve_paths = ["#{brotli}/include/brotli/*.h", "#{brotli}/{common,dec,enc}/*.h", "#{brotli}/{dec,enc}/static_init.c"]
  # Only the provider is public.
  s.public_header_files = "ios/*.h"

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/csrc\" " \
                             "\"$(PODS_TARGET_SRCROOT)/#{brotli}/include\"",
    # Same defines as binding.gyp and scripts/build-wasm.mjs.
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) BROTLI_ENCODER_CLEANUP_ON_OOM",
    "GCC_OPTIMIZATION_LEVEL" => "3",
    "GCC_SYMBOLS_PRIVATE_EXTERN" => "YES",
    # The encoder's cost model uses floating point. Fusing multiply-adds (clang's
    # default on arm64) would change its choices, so the output would no longer be
    # the same bytes as the Node addon and the WebAssembly build. See binding.gyp.
    "OTHER_CFLAGS" => "$(inherited) -ffp-contract=off",
    "OTHER_CPLUSPLUSFLAGS" => "$(inherited) -ffp-contract=off",
    # Xcode's defaults flag a few idioms in brotli's sources.
    "CLANG_WARN_COMMA" => "NO",
    "CLANG_WARN_UNREACHABLE_CODE" => "NO",
  }

  install_modules_dependencies(s)
end
