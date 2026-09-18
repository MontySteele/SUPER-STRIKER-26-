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
    uniform vec2 cameraRange;
    varying vec2 vUv;

    /** metres from the lens, out of the depth buffer */
    float viewDistance(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * cameraRange.x * cameraRange.y)
        / (cameraRange.y + cameraRange.x - z * (cameraRange.y - cameraRange.x));
    }

    // Eight points on a Vogel disk — the cheapest arrangement that does not
    // read as a ring, which is what a fixed 8-tap circle always does. It is
    // ROTATED per pixel (see ign below): eight fixed taps over a 20-pixel
    // circle of confusion do not blur a distant player, they REPLICATE him
    // eight times, and the ghosting is the loudest artefact in the frame.
    // Rotating the disk turns that replication into dither, which at this
    // amount reads as film grain and is what the output dither was going to
    // do to it anyway.
    const vec2 DOF_TAPS[8] = vec2[8](
      vec2( 0.2165,  0.1250), vec2(-0.1531,  0.3536), vec2(-0.4330, -0.1250),
      vec2( 0.2500, -0.4330), vec2( 0.5303,  0.3062), vec2(-0.5000,  0.5000),
      vec2(-0.2588, -0.6964), vec2( 0.8000, -0.1000)
    );

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
      // nothing: the compiler cannot skip the taps, but the GPU's whole warp
      // takes the same branch on every pixel of a tele frame and the cost is
      // the compare.
      //
      // It reuses the SAME depth texture the AO pass reads, which is why this
      // is worth having at all: three's BokehPass would re-render the scene
      // into a depth target of its own, and there is no version of that under
      // a millisecond. The blur is a single 8-tap Vogel gather whose radius is
      // the circle of confusion — no near/far separation and no fixup pass, so
      // a sharp foreground object does bleed slightly into a blurred
      // background. At the distances the close cameras work at (a scorer 3.8m
      // from the lens, a keeper at 6m) there IS nothing sharp in front, so the
      // artefact has nowhere to appear.
      if (dofAmount > 0.0) {
        float dist = viewDistance(vUv);
        float coc = clamp(abs(dist - dofFocus) / max(dofRange, 0.01), 0.0, 1.0);
        coc = coc * coc * dofAmount;
        if (coc > 0.004) {
          float r = coc * dofRadius;
          float a = ign(gl_FragCoord.xy) * 6.2831853;
          float ca = cos(a), sa = sin(a);
          mat2 rot = mat2(ca, -sa, sa, ca);
          vec3 sum = c.rgb;
          float wsum = 1.0;
          for (int i = 0; i < 8; i++) {
            // aspect-corrected: the CoC is round on the SCREEN, not in UV
            vec2 off = (rot * DOF_TAPS[i]) * r * vec2(texel.x / max(texel.y, 1e-6), 1.0);
            vec2 suv = vUv + off;
            // a tap that lands on something much NEARER than this pixel is in
            // front of it and must not smear back over it
            float sd = viewDistance(suv);
            float w = sd > dist - 0.25 ? 1.0 : 0.15;
            sum += texture2D(tDiffuse, suv).rgb * w;
            wsum += w;
          }
          c.rgb = sum / wsum;
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
