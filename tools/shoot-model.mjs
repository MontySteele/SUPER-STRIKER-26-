// Model-lab shooter (§7A.9). Drives modellab.html headlessly and writes every
// angle × pose plate for one rigged glTF character, plus the stats sheet the
// page measured — triangles, draw calls, bones, texture sizes, load time.
//
//   npm run shoot-model                                   # 5 angles × 3 poses
//   npm run shoot-model -- --angles front,face --poses kick
//   npm run shoot-model -- --model models/players/p2.glb --out captures/p2
//   npm run shoot-model -- --url http://localhost:5173    # reuse a dev server
//   npm run shoot-model -- --clip cmu_10_01               # 6-frame animation strip
//   npm run shoot-model -- --clip cmu_09_11 --frames 8 --angle side

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, parseArgs, pixelStats, startDevServer, stripPngs } from './harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const ALL_ANGLES = ['front', 'three_quarter', 'side', 'back', 'face'];
const ALL_POSES = ['apose', 'stand', 'kick'];

const WIDTH = 1280;
const HEIGHT = 720;
// a filmstrip cell is portrait-ish: six 1280-wide landscape plates side by side
// would be 7680px of mostly empty studio floor. It cannot go much narrower than
// this either — the camera is fitted to a hull that spans the widest frame in
// the clip (arms out, leg extended), so a slim cell pushes the camera back and
// leaves the figure small in every cell.
const CELL_WIDTH = 640;
const CELL_HEIGHT = 720;
const TIMEOUT_MS = 180_000; // an 18 MB character plus a 21 MB clip, under SwiftShader

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(ROOT, typeof args.out === 'string' ? args.out : 'captures/model');
const model = typeof args.model === 'string' ? args.model : null;
const clip = typeof args.clip === 'string' ? args.clip : null;

const list = (v, all, what) => {
  if (typeof v !== 'string') return all;
  const picked = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of picked) {
    if (!all.includes(p)) {
      console.error(`unknown ${what} "${p}" — expected one of ${all.join(', ')}`);
      process.exit(1);
    }
  }
  return picked;
};

const angles = list(args.angles, ALL_ANGLES, 'angle');
const poses = list(args.poses, ALL_POSES, 'pose');

mkdirSync(outDir, { recursive: true });

let server = null;
let browser = null;
let failures = 0;
const shots = {};
let modelStats = null;

try {
  let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
  if (!base) {
    server = await startDevServer({ port: 5275 });
    base = server.url;
    console.log(`dev server: ${base}`);
  }

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  if (clip) {
    // ---------------------------------------------------------- clip strip
    // Six evenly spaced frames across the clip, each its own deterministic
    // still (?t=), composited into one filmstrip. The page fits its camera to
    // a hull measured over the WHOLE clip and re-centres it on the hips every
    // frame, so the cells share a scale and the runner stays in shot while the
    // floor slides past underneath him.
    const page = await context.newPage();
    await page.setViewportSize({ width: CELL_WIDTH, height: CELL_HEIGHT });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(String(e)));

    const stripAngle = typeof args.angle === 'string' ? args.angle : 'three_quarter';
    const frames = Number(args.frames ?? 6) || 6;
    const cells = [];
    const frameStats = [];
    let duration = null;

    try {
      for (let i = 0; i < frames; i++) {
        // duration is not known until the first page has parsed the clip, so
        // frame 0 doubles as the probe
        const t = duration === null ? 0 : (duration * i) / frames;
        const q = new URLSearchParams({ angle: stripAngle, clip, capture: '1', t: String(t) });
        if (!args.label) q.set('label', '0');
        if (model) q.set('model', model);
        await page.goto(`${base}/modellab.html?${q}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__ss26ModelLab?.ready === true,
          null, { timeout: TIMEOUT_MS });
        const info = await page.evaluate(() => window.__ss26ModelLab.stats);
        modelStats ??= info;
        duration ??= info.clipDuration;

        const file = join(outDir, `${clip}_f${i}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: CELL_WIDTH, height: CELL_HEIGHT } });
        const px = pixelStats(file);
        if (px.blank) throw new Error(`blank frame at t=${t}`);
        cells.push(file);
        frameStats.push({
          t: info.clipTime, travel: info.rootMotion, footY: info.footY,
          minLum: px.minLum, maxLum: px.maxLum, colors: px.colors,
        });
        console.log(`${clip} f${i}`.padEnd(24)
          + ` t=${String(info.clipTime).padEnd(6)} travel ${String(info.rootMotion).padEnd(6)}m`
          + ` footY ${String(info.footY).padEnd(7)} [${px.colors} colours]`);
      }

      const stripPath = join(outDir, `${clip}_strip.png`);
      const dim = stripPngs(cells, stripPath);
      for (const c of cells) rmSync(c);
      console.log(`\nstrip ${dim.width}x${dim.height} → ${stripPath}`);
      console.log(`clip ${modelStats.clip} · ${modelStats.clipDuration}s · ${modelStats.clipTracks} tracks`
        + ` · ${modelStats.clipUnbound?.length ?? 0} unbound · lowest vertex in clip ${modelStats.clipFloorMinY}`);
    } catch (err) {
      failures++;
      console.error(`${clip} FAILED: ${err.message ?? err}`);
      for (const l of logs.slice(0, 8)) console.error(`  page: ${l}`);
    } finally {
      await page.close();
    }

    writeFileSync(join(outDir, `${clip}_stats.json`), `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      model: model ?? 'models/players/p1.glb',
      clip,
      angle: stripAngle,
      cell: { width: CELL_WIDTH, height: CELL_HEIGHT },
      model_stats: modelStats,
      frames: frameStats,
    }, null, 2)}\n`);
    console.log(`stats → ${join(outDir, `${clip}_stats.json`)}`);
  } else {
  for (const pose of poses) {
    for (const angle of angles) {
      const name = `${pose}_${angle}`;
      const page = await context.newPage();
      const logs = [];
      page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
      page.on('pageerror', (e) => logs.push(String(e)));

      // label=0 keeps the stats caption out of the plate unless asked for
      const q = new URLSearchParams({ angle, pose, capture: '1' });
      if (!args.label) q.set('label', '0');
      if (model) q.set('model', model);

      try {
        await page.goto(`${base}/modellab.html?${q}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__ss26ModelLab?.ready === true,
          null, { timeout: TIMEOUT_MS });

        const info = await page.evaluate(() => window.__ss26ModelLab.stats);
        modelStats ??= info;

        const file = join(outDir, `${name}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
        const px = pixelStats(file);
        if (px.blank) throw new Error(`blank frame (lum ${px.minLum}..${px.maxLum}, ${px.colors} colours)`);
        shots[name] = { ...px, drawCalls: info?.drawCalls, triangles: info?.triangles };
        console.log(`${name.padEnd(24)} [lum ${px.minLum}..${px.maxLum}, mean ${px.meanLum},`
          + ` ${px.colors} colours, ${info?.drawCalls} draws]`);
      } catch (err) {
        failures++;
        shots[name] = { error: String(err.message ?? err) };
        console.error(`${name.padEnd(24)} FAILED: ${err.message ?? err}`);
        for (const l of logs.slice(0, 5)) console.error(`  page: ${l}`);
      } finally {
        await page.close();
      }
    }
  }

  writeFileSync(join(outDir, 'stats.json'), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    model: model ?? 'models/players/p1.glb',
    viewport: { width: WIDTH, height: HEIGHT },
    angles,
    poses,
    model_stats: modelStats,
    shots,
  }, null, 2)}\n`);
  console.log(`\n${Object.keys(shots).length} plate(s) → ${outDir}`);
  }
} finally {
  await browser?.close();
  await server?.stop();
}

process.exit(failures ? 1 : 0);
