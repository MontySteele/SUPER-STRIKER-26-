// Stylized PS3-era players (§7.1): rigid-limb hierarchy (~confidently game-y),
// kit colors + printed back numbers from roster data, code-driven locomotion
// with action overlays. Proportions ~5% broad for couch readability.

import * as THREE from 'three';
import type { PlayerData } from '../data/types';
import type { ActionAnim } from '../sim/player';

const SKIN_TONES = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x5c3a21];
const HAIR_COLORS = [0x151210, 0x2e2018, 0x4a3320, 0x7a5c30, 0xb8963e, 0x101010];

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

function makeBackNumberTexture(kit: string, num: number, name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = kit;
  ctx.fillRect(0, 0, 256, 256);
  // subtle fabric shading
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const lum = luminance(kit);
  ctx.fillStyle = lum > 0.5 ? '#111318' : '#f2f4f8';
  ctx.textAlign = 'center';
  ctx.font = 'bold 36px Helvetica, Arial, sans-serif';
  const short = name.split(' ').pop()?.toUpperCase() ?? '';
  ctx.fillText(short.length > 11 ? short.slice(0, 11) : short, 128, 62);
  ctx.font = 'bold 150px Helvetica, Arial, sans-serif';
  ctx.fillText(String(num), 128, 205);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
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

  constructor(public data: PlayerData, kit: KitSpec) {
    const skin = SKIN_TONES[hashStr(data.name) % SKIN_TONES.length];
    const hairC = HAIR_COLORS[hashStr(data.name + 'h') % HAIR_COLORS.length];
    const bald = hashStr(data.name + 'b') % 9 === 0;

    const shirtMat = new THREE.MeshPhongMaterial({ color: kit.shirt, shininess: 14 });
    const shortsMat = new THREE.MeshPhongMaterial({ color: kit.shorts, shininess: 14 });
    const socksMat = new THREE.MeshPhongMaterial({ color: kit.socks, shininess: 10 });
    const skinMat = new THREE.MeshPhongMaterial({ color: skin, shininess: 22 });
    const hairMat = new THREE.MeshPhongMaterial({ color: hairC, shininess: 30 });
    const bootMat = new THREE.MeshPhongMaterial({ color: 0x16181c, shininess: 45 });

    // torso — back face carries the printed name/number
    const numberTex = makeBackNumberTexture(kit.shirt, data.num, data.name);
    const backMat = new THREE.MeshPhongMaterial({ map: numberTex, shininess: 14 });
    const torsoGeo = new THREE.BoxGeometry(0.52, 0.58, 0.3);
    const torso = new THREE.Mesh(torsoGeo, [shirtMat, shirtMat, shirtMat, shirtMat, shirtMat, backMat]);
    torso.position.y = 1.24;
    torso.castShadow = true;
    this.body.add(torso);

    // pelvis / shorts
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.29), shortsMat);
    pelvis.position.y = 0.86;
    pelvis.castShadow = true;
    this.body.add(pelvis);

    // head + hair + tiny nose for direction reading
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 10), skinMat);
    skull.castShadow = true;
    this.head.add(skull);
    if (!bald) {
      const hair = new THREE.Mesh(
        new THREE.SphereGeometry(0.165, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat,
      );
      hair.position.y = 0.015;
      this.head.add(hair);
    }
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.06), skinMat);
    nose.position.set(0, -0.01, 0.15);
    this.head.add(nose);
    this.head.position.y = 1.72;
    this.body.add(this.head);

    // arms: pivot at shoulders; upper = sleeve, lower = skin
    const mkArm = (side: number): THREE.Group => {
      const g = new THREE.Group();
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.24, 0.13), shirtMat);
      sleeve.position.y = -0.11;
      sleeve.castShadow = true;
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), skinMat);
      fore.position.y = -0.38;
      fore.castShadow = true;
      g.add(sleeve, fore);
      g.position.set(0.33 * side, 1.5, 0);
      g.rotation.z = -0.12 * side;
      this.body.add(g);
      return g;
    };
    this.armL = mkArm(-1);
    this.armR = mkArm(1);

    // legs: pivot at hip; thigh skin, shin sock, boot
    const mkLeg = (side: number): THREE.Group => {
      const g = new THREE.Group();
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, 0.17), skinMat);
      thigh.position.y = -0.2;
      thigh.castShadow = true;
      const shortLeg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.19), shortsMat);
      shortLeg.position.y = -0.06;
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.13), socksMat);
      shin.position.y = -0.6;
      shin.castShadow = true;
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.26), bootMat);
      boot.position.set(0, -0.83, 0.05);
      boot.castShadow = true;
      g.add(shortLeg, thigh, shin, boot);
      g.position.set(0.13 * side, 0.88, 0);
      this.body.add(g);
      return g;
    };
    this.legL = mkLeg(-1);
    this.legR = mkLeg(1);

    this.root.add(this.body);

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

    // apply with light damping so overlays don't pop
    const k = 1 - Math.pow(0.0001, dt);
    this.legL.rotation.x += (legLx - this.legL.rotation.x) * k;
    this.legR.rotation.x += (legRx - this.legR.rotation.x) * k;
    this.armL.rotation.x += (armLx - this.armL.rotation.x) * k;
    this.armR.rotation.x += (armRx - this.armR.rotation.x) * k;
    this.armL.rotation.z += (armLz - this.armL.rotation.z) * k;
    this.armR.rotation.z += (armRz - this.armR.rotation.z) * k;
    this.body.rotation.x += (bodyLean - this.body.rotation.x) * k;
    this.body.rotation.z += (bodyRoll - this.body.rotation.z) * k;
    this.body.position.y += (rootY - this.body.position.y) * k;
    this.head.rotation.x += (headPitch - this.head.rotation.x) * k;

    if (this.starGlow) {
      const m = this.starGlow.material as THREE.MeshBasicMaterial;
      m.opacity = 0.35 + Math.abs(Math.sin(performance.now() * 0.004)) * 0.3;
      this.starGlow.rotation.z += dt * 0.8;
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
  // keepers get deliberately loud kits that clash with nobody
  const gkA: KitSpec = { shirt: '#c8e04a', shorts: '#20242c', socks: '#c8e04a', isGK: true };
  const gkB: KitSpec = { shirt: '#e07a3a', shorts: '#20242c', socks: '#e07a3a', isGK: true };
  const home = mk(homeShirt);
  let away = mk(awayShirt);
  if (colorDist(homeShirt, awayShirt) < 130) {
    away = mk(luminance(homeShirt) > 0.5 ? '#1a2f6b' : '#f0f2f5');
  }
  return [home, away, gkA, gkB];
}

function colorDist(a: string, b: string): number {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const dr = ((pa >> 16) & 255) - ((pb >> 16) & 255);
  const dg = ((pa >> 8) & 255) - ((pb >> 8) & 255);
  const db = (pa & 255) - (pb & 255);
  return Math.hypot(dr, dg, db);
}
