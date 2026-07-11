// Stadium (§7.1): modeled lower bowl near the pitch, billboard crowd upper
// tier, floodlight pylons that bloom at night, and animated LED ad boards.

import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';

const AD_MESSAGES = [
  'CLAWDE SPORTS', 'ANTHROPIC AIR', "SUPER STRIKER '26", '0 MICROTRANSACTIONS',
  'ONE MORE MATCH', 'CLAWDE SPORTS', 'GOOOOOAL FM 101.2', 'PS3-ERA & PROUD',
];

/** §7.1: three tiers of venue — Mega Bowl 80k / National 45k / Municipal 18k. */
export type StadiumSize = 'municipal' | 'national' | 'mega';

interface TierSpec { rise: number; run: number; y0: number; }

const SIZES: Record<StadiumSize, { tiers: TierSpec[]; roofY: number; lightH: number }> = {
  municipal: {
    tiers: [{ rise: 6, run: 10, y0: 1.2 }],
    roofY: 10.5, lightH: 26,
  },
  national: {
    tiers: [{ rise: 7, run: 11, y0: 1.4 }, { rise: 10, run: 11, y0: 9.6 }],
    roofY: 23.5, lightH: 38,
  },
  mega: {
    tiers: [
      { rise: 7, run: 11, y0: 1.4 },
      { rise: 10, run: 11, y0: 9.6 },
      { rise: 13, run: 12, y0: 20.5 },
    ],
    roofY: 36.5, lightH: 48,
  },
};

export class Stadium {
  private adTextures: THREE.CanvasTexture[] = [];
  private adOffset = 0;
  floodlightHeads: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, night: boolean, public size: StadiumSize = 'national') {
    this.buildBowl(scene, night);
    this.buildFloodlights(scene, night);
    this.buildAdBoards(scene);
  }

  /** Crowd texture: thousands of 2px fan blobs in varied colors, drawn once. */
  private makeCrowdTexture(dark: boolean): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = dark ? '#12151d' : '#1e232d';
    ctx.fillRect(0, 0, c.width, c.height);
    const palette = ['#c8ccd4', '#8a93a8', '#b8563e', '#3e6cb8', '#d4c04a', '#5a9950', '#d8d8e0', '#7a4a7e'];
    // seat rows: fans sit on a grid with jitter, so the stand reads as terraces
    const ROW_H = 8, SEAT_W = 5;
    for (let row = 0; row < c.height / ROW_H; row++) {
      // subtle row shadow line
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, row * ROW_H + ROW_H - 1, c.width, 1.5);
      for (let seat = 0; seat < c.width / SEAT_W; seat++) {
        if (Math.random() < 0.06) continue; // a few empty seats
        const x = seat * SEAT_W + Math.random() * 1.5;
        const y = row * ROW_H + 1 + Math.random() * 1.5;
        // body
        ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
        ctx.globalAlpha = dark ? 0.6 + Math.random() * 0.3 : 0.8 + Math.random() * 0.2;
        ctx.fillRect(x, y + 2, 3.4, 4);
        // head
        ctx.fillStyle = ['#e0b08c', '#c68642', '#8d5524', '#5c3a21'][(Math.random() * 4) | 0];
        ctx.fillRect(x + 0.7, y, 2, 2.2);
      }
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildBowl(scene: THREE.Scene, night: boolean): void {
    const crowdTex = this.makeCrowdTexture(night);
    const crowdMat = new THREE.MeshPhongMaterial({ map: crowdTex });
    const concreteMat = new THREE.MeshPhongMaterial({ color: 0x2e3440 });
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x454e5e, shininess: 30 });

    // one stand per side; built in local space with the pitch toward -z and
    // the tiers rising away toward +z, then rotated into place
    const stands: { len: number; rotY: number; cx: number; cz: number }[] = [
      { len: 130, rotY: 0, cx: 0, cz: HALF_W + 12 },
      { len: 130, rotY: Math.PI, cx: 0, cz: -(HALF_W + 12) },
      { len: 96, rotY: Math.PI / 2, cx: HALF_L + 14, cz: 0 },
      { len: 96, rotY: -Math.PI / 2, cx: -(HALF_L + 14), cz: 0 },
    ];

    const spec = SIZES[this.size];
    for (const s of stands) {
      const stand = new THREE.Group();
      const tiers = spec.tiers;
      let depth = 0;
      for (const t of tiers) {
        const theta = Math.atan2(t.rise, t.run);
        const rakeLen = Math.hypot(t.rise, t.run);
        const m = crowdMat.clone();
        m.map = crowdTex.clone();
        m.map.repeat.set(s.len / 16, rakeLen / 5);
        m.map.needsUpdate = true;
        const rake = new THREE.Mesh(new THREE.PlaneGeometry(s.len, rakeLen), m);
        // normal points up and toward the pitch (-z local)
        rake.rotation.x = -Math.PI / 2 - theta;
        rake.position.set(0, t.y0 + t.rise / 2, depth + t.run / 2);
        stand.add(rake);
        // concrete front wall of the tier
        const wallH = t.y0 + 0.2;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(s.len, wallH, 0.6), concreteMat);
        wall.position.set(0, wallH / 2, depth - 0.3);
        stand.add(wall);
        depth += t.run + 1.2;
      }
      // roof slab over the top tier
      const roof = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.8, 13), roofMat);
      roof.position.set(0, spec.roofY, depth - 7);
      stand.add(roof);
      // back wall
      const back = new THREE.Mesh(new THREE.BoxGeometry(s.len, spec.roofY - 0.5, 1), concreteMat);
      back.position.set(0, (spec.roofY - 0.5) / 2, depth + 0.4);
      stand.add(back);

      stand.position.set(s.cx, 0, s.cz);
      stand.rotation.y = s.rotY;
      scene.add(stand);
    }
  }

  private buildFloodlights(scene: THREE.Scene, night: boolean): void {
    const poleMat = new THREE.MeshPhongMaterial({ color: 0x3a4150 });
    const headMat = new THREE.MeshBasicMaterial({
      color: night ? 0xffffff : 0xd8dde8,
    });
    const h = SIZES[this.size].lightH;
    for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const px = x * (HALF_L + 22);
      const pz = z * (HALF_W + 24);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, h, 8), poleMat);
      pole.position.set(px, h / 2, pz);
      scene.add(pole);
      // bank of lamps angled at the pitch — MeshBasicMaterial so bloom catches it
      const head = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 0.8), headMat);
      head.position.set(px * 0.965, h + 0.5, pz * 0.95);
      head.lookAt(0, 0, 0);
      this.floodlightHeads.push(head);
      scene.add(head);
    }
  }

  private makeAdTexture(text: string): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 48;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 48);
    grad.addColorStop(0, '#0c2b6b');
    grad.addColorStop(1, '#081d49');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 48);
    ctx.font = 'bold 30px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8f0ff';
    ctx.fillText(text, 256, 26);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildAdBoards(scene: THREE.Scene): void {
    // one board segment per message, ringed around the pitch
    const H = 1.0;
    const segments: { x: number; z: number; rotY: number; w: number }[] = [];
    const N_LONG = 8;
    for (let i = 0; i < N_LONG; i++) {
      const w = (HALF_L * 2) / N_LONG;
      const x = -HALF_L + w / 2 + i * w;
      segments.push({ x, z: HALF_W + 3, rotY: Math.PI, w });
      segments.push({ x, z: -(HALF_W + 3), rotY: 0, w });
    }
    for (let i = 0; i < 4; i++) {
      const w = (HALF_W * 2) / 4;
      const z = -HALF_W + w / 2 + i * w;
      segments.push({ x: HALF_L + 3, z, rotY: -Math.PI / 2, w });
      segments.push({ x: -(HALF_L + 3), z, rotY: Math.PI / 2, w });
    }
    segments.forEach((s, i) => {
      const tex = this.makeAdTexture(AD_MESSAGES[i % AD_MESSAGES.length]);
      this.adTextures.push(tex);
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(s.w - 0.4, H), mat);
      board.position.set(s.x, H / 2 + 0.05, s.z);
      board.rotation.y = s.rotY;
      scene.add(board);
    });
  }

  /** LED shimmer: slowly pulse ad brightness so the boards feel alive. */
  update(dt: number): void {
    this.adOffset += dt;
    // cheap: modulate texture offset for a subtle scroll every few seconds
    const phase = (Math.sin(this.adOffset * 0.8) + 1) / 2;
    for (const tex of this.adTextures) {
      tex.offset.x = Math.sin(this.adOffset * 0.15) * 0.01;
    }
    void phase;
  }
}
