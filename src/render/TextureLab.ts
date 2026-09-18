// TextureLab (§7A.3): the procedural texture bakery.
//
// Every texture the match scene owns is baked here, at load, from ONE seeded
// noise field. That is the whole point: a pitch that is different every boot is
// not art direction, it is a bug you can't reproduce, and the capture contract
// (§7A.9) would lose its meaning. There is no Math.random in this file and
// there never may be — the sim's RNG discipline (core/rng.ts) applies to the
// art pipeline too.
//
// The pattern is lifted from pallet-town-3d's core/TextureLab (MIT, credited in
// CREDITS.md): one lab object per scene, every map derived from a shared noise
// field, every bake timed and reported so the budget is a number and not a
// feeling.
//
// Two rules that are easy to get wrong and expensive to debug:
//
//  • SEAMLESS MEANS TORUS, NOT MIRROR. The lattice the noise is evaluated on
//    wraps modulo its period, so texel (0, y) and texel (W, y) are literally
//    the same sample of the same field. Mirroring or edge-blending gives you a
//    visible seam of symmetry instead of a visible seam of discontinuity, which
//    is worse because it reads as a pattern.
//
//  • ALBEDO AND NORMALS COME FROM THE SAME HEIGHT FIELD. The detail albedo is
//    that height shaded; the detail normal is that height Sobel'd. If they are
//    generated independently the grass lights as if the bumps are somewhere
//    other than where the eye sees them, and no amount of tuning fixes it.

import * as THREE from 'three';
import { RNG } from '../core/rng';
import { maxAnisotropy } from './materials';
import {
  BOX_DEPTH, BOX_HALF_W, CENTER_CIRCLE_R, HALF_L, HALF_W, PENALTY_SPOT,
  PITCH_LENGTH, PITCH_WIDTH, SIX_DEPTH, SIX_HALF_W,
} from '../sim/constants';

/** Fixed. Change this and every baked map in the game changes with it. */
export const LAB_SEED = 0x5_53_26;

/** Metres of apron baked into the pitch macro map, matching the plane. */
export const PITCH_MARGIN = 6;

// ---------------------------------------------------------------- noise field

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * One octave of gradient noise on a PERIODIC lattice — i.e. the field lives on
 * a torus of `period` cells, so sampling x over [0, period) tiles exactly.
 */
class TorusOctave {
  private gx: Float32Array;
  private gy: Float32Array;

  constructor(rng: RNG, private period: number) {
    const n = period * period;
    this.gx = new Float32Array(n);
    this.gy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  private dot(ix: number, iy: number, dx: number, dy: number): number {
    const p = this.period;
    const i = (((iy % p) + p) % p) * p + (((ix % p) + p) % p);
    return this.gx[i] * dx + this.gy[i] * dy;
  }

  /** Roughly [-0.7, 0.7]. x/y are in lattice cells. */
  at(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const n00 = this.dot(xi, yi, xf, yf);
    const n10 = this.dot(xi + 1, yi, xf - 1, yf);
    const n01 = this.dot(xi, yi + 1, xf, yf - 1);
    const n11 = this.dot(xi + 1, yi + 1, xf - 1, yf - 1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  }
}

/**
 * The single noise field every map in the lab samples. Octave k has period
 * `base << k`, so every octave tiles over the same [0,1) domain and the sum
 * does too — which is what makes a two-octave grass height field seamless
 * rather than "seamless if you squint at the low frequency".
 */
class NoiseField {
  private octaves: TorusOctave[] = [];
  private periods: number[] = [];

  constructor(rng: RNG, base: number, count: number) {
    for (let k = 0; k < count; k++) {
      const p = base << k;
      this.periods.push(p);
      this.octaves.push(new TorusOctave(rng, p));
    }
  }

  /** Octave k over a [0,1) uv domain. Every octave spans its own period
   *  exactly once across that domain, so every octave — and therefore any sum
   *  of them — tiles seamlessly. */
  octave(k: number, u: number, v: number): number {
    const p = this.periods[k];
    return this.octaves[k].at(u * p, v * p);
  }
}

// ------------------------------------------------------------------ utilities

interface Mark { map: string; ms: number; count: number; }

/**
 * The REAL clock, grabbed at module load. tools/determinism.ts replaces
 * performance.now with a virtual clock before the first bake runs, and a
 * budget report that says 0.0ms for everything is worse than no report.
 */
const REAL_NOW = performance.now.bind(performance);

const canvas2d = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Baked pitch maps: one macro albedo the plane wears 1:1, one tiling detail
 *  pair that agrees with itself because both come from `height`. */
export interface PitchMaps {
  /** whole-pitch albedo: base grass + macro variation + wear + line markings */
  macro: THREE.CanvasTexture;
  /** tiling grass albedo, blade + clump scale */
  detail: THREE.CanvasTexture;
  /** tiling normal map Sobel'd from the SAME height field as `detail` */
  detailNormal: THREE.CanvasTexture;
  /** how many times `detail`/`detailNormal` repeat across the pitch plane */
  repeat: THREE.Vector2;
}

export interface KitColors {
  shirt: string;
  shorts: string;
  socks: string;
}

/**
 * Where each body part's UVs land in the kit atlas (§7A.2.3). ONE layout,
 * shared by every kit and every team — which is the whole point: a team is a
 * texture swap, and the body geometry is built exactly once for the match.
 * Values are [u0, v0, u1, v1] in atlas space.
 */
export const KIT_UV = {
  shirt: [0.0, 0.0, 0.5, 1.0],
  sleeve: [0.5, 0.5, 0.75, 1.0],
  collar: [0.75, 0.5, 1.0, 1.0],
  shorts: [0.5, 0.0, 0.75, 0.5],
  socks: [0.75, 0.0, 1.0, 0.5],
} as const;

export type KitRegion = keyof typeof KIT_UV;

const KIT_W = 512;
const KIT_H = 512;
/** The per-player shirt back. Small on purpose: 22 of these ship per match. */
const NUM_W = 256;
const NUM_H = 160;

// Tiling detail resolution and the patch of pitch it covers. 4m over 1024px is
// 256 texels per metre — a quarter-centimetre per texel, which is finally finer
// than a blade of grass, so the knee-height camera reads individual leaves in
// the normal map instead of a suggestion of them. (512 was 6cm per feature:
// grain, not grass.) The tile is 4MB; the map it replaces was 1MB.
const DETAIL_PX = 1024;
const DETAIL_M = 4;
// the macro layers are low-frequency by definition, so they are baked small and
// scaled up onto the marking canvas — a 2048x1330 per-pixel noise loop is a
// second of the budget for detail nobody can resolve
const MACRO_PX = 256;
// The macro map carries the LINE MARKINGS, which are the one thing on this
// pitch with a hard edge, and a 105m pitch across 2048px put a 12cm touchline
// inside two texels — so every line in the game was a grey smear at DPR 2.
// 4096 puts it in four and costs 42MB for a map that is baked once.
const PITCH_TEX_W = 4096;

// ------------------------------------------------------------- shell turf
//
// The density map for the shell-textured grass (see render/grass.ts). This is
// NOT a picture of grass — it is the field "how tall is the blade standing at
// this square millimetre", which is the only thing a shell renderer needs:
// shell number k keeps the texels whose blade is at least k/N tall, so one
// texture makes every layer and the blades taper on their own.
//
// 0.5m across 512px is 0.98mm a texel, which is finally finer than the ~3mm
// width of a real blade, so a blade is three texels wide instead of one and
// survives the first mip instead of dissolving into a grey wash.
const SHELL_PX = 512;
/** metres one tile of the shell map covers */
export const SHELL_TILE_M = 0.5;
// Coverage, not botany. A real pitch is ~15k blades/m², but what matters here
// is the TOP-DOWN footprint: a 3mm blade leaning over covers ~0.9cm², and the
// number below puts the lowest shell at ~80% coverage and the top shell at
// ~13%, which is the density that reads as turf rather than as a hairbrush.
const SHELL_BLADES = 6000;

// ------------------------------------------------------------- the bowl
//
// Metres of stand one tile of each stadium map covers. They are exported
// because the tile only lines up with anything if the geometry sets `repeat`
// from the same number the bake laid the tile out with — an aisle every 10m
// and a precast panel 1.5m wide are facts about the STADIUM, not about the
// canvas, and a hardcoded 10 in two files is how they stop agreeing.

/** Width of one terrace tile: 18 seats at ~0.5m plus a ~0.94m aisle. */
export const TERRACE_TILE_M = 10;
/** Side of one facade tile: 8 precast panels across, 4 storeys up. */
export const FACADE_TILE_M = 12;

export class TextureLab {
  private field: NoiseField;
  /** kit / crowd bakes draw from their own stream, so adding a pitch octave
   *  later can't silently reshuffle every shirt in the game */
  private dressRng: RNG;
  private marks: Mark[] = [];
  private pitch: PitchMaps | null = null;
  private kitCache = new Map<string, THREE.CanvasTexture>();
  /** the fabric-weave tile every kit atlas is painted with, baked once */
  private weave: HTMLCanvasElement | null = null;

  constructor(private seed: number = LAB_SEED) {
    const rng = new RNG(seed);
    // 6 octaves from base 4: periods 4, 8, 16, 32, 64, 128 cells over a [0,1)
    // tile. The 6th is new with the 1024px detail map and is APPENDED, so
    // octaves 0-4 draw exactly the gradients they always did and every map
    // that does not ask for octave 5 is bit-identical to before.
    this.field = new NoiseField(rng, 4, 6);
    this.dressRng = new RNG(seed ^ 0x9e3779b9);
  }

  private time<T>(map: string, fn: () => T): T {
    const t0 = REAL_NOW();
    const out = fn();
    const ms = REAL_NOW() - t0;
    // maps of the same kind (twenty-two back numbers, four kit atlases) fold
    // into one row: the budget cares about the line item, not the instance
    const hit = this.marks.find((m) => m.map === map);
    if (hit) { hit.ms += ms; hit.count++; } else this.marks.push({ map, ms, count: 1 });
    return out;
  }

  private cached(key: string, mark: string, bake: () => THREE.CanvasTexture): THREE.CanvasTexture {
    const hit = this.kitCache.get(key);
    if (hit) return hit;
    const tex = this.time(mark, bake);
    this.kitCache.set(key, tex);
    return tex;
  }

  /** The dressing stream, shared by the crowd bakes and the stadium's own
   *  instance placement. One stream, drawn in construction order, so the whole
   *  bowl is a pure function of the lab seed. */
  crowdRng(): RNG {
    return this.dressRng;
  }

  /**
   * A FRESH stream off the lab seed, for callers that want determinism without
   * joining the dressing queue. Anything that draws from crowdRng() shifts
   * every kit and every fan drawn after it, so a new decoration — a band of
   * executive windows, say — either gets its own salt here or silently
   * reshuffles the whole bowl the day it is added.
   */
  stream(salt: number): RNG {
    return new RNG(this.seed ^ salt);
  }

  /** Per-map bake times + the total, against the §7A.3 2s budget. */
  report(): { total: number; maps: Mark[] } {
    const total = this.marks.reduce((a, m) => a + m.ms, 0);
    const lines = this.marks
      .slice()
      .sort((a, b) => b.ms - a.ms)
      .map((m) => `  ${m.map.padEnd(15)}${(m.count > 1 ? `x${m.count}` : '').padEnd(5)}`
        + `${m.ms.toFixed(1).padStart(7)}ms`);
    console.info(`TextureLab bake ${total.toFixed(1)}ms / 2000ms budget`
      + ` — ${total <= 2000 ? 'OK' : 'OVER BUDGET'}\n${lines.join('\n')}`);
    const w = window as unknown as Record<string, unknown>;
    w.__ss26Bake = { total, maps: this.marks.map((m) => ({ ...m })) };
    return { total, maps: this.marks };
  }

  // ------------------------------------------------------------------- pitch

  /**
   * The pitch set. One height field feeds both the tiling albedo and the
   * tiling normal; a separate low-frequency pass kills the visible repeat of
   * that tile, and the line markings are painted on top of the macro map so
   * they stay vector-crisp instead of inheriting the grass resolution.
   */
  pitchMaps(): PitchMaps {
    if (this.pitch) return this.pitch;

    // The browser's 2D canvas backend initialises on first use, and under
    // software rasterization that is over a second — a cost that belongs to
    // the page, not to any one map. Pay it here where the report can name it,
    // rather than silently billing it to whichever bake happens to go first.
    this.time('canvas warm-up', () => {
      const [, ctx] = canvas2d(8, 8);
      ctx.putImageData(ctx.createImageData(8, 8), 0, 0);
    });
    const height = this.time('grass height', () => this.bakeGrassHeight());
    const detail = this.time('grass albedo', () => this.bakeGrassAlbedo(height));
    const detailNormal = this.time('grass normal', () => this.bakeGrassNormal(height));
    const macro = this.time('pitch macro', () => this.bakePitchMacro());

    this.pitch = {
      macro, detail, detailNormal,
      repeat: new THREE.Vector2(
        (PITCH_LENGTH + PITCH_MARGIN * 2) / DETAIL_M,
        (PITCH_WIDTH + PITCH_MARGIN * 2) / DETAIL_M,
      ),
    };
    return this.pitch;
  }

  /**
   * The shell-turf density map (§7A.3, render/grass.ts).
   *
   *   R — blade height at this texel, 0..1. Shell k keeps texels with R ≥ k/N.
   *   G — per-blade random, 0..1. Drives the tip tint so a hundred blades in a
   *       pixel are not a hundred copies of one blade.
   *   B — "tipness": 0 at the root end of the blade's footprint, 1 at the tip.
   *   A — 255 (a canvas texture has no way to say "three channels").
   *
   * Seeded from its own stream, appended after the dressing stream, so adding
   * the grass cannot reshuffle a single shirt in the game.
   *
   * SEAMLESS: every blade is stamped with wrapping coordinates, so the tile
   * repeats across 105m of pitch without a grid of visible edges.
   */
  grassShell(): THREE.CanvasTexture {
    return this.cached('shell', 'grass shells', () => {
      const N = SHELL_PX;
      const h = new Float32Array(N * N);
      const g = new Float32Array(N * N);
      const b = new Float32Array(N * N);
      const rng = new RNG(this.seed ^ 0x51ed270b);

      for (let i = 0; i < SHELL_BLADES; i++) {
        const x0 = rng.next() * N;
        const y0 = rng.next() * N;
        // Lean direction: mostly along the mowing axis (world x, which is the
        // texture's u), because that is what a gang mower leaves, with enough
        // spread that the turf is not a combed carpet.
        const along = rng.next() < 0.5 ? 0 : Math.PI;
        const ang = along + rng.noise() * 0.85;
        // 10-26 texels = 1-2.5cm of top-down footprint, i.e. a 4cm blade
        // leaning between 15° and 40° off vertical
        const len = rng.range(10, 26);
        const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
        // per-blade height, modulated by a clump field so the turf has denser
        // and thinner patches instead of one uniform pile depth
        const clump = this.field.octave(2, x0 / N, y0 / N) * 0.5 + 0.5;
        const hb = Math.min(1, rng.range(0.58, 1.0) * (0.86 + clump * 0.24));
        const rnd = rng.next();
        const wRoot = 1.5, wTip = 0.5;

        // walk the blade, stamping a round cap of the right width at each step
        const steps = Math.ceil(len) + 1;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const cx = x0 + dx * t, cy = y0 + dy * t;
          const w = wRoot + (wTip - wRoot) * t;
          const hv = hb * (0.18 + 0.82 * t);
          const r = Math.ceil(w);
          for (let oy = -r; oy <= r; oy++) {
            for (let ox = -r; ox <= r; ox++) {
              const px = Math.round(cx) + ox, py = Math.round(cy) + oy;
              const d = Math.hypot(px - cx, py - cy);
              if (d > w) continue;
              // wrap: the tile is a torus, same rule as the noise field
              const idx = (((py % N) + N) % N) * N + (((px % N) + N) % N);
              if (hv <= h[idx]) continue;
              h[idx] = hv;
              g[idx] = rnd;
              b[idx] = t;
            }
          }
        }
      }

      const [c, ctx] = canvas2d(N, N);
      const img = ctx.createImageData(N, N);
      const px = img.data;
      for (let i = 0; i < h.length; i++) {
        px[i * 4] = Math.round(clamp01(h[i]) * 255);
        px[i * 4 + 1] = Math.round(clamp01(g[i]) * 255);
        px[i * 4 + 2] = Math.round(clamp01(b[i]) * 255);
        px[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      // DATA, not a picture: an sRGB decode here would bend every shell
      // threshold in the game and the turf would go bald at the top.
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      // 4x, NOT the 16x every other grazing texture in the game gets. This map
      // is read once per shell — seven times a pixel — and the cost of an
      // anisotropic fetch is multiplied by that. Its own content is blade
      // noise at the resolution limit, so the angular refinement buys almost
      // nothing here and costs more than anywhere else in the frame.
      tex.anisotropy = Math.min(4, maxAnisotropy());
      return tex;
    });
  }

  /**
   * Two octaves: blade scale (the grain you see from a knee-height camera) and
   * clump scale (the patchiness that stops a lawn reading as felt). Returned in
   * [0,1] so both the shading and the Sobel pass can use it directly.
   */
  private bakeGrassHeight(): Float32Array {
    const n = DETAIL_PX * DETAIL_PX;
    const h = new Float32Array(n);
    let lo = 1e9, hi = -1e9;
    for (let y = 0; y < DETAIL_PX; y++) {
      const v = y / DETAIL_PX;
      for (let x = 0; x < DETAIL_PX; x++) {
        const u = x / DETAIL_PX;
        // octave 5 = 128 cells over the 4m tile ≈ 3cm leaf, octave 4 ≈ 6cm
        // blade clusters, octave 1 = 8 cells ≈ 50cm clumps. The leaf octave is
        // only affordable at 1024px: at 512 it landed on 4 texels and aliased.
        const leaf = this.field.octave(5, u, v);
        const blade = this.field.octave(4, u, v);
        const clump = this.field.octave(1, u, v);
        const val = leaf * 0.24 + blade * 0.44 + clump * 0.32;
        h[y * DETAIL_PX + x] = val;
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    }
    const inv = 1 / Math.max(hi - lo, 1e-6);
    for (let i = 0; i < n; i++) h[i] = (h[i] - lo) * inv;
    return h;
  }

  /**
   * The height field shaded as grass: darker in the troughs, a touch yellower
   * on the crests. The swing is deliberately tiny — ±6% total. This map is
   * multiplied onto the macro albedo across the WHOLE pitch, and grain that
   * reads as texture at two metres reads as a shag carpet at ten. The relief
   * is the normal map's job; this only has to agree with it.
   */
  private bakeGrassAlbedo(h: Float32Array): THREE.CanvasTexture {
    const [c, ctx] = canvas2d(DETAIL_PX, DETAIL_PX);
    const img = ctx.createImageData(DETAIL_PX, DETAIL_PX);
    const px = img.data;
    for (let i = 0; i < h.length; i++) {
      const t = h[i];
      // sRGB values: the base is neutral mid-grass and the shader multiplies
      // this onto the macro albedo, so what matters is only the RATIO
      const s = 0.965 + t * 0.07;
      px[i * 4] = Math.min(255, 250 * s * (0.985 + t * 0.03));
      px[i * 4 + 1] = Math.min(255, 252 * s);
      px[i * 4 + 2] = Math.min(255, 246 * s * (1.015 - t * 0.03));
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // The detail tile is minified hard at a grazing angle — one texel is under
    // a centimetre and the low-sun camera sees it edge-on for fifty metres.
    // Max anisotropy is what keeps that from turning into a dither pattern.
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy();
    return tex;
  }

  /**
   * Sobel over the same height field, wrapped at the edges so the normal map
   * tiles exactly as the albedo does. This is the map that finally gives the
   * low-sun shot something to rake across.
   */
  private bakeGrassNormal(h: Float32Array): THREE.CanvasTexture {
    const [c, ctx] = canvas2d(DETAIL_PX, DETAIL_PX);
    const img = ctx.createImageData(DETAIL_PX, DETAIL_PX);
    const px = img.data;
    const N = DETAIL_PX;
    const at = (x: number, y: number): number => h[((y + N) % N) * N + ((x + N) % N)];
    // How steep the derived surface is. A Sobel works in TEXELS, so doubling
    // the map to 1024 halved every gradient it measures — the same 0.95 on the
    // finer grid is a visibly flatter pitch. 1.9 puts the blade relief back
    // where it was and the new leaf octave on top of it, which is the "stronger
    // blade detail" half of the uplift. The mowing stripes lean the normal by
    // 0.20 and the grain must stay a texture under them, not a competitor.
    const STRENGTH = 1.9;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        let nx = -dx * STRENGTH, ny = -dy * STRENGTH, nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;
        const i = (y * N + x) * 4;
        px[i] = (nx * 0.5 + 0.5) * 255;
        px[i + 1] = (ny * 0.5 + 0.5) * 255;
        px[i + 2] = (nz * 0.5 + 0.5) * 255;
        px[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    // normal maps are DATA. Decoding one through sRGB is the classic
    // "why is my lighting subtly wrong everywhere" bug.
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    // The detail tile is minified hard at a grazing angle — one texel is under
    // a centimetre and the low-sun camera sees it edge-on for fifty metres.
    // Max anisotropy is what keeps that from turning into a dither pattern.
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy();
    return tex;
  }

  /**
   * The whole-pitch layer: base grass, a low-frequency ±3% variation that kills
   * the repeat of the detail tile, procedural worn areas at both goal mouths
   * and the centre circle, then the line markings painted vector-crisp on top.
   */
  private bakePitchMacro(): THREE.CanvasTexture {
    const texH = Math.round(PITCH_TEX_W * (PITCH_WIDTH + PITCH_MARGIN * 2)
      / (PITCH_LENGTH + PITCH_MARGIN * 2));
    const [c, ctx] = canvas2d(PITCH_TEX_W, texH);

    // --- macro variation + wear, baked small and scaled up
    const mh = Math.round(MACRO_PX * texH / PITCH_TEX_W);
    const [lowC, lowCtx] = canvas2d(MACRO_PX, mh);
    const img = lowCtx.createImageData(MACRO_PX, mh);
    const px = img.data;
    // world extent of the macro canvas, so the wear masks can be placed in metres
    const spanX = PITCH_LENGTH + PITCH_MARGIN * 2;
    const spanY = PITCH_WIDTH + PITCH_MARGIN * 2;
    // worn areas: both goal mouths and the centre spot, as radial falloffs
    // roughened by the same noise field so the edge isn't a perfect circle
    const WEAR: [number, number, number, number][] = [
      [-HALF_L + 1.5, 0, 8.5, 0.62],
      [HALF_L - 1.5, 0, 8.5, 0.62],
      [0, 0, 5.0, 0.30],
    ];
    for (let y = 0; y < mh; y++) {
      const v = y / mh;
      const wy = (v - 0.5) * spanY;
      for (let x = 0; x < MACRO_PX; x++) {
        const u = x / MACRO_PX;
        const wx = (u - 0.5) * spanX;
        // octaves 0/2: metres-to-tens-of-metres blotches, the scale a real
        // pitch varies at between mowing passes
        const macro = this.field.octave(0, u, v) * 0.7 + this.field.octave(2, u, v) * 0.3;
        // ±3%, exactly as the spec asks — any more and it reads as dirt
        const lift = 1 + macro * 0.06;

        let wear = 0;
        for (const [cx, cy, r, amt] of WEAR) {
          const d = Math.hypot(wx - cx, wy - cy) / r;
          // the noise term pushes the boundary in and out by ~15% of the radius
          const edge = d * (1 + this.field.octave(3, u, v) * 0.3);
          wear = Math.max(wear, amt * (1 - clamp01(edge)) ** 1.6);
        }

        // base grass, warmed and desaturated toward bare earth by `wear`
        const gr = 44 * lift, gg = 112 * lift, gb = 52 * lift;
        const dr = 150, dg = 126, db = 76;
        const i = (y * MACRO_PX + x) * 4;
        px[i] = gr + (dr - gr) * wear;
        px[i + 1] = gg + (dg - gg) * wear;
        px[i + 2] = gb + (db - gb) * wear;
        px[i + 3] = 255;
      }
    }
    lowCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(lowC, 0, 0, PITCH_TEX_W, texH);

    // --- line markings, in metres, painted last so nothing softens them
    paintMarkings(ctx, PITCH_TEX_W, texH);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // the macro map IS the line markings, and the markings are what a low
    // camera sees edge-on for eighty metres — this is the single most
    // anisotropy-hungry texture in the game
    tex.anisotropy = maxAnisotropy();
    return tex;
  }

  // --------------------------------------------------------------- kit atlas

  /**
   * The team's kit atlas: shirt / sleeve / collar / shorts / socks composited
   * onto the shared KIT_UV layout from nothing but the two hex colours in
   * teams.json. One of these per KIT in the match — four, not twenty-two —
   * because per-team appearance is a texture swap and nothing else.
   */
  kitAtlas(kit: KitColors): THREE.CanvasTexture {
    const key = `kit|${kit.shirt}|${kit.shorts}|${kit.socks}`;
    const hit = this.kitCache.get(key);
    if (hit) return hit;

    const tex = this.time('kit atlas', () => {
      const [c, ctx] = canvas2d(KIT_W, KIT_H);
      const trim = luminance(kit.shirt) > 0.55 ? shade(kit.shirt, -0.45) : shade(kit.shirt, 0.5);
      this.paintKitRegion(ctx, KIT_UV.shirt, kit.shirt, 1);
      this.paintKitRegion(ctx, KIT_UV.sleeve, shade(kit.shirt, -0.08), 0.85);
      this.paintKitRegion(ctx, KIT_UV.collar, trim, 0.7);
      this.paintKitRegion(ctx, KIT_UV.shorts, kit.shorts, 1);
      this.paintKitRegion(ctx, KIT_UV.socks, kit.socks, 0.9);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    });

    this.kitCache.set(key, tex);
    return tex;
  }

  /** The player's shirt back — name and number, printed at load (§7A.2.3).
   *  Its own small texture so the 512² kit atlas stays shared by the team. */
  backNumber(kit: KitColors, player: { name: string; num: number }): THREE.CanvasTexture {
    const key = `num|${kit.shirt}|${player.num}|${player.name}`;
    const hit = this.kitCache.get(key);
    if (hit) return hit;

    const tex = this.time('back number', () => {
      const [c, ctx] = canvas2d(NUM_W, NUM_H);
      this.paintKitRegion(ctx, [0, 0, 1, 1], kit.shirt, 1);
      ctx.fillStyle = luminance(kit.shirt) > 0.5 ? '#12141a' : '#f4f6fa';
      ctx.textAlign = 'center';
      const short = (player.name.split(' ').pop() ?? '').toUpperCase().slice(0, 11);
      ctx.font = `bold ${Math.round(NUM_H * 0.17)}px Helvetica, Arial, sans-serif`;
      ctx.fillText(short, NUM_W / 2, NUM_H * 0.24);
      ctx.font = `bold ${Math.round(NUM_H * 0.58)}px Helvetica, Arial, sans-serif`;
      ctx.fillText(String(player.num), NUM_W / 2, NUM_H * 0.86);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    });

    this.kitCache.set(key, tex);
    return tex;
  }

  /** One atlas region: flat colour, a cloth light-ramp, then the weave. */
  private paintKitRegion(ctx: CanvasRenderingContext2D,
    r: readonly [number, number, number, number] | number[], color: string, shading: number): void {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const x = r[0] * w, y = (1 - r[3]) * h;
    const rw = (r[2] - r[0]) * w, rh = (r[3] - r[1]) * h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, rw, rh);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, rw, rh);
    // cloth doesn't light flat: a top-to-bottom ramp is the cheapest thing
    // that stops a shirt reading as a coloured sticker
    const g = ctx.createLinearGradient(x, y, x, y + rh);
    g.addColorStop(0, `rgba(255,255,255,${0.13 * shading})`);
    g.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.20 * shading})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, rw, rh);
    // the weave itself, tiled — at broadcast distance this is what separates
    // "fabric" from "plastic"
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = ctx.createPattern(this.fabricWeave(), 'repeat')!;
    ctx.fillRect(x, y, rw, rh);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** A small seeded weave tile, baked once and reused by every kit region. */
  private fabricWeave(): HTMLCanvasElement {
    if (this.weave) return this.weave;
    this.time('fabric weave', () => {
      const N = 32;
      const [c, ctx] = canvas2d(N, N);
      const img = ctx.createImageData(N, N);
      const px = img.data;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          // a knit is a grid plus noise; the grid is what the eye reads as cloth
          const knit = ((x & 1) ^ (y & 1)) ? 0.55 : 0.45;
          const n = this.field.octave(4, x / N, y / N) * 0.5 + 0.5;
          const a = (knit * 0.5 + n * 0.5 - 0.5) * 90;
          const i = (y * N + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = a > 0 ? 255 : 0;
          px[i + 3] = Math.min(255, Math.abs(a) * 2.2);
        }
      }
      ctx.putImageData(img, 0, 0);
      this.weave = c;
    });
    return this.weave!;
  }

  // ------------------------------------------------------------------- crowd

  /**
   * The crowd card atlas (§7A.5): four frames of the same little cluster of
   * fans, each frame a different sway/arms pose. Instances pick a frame by
   * phase, which is what stops a whole stand moving as one object.
   */
  crowdAtlas(night: boolean): THREE.CanvasTexture {
    return this.cached(`crowd|${night}`, 'crowd cards', () => {
      // 128px a frame: at the celebration camera a card is ~60 screen pixels
      // wide, and 96 was visibly chunky there
      const FW = 128, FH = 128, FRAMES = 4;
      const [c, ctx] = canvas2d(FW * FRAMES, FH);
      const skin = ['#e8bb92', '#c68642', '#8d5524', '#5c3a21', '#f1c27d'];
      const shirts = ['#d8dce4', '#8a93a8', '#b8563e', '#3e6cb8', '#d4c04a',
        '#5a9950', '#e8e8f0', '#7a4a7e', '#2f3a4c', '#c85a2c'];
      const rng = this.dressRng;
      for (let f = 0; f < FRAMES; f++) {
        const ox = f * FW;
        // sway/cheer: frame index drives lean and how far the arms are up
        const lean = Math.sin((f / FRAMES) * Math.PI * 2) * 5;
        const arms = f === 1 || f === 2 ? 1 : 0;
        // 4 rows of fans per card, back rows darker (they sit further up
        // the rake and catch less light)
        for (let row = 3; row >= 0; row--) {
          const rowY = FH - 16 - row * 26;
          const dim = 1 - row * 0.13;
          for (let i = 0; i < 5; i++) {
            const bx = ox + 7 + i * 23 + rng.range(-3, 3) + lean * (1 - row * 0.25);
            const body = shirts[(rng.next() * shirts.length) | 0];
            ctx.globalAlpha = (night ? 0.72 : 0.92) * dim;
            // torso
            ctx.fillStyle = body;
            ctx.fillRect(bx, rowY, 15, 22);
            // head
            ctx.fillStyle = skin[(rng.next() * skin.length) | 0];
            ctx.fillRect(bx + 4, rowY - 10, 8, 9);
            // arms — up on the cheer frames, down otherwise
            ctx.fillStyle = body;
            if (arms) {
              ctx.fillRect(bx - 2.5, rowY - 13, 4, 15);
              ctx.fillRect(bx + 13.5, rowY - 13, 4, 15);
            } else {
              ctx.fillRect(bx - 2.5, rowY + 2, 4, 15);
              ctx.fillRect(bx + 13.5, rowY + 2, 4, 15);
            }
          }
        }
        ctx.globalAlpha = 1;
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  /**
   * The v1.1 crowd texture, preserved for RETRO (§7A.7): thousands of 2px fan
   * blobs on a terraced grid, one quad per rake. Seeded now — the old version
   * sprayed it with Math.random, which is exactly the thing this file exists
   * to stop.
   */
  retroCrowdTexture(dark: boolean): THREE.CanvasTexture {
    return this.cached(`retroCrowd|${dark}`, 'retro crowd', () => {
      const [c, ctx] = canvas2d(512, 128);
      const rng = this.dressRng;
      ctx.fillStyle = dark ? '#12151d' : '#1e232d';
      ctx.fillRect(0, 0, c.width, c.height);
      const palette = ['#c8ccd4', '#8a93a8', '#b8563e', '#3e6cb8', '#d4c04a',
        '#5a9950', '#d8d8e0', '#7a4a7e'];
      const ROW_H = 8, SEAT_W = 5;
      for (let row = 0; row < c.height / ROW_H; row++) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, row * ROW_H + ROW_H - 1, c.width, 1.5);
        for (let seat = 0; seat < c.width / SEAT_W; seat++) {
          if (rng.next() < 0.06) continue;
          const x = seat * SEAT_W + rng.next() * 1.5;
          const y = row * ROW_H + 1 + rng.next() * 1.5;
          ctx.fillStyle = palette[(rng.next() * palette.length) | 0];
          ctx.globalAlpha = dark ? 0.6 + rng.next() * 0.3 : 0.8 + rng.next() * 0.2;
          ctx.fillRect(x, y + 2, 3.4, 4);
          ctx.fillStyle = ['#e0b08c', '#c68642', '#8d5524', '#5c3a21'][(rng.next() * 4) | 0];
          ctx.fillRect(x + 0.7, y, 2, 2.2);
        }
      }
      ctx.globalAlpha = 1;
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  /**
   * The v1.1 grass grain, for the RETRO pitch (§7A.7): 60k 2px flecks sprayed
   * over a flat canvas. Seeded here rather than left on Math.random, because
   * "no unseeded randomness in the bakery" has to hold for the level we keep
   * around as a feature too.
   */
  retroGrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.time('retro grain', () => {
      const rng = new RNG(this.seed ^ 0x1e5b0a1f);
      for (let i = 0; i < 60000; i++) {
        const x = rng.next() * w, y = rng.next() * h;
        ctx.fillStyle = rng.next() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)';
        ctx.fillRect(x, y, 2, 2);
      }
    });
  }

  /** A waving-flag panel: kit-coloured field with a lighter bar, tinted
   *  per instance so one texture serves every team. */
  flagTexture(): THREE.CanvasTexture {
    return this.cached('flag', 'crowd flags', () => {
      const [c, ctx] = canvas2d(64, 40);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 64, 40);
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.fillRect(0, 15, 64, 10);
      // a soft vertical shade so the cloth doesn't read as a flat card
      const g = ctx.createLinearGradient(0, 0, 64, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.28)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 40);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  /** Radial falloff for the additive floodlight flares (§7A.5, night only). */
  flareTexture(): THREE.CanvasTexture {
    return this.cached('flare', 'lens flare', () => {
      // 256, not 128: this sprite is drawn 22 metres wide and a night goal
      // package puts it a few metres from the lens, where a 128px radial ramp
      // is a visibly stepped disc.
      const N = 256;
      const [c, ctx] = canvas2d(N, N);
      const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
      g.addColorStop(0, 'rgba(255,252,240,1)');
      g.addColorStop(0.18, 'rgba(255,244,214,0.55)');
      g.addColorStop(0.5, 'rgba(190,214,255,0.13)');
      g.addColorStop(1, 'rgba(140,180,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, N, N);

      // The STARBURST. A floodlight through a real broadcast lens does not
      // make a disc: the iris blades diffract it into an even number of
      // spokes, and that shape is most of what says "this is a photograph of a
      // very bright light" rather than "this is a white circle". Six blades,
      // so twelve spokes, at two lengths so the pattern is not a snowflake.
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(N / 2, N / 2);
      const SPOKES = 12;
      for (let i = 0; i < SPOKES; i++) {
        const long = i % 2 === 0;
        const len = (N / 2) * (long ? 0.98 : 0.54);
        const halfWidth = long ? 0.020 : 0.013;
        ctx.save();
        ctx.rotate((i / SPOKES) * Math.PI * 2 + 0.13);
        // a spike is a triangle with a gradient along it, not a stroked line:
        // it has to be wide and bright at the core and vanish to nothing
        const sg = ctx.createLinearGradient(0, 0, len, 0);
        sg.addColorStop(0, 'rgba(255,250,235,0.85)');
        sg.addColorStop(0.22, 'rgba(255,246,220,0.22)');
        sg.addColorStop(1, 'rgba(200,220,255,0)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.moveTo(0, -N * halfWidth);
        ctx.lineTo(len, 0);
        ctx.lineTo(0, N * halfWidth);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  /**
   * The anamorphic streak: the long horizontal smear a broadcast lens lays
   * across a floodlight. Separate from the flare because it is drawn on a
   * sprite with a 15:1 aspect — one texture cannot be both, and stretching the
   * radial one sideways gives an obvious ellipse instead of a streak.
   */
  streakTexture(): THREE.CanvasTexture {
    return this.cached('streak', 'lens streak', () => {
      const W = 512, H = 64;
      const [c, ctx] = canvas2d(W, H);
      const img = ctx.createImageData(W, H);
      const px = img.data;
      for (let y = 0; y < H; y++) {
        // across the streak: a tight core that stays a couple of pixels wide
        const dy = Math.abs(y - (H - 1) / 2) / (H / 2);
        const across = Math.exp(-dy * dy * 26);
        for (let x = 0; x < W; x++) {
          const dx = Math.abs(x - (W - 1) / 2) / (W / 2);
          // along it: a fast core falloff plus a long low tail, which is what
          // makes a streak read as long rather than as a fat ellipse
          const along = Math.exp(-dx * 7.5) * 0.85 + (1 - dx) ** 3 * 0.15;
          const a = clamp01(across * along);
          const i = (y * W + x) * 4;
          // cool at the tips, neutral at the core: real anamorphic flare is
          // famously blue, and a pure white smear looks like a smudge
          px[i] = 255;
          px[i + 1] = Math.round(246 - dx * 30);
          px[i + 2] = Math.round(226 + dx * 29);
          px[i + 3] = Math.round(a * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  /**
   * The slide-tackle scuff (§7A.3c, render/divots.ts): one gouge, drawn along
   * +U, worn by every divot instance on the pitch.
   *
   * SHAPE. A slide does not leave a stripe of even width. The boot digs in at
   * the heel, the studs peel the mat back over the next half-metre, and the
   * mark thins to nothing as the player's weight comes off it — so the width
   * profile ramps hard over the first fifth of the texture and then decays,
   * which is what makes an instance read as "something moved through here"
   * rather than as a rectangle someone painted on the grass.
   *
   * COLOUR AND ALPHA CARRY DIFFERENT THINGS. Alpha is coverage: how much turf
   * is actually gone. Colour is what is underneath, and it is not one colour —
   * the middle is wet soil and the rim is TORN TURF, the pale straw-green of
   * roots and stalk pulled sideways and left lying. That rim is a couple of
   * centimetres wide in the world and it is the whole difference between a
   * divot and a dirty smudge, so it gets its own colour ramp keyed off the
   * same coverage that fades the alpha out.
   *
   * The noise is a LOCAL hash, not the lab's dressing stream: consuming
   * `dressRng` here would reshuffle every kit and every crowd in the game to
   * pay for one 256x64 map.
   */
  scuffTexture(): THREE.CanvasTexture {
    return this.cached('scuff', 'tackle scuff', () => {
      // 4:1, which is the aspect the quad is drawn at (~2.0m x 0.45m). The map
      // is never seen closer than a boot away and is stretched along its
      // length by the instance, so 256 across the long axis is already finer
      // than the pitch's own macro albedo under it.
      const W = 256, H = 64;
      const [c, ctx] = canvas2d(W, H);
      const img = ctx.createImageData(W, H);
      const px = img.data;

      const hash = (i: number, j: number): number => {
        const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
        return s - Math.floor(s);
      };
      const noise = (x: number, y: number): number => {
        const i = Math.floor(x), j = Math.floor(y);
        const fx = x - i, fy = y - j;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * sx;
        const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * sx;
        return a + (b - a) * sy;
      };

      // Three materials, inside out: a NARROW soil gouge where the hip and
      // the trailing boot actually cut the mat, a halo of dry flattened grass
      // around it (paler and yellower than the turf, broken up so the pitch
      // shows through), and a few stud-drag streaks. The first cut of this
      // map was one soft dark ellipse, and from any broadcast camera it read
      // as a shadow that had lost its owner.
      const SOIL = [0.30, 0.215, 0.135];
      const DRY = [0.62, 0.60, 0.33];

      const smooth = (e0: number, e1: number, x: number): number => {
        const t = clamp01((x - e0) / (e1 - e0));
        return t * t * (3 - 2 * t);
      };

      for (let y = 0; y < H; y++) {
        // -1 .. 1 across the mark
        const v = ((y + 0.5) / H) * 2 - 1;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W; // 0 at the heel, 1 at the toe
          // ramp in over the first fifth, then decay: the heel is the deepest
          // part of a slide and the tail is where the weight came off
          const along = Math.min(1, u / 0.17) * (1 - u) ** 0.6;
          // Ragged edges as TWO wanders that are functions of u alone, one per
          // side, so the mark stays centred and inside the map (see the git
          // history of this bake for why a noise sampled at (u, v) does not).
          const eA = 0.34 + 0.30 * noise(u * 8.5, 3.7);
          const eB = 0.34 + 0.30 * noise(u * 8.5, 9.1);
          const haloHalf = along * (v < 0 ? eA : eB);          // ≤ 0.64
          const coreHalf = along * (0.075 + 0.05 * noise(u * 14, 5.5));
          const a = Math.abs(v);

          // the gouge: hard-edged, wobbling along its length
          const wob = 0.06 * (noise(u * 6, 17.2) - 0.5);
          const core = smooth(coreHalf + 0.02, coreHalf - 0.02, a - wob);
          // the halo: crisp outline, then streaky along u so blades show
          // through — a flattened patch is not a solid stain
          let halo = smooth(haloHalf + 0.03, haloHalf - 0.03, a);
          const streak = noise(u * 30, v * 7 + 11.3) * 0.6 + noise(u * 90, v * 3 + 41.7) * 0.4;
          halo *= smooth(0.34, 0.70, streak);
          // stud drags: three thin dark lines wandering along the mark
          let drag = 0;
          for (let k = 0; k < 3; k++) {
            const off = (k - 1) * 0.22 + 0.10 * (noise(u * 5, 23.1 + k * 7.7) - 0.5);
            const w = 0.028;
            drag = Math.max(drag, smooth(w, w * 0.4, Math.abs(v - off)) * smooth(0.25, 0.55, noise(u * 20, 61 + k * 3)));
          }
          drag *= along * smooth(0.02, 0.2, a - coreHalf);   // only outside the gouge

          // composite: soil over dry grass, drags on top of the halo
          const soilW = Math.max(core, drag * 0.7);
          const cov = Math.max(soilW * 0.95, halo * 0.55);
          const mix = cov > 1e-4 ? (soilW * 0.95) / cov : 0;
          const r = DRY[0] + (SOIL[0] - DRY[0]) * mix;
          const g = DRY[1] + (SOIL[1] - DRY[1]) * mix;
          const b = DRY[2] + (SOIL[2] - DRY[2]) * mix;

          const i = (y * W + x) * 4;
          px[i] = Math.round(clamp01(r) * 255);
          px[i + 1] = Math.round(clamp01(g) * 255);
          px[i + 2] = Math.round(clamp01(b) * 255);
          px[i + 3] = Math.round(clamp01(cov) * 255);
        }
      }
      ctx.putImageData(img, 0, 0);

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      // the mark is seen edge-on from every broadcast camera there is
      tex.anisotropy = maxAnisotropy();
      // CLAMP, both axes: a decal that wraps tiles its own torn edge back onto
      // itself at the seam, which reads as two divots end to end
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    });
  }

  /**
   * ONE ROW of a terrace, tiled up the rake and along the stand (§7A.5).
   *
   * The tile is exactly one seat row deep and TERRACE_TILE_M of stand wide,
   * which is what lets stadium.ts set `repeat.y` to the crowd's own row count:
   * a seat then lands under every figure instead of near it, and the fans read
   * as sitting IN the terrace rather than on a slab painted to look like one.
   *
   * Three things carry the read at broadcast distance, in this order: the dark
   * band across the back of every row (the riser in its own shade — this is
   * the per-row AO, and it is the whole illusion of steps on a flat plane),
   * the vertical gaps between seat backs, and the aisle, which is a stair
   * because the tile repeats and the tread/riser pair repeats with it.
   *
   * Seeded per seat: a little lightness jitter and the odd folded-up seat, so
   * a 130m stand is not one colour swatch stretched thirteen times.
   */
  terraceSeats(seatHex: string): THREE.CanvasTexture {
    return this.cached(`seats|${seatHex}`, 'terrace seats', () => {
      const W = 1024, H = 128;
      const [c, ctx] = canvas2d(W, H);
      // its OWN stream: drawing from dressRng here would reshuffle every kit
      // and every fan in the game the first time a stand changed colour
      const rng = new RNG(this.seed ^ 0x5ea70a15);
      const seat = new THREE.Color(seatHex);
      const css = (col: THREE.Color, k: number): string =>
        `rgb(${Math.round(clamp01(col.r * k) * 255)},`
        + `${Math.round(clamp01(col.g * k) * 255)},`
        + `${Math.round(clamp01(col.b * k) * 255)})`;

      // canvas TOP is v=1, and the terrace plane's +v points at the pitch —
      // so y=0 here is the FRONT (low) edge of the row and y=H the back (high)
      const TREAD = 26;      // concrete in front of the seat
      const SEAT_T = 30, SEAT_B = 94;
      const AISLE = 96;      // ~0.94m of the 10m tile
      const SEATS = 18;
      const seatW = (W - AISLE) / SEATS;

      ctx.fillStyle = '#4b515c';
      ctx.fillRect(0, 0, W, H);
      // the nosing: the lit front lip of this row's tread
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(0, 0, W, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, 4, W, TREAD - 4);

      // the aisle is a flight of stairs: one tread + one riser per tile
      ctx.fillStyle = '#5d646f';
      ctx.fillRect(0, 0, AISLE, H);
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fillRect(0, 2, AISLE, 30);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(AISLE - 3, 0, 3, H);

      for (let i = 0; i < SEATS; i++) {
        const x0 = AISLE + i * seatW;
        const k = rng.range(0.86, 1.12);
        // a folded-up / missing seat every twenty-odd: the stand is used
        const empty = rng.next() < 0.05;
        if (empty) {
          ctx.fillStyle = 'rgba(0,0,0,0.42)';
          ctx.fillRect(x0 + 3, SEAT_T + 14, seatW - 6, SEAT_B - SEAT_T - 14);
          continue;
        }
        ctx.fillStyle = css(seat, k);
        ctx.fillRect(x0 + 3, SEAT_T, seatW - 6, SEAT_B - SEAT_T);
        // the moulded top edge catches the sky, the base sits in its own shade
        ctx.fillStyle = css(seat, k * 1.26);
        ctx.fillRect(x0 + 3, SEAT_T, seatW - 6, 7);
        ctx.fillStyle = css(seat, k * 0.55);
        ctx.fillRect(x0 + 3, SEAT_B - 11, seatW - 6, 11);
        // the shadow one seat casts into the gap beside it
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.fillRect(x0 + seatW - 5, SEAT_T + 2, 2, SEAT_B - SEAT_T - 2);
      }

      // THE per-row AO: the riser behind this row, in the shade of the row
      // above it. Everything above is detail; this is what makes it a step.
      const ao = ctx.createLinearGradient(0, SEAT_B - 6, 0, H);
      ao.addColorStop(0, 'rgba(0,0,0,0.10)');
      ao.addColorStop(0.55, 'rgba(0,0,0,0.46)');
      ao.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = ao;
      ctx.fillRect(0, SEAT_B - 6, W, H - SEAT_B + 6);

      // seeded grime, so the tile does not read as a repeated stamp
      for (let i = 0; i < 260; i++) {
        const x = rng.next() * W, y = rng.next() * H;
        ctx.fillStyle = rng.next() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.05)';
        ctx.fillRect(x, y, rng.range(2, 9), rng.range(1, 4));
      }

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      // a rake is seen at a grazing angle from every camera in the game
      tex.anisotropy = maxAnisotropy();
      return tex;
    });
  }

  /**
   * The concrete outside of a stand: precast panel joints, floor bands and
   * stairwell glazing. The back walls and the exterior pilasters wear it, and
   * it is the only thing between the establishing shot and four black slabs.
   * One tile covers FACADE_TILE_M square.
   */
  standFacade(): THREE.CanvasTexture {
    return this.cached('facade', 'stand facade', () => {
      const N = 512;
      const [c, ctx] = canvas2d(N, N);
      const rng = new RNG(this.seed ^ 0x0fac1de5);
      ctx.fillStyle = '#39404d';
      ctx.fillRect(0, 0, N, N);

      // precast panels: 8 columns, 4 floors over the tile
      const PW = N / 8, PH = N / 4;
      for (let fy = 0; fy < 4; fy++) {
        for (let fx = 0; fx < 8; fx++) {
          const x = fx * PW, y = fy * PH;
          ctx.fillStyle = `rgba(255,255,255,${rng.range(0.01, 0.055).toFixed(3)})`;
          ctx.fillRect(x, y, PW, PH);
          // panel joint: a dark shadow line with a lit lip under it
          ctx.fillStyle = 'rgba(0,0,0,0.42)';
          ctx.fillRect(x, y, 2, PH);
          ctx.fillRect(x, y, PW, 3);
          ctx.fillStyle = 'rgba(255,255,255,0.09)';
          ctx.fillRect(x + 2, y + 3, PW - 2, 2);
        }
        // the floor band: a deeper recess every storey, with glazing in it
        const by = fy * PH + PH * 0.30;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, by, N, PH * 0.26);
        for (let w = 0; w < 16; w++) {
          const x = w * (N / 16) + 4;
          ctx.fillStyle = `rgba(14,18,26,${rng.range(0.55, 0.9).toFixed(2)})`;
          ctx.fillRect(x, by + 3, N / 16 - 9, PH * 0.26 - 6);
          ctx.fillStyle = 'rgba(150,175,205,0.10)';
          ctx.fillRect(x, by + 3, N / 16 - 9, 3);
        }
      }
      // weather: streaks running down from the bands
      for (let i = 0; i < 90; i++) {
        const x = rng.next() * N;
        const y = rng.next() * N;
        ctx.fillStyle = `rgba(0,0,0,${rng.range(0.03, 0.10).toFixed(3)})`;
        ctx.fillRect(x, y, rng.range(1, 4), rng.range(8, 48));
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = Math.min(4, maxAnisotropy());
      return tex;
    });
  }

  /**
   * One LED board: the message repeated end to end so the texture can be
   * scrolled on wrapS without the text ever tearing at the seam.
   */
  adTexture(text: string): THREE.CanvasTexture {
    return this.cached(`ad|${text}`, 'ad board', () => {
      const W = 512, H = 48;
      const [c, ctx] = canvas2d(W, H);
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#0c2b6b');
      grad.addColorStop(1, '#081d49');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // faint LED pixel grid — the thing that says "board", not "poster"
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      for (let x = 0; x < W; x += 4) ctx.fillRect(x, 0, 1, H);
      for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e8f0ff';
      // Drawn twice, half a texture apart; each board shows half the texture,
      // so a wrapping offset crawls the message past with no seam. The type
      // has to FIT inside its half with room to spare or the two copies
      // overlap and the crawl reads as two collided half-words.
      let size = 30;
      ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
      const room = W * 0.42;
      const w0 = ctx.measureText(text).width;
      if (w0 > room) {
        size = Math.max(14, Math.floor(size * room / w0));
        ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
      }
      ctx.fillText(text, W * 0.25, H / 2);
      ctx.fillText(text, W * 0.75, H / 2);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      return tex;
    });
  }

  /**
   * The >60m impostor (§7A.2): a whole player, kit-coloured, on one card. At
   * that range a player is ~30px tall, which a billboard carries perfectly
   * well and 900 triangles carries no better.
   */
  impostor(kit: KitColors): THREE.CanvasTexture {
    const key = `imp|${kit.shirt}|${kit.shorts}|${kit.socks}`;
    const hit = this.kitCache.get(key);
    if (hit) return hit;
    const tex = this.time('impostor card', () => {
      const W = 64, H = 128;
      const [c, ctx] = canvas2d(W, H);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const SKIN = '#c08a5e';
      // Proportions match the mesh, so the tier swap doesn't pop in size, and
      // the shoulder line tapers the same way — a rectangle where the torso
      // should be is exactly what makes a billboard read as a sticker.
      const limb = (x: number, y: number, w: number, h: number, col: string): void => {
        ctx.fillStyle = col;
        ctx.fillRect(x, y, w, h);
      };
      limb(cx - 11, 96, 8, 26, kit.socks);
      limb(cx + 3, 96, 8, 26, kit.socks);
      limb(cx - 12, 120, 10, 6, '#16181c');
      limb(cx + 2, 120, 10, 6, '#16181c');
      limb(cx - 11, 74, 8, 24, SKIN);
      limb(cx + 3, 74, 8, 24, SKIN);
      limb(cx - 13, 62, 26, 21, kit.shorts);
      // torso: a trapezium, wider at the shoulders
      ctx.fillStyle = kit.shirt;
      ctx.beginPath();
      ctx.moveTo(cx - 14, 28); ctx.lineTo(cx + 14, 28);
      ctx.lineTo(cx + 12, 64); ctx.lineTo(cx - 12, 64);
      ctx.closePath(); ctx.fill();
      limb(cx - 20, 29, 7, 21, kit.shirt);
      limb(cx + 13, 29, 7, 21, kit.shirt);
      limb(cx - 20, 49, 6, 15, SKIN);
      limb(cx + 14, 49, 6, 15, SKIN);
      limb(cx - 7, 9, 14, 19, SKIN);
      limb(cx - 7, 6, 14, 8, '#2b1f18');
      // form shading: light from the top-left, dark down the right edge. It is
      // the crudest possible lighting model and at thirty pixels tall it is
      // indistinguishable from the real one.
      ctx.globalCompositeOperation = 'source-atop';
      const g = ctx.createLinearGradient(cx - 22, 0, cx + 22, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.16)');
      g.addColorStop(0.45, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.34)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
    this.kitCache.set(key, tex);
    return tex;
  }

  /** Free everything the lab minted. The scene traversal in SceneManager
   *  disposes what is attached to the scene; these caches are ours. */
  dispose(): void {
    for (const t of this.kitCache.values()) t.dispose();
    this.kitCache.clear();
    if (this.pitch) {
      this.pitch.macro.dispose();
      this.pitch.detail.dispose();
      this.pitch.detailNormal.dispose();
      this.pitch = null;
    }
  }
}

// ------------------------------------------------------------- line markings

/**
 * The §7.1 markings, in metres, onto a canvas of the given size. Split out of
 * the pitch builder so the macro bake owns the whole albedo and RETRO can still
 * paint the same lines onto its own flat canvas.
 */
export function paintMarkings(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const spanX = PITCH_LENGTH + PITCH_MARGIN * 2;
  const mPx = w / spanX;
  const toTex = (x: number, y: number): [number, number] => [
    ((x + HALF_L + PITCH_MARGIN) / spanX) * w,
    ((y + HALF_W + PITCH_MARGIN) / (PITCH_WIDTH + PITCH_MARGIN * 2)) * h,
  ];

  ctx.strokeStyle = 'rgba(250,250,250,0.92)';
  ctx.lineWidth = 0.13 * mPx * 2;
  ctx.lineCap = 'round';

  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    const [a, b] = toTex(x1, y1);
    const [c, d] = toTex(x2, y2);
    ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
  };
  const rect = (x: number, y: number, rw: number, rh: number): void => {
    line(x, y, x + rw, y); line(x + rw, y, x + rw, y + rh);
    line(x + rw, y + rh, x, y + rh); line(x, y + rh, x, y);
  };
  const circle = (x: number, y: number, r: number, a0 = 0, a1 = Math.PI * 2): void => {
    const [cx, cy] = toTex(x, y);
    ctx.beginPath(); ctx.arc(cx, cy, r * mPx, a0, a1); ctx.stroke();
  };
  const spot = (x: number, y: number): void => {
    const [cx, cy] = toTex(x, y);
    ctx.beginPath(); ctx.arc(cx, cy, 0.22 * mPx, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(250,250,250,0.92)'; ctx.fill();
  };

  rect(-HALF_L, -HALF_W, PITCH_LENGTH, PITCH_WIDTH);
  line(0, -HALF_W, 0, HALF_W);
  circle(0, 0, CENTER_CIRCLE_R);
  spot(0, 0);
  for (const s of [1, -1]) {
    const gx = HALF_L * s;
    rect(gx - BOX_DEPTH * s, -BOX_HALF_W, BOX_DEPTH * s, BOX_HALF_W * 2);
    rect(gx - SIX_DEPTH * s, -SIX_HALF_W, SIX_DEPTH * s, SIX_HALF_W * 2);
    spot(gx - PENALTY_SPOT * s, 0);
    const a = s > 0 ? Math.PI * 0.65 : -Math.PI * 0.35;
    circle(gx - PENALTY_SPOT * s, 0, CENTER_CIRCLE_R, a, a + Math.PI * 0.7);
    circle(gx, -HALF_W, 1, 0, Math.PI * 2);
    circle(gx, HALF_W, 1, 0, Math.PI * 2);
  }
}

export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Lighten (t > 0) or darken (t < 0) a hex colour. Used for kit trim, which
 *  has to derive from the two colours teams.json actually gives us. */
export function shade(hex: string, t: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const mix = (ch: number): number => Math.round(t >= 0 ? ch + (255 - ch) * t : ch * (1 + t));
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
