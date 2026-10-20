{
  "targets": [
    {
      "target_name": "brotli_js",
      "sources": [
        "csrc/addon.cc",
        "csrc/bjs.c",
        "<!@(node scripts/brotli-sources.cjs)"
      ],
      "include_dirs": ["deps/brotli/c/include"],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_DISABLE_DEPRECATED",
        "BROTLI_ENCODER_CLEANUP_ON_OOM"
      ],
      # The encoder's cost model uses floating point. Fusing multiply-adds
      # (the default on arm64 with gcc and clang) would change its choices, so
      # the addon would stop producing the same bytes as the WebAssembly build.
      "cflags": ["-O3", "-fvisibility=hidden", "-ffp-contract=off"],
      "cflags_cc": ["-O3", "-fvisibility=hidden", "-std=c++17"],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_CFLAGS": ["-ffp-contract=off"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
