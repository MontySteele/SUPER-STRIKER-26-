// Volume smoke check (§7.3).
//
// The faders are two independent halves — a localStorage write in the front end
// and a gain ramp in AudioEngine — and a regression in either is silent. So
// this drives a real browser and asserts the whole chain:
//
//   1. defaults land on the four gain nodes at their documented values;
//   2. a write to `ss26.vol.*` SURVIVES A RELOAD and reaches the nodes;
//   3. moving a fader at runtime (the same `ss26-volume-change` the menu fires)
//      ramps the node it names and leaves the other three alone;
//   4. 0 is true silence and the taper is perceptual, not linear.
//
//   node tools/volume-smoke.mjs
//   node tools/volume-smoke.mjs --url http://localhost:5173   # reuse a server
//
// Chromium is launched with the autoplay policy relaxed so the context really
// RUNS: a suspended context's currentTime never advances, and a 50 ms
// setTargetAtTime ramp on one would sit at its old value forever — the check
// would pass or fail for reasons that have nothing to do with the code.

import { chromium } from 'playwright';
import { GPU_ARGS, chromiumExecutablePath, parseArgs, startDevServer } from './harness.mjs';

const args = parseArgs(process.argv.slice(2));

const DEFAULTS = { master: 80, music: 60, sfx: 100, voice: 100 };
// base gain per bus, straight out of src/audio/audio.ts VOL_BASE
const g = (pct) => (pct / 100) ** 2;
const BASE = {
  master: 1 / g(DEFAULTS.master),
  sfx: 0.7 / g(DEFAULTS.sfx),
  voice: 0.7 / g(DEFAULTS.voice),
  music: 1 / g(DEFAULTS.music),
};
const expected = (bus, pct) => BASE[bus] * g(pct);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const near = (a, b, eps = 1e-3) => a !== null && Math.abs(a - b) <= eps;

let server = null;
let browser = null;

try {
  let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
  if (!base) {
    server = await startDevServer({ port: 5278 });
    base = server.url;
    console.log(`dev server: ${base}`);
  }

  const exe = chromiumExecutablePath();
  browser = await chromium.launch({
    args: [...GPU_ARGS, '--autoplay-policy=no-user-gesture-required'],
    ...(exe ? { executablePath: exe } : {}),
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('page error:', e.message); failures++; });

  const unlockAndRead = async () => {
    await page.waitForFunction(() => !!window.__ss26audio?.volumes, null, { timeout: 30_000 });
    // a real gesture: the engine only builds its graph on one
    await page.mouse.move(400, 400);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(
      () => (window.__ss26audio?.volumes?.().master.gain ?? null) !== null, null, { timeout: 15_000 },
    );
    return page.evaluate(() => window.__ss26audio.volumes());
  };

  // ---------------------------------------------------- 1. shipped defaults
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  let vols = await unlockAndRead();
  for (const [bus, pct] of Object.entries(DEFAULTS)) {
    check(`default ${bus} = ${pct}`, vols[bus].pct === pct, `got ${vols[bus].pct}`);
    check(`default ${bus} gain`, near(vols[bus].gain, expected(bus, pct)),
      `${vols[bus].gain?.toFixed(4)} vs ${expected(bus, pct).toFixed(4)}`);
  }
  // the whole point of the base gains: defaults reproduce the shipped mix
  check('defaults reproduce shipped mix',
    near(vols.master.gain, 1) && near(vols.sfx.gain, 0.7)
    && near(vols.voice.gain, 0.7) && near(vols.music.gain, 1));

  // ------------------------------------------- 2. persisted across a reload
  const WRITTEN = { master: 35, music: 0, sfx: 65, voice: 100 };
  await page.evaluate((w) => {
    for (const [bus, v] of Object.entries(w)) localStorage.setItem(`ss26.vol.${bus}`, String(v));
  }, WRITTEN);
  await page.reload({ waitUntil: 'domcontentloaded' });
  vols = await unlockAndRead();
  for (const [bus, pct] of Object.entries(WRITTEN)) {
    check(`reload ${bus} = ${pct}`, vols[bus].pct === pct, `got ${vols[bus].pct}`);
    check(`reload ${bus} reached the gain node`, near(vols[bus].gain, expected(bus, pct)),
      `${vols[bus].gain?.toFixed(4)} vs ${expected(bus, pct).toFixed(4)}`);
  }
  check('0 is true silence', vols.music.gain === 0, `music gain ${vols.music.gain}`);

  // -------------------------------------------------- 3. a live fader move
  const after = await page.evaluate(async () => {
    localStorage.setItem('ss26.vol.master', '100');
    window.dispatchEvent(new CustomEvent('ss26-volume-change', { detail: { bus: 'master', value: 100 } }));
    // the ramp is setTargetAtTime(tau 50ms): 400ms is 8 tau, i.e. settled
    await new Promise((r) => setTimeout(r, 400));
    return window.__ss26audio.volumes();
  });
  check('live move: master target is 100', after.master.pct === 100);
  check('live move: master ramped to the new gain',
    near(after.master.gain, expected('master', 100), 5e-3),
    `${vols.master.gain?.toFixed(4)} -> ${after.master.gain?.toFixed(4)} (want ${expected('master', 100).toFixed(4)})`);
  check('live move: sfx untouched', near(after.sfx.gain, vols.sfx.gain, 1e-4));
  check('live move: voice untouched', near(after.voice.gain, vols.voice.gain, 1e-4));

  // ---------------------------------------------------- 4. perceptual taper
  const taper = await page.evaluate(() => {
    const g2 = (p) => (p / 100) ** 2;
    return { at50: g2(50), at100: g2(100) };
  });
  check('50 is a quarter of the power of 100 (≈ half the loudness)',
    Math.abs(taper.at50 / taper.at100 - 0.25) < 1e-9);

  // put the box back the way we found it
  await page.evaluate(() => localStorage.clear());
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser?.close();
  await server?.stop();
}

console.log(failures ? `\n${failures} FAILED` : '\nvolume smoke: all good');
process.exit(failures ? 1 : 0);
