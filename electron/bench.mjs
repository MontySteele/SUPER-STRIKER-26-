// `npm run app:bench` — the real-GPU benchmark (§7A.9b).
//
// Starts Vite, opens the native shell at `?bench=...` in a normal 1920x1080
// window (NOT fullscreen: fullscreen on macOS animates into its own Space and
// steals the user's screen for the duration), lets the page play four seeded
// situations with the GPU on, lifts the JSON report straight off the shell's
// stdout and writes it to captures/bench/<label>.json.
//
// The window is deliberately visible — there is no way to measure a real GPU
// frame without a real surface — but it is shown WITHOUT focus and the whole
// run is ~40s.
//
//   npm run app:bench
//   npm run app:bench -- --label before
//   npm run app:bench -- --situations corner,walkout --secs 2
//   npm run app:bench -- --quality medium --label medium-after

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronBin from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 240_000;

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};

const label = arg('label', 'bench');
const situations = arg('situations', '1');
const secs = arg('secs');
const quality = arg('quality');
// `--burst 16x12` — more, longer burst chunks, so the MIN column has something
// clean to find on a machine that is busy with something else
const burst = arg('burst');
// 'fixed' (default): the comparable 1920x1080@2 frame. 'window': whatever this
// machine's window really draws, for a sanity check against the panel. 'off':
// do not pin at all — the adaptive-resolution valve stays live, which is the
// only mode that measures the frame a PLAYER gets.
const pin = arg('pin');
// one-setting A/B against the real GPU, e.g. --profile samples:0
const profile = arg('profile');
// the shell is normally shown WITHOUT focus so a bench run does not steal the
// screen; --focus is here because macOS throttles some unfocused surfaces and
// the presented-fps column has to be checkable against a focused window
const focus = argv.includes('--focus');
const outDir = path.resolve(ROOT, arg('out', 'captures/bench'));
// window geometry: the bench normally forces 1920x1080 so a frame time means
// the same thing everywhere. `--panel` takes the machine's whole work area
// instead, which is what `--pin off` wants (the point there is the real frame).
const panel = argv.includes('--panel');
const width = arg('width');
const height = arg('height');
// extra query params, e.g. `--query gfx=log` for the resolution trace
const extra = arg('query');
// `--eval <js>` prints a renderer-side expression once a second (see main.cjs)
const evalExpr = arg('eval');

const query = `?bench=${encodeURIComponent(situations)}&label=${encodeURIComponent(label)}`
  + (secs ? `&secs=${encodeURIComponent(secs)}` : '')
  + (quality ? `&quality=${encodeURIComponent(quality)}` : '')
  + (burst ? `&burst=${encodeURIComponent(burst)}` : '')
  + (pin ? `&pin=${encodeURIComponent(pin)}` : '')
  + (profile ? `&profile=${encodeURIComponent(profile)}` : '')
  + (extra ? `&${extra}` : '');

// ------------------------------------------------------------- dev server

async function freePort(from) {
  for (let p = from; p < from + 60; p++) {
    const ok = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, HOST);
    });
    if (ok) return p;
  }
  throw new Error(`no free port near ${from}`);
}

const PORT = process.env.SS26_PORT ? Number(process.env.SS26_PORT) : await freePort(5373);
const URL_BASE = `http://${HOST}:${PORT}`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite', '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: process.env,
});

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${URL_BASE}/`, { redirect: 'follow' });
      if (res.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`dev server never answered on ${URL_BASE}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let electron = null;
let done = false;

function cleanup(code) {
  if (done) return;
  done = true;
  if (electron && electron.exitCode === null) electron.kill('SIGTERM');
  if (vite.exitCode === null) vite.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250).unref();
}
process.on('SIGINT', () => cleanup(130));

try {
  await waitForServer();
} catch (err) {
  console.error('[bench]', err.message);
  cleanup(1);
  throw err;
}

// ------------------------------------------------------------------- run

console.log(`[bench] dev server ${URL_BASE} — launching the shell at ${query}`);

electron = spawn(electronBin, [path.join(HERE, 'main.cjs')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SS26_DEV_SERVER: URL_BASE,
    SS26_QUERY: query,
    SS26_WINDOWED: '1',
    SS26_MAXIMIZE: panel ? '1' : '',
    SS26_WIDTH: panel ? '' : String(width || 1920),
    SS26_HEIGHT: panel ? '' : String(height || 1080),
    SS26_NO_FOCUS: focus ? '0' : '1',
    SS26_EVAL: evalExpr || '',
  },
});

let buf = '';
let report = null;

const MARKER = '__SS26_BENCH_JSON__';

function scan(text) {
  buf += text;
  const i = buf.indexOf(MARKER);
  if (i < 0 || report) return;
  const line = buf.slice(i + MARKER.length).split('\n')[0];
  // the shell appends " (source:line)" to every console line; the JSON is the
  // first balanced object on it, so take up to the last brace
  const end = line.lastIndexOf('}');
  if (end < 0) return;
  try {
    report = JSON.parse(line.slice(0, end + 1));
  } catch (err) {
    console.error(`[bench] could not parse the report: ${err.message}`);
  }
}

electron.stdout.on('data', (b) => {
  const s = b.toString();
  scan(s);
  // echo everything except the machine-readable line
  for (const l of s.split('\n')) {
    if (l && !l.includes(MARKER)) process.stdout.write(`${l}\n`);
  }
});
electron.stderr.on('data', (b) => process.stderr.write(b));

const timer = setTimeout(() => {
  console.error('[bench] timed out — killing the shell');
  electron.kill('SIGKILL');
}, RUN_TIMEOUT_MS);

electron.on('exit', (code) => {
  clearTimeout(timer);
  if (!report) {
    console.error(`[bench] no report (shell exit ${code})`);
    cleanup(1);
    return;
  }
  if (report.error) {
    console.error(`[bench] page reported: ${report.error}`);
    cleanup(1);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${label}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n[bench] ${report.situations.length} situation(s) → ${file}`);
  cleanup(0);
});
