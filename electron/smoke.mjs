// `npm run app:smoke` — boot the native shell against the built dist/, forward
// every renderer console line to stdout, screenshot the window through
// webContents.capturePage(), and exit non-zero if the renderer logged an error.
//
// This is the closest thing to a headless test the shell has: it proves the
// ss26:// scheme resolves the multi-page build, that the ES modules load (the
// file:// CORS trap), that WebGL2 comes up, and that nothing throws on boot.
//
//   node electron/smoke.mjs [page] [--windowed]
//     page: index (default) | pad | viewer | modellab | join

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import electronBin from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const page = args[0] || 'index';
const outDir = path.join(ROOT, 'captures', 'electron');
const outFile = path.join(outDir, `${page}.png`);

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('[smoke] no dist/ — run `npm run build` first');
  process.exit(2);
}

const child = spawn(electronBin, [path.join(HERE, 'main.cjs')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SS26_PAGE: page,
    SS26_CAPTURE: outFile,
    SS26_CAPTURE_DELAY: process.env.SS26_CAPTURE_DELAY || '9000',
    // a real window, not fullscreen: fullscreen on macOS animates into its own
    // Space and the capture can land mid-transition
    SS26_WINDOWED: '1',
  },
});

let out = '';
for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', (b) => { out += b.toString(); sink.write(b); });
}

const timer = setTimeout(() => {
  console.error('[smoke] timed out — killing the shell');
  child.kill('SIGKILL');
}, 90_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const errors = [...out.matchAll(/\[renderer:error\]|\[did-fail-load\]|\[render-process-gone\]|\[preload-error\]/g)];
  console.log(`\n[smoke] page=${page} exit=${code} errorLines=${errors.length}`);
  if (existsSync(outFile)) console.log(`[smoke] screenshot: ${outFile}`);
  process.exit(code === 0 && errors.length === 0 ? 0 : 1);
});
