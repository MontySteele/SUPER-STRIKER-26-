// Screen-space ambient occlusion, from DEPTH ALONE (§7A.6b).
//
// WHY NOT GTAOPass / SSAOPass. Both of three's AO passes want a G-buffer they
// do not have, so both build one by re-rendering the entire scene through an
// override material — a second full pass over 1.4k objects, 22 skinned rigs
// and a 40k-figure crowd. That is not a 1.5ms effect, and it would roughly
// DOUBLE the frame's draw calls, which the shot contract measures. So this
// pass reconstructs what it needs instead:
//
//   • DEPTH comes free. The composer's HDR targets carry a DepthTexture, so
//     the geometry pass that was already happening leaves us a depth buffer.
//   • NORMALS come from the derivatives of the reconstructed view position.
//     Screen-space normals from ddx/ddy are wrong on a silhouette and right
//     everywhere else, and AO on a silhouette is hidden by the silhouette.
//
// Cost is therefore ONE fullscreen draw at HALF resolution with 8 depth taps.
// The blur and the application both ride inside the grade pass, which is
// already reading and writing every pixel — see TonemapGradeShader.
//
// What it buys, in order of how much it matters here: boots planted in turf
// instead of floating on it, the contact between a player and his own shadow,
// the tunnel mouth and the vomitory slots reading as HOLES, and the seat rows
// and roof trusses getting the crease-shading their baked instance tint only
// approximates.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** Working resolution as a fraction of the composer's buffer. */
const AO_SCALE = 0.5;

const AO_SHADER = {
  uniforms: {
    tDepth: { value: null as THREE.Texture | null },
    /** the AO target's own size, in pixels */
    aoSize: { value: new THREE.Vector2(1, 1) },
    projInv: { value: new THREE.Matrix4() },
    proj: { value: new THREE.Matrix4() },
    /** sampling radius in METRES — this is a world-scale effect, not a
     *  pixel-scale one, or a wide shot and a close-up disagree about what an
     *  occluder is */
    radius: { value: 0.55 },
    intensity: { value: 1.0 },
    /** reject samples inside this slab of the surface (self-occlusion) */
    bias: { value: 0.035 },
    /** AO fades out between these view distances: past the far one the only
     *  thing left in frame is the bowl, whose creases are baked, and the depth
     *  precision out there is not worth sampling */
    fade: { value: new THREE.Vector2(28, 72) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth;
    uniform vec2 aoSize;
    uniform mat4 projInv;
    uniform mat4 proj;
    uniform float radius;
    uniform float intensity;
    uniform float bias;
    uniform vec2 fade;
    varying vec2 vUv;

    // A DEPTH24_STENCIL8 texture reads back its depth in .x.
    float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

    vec3 viewPos(vec2 uv, float d) {
      vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 v = projInv * clip;
      return v.xyz / v.w;
    }

    // Eight directions on a spiral, rotated per pixel. The rotation is
    // interleaved-gradient noise, which is a pure function of the pixel — the
    // capture contract says "same commit, same pixels", so nothing here may
    // depend on a frame counter or a clock.
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      float d = rawDepth(vUv);
      // the sky: depth 1, nothing in front of it, no occlusion
      if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }

      vec3 P = viewPos(vUv, d);
      // Screen-space normal. dFdx/dFdy of the reconstructed position is the
      // surface tangent frame at this pixel; cheaper and steadier than any
      // encode/decode of a real normal buffer we do not have.
      vec3 N = normalize(cross(dFdx(P), dFdy(P)));

      float dist = -P.z;
      float far = 1.0 - smoothstep(fade.x, fade.y, dist);
      if (far <= 0.001) { gl_FragColor = vec4(1.0); return; }

      float a0 = ign(gl_FragCoord.xy) * 6.2831853;
      float occ = 0.0;
      const int N_TAPS = 8;
      for (int i = 0; i < N_TAPS; i++) {
        float t = (float(i) + 0.5) / float(N_TAPS);
        float ang = a0 + t * 6.2831853 * 2.4;     // ~2.4 turns of spiral
        // the sample sits at t*radius metres from P, along the surface
        vec3 dirV = vec3(cos(ang), sin(ang), 0.0);
        vec3 sPosW = P + dirV * (radius * sqrt(t));
        vec4 sClip = proj * vec4(sPosW, 1.0);
        vec2 sUv = (sClip.xy / sClip.w) * 0.5 + 0.5;
        if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;
        float sd = rawDepth(sUv);
        if (sd >= 0.9999) continue;
        vec3 S = viewPos(sUv, sd);
        vec3 diff = S - P;
        float len = length(diff);
        if (len < 1e-4) continue;
        float ndl = max(dot(N, diff / len) - bias, 0.0);
        // range check: a sample from a surface a long way in front of this one
        // is a different object, not a crease
        float range = radius / (radius + len * len);
        occ += ndl * range;
      }
      occ = occ / float(N_TAPS);
      gl_FragColor = vec4(clamp(1.0 - occ * intensity * far, 0.0, 1.0));
    }
  `,
};

/**
 * Half-resolution depth-only AO. Place it immediately after the RenderPass:
 * it never touches the colour buffers (needsSwap is false), it only reads the
 * depth texture the geometry pass just filled and leaves its result in
 * `texture` for the grade pass to blur and apply.
 */
export class DepthAOPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(private camera: THREE.PerspectiveCamera) {
    super();
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      // one channel, 8 bits: AO is a multiplier in [0,1] and the grade's own
      // dither hides the quantisation long before the eye finds it
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.name = 'SS26.ao';
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(AO_SHADER.uniforms),
      vertexShader: AO_SHADER.vertexShader,
      fragmentShader: AO_SHADER.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** AO strength, 0..1 — 0 makes the pass a no-op the grade will skip. */
  setIntensity(v: number): void {
    this.material.uniforms.intensity.value = v;
  }

  setRadius(m: number): void {
    this.material.uniforms.radius.value = m;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * AO_SCALE));
    const h = Math.max(1, Math.round(height * AO_SCALE));
    this.target.setSize(w, h);
    this.material.uniforms.aoSize.value.set(w, h);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    // readBuffer is whatever the RenderPass just drew into — the only buffer
    // in the chain whose depth texture holds this frame's geometry. Both of
    // the composer's targets carry their own clone of it and they alternate
    // frame to frame, so this must be read here and never cached.
    const depth = readBuffer.depthTexture;
    if (!depth || this.material.uniforms.intensity.value <= 0) return;
    const u = this.material.uniforms;
    u.tDepth.value = depth;
    u.proj.value.copy(this.camera.projectionMatrix);
    u.projInv.value.copy(this.camera.projectionMatrixInverse);

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
