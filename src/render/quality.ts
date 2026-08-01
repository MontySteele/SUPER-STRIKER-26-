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
}

const PROFILES: Record<QualityLevel, QualityProfile> = {
  // 3 × 1024 beats the old single 2048: the near cascade covers ~40m instead
  // of 124m, so it lands ~5x the texel density where the players actually are,
  // for a quarter of the shadow-map memory a 3 × 2048 rig would eat.
  high: {
    level: 'high', retro: false, cascades: 3, shadowMapSize: 1024,
    samples: 4, bloomScale: 1, aa: 'smaa', grade: true, env: true,
  },
  medium: {
    level: 'medium', retro: false, cascades: 2, shadowMapSize: 1024,
    samples: 0, bloomScale: 0.5, aa: 'fxaa', grade: false, env: true,
  },
  retro: {
    level: 'retro', retro: true, cascades: 0, shadowMapSize: 2048,
    samples: 0, bloomScale: 1, aa: 'none', grade: true, env: false,
  },
};

/** Set by the capture harness so a shot never inherits a stray localStorage
 *  value from whatever profile the headless browser happens to be running. */
let forced: QualityLevel | null = null;

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

export function qualityProfile(level: QualityLevel = qualitySetting()): QualityProfile {
  return PROFILES[level];
}
