// Atmosphere (§7A.4): the ONE module that owns every light in the match scene.
//
// Nothing else in the project may create a light. If you find yourself reaching
// for `new THREE.SomethingLight()` anywhere else, add a preset here instead —
// the whole reason day/sunset/night used to read as "the same scene with three
// colour swaps" is that the rig was scattered and nobody could tune it as a
// unit. (The floodlight heads in stadium.ts are emissive MESHES, not lights;
// they belong to the stadium and are fine where they are.)
//
// The rig, per time of day:
//   • one shadow-casting sun key, run through CSM so players self-shadow and
//     the cascade actually covers the play area instead of a patch of it;
//   • a hemisphere fill whose GROUND colour is deliberately grass-green, so a
//     shadow reads green-blue like real turf shade and never dead grey;
//   • a dim warm bounce opposing the key — a PointLight with decay 0 parked far
//     away, because a second DirectionalLight would walk straight into the CSM
//     cascade loop (see registerMaterial below);
//   • a PMREM bake of the procedural sky for scene.environment, plus the same
//     sky as the visible backdrop, with fog tuned to the horizon band.

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky, type SkyPreset } from './sky';
import { SHADOW_LAYER, applyShaderPatches } from './materials';
import type { QualityProfile } from './quality';
import type { TimeOfDay } from './scene';
import { effectiveTimeOfDay, weatherProfile, type WeatherProfile } from './weather';

/**
 * The broadcast grade (§7A.6c), per preset.
 *
 * The old chain tone-mapped and then applied one fixed split-tone to every
 * scene in the game, which is why day, sunset and night all read as the same
 * lighting with three colour swaps. A grade belongs to a LOOK: a day match is
 * a clean, slightly cool print with the contrast in the midtones; a sunset is
 * a warm, heavily-vignetted one; a floodlit night is high-contrast, low
 * saturation and blue in the lift. These travel with the preset for the same
 * reason the fog colour does.
 *
 * lift/gain are the ASC-CDL pair, applied AFTER the tone-map in display space
 * — a lift is "how far off black the blacks sit", which is a print property,
 * not a scene one, and doing it in linear light just changes the exposure.
 */
export interface GradeSettings {
  exposure: number;
  contrast: number;
  lift: THREE.Vector3;
  gain: THREE.Vector3;
  saturation: number;
  vignette: number;
  /** transverse chromatic aberration at the frame edge, in pixels */
  chroma: number;
  shadowTint: THREE.Vector3;
  highlightTint: THREE.Vector3;
  bloomStrength: number;
  bloomThreshold: number;
}

interface GradePreset {
  contrast: number;
  lift: [number, number, number];
  gain: [number, number, number];
  saturation: number;
  vignette: number;
  chroma: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  bloomStrength: number;
  bloomThreshold: number;
}

interface Preset {
  sky: SkyPreset;
  /** direction TO the sun; the key light comes from here */
  sunDir: THREE.Vector3;
  keyColor: number;
  keyIntensity: number;
  hemiSky: number;
  /** grass-green on purpose — this is what keeps shadows off grey */
  hemiGround: number;
  hemiIntensity: number;
  bounceColor: number;
  bounceIntensity: number;
  /** where the bounce sits; direction only, it is pushed out to 300m */
  bounceDir: THREE.Vector3;
  fog: number;
  fogNear: number;
  fogFar: number;
  envIntensity: number;
  /** grade-pass exposure — ACES moved downstream, so this is the only dial */
  exposure: number;
  /**
   * How much direct light a SHADOWED fragment keeps, 0..1 (§7A.4b). Real
   * broadcast shade is not the absence of the sun, it is the sun replaced by
   * the sky — and now that the roof throws its line across a third of the
   * pitch, a shadow that goes to pure hemisphere fill reads as a hole. three
   * spells this the other way round (LightShadow.intensity is the fraction
   * REMOVED), which is converted on the way in.
   */
  shadowLift: number;
  grade: GradePreset;
}

const dir = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z).normalize();

/**
 * Put a light on SHADOW_LAYER as well as its own.
 *
 * SceneManager's shadow pass runs from a probe camera whose mask is
 * SHADOW_LAYER alone (see drawShadows), and three collects the lights for a
 * render by testing each one against THAT mask. A light the probe cannot see
 * is a light with no shadow map. Every light in the rig goes on the layer, not
 * just the shadow-casting key: the probe and the real render must agree on the
 * light counts or every material in the scene gets compiled twice, once per
 * camera, and swaps programs every frame.
 */
const lightSeesShadowPass = (...lights: (THREE.Light | null)[]): void => {
  for (const l of lights) l?.layers.enable(SHADOW_LAYER);
};

// Late-afternoon angles for day and sunset: the sun is low and off to the west
// end, so every player drags a long shadow across the mowing stripes. That one
// choice does more for "this is a real broadcast" than any post effect.
const PRESETS: Record<TimeOfDay, Preset> = {
  day: {
    sky: {
      // saturated on purpose: gain pushes the whole gradient up, and a pale
      // hex times a gain of 2 is just a white sky that blooms into the stands
      zenith: 0x2f6ec4, horizon: 0x9dc0e0, ground: 0x2c3a28,
      sun: 0xfff1d4, sunIntensity: 22, sunSize: 0.035, haze: 0.55,
      sunDir: dir(-0.62, 0.44, 0.65), gain: 1.35,
      // fair-weather cumulus, small and high: the deck is what gives a wide
      // shot its sense of how big the bowl is
      cloud: 0.30, cloudSharp: 2.4,
      cloudColor: 0xf6f9ff, cloudShadow: 0x9db2cb,
      cloudScale: 1.6, cloudOffset: [17.31, 42.07],
    },
    sunDir: dir(-0.62, 0.44, 0.65),
    keyColor: 0xfff0d8, keyIntensity: 2.5,
    // The fill went up with the roof shadow (§7A.4b). Before it, nothing on
    // the pitch was ever out of the key and the hemisphere was only doing the
    // undersides; now a third of the pitch is lit BY IT, and 0.42 left that
    // third looking like a power cut.
    hemiSky: 0x9cc4f2, hemiGround: 0x3d6b33, hemiIntensity: 0.56,
    bounceColor: 0xffd9a8, bounceIntensity: 0.3, bounceDir: dir(0.7, 0.22, -0.6),
    fog: 0xb9d0e6, fogNear: 260, fogFar: 820,
    envIntensity: 0.38,
    exposure: 1.15,
    shadowLift: 0.26,
    grade: {
      contrast: 1.045,
      // a print lift: the blacks sit a little off zero and a little blue,
      // which is most of what separates "filmed" from "rendered"
      lift: [0.004, 0.007, 0.014],
      gain: [1.025, 1.0, 0.978],
      saturation: 1.07, vignette: 0.17, chroma: 0.35,
      shadowTint: [0.93, 1.0, 1.07], highlightTint: [1.05, 1.0, 0.94],
      bloomStrength: 0.40, bloomThreshold: 1.2,
    },
  },
  sunset: {
    sky: {
      zenith: 0x1e2a5c, horizon: 0xff8a35, ground: 0x2b2318,
      // the sun clears the west stand roof at this elevation and lands in
      // frame on the bloom-check shot; 30 blew half the pitch out with it
      sun: 0xffc07a, sunIntensity: 15, sunSize: 0.04, haze: 0.7,
      sunDir: dir(-0.85, 0.3, 0.43), gain: 1.5,
      // more of them, and lit from underneath: a low sun turns the bases of
      // the deck the colour of the horizon band, which is the entire reason
      // anyone photographs a sunset
      cloud: 0.34, cloudSharp: 1.8,
      cloudColor: 0xffd3a4, cloudShadow: 0xb08476,
      cloudScale: 1.35, cloudOffset: [88.5, 11.9],
    },
    // ~17° elevation: still a long-shadow late-afternoon key, but not the 9°
    // that left a horizontal pitch taking 16% of the sun and the mowing
    // stripes — the entire point of the low-sun shot — invisible.
    sunDir: dir(-0.85, 0.3, 0.43),
    keyColor: 0xffc48c, keyIntensity: 2.5,
    // the fill at dusk is the HALF of the sky the sun isn't in, which is
    // violet-blue. A warm fill under a warm key is what made the old sunset
    // read as one flat orange wash with grey shadows in it.
    hemiSky: 0x93a8dd, hemiGround: 0x3c4a2c, hemiIntensity: 0.52,
    bounceColor: 0xffcf9a, bounceIntensity: 0.3, bounceDir: dir(0.85, 0.3, -0.4),
    fog: 0x6b4a4e, fogNear: 220, fogFar: 720,
    envIntensity: 0.32,
    // the low key still rakes the grass at a grazing angle here; much above
    // 1.1 and the sunlit half of the pitch clips to a flat cream sheet
    exposure: 1.05,
    // A 17.5-degree sun puts the west stand's roof line at x = -11: SIXTY PER
    // CENT of the pitch is in its shade, which is correct (it is why evening
    // kick-offs look the way they do) and is also why this preset needs by far
    // the biggest lift in the rig. At 0.24 the whole foreground of the
    // low-sun shot went to near-black with the sunset sky's grazing reflection
    // sitting on top of it in gold bands — an oil slick, not a pitch.
    shadowLift: 0.55,
    grade: {
      // MUCH gentler than it started. The first pass at this preset ran
      // contrast 1.11 with a 0.24 vignette on a scene whose midtones already
      // sit at 0.2, and a contrast pivot is a MULTIPLIER on the distance from
      // the pivot: 1.11 about 0.435 takes a 0.10 pixel to 0.063, i.e. it eats
      // a third of everything already in shadow. On a low-sun shot, where
      // most of the frame is exactly that, the pitch went black and the sky's
      // grazing reflection was the only thing left on it. A print grade for a
      // dim scene lives in the LIFT, not in the contrast.
      contrast: 1.035,
      lift: [0.012, 0.010, 0.020],
      gain: [1.035, 1.0, 0.965],
      saturation: 1.08, vignette: 0.18, chroma: 0.5,
      shadowTint: [0.92, 0.99, 1.09], highlightTint: [1.06, 1.0, 0.92],
      bloomStrength: 0.42, bloomThreshold: 1.2,
    },
  },
  night: {
    // no sun: the key IS the floodlight rig, high and cool, and the "sky"
    // is a dim gradient with a moon-sized core so the bowl has a lid
    sky: {
      zenith: 0x03060f, horizon: 0x0e1c31, ground: 0x05080d,
      sun: 0xc8d8ff, sunIntensity: 1.4, sunSize: 0.012, haze: 0.4,
      sunDir: dir(0.4, 0.5, -0.7), gain: 1.0,
      // a thin deck, lit from BELOW by the bowl — the orange underglow over a
      // floodlit ground, which is the one cue that says "night match" from
      // outside the stadium
      cloud: 0.22, cloudSharp: 2.0,
      cloudColor: 0x2c3a58, cloudShadow: 0x0d1424,
      cloudScale: 1.15, cloudOffset: [5.02, 71.44],
    },
    sunDir: dir(-0.3, 0.9, 0.32),
    keyColor: 0xf0f5ff, keyIntensity: 2.9,
    hemiSky: 0x24334f, hemiGround: 0x1a2c1c, hemiIntensity: 0.44,
    bounceColor: 0xffe2b8, bounceIntensity: 0.2, bounceDir: dir(0.5, 0.5, -0.7),
    fog: 0x070c18, fogNear: 190, fogFar: 580,
    envIntensity: 0.5,
    exposure: 1.35,
    // the floodlight rig is four banks, so nothing under it is ever fully
    // shadowed — a single-source blackout is what makes a night render look
    // like a moon landing
    shadowLift: 0.30,
    grade: {
      contrast: 1.06,
      lift: [0.003, 0.006, 0.015],
      gain: [0.985, 1.0, 1.045],
      saturation: 1.03, vignette: 0.22, chroma: 0.45,
      shadowTint: [0.90, 0.97, 1.14], highlightTint: [1.02, 1.0, 0.99],
      bloomStrength: 0.46, bloomThreshold: 1.25,
    },
  },
};

/**
 * Lay a weather over a time-of-day preset (§7A.4c). Nothing here invents a
 * value — every field is the preset's own, bent by a ratio from
 * WeatherProfile — which is what keeps "sunset in the rain" a real lighting
 * state rather than a fourth hand-tuned preset nobody maintains.
 */
function applyWeather(p: Preset, w: WeatherProfile): Preset {
  if (w.id === 'clear' || w.id === 'night') {
    return { ...p, shadowLift: Math.max(p.shadowLift, w.shadowLift * 0.9) };
  }
  const mix = (hex: number, towards: number, t: number): number =>
    new THREE.Color(hex).lerp(new THREE.Color(towards), t).getHex();
  // Overcast daylight is 6500K and flat; the key keeps its own colour only in
  // proportion to how much of it is left.
  const OVERCAST_WHITE = 0xdfe6ef;
  return {
    ...p,
    sky: {
      ...p.sky,
      sunIntensity: p.sky.sunIntensity * w.skySun,
      gain: (p.sky.gain ?? 1) * w.skyGain,
      haze: Math.min(1.2, p.sky.haze * 1.25),
      cloud: w.cloud,
      cloudSharp: w.cloudSharp,
      // the deck goes the colour of the fog, because under a solid lid the
      // deck IS the fog's light source
      cloudColor: mix(p.sky.cloudColor ?? 0xf2f6fb, w.fogTint, w.fogGrey * 0.8),
      cloudShadow: mix(p.sky.cloudShadow ?? 0x8fa3ba, 0x555f6b, w.fogGrey * 0.7),
    },
    keyColor: mix(p.keyColor, OVERCAST_WHITE, w.keyGrey),
    keyIntensity: p.keyIntensity * w.key,
    hemiSky: mix(p.hemiSky, w.fogTint, w.fogGrey * 0.6),
    hemiIntensity: p.hemiIntensity * w.hemi,
    bounceIntensity: p.bounceIntensity * (0.4 + 0.6 * w.key),
    fog: mix(p.fog, w.fogTint, w.fogGrey),
    fogNear: p.fogNear * w.fogNear,
    fogFar: p.fogFar * w.fogFar,
    envIntensity: p.envIntensity * w.env,
    exposure: p.exposure * w.exposure,
    shadowLift: Math.max(p.shadowLift, w.shadowLift),
    grade: {
      ...p.grade,
      contrast: p.grade.contrast * (1 + w.fogGrey * 0.05),
      saturation: p.grade.saturation * (1 - w.fogGrey * 0.22),
      vignette: p.grade.vignette + w.fogGrey * 0.05,
      // a flat sky has nothing above the bloom threshold in it, so the lamps
      // and the white kits are all that is left to glow — let them
      bloomThreshold: p.grade.bloomThreshold - w.fogGrey * 0.25,
    },
  };
}

/** The v1.1 rig, preserved verbatim for the RETRO level (§7A.7). */
interface RetroPreset {
  keyColor: number; keyIntensity: number; keyPos: [number, number, number];
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  fog: number; fogNear: number; fogFar: number;
  exposure: number;
}

const RETRO_PRESETS: Record<TimeOfDay, RetroPreset> = {
  day: {
    keyColor: 0xfff4e0, keyIntensity: 2.6, keyPos: [-45, 85, 40],
    hemiSky: 0xbdd7ff, hemiGround: 0x2e4a2e, hemiIntensity: 0.75,
    fog: 0x9db8d8, fogNear: 280, fogFar: 700, exposure: 1.05,
  },
  sunset: {
    keyColor: 0xffc890, keyIntensity: 2.2, keyPos: [-80, 42, 30],
    hemiSky: 0xffb98a, hemiGround: 0x2a3320, hemiIntensity: 0.6,
    fog: 0x2b1e2e, fogNear: 250, fogFar: 600, exposure: 1.05,
  },
  night: {
    keyColor: 0xf2f6ff, keyIntensity: 2.3, keyPos: [-30, 90, 55],
    hemiSky: 0x8899cc, hemiGround: 0x1a2a1a, hemiIntensity: 0.55,
    fog: 0x060a14, fogNear: 220, fogFar: 520, exposure: 1.15,
  },
};

/** How far out the cascades bother to reach. The action lives inside ~150m;
 *  splitting the full 900m camera range would waste two of three cascades on
 *  the empty car park behind the stands. */
const CSM_MAX_FAR = 170;

export class Atmosphere {
  /** grade-pass exposure this preset wants */
  readonly exposure: number;
  /** the whole broadcast grade this preset+weather wants (§7A.6c). Null on
   *  RETRO, which keeps the v1.1 grade verbatim. */
  readonly grade: GradeSettings | null = null;
  /** the weather this rig was built for — leaf modules read it from here so
   *  there is one answer per scene, not one per call site */
  readonly weather: WeatherProfile;
  /** the time of day the scene is actually dressed for (weather=night wins) */
  readonly tod: TimeOfDay;

  private hemi: THREE.HemisphereLight;
  private bounce: THREE.PointLight | null = null;
  private csm: CSM | null = null;
  /** RETRO only: the single v1.1 cascade */
  private legacyKey: THREE.DirectionalLight | null = null;
  private sky: Sky | null = null;
  /** every material we have already wired up, so a re-register is free */
  private registered = new Set<THREE.Material>();
  private lastFov = 0;
  private lastAspect = 0;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    todIn: TimeOfDay,
    private profile: QualityProfile,
  ) {
    this.weather = weatherProfile();
    // RETRO is the v1.1 rig and has no weather: it gets the time of day it
    // asked for, unbent, because that look is a feature (§7A.7).
    const tod = profile.retro ? todIn : effectiveTimeOfDay(todIn);
    this.tod = tod;
    if (profile.retro) {
      const p = RETRO_PRESETS[tod];
      this.exposure = p.exposure;
      this.hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity);
      scene.add(this.hemi);

      const key = new THREE.DirectionalLight(p.keyColor, p.keyIntensity);
      key.castShadow = true;
      const sc = key.shadow.camera;
      sc.left = -62; sc.right = 62; sc.top = 48; sc.bottom = -48;
      sc.near = 10; sc.far = 220;
      // without this the frustum silently stays at the ±5m default and
      // shadows only exist in a small patch around the centre spot
      sc.updateProjectionMatrix();
      key.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
      key.shadow.bias = -0.0012;
      key.position.set(...p.keyPos);
      key.target.position.set(0, 0, 0);
      scene.add(key, key.target);
      this.legacyKey = key;
      lightSeesShadowPass(key, this.hemi);

      scene.fog = new THREE.Fog(p.fog, p.fogNear, p.fogFar);
      scene.background = new THREE.Color(p.fog);
      return;
    }

    const p = applyWeather(PRESETS[tod], this.weather);
    this.exposure = p.exposure;
    const g = p.grade;
    this.grade = {
      exposure: p.exposure,
      contrast: g.contrast,
      lift: new THREE.Vector3(...g.lift),
      gain: new THREE.Vector3(...g.gain),
      saturation: g.saturation,
      vignette: g.vignette,
      chroma: g.chroma,
      shadowTint: new THREE.Vector3(...g.shadowTint),
      highlightTint: new THREE.Vector3(...g.highlightTint),
      bloomStrength: g.bloomStrength,
      bloomThreshold: g.bloomThreshold,
    };

    this.hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity);
    scene.add(this.hemi);

    // decay 0 + distance 0 makes a PointLight behave like a directional one
    // that happens to have a position — which is exactly what we want, and it
    // stays out of NUM_DIR_LIGHTS where CSM indexes its cascades
    this.bounce = new THREE.PointLight(p.bounceColor, p.bounceIntensity, 0, 0);
    this.bounce.position.copy(p.bounceDir).multiplyScalar(300);
    scene.add(this.bounce);

    // NOTE: constructing a CSM rewrites three's GLOBAL lights_fragment_begin /
    // lights_pars_begin chunks, and nothing puts them back. That is safe here
    // — the replacement keeps a byte-identical `!defined(USE_CSM)` branch, so
    // a RETRO scene built later in the same page still compiles exactly the
    // stock lighting — but it is why registerMaterial() below is mandatory
    // rather than an optimisation.
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: profile.cascades,
      maxFar: CSM_MAX_FAR,
      mode: 'practical',
      shadowMapSize: profile.shadowMapSize,
      // depth bias scales with the texel: HIGH doubled the map to 2048, so the
      // slope error inside one texel halved and so does this. Left at -0.0006
      // a 2048 rig peter-pans — the near cascade's texels are ~2cm of pitch
      // and the old bias is most of a boot sole.
      shadowBias: profile.shadowMapSize >= 2048 ? -0.0003 : -0.0006,
      lightDirection: p.sunDir.clone().negate(),
      lightIntensity: p.keyIntensity,
      lightNear: 1,
      lightFar: 900,
      lightMargin: 120,
    });
    lightSeesShadowPass(this.hemi, this.bounce);
    for (const light of this.csm.lights) {
      light.color.set(p.keyColor);
      lightSeesShadowPass(light);
      // NOT light.shadow.camera.layers: three never consults the shadow
      // camera's mask. What decides a shadow map's contents is the mask of the
      // camera passed to WebGLShadowMap.render, which is why the shadow pass
      // is driven from SceneManager.drawShadows() by a probe camera that sees
      // SHADOW_LAYER — and why the light above has to be on it as well, or the
      // probe collects no lights and quietly renders no shadows at all.
      // CSM has no knob for either of these. normalBias kills the acne a 105m
      // pitch under a low sun would otherwise show everywhere; radius is what
      // the PCF tap kernel spreads by, i.e. how soft the edge reads.
      //
      // Both are texel-relative, so both follow the map size. At 2048 the
      // normal offset that used to be needed is half a texel of over-push —
      // visible as a gap under the boot on the tele cam — and 2.2 texels of
      // PCF radius is half the penumbra it used to be, which reads as a hard
      // edge. 3.0 texels at 2048 is slightly CRISPER than 2.2 at 1024 and
      // still five Vogel taps wide, which is the trade we want: sharper
      // contact, same softness class.
      const fine = profile.shadowMapSize >= 2048;
      light.shadow.normalBias = fine ? 0.018 : 0.035;
      // ...plus the weather's own softening. An overcast shadow is a wide,
      // shallow smudge and a rain shadow barely exists; both are the SAME
      // five Vogel taps, spread further apart.
      light.shadow.radius = (fine ? 3.0 : 2.2) + this.weather.shadowSoft;
      // three counts this the other way round: `intensity` is how much light
      // the shadow REMOVES. See Preset.shadowLift.
      light.shadow.intensity = 1 - p.shadowLift;
    }

    if (profile.env) {
      this.sky = new Sky(renderer, p.sky);
      scene.add(this.sky.dome);
      scene.environment = this.sky.envTexture;
      scene.environmentIntensity = p.envIntensity;
      // the dome paints the backdrop; a clear colour underneath it only
      // matters for the one frame before it draws
      scene.background = new THREE.Color(p.sky.horizon);
    } else {
      scene.background = new THREE.Color(p.fog);
    }

    // fog colour sits on the sky's horizon band, so distance fades INTO the
    // backdrop rather than toward some unrelated grey
    scene.fog = new THREE.Fog(p.fog, p.fogNear, p.fogFar);

    this.lastFov = camera.fov;
    this.lastAspect = camera.aspect;
  }

  /**
   * Wire one material into the rig. Mandatory for every lit material in the
   * scene — CSM patches three's global lighting chunk, and a lit material that
   * MISSES setupMaterial falls into the non-CSM branch, which loops over all
   * NUM_DIR_LIGHTS and therefore applies the sun once per cascade. A forgotten
   * material doesn't lose its shadows, it goes three times too bright.
   */
  registerMaterial(mat: THREE.Material): void {
    if (this.registered.has(mat)) return;
    this.registered.add(mat);
    const lit = (mat as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial
      || (mat as { isMeshPhongMaterial?: boolean }).isMeshPhongMaterial
      || (mat as { isMeshLambertMaterial?: boolean }).isMeshLambertMaterial;
    if (!lit) return;
    // order is load-bearing: CSM.setupMaterial REPLACES onBeforeCompile, so
    // our own patches have to be hung on top of it afterwards
    this.csm?.setupMaterial(mat);
    if (!this.profile.retro) applyShaderPatches(mat);
  }

  /** Walk a subtree and register every material it carries. */
  register(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) this.registerMaterial(m);
    });
  }

  /** Called once per drawn frame, before the composer runs. */
  update(): void {
    if (this.sky) this.sky.follow(this.camera);
    if (!this.csm) return;
    // the capture harness re-poses the camera (and sometimes its fov) between
    // draws; cascades split on the projection, so they have to be rebuilt
    if (this.camera.fov !== this.lastFov || this.camera.aspect !== this.lastAspect) {
      this.lastFov = this.camera.fov;
      this.lastAspect = this.camera.aspect;
      this.csm.updateFrustums();
    }
    this.csm.update();
  }

  /** Camera projection changed for good (window resize). */
  onCameraChange(): void {
    this.lastFov = this.camera.fov;
    this.lastAspect = this.camera.aspect;
    this.csm?.updateFrustums();
  }

  /**
   * Give back every GPU resource this rig holds. CSM.dispose() only unpicks
   * its shader hooks — the cascade shadow maps and the PMREM target are ours
   * to free, and a tournament builds one of these per match.
   */
  dispose(): void {
    if (this.csm) {
      for (const light of this.csm.lights) light.shadow.dispose();
      this.csm.remove();
      this.csm.dispose();
      this.csm = null;
    }
    if (this.legacyKey) {
      this.legacyKey.shadow.dispose();
      this.scene.remove(this.legacyKey, this.legacyKey.target);
      this.legacyKey = null;
    }
    if (this.sky) {
      this.scene.remove(this.sky.dome);
      this.sky.dispose();
      this.sky = null;
    }
    if (this.bounce) {
      this.scene.remove(this.bounce);
      this.bounce.dispose();
      this.bounce = null;
    }
    this.scene.remove(this.hemi);
    this.hemi.dispose();
    this.scene.environment = null;
    this.registered.clear();
  }
}
