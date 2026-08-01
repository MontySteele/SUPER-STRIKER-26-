// The post chain's own pieces (§7A.6).
//
// The whole point of the rewrite: there is exactly ONE tone-map in the
// pipeline and it lives in TonemapGradeShader below. The renderer is set to
// NoToneMapping, every composer buffer is half-float, and bloom therefore
// samples real HDR radiance instead of already-compressed LDR. Tone-mapping twice
// is what produced the grey halo the spec calls out: the second curve pulls
// the bloom's colour toward white before it ever reaches the screen.
//
// Order matters downstream too. OutputPass reads renderer.toneMapping at draw
// time, so with NoToneMapping it degrades to a pure sRGB encode — put anything
// after the grade that tone-maps again and the halo comes straight back.

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** The single ACES filmic tone-map, plus a mild broadcast grade + vignette. */
export const TonemapGradeShader = {
  name: 'SS26TonemapGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    exposure: { value: 1.0 },
    vignette: { value: 0.15 },
    saturation: { value: 1.05 },
    /** 0 disables the split-tone + saturation trim (MEDIUM) */
    gradeAmount: { value: 1.0 },
    shadowTint: { value: new THREE.Vector3(0.94, 1.0, 1.05) },
    highlightTint: { value: new THREE.Vector3(1.05, 1.0, 0.95) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float exposure;
    uniform float vignette;
    uniform float saturation;
    uniform float gradeAmount;
    uniform vec3 shadowTint;
    uniform vec3 highlightTint;
    varying vec2 vUv;

    // three's ACES fit, lifted verbatim so RETRO and HIGH agree on the curve
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 acesFilmic(vec3 color) {
      const mat3 inMat = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
      );
      const mat3 outMat = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
      );
      color *= exposure / 0.6;
      color = inMat * color;
      color = RRTAndODTFit(color);
      color = outMat * color;
      return clamp(color, 0.0, 1.0);
    }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);

      // ---- the one and only tone-map ----
      c.rgb = acesFilmic(max(c.rgb, 0.0));

      // ---- grade: teal in the shadows, warmth in the highlights ----
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 tint = mix(shadowTint, highlightTint, smoothstep(0.12, 0.88, l));
      c.rgb *= mix(vec3(1.0), tint, gradeAmount);
      c.rgb = mix(vec3(l), c.rgb, mix(1.0, saturation, gradeAmount));

      // ---- vignette (kept on at every level; it frames the pitch) ----
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.32, 0.92, d);

      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }
  `,
};

/** The v1.1 grade, kept intact for the RETRO level (§7A.7). */
export const RetroGradeShader = {
  name: 'SS26RetroGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.32 },
    saturation: { value: 1.12 },
    contrast: { value: 1.05 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // punchy broadcast grade
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      // vignette
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, d);
      gl_FragColor = c;
    }
  `,
};

/**
 * UnrealBloomPass hard-codes its working buffers to half the size the composer
 * hands it, which leaves no way to ask for a cheaper blur. This subclass folds
 * an extra scale into setSize so MEDIUM can run bloom at half res again.
 */
export class ScaledBloomPass extends UnrealBloomPass {
  constructor(
    resolution: THREE.Vector2, strength: number, radius: number, threshold: number,
    private readonly scale = 1,
  ) {
    super(resolution, strength, radius, threshold);
  }

  override setSize(width: number, height: number): void {
    super.setSize(
      Math.max(1, Math.round(width * this.scale)),
      Math.max(1, Math.round(height * this.scale)),
    );
  }
}
