// Studio character shooter (§7A.9). Drives viewer.html headlessly and writes
// the four review angles of one team's player model — the "does this character
// hold up in isolation" sheet, with no stadium, no crowd and no post stack in
// the way.
//
//   npm run shoot-player                          # BRA, four angles
//   npm run shoot-player -- --team arg --out /tmp/arg
//   npm run shoot-player -- --team ger --gk       # the keeper in the keeper kit
//   npm run shoot-player -- --angles front,side --url http://localhost:5173

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, parseArgs, pixelStats, startDevServer } from './harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const ALL_ANGLES = ['front', 'three_quarter', 'side', 'back'];

const WIDTH = 720;
const HEIGHT = 960; // portrait: a standing player wastes most of a 16:9 frame
const TIMEOUT_MS = 60_000;

const args = parseArgs(process.argv.slice(2));
const team = String(args.team ?? 'bra').toLowerCase();
const outDir = resolve(ROOT, typeof args.out === 'string' ? args.out : 'captures/players');
const angles = typeof args.angles === 'string'
  ? args.angles.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_ANGLES;

for (const a of angles) {
  if (!ALL_ANGLES.includes(a)) {
    console.error(`unknown angle "${a}" — expected one of ${ALL_ANGLES.join(', ')}`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });

let server = null;
let browser = null;
let failures = 0;
const stats = {};

try {
  let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
  if (!base) {
    server = await startDevServer({ port: 5274 });
    base = server.url;
    console.log(`dev server: ${base}`);
  }

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  for (const angle of angles) {
    const page = await context.newPage();
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(String(e)));

    // label=0 keeps the caption out of the plate; slot/gk pass straight through
    const q = new URLSearchParams({ team, angle, label: '0' });
    if (args.gk) q.set('gk', '1');
    if (args.slot !== undefined) q.set('slot', String(args.slot));

    try {
      await page.goto(`${base}/viewer.html?${q}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ss26Viewer?.ready === true,
        null, { timeout: TIMEOUT_MS });

      const file = join(outDir, `${team}_${angle}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
      const px = pixelStats(file);
      if (px.blank) throw new Error(`blank frame (lum ${px.minLum}..${px.maxLum}, ${px.colors} colours)`);
      stats[angle] = px;
      console.log(`${`${team}_${angle}`.padEnd(24)} [lum ${px.minLum}..${px.maxLum}, ${px.colors} colours]`);
    } catch (err) {
      failures++;
      stats[angle] = { error: String(err.message ?? err) };
      console.error(`${`${team}_${angle}`.padEnd(24)} FAILED: ${err.message ?? err}`);
      for (const l of logs.slice(0, 5)) console.error(`  page: ${l}`);
    } finally {
      await page.close();
    }
  }

  writeFileSync(join(outDir, `${team}.json`), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    team,
    viewport: { width: WIDTH, height: HEIGHT },
    angles: stats,
  }, null, 2)}\n`);
  console.log(`\n${Object.keys(stats).length} angle(s) → ${outDir}`);
} finally {
  await browser?.close();
  await server?.stop();
}

process.exit(failures ? 1 : 0);
