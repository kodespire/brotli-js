# The C++ TurboModule, added to the app's native build by autolinking
# (react-native.config.js). Same sources, defines and floating-point flags as binding.gyp.
cmake_minimum_required(VERSION 3.13)
project(kodespire_brotli C CXX)

set(ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
set(BROTLI ${ROOT}/deps/brotli/c)
file(GLOB BROTLI_SOURCES ${BROTLI}/common/*.c ${BROTLI}/dec/*.c ${BROTLI}/enc/*.c)
# enc/ and dec/ both have a static_init.c; compile them through the wrappers in
# csrc/, like every other build (scripts/brotli-sources.cjs).
list(REMOVE_ITEM BROTLI_SOURCES ${BROTLI}/dec/static_init.c ${BROTLI}/enc/static_init.c)

add_library(kodespire_brotli STATIC
  ${ROOT}/cpp/KodespireBrotliModule.cpp
  ${ROOT}/csrc/bjs.c
  ${ROOT}/csrc/brotli_dec_static_init.c
  ${ROOT}/csrc/brotli_enc_static_init.c
  ${BROTLI_SOURCES})

target_include_directories(kodespire_brotli
  PUBLIC ${ROOT}/cpp
  PRIVATE ${ROOT}/csrc ${BROTLI}/include)
target_compile_definitions(kodespire_brotli PRIVATE BROTLI_ENCODER_CLEANUP_ON_OOM)
# -O3 in debug builds too: the encoder at -O0 is too slow to be useful.
# -ffp-contract=off: fused multiply-adds (the default on arm64) would change the
# encoder's floating-point cost model, and with it the output bytes. See binding.gyp.
target_compile_options(kodespire_brotli PRIVATE -O3 -fvisibility=hidden -ffp-contract=off)
set_target_properties(kodespire_brotli PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)

target_link_libraries(kodespire_brotli ReactAndroid::jsi ReactAndroid::reactnative)
