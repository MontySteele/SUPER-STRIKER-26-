// `npm run app:build` — wrap the built dist/ in a macOS arm64 .app.
//
// The repo itself is never handed to @electron/packager: it would drag in
// node_modules (Electron's own 250MB dist included), src/, the asset pipeline
// and the capture folders. Instead a tiny staging tree is assembled with
// exactly three things — a trimmed package.json, electron/, and dist/ — and
// that is what gets packaged. Unsigned and un-notarised on purpose: this is a
// local build for one laptop, and signing needs a paid Apple identity.

import { cp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packager } from '@electron/packager';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, 'build', 'app-stage');
const OUT = path.join(ROOT, 'release');

const PRODUCT = "SUPER STRIKER '26";
const BUNDLE_ID = 'com.montysteele.superstriker26';

try {
  const s = await stat(path.join(DIST, 'index.html'));
  if (!s.isFile()) throw new Error('not a file');
} catch {
  console.error('[app:build] no dist/index.html — run `npm run build` first');
  process.exit(2);
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await cp(DIST, path.join(STAGE, 'dist'), { recursive: true });
await cp(path.join(ROOT, 'electron'), path.join(STAGE, 'electron'), {
  recursive: true,
  // the build/dev helpers are tooling, not runtime
  filter: (src) => !/\/(dev|package|smoke)\.mjs$/.test(src),
});

// No "type": "module" here: main.cjs and preload.cjs are CommonJS, and the
// staged app has no dependencies at all (Vite already bundled three/peerjs).
await writeFile(path.join(STAGE, 'package.json'), JSON.stringify({
  name: 'super-striker-26',
  productName: PRODUCT,
  version: pkg.version,
  description: pkg.description,
  main: 'electron/main.cjs',
  author: 'Monty Steele',
  license: 'UNLICENSED',
  private: true,
}, null, 2) + '\n');

await rm(OUT, { recursive: true, force: true });

const paths = await packager({
  dir: STAGE,
  out: OUT,
  name: PRODUCT,
  platform: 'darwin',
  arch: process.env.SS26_ARCH || 'arm64',
  appBundleId: BUNDLE_ID,
  appCategoryType: 'public.app-category.sports-games',
  appVersion: pkg.version,
  overwrite: true,
  prune: false,          // the staged tree has no node_modules to prune
  asar: true,
  darwinDarkModeSupport: true,
  extendInfo: {
    // a game: it should not be told to take a nap, and it wants the whole screen
    NSHighResolutionCapable: true,
    LSApplicationCategoryType: 'public.app-category.sports-games',
    NSSupportsAutomaticGraphicsSwitching: false,
  },
});

console.log('[app:build] built:', paths.join(', '));
