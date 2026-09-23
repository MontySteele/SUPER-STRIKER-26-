// Weather (§7A.4c): the second dimension of the lighting rig, alongside
// timeOfDay.
//
// The rule this module exists to enforce: WEATHER IS LIGHT. A "rain" setting
// that only adds particles is a filter, not a forecast — the sun has to lose
// three quarters of its intensity and most of its colour, the shadow has to go
// soft and shallow, the sky has to close over, the fog has to come in, the
// floodlights have to come ON, and the grass has to go dark and wet. Every one
// of those is a number here, and every consumer reads them from this one
// place: Atmosphere for the rig, sky.ts for the dome, stadium.ts for the lamps,
// pitch.ts and grass.ts for the wet turf, rain.ts for the streaks.
//
// It is a module-level SETTING rather than a constructor argument for the same
// reason quality.ts is: the value has to reach a dozen leaf modules that are
// built at four different points in GameRenderer's constructor, and threading
// it through every signature would touch the menu, the bench, the broadcast
// card shooter and the capture harness for no gain. Same idiom, same rules —
// the capture harness pins it per shot and nothing else ever writes it
// mid-frame.

import type { TimeOfDay } from './scene';

export type Weather = 'clear' | 'overcast' | 'rain' | 'night';

export const WEATHER_KEY = 'ss26.weather';

export const WEATHER_OPTIONS: [Weather, string][] = [
  ['clear', 'CLEAR'],
  ['overcast', 'OVERCAST'],
  ['rain', 'RAIN'],
  ['night', 'FLOODLIT'],
];

/** How one weather bends the time-of-day preset it is laid over. */
export interface WeatherProfile {
  id: Weather;
  /** multiplier on the sun key's intensity */
  key: number;
  /** how far the key colour is pulled toward overcast daylight, 0..1 */
  keyGrey: number;
  /** multiplier on the hemisphere fill — an overcast sky IS the key light */
  hemi: number;
  /** multiplier on scene.environmentIntensity */
  env: number;
  /** how much direct light a shadowed fragment keeps (three's
   *  LightShadow.intensity is the fraction REMOVED, so this is 1 - that) */
  shadowLift: number;
  /** extra PCF radius, in texels — an overcast shadow has no hard edge */
  shadowSoft: number;
  /** fog near/far multipliers; rain brings the far wall in hard */
  fogNear: number;
  fogFar: number;
  /** how far the fog colour is pulled toward `fogTint` */
  fogGrey: number;
  fogTint: number;
  /** grade exposure multiplier */
  exposure: number;
  /** 0 = no cloud deck, 1 = solid lid (drives sky.ts) */
  cloud: number;
  /** how hard-edged the cloud deck is; low = soft stratus, high = cumulus */
  cloudSharp: number;
  /** multiplier on the sky's sun disc and its gain */
  skySun: number;
  skyGain: number;
  /** the floodlights are lit (lamp cells overbright, flares on) */
  floodlights: boolean;
  /** rain streaks per cubic camera volume; 0 = dry */
  rain: number;
  /** 0 = dry turf, 1 = standing water: darker albedo, lower roughness, more
   *  grazing specular (pitch.ts / grass.ts) */
  wet: number;
}

const PROFILES: Record<Weather, WeatherProfile> = {
  clear: {
    id: 'clear',
    key: 1, keyGrey: 0, hemi: 1, env: 1,
    shadowLift: 0.16, shadowSoft: 0,
    fogNear: 1, fogFar: 1, fogGrey: 0, fogTint: 0xb9d0e6,
    exposure: 1, cloud: 0.30, cloudSharp: 2.4, skySun: 1, skyGain: 1,
    floodlights: false, rain: 0, wet: 0,
  },
  // A real overcast is not "the same scene, darker". The cloud deck is a
  // 180°-wide softbox: the key collapses to about a third and goes neutral,
  // the FILL nearly doubles, and the shadow that is left is a wide, shallow
  // smudge. Getting that ratio wrong is what makes most games' "cloudy" look
  // like dusk instead of like a Tuesday in Manchester.
  overcast: {
    id: 'overcast',
    key: 0.34, keyGrey: 0.8, hemi: 1.75, env: 1.35,
    shadowLift: 0.55, shadowSoft: 2.6,
    fogNear: 0.62, fogFar: 0.58, fogGrey: 0.75, fogTint: 0xa9b4c0,
    exposure: 1.05, cloud: 0.96, cloudSharp: 1.1, skySun: 0.05, skyGain: 0.78,
    floodlights: false, rain: 0, wet: 0.12,
  },
  rain: {
    id: 'rain',
    key: 0.22, keyGrey: 0.9, hemi: 1.55, env: 1.2,
    shadowLift: 0.66, shadowSoft: 3.2,
    fogNear: 0.34, fogFar: 0.34, fogGrey: 0.88, fogTint: 0x8e99a6,
    exposure: 1.08, cloud: 1.0, cloudSharp: 0.85, skySun: 0, skyGain: 0.58,
    floodlights: true, rain: 1, wet: 1,
  },
  // 'night' is a weather rather than a time of day so a shot can ask for a
  // floodlit match without also rewriting which stadium and which crowd bake
  // it gets. It FORCES the night preset (see effectiveTimeOfDay) and then
  // leaves the rig alone — the night rig is already the floodlight rig.
  night: {
    id: 'night',
    key: 1, keyGrey: 0, hemi: 1, env: 1,
    shadowLift: 0.20, shadowSoft: 0.4,
    fogNear: 1, fogFar: 1, fogGrey: 0, fogTint: 0x070c18,
    exposure: 1, cloud: 0.22, cloudSharp: 2.0, skySun: 1, skyGain: 1,
    floodlights: true, rain: 0, wet: 0,
  },
};

let forced: Weather | null = null;

/** Pin the weather for this page load (capture / viewer entry points). */
export function forceWeather(w: Weather): void {
  forced = w;
}

function fromQuery(): Weather | null {
  try {
    const v = new URLSearchParams(location.search).get('weather');
    if (v === 'clear' || v === 'overcast' || v === 'rain' || v === 'night') return v;
  } catch { /* no location (worker/test) */ }
  return null;
}

export function weatherSetting(): Weather {
  if (forced) return forced;
  const q = fromQuery();
  if (q) return q;
  try {
    const v = localStorage.getItem(WEATHER_KEY);
    if (v === 'clear' || v === 'overcast' || v === 'rain' || v === 'night') return v;
  } catch { /* private browsing */ }
  return 'clear';
}

export function setWeather(w: Weather): void {
  try {
    localStorage.setItem(WEATHER_KEY, w);
  } catch { /* private browsing: the toggle just won't persist */ }
}

export function weatherProfile(w: Weather = weatherSetting()): WeatherProfile {
  return PROFILES[w];
}

/**
 * The time of day the scene is actually DRESSED for.
 *
 * `weather=night` is the one setting that overrides its host preset outright:
 * a floodlit match is a night match whatever the shot asked for, and the
 * stadium's crowd bake, the seat shading and the impostor tints all key off
 * the same enum. Everything else leaves the time of day alone and only bends
 * the numbers (see WeatherProfile).
 */
export function effectiveTimeOfDay(tod: TimeOfDay, w: Weather = weatherSetting()): TimeOfDay {
  return w === 'night' ? 'night' : tod;
}

/** Are the lamps burning? Night always; rain and a dark overcast as well. */
export function floodlightsLit(tod: TimeOfDay, w: Weather = weatherSetting()): boolean {
  return effectiveTimeOfDay(tod, w) === 'night' || PROFILES[w].floodlights
    || (w === 'overcast' && tod !== 'day');
}

// ------------------------------------------------------ the floodlit night
//
// §7A.4d. The lighting signal every UNLIT stand consumer (the crowd, the
// terrace shading, the impostor tints) should take at night, so the bowl
// falls away around the pitch by the same rule the lit materials use. The
// lit side of this lives in Atmosphere (the key footprint patch) and
// floodlights.ts (the three spot banks and the fake shadows).

let floodRig: boolean | null = null;

/**
 * `?flood=0` builds the night WITHOUT the §7A.4d floodlight rig (no spot
 * banks, no fake shadows, no key footprint) — the preset numbers stay. It
 * exists for one job: a same-tree A/B of the rig's cost on the real GPU,
 * `npm run app:bench -- --query "weather=night&flood=0"` against
 * `--query weather=night`.
 */
export function floodRigEnabled(): boolean {
  if (floodRig === null) {
    try {
      floodRig = new URLSearchParams(location.search).get('flood') !== '0';
    } catch { floodRig = true; }
  }
  return floodRig;
}

/** Direction TO the night key (the (-x, +z) pylon bank, steepened to 68°). */
export const NIGHT_KEY_DIR: readonly [number, number, number] = (() => {
  const v = [-0.295, 0.927, 0.23];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as const;
})();

/**
 * How much of the floodlight key reaches a point, 0.06..1. Mirrors the
 * GLSL footprint in Atmosphere.ts exactly: 1 over the pitch and run-off,
 * falling away across the stands (an ellipse 64m x 45m out to 1.75x that)
 * and with height (a floodlight is aimed DOWN at the pitch; the back rows
 * and the roof get its spill, not its beam). Cheap enough to bake per fan.
 */
export function floodFootprint(x: number, y: number, z: number): number {
  const ss = (a: number, b: number, t: number): number => {
    const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  const r = Math.hypot(x / 64, z / 45);
  const across = 1 - ss(1.0, 1.75, r);
  const up = 1 - 0.88 * ss(2.5, 24.0, y);
  return Math.max(across * up, 0.06);
}

/** Linear-radiance lighting for an unlit stand at night (crowd.ts shape). */
export interface StandLight {
  /** direction TO the key */
  keyDir: [number, number, number];
  /** key radiance; scale it per fan by floodFootprint() */
  key: [number, number, number];
  /** hemisphere top / bottom. `ground` is high on purpose: the brightest
   *  thing in a floodlit bowl is the pitch, and it bounces onto every face
   *  that looks at it */
  sky: [number, number, number];
  ground: [number, number, number];
}

/**
 * The night stand light, with the weather already folded in the NIGHT way:
 * rain at night dims the floodlights a little and scatters a little more
 * into the fill — it does not collapse the key to a fifth the way it does
 * the sun (never multiply a night key by WeatherProfile.key directly).
 *
 * Tuned against the §7A.4d rig at exposure 1.0 so the front rows sit about a
 * stop under the pitch and the back rows two, dimmer than the v1 night crowd
 * (which was lit like a day crowd under a 1.35 exposure).
 */
export function nightStandLight(w: Weather = weatherSetting()): StandLight {
  const p = PROFILES[w];
  const keyK = 0.85 + 0.15 * p.key;
  const fillK = 1 + (p.hemi - 1) * 0.35;
  return {
    keyDir: [...NIGHT_KEY_DIR],
    key: [0.30 * keyK, 0.32 * keyK, 0.37 * keyK],
    sky: [0.10 * fillK, 0.11 * fillK, 0.15 * fillK],
    ground: [0.17 * fillK, 0.19 * fillK, 0.18 * fillK],
  };
}
