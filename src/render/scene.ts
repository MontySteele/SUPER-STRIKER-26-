// Scene + the PS3 post stack (§7A.6/§7A.7). Lighting is NOT here — Atmosphere
// owns every light in the project; this file owns the renderer, the camera and
// the pass chain.
//
// HIGH / MEDIUM chain (one tone-map, in the grade):
//   scene → [MSAA half-float RT] → UnrealBloom(threshold 1.0, strength 0.35)
//         → TonemapGrade (ACES + split-tone + vignette)
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
import { RetroGradeShader, ScaledBloomPass, TonemapGradeShader } from './postFX';
import { qualityProfile, qualitySetting, type QualityLevel, type QualityProfile } from './quality';

export type TimeOfDay = 'day' | 'sunset' | 'night';

// Adaptive resolution (§7A.7): under frame pressure we give up PIXELS, never
// features. Steps are gentle and hysteresis is deliberately lopsided — drop
// after ~1s of pain, climb back only after ~4s of comfort, so a single hitch
// never starts an oscillation the player can see.
const RATIO_STEPS = [1, 0.85, 0.72, 0.6];
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
  private frameEma = 16.7;
  private hotFor = 0;
  private coolFor = 0;

  constructor(canvas: HTMLCanvasElement, public timeOfDay: TimeOfDay, level?: QualityLevel) {
    this.profile = qualityProfile(level ?? qualitySetting());

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.profile.retro });
    this.basePixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in r185 and silently falls back to this
    // anyway; the soft edge comes from each cascade light's shadow.radius,
    // which the PCF tap kernel actually reads (see Atmosphere).
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
      // half-float everywhere so bloom sees real radiance, plus MSAA on the
      // scene buffer (SMAA cleans the post-composite edges; MSAA cleans the
      // geometry ones, and goal netting needs both)
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        samples: this.profile.samples,
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
    this.renderer.dispose();
  }

  /**
   * Frame-pressure valve (§7A.7): trim PIXELS, never features. Fed the real
   * frame dt from the game loop; the capture harness never reaches this,
   * because it never draws through the animated path.
   */
  adaptPixelRatio(dtReal: number): void {
    if (dtReal <= 0) return;
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
    // a resolution change is a fresh baseline; don't judge it on stale frames
    this.frameEma = (DROP_MS + RAISE_MS) / 2;
  }

  onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.atmos.onCameraChange();
  }

  render(): void {
    // cascades follow the camera and the sky dome rides on it, so this has to
    // happen after the camera director has moved and before anything draws
    this.atmos.update();
    this.composer.render();
  }
}
