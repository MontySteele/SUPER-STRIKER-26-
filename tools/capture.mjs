// Headless shot runner (§7A.9). Boots the game at `?capture=<shot>` for every
// shot in the contract (src/tools/shots.json), waits for the page to publish
// its deterministic still, screenshots it at 1280x720 and writes a stats.json
// of draw calls / triangles / fps. This is the quality gate the graphics work
// is measured against: run it before a change, run it after, diff the PNGs.
//
//   npm run capture                      # every shot into captures/
//   npm run capture -- --list            # print the shot list and exit
//   npm run capture -- --shots midfield_wide,celebration_closeup
//   npm run capture -- --out /tmp/before --url http://localhost:5173

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, parseArgs, pixelStats, startDevServer } from './harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = JSON.parse(readFileSync(join(ROOT, 'src/tools/shots.json'), 'utf8')).shots;

const WIDTH = 1280;
const HEIGHT = 720;
/** Some shots step ~2000 sim ticks under software rasterization. */
const SHOT_TIMEOUT_MS = 240_000;

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  for (const s of SHOTS) console.log(`${s.name.padEnd(24)} ${s.note}`);
  process.exit(0);
}

const outDir = resolve(ROOT, typeof args.out === 'string' ? args.out : 'captures');
const wanted = typeof args.shots === 'string'
  ? args.shots.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const shots = wanted ? wanted.map((name) => {
  const s = SHOTS.find((x) => x.name === name);
  if (!s) {
    console.error(`unknown shot "${name}" — run with --list`);
    process.exit(1);
  }
  return s;
}) : SHOTS;

mkdirSync(outDir, { recursive: true });

let server = null;
let browser = null;
let failures = 0;
const stats = {};

try {
  let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
  if (!base) {
    server = await startDevServer();
    base = server.url;
    console.log(`dev server: ${base}`);
  }

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  for (const shot of shots) {
    const page = await context.newPage();
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(String(e)));

    const t0 = Date.now();
    try {
      await page.goto(`${base}/index.html?capture=${encodeURIComponent(shot.name)}`,
        { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ss26Capture?.ready === true,
        null, { timeout: SHOT_TIMEOUT_MS });
      const result = await page.evaluate(() => window.__ss26Capture);
      if (result.error) throw new Error(result.error);

      const file = join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
      const px = pixelStats(file);
      if (px.blank) throw new Error(`blank frame (lum ${px.minLum}..${px.maxLum}, ${px.colors} colours)`);

      stats[shot.name] = { ...result.stats, pixels: px, seconds: Math.round((Date.now() - t0) / 100) / 10 };
      console.log(`${shot.name.padEnd(24)} ${String(result.stats.drawCalls).padStart(5)} calls  `
        + `${String(result.stats.triangles).padStart(8)} tris  ${String(result.stats.fps).padStart(6)} fps  `
        + `[lum ${px.minLum}..${px.maxLum}, ${px.colors} colours]`);
    } catch (err) {
      failures++;
      stats[shot.name] = { error: String(err.message ?? err) };
      console.error(`${shot.name.padEnd(24)} FAILED: ${err.message ?? err}`);
      for (const l of logs.slice(0, 5)) console.error(`  page: ${l}`);
    } finally {
      await page.close();
    }
  }

  writeFileSync(join(outDir, 'stats.json'), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    viewport: { width: WIDTH, height: HEIGHT },
    shots: stats,
  }, null, 2)}\n`);
  console.log(`\n${Object.keys(stats).length} shot(s) → ${outDir}`);
} finally {
  await browser?.close();
  await server?.stop();
}

process.exit(failures ? 1 : 0);
