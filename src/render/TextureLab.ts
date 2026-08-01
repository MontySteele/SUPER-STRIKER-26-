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

// Tiling detail resolution and the patch of pitch it covers. 4m over 512px is
// 128 texels per metre, so the blade octave lands at ~6cm — fine enough that a
// knee-height camera reads grain and not gravel.
const DETAIL_PX = 512;
const DETAIL_M = 4;
// the macro layers are low-frequency by definition, so they are baked small and
// scaled up onto the marking canvas — a 2048x1330 per-pixel noise loop is a
// second of the budget for detail nobody can resolve
const MACRO_PX = 256;
const PITCH_TEX_W = 2048;

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
    // 5 octaves from base 4: periods 4, 8, 16, 32, 64 cells over a [0,1) tile
    this.field = new NoiseField(rng, 4, 5);
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
        // octave 4 = 64 cells over the 4m tile ≈ 6cm blades; octave 1 = 8
        // cells ≈ 50cm clumps. Anything finer is below what a 512px/4m map can
        // carry and just aliases into noise.
        const blade = this.field.octave(4, u, v);
        const clump = this.field.octave(1, u, v);
        const val = blade * 0.62 + clump * 0.38;
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
    tex.anisotropy = 16;
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
    // how steep the derived surface is; tuned so the grass reads as grass and
    // not as gravel under a low key. The mowing stripes lean the normal by
    // 0.20 and this has to stay well under that or the stripes drown in grain.
    const STRENGTH = 0.95;
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
    tex.anisotropy = 16;
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
    tex.anisotropy = 8;
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
      const N = 128;
      const [c, ctx] = canvas2d(N, N);
      const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
      g.addColorStop(0, 'rgba(255,252,240,1)');
      g.addColorStop(0.18, 'rgba(255,244,214,0.55)');
      g.addColorStop(0.5, 'rgba(190,214,255,0.13)');
      g.addColorStop(1, 'rgba(140,180,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, N, N);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
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
