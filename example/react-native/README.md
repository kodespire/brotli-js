# brotli-js React Native example

A bare React Native app (Hermes, New Architecture) that runs a self-test of
`@kodespire/brotli-js` on launch: round trips at each quality and option, the
same bytes as the brotli CLI and the WebAssembly build, large windows,
truncated input, trailing data, `maxOutputSize`, async work off the JS thread
and streams. See `selftest/run.ts`. CI runs it on an iOS simulator and an
Android emulator (`.github/workflows/react-native.yml`).

`npm install` here replaces the `file:../..` link with the package exactly as
`npm pack` would publish it (`scripts/prepare.mjs`), so build the package first:

```sh
# in the repo root
npm run build:wasm && npm run build:ts

# here
npm install
(cd ios && bundle install && bundle exec pod install)
npm run selftest:ios       # boots a simulator if none is running (IOS_SIMULATOR picks one)
npm run selftest:android   # needs ANDROID_HOME and a running emulator or device
```

`scripts/selftest.mjs` builds a Release app, installs and launches it, and
prints the `BROTLI_SELFTEST` lines from the device log. It exits non-zero if any
test fails. Run `npm install` again after changing the package.

The app has a `SceneDelegate` (`ios/BrotliExample/SceneDelegate.swift`): iOS 27
stops apps that do not use the UIScene lifecycle, and the React Native 0.84
template has none.
