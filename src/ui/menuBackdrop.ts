// The menu's depth-of-field player backdrop (§7.1: "dark UI with
// depth-of-field 3D player render backdrop").
//
// A small dedicated three.js scene — NOT the match renderer: two skinned
// players in the current kits, three lights, no shadow maps.
//
// THE DEPTH OF FIELD USED TO BE A LIE. The backing store was rendered at
// 0.26-0.42 of the CSS size and the compositor's bilinear upscale was called
// "defocus". On a Retina panel that is not a lens, it is a 4x upscale of a
// quarter-resolution image, and it reads exactly like what it is: the players'
// faces are mush and the kit numbers are a smear. The rule for a menu is the
// opposite of a lens — the SUBJECT must be the sharpest thing on screen.
//
// So the chain now is:
//
//   scene → sceneRT (full res, half-float, linear)
//         → 9-tap separable Gaussian at HALF res (two passes)
//         → composite: mix(sharp, blurred) by a radial mask centred on the
//           figures, then ACES + vignette + sRGB, straight to the canvas.
//
// The players are drawn at full device resolution and stay sharp in both
// states; what the mask softens is the fall-off around them, which is where a
// real lens loses focus anyway. The menu state widens the mask and drops two
// stops instead of dropping resolution.
//
// Budget: ~16k triangles, one scene pass and three fullscreen passes (two of
// them at quarter the pixels) — ~2ms/frame on an M3, against a front end that
// suspends the attract match while this is up. It stops rendering the moment
// the page is hidden.
//
// It NEVER edits the character pipeline: CharacterRig/preloadCharacters are
// used exactly as the match renderer uses them.

import * as THREE from 'three';
import { CharacterRig, charactersReady, preloadCharacters } from '../render/characterAssets';
import type { CharacterInstance } from '../render/characterAssets';
import { skinnedPlayersWanted } from '../render/gameRenderer';
import { resolveKits } from '../render/playerMesh';
import { pickStartingXI } from '../data/loader';
import type { PlayerData, TeamData } from '../data/types';

/**
 * The lens, as a real depth of field: how much of the frame stays sharp around
 * the figures, and how strongly everything outside that is blurred. The title
 * screen holds focus wide (the figures ARE the picture); behind the menus the
 * circle of sharpness closes down and the surround goes soft, so the type
 * wins — without ever softening the players themselves.
 */
const FOCUS_TITLE = { inner: 0.44, outer: 0.95, amount: 0.55 };
const FOCUS_MENU = { inner: 0.26, outer: 0.72, amount: 0.9 };
/** Gaussian radius in half-res texels — the blur's actual strength. */
const BLUR_RADIUS = 2.6;
/** Exposure follows suit: the menus need the type to win. */
const EXPOSURE_TITLE = 0.95;
const EXPOSURE_MENU = 0.52;
/** Metres the camera drifts, and how slowly. */
const DRIFT_X = 0.30;
const DRIFT_SPEED = 0.085;
/** Far enough back that a 1.8m player is ~60% of frame height, not all of it. */
const CAM_DIST = 5.9;
const CAM_HEIGHT = 1.26;
/**
 * How far the camera slides left once the menus need the middle of the screen.
 * Sliding the CAMERA (rather than the actors) keeps the light rig, the pool and
 * the drift exactly where they were — the players just walk over to stage right.
 */
const PAN_SIDE = -1.25;

interface Actor {
  inst: CharacterInstance;
  mixer: THREE.AnimationMixer;
}

/** Shared by the blur and composite passes: a full-screen triangle-ish quad. */
const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class MenuBackdrop {
  private canvas: HTMLCanvasElement;
  private fallback: HTMLDivElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.25, 60);
  private target = new THREE.Vector3(0, 1.02, 0);
  private rig: CharacterRig | null = null;
  private actors: Actor[] = [];
  private raf = 0;
  private alive = true;
  private last = 0;
  private t = 0;
  private pending: [TeamData, TeamData] | null = null;
  private shown: string | null = null;
  private waiting = false;
  private pan = 0;
  private panWanted = 0;
  private defocused = false;
  private frozen = false;
  private resize: () => void;
  /** the post chain (see the header): full-res scene, half-res blur, composite */
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private blurA: THREE.WebGLRenderTarget | null = null;
  private blurB: THREE.WebGLRenderTarget | null = null;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh | null = null;
  private blurMat: THREE.ShaderMaterial | null = null;
  private compMat: THREE.ShaderMaterial | null = null;
  /** eased towards FOCUS_TITLE / FOCUS_MENU so the rack is a MOVE, not a cut */
  private focus = { ...FOCUS_TITLE };
  private exposure = EXPOSURE_TITLE;

  constructor(private parent: HTMLElement) {
    this.fallback = document.createElement('div');
    this.fallback.className = 'fe-backdrop-fallback';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fe-backdrop';
    this.canvas.style.opacity = '0';
    this.canvas.style.transition = 'opacity 400ms ease';
    parent.appendChild(this.fallback);
    parent.appendChild(this.canvas);

    this.resize = () => this.sizeToParent();
    window.addEventListener('resize', this.resize);

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: false, alpha: false,
        powerPreference: 'low-power', depth: true, stencil: false,
      });
      // full device resolution, capped at 2 exactly like the match renderer
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      // the tone-map lives in the composite shader (three skips tone mapping
      // when it draws into a render target, so doing it here would apply the
      // curve to the screen pass only — and twice to nothing)
      this.renderer.toneMapping = THREE.NoToneMapping;
    } catch {
      // a second WebGL context is not always available (context limits, a lost
      // GPU). The styled fallback is a perfectly good title screen.
      this.renderer = null;
      return;
    }

    this.buildStage();
    this.buildPost();
    this.sizeToParent();
    this.last = performance.now();
    this.raf = requestAnimationFrame((n) => this.loop(n));
  }

  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.clearActors();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      // only what THIS scene minted: the character geometry is page-level and
      // shared with the match renderer, and the rig owns its own materials
      if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh) {
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
    this.rig?.dispose();
    this.rig = null;
    this.sceneRT?.dispose();
    this.blurA?.dispose();
    this.blurB?.dispose();
    this.quad?.geometry.dispose();
    this.blurMat?.dispose();
    this.compMat?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas.remove();
    this.fallback.remove();
  }

  /**
   * Where the figures stand in frame, and how the lens is racked. The title
   * screen wants them centred behind the logo with focus held wide; every
   * other screen needs the middle of the screen for the UI, so they slide over
   * to stage right, the circle of sharpness closes down around them and the
   * whole plate loses two stops. The PLAYERS never lose resolution.
   */
  setFocus(toTheSide: boolean): void {
    this.panWanted = toTheSide ? PAN_SIDE : 0;
    if (!this.renderer) return;
    this.defocused = toTheSide;
  }

  /**
   * Dress the backdrop in a match-up's kits. Rebuilding two skinned players
   * costs ~10ms, so callers only do this on a confirmed pick, never while a
   * team grid is being scrolled.
   */
  /**
   * Stop/restart the render loop. The headless shooter parks it before each
   * screenshot: a canvas repainting at 60Hz under software GL can keep the
   * compositor from ever handing back a finished frame.
   */
  freeze(on: boolean): void {
    this.frozen = on;
    this.last = performance.now();
  }

  setTeams(home: TeamData, away: TeamData): void {
    const key = `${home.id}|${away.id}`;
    if (key === this.shown) return;
    this.pending = [home, away];
    this.tryBuildActors();
  }

  // ------------------------------------------------------------------ stage

  private buildStage(): void {
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.Fog(0x05070c, 5.5, 13);

    // key: a warm floodlight from camera-left and high, like a tunnel lamp
    const key = new THREE.DirectionalLight(0xfff0d6, 2.4);
    key.position.set(2.6, 3.4, 2.2);
    this.scene.add(key);
    // rim: the cold backlight that separates the figures from the black — the
    // single thing that makes a dark menu render look expensive
    const rim = new THREE.DirectionalLight(0x9cc4ff, 3.1);
    rim.position.set(-2.4, 2.0, -2.6);
    this.scene.add(rim);
    const rim2 = new THREE.DirectionalLight(0xffb070, 1.5);
    rim2.position.set(2.2, 1.6, -2.4);
    this.scene.add(rim2);
    this.scene.add(new THREE.HemisphereLight(0x2b3a58, 0x070a10, 0.55));

    // the pool of light they are standing in
    const tex = poolTexture();
    if (tex) {
      const pool = new THREE.Mesh(
        new THREE.PlaneGeometry(7, 7),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, opacity: 0.5,
        }),
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.005;
      this.scene.add(pool);
    }

    this.camera.position.set(0, CAM_HEIGHT, CAM_DIST);
    this.camera.lookAt(this.target);
  }

  /** The post chain: two shaders and one quad, reused by all three passes. */
  private buildPost(): void {
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
    });
    this.sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const half = (): THREE.WebGLRenderTarget => {
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return rt;
    };
    this.blurA = half();
    this.blurB = half();

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null as THREE.Texture | null },
        dir: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc;
        uniform vec2 dir;
        varying vec2 vUv;
        void main() {
          // 9 taps, binomial weights, in linear light — blurring a tone-mapped
          // image is what makes a cheap defocus look like grey mud
          float w[5];
          w[0] = 0.2270270; w[1] = 0.1945946; w[2] = 0.1216216;
          w[3] = 0.0540541; w[4] = 0.0162162;
          vec3 sum = texture2D(tSrc, vUv).rgb * w[0];
          for (int i = 1; i < 5; i++) {
            vec2 o = dir * float(i);
            sum += texture2D(tSrc, vUv + o).rgb * w[i];
            sum += texture2D(tSrc, vUv - o).rgb * w[i];
          }
          gl_FragColor = vec4(sum, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tSharp: { value: null as THREE.Texture | null },
        tBlur: { value: null as THREE.Texture | null },
        focus: { value: new THREE.Vector2(0.5, 0.5) },
        aspect: { value: new THREE.Vector2(1.78, 1) },
        inner: { value: FOCUS_TITLE.inner },
        outer: { value: FOCUS_TITLE.outer },
        amount: { value: FOCUS_TITLE.amount },
        exposure: { value: EXPOSURE_TITLE },
        vignette: { value: 0.34 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tSharp;
        uniform sampler2D tBlur;
        uniform vec2 focus;
        uniform vec2 aspect;
        uniform float inner;
        uniform float outer;
        uniform float amount;
        uniform float exposure;
        uniform float vignette;
        varying vec2 vUv;

        vec3 RRTAndODTFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 aces(vec3 color) {
          const mat3 inMat = mat3(
            0.59719, 0.07600, 0.02840,
            0.35458, 0.90834, 0.13383,
            0.04823, 0.01566, 0.83777);
          const mat3 outMat = mat3(
             1.60475, -0.10208, -0.00327,
            -0.53108,  1.10813, -0.07276,
            -0.07367, -0.00605,  1.07602);
          color *= exposure / 0.6;
          color = outMat * RRTAndODTFit(inMat * color);
          return clamp(color, 0.0, 1.0);
        }
        vec3 toSRGB(vec3 c) {
          return mix(c * 12.92,
            1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
            step(vec3(0.0031308), c));
        }

        void main() {
          vec3 sharp = texture2D(tSharp, vUv).rgb;
          vec3 soft = texture2D(tBlur, vUv).rgb;
          // the lens: sharp on the figures, falling off around them. aspect
          // keeps the circle a circle on a 21:9 window.
          float d = length((vUv - focus) * aspect);
          float coc = smoothstep(inner, outer, d) * amount;
          vec3 c = mix(sharp, soft, coc);
          c = aces(c);
          float v = distance(vUv, vec2(0.5));
          c *= 1.0 - vignette * smoothstep(0.30, 0.95, v);
          gl_FragColor = vec4(toSRGB(c), 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private sizeToParent(): void {
    const w = Math.max(320, this.parent.clientWidth || window.innerWidth);
    const h = Math.max(240, this.parent.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(w, h, false);
    if (!this.renderer) return;
    const ratio = this.renderer.getPixelRatio();
    const pw = Math.max(2, Math.round(w * ratio));
    const ph = Math.max(2, Math.round(h * ratio));
    this.sceneRT?.setSize(pw, ph);
    // the blur runs at half res in each axis: a quarter of the pixels for a
    // Gaussian nobody can tell from the full-res one once it is this wide
    this.blurA?.setSize(Math.max(1, pw >> 1), Math.max(1, ph >> 1));
    this.blurB?.setSize(Math.max(1, pw >> 1), Math.max(1, ph >> 1));
    if (this.compMat) this.compMat.uniforms.aspect.value.set(w / h, 1);
  }

  // ----------------------------------------------------------------- actors

  private clearActors(): void {
    for (const a of this.actors) {
      a.mixer.stopAllAction();
      a.inst.root.removeFromParent();
    }
    this.actors = [];
  }

  private tryBuildActors(): void {
    if (!this.renderer || !this.pending) return;
    const assets = charactersReady();
    if (!assets) {
      if (this.waiting || !skinnedPlayersWanted()) return;
      this.waiting = true;
      // idempotent and shared with main's preload — this never double-fetches
      void preloadCharacters().then(() => {
        this.waiting = false;
        if (this.alive) this.tryBuildActors();
      }).catch(() => { this.waiting = false; });
      return;
    }

    const [home, away] = this.pending;
    this.shown = `${home.id}|${away.id}`;
    this.clearActors();
    // one rig for the page's worth of menu kits; rebuilt when the kits change
    // so its per-kit materials do not pile up
    this.rig?.dispose();
    this.rig = new CharacterRig(assets);

    const [homeKit, awayKit] = resolveKits(home.kit, away.kit);
    const place: [TeamData, typeof homeKit, number, number, number][] = [
      [home, homeKit, -0.95, 0.10, 0.30],
      [away, awayKit, 0.92, -1.05, -0.34],
    ];
    for (const [team, kit, x, z, yaw] of place) {
      const data = heroOf(team);
      let inst: CharacterInstance;
      try {
        inst = this.rig.instance(data, kit);
      } catch {
        continue; // a broken archetype must not take the menu down
      }
      inst.root.position.set(x, inst.groundOffset, z);
      inst.root.rotation.y = yaw;
      // only the highest detail level is wanted at three metres; the LOD
      // meshes and the shadow proxy are hidden, not deleted
      inst.levels.forEach((lv, i) => {
        for (const m of lv.meshes) m.visible = i === 0;
      });
      for (const m of inst.shadowMeshes) m.castShadow = false;
      this.scene.add(inst.root);

      const mixer = new THREE.AnimationMixer(inst.root);
      const idle = this.rig.clip('idle') ?? this.rig.clip('strut');
      if (idle) {
        const act = mixer.clipAction(idle.clip);
        act.play();
        // never let two players breathe in lockstep
        act.time = Math.random() * idle.clip.duration;
        act.timeScale = 0.88 + Math.random() * 0.24;
      }
      this.actors.push({ inst, mixer });
    }

    if (this.actors.length > 0) {
      this.canvas.style.opacity = '1';
      this.fallback.style.transition = 'opacity 400ms ease';
      this.fallback.style.opacity = '0';
    }
  }

  // ------------------------------------------------------------------- loop

  private loop(now: number): void {
    if (!this.alive) return;
    this.raf = requestAnimationFrame((n) => this.loop(n));
    if (!this.renderer || this.frozen || document.hidden) { this.last = now; return; }
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.t += dt;

    for (const a of this.actors) a.mixer.update(dt);

    // ease the stage-right slide (roughly a 250ms move, framerate-independent)
    this.pan += (this.panWanted - this.pan) * Math.min(1, dt * 9);

    // a slow, never-quite-repeating drift: two sines at unrelated rates
    const t = this.t;
    this.camera.position.set(
      this.pan + Math.sin(t * DRIFT_SPEED) * DRIFT_X,
      CAM_HEIGHT + Math.sin(t * 0.061 + 1.3) * 0.085,
      CAM_DIST + Math.sin(t * 0.043 + 0.4) * 0.26,
    );
    this.target.set(this.pan + Math.sin(t * 0.052) * 0.09, 1.02 + Math.sin(t * 0.071) * 0.03, 0);
    this.camera.lookAt(this.target);

    this.draw(dt);
  }

  /**
   * Scene → blur → composite. Kept in one place so the fallback (no render
   * targets, e.g. a context that refused a half-float buffer) is a single
   * early return that still puts the players on screen.
   */
  private draw(dt: number): void {
    const r = this.renderer;
    if (!r) return;
    if (!this.sceneRT || !this.blurA || !this.blurB || !this.quad
      || !this.blurMat || !this.compMat) {
      r.render(this.scene, this.camera);
      return;
    }

    // rack the lens towards wherever setFocus last asked for (~300ms)
    const want = this.defocused ? FOCUS_MENU : FOCUS_TITLE;
    const k = Math.min(1, dt * 7);
    this.focus.inner += (want.inner - this.focus.inner) * k;
    this.focus.outer += (want.outer - this.focus.outer) * k;
    this.focus.amount += (want.amount - this.focus.amount) * k;
    const wantExp = this.defocused ? EXPOSURE_MENU : EXPOSURE_TITLE;
    this.exposure += (wantExp - this.exposure) * k;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(this.scene, this.camera);

    const bw = this.blurA.width, bh = this.blurA.height;
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tSrc.value = this.sceneRT.texture;
    this.blurMat.uniforms.dir.value.set(BLUR_RADIUS / bw, 0);
    r.setRenderTarget(this.blurB);
    r.render(this.quadScene, this.quadCam);

    this.blurMat.uniforms.tSrc.value = this.blurB.texture;
    this.blurMat.uniforms.dir.value.set(0, BLUR_RADIUS / bh);
    r.setRenderTarget(this.blurA);
    r.render(this.quadScene, this.quadCam);

    // where the figures actually are on screen, so the sharp circle tracks the
    // camera drift and the stage-right pan instead of sitting in the middle
    const subject = SUBJECT.set(this.target.x, 1.12, this.target.z).project(this.camera);
    this.quad.material = this.compMat;
    const u = this.compMat.uniforms;
    u.tSharp.value = this.sceneRT.texture;
    u.tBlur.value = this.blurA.texture;
    u.focus.value.set(subject.x * 0.5 + 0.5, subject.y * 0.5 + 0.5);
    u.inner.value = this.focus.inner;
    u.outer.value = this.focus.outer;
    u.amount.value = this.focus.amount;
    u.exposure.value = this.exposure;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}

/** Scratch vector for projecting the subject; allocating one per frame in a
 *  menu that runs at 60Hz is how a front end grows a GC sawtooth. */
const SUBJECT = new THREE.Vector3();

/** The team's face for the poster: the star if there is one, else a striker. */
function heroOf(team: TeamData): PlayerData {
  const xi = pickStartingXI(team);
  return xi.find((p) => p.star)
    ?? xi.find((p) => p.pos === 'FW')
    ?? xi[Math.min(9, xi.length - 1)]
    ?? team.players[0];
}

/** Soft elliptical light pool, painted once. */
function poolTexture(): THREE.CanvasTexture | null {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(150,180,230,0.55)');
  g.addColorStop(0.45, 'rgba(90,115,165,0.16)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
