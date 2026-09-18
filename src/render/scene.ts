// Scene + the PS3 post stack (§7A.6/§7A.7). Lighting is NOT here — Atmosphere
// owns every light in the project; this file owns the renderer, the camera and
// the pass chain.
//
// HIGH / MEDIUM chain (one tone-map, in the grade):
//   scene → [half-float RT, MSAA only at pixel ratio < 1.75]
//         → UnrealBloom(threshold 1.3, strength 0.38)
//         → TonemapGrade (ACES + split-tone + sharpen + vignette)
//         → SMAA → OutputPass(sRGB)                      … HIGH
//         → OutputPass(sRGB) → FXAA                      … MEDIUM
//
// RETRO chain is the v1.1 stack, untouched: renderer-level ACES, bloom on the
// tone-mapped image, the old contrast/saturation grade, OutputPass.
//
// GTAO was evaluated and cut. The scene is an open pitch under a single key —
// the only thing worth occluding is the contact between a boot and the grass,
// and the CSM cascades already put a real shadow there. A depth+normal prepass
// for that is the worst frame-time trade in the whole chain, so it goes first,
// exactly as §7A.6 says.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Atmosphere } from './Atmosphere';
import { SHADOW_LAYER, setMaxAnisotropy } from './materials';
import { RetroGradeShader, ScaledBloomPass, TonemapGradeShader } from './postFX';
import {
  effectiveSamples, qualityProfile, qualitySetting,
  type QualityLevel, type QualityProfile,
} from './quality';

export type TimeOfDay = 'day' | 'sunset' | 'night';

// Adaptive resolution (§7A.7): under frame pressure we give up PIXELS, never
// features. Steps are gentle and hysteresis is deliberately lopsided — drop
// after ~1s of pain, climb back only after ~4s of comfort, so a single hitch
// never starts an oscillation the player can see.
const RATIO_STEPS = [1, 0.85, 0.72, 0.6];

/** A mesh on SHADOW_LAYER and nothing else — i.e. a shadow proxy. */
const PROXY_MASK = 1 << SHADOW_LAYER;
const DROP_MS = 22;   // ~45fps
const RAISE_MS = 13;  // ~77fps
const DROP_AFTER = 1.0;
const RAISE_AFTER = 4.0;

export class SceneManager {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  atmos: Atmosphere;
  readonly profile: QualityProfile;
  private bloom: ScaledBloomPass;
  private gradePass: ShaderPass;

  private basePixelRatio: number;
  private ratioIdx = 0;
  /** set by pinRenderSize(): while this holds, neither the adaptive-resolution
   *  valve nor a window resize may touch the drawing buffer */
  private pinned: { w: number; h: number; ratio: number } | null = null;
  /** see drawShadows(): a camera that sees the proxy layer and nothing else */
  private shadowProbe = new THREE.PerspectiveCamera(1, 1, 0.01, 0.02);
  private shadowScratch = new THREE.WebGLRenderTarget(1, 1);
  private frameEma = 16.7;
  private hotFor = 0;
  private coolFor = 0;

  constructor(canvas: HTMLCanvasElement, public timeOfDay: TimeOfDay, level?: QualityLevel) {
    this.profile = qualityProfile(level ?? qualitySetting());

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.profile.retro });
    this.basePixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // publish the real anisotropy cap before anything bakes a texture: the
    // pitch is the one surface in the game that is always seen edge-on, and
    // 16x is the difference between grain and a crawling moire at DPR 2
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.renderer.shadowMap.enabled = true;
    // We drive the shadow pass by hand (see drawShadows): three's automatic one
    // runs inside renderer.render() with the VIEW camera's layer mask, which
    // is exactly the mask the shadow proxies are hidden from.
    this.renderer.shadowMap.autoUpdate = false;
    // the probe: under the world, looking at nothing, and seeing ONLY the
    // shadow-caster layer (see drawShadows)
    this.shadowProbe.position.set(0, -5000, 0);
    this.shadowProbe.layers.set(SHADOW_LAYER);
    this.shadowProbe.updateMatrixWorld();
    // Do NOT "upgrade" this to PCFSoftShadowMap. r185 dropped that path:
    // generateShadowMapTypeDefine() only knows PCF and VSM, so PCFSoftShadowMap
    // falls through to SHADOWMAP_TYPE_BASIC — ONE hard comparison tap, i.e.
    // strictly worse than what we have. PCFShadowMap here is a 5-tap Vogel disk
    // with interleaved-gradient rotation, and the penumbra width comes from
    // each cascade light's shadow.radius (see Atmosphere).
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // the single tone-map lives in the grade pass; leaving ACES on the renderer
    // as well is precisely the double-curve that greys out the bloom
    this.renderer.toneMapping = this.profile.retro
      ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 1, 900);
    this.camera.position.set(0, 26, 48);
    this.camera.lookAt(0, 0, 0);

    this.atmos = new Atmosphere(this.scene, this.camera, this.renderer, timeOfDay, this.profile);
    if (this.profile.retro) this.renderer.toneMappingExposure = this.atmos.exposure;

    // ---- post stack ----
    const w = window.innerWidth, h = window.innerHeight;
    const size = new THREE.Vector2(w, h);

    if (this.profile.retro) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new ScaledBloomPass(size.clone().multiplyScalar(0.5), 0.35, 0.55, 0.82);
      this.composer.addPass(this.bloom);
      this.gradePass = new ShaderPass(RetroGradeShader);
      this.composer.addPass(this.gradePass);
      this.composer.addPass(new OutputPass());
    } else {
      // half-float everywhere so bloom sees real radiance. MSAA on top of it
      // is a pixel-ratio decision, not a quality-level one: on a 1x display it
      // cleans the geometry edges SMAA cannot (goal netting), and at 2x it
      // costs half the frame rate for edges that are already sub-pixel.
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        // not profile.samples: MSAA is priced per device pixel, and on a
        // Retina panel the 4x half-float resolve alone costs more than the
        // entire rest of the frame (see effectiveSamples)
        samples: effectiveSamples(this.profile, this.basePixelRatio),
      });
      rt.texture.name = 'SS26.hdr';
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));

      // Restraint (§7A.6). The threshold sits just ABOVE where a white shirt
      // in full key lands (~1.0 linear), because a white kit is the one thing
      // in this game that is legitimately near-white and must NOT glow — that
      // is the exact "grey halo around the players" the spec is hunting.
      // What is left above the line is what should bloom: floodlight heads,
      // the sun disc and horizon, and the ball's specular.
      this.bloom = new ScaledBloomPass(size.clone(), 0.38, 0.55, 1.3, this.profile.bloomScale);
      this.composer.addPass(this.bloom);

      this.gradePass = new ShaderPass(TonemapGradeShader);
      this.gradePass.uniforms.exposure.value = this.atmos.exposure;
      this.gradePass.uniforms.gradeAmount.value = this.profile.grade ? 1 : 0;
      // A light sharpen only where it is paid for: SMAA is an edge-aware
      // reconstruction and leaves the image slightly soft, which at DPR 2 on a
      // Retina panel reads as "not quite in focus". FXAA (MEDIUM) is already a
      // blur and sharpening it just amplifies its own artefacts.
      this.gradePass.uniforms.sharpen.value = this.profile.aa === 'smaa' ? 0.22 : 0;
      this.composer.addPass(this.gradePass);

      if (this.profile.aa === 'smaa') {
        // SMAA wants the tone-mapped image, so it sits after the grade
        this.composer.addPass(new SMAAPass());
      }
      this.composer.addPass(new OutputPass());
      // ...whereas FXAA wants sRGB, which only exists after OutputPass
      if (this.profile.aa === 'fxaa') this.composer.addPass(new FXAAPass());
    }
    this.composer.setSize(w, h);
    if (!this.profile.retro) this.syncTexel();

    window.addEventListener('resize', this.resizeHandler);
  }

  private resizeHandler = (): void => this.onResize();

  /**
   * Release everything the GPU is holding for this match. A tournament run
   * builds a fresh renderer per match on the same canvas; without this, GPU
   * memory grows monotonically until the context is lost mid-demo.
   */
  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    // lights, cascade shadow maps, the PMREM target and the sky dome first —
    // the traversal below would otherwise walk a subtree we still own
    this.atmos.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      // InstancedMesh (§7A.5's crowd) holds instanceMatrix / instanceColor
      // OUTSIDE its geometry; geometry.dispose() frees the per-vertex buffers
      // and the per-instance ones would strand. One rake is 500 instances, and
      // a tournament builds a fresh bowl per match.
      const inst = obj as THREE.InstancedMesh;
      if (inst.isInstancedMesh) inst.dispose();
      // Sprite geometry is a module-level singleton inside three, shared by
      // every sprite ever made — not ours to free.
      if (mesh.geometry && !(obj as THREE.Sprite).isSprite) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) {
          if (v instanceof THREE.Texture) v.dispose();
        }
        m.dispose();
      }
    });
    this.scene.clear();
    // composer.dispose() only frees its internal targets — every added pass
    // (bloom's six mip chains, SMAA's two buffers and its area/search
    // textures) must be freed by hand or tens of MB strand per match
    for (const pass of this.composer.passes) {
      (pass as { dispose?: () => void }).dispose?.();
    }
    this.composer.dispose();
    this.shadowScratch.dispose();
    this.renderer.dispose();
  }

  /**
   * Frame-pressure valve (§7A.7): trim PIXELS, never features. Fed the real
   * frame dt from the game loop; the capture harness never reaches this,
   * because it never draws through the animated path.
   */
  adaptPixelRatio(dtReal: number): void {
    // a pinned buffer is a measurement, not a game: giving up pixels under
    // load is exactly what the bench is trying to observe
    if (this.pinned || dtReal <= 0) return;
    const ms = Math.min(dtReal * 1000, 250);
    this.frameEma += (ms - this.frameEma) * 0.1;

    if (this.frameEma > DROP_MS) {
      this.coolFor = 0;
      this.hotFor += dtReal;
      if (this.hotFor >= DROP_AFTER && this.ratioIdx < RATIO_STEPS.length - 1) {
        this.hotFor = 0;
        this.setRatioStep(this.ratioIdx + 1);
      }
    } else if (this.frameEma < RAISE_MS) {
      this.hotFor = 0;
      this.coolFor += dtReal;
      if (this.coolFor >= RAISE_AFTER && this.ratioIdx > 0) {
        this.coolFor = 0;
        this.setRatioStep(this.ratioIdx - 1);
      }
    } else {
      this.hotFor = 0;
      this.coolFor = 0;
    }
  }

  private setRatioStep(idx: number): void {
    this.ratioIdx = idx;
    const ratio = this.basePixelRatio * RATIO_STEPS[idx];
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.syncTexel();
    // a resolution change is a fresh baseline; don't judge it on stale frames
    this.frameEma = (DROP_MS + RAISE_MS) / 2;
  }

  /**
   * Bench only (§7A.9b): pin the drawing buffer to a fixed CSS size and pixel
   * ratio so a frame-time number means the same thing on any window and any
   * display. The canvas KEEPS its CSS size (updateStyle false), so the shell
   * window can be whatever fits on the machine while the GPU still draws the
   * 1920x1080@2 frame we are quoting numbers for.
   */
  pinRenderSize(w: number, h: number, ratio: number): void {
    this.pinned = { w, h, ratio };
    this.basePixelRatio = ratio;
    this.ratioIdx = 0;
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.syncTexel();
    this.atmos.onCameraChange();
  }

  /** Keep the sharpen's taps one DEVICE pixel apart whatever the buffer is. */
  private syncTexel(): void {
    const t = this.gradePass.uniforms.texel;
    if (!t) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    t.value.set(1 / Math.max(size.x, 1), 1 / Math.max(size.y, 1));
  }

  /** The drawing buffer the GPU is actually filling, in device pixels. */
  bufferSize(): { width: number; height: number; ratio: number } {
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { width: v.x, height: v.y, ratio: this.renderer.getPixelRatio() };
  }

  onResize(): void {
    if (this.pinned) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.syncTexel();
    this.atmos.onCameraChange();
  }

  /**
   * The shadow pass, run as its own render — and the reason it has to be.
   *
   * three r185 decides what goes into a shadow map with
   *
   *     const visible = object.layers.test( camera.layers );   // WebGLShadowMap
   *
   * where `camera` is the VIEW camera, not the shadow camera. The skinned
   * players cast off decimated proxies parked on SHADOW_LAYER precisely so the
   * view camera will not draw them (§7A.2) — so that test fails for every proxy
   * in the game and 22 players cast NOTHING. Enabling the layer on
   * light.shadow.camera (which is what the rig used to do) changes nothing: the
   * shadow camera's own mask is never consulted.
   *
   * Calling renderer.shadowMap.render() by hand does not work either — it
   * reaches into the renderer's per-render state, which only exists inside
   * renderer.render(). So the shadow maps are filled by a real render that
   * draws (almost) nothing: a probe camera parked 5km under the pitch, with a
   * 1-degree 1cm-deep frustum and a layer mask of SHADOW_LAYER and nothing
   * else. prepareShadowCasters() puts every caster in the scene on that layer,
   * so the shadow pass sees all of them, while the render list the probe builds
   * is culled away to nothing by its own frustum.
   *
   * The mask has to be SHADOW_LAYER *only*, not "layer 0 plus SHADOW_LAYER":
   * the character meshes carry frustumCulled = false, so a probe that could see
   * layer 0 would skip the cull and re-draw all 22 players at full detail into
   * a 1x1 target. Measured: 4.8ms -> 26ms a frame. Ask how I know.
   */
  private drawShadows(): void {
    this.prepareShadowCasters();
    const sm = this.renderer.shadowMap;
    const prevTarget = this.renderer.getRenderTarget();
    sm.autoUpdate = true;
    this.renderer.setRenderTarget(this.shadowScratch);
    this.renderer.render(this.scene, this.shadowProbe);
    // ...and the composer's own render must not do it all over again
    sm.autoUpdate = false;
    sm.needsUpdate = false;
    this.renderer.setRenderTarget(prevTarget);
  }

  /**
   * Two jobs, one traversal, both run before the shadow pass.
   *
   * 1. Put every shadow caster on SHADOW_LAYER, so the probe camera (which sees
   *    that layer and nothing else) can find them. Idempotent bit-setting on a
   *    ~1.5k-object scene: ~0.05ms.
   *
   * 2. The compatibility shim. The skinned rig's shadow proxy IS its lowest LOD
   *    mesh, and the LOD picker hides every level except the one being drawn —
   *    so the proxy of a player at LOD 0 or 1 is `visible = false`, and three's
   *    shadow pass skips invisible objects before it looks at anything else.
   *    With 2 players at LOD 0 and 20 at LOD 1, that was 22 players casting
   *    nothing. A mesh whose layer mask is SHADOW_LAYER *only* is by definition
   *    invisible to the game camera, so forcing it visible cannot put a
   *    low-poly duplicate on screen. (When the proxy IS the drawn level the rig
   *    puts layer 0 back on it, and the mask test leaves it alone.)
   *
   *    The real fix belongs in the character pipeline — a shadow proxy should
   *    not share a visibility flag with the LOD level it is built from.
   */
  private prepareShadowCasters(): void {
    this.scene.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      // the proxy test first: enabling the layer below would change the mask
      if (!o.visible && o.layers.mask === PROXY_MASK) o.visible = true;
      if ((o as THREE.Mesh).castShadow) o.layers.enable(SHADOW_LAYER);
    });
  }

  render(): void {
    // cascades follow the camera and the sky dome rides on it, so this has to
    // happen after the camera director has moved and before anything draws
    this.atmos.update();
    // the cascades are fitted to where the camera IS, not where it was a frame
    // ago — the capture harness re-poses it between draws
    this.camera.updateMatrixWorld();
    this.drawShadows();
    this.composer.render();
  }
}
