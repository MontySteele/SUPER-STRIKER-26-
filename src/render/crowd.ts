// The crowd (§7.1 "Stadiums", §7A.5) — v2: baked human impostors.
//
// v1.3/v1.4 seated the tier nearest the pitch with a procedural 116-triangle
// figure and dressed the upper tiers with cards cut from a four-frame cluster
// texture. On a real-GPU capture that read as exactly what it was: boxes with
// pentagon heads down low, and a field of high-frequency multicoloured
// confetti up high, filling ~40% of the broadcast frame.
//
// v2 is the PS3-era answer, and it covers EVERY tier now: each fan is one
// camera-facing, Y-locked card showing a real human render. The renders come
// from pipeline/crowd/bake_crowd.py — ten MPFB people (jackets, jeans, jumpers,
// club scarves) in twelve poses transferred from the retargeted Mixamo clips
// the players already use (idle, clap open/shut, arms up, a V, a fist, a scarf
// held overhead, dismay, three seated) — packed into two atlases:
//
//   crowd_albedo.webp  RGB albedo x baked sky visibility (sRGB), A coverage.
//                      The top garment is stored as neutral grey (mean 0.5), so
//                      every fan can wear any coat colour and any club's kit
//                      while keeping the folds, seams and prints of the render.
//   crowd_data.webp    RG card-space normal, B top-garment mask, A scarf mask.
//
// Why cards and not a better mesh: at the tele camera a fan is 12–40 px tall,
// and at that size the only thing that reads as a PERSON is a person's
// silhouette and shading — a head on a neck, sleeves, jeans with light between
// them. A mesh that good is ~10k triangles and a skinning pass per fan; a card
// is four vertices and one texture fetch pair, and its mip chain averages a
// fan down to the right colour at distance, which is what cures the confetti.
// The camera-facing turn is Y-locked, so a fan never leans with the lens.
//
// Everything that made the old crowd a crowd is kept and still costs a few
// floats of uniform per frame: per-instance phase, allegiance, seated flag and
// bowl coordinate drive POSE SELECTION on the GPU (a goal flips the home end
// into arms-up/scarf/fist cells while the away end drops into dismay; a save
// is applause, alternating the clap cells; a lull sits the back rows down; the
// Mexican wave is a travelling window of arms-up cells), plus a bob, a jump and
// a sway on the card itself. Nothing touches an instance buffer after build.
//
// Lighting is per PIXEL off the baked normals: hemisphere + one key, the same
// per-time-of-day constants as before, bent by the weather preset (an overcast
// sky flattens the key into the fill). Unlit material, so it is exempt from the
// CSM registration rule (§7A.4) and cannot take the sun once per cascade.
//
// Coverage: alpha-tested (no MSAA at DPR 2), with the test threshold scaled by
// the sampled mip level so a distant fan keeps his silhouette instead of
// thinning to nothing as box-filtered alpha drops under the cut.
//
// Determinism (§7A.3): every placement draw comes from TextureLab's seeded
// dressing stream. No Math.random, ever.

import * as THREE from 'three';
import type { RNG } from '../core/rng';
import type { QualityLevel } from './quality';
import type { TimeOfDay } from './scene';
import { floodFootprint, nightStandLight, weatherProfile } from './weather';

// ------------------------------------------------------------------- atlas

/** The atlas contract with pipeline/crowd/bake_crowd.py (crowd_atlas.json). */
const ATLAS = {
  cols: 12,          // poses
  rows: 10,          // bodies
  cellW: 160, cellH: 320,
  /** metres the cell covers */
  cardW: 1.15, cardH: 2.30,
  /** metres from the card's bottom edge to the ground point */
  foot: 0.05,
  /** bodies that were baked wearing a scarf (the accent mask exists on them) */
  scarf: [1, 1, 0, 1, 0, 1, 1, 0, 1, 1],
};

/** Pose columns, as baked. A contract with the GLSL below. */
const P = {
  idle: 0, idleB: 1, clapOpen: 2, clapShut: 3, armsUp: 4, armsV: 5, fist: 6,
  scarfUp: 7, dismay: 8, seated: 9, seatedB: 10, seatedFist: 11,
} as const;

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';

interface AtlasTextures { albedo: THREE.Texture; data: THREE.Texture }
let atlasPromise: Promise<AtlasTextures> | null = null;
let atlasLoaded: AtlasTextures | null = null;

function loadTex(url: string, srgb: boolean): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // the data map's alpha is a MASK, not coverage — never premultiply it
      t.premultiplyAlpha = false;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = 1;
      t.needsUpdate = true;
      resolve(t);
    }, undefined, (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * Start (or join) the atlas download. Idempotent. The capture harness awaits
 * it before building a renderer so a still never catches an empty stand; the
 * game simply starts it at import time and the crowd fades in on its own if a
 * match somehow beats a 3 MB download.
 */
export function preloadCrowd(): Promise<void> {
  if (!atlasPromise) {
    atlasPromise = Promise.all([
      loadTex(`${BASE}crowd/crowd_albedo.webp`, true),
      loadTex(`${BASE}crowd/crowd_data.webp`, false),
    ]).then(([albedo, data]) => {
      atlasLoaded = { albedo, data };
      return atlasLoaded;
    });
    atlasPromise.catch((e) => console.warn('crowd: atlas failed to load', e));
  }
  return atlasPromise.then(() => undefined, () => undefined);
}

if (typeof window !== 'undefined') void preloadCrowd();

// ---------------------------------------------------------------- lighting

/**
 * Per-time-of-day shading constants, LINEAR radiance (the HDR chain tone-maps
 * downstream). Tuned so a stand reads a stop or so under the pitch: a crowd sits
 * under a roof, and a crowd as bright as the grass is the loudest "texture" tell.
 */
interface CrowdLight {
  keyDir: THREE.Vector3;
  key: THREE.Color;
  sky: THREE.Color;
  ground: THREE.Color;
}

const lin = (r: number, g: number, b: number): THREE.Color =>
  new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

const CROWD_LIGHT: Record<TimeOfDay, CrowdLight> = {
  day: {
    keyDir: new THREE.Vector3(-0.62, 0.44, 0.65).normalize(),
    key: lin(0.50, 0.48, 0.41),
    sky: lin(0.32, 0.35, 0.41),
    ground: lin(0.10, 0.11, 0.11),
  },
  sunset: {
    keyDir: new THREE.Vector3(-0.85, 0.30, 0.43).normalize(),
    key: lin(0.52, 0.38, 0.25),
    sky: lin(0.21, 0.22, 0.30),
    ground: lin(0.075, 0.07, 0.07),
  },
  night: {
    // The floodlight rig is the key and it is almost straight down, so a night
    // crowd is lit tops and darker fronts. Ambient-dominated on purpose: a fan
    // always faces the pitch, so a strongly directional key would light the far
    // stand's chests and not the near stand's, and the establishing crane would
    // see nothing but blown shoulders.
    keyDir: new THREE.Vector3(-0.28, 0.92, 0.28).normalize(),
    key: lin(0.38, 0.40, 0.46),
    sky: lin(0.29, 0.31, 0.38),
    ground: lin(0.20, 0.21, 0.25),
  },
};

const NIGHT_STAND_GAIN = 2.4;

/** Bend a time-of-day preset by the weather: overcast/rain collapse the key
 *  toward a neutral grey and push the level into the fill (weather.ts).
 *  At NIGHT the key is the floodlight rig, not the sun, so the weather must
 *  not scale it by a sun factor (rain's 0.22 left a rain-night crowd black):
 *  weather.ts owns that fold and hands back the stand light directly. */
function weatherLight(tod: TimeOfDay): CrowdLight {
  if (tod === 'night') {
    const n = nightStandLight();
    // NIGHT_STAND_GAIN: weather.ts's stand light is tuned for surfaces at
    // concrete/plastic albedo. A fan is mostly dark coat (linear 0.02–0.08)
    // and his card carries its own baked sky occlusion on top, so taken
    // as-is the floodlit crowd sat ~4 stops under the pitch (measured on
    // weather_night_floodlit) where the brief is about one; x2.4 lands it at
    // ~1.5 (the day tele frame measures ~1.2 by the same crop). The gain is the
    // crowd's own exposure, applied evenly, so the rig's ratios survive.
    const g = NIGHT_STAND_GAIN;
    return {
      keyDir: new THREE.Vector3(...n.keyDir).normalize(),
      key: lin(n.key[0] * g, n.key[1] * g, n.key[2] * g),
      sky: lin(n.sky[0] * g, n.sky[1] * g, n.sky[2] * g),
      ground: lin(n.ground[0] * g, n.ground[1] * g, n.ground[2] * g),
    };
  }
  const base = CROWD_LIGHT[tod];
  const w = weatherProfile();
  const grey = lin(0.46, 0.46, 0.47);
  const key = base.key.clone().lerp(grey, w.keyGrey).multiplyScalar(w.key);
  // the crowd's fill is a hemisphere under a ROOF: it rises with the sky, but
  // nowhere near as hard as open grass does
  const hemi = 1 + (w.hemi - 1) * 0.55;
  return {
    keyDir: base.keyDir.clone(),
    key,
    sky: base.sky.clone().multiplyScalar(hemi),
    ground: base.ground.clone().multiplyScalar(hemi),
  };
}

// ----------------------------------------------------------------- density

/** How much crowd each quality level actually builds. */
export interface CrowdDetail {
  /** metres between fans along a rake */
  stepAlong: number;
  /** metres between rows up a rake */
  stepUp: number;
  /** hard ceiling on fans across every tier */
  maxFigures: number;
  /** false = no crowd at all here (RETRO keeps the v1.1 textured rake) */
  figures: boolean;
}

export const CROWD_DETAIL: Record<QualityLevel, CrowdDetail> = {
  // A card is four vertices, so the ceiling is a FILL budget, not a vertex one:
  // it is set so a Mega Bowl's three tiers all fill at seat pitch on HIGH.
  high: { stepAlong: 0.80, stepUp: 1.35, maxFigures: 26000, figures: true },
  // MEDIUM keeps nearly HIGH's density: a card is cheap, and a half-empty
  // ground reads as a worse game than a slightly softer one does
  medium: { stepAlong: 0.88, stepUp: 1.45, maxFigures: 20000, figures: true },
  retro: { stepAlong: 0, stepUp: 0, maxFigures: 0, figures: false },
};

// -------------------------------------------------------------- build spec

/** One rake's worth of seats to fill, in the stand's own local space. */
export interface CrowdBlock {
  /** stand placement: local +z runs away from the pitch, then rotated by rotY */
  cx: number; cz: number; rotY: number;
  /** length of the stand along its local x */
  len: number;
  /** the tier to seat: front edge at local z = depth, rising y0 → y0+rise */
  y0: number; rise: number; run: number; depth: number;
  /** 0..1 relative density — the far stand gets 1, the one behind the camera
   *  gets a fraction of it, because nobody has ever seen it */
  detail: number;
  /** local x spans to leave empty (the tunnel mouth, the camera gantry) */
  gaps?: [number, number][];
  /** gaps only bite below this world y */
  gapTop?: number;
  /** allegiance at local x = -len/2 and +len/2; lerped across the stand.
   *  1 = home support, 0 = away support, 0.5 = neutral/mixed. */
  alle0: number; alle1: number;
  /** 0 = the tier nearest the pitch; higher tiers sit deeper in roof shade */
  tier?: number;
  tierCount?: number;
}

/** What a stand's seating cost, for the budget line the stadium prints. */
export interface CrowdBudget {
  figures: number;
  triangles: number;
  drawCalls: number;
}

// --------------------------------------------------------------- reactions

export type CrowdReaction =
  | 'goal' | 'shot' | 'save' | 'post' | 'miss' | 'card'
  | 'corner' | 'kickoff' | 'halftime' | 'fulltime' | 'penalty';

const JOY_HOLD = 7.0;
const SAD_HOLD = 8.5;
const APPLAUD_HOLD = 3.2;
/** A crowd that has had nothing to cheer for this long starts a wave. */
const LULL_BEFORE_WAVE = 26;
const WAVE_LAPS = 1.75;
const WAVE_LAP_SEC = 9.0;

/** Per-stand instance streams, grown across every seat() call for that stand
 *  so a stand's tiers draw as ONE instanced call. */
interface StandAcc {
  parent: THREE.Object3D;
  mesh: THREE.Mesh | null;
  off: number[];    // feet xyz, height scale
  fan: number[];    // phase, lap coordinate, allegiance, seated
  look: number[];   // body row, girth, dressing roll, depth shade
  shirt: number[];  // coat rgb (linear)
  accent: number[]; // scarf rgb (linear)
  flood: number[];  // share of the key light this fan gets (1 by day)
}

export class Crowd {
  private mat: THREE.ShaderMaterial | null = null;
  private quad: THREE.PlaneGeometry | null = null;
  private stands = new Map<string, StandAcc>();
  /** night: each fan's share of the floodlight key (weather.floodFootprint) */
  private night = false;

  private uTime = { value: 0 };
  private uExcite = { value: 0.12 };
  /** x = wave head as a 0..1 lap of the bowl, y = amplitude */
  private uWave = { value: new THREE.Vector2(0, 0) };
  /** x = home support, y = away support */
  private uJoy = { value: new THREE.Vector2(0, 0) };
  private uSad = { value: new THREE.Vector2(0, 0) };
  private uApplaud = { value: 0 };
  private uReady = { value: 0 };

  private clock = 0;
  private base = 0.12;
  private baseTarget = 0.12;
  private spike = 0;
  private joy: [number, number] = [0, 0];
  private sad: [number, number] = [0, 0];
  private applaud = 0;
  private quietFor = 0;
  private waveT = -1;

  budget: CrowdBudget = { figures: 0, triangles: 0, drawCalls: 0 };

  constructor(
    private rng: RNG,
    tod: TimeOfDay,
    private detail: CrowdDetail,
    private homeShirt: THREE.Color,
    private awayShirt: THREE.Color,
  ) {
    if (!detail.figures) return;
    // the card: x -0.5..0.5, y 0..1, uv as three lays it out
    this.quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.quad.translate(0, 0.5, 0);
    this.night = tod === 'night';
    this.mat = this.makeMaterial(weatherLight(tod));
  }

  /** true when this quality level actually seats figures. */
  get live(): boolean {
    return this.detail.figures && this.mat !== null;
  }

  // ------------------------------------------------------------- material

  private makeMaterial(light: CrowdLight): THREE.ShaderMaterial {
    const uAlbedo = { value: atlasLoaded?.albedo ?? null as THREE.Texture | null };
    const uData = { value: atlasLoaded?.data ?? null as THREE.Texture | null };
    this.uReady.value = atlasLoaded ? 1 : 0;
    if (!atlasLoaded) {
      void preloadCrowd().then(() => {
        if (!atlasLoaded) return;
        uAlbedo.value = atlasLoaded.albedo;
        uData.value = atlasLoaded.data;
        this.uReady.value = 1;
      });
    }
    const f = (v: number): string => v.toFixed(4);
    const mat = new THREE.ShaderMaterial({
      fog: true,
      side: THREE.DoubleSide,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uAlbedo, uData,
        uReady: this.uReady,
        uTime: this.uTime,
        uExcite: this.uExcite,
        uWave: this.uWave,
        uJoy: this.uJoy,
        uSad: this.uSad,
        uApplaud: this.uApplaud,
        uKeyDir: { value: light.keyDir },
        uKey: { value: light.key },
        uSky: { value: light.sky },
        uGround: { value: light.ground },
        uTexSize: { value: new THREE.Vector2(ATLAS.cols * ATLAS.cellW, ATLAS.rows * ATLAS.cellH) },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aOff;    // feet xyz, height scale
        attribute vec4 aFan;    // phase, lap coordinate, allegiance, seated
        attribute vec4 aLook;   // body row, girth, dressing roll, depth shade
        attribute vec3 aShirt;
        attribute vec3 aAccent;
        attribute float aFlood;
        uniform float uTime;
        uniform float uExcite;
        uniform vec2  uWave;
        uniform vec2  uJoy;
        uniform vec2  uSad;
        uniform float uApplaud;
        uniform float uReady;
        varying vec2  vUv;
        varying vec3  vShirt;
        varying vec3  vAccent;
        varying float vDeep;
        varying vec3  vRight;
        varying vec3  vFwd;
        varying float vFlood;

        void main() {
          float ph   = aFan.x;
          float alle = aFan.z;
          float seat = aFan.w;
          float t    = uTime;
          float tp   = t + ph * 6.2831853;
          float rnd  = fract( ph * 733.71 );
          float rnd2 = fract( ph * 197.13 + 0.37 );
          float rnd3 = fract( ph * 51.97 + 0.61 );
          float dress = aLook.z;

          float joy = mix( uJoy.y, uJoy.x, alle );
          float sad = mix( uSad.y, uSad.x, alle );

          float d = aFan.y - uWave.x;
          d -= floor( d + 0.5 );
          float wave = uWave.y * smoothstep( 0.055, 0.0, abs( d ) );

          float energy = clamp( uExcite + joy * 1.15 - sad * 0.7, 0.0, 1.4 );
          float stand = clamp( ( 1.0 - seat )
            + seat * clamp( energy * 1.55 + wave * 1.3 - sad * 1.2, 0.0, 1.0 ), 0.0, 1.0 );
          // each fan has his own threshold, so a stand rises in a ripple
          bool up = stand > 0.30 + 0.40 * rnd3;

          // Not everyone is equally demonstrative; see v1.4's note on 1,500
          // identical pairs of arms.
          float joyI = joy * ( 0.55 + 0.62 * rnd2 );
          float armUp = clamp(
              wave * 1.05 + joyI * 1.45
            + step( 0.88, rnd ) * uExcite * 0.9
            + step( 0.965, fract( rnd2 + t * 0.055 ) ) * 0.85,
            0.0, 1.0 ) * ( 1.0 - sad * 0.92 );
          // a pumping crowd alternates between two cells, on its own beat
          float beat = step( 0.5, fract( tp * ( 0.9 + 0.8 * rnd ) ) );

          float pose;
          if ( !up ) {
            pose = ( joyI > 0.30 || wave > 0.5 ) ? ${f(P.seatedFist)}
              : ( rnd2 < 0.55 ? ${f(P.seated)} : ${f(P.seatedB)} );
          } else if ( sad > 0.25 && rnd < sad * 1.1 ) {
            pose = rnd2 < 0.78 ? ${f(P.dismay)} : ${f(P.fist)};
          } else if ( armUp > 0.5 ) {
            if ( dress > 0.55 && rnd3 < 0.6 ) pose = ${f(P.scarfUp)};
            else if ( rnd2 < 0.40 ) pose = mix( ${f(P.armsUp)}, ${f(P.armsV)}, beat );
            else if ( rnd2 < 0.72 ) pose = mix( ${f(P.armsV)}, ${f(P.fist)}, beat );
            else pose = mix( ${f(P.fist)}, ${f(P.armsUp)}, beat );
          } else if ( uApplaud > 0.18 + 0.5 * rnd || ( uExcite > 0.55 && rnd > 0.7 ) ) {
            // clapping: open, shut, ~3 claps a second, each fan on his own beat
            pose = mod( floor( t * 6.0 + ph * 17.0 ), 2.0 ) < 0.5 ? ${f(P.clapOpen)} : ${f(P.clapShut)};
          } else {
            // idle, with the odd shift of weight
            float sw = step( 0.5, fract( t * 0.035 + rnd3 ) );
            pose = mix( ${f(P.idle)}, ${f(P.idleB)}, abs( step( 0.5, rnd2 ) - sw * step( 0.7, rnd ) ) );
          }

          float bob  = ( 0.006 + 0.07 * energy ) * abs( sin( tp * ( 2.0 + 2.4 * energy ) ) ) * float( up );
          float jump = joy * max( 0.0, sin( tp * 4.6 ) ) * 0.30 * float( up );
          float sway = sin( tp * 0.9 ) * ( 0.01 + 0.04 * energy ) + sin( t * 0.43 + ph * 17.0 ) * 0.012;

          // ---- the card: Y-locked, facing the lens ----
          float h = aOff.w;
          vec3 feet = aOff.xyz;
          vec3 toCam = cameraPosition - feet;
          toCam.y = 0.0;
          vec3 fwd = normalize( toCam + vec3( 1e-4, 0.0, 0.0 ) );
          vec3 right = vec3( fwd.z, 0.0, -fwd.x );
          // Stand the card a little proud of the fan's own spot, toward the
          // lens: a card turned to an oblique camera would otherwise swing a
          // corner into the rake behind and lose a foot to the terrace, and the
          // per-fan offset keeps two neighbours' overlapping cards off one depth.
          feet += fwd * ( 0.22 + 0.12 * rnd3 ) * h;
          float w = ${f(ATLAS.cardW)} * h * aLook.y;
          float ht = ${f(ATLAS.cardH)} * h;
          vec3 p = feet
            + right * ( position.x * w + sway * position.y * ht * 0.35 )
            + vec3( 0.0, position.y * ht - ${f(ATLAS.foot)} * h + bob + jump, 0.0 );
          // not loaded yet: collapse to nothing rather than draw black cards
          p = mix( feet, p, uReady );

          vec2 cell = vec2( pose, aLook.x );
          vUv = vec2( ( cell.x + uv.x ) / ${f(ATLAS.cols)},
                      1.0 - ( cell.y + 1.0 - uv.y ) / ${f(ATLAS.rows)} );
          vShirt = aShirt;
          vAccent = aAccent;
          vDeep = aLook.w;
          vRight = right;
          vFwd = fwd;
          vFlood = aFlood;

          vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D uAlbedo;
        uniform sampler2D uData;
        uniform vec3 uKeyDir;
        uniform vec3 uKey;
        uniform vec3 uSky;
        uniform vec3 uGround;
        uniform vec2 uTexSize;
        varying vec2  vUv;
        varying vec3  vShirt;
        varying vec3  vAccent;
        varying float vDeep;
        varying vec3  vRight;
        varying vec3  vFwd;
        varying float vFlood;

        void main() {
          #include <logdepthbuf_fragment>
          vec4 a = texture2D( uAlbedo, vUv );
          // Coverage-preserving alpha test: box-filtered mips lose alpha, so a
          // distant fan would thin to a stick and then vanish. Scale the
          // sampled alpha up with the mip level being read.
          vec2 tx = vUv * uTexSize;
          float lod = 0.5 * log2( max( dot( dFdx( tx ), dFdx( tx ) ), dot( dFdy( tx ), dFdy( tx ) ) ) );
          float cov = a.a * ( 1.0 + max( lod, 0.0 ) * 0.28 );
          if ( cov < 0.5 ) discard;

          vec4 dt = texture2D( uData, vUv );
          vec2 nxy = dt.rg * 2.0 - 1.0;
          vec3 n = normalize( vRight * nxy.x + vec3( 0.0, 1.0, 0.0 ) * nxy.y
            + vFwd * sqrt( max( 0.0, 1.0 - dot( nxy, nxy ) ) ) );

          vec3 col = a.rgb;
          // the grey garment is mean 0.5 — x2 puts the tint at its own value
          col = mix( col, vShirt * a.r * 2.0, dt.b );
          col = mix( col, vAccent * a.r * 2.0, dt.a );

          vec3 amb = mix( uGround, uSky, n.y * 0.5 + 0.5 );
          vec3 shade = amb + uKey * vFlood * max( dot( n, uKeyDir ), 0.0 );
          gl_FragColor = vec4( col * shade * vDeep, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    });
    return mat;
  }

  // ---------------------------------------------------------------- build

  private standFor(parent: THREE.Object3D, key: string): StandAcc {
    let s = this.stands.get(key);
    if (!s) {
      s = { parent, mesh: null, off: [], fan: [], look: [], shirt: [], accent: [], flood: [] };
      this.stands.set(key, s);
    }
    return s;
  }

  /** (Re)emit one stand's accumulated fans as a single instanced draw. */
  private flush(s: StandAcc): void {
    const count = s.off.length / 4;
    if (s.mesh) {
      s.mesh.geometry.dispose();
      s.mesh.removeFromParent();
      s.mesh = null;
      this.budget.drawCalls -= 1;
    }
    if (count === 0) return;
    const geo = new THREE.InstancedBufferGeometry();
    // own copies of the four-vertex quad: a disposed stand must not free a
    // buffer another stand is still drawing from
    geo.index = this.quad!.index!.clone();
    geo.setAttribute('position', this.quad!.getAttribute('position').clone());
    geo.setAttribute('uv', this.quad!.getAttribute('uv').clone());
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(s.off), 4));
    geo.setAttribute('aFan', new THREE.InstancedBufferAttribute(new Float32Array(s.fan), 4));
    geo.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(s.look), 4));
    geo.setAttribute('aShirt', new THREE.InstancedBufferAttribute(new Float32Array(s.shirt), 3));
    geo.setAttribute('aAccent', new THREE.InstancedBufferAttribute(new Float32Array(s.accent), 3));
    geo.setAttribute('aFlood', new THREE.InstancedBufferAttribute(new Float32Array(s.flood), 1));
    geo.instanceCount = count;
    // cull the whole stand as one object: bound every fan's feet, padded by a
    // card's height (jumps and arms go up, not sideways)
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) box.expandByPoint(v.set(s.off[i * 4], s.off[i * 4 + 1], s.off[i * 4 + 2]));
    box.max.y += ATLAS.cardH * 1.3;
    geo.boundingBox = box;
    geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    geo.boundingSphere.radius += 1.5;
    const mesh = new THREE.Mesh(geo, this.mat!);
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = 'crowd';
    s.parent.add(mesh);
    s.mesh = mesh;
    this.budget.drawCalls += 1;
  }

  /** Pick a body row. Scarf-owners (dressing roll > 0.55) get a body that was
   *  baked with a scarf; the rest get any body, and the scarf on it wears a
   *  plain winter colour instead of the club's. */
  private pickBody(dress: number, rng: RNG): number {
    const want = dress > 0.55;
    for (let k = 0; k < 4; k++) {
      const b = Math.min(ATLAS.rows - 1, Math.floor(rng.next() * ATLAS.rows));
      if (!want || ATLAS.scarf[b]) return b;
    }
    return 0;
  }

  private pushFan(s: StandAcc, x: number, y: number, z: number, h: number,
    phase: number, lap: number, alle: number, seated: number,
    body: number, girth: number, dress: number, deep: number,
    shirt: THREE.Color, accent: THREE.Color): void {
    s.off.push(x, y, z, h);
    s.fan.push(phase, lap, alle, seated);
    s.look.push(body, girth, dress, deep);
    s.shirt.push(shirt.r, shirt.g, shirt.b);
    s.accent.push(accent.r, accent.g, accent.b);
    s.flood.push(this.night ? floodFootprint(x, y + 1.2, z) : 1);
  }

  /**
   * Seat one tier of one stand. Every tier of a stand joins the same instanced
   * draw (it is re-emitted on each call; build time only). Returns the number
   * of fans actually seated.
   */
  seat(parent: THREE.Object3D, block: CrowdBlock): number {
    if (!this.live) return 0;
    const det = this.detail;
    const stepAlong = det.stepAlong / Math.max(0.35, block.detail);
    const stepUp = det.stepUp / Math.max(0.5, Math.min(1, block.detail + 0.35));
    const rakeLen = Math.hypot(block.rise, block.run);
    const cols = Math.max(2, Math.floor(block.len / stepAlong));
    const rows = Math.max(1, Math.floor(rakeLen / stepUp));
    const room = det.maxFigures - this.budget.figures;
    if (room <= 0) return 0;

    const s = this.standFor(parent, `${block.cx}|${block.cz}|${block.rotY}`);
    const rng = this.rng;
    const col = new THREE.Color();
    const ac = new THREE.Color();
    const cosR = Math.cos(block.rotY), sinR = Math.sin(block.rotY);
    const tier = block.tier ?? 0;
    // at night the floodlight footprint already falls away with height, so the
    // roof-shade term would count the same darkness twice
    const tierShade = (tier / Math.max(1, (block.tierCount ?? 1) - 1)) * (this.night ? 0.12 : 0.30);

    let n = 0;
    for (let r = 0; r < rows && n < room; r++) {
      const up = (r + 0.5) / rows;
      const y = block.y0 + block.rise * up;
      const z = block.depth + block.run * up;
      for (let c = 0; c < cols && n < room; c++) {
        const along = -block.len / 2 + stepAlong * (c + 0.5) + rng.range(-0.16, 0.16);
        if (y < (block.gapTop ?? Infinity)
          && block.gaps?.some(([a, b]) => along > a && along < b)) continue;
        // a few empty seats, more of them high up
        if (rng.next() < 0.015 + up * 0.05 + tier * 0.02) continue;

        const lz = z + rng.range(-0.10, 0.10);
        const wx = block.cx + along * cosR + lz * sinR;
        const wz = block.cz - along * sinR + lz * cosR;
        const h = rng.range(0.93, 1.08);
        const girth = rng.range(0.94, 1.10);
        const lap = (Math.atan2(wz, wx) / (Math.PI * 2)) + 0.5;
        const alle = block.alle0 + (block.alle1 - block.alle0) * ((along / block.len) + 0.5);
        // front rows stand all match; the back sits until something happens
        const seated = rng.next() < 0.22 + up * 0.50 ? 1 : 0;
        const phase = rng.next();
        // depth: the back of a rake and the upper tiers are under the roof
        const deep = (1 - up * (this.night ? 0.15 : 0.30)) * (1 - tierShade);
        this.pickShirt(col, alle, rng);
        const dress = rng.next();
        if (dress > 0.55) this.pickAccent(ac, alle, rng);
        else this.pickPlainScarf(ac, col, rng);
        const body = this.pickBody(dress, rng);
        this.pushFan(s, wx, y, wz, h, phase, lap, alle, seated, body, girth, dress, deep, col, ac);
        n++;
      }
    }
    this.flush(s);
    this.budget.figures += n;
    this.budget.triangles += n * 2;
    return n;
  }

  /**
   * A handful of seated figures on a bench (the dugouts). Same cards, same
   * uniforms — so the subs are out of their seats on a goal too.
   */
  seatBench(parent: THREE.Object3D, spots: { x: number; y: number; z: number; rotY: number;
    alle: number; shirt: THREE.Color }[]): void {
    if (!this.live || spots.length === 0) return;
    const s = this.standFor(parent, 'bench');
    const rng = this.rng;
    for (const sp of spots) {
      // a bench wears the kit: coat = the bench colour, and a dark "scarf"
      // (the training top's collar) rather than merchandise
      const collar = sp.shirt.clone().multiplyScalar(0.5);
      this.pushFan(s, sp.x, sp.y, sp.z, rng.range(0.97, 1.04),
        rng.next(), (Math.atan2(sp.z, sp.x) / (Math.PI * 2)) + 0.5, sp.alle, 1,
        this.pickBody(0, rng), 1, 0.4, 0.8, sp.shirt, collar);
    }
    this.flush(s);
    this.budget.figures += spots.length;
    this.budget.triangles += spots.length * 2;
  }

  /**
   * The palette. A home end is not "everyone in the home shirt" — it is a
   * majority in the shirt, a scattering of white/grey, and a lot of people in
   * a dark coat because it is a football match and it is cold. Values are the
   * garment's LINEAR albedo: the baked grey carries the folds around it.
   */
  private pickShirt(out: THREE.Color, alle: number, rng: RNG): void {
    const roll = rng.next();
    const kit = rng.next() < alle ? this.homeShirt : this.awayShirt;
    if (roll < 0.32) {
      // the replica shirt, never at full kit value — it is under a roof, in a
      // stand, twenty rows back
      out.copy(kit).multiplyScalar(rng.range(0.40, 0.80));
      out.offsetHSL(rng.range(-0.02, 0.02), rng.range(-0.14, 0.02), 0);
    } else if (roll < 0.46) {
      const g = rng.range(0.16, 0.42);
      out.setRGB(g, g * 1.01, g * 1.05, THREE.LinearSRGBColorSpace);
    } else if (roll < 0.78) {
      // dark outerwear — a third of any real crowd, and what stops it glowing
      const g = rng.range(0.022, 0.075);
      out.setRGB(g * rng.range(0.8, 1.25), g, g * rng.range(0.9, 1.4),
        THREE.LinearSRGBColorSpace);
    } else if (roll < 0.94) {
      // the winter-coat rack: olive, navy, oxblood, tan, teal, brown
      const HUES = [0.10, 0.60, 0.015, 0.09, 0.48, 0.065];
      const h = HUES[Math.min(HUES.length - 1, Math.floor(rng.next() * HUES.length))];
      out.setHSL(h + rng.range(-0.02, 0.02), rng.range(0.10, 0.36),
        rng.range(0.07, 0.16));
    } else {
      // the odd bright jacket, muted so 6% of a stand does not read as confetti
      out.setHSL(rng.next(), rng.range(0.22, 0.5), rng.range(0.14, 0.28));
    }
  }

  /** The club colour a fan carries ON TOP of whatever coat — the scarf. */
  private pickAccent(out: THREE.Color, alle: number, rng: RNG): void {
    const kit = rng.next() < alle ? this.homeShirt : this.awayShirt;
    out.copy(kit).multiplyScalar(rng.range(0.50, 0.95));
    out.offsetHSL(rng.range(-0.03, 0.03), rng.range(-0.10, 0.06), 0);
  }

  /** A scarf that is just a scarf: charcoal, navy, camel, or the coat itself. */
  private pickPlainScarf(out: THREE.Color, coat: THREE.Color, rng: RNG): void {
    const r = rng.next();
    if (r < 0.35) out.copy(coat).multiplyScalar(0.8);
    else if (r < 0.65) out.setRGB(0.03, 0.03, 0.035, THREE.LinearSRGBColorSpace);
    else if (r < 0.85) out.setRGB(0.02, 0.03, 0.07, THREE.LinearSRGBColorSpace);
    else out.setRGB(0.20, 0.13, 0.07, THREE.LinearSRGBColorSpace);
  }

  // ------------------------------------------------------------ behaviour

  /** The match's running anticipation, 0..1. Floored: even a goalless 20th
   *  minute has people fidgeting. */
  setExcitement(v: number): void {
    this.baseTarget = 0.09 + 0.91 * Math.max(0, Math.min(1, v));
  }

  /**
   * One beat of the match. `teamIdx` is the team the beat belongs to: who
   * scored, whose keeper saved, who got booked. A few scalars; nothing walks
   * the instance buffers.
   */
  react(kind: CrowdReaction, teamIdx = 0): void {
    const side = teamIdx === 0 ? 0 : 1;
    const other = 1 - side;
    switch (kind) {
      case 'goal':
        this.joy[side] = 1;
        this.sad[other] = 1;
        this.applaud = 0.35;
        this.spike = 1;
        this.baseTarget = Math.max(this.baseTarget, 0.55);
        break;
      case 'shot':
        this.spike = Math.max(this.spike, 0.62);
        this.applaud = Math.max(this.applaud, 0.2);
        break;
      case 'save':
        this.applaud = 1;
        this.joy[side] = Math.max(this.joy[side], 0.28);
        this.sad[other] = Math.max(this.sad[other], 0.35);
        this.spike = Math.max(this.spike, 0.7);
        break;
      case 'post':
        this.spike = Math.max(this.spike, 0.85);
        this.applaud = Math.max(this.applaud, 0.55);
        break;
      case 'miss':
        this.sad[side] = Math.max(this.sad[side], 0.5);
        this.spike = Math.max(this.spike, 0.3);
        break;
      case 'card':
        this.spike = Math.max(this.spike, 0.55);
        this.joy[other] = Math.max(this.joy[other], 0.22);
        this.sad[side] = Math.max(this.sad[side], 0.4);
        break;
      case 'corner':
      case 'penalty':
        this.spike = Math.max(this.spike, kind === 'penalty' ? 0.8 : 0.42);
        break;
      case 'kickoff':
        this.applaud = Math.max(this.applaud, 0.75);
        this.spike = Math.max(this.spike, 0.45);
        break;
      case 'halftime':
        this.baseTarget = 0.06;
        this.spike = 0;
        this.joy = [0, 0];
        this.sad = [0, 0];
        this.applaud = 0.5;
        this.waveT = -1;
        break;
      case 'fulltime':
        this.applaud = 1;
        this.spike = 0.8;
        this.baseTarget = 0.5;
        this.waveT = -1;
        break;
    }
    if (kind !== 'halftime') this.quietFor = 0;
    if (kind !== 'kickoff' && this.spike > 0.4) this.waveT = -1;
  }

  /**
   * Drive the crowd. `dt` is the renderer's frame step — the real clock in a
   * match, the harness's fixed virtual step under capture.
   */
  update(dt: number): void {
    if (!this.live || dt < 0) return;
    this.clock += dt;
    this.uTime.value = this.clock;

    this.base += (this.baseTarget - this.base) * Math.min(1, dt * 0.9);
    this.spike = Math.max(0, this.spike - dt / 3.4);
    this.uExcite.value = Math.min(1.25, this.base + this.spike);

    this.joy[0] = Math.max(0, this.joy[0] - dt / JOY_HOLD);
    this.joy[1] = Math.max(0, this.joy[1] - dt / JOY_HOLD);
    this.sad[0] = Math.max(0, this.sad[0] - dt / SAD_HOLD);
    this.sad[1] = Math.max(0, this.sad[1] - dt / SAD_HOLD);
    this.applaud = Math.max(0, this.applaud - dt / APPLAUD_HOLD);
    this.uJoy.value.set(easeOut(this.joy[0]), easeOut(this.joy[1]));
    this.uSad.value.set(this.sad[0], this.sad[1]);
    this.uApplaud.value = this.applaud;

    if (this.waveT >= 0) {
      this.waveT += dt / WAVE_LAP_SEC;
      if (this.waveT > WAVE_LAPS) {
        this.waveT = -1;
        this.uWave.value.set(0, 0);
      } else {
        const amp = Math.min(1, this.waveT * 3) * Math.min(1, (WAVE_LAPS - this.waveT) * 2.2);
        this.uWave.value.set(this.waveT % 1, amp);
      }
    } else {
      this.quietFor += dt;
      this.uWave.value.y = 0;
      if (this.quietFor > LULL_BEFORE_WAVE && this.uExcite.value < 0.34) {
        this.quietFor = 0;
        this.waveT = 0;
      }
    }
  }

  /** Force a wave to start now (the ticker's "the crowd amuse themselves"). */
  startWave(): void {
    if (this.waveT < 0) this.waveT = 0;
  }

  dispose(): void {
    for (const s of this.stands.values()) {
      if (s.mesh) {
        s.mesh.geometry.dispose();
        s.mesh.removeFromParent();
      }
    }
    this.stands.clear();
    this.mat?.dispose();
    this.quad?.dispose();
    // the atlas is shared across matches (module-level), so it is NOT disposed
  }
}

/** A goal is a bang followed by a long tail, not a linear fade. */
function easeOut(v: number): number {
  return v <= 0 ? 0 : 1 - (1 - v) * (1 - v);
}
