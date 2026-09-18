// Headless runner for the broadcast-graphics shots (src/ui/broadcastShots.ts).
// Boots the game at `?broadcast=<shot>`, waits for the page to freeze the TV
// package over a seeded match, and screenshots it. Unlike tools/capture.mjs
// this one shoots at both broadcast sizes by default, because the whole point
// of the exercise is "does it read as television at 1080p AND at 720p".
//
//   npm run capture-tv                       # every graphic, both sizes
//   npm run capture-tv -- --list
//   npm run capture-tv -- --shots goal_banner,stats_card
//   npm run capture-tv -- --size 1920x1080   # one size only
//   npm run capture-tv -- --out /tmp/tv --url http://localhost:5173

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, parseArgs, pixelStats, startDevServer } from './harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOT_TIMEOUT_MS = 300_000;

const args = parseArgs(process.argv.slice(2));

const sizes = typeof args.size === 'string'
  ? args.size.split(',').map((s) => {
    const [w, h] = s.trim().toLowerCase().split('x').map(Number);
    return { width: w, height: h };
  })
  : [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }];

const outDir = resolve(ROOT, typeof args.out === 'string' ? args.out : 'captures/tv');
const wanted = typeof args.shots === 'string'
  ? args.shots.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

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

  // the shot list lives in TypeScript; ask the page for it rather than
  // duplicating it here and letting the two drift
  const probeCtx = await browser.newContext({ viewport: sizes[0], deviceScaleFactor: 1 });
  const probe = await probeCtx.newPage();
  await probe.goto(`${base}/index.html?broadcast=__list__`, { waitUntil: 'load' });
  await probe.waitForFunction(() => window.__ss26CaptureShots !== undefined,
    null, { timeout: 60_000 });
  const names = await probe.evaluate(() => window.__ss26CaptureShots);
  await probe.close();
  await probeCtx.close();

  if (args.list) {
    for (const n of names) console.log(n);
    process.exit(0);
  }

  const shots = wanted ?? names;
  for (const name of shots) {
    if (!names.includes(name)) {
      console.error(`unknown broadcast shot "${name}" — run with --list`);
      failures++;
      continue;
    }
  }

  mkdirSync(outDir, { recursive: true });

  for (const size of sizes) {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    const tag = `${size.width}x${size.height}`;
    for (const name of shots) {
      if (!names.includes(name)) continue;
      const page = await context.newPage();
      const logs = [];
      page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
      page.on('pageerror', (e) => logs.push(String(e)));

      const t0 = Date.now();
      try {
        await page.goto(`${base}/index.html?broadcast=${encodeURIComponent(name)}`,
          { waitUntil: 'load' });
        await page.waitForFunction(() => window.__ss26Capture?.ready === true,
          null, { timeout: SHOT_TIMEOUT_MS, polling: 500 });
        const result = await page.evaluate(() => window.__ss26Capture);
        if (result.error) throw new Error(result.error);

        const file = join(outDir, `${name}@${tag}.png`);
        await page.screenshot({ path: file, timeout: SHOT_TIMEOUT_MS,
          clip: { x: 0, y: 0, ...size } });
        const px = pixelStats(file);
        if (px.blank) throw new Error(`blank frame (lum ${px.minLum}..${px.maxLum})`);
        stats[`${name}@${tag}`] = { ...result.stats, seconds: Math.round((Date.now() - t0) / 100) / 10 };
        console.log(`${`${name}@${tag}`.padEnd(34)} ok  `
          + `${JSON.stringify(result.stats)}  ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (err) {
        failures++;
        stats[`${name}@${tag}`] = { error: String(err.message ?? err) };
        console.error(`${`${name}@${tag}`.padEnd(34)} FAILED: ${err.message ?? err}`);
        for (const l of logs.slice(0, 5)) console.error(`  page: ${l}`);
      } finally {
        await page.close();
      }
    }
    await context.close();
  }

  writeFileSync(join(outDir, 'stats.json'), `${JSON.stringify({
    capturedAt: new Date().toISOString(), sizes, shots: stats,
  }, null, 2)}\n`);
  console.log(`\n${Object.keys(stats).length} PNG(s) → ${outDir}`);
} finally {
  await browser?.close();
  await server?.stop();
}

process.exit(failures ? 1 : 0);
