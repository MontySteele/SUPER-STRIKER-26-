// Stylized PS3-era players (§7.1/§7A.2): one shared body construction worn by
// every player in the match, per-team appearance as a texture swap onto the
// TextureLab kit atlas, per-player skin/hair seeded off the name, and
// code-driven locomotion with action overlays.
//
// The pipeline, and why it is shaped this way:
//
//   PlayerRig owns the geometry (playerBody.ts) and the materials. Twenty-two
//   players share ten geometries per detail level and four kit atlases; the
//   only thing minted per player is a 256x160 back-number texture and two
//   colours. That is what "per-team appearance = texture swap only" buys.
//
//   LOD is distance-driven off the camera (§7A.2): full detail inside 30m,
//   a decimated set out to 60m, a single kit-coloured billboard beyond. The
//   scene draws twenty-two players and the triangle budget is 150k, so the
//   third tier is not an optimisation, it is the reason the budget holds.
//
//   playerMesh.update() is UNCHANGED. Every LOD tier animates through the same
//   five Groups, so nothing above this file knows the tiers exist.

import * as THREE from 'three';
import type { PlayerData } from '../data/types';
import type { ActionAnim } from '../sim/player';
import { queueBroadcastSkin } from './materials';
import { TextureLab, luminance } from './TextureLab';
import {
  buildParts, disposeParts, mirrorLimbs, triangleCount,
  type BodyParts, type Detail, type LimbSet,
} from './playerBody';
import type { TimeOfDay } from './scene';

const SKIN_TONES = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x5c3a21];
const HAIR_COLORS = [0x151210, 0x2e2018, 0x4a3320, 0x7a5c30, 0xb8963e, 0x101010];

/** §7A.2 LOD bands, in metres from the camera. */
export const LOD_FULL_M = 30;
export const LOD_IMPOSTOR_M = 60;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface KitSpec {
  shirt: string;   // hex like "#D7141A"
  shorts: string;
  socks: string;
  isGK: boolean;
}

/** The impostor is unlit (a lit billboard whose normal faces the camera goes
 *  black the moment the sun is behind it), so the time of day is baked into
 *  its tint instead. These are the levels a lit player lands at. */
const IMPOSTOR_TINT: Record<TimeOfDay, number> = {
  day: 0xdde4f2,
  sunset: 0xc9a88c,
  night: 0x8494ae,
};

/**
 * Everything twenty-two players share. Built once per match, disposed with the
 * match — never module-level, because SceneManager.dispose() frees whatever is
 * hanging off the scene and a cached geometry would come back dead.
 */
export class PlayerRig {
  readonly parts: Record<Detail, BodyParts>;
  readonly limbsL: Record<Detail, LimbSet>;
  private kitMats = new Map<string, THREE.MeshStandardMaterial>();
  private impostorMats = new Map<string, THREE.MeshBasicMaterial>();
  readonly bootMat: THREE.MeshStandardMaterial;
  readonly eyeMat: THREE.MeshStandardMaterial;
  private impostorGeo: THREE.PlaneGeometry;

  constructor(readonly lab: TextureLab, private tod: TimeOfDay) {
    this.parts = { full: buildParts('full'), lod: buildParts('lod') };
    this.limbsL = { full: mirrorLimbs(this.parts.full), lod: mirrorLimbs(this.parts.lod) };
    this.bootMat = new THREE.MeshStandardMaterial({
      color: 0x16181c, roughness: 0.3, metalness: 0.08, vertexColors: true,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: 0x14161a, roughness: 0.25, vertexColors: true,
    });
    this.impostorGeo = new THREE.PlaneGeometry(1.05, 1.9);
  }

  /** Shared per KIT, not per player — this is the texture-swap contract. */
  kitMaterial(kit: KitSpec): THREE.MeshStandardMaterial {
    const key = `${kit.shirt}|${kit.shorts}|${kit.socks}`;
    let m = this.kitMats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        map: this.lab.kitAtlas(kit), roughness: 0.72, vertexColors: true,
      });
      queueBroadcastSkin(m, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.075, rimPower: 3.6 });
      this.kitMats.set(key, m);
    }
    return m;
  }

  impostorMaterial(kit: KitSpec): THREE.MeshBasicMaterial {
    const key = `${kit.shirt}|${kit.shorts}|${kit.socks}`;
    let m = this.impostorMats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        map: this.lab.impostor(kit),
        color: IMPOSTOR_TINT[this.tod],
        transparent: true,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
      });
      this.impostorMats.set(key, m);
    }
    return m;
  }

  newImpostor(kit: KitSpec): THREE.Mesh {
    return new THREE.Mesh(this.impostorGeo, this.impostorMaterial(kit));
  }

  /** Triangles per player at each tier — the §7A.9 budget arithmetic. */
  budget(): { full: number; lod: number; impostor: number } {
    return { full: triangleCount(this.parts.full), lod: triangleCount(this.parts.lod), impostor: 2 };
  }

  dispose(): void {
    disposeParts(this.parts.full);
    disposeParts(this.parts.lod);
    for (const set of [this.limbsL.full, this.limbsL.lod]) {
      for (const g of Object.values(set)) g.dispose();
    }
    for (const m of this.kitMats.values()) m.dispose();
    for (const m of this.impostorMats.values()) m.dispose();
    this.kitMats.clear();
    this.impostorMats.clear();
    this.bootMat.dispose();
    this.eyeMat.dispose();
    this.impostorGeo.dispose();
  }
}

/** One mesh whose geometry swaps between detail levels in place. */
interface LodMesh {
  mesh: THREE.Mesh;
  full: THREE.BufferGeometry;
  lod: THREE.BufferGeometry;
  /** dropped entirely below full detail (eyes, the printed number) */
  nearOnly?: boolean;
  /** keeps casting into the cascades at the mid tier; small parts don't */
  bigShadow?: boolean;
}

export class PlayerMesh {
  root = new THREE.Group();
  private body = new THREE.Group();      // lean/tilt happens here, yaw on root
  private armL!: THREE.Group;
  private armR!: THREE.Group;
  private legL!: THREE.Group;
  private legR!: THREE.Group;
  private head!: THREE.Group;
  private locoPhase = Math.random() * Math.PI * 2;
  private starGlow: THREE.Mesh | null = null;

  private lods: LodMesh[] = [];
  private impostor: THREE.Mesh | null = null;
  /** 0 = full, 1 = decimated, 2 = billboard */
  private tier = -1;
  get lodTier(): number { return this.tier; }
  private ownMats: THREE.Material[] = [];

  constructor(public data: PlayerData, kit: KitSpec, private rig: PlayerRig) {
    const skin = SKIN_TONES[hashStr(data.name) % SKIN_TONES.length];
    const hairC = HAIR_COLORS[hashStr(data.name + 'h') % HAIR_COLORS.length];
    const bald = hashStr(data.name + 'b') % 9 === 0;

    // The only per-player materials in the game. Standard, not Phong: only the
    // physical model has an indirect-specular term, which is what turns
    // scene.environment (§7A.4's PMREM sky) into an actual sheen on a shirt
    // instead of a flat ambient lift.
    const skinMat = new THREE.MeshStandardMaterial({
      color: skin, roughness: 0.62, vertexColors: true,
    });
    const hairMat = new THREE.MeshStandardMaterial({
      color: hairC, roughness: 0.65, vertexColors: true,
    });
    const backMat = new THREE.MeshStandardMaterial({
      map: rig.lab.backNumber(kit, data), roughness: 0.72, vertexColors: true,
    });
    this.ownMats.push(skinMat, hairMat, backMat);

    // §7A.4 broadcast skin/fabric: wrapped diffuse + a weak fresnel rim, on the
    // PLAYERS and nowhere else. Skin wraps further and warmer (that is what
    // subsurface scattering looks like from ten metres); cloth barely wraps at
    // all and keeps its own colour.
    queueBroadcastSkin(backMat, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.075, rimPower: 3.6 });
    queueBroadcastSkin(skinMat, { wrap: 0.42, wrapTint: 0xffbfa0, rim: 0.05, rimPower: 4.0 });

    const kitMat = rig.kitMaterial(kit);
    const P = rig.parts;
    const L = rig.limbsL;

    const add = (parent: THREE.Object3D, full: THREE.BufferGeometry,
      lod: THREE.BufferGeometry, mat: THREE.Material,
      opts: { big?: boolean; nearOnly?: boolean } = {}): THREE.Mesh => {
      const mesh = new THREE.Mesh(full, mat);
      mesh.castShadow = !opts.nearOnly;
      parent.add(mesh);
      this.lods.push({ mesh, full, lod, nearOnly: opts.nearOnly, bigShadow: opts.big });
      return mesh;
    };

    // torso: shirt, collar trim and shorts lofted as ONE piece
    add(this.body, P.full.torso, P.lod.torso, kitMat, { big: true });
    add(this.body, P.full.backPanel, P.lod.backPanel, backMat, { nearOnly: true });

    // head: skull carries the nose and the neck stub
    this.head = new THREE.Group();
    this.head.position.y = 1.72;
    add(this.head, P.full.skull, P.lod.skull, skinMat, { big: true });
    if (!bald) add(this.head, P.full.hair, P.lod.hair, hairMat);
    add(this.head, P.full.eyes, P.lod.eyes, rig.eyeMat, { nearOnly: true });
    this.body.add(this.head);

    const mkArm = (side: number): THREE.Group => {
      const g = new THREE.Group();
      const set = side < 0 ? L : null;
      add(g, set ? set.full.armKit : P.full.armKit,
        set ? set.lod.armKit : P.lod.armKit, kitMat);
      add(g, set ? set.full.armSkin : P.full.armSkin,
        set ? set.lod.armSkin : P.lod.armSkin, skinMat);
      // on the shoulder line, not above it — the deltoid ring in SLEEVE is at
      // local -0.02, which puts it inside the torso's widest ring
      g.position.set(0.295 * side, 1.44, 0);
      g.rotation.z = -0.12 * side;
      this.body.add(g);
      return g;
    };
    this.armL = mkArm(-1);
    this.armR = mkArm(1);

    const mkLeg = (side: number): THREE.Group => {
      const g = new THREE.Group();
      const set = side < 0 ? L : null;
      add(g, set ? set.full.legKit : P.full.legKit,
        set ? set.lod.legKit : P.lod.legKit, kitMat, { big: true });
      add(g, set ? set.full.legSkin : P.full.legSkin,
        set ? set.lod.legSkin : P.lod.legSkin, skinMat, { big: true });
      add(g, set ? set.full.boot : P.full.boot,
        set ? set.lod.boot : P.lod.boot, rig.bootMat);
      g.position.set(0.13 * side, 0.88, 0);
      this.body.add(g);
      return g;
    };
    this.legL = mkLeg(-1);
    this.legR = mkLeg(1);

    this.root.add(this.body);

    // The >60m tier: one card, two triangles, kit colours. It still casts —
    // three copies map and alphaTest onto the depth material, so an
    // alpha-tested billboard throws a player-shaped shadow rather than a
    // rectangle, and a player at 70m with no shadow under him is the one thing
    // that makes an impostor obvious in a still.
    this.impostor = rig.newImpostor(kit);
    this.impostor.position.y = 0.95;
    this.impostor.visible = false;
    this.impostor.castShadow = true;
    this.root.add(this.impostor);

    // star player flair (§4): pulsing gold ring at the feet
    if (data.star) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.72, 24),
        new THREE.MeshBasicMaterial({
          color: 0xffce4a, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      this.root.add(ring);
      this.starGlow = ring;
    }

    this.setTier(0);
  }

  /**
   * Pick the detail tier for this frame (§7A.2). Called from the renderer with
   * the camera that is about to draw — including the capture harness's pinned
   * pose, so a still and the live game agree about what they are drawing.
   */
  updateLOD(camera: THREE.Camera): void {
    const p = this.root.position;
    const c = camera.position;
    const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
    this.setTier(d <= LOD_FULL_M ? 0 : d <= LOD_IMPOSTOR_M ? 1 : 2);
    if (this.tier === 2 && this.impostor) {
      // Billboard on Y only: a card that pitches toward a high camera reads as
      // a sticker lying on the grass. The card is parented to root, which is
      // already yawed to the player's facing — so the world-space angle has to
      // have that yaw taken back out, or the card ends up pointing wherever
      // the player happens to be running and spends half its life edge-on to
      // the camera, i.e. invisible.
      this.impostor.rotation.y = Math.atan2(c.x - p.x, c.z - p.z) - this.root.rotation.y;
    }
  }

  private setTier(tier: number): void {
    if (tier === this.tier) return;
    this.tier = tier;
    const body = tier < 2;
    for (const l of this.lods) {
      l.mesh.visible = body && !(l.nearOnly && tier > 0);
      const want = tier === 0 ? l.full : l.lod;
      if (l.mesh.geometry !== want) l.mesh.geometry = want;
      // the mid tier still casts, but only from the parts that make the
      // silhouette: three cascade passes over twenty-two pairs of forearms is
      // pure cost at 40m and changes nothing on screen
      l.mesh.castShadow = !l.nearOnly && (tier === 0 || !!l.bigShadow);
    }
    this.body.visible = body;
    if (this.impostor) this.impostor.visible = tier === 2;
  }

  /**
   * Drive the pose. speed in m/s, facing = sim angle, anim/animT from the
   * entity. Timing rule (§8): ball leaves foot on the contact frame — kick
   * anims start at the contact and play the follow-through.
   */
  update(dt: number, x: number, y: number, z: number, facing: number, speed: number,
    anim: ActionAnim, animT: number): void {
    this.root.position.set(x, z, y);
    this.root.rotation.y = Math.PI / 2 - facing;

    const runW = Math.min(speed / 7.5, 1.15);
    this.locoPhase += dt * (3.2 + speed * 1.35);
    const swing = Math.sin(this.locoPhase) * (0.28 + runW * 0.75);

    // locomotion baseline
    let legLx = swing, legRx = -swing;
    let armLx = -swing * 0.75, armRx = swing * 0.75;
    let armLz = -0.12, armRz = 0.12;
    let bodyLean = runW * 0.22;
    let bodyRoll = 0;
    let rootY = Math.abs(Math.sin(this.locoPhase)) * 0.05 * runW;
    let headPitch = 0;

    // action overlays
    switch (anim) {
      case 'pass': {
        const t = Math.min(animT / 0.42, 1);
        legRx = -0.5 + Math.sin(t * Math.PI) * 1.3;
        armLx = 0.5; armRx = -0.4;
        break;
      }
      case 'loft':
      case 'shoot': {
        const t = Math.min(animT / 0.42, 1);
        legRx = -0.9 + Math.sin(t * Math.PI) * 1.9;
        bodyLean = 0.1 - t * 0.18;
        armLx = 0.9; armRx = -0.7;
        armLz = -0.5;
        break;
      }
      case 'slide': {
        const t = Math.min(animT / 0.8, 1);
        rootY = -0.62;
        bodyLean = -1.25;
        legLx = -1.5; legRx = -1.35;
        armLx = -0.6; armRx = 1.4;
        void t;
        break;
      }
      case 'diveL':
      case 'diveR': {
        const dir = anim === 'diveR' ? 1 : -1;
        const t = Math.min(animT / 0.5, 1);
        bodyRoll = dir * (0.4 + t * 1.05);
        rootY = -0.4 * t;
        armLx = Math.PI * 0.9; armRx = Math.PI * 0.9; // both arms extended overhead
        armLz = -0.25; armRz = 0.25;
        legLx = 0.3; legRx = -0.3;
        break;
      }
      case 'collect': {
        rootY = -0.35;
        bodyLean = 0.6;
        armLx = 0.9; armRx = 0.9;
        break;
      }
      case 'celebrate': {
        const t = animT;
        armLx = Math.PI * 0.85; armRx = Math.PI * 0.85;
        armLz = -0.4; armRz = 0.4;
        rootY = Math.abs(Math.sin(t * 6)) * 0.28;
        bodyLean = -0.08;
        break;
      }
      case 'dejected': {
        headPitch = 0.55;
        bodyLean = 0.18;
        armLx = 0.15; armRx = 0.15;
        break;
      }
      case 'header':
      case 'none':
      default:
        break;
    }

    // apply with damping so overlays don't pop. Striking actions are over in
    // 0.42s, so their limbs need a much faster time constant or the pose
    // never reaches full extension and the kick reads mushy; locomotion and
    // the vertical bob stay soft.
    const snappy = anim === 'pass' || anim === 'loft' || anim === 'shoot' ||
      anim === 'slide' || anim === 'diveL' || anim === 'diveR';
    const k = 1 - Math.pow(snappy ? 1e-8 : 1e-4, dt);
    const kSlow = 1 - Math.pow(0.0001, dt);
    this.legL.rotation.x += (legLx - this.legL.rotation.x) * k;
    this.legR.rotation.x += (legRx - this.legR.rotation.x) * k;
    this.armL.rotation.x += (armLx - this.armL.rotation.x) * k;
    this.armR.rotation.x += (armRx - this.armR.rotation.x) * k;
    this.armL.rotation.z += (armLz - this.armL.rotation.z) * k;
    this.armR.rotation.z += (armRz - this.armR.rotation.z) * k;
    this.body.rotation.x += (bodyLean - this.body.rotation.x) * k;
    this.body.rotation.z += (bodyRoll - this.body.rotation.z) * k;
    this.body.position.y += (rootY - this.body.position.y) * kSlow;
    this.head.rotation.x += (headPitch - this.head.rotation.x) * k;

    if (this.starGlow) {
      const m = this.starGlow.material as THREE.MeshBasicMaterial;
      m.opacity = 0.35 + Math.abs(Math.sin(performance.now() * 0.004)) * 0.3;
      this.starGlow.rotation.z += dt * 0.8;
    }
  }

  /** Per-player materials only: the rig owns everything that is shared. */
  dispose(): void {
    for (const m of this.ownMats) {
      const map = (m as THREE.MeshStandardMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
    if (this.starGlow) {
      this.starGlow.geometry.dispose();
      (this.starGlow.material as THREE.Material).dispose();
    }
  }
}

/** Build kit specs for both teams, resolving color clashes via away kits. */
export function resolveKits(homeKit: { home: string; away: string }, awayKit: { home: string; away: string }):
  [KitSpec, KitSpec, KitSpec, KitSpec] {
  const clash = colorDist(homeKit.home, awayKit.home) < 130;
  const homeShirt = homeKit.home;
  const awayShirt = clash ? awayKit.away : awayKit.home;
  const mk = (shirt: string): KitSpec => ({
    shirt,
    shorts: luminance(shirt) > 0.55 ? '#20242c' : '#f0f2f5',
    socks: shirt,
    isGK: false,
  });
  const home = mk(homeShirt);
  let away = mk(awayShirt);
  if (colorDist(homeShirt, awayShirt) < 130) {
    away = mk(luminance(homeShirt) > 0.5 ? '#1a2f6b' : '#f0f2f5');
  }
  // keepers get deliberately loud kits — picked per match from a palette so
  // they clash with neither outfield shirt nor each other (a fixed orange
  // keeper next to Holland's outfield orange was unreadable)
  const pickGk = (avoid: string[]): string => {
    let best = GK_PALETTE[0];
    let bestScore = -1;
    for (const c of GK_PALETTE) {
      const s = Math.min(...avoid.map((a) => colorDist(c, a)));
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  };
  const shirtA = pickGk([home.shirt, away.shirt]);
  const shirtB = pickGk([home.shirt, away.shirt, shirtA]);
  const gkA: KitSpec = { shirt: shirtA, shorts: '#20242c', socks: shirtA, isGK: true };
  const gkB: KitSpec = { shirt: shirtB, shorts: '#20242c', socks: shirtB, isGK: true };
  return [home, away, gkA, gkB];
}

const GK_PALETTE = ['#c8e04a', '#e07a3a', '#38c6de', '#df4ad2', '#2d3ce8'];

/** The two resolved outfield shirt colors — what's ACTUALLY worn on the pitch,
 *  for HUD chips/scorelines/confetti to stay consistent with it. */
export function resolvedShirts(
  homeKit: { home: string; away: string }, awayKit: { home: string; away: string },
): [string, string] {
  const [h, a] = resolveKits(homeKit, awayKit);
  return [h.shirt, a.shirt];
}

function colorDist(a: string, b: string): number {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const dr = ((pa >> 16) & 255) - ((pb >> 16) & 255);
  const dg = ((pa >> 8) & 255) - ((pb >> 8) & 255);
  const db = (pa & 255) - (pb & 255);
  return Math.hypot(dr, dg, db);
}
