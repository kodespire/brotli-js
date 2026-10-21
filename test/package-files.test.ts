// What `npm pack` publishes. React Native apps compile the native module from the
// package, so it must carry the podspec, android/, cpp/ and every C source those
// builds compile, and nothing else of the repo (the example app, build output).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const { sources } = createRequire(import.meta.url)('../scripts/brotli-sources.cjs') as { sources(): string[] };

const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
) as [{ files: { path: string; size: number }[] }];
const files = pack.files.map((f) => f.path.replaceAll('\\', '/'));

describe('npm package contents', () => {
  it('includes the React Native build', () => {
    for (const file of [
      'KodespireBrotli.podspec',
      'react-native.config.js',
      'ios/KodespireBrotliModuleProvider.h',
      'ios/KodespireBrotliModuleProvider.mm',
      'cpp/KodespireBrotliModule.h',
      'cpp/KodespireBrotliModule.cpp',
      'android/build.gradle',
      'android/CMakeLists.txt',
      'android/src/main/java/com/kodespire/brotli/KodespireBrotliPackage.java',
      'codegen/NativeKodespireBrotli.ts',
      'csrc/bjs.c',
      'csrc/bjs.h',
      'deps/brotli/LICENSE',
      'dist/entry-react-native.js',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('includes every brotli source and header the native builds compile', () => {
    // sources() lists the csrc/ wrappers in place of the two static_init.c files,
    // which the wrappers #include, so those must be there too.
    for (const source of sources()) expect(files).toContain(source);
    for (const dir of ['common', 'dec', 'enc']) {
      for (const name of readdirSync(join(root, 'deps', 'brotli', 'c', dir)).filter((n) => /\.[ch]$/.test(n))) {
        expect(files).toContain(`deps/brotli/c/${dir}/${name}`);
      }
    }
    for (const name of readdirSync(join(root, 'deps', 'brotli', 'c', 'include', 'brotli'))) {
      expect(files).toContain(`deps/brotli/c/include/brotli/${name}`);
    }
  });

  it('leaves out the rest of the repo', () => {
    for (const file of files) {
      expect(file).not.toMatch(/^(example|test|scripts|src|out|build|\.github)\//);
      expect(file).not.toMatch(/^android\/(build|\.cxx|\.gradle)\//);
      // Only brotli's C library: not its tools, fuzzers, tests or other language bindings.
      if (file.startsWith('deps/')) expect(file).toMatch(/^deps\/brotli\/(LICENSE$|c\/(common|dec|enc|include\/brotli)\/)/);
    }
    expect(files).not.toContain('binding.gyp');
    expect(files).not.toContain('csrc/addon.cc');
  });

  it('accepts any react-native version as a peer', () => {
    // npm treats "*" as always satisfied. A range such as ">=0.84" made installs fail
    // (ERESOLVE) next to older or prerelease React Native, even for web-only use.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.peerDependencies).toEqual({ 'react-native': '*' });
    expect(pkg.peerDependenciesMeta).toEqual({ 'react-native': { optional: true } });
  });

  it('keeps the React Native sources small', () => {
    // Everything except the JavaScript build and the Node prebuilds, unpacked.
    const native = pack.files.filter((f) => !/^(dist|prebuilds)\//.test(f.path.replaceAll('\\', '/')));
    const bytes = native.reduce((n, f) => n + f.size, 0);
    expect(bytes).toBeLessThan(2.5e6);
  });
});
