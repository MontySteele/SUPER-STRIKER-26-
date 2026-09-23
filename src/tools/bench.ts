// Real-GPU benchmark (§7A.9b): `index.html?bench=1`.
//
// The capture harness (capture.ts) answers "does this frame still look right".
// It cannot answer "does this frame still FIT", because it runs under software
// rasterization where an fps number is a random variable. This module is the
// other half: it boots the real game loop inside the Electron shell with the
// GPU on, plays a seeded match through a handful of representative situations,
// and reports what each one actually costs.
//
// Three rules keep the numbers honest:
//
//  • THE DRAWING BUFFER IS PINNED. SceneManager.pinRenderSize() fixes the
//    frame at 1920x1080 CSS x pixel ratio 2 (3840x2160 device pixels) whatever
//    the shell window happens to be, and disables the adaptive-resolution
//    valve — which otherwise trims pixels under load and hands back a flat
//    60fps that means nothing.
//
//  • FPS AND COST ARE DIFFERENT NUMBERS. rAF is vsync-paced, so "fps" tops out
//    at the display's refresh rate and only ever tells you when we MISS it.
//    The frame-time column is measured around the draw with a gl.finish(), so
//    it is the real CPU+GPU cost of the frame and the headroom column
//    (1000/cost) is what says how much room is left.
//
//  • NO DETERMINISTIC ENV. The capture harness replaces performance.now with a
//    virtual clock; a benchmark that did that would be timing a fiction. The
//    sim is still seeded, so the situations are the same football every run.

import { GameRenderer, skinnedPlayersWanted } from '../render/gameRenderer';
import { Presentation } from '../present/director';
import { preloadCharacters } from '../render/characterAssets';
import { preloadCrowd } from '../render/crowd';
import { forceQuality, overrideProfile, type QualityLevel, type QualityProfile } from '../render/quality';
import type { GfxStats, TimeOfDay } from '../render/scene';
import type { StadiumSize } from '../render/stadium';
import { SIM_DT } from '../sim/constants';
import { Match } from '../sim/match';
import { findTeam } from '../data/loader';

/** The frame we quote numbers for: a 1080p window on a Retina panel. This is
 *  a FIXED target on purpose — a number that changes with the window it was
 *  taken in cannot be compared with the one from before the change. */
const BENCH_W = 1920;
const BENCH_H = 1080;
const BENCH_RATIO = 2;

// Pre-roll: frames DRAWN AND THROWN AWAY before the clock starts. Three's
// programs compile lazily on first draw, every texture uploads on first use
// and the LOD picker needs a couple of frames to settle on a new camera — the
// first frame of a situation costs ~175ms and would otherwise own the average.
// Whichever of the two limits comes first ends the pre-roll, so a pathological
// start cannot eat the whole run.
const PREROLL_FRAMES = 45;
const PREROLL_MS = 2500;

// A measured roll is two phases, because the two numbers cannot be taken from
// the same frames.
//
//  1. The PACED phase draws exactly as the game draws, one frame per rAF, and
//     gives the presented frame rate and the 1% low. This is the number that
//     answers "does it hold 60".
//
//  2. The BURST phase then redraws the settled frame back to back, off rAF, in
//     chunks ending in a gl.finish(), and divides. This is the number that
//     answers "how much room is left", and it has to be measured this way:
//     a per-frame finish inside a paced loop reports ~5ms for a frame that
//     demonstrably takes 33ms to present, because ANGLE-on-Metal's finish
//     returns when OUR commands are done and not when the frame is on screen.
//     A saturated queue has nowhere to hide that difference.
//
// Both are tunable from the URL (`&burst=12x16`) for one reason: this is a
// LAPTOP, and a laptop runs other things. When the machine is loaded, every
// chunk picks up whatever CPU contention it happened to meet, and the mean of
// six chunks is then a measurement of the other process. More chunks plus the
// MINIMUM (reported as frameMs.min) is the answer — the cleanest chunk of a
// long run is the closest thing to an uncontended number you can get without
// owning the machine, and it is the one to quote in an A/B.
const DEFAULT_BURST_CHUNKS = 6;
const DEFAULT_BURST_PER_CHUNK = 8;
let BURST_CHUNKS = DEFAULT_BURST_CHUNKS;
let BURST_PER_CHUNK = DEFAULT_BURST_PER_CHUNK;

export interface BenchSituation {
  name: string;
  note: string;
  seed: number;
  home: string;
  away: string;
  timeOfDay: TimeOfDay;
  stadium: StadiumSize;
  /** sim ticks (or scene ticks, under a walkout) stepped without drawing */
  warmFrames: number;
  /** seconds of real, drawn, vsync-paced gameplay to measure */
  seconds: number;
  /** §7 scene to run alongside: 'walkout' holds the sim, 'goal' rides along */
  cutscene?: 'walkout' | 'goal';
}

/**
 * Four situations, chosen because they are the four shapes of frame this game
 * draws: the everyday broadcast wide, the most expensive thing in the game (a
 * night goal package in the big bowl, with replays and confetti), a set piece
 * with both boxes packed, and the pre-match walkout where 22 authored
 * characters are all on screen at LOD 0 at once.
 */
export const SITUATIONS: BenchSituation[] = [
  {
    name: 'broadcast_midfield',
    note: 'Open play under the tele cam, day, national stadium — the everyday frame.',
    seed: 12648430, home: 'cze', away: 'ger',
    timeOfDay: 'day', stadium: 'national',
    warmFrames: 600, seconds: 5,
  },
  {
    name: 'goal_sequence',
    note: 'Seed 22343 scores at frame 1706: slow-mo, celebration, crowd cutaway and'
      + ' three replay angles, at night in the mega bowl with confetti up.',
    seed: 22343, home: 'cze', away: 'ger',
    timeOfDay: 'night', stadium: 'mega',
    warmFrames: 1690, seconds: 9, cutscene: 'goal',
  },
  {
    name: 'corner',
    note: 'Seed 4242 corner (frames 1404-1570): both boxes packed, the set-piece rig'
      + ' looking across the six-yard box.',
    seed: 4242, home: 'cze', away: 'ger',
    timeOfDay: 'day', stadium: 'national',
    warmFrames: 1400, seconds: 4,
  },
  {
    name: 'walkout',
    note: 'The pre-match walkout 3s in: 22 characters on screen on their own idles,'
      + ' the pitch-level dolly moving.',
    seed: 12648430, home: 'cze', away: 'ger',
    timeOfDay: 'day', stadium: 'national',
    warmFrames: 180, seconds: 4, cutscene: 'walkout',
  },
];

export interface BenchResult {
  name: string;
  note: string;
  frames: number;
  seconds: number;
  /** presented (vsync-paced) frame rate */
  fps: { avg: number; low1: number; min: number };
  /** the presented intervals themselves — a clean 16.7 vs a clean 33.3 is the
   *  difference between "we fit" and "we miss every other vsync" */
  intervalMs: { p50: number; p95: number; max: number };
  /** what the frame costs with the queue saturated (the burst phase). `min` is
   *  the cleanest chunk of the run — the number to use on a shared machine. */
  frameMs: { min: number; avg: number; p50: number; p95: number; p99: number; max: number };
  /** 1000 / frameMs.avg — the unpaced throughput of this frame */
  headroomFps: number;
  triangles: { avg: number; max: number };
  drawCalls: { avg: number; max: number };
}

export interface BenchReport {
  label: string;
  at: string;
  quality: QualityLevel;
  /** the `&profile=` A/B string this run used, if any */
  profileOverride: string | null;
  canvas: { cssWidth: number; cssHeight: number; ratio: number; width: number; height: number };
  window: { innerWidth: number; innerHeight: number; devicePixelRatio: number };
  renderer: string;
  /** what the resolution valve was doing when the last situation ended.
   *  Under `&pin=off` this is the answer to "what does the player see". */
  gfx: GfxStats | null;
  situations: BenchResult[];
}

// ---------------------------------------------------------------- statistics

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))] ?? 0;

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** The classic "1% low": the mean of the worst 1% of frame intervals, as a
 *  rate. One long frame in a hundred is what a player feels as a stutter. */
function low1(intervalsMs: number[]): number {
  if (!intervalsMs.length) return 0;
  const worst = intervalsMs.slice().sort((a, b) => b - a);
  const n = Math.max(1, Math.ceil(worst.length * 0.01));
  return 1000 / mean(worst.slice(0, n));
}

// -------------------------------------------------------------------- driver

/** Yield to the event loop so a long warm-up never trips the watchdog. */
const breathe = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/** `&pin=window` measures the frame this shell window would really draw
 *  instead of the fixed 1920x1080@2 one — useful when the machine's panel is
 *  smaller than the target and the compositor's rescale is in the numbers. */
function pinnedSize(mode: string | null): { w: number; h: number; ratio: number } | null {
  // `&pin=off` does NOT pin: the shell window's own size, the adaptive
  // resolution valve live, i.e. exactly the frame a player gets. This is the
  // only mode that can answer "what resolution am I actually seeing" — every
  // other mode disables the valve by construction.
  if (mode === 'off' || mode === 'none' || mode === 'live') return null;
  // `&pin=1280x720@2` pins an arbitrary frame — how the fill-rate question
  // ("is this resolution-bound or geometry-bound?") gets answered
  const m = mode?.match(/^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/);
  if (m) return { w: Number(m[1]), h: Number(m[2]), ratio: Number(m[3] ?? 2) };
  if (mode === 'window') {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      ratio: Math.min(window.devicePixelRatio, 2),
    };
  }
  return { w: BENCH_W, h: BENCH_H, ratio: BENCH_RATIO };
}

async function runSituation(
  canvas: HTMLCanvasElement, s: BenchSituation, pin: { w: number; h: number; ratio: number } | null,
): Promise<{
  result: BenchResult;
  buffer: { width: number; height: number; ratio: number };
  gfx: GfxStats;
}> {
  const match = new Match({
    home: findTeam(s.home),
    away: findTeam(s.away),
    seats: [null, null],
    halfLengthSec: 600,
    difficulty: 'pro',
    knockout: false,
    mode: 'match',
    seed: s.seed,
  });
  const renderer = new GameRenderer(canvas, match, s.timeOfDay, s.stadium);
  match.events.on((e) => renderer.onEvent(e));
  if (pin) renderer.sceneMgr.pinRenderSize(pin.w, pin.h, pin.ratio);

  const present = s.cutscene
    ? new Presentation(renderer, match, {
      walkout: s.cutscene === 'walkout',
      celebration: s.cutscene === 'goal',
      walkoff: false,
    })
    : null;

  // ---- warm-up: step the sim to the interesting moment without drawing
  for (let i = 0; i < s.warmFrames; i++) {
    if (!present?.frame()) {
      match.update();
      if (match.phase === 'break') match.continueFromBreak();
      renderer.snapshot();
    }
    renderer.advanceNoDraw(SIM_DT, 1);
    if (i % 240 === 239) await breathe();
  }

  // ---- paced roll: the real game loop, drawn through rAF
  const gl = renderer.sceneMgr.renderer.getContext();
  const info = renderer.sceneMgr.renderer.info;
  const prevAutoReset = info.autoReset;
  info.autoReset = false;

  const intervals: number[] = [];
  const costs: number[] = [];
  const tris: number[] = [];
  const calls: number[] = [];

  await new Promise<void>((resolve) => {
    let acc = 0;
    let frame = 0;
    let last = performance.now();
    let collecting = false;
    let deadline = 0;
    const prerollUntil = last + PREROLL_MS;

    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.25);
      const interval = now - last;
      last = now;

      // the same loop main.ts runs, minus input and the pause machine
      const hold = present?.frame() ?? false;
      if (!hold) {
        acc += dt;
        let steps = 0;
        while (acc >= SIM_DT && steps < 5) {
          match.update();
          if (match.phase === 'break') match.continueFromBreak();
          renderer.snapshot();
          acc -= SIM_DT;
          steps++;
        }
        if (acc > SIM_DT * 2) acc = SIM_DT * 2;
      }
      const alpha = Math.min(acc / SIM_DT, 1);

      info.reset();
      renderer.update(dt, alpha);

      frame++;
      if (!collecting && (frame >= PREROLL_FRAMES || now >= prerollUntil)) {
        collecting = true;
        deadline = now + s.seconds * 1000;
      } else if (collecting) {
        intervals.push(interval);
        tris.push(info.render.triangles);
        calls.push(info.render.calls);
      }

      if (!collecting || now < deadline) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  // ---- burst: the same settled frame, redrawn with the queue saturated
  for (let c = 0; c < BURST_CHUNKS; c++) {
    info.reset();
    const t0 = performance.now();
    for (let i = 0; i < BURST_PER_CHUNK; i++) renderer.renderStillLive();
    gl.finish();
    costs.push((performance.now() - t0) / BURST_PER_CHUNK);
    tris.push(info.render.triangles / BURST_PER_CHUNK);
    calls.push(info.render.calls / BURST_PER_CHUNK);
  }

  info.autoReset = prevAutoReset;
  const buffer = renderer.sceneMgr.bufferSize();
  // taken BEFORE dispose(): under `&pin=off` this is the whole point of the
  // run — what the adaptive valve settled on, and how big the buffer it is
  // feeding the composer really is
  const gfx = renderer.sceneMgr.gfxStats();

  const sortedCost = costs.slice().sort((a, b) => a - b);
  const sortedInterval = intervals.slice().sort((a, b) => a - b);
  const span = intervals.reduce((a, b) => a + b, 0);
  const result: BenchResult = {
    name: s.name,
    note: s.note,
    frames: intervals.length + costs.length,
    seconds: r2(span / 1000),
    fps: {
      avg: r1(intervals.length / Math.max(span / 1000, 1e-6)),
      low1: r1(low1(intervals)),
      min: r1(1000 / Math.max(...intervals, 1e-6)),
    },
    intervalMs: {
      p50: r2(pct(sortedInterval, 0.5)),
      p95: r2(pct(sortedInterval, 0.95)),
      max: r2(Math.max(...intervals, 0)),
    },
    frameMs: {
      min: r2(Math.min(...costs, Infinity)),
      avg: r2(mean(costs)),
      p50: r2(pct(sortedCost, 0.5)),
      p95: r2(pct(sortedCost, 0.95)),
      p99: r2(pct(sortedCost, 0.99)),
      max: r2(Math.max(...costs, 0)),
    },
    // quoted off the cleanest chunk, for the same reason min exists
    headroomFps: r1(1000 / Math.max(Math.min(...costs, Infinity), 1e-6)),
    triangles: { avg: Math.round(mean(tris)), max: Math.max(...tris, 0) },
    drawCalls: { avg: Math.round(mean(calls)), max: Math.max(...calls, 0) },
  };

  present?.dispose();
  renderer.dispose();
  return { result, buffer, gfx };
}

/** A fixed-width table, printed to the console so the runner can forward it. */
export function benchTable(report: BenchReport): string {
  const head = ['situation', 'fps', '1% low', 'frame ms', 'burst ms', 'best ms', 'max ms',
    'headroom', 'tris', 'calls'];
  const w = [22, 7, 7, 9, 9, 8, 7, 9, 10, 7];
  const rows = report.situations.map((s) => [
    s.name,
    s.fps.avg.toFixed(1),
    s.fps.low1.toFixed(1),
    // the presented interval IS the frame time the player lives with
    s.intervalMs.p50.toFixed(2),
    s.frameMs.avg.toFixed(2),
    s.frameMs.min.toFixed(2),
    s.frameMs.max.toFixed(2),
    s.headroomFps.toFixed(1),
    String(s.triangles.avg),
    String(s.drawCalls.avg),
  ]);
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join(' ');
  const c = report.canvas;
  const g = report.gfx;
  return [
    `bench "${report.label}" — quality ${report.quality}, `
      + `${c.cssWidth}x${c.cssHeight} @${c.ratio} = ${c.width}x${c.height} device px`
      + ` (shell window ${report.window.innerWidth}x${report.window.innerHeight})`,
    g
      ? `  ${g.pinned ? 'PINNED' : 'LIVE'} — scale x${g.scale} (step ${g.step}/`
        + `${g.steps.length - 1}), composer ${g.composer.w}x${g.composer.h}, `
        + `aa ${g.aa}, msaa ${g.msaaSamples}x, sharpen ${g.sharpen}, aniso ${g.anisotropy}, `
        + `vsync ${g.vsyncMs}ms — ${g.note}`
      : '',
    report.renderer,
    line(head),
    line(w.map((n) => '-'.repeat(n))),
    ...rows.map(line),
  ].join('\n');
}

/**
 * Entry point for `?bench=1`. Never throws: the runner watches for the JSON
 * marker on the console and a failure has to be visible there too.
 *
 *   ?bench=1                     every situation, default lengths
 *   ?bench=corner,walkout        a subset
 *   &secs=2                      shorten every measured roll (iteration only)
 *   &label=after                 names the JSON the runner writes
 *   &quality=medium              level to draw at (default high)
 */
export async function runBench(canvas: HTMLCanvasElement, arg: string): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  const params = new URLSearchParams(location.search);
  try {
    // `&profile=samples:0,cascades:2` — one-setting A/B on a real GPU
    const profileArg = params.get('profile');
    const over: Record<string, unknown> = {};
    for (const pair of (profileArg ?? '').split(',').filter(Boolean)) {
      const [k, v] = pair.split(':');
      over[k] = v === 'true' ? true : v === 'false' ? false
        : Number.isNaN(Number(v)) ? v : Number(v);
    }
    overrideProfile(profileArg ? over as Partial<QualityProfile> : null);

    const q = params.get('quality');
    const quality: QualityLevel = q === 'medium' || q === 'retro' || q === 'high' ? q : 'high';
    forceQuality(quality);

    const wanted = arg && arg !== '1' && arg !== 'all'
      ? arg.split(',').map((x) => x.trim()).filter(Boolean) : null;
    const secs = Number(params.get('secs') || 0);
    const burst = params.get('burst')?.match(/^(\d+)x(\d+)$/);
    if (burst) { BURST_CHUNKS = Number(burst[1]); BURST_PER_CHUNK = Number(burst[2]); }
    const list = (wanted
      ? wanted.map((n) => {
        const hit = SITUATIONS.find((s) => s.name === n);
        if (!hit) throw new Error(`unknown bench situation "${n}"`);
        return hit;
      })
      : SITUATIONS).map((s) => (secs > 0 ? { ...s, seconds: secs } : s));

    if (skinnedPlayersWanted()) await preloadCharacters();
    await preloadCrowd();   // crowd v2 atlas: never shoot an empty stand

    const pin = pinnedSize(params.get('pin'));
    const results: BenchResult[] = [];
    let buffer = { width: 0, height: 0, ratio: pin?.ratio ?? 0 };
    let gfx: GfxStats | null = null;
    for (const s of list) {
      const out = await runSituation(canvas, s, pin);
      results.push(out.result);
      buffer = out.buffer;
      gfx = out.gfx;
      console.info(`bench ${s.name}: ${out.result.fps.avg}fps `
        + `(1% low ${out.result.fps.low1}), ${out.result.frameMs.avg}ms/frame`);
      await breathe();
    }

    const gl = (canvas.getContext('webgl2') ?? null) as WebGL2RenderingContext | null;
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const report: BenchReport = {
      label: params.get('label') || 'bench',
      at: new Date().toISOString(),
      quality,
      profileOverride: profileArg,
      canvas: {
        cssWidth: pin?.w ?? window.innerWidth,
        cssHeight: pin?.h ?? window.innerHeight,
        ratio: pin?.ratio ?? buffer.ratio,
        width: buffer.width, height: buffer.height,
      },
      window: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      renderer: dbg && gl
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : 'unknown GPU',
      gfx,
      situations: results,
    };

    console.info(benchTable(report));
    // one line, one marker: tools/bench.mjs lifts this straight out of the
    // shell's stdout rather than inventing an IPC channel for it
    console.info(`__SS26_BENCH_JSON__${JSON.stringify(report)}`);
    w.__ss26Bench = { ready: true, report };
  } catch (err) {
    console.error('bench failed:', err);
    console.info(`__SS26_BENCH_JSON__${JSON.stringify({ error: String(err) })}`);
    w.__ss26Bench = { ready: true, error: String(err) };
  }
  // the runner also kills us on a timeout, but leaving on our own is cleaner
  const native = (window as unknown as { ss26Native?: { quit?: () => void } }).ss26Native;
  setTimeout(() => native?.quit?.(), 300);
}
