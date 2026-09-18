// Graphics quality (§7A.7). Three levels, persisted like the other prefs
// (same idiom as ss26.music / ss26.controls — the owning module holds the key).
//
// HIGH is the full uplift. MEDIUM trims the expensive half of every effect but
// keeps the lighting model intact. RETRO is not "Low": it is the pre-uplift
// v1.1 renderer kept alive on purpose — renderer-level ACES, the simple bloom
// stack, one shadow map — because that look is a feature, not a fallback.
//
// Nothing here ever turns a feature off on its own. Frame pressure is answered
// by trimming pixel ratio first (SceneManager.adaptPixelRatio); the level is
// only ever changed by a human in the settings menu.

export type QualityLevel = 'high' | 'medium' | 'retro';

export const QUALITY_KEY = 'ss26.quality';

/** Menu labels — "RETRO", never "Low". */
export const QUALITY_OPTIONS: [QualityLevel, string][] = [
  ['high', 'HIGH'],
  ['medium', 'MEDIUM'],
  ['retro', 'RETRO (v1.1)'],
];

export interface QualityProfile {
  level: QualityLevel;
  /** true = the v1.1 code path: renderer ACES, simple bloom, single cascade */
  retro: boolean;
  /** cascades in the CSM rig (ignored when retro) */
  cascades: number;
  shadowMapSize: number;
  /** MSAA samples on the composer's HDR buffers (0 = none) */
  samples: number;
  /** bloom's internal working resolution as a fraction of the frame */
  bloomScale: number;
  aa: 'smaa' | 'fxaa' | 'none';
  /** false = tone-map + vignette only, no split-tone/saturation grade */
  grade: boolean;
  /** PMREM sky environment on scene.environment */
  env: boolean;
  /**
   * §7A.6b screen-space AO strength, 0 = the pass is never built. It is a
   * FRACTION rather than a flag because MEDIUM wants the grounding without the
   * crease shading — the same depth pass, applied at half the amount, which is
   * free where turning it off entirely would put MEDIUM's players back on top
   * of the grass instead of in it.
   */
  ao: number;
  /** shell layers in the turf (§7A.3b, render/grass.ts); 0 = no shell turf */
  grassShells: number;
  /** metres from the lens at which the shells have faded back into the plane */
  grassRadius: number;
  /** slide-tackle scuffs kept on the pitch at once (§7A.3c, render/divots.ts);
   *  0 = no divots. This is a RING BUFFER SIZE, not a spawn rate: the cost is
   *  one instanced draw either way, so the number only decides how far back the
   *  pitch remembers. */
  divots: number;
}

const PROFILES: Record<QualityLevel, QualityProfile> = {
  // 3 × 2048: the near cascade covers ~40m of pitch, so a 2048 map lands ~50
  // texels per metre where the players are — enough that a boot's own shadow
  // on the grass has an edge instead of a staircase. The three maps together
  // are 48MB, which is what the MSAA buffer used to cost for a worse picture
  // (see samples below).
  high: {
    level: 'high', retro: false, cascades: 3, shadowMapSize: 2048,
    // MSAA is bought per DEVICE pixel and paid for twice on a Retina panel:
    // see effectiveSamples() — at pixel ratio 2 this is spent as 0 and SMAA
    // carries the edges alone. The 4 is what a 1x display gets.
    samples: 4, bloomScale: 1, aa: 'smaa', grade: true, env: true,
    // §7A.6b: half-res, 8 taps, applied inside the grade. ~0.35ms at DPR 2.
    ao: 0.85,
    // §7A.3b. Both numbers were set by measurement, not by taste — see the
    // table in render/grass.ts. Shells are priced per SCREEN PIXEL COVERED,
    // so the radius is the expensive dial and the layer count is the cheap
    // one: doubling the radius roughly doubles the cost, while the eighth
    // layer costs a tenth of what the first one does.
    grassShells: 7, grassRadius: 30,
    // 24 marks at ~90s each is roughly four minutes of tackling held on the
    // pitch, which is longer than any passage of play a camera revisits.
    divots: 24,
  },
  // the sensible step down: half the shadow resolution, one fewer cascade,
  // bloom at half res, FXAA. MEDIUM is what a machine that cannot hold HIGH
  // at 60 should land on, not a different art direction.
  medium: {
    level: 'medium', retro: false, cascades: 2, shadowMapSize: 1024,
    samples: 0, bloomScale: 0.5, aa: 'fxaa', grade: false, env: true,
    ao: 0.55,
    grassShells: 5, grassRadius: 18,
    divots: 16,
  },
  retro: {
    level: 'retro', retro: true, cascades: 0, shadowMapSize: 2048,
    samples: 0, bloomScale: 1, aa: 'none', grade: true, env: false,
    // RETRO has no depth texture and no AO pass: it is the v1.1 chain
    ao: 0,
    // RETRO is the v1.1 renderer on purpose; it had a flat pitch and keeps one
    grassShells: 0, grassRadius: 0,
    // ...and a pitch that never remembers a tackle, for the same reason
    divots: 0,
  },
};

/** Set by the capture harness so a shot never inherits a stray localStorage
 *  value from whatever profile the headless browser happens to be running. */
let forced: QualityLevel | null = null;

/**
 * Bench-only field overrides (§7A.9b), e.g. `?bench=1&profile=samples:0`.
 *
 * The point is to A/B ONE setting on a real GPU without editing this file and
 * rebuilding between runs — "is the 30fps lock the MSAA or the bloom" is a
 * question you want to answer in two minutes, not two rebuilds. Nothing in the
 * game ever sets this; only src/tools/bench.ts does, and a run that used it
 * says so in its JSON.
 */
let overrides: Partial<QualityProfile> | null = null;

export function overrideProfile(o: Partial<QualityProfile> | null): void {
  overrides = o;
}

/** Pin the level for this page load (capture / viewer entry points only). */
export function forceQuality(level: QualityLevel): void {
  forced = level;
}

export function qualitySetting(): QualityLevel {
  if (forced) return forced;
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (v === 'high' || v === 'medium' || v === 'retro') return v;
  } catch { /* private browsing */ }
  return 'high';
}

export function setQuality(level: QualityLevel): void {
  try {
    localStorage.setItem(QUALITY_KEY, level);
  } catch { /* private browsing: the toggle just won't persist */ }
}

/**
 * MSAA samples this profile should actually ask for at a given pixel ratio.
 *
 * Measured on an M3 (ANGLE/Metal), broadcast_midfield, 2940x1598 device px:
 *
 *   samples 4 → 31 fps (a clean 33.3ms: every other vsync missed)
 *   samples 2 → 46 fps (oscillating between 16.7 and 33.3)
 *   samples 0 → 60 fps, and the whole frame bursts at 2.1ms instead of 5.3ms
 *
 * A 4x multisampled HALF-FLOAT colour buffer is the expensive part — the
 * resolve is bandwidth the tile memory cannot hide — and at pixel ratio 2 the
 * edges it cleans are already half the size of the ones SMAA is tuned for. So
 * HIGH spends MSAA only where the pixels are big enough to need it. On a 1x
 * display (an external 1080p monitor) the 4 samples come back.
 */
export function effectiveSamples(profile: QualityProfile, pixelRatio: number): number {
  return pixelRatio >= 1.75 ? 0 : profile.samples;
}

export function qualityProfile(level: QualityLevel = qualitySetting()): QualityProfile {
  return overrides ? { ...PROFILES[level], ...overrides } : PROFILES[level];
}
