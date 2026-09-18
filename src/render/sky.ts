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
  varying vec3 vDir;

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

    // sun: a hot core plus two glow lobes (tight bloom seed, wide sky wash)
    float cosA = dot(d, sunDir);
    float disc = smoothstep(cos(sunSize * 1.7), cos(sunSize * 0.6), cosA);
    float tight = pow(max(cosA, 0.0), 900.0);
    float wide = pow(max(cosA, 0.0), 9.0);
    c += sunColor * (disc * sunIntensity + tight * sunIntensity * 0.35 + wide * 0.28);

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
