// Procedural sky (§7A.4): a vertical gradient, a sun disc with its bloom-able
// core, and a horizon haze band, all in one small shader. It does two jobs at
// once — it is the visible background (a dome pinned to the camera, so the
// backdrop stops being a flat clear colour), and it is the source scene that
// PMREM bakes into scene.environment for real image-based specular.
//
// Everything it writes is HDR-linear: the sun core sits well above 1.0 so the
// bloom threshold catches it, and there is exactly one tone-map in the whole
// pipeline, downstream in the grade pass (§7A.6).

import * as THREE from 'three';

export interface SkyPreset {
  zenith: number;
  horizon: number;
  /** below the horizon line — reads as haze over distant ground, not sky */
  ground: number;
  sun: number;
  /** HDR value of the sun core; 0 for an overcast/floodlit sky */
  sunIntensity: number;
  /** angular radius of the disc in radians */
  sunSize: number;
  /** how hard the horizon band glows */
  haze: number;
  /** direction TO the sun (normalized) */
  sunDir: THREE.Vector3;
  /**
   * Overall radiance of the gradient. A real sky is several times brighter
   * than the grass under it — leaving it at 1.0 gives a backdrop that is
   * technically HDR and practically never clears the bloom threshold, which
   * is how you end up with a flat pastel sky and no glow anywhere.
   */
  gain?: number;

  // ------------------------------------------------------------- the deck
  // §7A.4c. A flat gradient is the single most "this is a render" thing left
  // in a wide shot: every real sky has SCALE in it, and scale comes from
  // clouds getting smaller and flatter as they run to the horizon.
  //
  // The deck is a plane at a fixed height, sampled by ray-marching nothing at
  // all: the view direction is intersected with y = CLOUD_H analytically, and
  // the resulting ground-plane coordinate is fed to a 4-octave value-noise
  // FBM. That gives true perspective foreshortening — the cells crowd
  // together toward the horizon on their own — for the cost of ~20 ALU and no
  // texture at all. The noise is a HASH of the seeded offset below, so a
  // capture of the same shot is the same sky, pixel for pixel, forever.

  /** 0 = clear, 1 = solid lid */
  cloud?: number;
  /** contrast of the deck: <1 soft stratus, >2 hard-edged cumulus */
  cloudSharp?: number;
  /** lit tops */
  cloudColor?: number;
  /** shaded bases — this is where an overcast's mood actually lives */
  cloudShadow?: number;
  /** metres per noise cell at the deck, and the seeded world offset */
  cloudScale?: number;
  cloudOffset?: [number, number];

  /**
   * §7A.4d. The glow a floodlit bowl throws into its own air: a wide, soft
   * band hugging the roof line that the haze term cannot be (the haze is the
   * HORIZON's colour, and at night the horizon is black). It also lights the
   * cloud deck from below, strongest over the bowl. 0 / omitted = none.
   */
  bowlGlow?: number;
  /** how fast the glow falls off with elevation; higher = a tighter band */
  bowlGlowWidth?: number;
}

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 ground;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  uniform float sunIntensity;
  uniform float sunSize;
  uniform float haze;
  uniform float gain;
  uniform float cloud;
  uniform float cloudSharp;
  uniform vec3 cloudColor;
  uniform vec3 cloudShadow;
  uniform float cloudScale;
  uniform vec2 cloudOffset;
  uniform vec3 bowlGlow;
  uniform float bowlGlowWidth;
  varying vec3 vDir;

  // ---- value noise. Deterministic, seeded only through cloudOffset.
  float ss26Hash(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y * 95.4337);
  }

  float ss26Noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(ss26Hash(i), ss26Hash(i + vec2(1.0, 0.0)), u.x),
      mix(ss26Hash(i + vec2(0.0, 1.0)), ss26Hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float ss26Fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) {
      s += a * ss26Noise(p);
      p = p * 2.03 + 11.7;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // Gradient: horizon -> zenith above, horizon -> ground haze below.
    //
    // Two curves, not one. The old single pow(h, 0.42) is a soft ramp that
    // spends most of its range on the boring middle of the sky, and at DPR 2
    // on a Retina panel that reads as a flat wash with a band in it. The
    // smoothstep is a CONTRAST curve laid over the same ramp: it steepens the
    // transition where the eye is looking (the first 25° above the roof line)
    // and flattens the top, which is what a real late-afternoon sky does and
    // what makes the horizon read as an edge instead of a fade.
    float hh = clamp(h, 0.0, 1.0);
    float ramp = pow(hh, 0.42);
    ramp = mix(ramp, smoothstep(0.0, 0.62, ramp), 0.55);
    vec3 sky = mix(horizon, zenith, ramp);
    vec3 below = mix(horizon, ground, clamp(-h * 2.6, 0.0, 1.0));
    vec3 c = h > 0.0 ? sky : below;

    // haze band hugging the horizon line — this is what the scene fog reads
    // as, so the two stay coherent. Two widths: a tight bright lip right on
    // the line and the broad wash above it, because one exponential cannot be
    // both a horizon and a glow.
    c = mix(c, horizon * 1.25, exp(-abs(h) * 12.0) * haze);
    c = mix(c, horizon * 1.42, exp(-abs(h) * 46.0) * haze * 0.65);
    c *= gain;
    // the bowl's own light pollution, above the line only
    float glowK = exp(-max(h, 0.0) * bowlGlowWidth) * smoothstep(-0.06, 0.02, h);
    c += bowlGlow * glowK;

    // sun: a hot core plus two glow lobes (tight bloom seed, wide sky wash)
    float cosA = dot(d, sunDir);
    float disc = smoothstep(cos(sunSize * 1.7), cos(sunSize * 0.6), cosA);
    float tight = pow(max(cosA, 0.0), 900.0);
    float wide = pow(max(cosA, 0.0), 9.0);
    c += sunColor * (disc * sunIntensity + tight * sunIntensity * 0.35 + wide * 0.28);

    // ---- the cloud deck (see SkyPreset) ----
    // Intersect the view ray with a plane 1 unit up. The 1/h is the whole
    // perspective: at h = 0.9 (straight up) a cell is one unit across, at
    // h = 0.05 (just over the roof line) it is twenty, so the deck runs away
    // to the horizon by itself.
    if (cloud > 0.001 && h > 0.0) {
      vec2 pl = (d.xz / max(h, 0.012)) * cloudScale + cloudOffset;
      // A 4-octave FBM with amplitudes 1/2..1/16 sums to at most 0.9375 and
      // sits around 0.47, so the raw value covers barely a fifth of [0,1] —
      // thresholding it directly is how you end up with three wisps and call
      // it a sky. Normalise, then stretch the contrast so the deck actually
      // has edges, and only then threshold.
      float n = clamp((ss26Fbm(pl) * 1.0667 - 0.5) * 2.4 + 0.5, 0.0, 1.0);
      // the cloud uniform slides the threshold: 0 is a clear day, 1 is a lid.
      float thr = mix(0.80, 0.02, cloud);
      float cover = smoothstep(thr, thr + 0.22, n);
      // second, finer octave set for the ragged edge, gated on the first so
      // the wisps only ever appear where there is cloud to be ragged
      cover *= 0.72 + 0.28 * smoothstep(0.32, 0.78, ss26Fbm(pl * 3.1 + 5.0));
      cover = pow(clamp(cover, 0.0, 1.0), max(cloudSharp, 0.05));
      // Clouds do not exist at the horizon line — they run INTO it. Fading
      // the deck out across the bottom 7° both hides the plane's own
      // singularity and is what a real sky does.
      cover *= smoothstep(0.0, 0.12, h);
      // shading: a fourth octave stands in for the self-shadowing that makes
      // a cumulus a solid object and a stratus a flat sheet
      float lit = smoothstep(0.30, 0.74, ss26Fbm(pl * 1.7 - 3.0));
      vec3 body = mix(cloudShadow, cloudColor, lit);
      // ...and the sun still rims whatever is in front of it
      body += sunColor * wide * 0.5 * (1.0 - lit) * step(0.01, sunIntensity);
      // ...and a floodlit bowl lights the underside of whatever is over it
      body += bowlGlow * exp(-h * bowlGlowWidth * 0.45) * (1.2 - 0.6 * lit);
      c = mix(c, body * gain, cover);
    }

    gl_FragColor = vec4(c, 1.0);
  }
`;

export function makeSkyMaterial(p: SkyPreset): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      zenith: { value: new THREE.Color(p.zenith) },
      horizon: { value: new THREE.Color(p.horizon) },
      ground: { value: new THREE.Color(p.ground) },
      sunColor: { value: new THREE.Color(p.sun) },
      sunDir: { value: p.sunDir.clone().normalize() },
      sunIntensity: { value: p.sunIntensity },
      sunSize: { value: p.sunSize },
      haze: { value: p.haze },
      gain: { value: p.gain ?? 1 },
      cloud: { value: p.cloud ?? 0 },
      cloudSharp: { value: p.cloudSharp ?? 1.6 },
      cloudColor: { value: new THREE.Color(p.cloudColor ?? 0xf2f6fb) },
      cloudShadow: { value: new THREE.Color(p.cloudShadow ?? 0x8fa3ba) },
      // 0.42 cells per unit of (xz/y) puts a fair-weather cumulus at roughly
      // the angular size one actually is from a stadium bowl
      cloudScale: { value: p.cloudScale ?? 0.42 },
      cloudOffset: {
        value: new THREE.Vector2(...(p.cloudOffset ?? [17.31, 42.07])),
      },
      bowlGlow: { value: new THREE.Color(p.bowlGlow ?? 0x000000) },
      bowlGlowWidth: { value: p.bowlGlowWidth ?? 6 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
}

/**
 * Bake a sky preset into a PMREM environment map. The caller owns the returned
 * target and must dispose it.
 */
export function bakeSkyEnvironment(
  renderer: THREE.WebGLRenderer, preset: SkyPreset,
): THREE.WebGLRenderTarget {
  // PMREM wants its own tiny scene — a unit sphere with the same shader, so
  // the environment and the visible backdrop can never disagree
  const pmrem = new THREE.PMREMGenerator(renderer);
  const mat = makeSkyMaterial(preset);
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const bakeScene = new THREE.Scene();
  bakeScene.add(new THREE.Mesh(geo, mat));
  const rt = pmrem.fromScene(bakeScene, 0, 0.05, 10);
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return rt;
}

/**
 * The visible sky dome plus the baked environment map.
 *
 * The dome is parented to nothing and simply teleported onto the camera every
 * frame — a 600m sphere around the origin would parallax visibly from the
 * corner-of-the-bowl establishing shot, and a sun that slides when the camera
 * pans is worse than no sun at all.
 */
export class Sky {
  readonly dome: THREE.Mesh;
  readonly envTexture: THREE.Texture;
  private domeMat: THREE.ShaderMaterial;
  private envRT: THREE.WebGLRenderTarget;

  constructor(renderer: THREE.WebGLRenderer, preset: SkyPreset) {
    this.domeMat = makeSkyMaterial(preset);
    // 64x32, not 32x16. The fragment shader works from normalize(position),
    // and on a 32x16 sphere that direction is linearly interpolated across 11°
    // of arc — enough that the gradient shows faint facet seams on a Retina
    // panel. 2k extra triangles on a mesh that writes no depth is free.
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(600, 64, 32), this.domeMat);
    this.dome.frustumCulled = false;
    // drawn first, writes no depth: the rest of the scene paints straight over
    this.dome.renderOrder = -1000;

    this.envRT = bakeSkyEnvironment(renderer, preset);
    this.envTexture = this.envRT.texture;
  }

  /** Pin the dome to the camera so it behaves like a real skybox. */
  follow(camera: THREE.Camera): void {
    this.dome.position.copy(camera.position);
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.envRT.dispose();
  }
}
