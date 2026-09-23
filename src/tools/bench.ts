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

import type * as THREE from 'three';
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
/** `&ablate=1`: after the burst, re-run it with one thing switched off at a
 *  time (each composer pass, the shadow pass, each top-level scene group) and
 *  report what each one saved. The pipeline's cost breakdown, on the real GPU. */
let ABLATE = false;
/** `&cpuprof=1`: time the main-thread sections of every paced frame (players,
 *  camera, crowd, shadow prep, each composer pass's submission, ...) by
 *  wrapping the live instances' methods. Nothing in src/render is touched. */
let CPUPROF = false;

/** Wrap obj[name] so every call adds its wall time to acc[label]. Returns the undo. */
function timeMethod(obj: object | null | undefined, name: string, label: string,
  acc: Map<string, number>): () => void {
  const o = obj as Record<string, unknown> | null | undefined;
  const orig = o?.[name];
  if (!o || typeof orig !== 'function') return () => {};
  o[name] = function (this: unknown, ...args: unknown[]) {
    const t0 = performance.now();
    try { return (orig as (...a: unknown[]) => unknown).apply(this, args); }
    finally { acc.set(label, (acc.get(label) ?? 0) + performance.now() - t0); }
  };
  return () => { o[name] = orig; };
}

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
  /** presented intervals over 25 ms: roll index, ms, draw calls, sim steps in */
  spikes: { i: number; ms: number; calls: number; tris: number; sim: number }[];
  /** main-thread cost per presented frame: sim steps, and renderer.update
   *  (animation, skinning, culling and the WebGL submission) */
  cpuMs: { sim: { p50: number; p95: number; max: number }; update: { p50: number; p95: number; max: number } };
  /** `&cpuprof=1` only: mean main-thread ms per paced frame, by section */
  cpuSections?: Record<string, number>;
  /** `&cpuprof=1` only: the sections of every frame whose update ran over 20ms */
  cpuSpikes?: { frame: number; updateMs: number; sections: Record<string, number> }[];
  /** `&ablate=1` only: burst-min ms saved by switching each thing off */
  ablation?: { what: string; savedMs: number; calls: number }[];
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

/** Best-of-chunks burst cost of the settled frame, as the burst phase measures it. */
function burstMin(renderer: GameRenderer, gl: WebGLRenderingContext | WebGL2RenderingContext): { ms: number; calls: number } {
  const info = renderer.sceneMgr.renderer.info;
  let best = Infinity;
  gl.finish();
  for (let c = 0; c < BURST_CHUNKS; c++) {
    const t0 = performance.now();
    for (let i = 0; i < BURST_PER_CHUNK; i++) renderer.renderStillLive();
    gl.finish();
    best = Math.min(best, (performance.now() - t0) / BURST_PER_CHUNK);
  }
  // renderStillLive resets info per frame, so this is ONE frame's calls
  return { ms: best, calls: info.render.calls };
}

/**
 * `&ablate=1` — what each part of the frame costs, by switching it off.
 *
 * GPU timer queries were tried first and are useless here: ANGLE-on-Metal's
 * EXT_disjoint_timer_query_webgl2 reports 30-60ms per pass on a 2.5ms frame.
 * So this is the burst measurement (best of chunks, queue saturated) with one
 * thing off at a time, the baseline re-measured beside every probe. On a
 * loaded machine the small numbers are noise; the big ones are real.
 */
async function ablate(
  renderer: GameRenderer, gl: WebGLRenderingContext | WebGL2RenderingContext,
): Promise<{ what: string; savedMs: number; calls: number }[]> {
  const sm = renderer.sceneMgr;
  const out: { what: string; savedMs: number; calls: number }[] = [];
  const probe = async (what: string, off: () => void, on: () => void): Promise<void> => {
    const base = burstMin(renderer, gl);
    off();
    let cut: { ms: number; calls: number };
    try { cut = burstMin(renderer, gl); } finally { on(); }
    out.push({ what, savedMs: r2(base.ms - cut.ms), calls: base.calls - cut.calls });
    await breathe();
  };
  for (const [i, pass] of sm.composer.passes.entries()) {
    if (i === 0 || !pass.enabled) continue;
    await probe(`pass:${(pass as { constructor: { name: string } }).constructor.name}`,
      () => { pass.enabled = false; }, () => { pass.enabled = true; });
  }
  await probe('shadows', () => { sm.benchSkipShadows = true; }, () => { sm.benchSkipShadows = false; });
  await probe('geometry (all)', () => { sm.scene.visible = false; }, () => { sm.scene.visible = true; });
  // top-level scene children, grouped by name so a thousand loose props are
  // one probe, and only the biggest groups
  const groups = new Map<string, { objs: THREE.Object3D[]; meshes: number }>();
  for (const child of sm.scene.children) {
    if (!child.visible || (child as THREE.Light).isLight) continue;
    let meshes = 0;
    child.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    if (!meshes) continue;
    const key = child.name || `${child.type}:${child.children[0]?.name ?? ''}`;
    const g = groups.get(key) ?? { objs: [], meshes: 0 };
    g.objs.push(child); g.meshes += meshes;
    groups.set(key, g);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].meshes - a[1].meshes).slice(0, 16);
  for (const [key, g] of ranked) {
    await probe(`hide ${key} (${g.objs.length} obj/${g.meshes} mesh)`,
      () => { for (const o of g.objs) o.visible = false; },
      () => { for (const o of g.objs) o.visible = true; });
  }
  return out;
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
  // every presented interval over two vsyncs, with where it fell — a 1% low
  // that is three identical spikes in every run is an EVENT, and the event is
  // found by when it happens, not by how bad the average is
  const spikes: { i: number; ms: number; calls: number; tris: number; sim: number }[] = [];
  // `&cpuprof=1`: the slowest single draw of every frame, so a spike can say
  // WHICH object it was (a first-use compile is one draw taking 100ms)
  const slow = { ms: 0, what: '' };
  if (CPUPROF) {
    const rr = renderer.sceneMgr.renderer as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = rr.renderBufferDirect;
    rr.renderBufferDirect = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      const out = orig.apply(this, args);
      const ms = performance.now() - t0;
      if (ms > slow.ms) {
        const obj = args[4] as THREE.Mesh; const mat = args[3] as THREE.MeshStandardMaterial;
        const path: string[] = [];
        for (let o: THREE.Object3D | null = obj; o; o = o.parent) path.push(o.name || o.type);
        slow.ms = ms;
        slow.what = `${ms.toFixed(1)}ms cam=${(args[0] as THREE.Camera).type} mat=${mat.type}/${mat.name} map=${!!mat.map} at=${mat.alphaTest} obj=${path.join('<')} srcmat=${(obj.material as THREE.Material)?.type}/${(obj.material as THREE.Material)?.name} srcAt=${(obj.material as THREE.MeshStandardMaterial)?.alphaTest} vis=${obj.visible} layers=${obj.layers.mask}`;
      }
      return out;
    };
  }
  const simMs: number[] = [];
  const updMs: number[] = [];
  const secAcc = new Map<string, number>();
  const undo: (() => void)[] = [];
  if (CPUPROF) {
    const sm = renderer.sceneMgr;
    const r = renderer as unknown as Record<string, unknown>;
    renderer.playerMeshes.forEach((pm) => undo.push(timeMethod(pm, 'update', 'players', secAcc)));
    undo.push(timeMethod(renderer.stadium, 'update', 'stadium(crowd)', secAcc));
    undo.push(timeMethod(renderer.cam, 'update', 'camera', secAcc));
    undo.push(timeMethod(r.rain as object, 'update', 'rain', secAcc));
    undo.push(timeMethod(r.divots as object, 'update', 'divots', secAcc));
    undo.push(timeMethod(renderer, 'updateLOD', 'updateLOD', secAcc));
    undo.push(timeMethod(renderer, 'syncLens', 'syncLens', secAcc));
    undo.push(timeMethod(renderer, 'cutscene', 'cutscene', secAcc));
    undo.push(timeMethod(sm.atmos, 'update', 'atmos', secAcc));
    undo.push(timeMethod(sm.scene.userData.ss26Grass as object, 'update', 'grass', secAcc));
    undo.push(timeMethod(sm, 'prepareShadowCasters', 'shadowPrep', secAcc));
    undo.push(timeMethod(sm, 'drawShadows', 'shadows(total)', secAcc));
    undo.push(timeMethod(sm, 'render', 'sceneMgr.render(total)', secAcc));
    sm.composer.passes.forEach((p, i) => undo.push(timeMethod(p, 'render',
      `pass${i}:${(p as { constructor: { name: string } }).constructor.name}`, secAcc)));
    undo.push(timeMethod(match, 'update', 'sim', secAcc));
    undo.push(timeMethod(sm.scene, 'updateMatrixWorld', 'scene.updateMatrixWorld', secAcc));
    undo.push(timeMethod(sm.renderer.shadowMap, 'render', 'shadowMap.render', secAcc));
    let nodes = 0, meshes = 0, bones = 0;
    sm.scene.traverse((o) => { nodes++; if ((o as THREE.Mesh).isMesh) meshes++; if ((o as THREE.Bone).isBone) bones++; });
    secAcc.set(`graph: ${nodes} nodes / ${meshes} meshes / ${bones} bones (x frames)`, 0);
  }
  let profFrames = 0;
  const cpuSpikes: { frame: number; updateMs: number; sections: Record<string, number> }[] = [];

  await new Promise<void>((resolve) => {
    let acc = 0;
    let frame = 0;
    let simSteps = 0;
    let last = performance.now();
    let collecting = false;
    let deadline = 0;
    const prerollUntil = last + PREROLL_MS;

    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.25);
      const interval = now - last;
      last = now;

      // the same loop main.ts runs, minus input and the pause machine
      const tSim = performance.now();
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
          simSteps++;
        }
        if (acc > SIM_DT * 2) acc = SIM_DT * 2;
      }
      const alpha = Math.min(acc / SIM_DT, 1);

      info.reset();
      const tUpd = performance.now();
      const secBefore = CPUPROF ? new Map(secAcc) : null;
      slow.ms = 0; slow.what = '';
      const progsBefore = CPUPROF ? new Set(info.programs ?? []) : null;
      renderer.update(dt, alpha);
      const tEnd = performance.now();
      profFrames++;
      if (secBefore && tEnd - tUpd > 20 && cpuSpikes.length < 12) {
        const sections: Record<string, number> = {};
        for (const [k, v] of secAcc) {
          const d = v - (secBefore.get(k) ?? 0);
          if (d > 0.5) sections[k] = r2(d);
        }
        sections[`SLOWEST DRAW ${slow.what}`] = 0;
        // a first-use shader compile is the usual suspect: name what was built
        for (const pr of info.programs ?? []) {
          if (progsBefore?.has(pr)) continue;
          const p = pr as unknown as { name: string; cacheKey: string };
          sections[`NEW PROGRAM ${p.name}: ${p.cacheKey.slice(0, 200)}`] = 0;
        }
        cpuSpikes.push({ frame: profFrames, updateMs: r2(tEnd - tUpd), sections });
      }

      frame++;
      if (!collecting && (frame >= PREROLL_FRAMES || now >= prerollUntil)) {
        collecting = true;
        deadline = now + s.seconds * 1000;
      } else if (collecting) {
        intervals.push(interval);
        tris.push(info.render.triangles);
        calls.push(info.render.calls);
        simMs.push(tUpd - tSim);
        updMs.push(tEnd - tUpd);
        if (interval > 25) {
          spikes.push({ i: intervals.length - 1, ms: r1(interval), calls: info.render.calls,
            tris: info.render.triangles, sim: simSteps });
        }
      }

      if (!collecting || now < deadline) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  for (const u of undo) u();
  // preroll frames are in the accumulators too, so divide by every frame drawn
  const cpuSections = CPUPROF ? Object.fromEntries([...secAcc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k, r2(v / Math.max(profFrames, 1))])) : undefined;

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

  const ablation = ABLATE ? await ablate(renderer, gl) : undefined;

  info.autoReset = prevAutoReset;
  const buffer = renderer.sceneMgr.bufferSize();
  // taken BEFORE dispose(): under `&pin=off` this is the whole point of the
  // run — what the adaptive valve settled on, and how big the buffer it is
  // feeding the composer really is
  const gfx = renderer.sceneMgr.gfxStats();

  const sortedCost = costs.slice().sort((a, b) => a - b);
  const sortedInterval = intervals.slice().sort((a, b) => a - b);
  const span = intervals.reduce((a, b) => a + b, 0);
  const cpuStat = (xs: number[]): { p50: number; p95: number; max: number } => {
    const so = xs.slice().sort((a, b) => a - b);
    return { p50: r2(pct(so, 0.5)), p95: r2(pct(so, 0.95)), max: r2(Math.max(...xs, 0)) };
  };
  const result: BenchResult = {
    spikes,
    cpuMs: { sim: cpuStat(simMs), update: cpuStat(updMs) },
    cpuSections,
    cpuSpikes: CPUPROF ? cpuSpikes : undefined,
    ablation,
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
    ABLATE = params.get('ablate') === '1';
    CPUPROF = params.get('cpuprof') === '1';
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
