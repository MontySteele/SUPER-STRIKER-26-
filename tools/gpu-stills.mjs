// Real-GPU stills at the panel's own pixel ratio (§7A.9c).
//
// `npm run capture` is the quality GATE: Playwright, 1280x720, deviceScaleFactor
// 1, SwiftShader. That is the right tool for "did this change the picture" —
// it is reproducible on any machine and it diffs. It is the WRONG tool for
// "does this look good on the user's laptop", because the two things the user
// is actually complaining about (Retina sharpness and the anti-aliasing it
// interacts with) are exactly the two things a 1x software raster cannot show.
//
// So: the same deterministic `?capture=<shot>` page, opened in the native shell
// with the GPU on, in a window whose backing store is DPR 2, screenshotted
// through webContents.capturePage() — which hands back the DEVICE pixels, not
// the CSS ones. One Electron process per shot, because the capture entry point
// deliberately boots a whole renderer and then stops.
//
//   node tools/gpu-stills.mjs                        # the default four
//   node tools/gpu-stills.mjs --shots tele_endzone,setpiece_corner
//   node tools/gpu-stills.mjs --out captures/foo --size 1440x810
//   node tools/gpu-stills.mjs --label after          # <shot>-after.png

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronBin from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HOST = '127.0.0.1';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};

/** The four frames the grass and the resolution work live or die on: the
 *  everyday tele wide, a knee-height end-zone look down the shells, the corner
 *  rig, and a night goal under the floodlights. */
const DEFAULT_SHOTS = ['midfield_wide', 'pitch_stripes_low_sun', 'setpiece_corner',
  'goal_celebration'];

const shots = (arg('shots') ?? DEFAULT_SHOTS.join(',')).split(',').map((s) => s.trim())
  .filter(Boolean);
const outDir = path.resolve(ROOT, arg('out', 'captures/fidelity-scene/gpu'));
const label = arg('label', '');
const players = arg('players', '');
// `--quality medium` / `retro` — an ad-hoc look at another level, exactly as
// `npm run capture -- --quality` means it: not a baseline, just a check
const quality = arg('quality', '');
// `--query a=1&b=2` — extra page params passed through verbatim (debug toggles)
const extraQuery = arg('query', '');
const size = (arg('size', '1440x810').match(/^(\d+)x(\d+)$/) ?? [null, '1440', '810']).slice(1);
const perShotTimeout = Number(arg('timeout', 180)) * 1000;

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

const PORT = process.env.SS26_PORT ? Number(process.env.SS26_PORT) : await freePort(5473);
const URL_BASE = `http://${HOST}:${PORT}`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite', '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${URL_BASE}/`, { redirect: 'follow' })).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('dev server never answered');
    await new Promise((r) => setTimeout(r, 200));
  }
}

function shoot(shot) {
  const file = path.join(outDir, `${shot}${label ? `-${label}` : ''}.png`);
  const query = `?capture=${encodeURIComponent(shot)}`
    + (players ? `&players=${encodeURIComponent(players)}` : '')
    + (quality ? `&quality=${encodeURIComponent(quality)}` : '')
    + (extraQuery ? `&${extraQuery}` : '');
  return new Promise((resolve) => {
    const child = spawn(electronBin, [path.join(ROOT, 'electron', 'main.cjs')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SS26_DEV_SERVER: URL_BASE,
        SS26_QUERY: query,
        SS26_WINDOWED: '1',
        SS26_WIDTH: size[0],
        SS26_HEIGHT: size[1],
        SS26_NO_FOCUS: '1',
        SS26_CAPTURE: file,
        // the page's own "the still is on screen" flag — see tools/capture.ts
        SS26_CAPTURE_READY: 'window.__ss26Capture && window.__ss26Capture.ready',
        SS26_CAPTURE_DELAY: String(perShotTimeout),
      },
    });
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
      for (const l of b.toString().split('\n')) {
        if (/captured|renderer:error|LOD tiers|bake/.test(l)) process.stdout.write(`${l}\n`);
      }
    });
    child.stderr.on('data', (b) => process.stderr.write(b));
    const timer = setTimeout(() => child.kill('SIGKILL'), perShotTimeout + 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ shot, file, code, ok: out.includes('[shell] captured') });
    });
  });
}

await waitForServer();
mkdirSync(outDir, { recursive: true });
console.log(`[stills] ${URL_BASE} → ${outDir} @ ${size[0]}x${size[1]} css (DPR 2)`);

const results = [];
for (const shot of shots) {
  console.log(`[stills] ${shot} …`);
  results.push(await shoot(shot));
}

vite.kill('SIGTERM');
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.shot} → ${r.file}`);
setTimeout(() => process.exit(bad.length ? 1 : 0), 250).unref();
