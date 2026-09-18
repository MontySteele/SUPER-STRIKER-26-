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
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The single ACES filmic tone-map, plus a mild broadcast grade, a contrast-
 * adaptive sharpen and a vignette.
 *
 * The sharpen lives HERE rather than in a pass of its own on purpose. It is
 * four extra taps on a pass that is already reading this pixel, where a
 * separate pass would be another full read and write of a 3840x2160 buffer —
 * the most expensive way to buy the cheapest effect in the chain. It runs
 * BEFORE the tone-map, in linear light, and clamps its result to the
 * neighbourhood's own min/max, which is what stops an unsharp mask from
 * drawing a white line down every floodlight mast.
 */
/**
 * One circle-of-confusion curve for the grade and the blur pass, so the two
 * never disagree about what is sharp. FLAT for ±dofRange around the focus
 * (a whole sprinting player, not just his shirt number), then a smooth ramp
 * to full blur at 2.5× that — a man a metre outside the zone is a little
 * soft, not gone.
 */
const DOF_COC_GLSL = /* glsl */ `
    float cocAt(float dist) {
      float off = abs(dist - dofFocus);
      return smoothstep(dofRange, dofRange * 2.5, off) * dofAmount;
    }
`;

export const TonemapGradeShader = {
  name: 'SS26TonemapGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    exposure: { value: 1.0 },
    vignette: { value: 0.15 },
    saturation: { value: 1.05 },
    /** 0 disables the split-tone + saturation trim (MEDIUM) */
    gradeAmount: { value: 1.0 },
    /** unsharp amount; 0 = off. SceneManager sets it per quality level. */
    sharpen: { value: 0.0 },
    /** 1 / drawing-buffer size, so the taps are one DEVICE pixel apart */
    texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    shadowTint: { value: new THREE.Vector3(0.94, 1.0, 1.05) },
    highlightTint: { value: new THREE.Vector3(1.05, 1.0, 0.95) },
    /** §7A.6b: the half-res AO buffer, blurred and applied here rather than in
     *  two passes of its own (see render/ao.ts) */
    tAO: { value: null as THREE.Texture | null },
    /** 1 / AO buffer size — the blur taps are one AO texel apart */
    aoTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
    /** 0 = no AO (RETRO, or a level that cannot afford the pass) */
    aoAmount: { value: 0.0 },

    // ---- §7A.6c broadcast grade, per Atmosphere preset ----
    contrast: { value: 1.0 },
    /** ASC-CDL lift/gain, applied in display space after the tone-map */
    lift: { value: new THREE.Vector3(0, 0, 0) },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    /** transverse chromatic aberration at the frame corner, in PIXELS */
    chroma: { value: 0.0 },

    // ---- §7A.6c depth of field (close cameras only) ----
    tDepth: { value: null as THREE.Texture | null },
    /** 0 = off, and the whole block is branched out */
    dofAmount: { value: 0.0 },
    /** metres from the lens that are in focus, and how deep that zone is */
    dofFocus: { value: 8.0 },
    dofRange: { value: 3.0 },
    /** max circle of confusion, as a fraction of the frame height */
    dofRadius: { value: 0.012 },
    /** the DofBlurPass result: half-res, CoC-weighted, already blurred */
    tDofBlur: { value: null as THREE.Texture | null },
    /** unproject the depth buffer: (near, far) of the game camera */
    cameraRange: { value: new THREE.Vector2(1, 900) },
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
    uniform float sharpen;
    uniform vec2 texel;
    uniform vec3 shadowTint;
    uniform vec3 highlightTint;
    uniform sampler2D tAO;
    uniform vec2 aoTexel;
    uniform float aoAmount;
    uniform float contrast;
    uniform vec3 lift;
    uniform vec3 gain;
    uniform float chroma;
    uniform sampler2D tDepth;
    uniform float dofAmount;
    uniform float dofFocus;
    uniform float dofRange;
    uniform float dofRadius;
    uniform sampler2D tDofBlur;
    uniform vec2 cameraRange;
    varying vec2 vUv;

    /** metres from the lens, out of the depth buffer */
    float viewDistance(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * cameraRange.x * cameraRange.y)
        / (cameraRange.y + cameraRange.x - z * (cameraRange.y - cameraRange.x));
    }
    ${DOF_COC_GLSL}

    /** interleaved-gradient noise: a pure function of the pixel, so a capture
     *  of the same shot is the same pixels (§7A.9) */
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

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
      // the un-defocused centre sample, so the aberration below can be a
      // DELTA added on top of whatever the bokeh gather produced instead of a
      // second set of taps that quietly undoes it
      vec3 base = c.rgb;

      // ---- depth of field (§7A.6c) — CLOSE CAMERAS ONLY ----
      // Branched on a uniform, so the tele cam (dofAmount 0) pays exactly
      // nothing: the GPU's whole warp takes the same branch on every pixel of
      // a tele frame and the cost is the compare.
      //
      // The blur itself is NOT gathered here any more. A sparse per-pixel
      // gather (eight rotated Vogel taps over a twenty-pixel circle) does not
      // produce bokeh, it produces DITHER, and on a Retina panel that dither
      // is exactly the "low-res model" look this pass was supposed to cure.
      // DofBlurPass builds a half-resolution, CoC-weighted, twice-blurred copy
      // of the frame (three small draws, close cameras only); this pixel just
      // blends toward it by its own circle of confusion. Sharp pixels carry
      // ~no weight in that copy, so a player in focus does not halo into the
      // crowd behind him.
      if (dofAmount > 0.0) {
        float coc = cocAt(viewDistance(vUv));
        float m = smoothstep(0.02, 0.30, coc);
        if (m > 0.0) {
          vec3 blurred = texture2D(tDofBlur, vUv).rgb;
          c.rgb = mix(c.rgb, blurred, m);
        }
      }

      // ---- transverse chromatic aberration (§7A.6c) ----
      // A real broadcast lens does not focus red and blue on the same spot at
      // the edge of a 70x zoom. Two extra taps, scaled by r^2 so the frame
      // centre is untouched and only the corners fringe. Kept small enough
      // that you have to go looking for it — the moment it is visible as an
      // effect it stops being a lens and starts being Instagram.
      if (chroma > 0.0) {
        vec2 d = vUv - 0.5;
        float r2 = clamp(dot(d, d) * 2.0, 0.0, 1.0);         // 0 centre, 1 corner
        vec2 dirUv = d * inversesqrt(max(dot(d, d), 1e-8));
        vec2 shift = dirUv * (chroma * r2) * texel;
        c.r += texture2D(tDiffuse, vUv + shift).r - base.r;
        c.b += texture2D(tDiffuse, vUv - shift).b - base.b;
      }

      // ---- contrast-adaptive sharpen, in linear light ----
      // Skipped entirely when the amount is 0: MEDIUM's FXAA and RETRO's
      // stack both want a soft image, and a branch on a uniform is free.
      if (sharpen > 0.0) {
        vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb;
        vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, texel.y)).rgb;
        vec3 e = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb;
        vec3 w = texture2D(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb;
        vec3 lo = min(min(n, s), min(e, w));
        vec3 hi = max(max(n, s), max(e, w));
        vec3 blur = (n + s + e + w) * 0.25;
        // the clamp is the whole trick: a pixel may only be pushed as far as
        // its own neighbours already go, so an edge gets crisper and never
        // grows the bright fringe an unclamped unsharp mask paints
        c.rgb = clamp(c.rgb + (c.rgb - blur) * sharpen, min(lo, c.rgb), max(hi, c.rgb));
      }

      // ---- ambient occlusion (§7A.6b) ----
      // Four bilinear taps half a texel off each diagonal of the half-res AO
      // buffer: that is a 2x2 tent over four DIFFERENT spiral rotations, which
      // is what turns eight noisy taps into a usable shade. It is also the
      // whole blur — a separable gaussian in two passes of its own would cost
      // more than the AO did.
      //
      // Applied in LINEAR light and BEFORE the tone-map, because occlusion is
      // missing light, not a darker picture.
      //
      // "Ambient only, if possible" (§7A.6b): there is no ambient term left to
      // multiply this far downstream, so the next best thing — weight the
      // occlusion by how UNLIT the pixel already is. A boot sole in a crease is
      // almost entirely ambient and takes the full term; a shirt in full key is
      // mostly direct and barely moves. Without that weighting an AO pass
      // simply lowers the exposure of the whole frame, which is the classic
      // way of making a picture darker instead of deeper.
      if (aoAmount > 0.0) {
        vec2 o = aoTexel * 0.5;
        float ao = 0.25 * (
            texture2D(tAO, vUv + vec2( o.x,  o.y)).r
          + texture2D(tAO, vUv + vec2(-o.x,  o.y)).r
          + texture2D(tAO, vUv + vec2( o.x, -o.y)).r
          + texture2D(tAO, vUv + vec2(-o.x, -o.y)).r);
        float lum0 = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        float ambientish = 1.0 - smoothstep(0.22, 1.10, lum0);
        c.rgb *= mix(1.0, ao, aoAmount * (0.35 + 0.65 * ambientish));
      }

      // ---- the one and only tone-map ----
      c.rgb = acesFilmic(max(c.rgb, 0.0));

      // ---- grade: teal in the shadows, warmth in the highlights ----
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 tint = mix(shadowTint, highlightTint, smoothstep(0.12, 0.88, l));
      c.rgb *= mix(vec3(1.0), tint, gradeAmount);
      c.rgb = mix(vec3(l), c.rgb, mix(1.0, saturation, gradeAmount));

      // ---- lift / gain / contrast (§7A.6c) ----
      // ORDER MATTERS. Lift first, because a print's blacks sitting off zero
      // is the thing every other step then works on top of; gain second, as a
      // white-balance of the highlights; contrast last, pivoting on 0.435
      // rather than 0.5 — 18% grey in sRGB is 0.46, and pivoting on 0.5
      // silently darkens every midtone in the frame while claiming only to
      // add contrast.
      vec3 lg = mix(vec3(1.0), gain, gradeAmount);
      c.rgb = (c.rgb * lg) + mix(vec3(0.0), lift, gradeAmount) * (1.0 - c.rgb);
      c.rgb = (c.rgb - 0.435) * mix(1.0, contrast, gradeAmount) + 0.435;

      // ---- vignette (kept on at every level; it frames the pitch) ----
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.32, 0.92, d);

      // ---- output dither ----
      // The whole chain up to here is half-float. The screen is 8 bits. A sky
      // gradient that crosses 200 pixels while changing by four code values
      // gets quantised into four visible bands, and that banding is the single
      // most "cheap render" artefact left in the frame — it is exactly what
      // the eye reads as low bit depth, and at DPR 2 the bands are TWICE as
      // wide in screen terms, so a Retina panel makes it worse, not better.
      //
      // The fix is half a code value of noise, applied before quantisation, so
      // the error is spread instead of stepped. A triangular PDF (two hashes
      // differenced) is the right shape: uniform noise leaves a residual bias
      // at the band edges that reads as a faint remaining stripe.
      //
      // Applied here rather than in OutputPass because this is the last place
      // the value is still linear-ish and, more importantly, the last pass
      // that is already reading and writing this pixel.
      vec2 dp = gl_FragCoord.xy;
      float r0 = fract(sin(dot(dp, vec2(12.9898, 78.233))) * 43758.5453);
      float r1 = fract(sin(dot(dp + 17.31, vec2(12.9898, 78.233))) * 43758.5453);
      c.rgb += (r0 - r1) * (1.0 / 255.0);

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

// ---------------------------------------------------------------- §7A.6c
// Depth-of-field blur buffer: three half-resolution draws, close cameras only.
//
//   1. prefilter  full-res colour + depth → half-res RGB (CoC-weighted 4×4
//                 box) with the pixel's CoC in alpha. In-focus pixels get
//                 ~zero weight, so they do not smear into the blur.
//   2. disc       12-tap Vogel disc, radius scaled by the pixel's own CoC,
//                 each tap weighted by ITS CoC (a sharp neighbour is not
//                 allowed to bleed).
//   3. fill       8-tap disc at 40% radius, which closes the gaps between
//                 disc taps — the difference between bokeh and a dither.
//
// Nothing here depends on a clock or a frame counter (§7A.9 capture
// contract), and the pass is skipped outright when dofAmount is 0.
const DOF_SCALE = 0.5;

const DOF_PREFILTER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    srcTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    dofAmount: { value: 0 },
    dofFocus: { value: 8 },
    dofRange: { value: 3 },
    cameraRange: { value: new THREE.Vector2(1, 900) },
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
    uniform sampler2D tDepth;
    uniform vec2 srcTexel;
    uniform float dofAmount;
    uniform float dofFocus;
    uniform float dofRange;
    uniform vec2 cameraRange;
    varying vec2 vUv;
    float viewDistance(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * cameraRange.x * cameraRange.y)
        / (cameraRange.y + cameraRange.x - z * (cameraRange.y - cameraRange.x));
    }
    ${DOF_COC_GLSL}
    void main() {
      // four bilinear taps a full-res texel off centre = a 4×4 box
      vec2 o = srcTexel;
      vec2 uvs[4];
      uvs[0] = vUv + vec2(-o.x, -o.y); uvs[1] = vUv + vec2( o.x, -o.y);
      uvs[2] = vUv + vec2(-o.x,  o.y); uvs[3] = vUv + vec2( o.x,  o.y);
      vec3 sum = vec3(0.0); float wsum = 0.0; float cmax = 0.0; vec3 plain = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        vec3 c = texture2D(tDiffuse, uvs[i]).rgb;
        float coc = cocAt(viewDistance(uvs[i]));
        float w = coc + 0.02;
        sum += c * w; wsum += w; cmax = max(cmax, coc); plain += c;
      }
      vec3 col = wsum > 0.1 ? sum / wsum : plain * 0.25;
      gl_FragColor = vec4(col, cmax);
    }
  `,
};

const DOF_DISC = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** the blur target's own texel */
    texel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
    /** max blur radius in PIXELS of this target, at CoC 1 */
    radiusPx: { value: 6 },
    /** 1 = the 12-tap disc, 0 = the 8-tap fill */
    fill: { value: 0 },
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
    uniform vec2 texel;
    uniform float radiusPx;
    uniform float fill;
    varying vec2 vUv;
    const vec2 TAPS[12] = vec2[12](
      vec2( 0.2887,  0.0000), vec2(-0.2041,  0.3536), vec2(-0.2041, -0.3536),
      vec2( 0.5774,  0.3333), vec2(-0.6455,  0.0000), vec2( 0.2887, -0.6667),
      vec2( 0.8000,  0.0000), vec2(-0.4000,  0.6928), vec2(-0.4000, -0.6928),
      vec2( 0.9500,  0.4000), vec2(-0.9500,  0.4000), vec2( 0.0000, -1.0000)
    );
    void main() {
      vec4 centre = texture2D(tDiffuse, vUv);
      float coc = centre.a;
      if (coc < 0.01) { gl_FragColor = centre; return; }
      float r = coc * radiusPx * (fill > 0.5 ? 0.4 : 1.0);
      int n = fill > 0.5 ? 8 : 12;
      vec3 sum = centre.rgb * 0.5; float wsum = 0.5;
      for (int i = 0; i < 12; i++) {
        if (i >= n) break;
        vec4 t = texture2D(tDiffuse, vUv + TAPS[i] * r * texel);
        // a tap is allowed to contribute in proportion to how blurred IT is:
        // the man in focus stays out of the crowd behind him
        float w = clamp(t.a * 4.0, 0.0, 1.0) + 0.02;
        sum += t.rgb * w; wsum += w;
      }
      gl_FragColor = vec4(sum / wsum, coc);
    }
  `,
};

/**
 * Sits between bloom and the grade. needsSwap is false: it reads the read
 * buffer (colour and depth), writes only its own half-res targets, and leaves
 * the result in `texture` for the grade to blend toward.
 */
export class DofBlurPass extends Pass {
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private prefilter: THREE.ShaderMaterial;
  private disc: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  /** the composer buffer size, so the blur radius can be a fraction of frame height */
  private fullHeight = 720;
  /** max CoC as a fraction of the frame height (mirrors the grade's dofRadius) */
  radiusFrac = 0.012;

  constructor() {
    super();
    this.needsSwap = false;
    const mk = (name: string) => {
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.name = name;
      return rt;
    };
    this.rtA = mk('SS26.dofA');
    this.rtB = mk('SS26.dofB');
    this.prefilter = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(DOF_PREFILTER.uniforms),
      vertexShader: DOF_PREFILTER.vertexShader,
      fragmentShader: DOF_PREFILTER.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.disc = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(DOF_DISC.uniforms),
      vertexShader: DOF_DISC.vertexShader,
      fragmentShader: DOF_DISC.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.prefilter);
  }

  /** where the grade should read the blurred frame from */
  get texture(): THREE.Texture { return this.rtA.texture; }

  /** same numbers the grade gets; amount 0 skips the pass entirely */
  setLens(amount: number, focusMetres: number, rangeMetres: number): void {
    const u = this.prefilter.uniforms;
    u.dofAmount.value = amount;
    u.dofFocus.value = focusMetres;
    u.dofRange.value = rangeMetres;
  }

  setCameraRange(near: number, far: number): void {
    this.prefilter.uniforms.cameraRange.value.set(near, far);
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * DOF_SCALE));
    const h = Math.max(1, Math.round(height * DOF_SCALE));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.fullHeight = height;
    this.prefilter.uniforms.srcTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.disc.uniforms.texel.value.set(1 / w, 1 / h);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const pu = this.prefilter.uniforms;
    const depth = readBuffer.depthTexture;
    if (!depth || pu.dofAmount.value <= 0) return;
    pu.tDiffuse.value = readBuffer.texture;
    pu.tDepth.value = depth;
    this.disc.uniforms.radiusPx.value = this.radiusFrac * this.fullHeight * DOF_SCALE;

    const prev = renderer.getRenderTarget();
    this.quad.material = this.prefilter;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    this.quad.material = this.disc;
    this.disc.uniforms.fill.value = 0;
    this.disc.uniforms.tDiffuse.value = this.rtA.texture;
    renderer.setRenderTarget(this.rtB);
    this.quad.render(renderer);

    this.disc.uniforms.fill.value = 1;
    this.disc.uniforms.tDiffuse.value = this.rtB.texture;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  override dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.prefilter.dispose();
    this.disc.dispose();
    this.quad.dispose();
  }
}

/**
 * The grade, as a pass rather than a bare ShaderPass.
 *
 * It needs ONE thing a ShaderPass cannot give it: the depth texture of
 * whichever composer buffer the geometry pass drew into this frame. That
 * alternates between renderTarget1 and renderTarget2 (the chain's swap count
 * is odd), so it has to be read at draw time and can never be cached at
 * construction. Everything else is a plain uniform.
 */
export class GradePass extends ShaderPass {
  constructor() {
    super(TonemapGradeShader);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    // Bloom renders back into the read buffer (needsSwap false), so this is
    // still the target the RenderPass filled — depth and all.
    this.uniforms.tDepth.value = readBuffer.depthTexture ?? null;
    if (!readBuffer.depthTexture) this.uniforms.dofAmount.value = 0;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

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
