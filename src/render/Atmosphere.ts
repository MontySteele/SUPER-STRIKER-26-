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
import { applyShaderPatches } from './materials';
import type { QualityProfile } from './quality';
import type { TimeOfDay } from './scene';

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
}

const dir = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z).normalize();

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
    },
    sunDir: dir(-0.62, 0.44, 0.65),
    keyColor: 0xfff0d8, keyIntensity: 2.5,
    hemiSky: 0x9cc4f2, hemiGround: 0x3d6b33, hemiIntensity: 0.42,
    bounceColor: 0xffd9a8, bounceIntensity: 0.3, bounceDir: dir(0.7, 0.22, -0.6),
    fog: 0xb9d0e6, fogNear: 260, fogFar: 820,
    envIntensity: 0.3,
    exposure: 1.15,
  },
  sunset: {
    sky: {
      zenith: 0x1e2a5c, horizon: 0xff8a35, ground: 0x2b2318,
      // the sun clears the west stand roof at this elevation and lands in
      // frame on the bloom-check shot; 30 blew half the pitch out with it
      sun: 0xffc07a, sunIntensity: 15, sunSize: 0.04, haze: 0.7,
      sunDir: dir(-0.85, 0.3, 0.43), gain: 1.5,
    },
    // ~17° elevation: still a long-shadow late-afternoon key, but not the 9°
    // that left a horizontal pitch taking 16% of the sun and the mowing
    // stripes — the entire point of the low-sun shot — invisible.
    sunDir: dir(-0.85, 0.3, 0.43),
    keyColor: 0xffc48c, keyIntensity: 2.5,
    // the fill at dusk is the HALF of the sky the sun isn't in, which is
    // violet-blue. A warm fill under a warm key is what made the old sunset
    // read as one flat orange wash with grey shadows in it.
    hemiSky: 0x93a8dd, hemiGround: 0x3c4a2c, hemiIntensity: 0.4,
    bounceColor: 0xffcf9a, bounceIntensity: 0.3, bounceDir: dir(0.85, 0.3, -0.4),
    fog: 0x6b4a4e, fogNear: 220, fogFar: 720,
    envIntensity: 0.26,
    // the low key still rakes the grass at a grazing angle here; much above
    // 1.1 and the sunlit half of the pitch clips to a flat cream sheet
    exposure: 1.05,
  },
  night: {
    // no sun: the key IS the floodlight rig, high and cool, and the "sky"
    // is a dim gradient with a moon-sized core so the bowl has a lid
    sky: {
      zenith: 0x03060f, horizon: 0x0e1c31, ground: 0x05080d,
      sun: 0xc8d8ff, sunIntensity: 1.4, sunSize: 0.012, haze: 0.4,
      sunDir: dir(0.4, 0.5, -0.7), gain: 1.0,
    },
    sunDir: dir(-0.3, 0.9, 0.32),
    keyColor: 0xf0f5ff, keyIntensity: 2.9,
    hemiSky: 0x24334f, hemiGround: 0x1a2c1c, hemiIntensity: 0.42,
    bounceColor: 0xffe2b8, bounceIntensity: 0.2, bounceDir: dir(0.5, 0.5, -0.7),
    fog: 0x070c18, fogNear: 190, fogFar: 580,
    envIntensity: 0.5,
    exposure: 1.35,
  },
};

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
    tod: TimeOfDay,
    private profile: QualityProfile,
  ) {
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

      scene.fog = new THREE.Fog(p.fog, p.fogNear, p.fogFar);
      scene.background = new THREE.Color(p.fog);
      return;
    }

    const p = PRESETS[tod];
    this.exposure = p.exposure;

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
      shadowBias: -0.0006,
      lightDirection: p.sunDir.clone().negate(),
      lightIntensity: p.keyIntensity,
      lightNear: 1,
      lightFar: 900,
      lightMargin: 120,
    });
    for (const light of this.csm.lights) {
      light.color.set(p.keyColor);
      // CSM has no knob for either of these. normalBias kills the acne a 105m
      // pitch under a low sun would otherwise show everywhere; radius is what
      // the PCF tap kernel spreads by, i.e. how soft the edge reads.
      light.shadow.normalBias = 0.035;
      light.shadow.radius = 2.2;
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
