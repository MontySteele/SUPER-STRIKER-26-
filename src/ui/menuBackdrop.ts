// The menu's depth-of-field player backdrop (§7.1: "dark UI with
// depth-of-field 3D player render backdrop").
//
// A small dedicated three.js scene — NOT the match renderer: two skinned
// players in the current kits, three lights, no shadow maps, no post stack,
// rendered at a fraction of the CSS resolution into its own canvas and scaled
// back up by the compositor. That upscale is the depth of field: it costs
// nothing (a full-screen CSS `filter: blur()` costs a whole raster pass and
// looks the same) and it is exactly the soft, slightly out-of-focus figure a
// PS3 front end put behind its menus. A CSS vignette finishes the grade.
//
// Budget: ~16k triangles, 1 draw pass, 3 lights, and a backing store between a
// quarter and a half of the frame — around 1ms/frame on an M3, and the main
// menu suspends the CPU-vs-CPU attract match while this is up, so the front end
// is CHEAPER than it was. It stops rendering the moment the page is hidden.
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
 * Render scale — this IS the lens. The backing store is rendered at a fraction
 * of the CSS size and the compositor's bilinear upscale does the defocusing,
 * which is both the cheapest possible blur and the one a PS3 menu actually
 * used. The title is the sharper of the two because the figures are the
 * subject there; behind the menus they are wallpaper.
 */
const RES_TITLE = 0.42;
const RES_MENU = 0.26;
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
      this.renderer.setPixelRatio(RES_TITLE);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = EXPOSURE_TITLE;
    } catch {
      // a second WebGL context is not always available (context limits, a lost
      // GPU). The styled fallback is a perfectly good title screen.
      this.renderer = null;
      return;
    }

    this.buildStage();
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
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas.remove();
    this.fallback.remove();
  }

  /**
   * Where the figures stand in frame, and how sharp they are. The title screen
   * wants them centred behind the logo and reasonably crisp; every other screen
   * needs the middle of the screen for the UI, so they slide over to stage
   * right, drop to a quarter-resolution backing store and lose two stops.
   */
  setFocus(toTheSide: boolean): void {
    this.panWanted = toTheSide ? PAN_SIDE : 0;
    if (!this.renderer || toTheSide === this.defocused) return;
    this.defocused = toTheSide;
    this.renderer.setPixelRatio(toTheSide ? RES_MENU : RES_TITLE);
    this.renderer.toneMappingExposure = toTheSide ? EXPOSURE_MENU : EXPOSURE_TITLE;
    this.sizeToParent();
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

  private sizeToParent(): void {
    const w = Math.max(320, this.parent.clientWidth || window.innerWidth);
    const h = Math.max(240, this.parent.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(w, h, false);
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

    this.renderer.render(this.scene, this.camera);
  }
}

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
