// Scene + the PS3 post stack (§7A.6/§7A.7). Lighting is NOT here — Atmosphere
// owns every light in the project; this file owns the renderer, the camera and
// the pass chain.
//
// HIGH / MEDIUM chain (one tone-map, in the grade):
//   scene → [half-float RT + DepthTexture, MSAA only at pixel ratio < 1.75]
//         → DepthAO (half-res, 8 taps, writes no colour)
//         → UnrealBloom(per-preset threshold/strength)
//         → GradePass — ACES, AO, bokeh, aberration, lift/gain/contrast,
//                       split-tone, sharpen, vignette, sRGB encode, dither:
//                       ONE pass
//         → SMAA (to screen)                             … HIGH
//         → FXAA (to screen)                             … MEDIUM
//
// RETRO chain is the v1.1 stack, untouched: renderer-level ACES, bloom on the
// tone-mapped image, the old contrast/saturation grade, OutputPass. No depth
// texture, no AO, no lens.
//
// GTAO was evaluated and cut, and still is: three's GTAOPass and SSAOPass both
// build a normal G-buffer by re-rendering the whole scene through an override
// material, which is a second pass over 1.4k objects and 22 skinned rigs for
// one screen-space effect. What replaced it (render/ao.ts) needs no prepass at
// all — the composer's target now carries a real DepthTexture, so the geometry
// pass that was already happening leaves the AO (and the grade's depth of
// field) everything they need. That is ONE half-res fullscreen draw.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Atmosphere } from './Atmosphere';
import { DepthAOPass } from './ao';
import type { GrassBall, GrassField } from './grass';
import { SHADOW_LAYER, setMaxAnisotropy } from './materials';
import { DofBlurPass, GradePass, RetroGradeShader, ScaledBloomPass, TonemapGradeShader } from './postFX';
import {
  effectiveSamples, qualityProfile, qualitySetting,
  type QualityLevel, type QualityProfile,
} from './quality';

export type TimeOfDay = 'day' | 'sunset' | 'night';

// Adaptive resolution (§7A.7): under frame pressure we give up PIXELS, never
// features.
//
// THE BUG THIS REPLACES. The first version compared an EMA of the frame
// interval against two absolute thresholds: drop over 22ms, climb back under
// 13ms. The drop half works. The climb half is UNREACHABLE on a vsync-locked
// display: rAF hands you one frame per refresh, so on a 60Hz panel the
// interval is 16.7ms when everything is perfect and the EMA can never go below
// 13. The controller was therefore a one-way ratchet — the shader-compile
// stalls in the first seconds of a match spend a second of "hot" time, the
// buffer steps down, and it stays down for the rest of the session no matter
// how much headroom the GPU has. At DPR 2 that is a 2940x1912 frame quietly
// becoming 2500x1625, which is exactly "still kinda low-res".
//
// The rewrite measures MISSED VSYNCS instead of absolute milliseconds:
//
//  • the display's refresh period is learned from the shortest interval we
//    ever see (under vsync that IS the period), so the same code is right on
//    60Hz, 120Hz and a ProMotion panel;
//  • a frame "misses" when it took more than 1.4 refreshes — i.e. we actually
//    dropped one, which is the only thing a player can see;
//  • we drop after ~1s of sustained misses and RESTORE after ~1.5s clean,
//    because at 60fps with 400fps of headroom (the measured case) there is no
//    reason to sit at reduced resolution for four seconds;
//  • a promotion that is punished by a drop within 4s doubles the next
//    promotion's patience, up to 20s, so a genuinely marginal machine settles
//    instead of pumping;
//  • frames longer than STALL_MS are neither hot nor cool — a shader compile,
//    a texture upload or a window drag is not fill-rate pressure and must not
//    cost pixels;
//  • the first WARMUP_MS of a renderer's life is ignored outright, which
//    is where every one of those stalls lives;
//  • and every drop is put on trial: once the smaller buffer has settled we
//    watch DROP_TRIAL seconds of it, and if the miss rate did not fall by at
//    least a third the misses were never fill-rate (the sim, GC, another app
//    eating the SoC) — so the pixels come straight back and further drops are
//    refused for FUTILE_HOLD seconds, doubling on each repeat.
const RATIO_STEPS: Record<QualityLevel, number[]> = {
  // HIGH floors at 0.85: below that a Retina panel reads as soft, and a
  // machine that cannot hold HIGH at 0.85 wants MEDIUM, not a blurrier HIGH.
  high: [1, 0.92, 0.85],
  medium: [1, 0.85, 0.72],
  retro: [1, 0.85, 0.72, 0.6],
};

/** a frame this long is a stall, not fill-rate pressure */
const STALL_MS = 90;
/** ignore everything for this long after the renderer is built */
const WARMUP_MS = 2500;
/** > this many refresh periods = a dropped frame */
const MISS_FACTOR = 1.4;
/** the learned refresh period is clamped here (240Hz … 55Hz) */
const VSYNC_MIN = 4.0;
const VSYNC_MAX = 18.5;
/** the estimate leaks upward ~4%/s so a 120Hz→60Hz move is picked up */
const VSYNC_LEAK = 1.0007;
const DROP_AFTER = 1.0;
const RAISE_AFTER = 1.5;
const RAISE_AFTER_MAX = 20;
/** a promotion punished within this many seconds doubles the next wait */
const PROMOTION_REGRET = 4.0;
/** frames right after a resolution change are re-allocation, not gameplay */
const SETTLE = 0.35;
/** seconds of post-drop frames a demotion is judged on */
const DROP_TRIAL = 2.0;
/** a drop must cut the miss rate to at most this fraction of what it was */
const DROP_MUST_REACH = 0.67;
/** after a futile drop, refuse drops for this long (doubles per repeat) */
const FUTILE_HOLD = 20;
const FUTILE_HOLD_MAX = 160;

/** What the resolution valve is doing right now — for the `?gfx=1` overlay,
 *  the bench report and anyone debugging "why is it soft". */
export interface GfxStats {
  css: { w: number; h: number };
  buffer: { w: number; h: number };
  composer: { w: number; h: number };
  devicePixelRatio: number;
  basePixelRatio: number;
  pixelRatio: number;
  /** adaptive scale currently applied (1 = full) */
  scale: number;
  step: number;
  steps: number[];
  pinned: boolean;
  quality: QualityLevel;
  aa: 'smaa' | 'fxaa' | 'none';
  msaaSamples: number;
  sharpen: number;
  anisotropy: number;
  /** learned display refresh period, ms */
  vsyncMs: number;
  /** last presented frame interval, ms */
  frameMs: number;
  /** presented fps over the last second */
  fps: number;
  /** fraction of the last second's frames that missed a vsync */
  missPct: number;
  /** why the valve last moved (or didn't) */
  note: string;
}

export class SceneManager {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  atmos: Atmosphere;
  readonly profile: QualityProfile;
  private bloom: ScaledBloomPass;
  private gradePass: ShaderPass;
  /** §7A.6b — null on RETRO and on any level whose profile says aoStrength 0 */
  private aoPass: DepthAOPass | null = null;
  private dofPass: DofBlurPass | null = null;

  private basePixelRatio: number;
  private ratioIdx = 0;
  /** set by pinRenderSize(): while this holds, neither the adaptive-resolution
   *  valve nor a window resize may touch the drawing buffer */
  private pinned: { w: number; h: number; ratio: number } | null = null;
  /** bench ablation only (`&ablate=1`): skip the shadow pass to price it */
  benchSkipShadows = false;

  // ---- adaptive-resolution state (see RATIO_STEPS above)
  private steps: number[];
  private vsyncMs = 16.7;
  private hotFor = 0;
  private coolFor = 0;
  private warmupLeft = WARMUP_MS;
  private settleLeft = 0;
  private raiseAfter = RAISE_AFTER;
  private sinceRaise = Infinity;
  /** the drop currently on trial: miss rate before it, and what we've seen since */
  private trial: { before: number; left: number; frames: number; misses: number } | null = null;
  /** drops are refused while this is > 0 (a recent drop bought nothing) */
  private futileLeft = 0;
  private futileHold = FUTILE_HOLD;
  /** rolling one-second window of presented intervals, for the overlay */
  private recent: number[] = [];
  private recentMs = 0;
  private lastNote = 'warmup';
  private lastFrameMs = 16.7;
  /** ?gfx=1 debug overlay / console trace */
  private debug: { el: HTMLDivElement | null; log: boolean; t: number } | null = null;

  constructor(canvas: HTMLCanvasElement, public timeOfDay: TimeOfDay, level?: QualityLevel) {
    this.profile = qualityProfile(level ?? qualitySetting());
    this.steps = RATIO_STEPS[this.profile.level] ?? RATIO_STEPS.high;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.profile.retro });
    this.basePixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // publish the real anisotropy cap before anything bakes a texture: the
    // pitch is the one surface in the game that is always seen edge-on, and
    // 16x is the difference between grain and a crawling moire at DPR 2
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.renderer.shadowMap.enabled = true;
    this.letShadowsSeeProxies();
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
      // §7A.6b: a real DepthTexture on the HDR target, so the AO pass and the
      // grade's depth of field can both work from the geometry pass that was
      // already happening instead of re-rendering the scene into a G-buffer.
      // EffectComposer's renderTarget2 is a structural CLONE of this one, so
      // it gets its own depth texture and the two never alias — which matters,
      // because the pass chain's swap count is odd and the buffer the
      // RenderPass draws into therefore alternates frame to frame.
      const depthTexture = new THREE.DepthTexture(1, 1);
      // Depth+stencil, and `stencilBuffer: true` below to go with it. These
      // two have to AGREE. When the target is multisampled — which it is at
      // pixel ratio 1, i.e. on an external monitor and in the capture harness
      // — three allocates the MSAA depth attachment as DEPTH_COMPONENT24 or
      // DEPTH24_STENCIL8 purely from `stencilBuffer`, and then blits it into
      // this texture. A DEPTH24_STENCIL8 texture behind a DEPTH_COMPONENT24
      // renderbuffer is "Depth/stencil buffer format combination not allowed
      // for blit", every frame, and the whole composite comes out black.
      depthTexture.format = THREE.DepthStencilFormat;
      depthTexture.type = THREE.UnsignedInt248Type;
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        // not profile.samples: MSAA is priced per device pixel, and on a
        // Retina panel the 4x half-float resolve alone costs more than the
        // entire rest of the frame (see effectiveSamples)
        samples: effectiveSamples(this.profile, this.basePixelRatio),
        depthTexture,
        stencilBuffer: true,
      });
      rt.texture.name = 'SS26.hdr';
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));

      // AO first, straight off the depth the RenderPass just wrote. It adds no
      // colour pass of its own — the grade blurs and applies it.
      if (this.profile.ao > 0) {
        this.aoPass = new DepthAOPass(this.camera, this.profile.aoTaps);
        this.aoPass.setIntensity(1.0);
        this.composer.addPass(this.aoPass);
      }

      // Restraint (§7A.6). The threshold sits just ABOVE where a white shirt
      // in full key lands (~1.0 linear), because a white kit is the one thing
      // in this game that is legitimately near-white and must NOT glow — that
      // is the exact "grey halo around the players" the spec is hunting.
      // What is left above the line is what should bloom: floodlight heads,
      // the sun disc and horizon, and the ball's specular.
      // strength/threshold come from the preset now (§7A.6c): an overcast sky
      // has nothing above the threshold in it and wants a lower one, and a
      // sunset wants more of the glow it has earned
      const g = this.atmos.grade;
      this.bloom = new ScaledBloomPass(size.clone(),
        g?.bloomStrength ?? 0.38, 0.55, g?.bloomThreshold ?? 1.3,
        this.profile.bloomScale);
      this.composer.addPass(this.bloom);

      // The lens blur buffer (§7A.6c): reads the bloomed frame + depth, writes
      // its own half-res targets, skipped entirely while dofAmount is 0.
      this.dofPass = new DofBlurPass();
      this.dofPass.setCameraRange(this.camera.near, this.camera.far);
      this.composer.addPass(this.dofPass);

      this.gradePass = new GradePass();
      this.gradePass.uniforms.tDofBlur.value = this.dofPass.texture;
      this.dofPass.radiusFrac = this.gradePass.uniforms.dofRadius.value;
      this.gradePass.uniforms.exposure.value = this.atmos.exposure;
      this.gradePass.uniforms.gradeAmount.value = this.profile.grade ? 1 : 0;
      this.gradePass.uniforms.cameraRange.value.set(this.camera.near, this.camera.far);
      if (g) {
        const u = this.gradePass.uniforms;
        u.contrast.value = g.contrast;
        u.lift.value.copy(g.lift);
        u.gain.value.copy(g.gain);
        u.saturation.value = g.saturation;
        u.vignette.value = g.vignette;
        // MEDIUM is "the lighting model, minus the expensive half": the
        // aberration is a two-tap lens affectation and goes with the grade it
        // belongs to. AO does NOT — grounding a player in the turf is the
        // lighting model.
        u.chroma.value = this.profile.grade ? g.chroma : 0;
        u.shadowTint.value.copy(g.shadowTint);
        u.highlightTint.value.copy(g.highlightTint);
      }
      if (this.aoPass) {
        this.gradePass.uniforms.tAO.value = this.aoPass.texture;
        this.gradePass.uniforms.aoAmount.value = this.profile.ao;
      }
      // A light sharpen only where it is paid for: SMAA is an edge-aware
      // reconstruction and leaves the image slightly soft, which at DPR 2 on a
      // Retina panel reads as "not quite in focus". FXAA (MEDIUM) is already a
      // blur and sharpening it just amplifies its own artefacts.
      // ...and MORE of it at DPR 2 than at DPR 1. The taps are one DEVICE
      // pixel apart (see syncTexel), so on a Retina panel the mask is
      // operating on half-a-CSS-pixel detail, where it is a genuine acuity
      // gain and nowhere near the ringing the same number would cause at 1x.
      this.gradePass.uniforms.sharpen.value = this.profile.aa === 'smaa'
        ? (this.basePixelRatio >= 1.75 ? 0.30 : 0.22) : 0;
      this.composer.addPass(this.gradePass);

      // Both AA filters want display-encoded input, which the grade now
      // writes (see TonemapGradeShader), and both write straight to the
      // screen: no OutputPass, one less full-screen pass. With no AA at all
      // the grade itself is the last pass and goes to the screen.
      if (this.profile.aa === 'smaa') this.composer.addPass(new SMAAPass());
      if (this.profile.aa === 'fxaa') this.composer.addPass(new FXAAPass());
    }
    this.composer.setSize(w, h);
    if (!this.profile.retro) this.syncTexel();

    this.setupDebug();
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
    this.debug?.el?.remove();
    this.debug = null;
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
    // a pinned buffer is a measurement, not a game: giving up pixels under
    // load is exactly what the bench is trying to observe
    if (this.pinned || dtReal <= 0) return;
    const ms = dtReal * 1000;
    this.lastFrameMs = ms;
    this.sinceRaise += dtReal;

    // the one-second window the overlay quotes fps and miss% from
    this.recent.push(ms);
    this.recentMs += ms;
    while (this.recentMs > 1000 && this.recent.length > 1) {
      this.recentMs -= this.recent.shift() as number;
    }

    if (this.warmupLeft > 0) {
      this.warmupLeft -= ms;
      this.lastNote = 'warmup';
      return;
    }
    // a stall is not fill-rate pressure: shader compile, texture upload, GC,
    // a window drag, the user Cmd-Tabbing away. Neither hot nor cool.
    if (ms > STALL_MS) {
      this.lastNote = `stall ${ms | 0}ms (ignored)`;
      return;
    }
    if (this.settleLeft > 0) {
      this.settleLeft -= dtReal;
      this.lastNote = 'settling';
      return;
    }

    // Learn the refresh period: under vsync the SHORTEST interval we ever see
    // is exactly one refresh. The slow upward leak lets the estimate follow a
    // display change (120Hz laptop panel → 60Hz projector) instead of pinning
    // itself to the fastest frame of the session forever.
    this.vsyncMs = Math.min(
      Math.max(Math.min(ms, VSYNC_MAX), VSYNC_MIN),
      Math.min(this.vsyncMs * VSYNC_LEAK, VSYNC_MAX),
    );

    const missed = ms > this.vsyncMs * MISS_FACTOR;
    if (this.futileLeft > 0) this.futileLeft -= dtReal;

    // a drop on trial: did giving up pixels actually stop the misses?
    if (this.trial) {
      const t = this.trial;
      t.frames++;
      if (missed) t.misses++;
      t.left -= dtReal;
      if (t.left > 0) {
        this.lastNote = `trial ${t.misses}/${t.frames} missed (was ${(t.before * 100) | 0}%)`;
        return;
      }
      this.trial = null;
      const after = t.misses / Math.max(1, t.frames);
      if (after > t.before * DROP_MUST_REACH) {
        // not fill-rate: take the pixels back and stop trading them away
        this.futileLeft = this.futileHold;
        this.futileHold = Math.min(this.futileHold * 2, FUTILE_HOLD_MAX);
        this.setRatioStep(this.ratioIdx - 1,
          `undone: drop left misses at ${(after * 100) | 0}% (was ${(t.before * 100) | 0}%)`);
        return;
      }
      this.futileHold = FUTILE_HOLD;
    }

    if (missed) {
      this.coolFor = 0;
      this.hotFor += dtReal;
    } else {
      this.coolFor += dtReal;
      // a lone dropped frame in an otherwise clean second must not accumulate
      // into a demotion, so the hot clock bleeds back down while we are fine
      this.hotFor = Math.max(0, this.hotFor - dtReal * 0.5);
    }

    if (this.hotFor >= DROP_AFTER && this.ratioIdx < this.steps.length - 1 && this.futileLeft > 0) {
      this.lastNote = `hot, but drops bought nothing (hold ${this.futileLeft.toFixed(0)}s)`;
    } else if (this.hotFor >= DROP_AFTER && this.ratioIdx < this.steps.length - 1) {
      // a promotion that got us here was a mistake; be more patient next time
      if (this.sinceRaise < PROMOTION_REGRET) {
        this.raiseAfter = Math.min(this.raiseAfter * 2, RAISE_AFTER_MAX);
      }
      const before = this.recentMissRate();
      this.setRatioStep(this.ratioIdx + 1, 'dropped: missed vsyncs for 1s');
      this.trial = { before, left: DROP_TRIAL, frames: 0, misses: 0 };
    } else if (this.coolFor >= this.raiseAfter && this.ratioIdx > 0) {
      this.setRatioStep(this.ratioIdx - 1, 'restored: 1s+ clean');
      this.sinceRaise = 0;
    } else {
      this.lastNote = missed ? `hot ${this.hotFor.toFixed(2)}s` : `ok ${this.coolFor.toFixed(1)}s`;
    }
  }

  /** share of the last second's non-stall frames that missed a vsync */
  private recentMissRate(): number {
    let n = 0, miss = 0;
    for (const ms of this.recent) {
      if (ms > STALL_MS) continue;
      n++;
      if (ms > this.vsyncMs * MISS_FACTOR) miss++;
    }
    return n ? miss / n : 0;
  }

  private setRatioStep(idx: number, why: string): void {
    this.ratioIdx = idx;
    const ratio = this.basePixelRatio * this.steps[idx];
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.syncTexel();
    // a resolution change is a fresh baseline; don't judge it on stale frames
    this.hotFor = 0;
    this.coolFor = 0;
    this.settleLeft = SETTLE;
    this.lastNote = `${why} → x${this.steps[idx]}`;
    console.info(`ss26 render scale x${this.steps[idx]} (${why})`);
  }

  /** Everything the `?gfx=1` overlay, the bench report and a bug report need. */
  gfxStats(): GfxStats {
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = this.composer.renderTarget1;
    const frames = this.recent.length;
    return {
      css: { w: window.innerWidth, h: window.innerHeight },
      buffer: { w: buf.x, h: buf.y },
      composer: { w: rt.width, h: rt.height },
      devicePixelRatio: window.devicePixelRatio,
      basePixelRatio: this.basePixelRatio,
      pixelRatio: this.renderer.getPixelRatio(),
      scale: this.pinned ? 1 : this.steps[this.ratioIdx],
      step: this.ratioIdx,
      steps: this.steps,
      pinned: !!this.pinned,
      quality: this.profile.level,
      aa: this.profile.aa,
      msaaSamples: effectiveSamples(this.profile, this.basePixelRatio),
      sharpen: (this.gradePass.uniforms.sharpen?.value as number) ?? 0,
      anisotropy: this.renderer.capabilities.getMaxAnisotropy(),
      vsyncMs: Math.round(this.vsyncMs * 100) / 100,
      frameMs: Math.round(this.lastFrameMs * 100) / 100,
      fps: frames > 1 ? Math.round((frames / Math.max(this.recentMs, 1)) * 10000) / 10 : 0,
      missPct: frames > 1
        ? Math.round((this.recent.filter((m) => m > this.vsyncMs * MISS_FACTOR).length
          / frames) * 1000) / 10
        : 0,
      note: this.lastNote,
    };
  }

  /**
   * `?gfx=1` — the resolution audit, on screen and on the console.
   *
   * There is no other honest way to answer "what am I actually looking at":
   * the drawing buffer, the pixel ratio, the adaptive step, the composer's own
   * target and the AA in force are five different numbers that a screenshot
   * cannot tell apart. `?gfx=log` is the same trace with no overlay, which is
   * what the native shell's stdout wants.
   */
  private setupDebug(): void {
    let mode: string | null = null;
    try {
      mode = new URLSearchParams(location.search).get('gfx');
    } catch { /* no location (worker/test) */ }
    if (!mode || mode === '0') return;
    const log = mode === 'log' || mode === '2';
    let el: HTMLDivElement | null = null;
    if (!log && typeof document !== 'undefined') {
      el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;pointer-events:none;'
        + 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;'
        + 'color:#bfe9c6;background:rgba(4,10,8,.72);padding:6px 9px;border-radius:5px;'
        + 'border:1px solid rgba(120,220,150,.28);text-shadow:0 1px 2px #000';
      document.body.appendChild(el);
    }
    this.debug = { el, log, t: 0 };
  }

  private updateDebug(): void {
    const d = this.debug;
    if (!d) return;
    const now = performance.now();
    const every = d.log ? 2000 : 220;
    if (now - d.t < every) return;
    d.t = now;
    const s = this.gfxStats();
    const text = [
      `buffer   ${s.buffer.w}x${s.buffer.h}   (css ${s.css.w}x${s.css.h})`,
      `ratio    ${s.pixelRatio.toFixed(2)}  = dpr ${s.devicePixelRatio} x base`
        + ` ${s.basePixelRatio} x scale ${s.scale}${s.pinned ? ' [PINNED]' : ''}`,
      `composer ${s.composer.w}x${s.composer.h}   step ${s.step}/${s.steps.length - 1}`,
      `quality  ${s.quality}  aa ${s.aa}  msaa ${s.msaaSamples}x  sharpen ${s.sharpen}`
        + `  aniso ${s.anisotropy}`,
      `frame    ${s.fps.toFixed(1)}fps  ${s.frameMs.toFixed(2)}ms  vsync`
        + ` ${s.vsyncMs.toFixed(2)}ms  miss ${s.missPct}%`,
      `valve    ${s.note}`,
    ].join('\n');
    if (d.el) d.el.textContent = text;
    else console.info(`[gfx]\n${text}`);
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

  /** Keep the sharpen's taps one DEVICE pixel apart — and the AO blur's taps
   *  one AO texel apart — whatever the buffer is. */
  private syncTexel(): void {
    const t = this.gradePass.uniforms.texel;
    if (!t) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    t.value.set(1 / Math.max(size.x, 1), 1 / Math.max(size.y, 1));
    const ao = this.aoPass;
    const at = this.gradePass.uniforms.aoTexel;
    if (ao && at) {
      at.value.set(1 / Math.max(ao.target.width, 1), 1 / Math.max(ao.target.height, 1));
    }
  }

  /**
   * §7A.6c — depth of field, for CLOSE CAMERAS ONLY.
   *
   * The camera director owns the decision (see GameRenderer.syncLens): a
   * cutscene, a celebration, a penalty, a keeper cam or a walkout gets a lens
   * with a focal plane on its subject; the tele cam never does, because a
   * broadcast long lens covering a football match is stopped down and
   * everything from the near touchline to the far stand is acceptably sharp.
   * Defocusing it is the single fastest way to make a game look like a game.
   *
   * `amount` 0 turns the whole block off — the uniform branch costs one
   * compare on a frame that is not using it.
   */
  setDepthOfField(amount: number, focusMetres: number, rangeMetres = 3.5): void {
    const u = this.gradePass.uniforms;
    if (!u.dofAmount) return;    // RETRO's grade has no lens
    u.dofAmount.value = this.profile.retro ? 0 : amount;
    u.dofFocus.value = focusMetres;
    u.dofRange.value = rangeMetres;
    this.dofPass?.setLens(u.dofAmount.value, focusMetres, rangeMetres);
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
    // a resize can be a MOVE: dragging the window onto a 1x external monitor
    // changes devicePixelRatio, and a base ratio captured at construction
    // would leave the game rendering at 2x on a 1x panel (or, worse, 1x on a
    // Retina one) for the rest of the session
    const base = Math.min(window.devicePixelRatio, 2);
    if (base !== this.basePixelRatio) {
      this.basePixelRatio = base;
      this.renderer.setPixelRatio(base * this.steps[this.ratioIdx]);
      this.composer.setPixelRatio(base * this.steps[this.ratioIdx]);
    }
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.syncTexel();
    this.atmos.onCameraChange();
  }

  /**
   * The shadow pass sees SHADOW_LAYER — from inside the one real render.
   *
   * three r185 decides what goes into a shadow map with
   *
   *     const visible = object.layers.test( camera.layers );   // WebGLShadowMap
   *
   * where `camera` is the VIEW camera, not the shadow camera. The skinned
   * players cast off decimated proxies parked on SHADOW_LAYER precisely so the
   * view camera will not draw them (§7A.2), and so do the roof casters — so
   * with the stock renderer that test fails for every proxy in the game and 22
   * players cast NOTHING. The shadow camera's own mask is never consulted.
   *
   * This used to be answered with a whole second renderer.render() a frame,
   * from a probe camera that saw only SHADOW_LAYER, plus a per-frame traversal
   * putting every caster on that layer. Measured with `&cpuprof=1`, that
   * probe render cost as much main-thread time as the beauty pass itself: a
   * second full-graph updateMatrixWorld (1.8k nodes, 1.1k of them bones), a
   * second projectObject, a second light setup and a second skeleton upload.
   *
   * The render already calls shadowMap.render(lights, scene, camera) AFTER it
   * has built its own render list (WebGLRenderer.render: projectObject, then
   * shadows, then draws). So the view camera is given SHADOW_LAYER for exactly
   * the length of that call: the beauty list, already built, never sees a
   * proxy, and the shadow pass sees every caster on layer 0 plus every proxy.
   */
  private letShadowsSeeProxies(): void {
    const shadowMap = this.renderer.shadowMap;
    const drawMaps = shadowMap.render.bind(shadowMap);
    shadowMap.render = (lights, scene, camera) => {
      if (this.benchSkipShadows) return;
      const mask = camera.layers.mask;
      camera.layers.enable(SHADOW_LAYER);
      try {
        drawMaps(lights, scene, camera);
      } finally {
        camera.layers.mask = mask;
      }
    };
  }

  render(): void {
    // §7A.3b: the shell turf follows the camera's look point and has to be
    // re-centred BEFORE the cascades are fitted (it is a shadow receiver) and
    // before anything reads a world matrix. It is driven from here rather than
    // from the game renderer because the only two things it needs are the
    // camera and the clock, and both live in this file.
    //
    // performance.now() — which the capture harness replaces with a virtual
    // clock, so a still of the wind is as reproducible as everything else.
    const grass = this.scene.userData.ss26Grass as GrassField | undefined;
    grass?.update(this.camera, performance.now() * 0.001,
      (this.scene.userData.ss26Ball as GrassBall | undefined) ?? null);
    // cascades follow the camera and the sky dome rides on it, so this has to
    // happen after the camera director has moved and before anything draws
    this.atmos.update();
    // the cascades are fitted to where the camera IS, not where it was a frame
    // ago — the capture harness re-poses it between draws
    this.camera.updateMatrixWorld();
    this.composer.render();
    if (this.debug) this.updateDebug();
  }
}
