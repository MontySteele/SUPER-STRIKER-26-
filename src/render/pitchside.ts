// Pitch-side dressing (§7A.5c): the band between the ad boards and the stands.
//
// That band is most of the lower third of every gameplay frame, and it used to
// be empty: a dark plane, a 1.6m slab of navy concrete under the front row, and
// nothing standing on either. A real ground is busiest exactly there —
// photographers in a line behind each goal, stewards on chairs facing the
// crowd, ball-kids on stools, camera operators on tripods, the fourth
// official's table, a wall of static sponsor panels under the front row and an
// LED ribbon on the balcony above it. None of it is individually interesting;
// together it is the difference between a stadium and a model of one.
//
// BUDGET. Everything solid here is a unit box pushed into the stadium's one
// structural InstancedMesh (stadium.ts `piece()`), and every person is a seat
// in the crowd's one bench InstancedMesh (Crowd.seatBench), so ~150 people and
// ~700 boxes add ZERO draw calls. Two things cannot join those meshes and pay
// one call each: the LED ribbon (unlit, scrolling, overbright at night) and the
// camera carpets beside the goals (lit and shadowed, they lie on the turf).
//
// Scene coordinates throughout: x along the pitch, z across it, the tele
// camera on +z looking at the -z (tunnel) touchline.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RNG } from '../core/rng';
import { GOAL_HALF_W, HALF_L, HALF_W } from '../sim/constants';
import { maxAnisotropy } from './materials';

/**
 * `?pitchside=0` turns the whole band off — the extended run-off plane, the
 * dressing, the ribbon, the carpets and the wall signage — for an A/B in
 * `npm run app:bench -- --query pitchside=0`. The turf shading and the net
 * are not behind it (they replace, rather than add to, what was there).
 */
export function pitchsideEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get('pitchside') !== '0';
  } catch {
    return true;
  }
}

/** A seat for Crowd.seatBench — the same shape the dugouts use. `y` is the
 *  FLOOR under the figure: the crowd mesh is modelled standing on its origin
 *  and folds its lap to 0.46m when seated, so a 0.44m chair at y = 0 is
 *  sat on, and when the ground's energy stands everybody up their feet are on
 *  the turf rather than floating a chair's height above it. */
export interface BenchSpot {
  x: number; y: number; z: number; rotY: number; alle: number; shirt: THREE.Color;
}

/** What the dressing writes into: the stadium's accumulators. */
export interface PitchsideSink {
  /** One lit unit box, world space, optional yaw. `shade` bakes the ambient
   *  occlusion the structural mesh cannot receive. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number,
    hex: number, shade?: number, rotY?: number, tilt?: THREE.Quaternion): void;
  /** One unlit (lamp) box: screens and LED boards. */
  glow(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color): void;
  people: BenchSpot[];
}

/** Where the boards are (stadium.ts buildAdBoards) and the stand fronts are. */
const BOARD = 3;
const STAND_Z = HALF_W + 12;
const STAND_X = HALF_L + 14;
/** Where the tunnel and dugouts stand, so nobody sits in them. */
const DUGOUT_X = 14.5;
const DUGOUT_HALF = 4.95;

/** Yaw that turns a seated figure (which faces -z) to face (dx, dz). */
const facing = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

const HIVIS = [0xd8e03a, 0xf07a1a, 0xc9d82c];
const DARK_CLOTHES = [0x1b1f28, 0x262b35, 0x1f2a3d, 0x30343c, 0x3a3226];

/**
 * Every person and prop in the band. `lit` is floodlightsLit(): the LED
 * screens on the fourth official's table get pushed overbright with the rest
 * of the rig, exactly as the boards do.
 */
export function dressPitchside(sink: PitchsideSink, rng: RNG, lit: boolean, hdr: boolean): void {
  const col = (hex: number): THREE.Color => new THREE.Color(hex);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng.next() * a.length) % a.length];

  // ---------------------------------------------------------- photographers
  // Two ranks either side of each goal, sitting on low stools behind the end
  // boards and looking up the pitch, with the long white lenses that are the
  // single most recognisable silhouette at a football ground.
  for (const sx of [-1, 1]) {
    const x0 = sx * (HALF_L + BOARD + 0.9);
    for (const sz of [-1, 1]) {
      for (let z = GOAL_HALF_W + 2.6; z < HALF_W - 4; z += 1.2 + rng.range(-0.15, 0.35)) {
        if (rng.next() < 0.18) continue;           // gaps: not every pitch is sold
        const x = x0 + sx * rng.range(-0.15, 0.35);
        const zz = sz * z;
        const bib = rng.next() < 0.55;
        sink.people.push({
          x, y: 0, z: zz, rotY: facing(-sx, 0), alle: 0.5,
          shirt: col(bib ? pick([0xe46a2a, 0x3f9a4a, 0xd4d64a]) : pick(DARK_CLOTHES))
            .offsetHSL(0, 0, rng.range(-0.04, 0.03)),
        });
        // the stool
        sink.box(x + sx * 0.08, 0.21, zz, 0.34, 0.42, 0.34, 0x2a2e36, 0.7);
        // camera body + long lens + the monopod it rests on
        const lensWhite = rng.next() < 0.7;
        sink.box(x - sx * 0.34, 1.02, zz + rng.range(-0.05, 0.05), 0.16, 0.17, 0.14, 0x121418, 1.0);
        sink.box(x - sx * 0.66, 1.03, zz, 0.46, 0.12, 0.12, lensWhite ? 0xe9e6dc : 0x1a1c20, 1.0);
        sink.box(x - sx * 0.62, 0.48, zz, 0.035, 0.96, 0.035, 0x202226, 0.8);
        // a kit bag, and every other one a second body on the ground
        if (rng.next() < 0.6) {
          sink.box(x + sx * 0.1, 0.12, zz + sz * 0.5, 0.42, 0.24, 0.3,
            pick([0x15171c, 0x2b2f38, 0x3b2a22]), 0.75);
        }
      }
    }
  }

  // ---------------------------------------------------------------- stewards
  // On chairs at the foot of every stand, FACING THE CROWD, in hi-vis. From
  // the gantry they are a dotted line of yellow along the bottom of the
  // stand, which is exactly how they read on television.
  const steward = (x: number, z: number, dx: number, dz: number): void => {
    sink.people.push({
      x, y: 0, z, rotY: facing(dx, dz), alle: 0.5,
      shirt: col(pick(HIVIS)).offsetHSL(0, 0, rng.range(-0.05, 0.02)),
    });
    sink.box(x - dx * 0.05, 0.22, z - dz * 0.05, 0.44, 0.44, 0.44, 0x33373f, 0.75);
  };
  for (const sz of [-1, 1]) {
    for (let x = -HALF_L + 4; x <= HALF_L - 4; x += 8.5 + rng.range(-1, 1.5)) {
      if (sz < 0 && Math.abs(x) < 5) continue;        // the tunnel mouth
      steward(x, sz * (STAND_Z - 1.35), 0, sz);
    }
  }
  for (const sx of [-1, 1]) {
    for (let z = -HALF_W + 3; z <= HALF_W - 3; z += 8 + rng.range(-1, 1.5)) {
      steward(sx * (STAND_X - 1.35), z, sx, 0);
    }
  }

  // --------------------------------------------------------------- ball-kids
  // Stool, tracksuit, and a spare ball at their feet.
  const kid = (x: number, z: number, dx: number, dz: number): void => {
    sink.people.push({
      x, y: 0, z, rotY: facing(dx, dz), alle: 0.5,
      shirt: col(0x2b7fd0).offsetHSL(rng.range(-0.01, 0.01), 0, rng.range(-0.04, 0.04)),
    });
    sink.box(x - dx * 0.06, 0.18, z - dz * 0.06, 0.34, 0.36, 0.34, 0x22262d, 0.7);
    sink.box(x + dx * 0.35 + dz * 0.3, 0.11, z + dz * 0.35 - dx * 0.3, 0.22, 0.22, 0.22, 0xe6e8ea, 0.95);
  };
  for (const sz of [-1, 1]) {
    for (const x of [-38, -22, 22, 38]) kid(x, sz * (HALF_W + BOARD + 0.9), 0, -sz);
  }
  for (const sx of [-1, 1]) {
    for (const z of [-30.5, 30.5]) kid(sx * (HALF_L + BOARD + 0.9), z, -sx, 0);
  }

  // -------------------------------------------------------- camera platforms
  // Broadcast cameras on tripods with an operator on a stool: the 18-yard
  // line positions on both touchlines and one behind each goal. The far-side
  // pair are the ones the tele camera sees all match.
  const tvCam = (x: number, z: number, dx: number, dz: number): void => {
    const yaw = Math.atan2(dx, dz);
    const q = new THREE.Quaternion();
    // three splayed legs
    for (let k = 0; k < 3; k++) {
      const a = yaw + (k / 3) * Math.PI * 2 + Math.PI / 3;
      const lx = Math.sin(a) * 0.32, lz = Math.cos(a) * 0.32;
      q.setFromEuler(new THREE.Euler(-Math.cos(a) * 0.22, 0, Math.sin(a) * 0.22));
      sink.box(x + lx, 0.66, z + lz, 0.04, 1.36, 0.04, 0x2a2d33, 0.85, 0, q);
    }
    sink.box(x, 1.36, z, 0.26, 0.1, 0.26, 0x1d1f24, 0.9);                     // head
    sink.box(x - dx * 0.04, 1.58, z - dz * 0.04, 0.34, 0.34, 0.34, 0x202329, 1.0, yaw); // body
    sink.box(x + dx * 0.34, 1.58, z + dz * 0.34, 0.2, 0.2, 0.36, 0x0f1013, 1.0, yaw);   // lens
    sink.box(x + dx * 0.54, 1.58, z + dz * 0.54, 0.26, 0.24, 0.04, 0x0b0c0e, 1.0, yaw); // hood
    sink.box(x - dx * 0.22 + dz * 0.2, 1.72, z - dz * 0.22 - dx * 0.2, 0.14, 0.12, 0.16,
      0x15171b, 1.0, yaw);                                                        // viewfinder
    // the operator, behind it, on a stool
    const ox = x - dx * 0.8, oz = z - dz * 0.8;
    sink.people.push({
      x: ox, y: 0.02, z: oz, rotY: facing(dx, dz), alle: 0.5,
      shirt: col(pick(DARK_CLOTHES)),
    });
    sink.box(ox - dx * 0.06, 0.23, oz - dz * 0.06, 0.36, 0.46, 0.36, 0x2b2f37, 0.7);
  };
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) tvCam(sx * (HALF_L - 16.5), sz * (HALF_W + BOARD + 1.3), 0, -sz);
  }
  for (const sx of [-1, 1]) tvCam(sx * (HALF_L + BOARD + 2.4), sx * 4.6, -sx, 0);

  // ---------------------------------------------------------- fourth official
  // Between the dugouts, beside the tunnel: a table, the fourth official and
  // the reserve assistant in black, a monitor, and the substitution board
  // lying on the table with its LEDs lit.
  const tz = -(HALF_W + BOARD + 1.4);
  sink.box(4.2, 0.37, tz, 1.6, 0.74, 0.62, 0x1c2029, 0.8);
  sink.box(4.2, 0.745, tz, 1.7, 0.03, 0.7, 0xb8bec8, 0.9);
  sink.box(3.8, 0.93, tz - 0.1, 0.46, 0.32, 0.05, 0x0d0f12, 1.0);
  const screen = new THREE.Color();
  const k = lit ? (hdr ? 1.6 : 1.0) : 0.85;
  screen.setRGB(0.35 * k, 0.55 * k, 0.9 * k, THREE.LinearSRGBColorSpace);
  sink.glow(3.8, 0.93, tz - 0.07, 0.4, 0.26, 0.02, screen);
  // the board: red OUT, green IN
  sink.box(4.75, 0.8, tz, 0.62, 0.06, 0.42, 0x111316, 1.0);
  sink.glow(4.6, 0.835, tz, 0.26, 0.01, 0.3, new THREE.Color().setRGB(1.3 * k, 0.12 * k, 0.1 * k,
    THREE.LinearSRGBColorSpace));
  sink.glow(4.9, 0.835, tz, 0.26, 0.01, 0.3, new THREE.Color().setRGB(0.12 * k, 1.2 * k, 0.2 * k,
    THREE.LinearSRGBColorSpace));
  for (const ox of [3.7, 4.8]) {
    sink.people.push({ x: ox, y: 0, z: tz - 0.62, rotY: facing(0, 1), alle: 0.5, shirt: col(0x101216) });
    sink.box(ox, 0.22, tz - 0.66, 0.44, 0.44, 0.44, 0x2a2e36, 0.75);
  }

  // --------------------------------------------- medics and the stretcher
  // A small group at the far corner flag nearest the tunnel end: two
  // paramedics in green on a bench, the stretcher on the grass beside them.
  for (const sx of [-1, 1]) {
    const bx = sx * (HALF_L - 4), bz = -(HALF_W + BOARD + 1.2);
    sink.box(bx, 0.23, bz - 0.1, 1.9, 0.46, 0.4, 0x3a3f49, 0.8);
    for (const ox of [-0.5, 0.5]) {
      sink.people.push({ x: bx + ox, y: 0, z: bz, rotY: facing(0, 1), alle: 0.5,
        shirt: col(0x3c9a4e).offsetHSL(0, 0, rng.range(-0.04, 0.04)) });
    }
    sink.box(bx + sx * 2.2, 0.08, bz + 0.1, 2.0, 0.08, 0.58, 0xc9ccd2, 0.9);
    sink.box(bx + sx * 2.2, 0.13, bz + 0.1, 1.9, 0.04, 0.5, 0xd24a36, 0.9);
  }

  // ----------------------------------------------------- warm-up area kit
  // Cones and bibs in the corner behind the dugouts where the subs warm up.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const cx = sx * (DUGOUT_X + DUGOUT_HALF + 4 + i * 1.6);
      sink.box(cx, 0.1, -(HALF_W + BOARD + 2.3), 0.16, 0.2, 0.16,
        i % 2 ? 0xf0a020 : 0xe8ecef, 0.95, Math.PI / 4);
    }
  }
}

/**
 * The ad boards were single planes: seen from anywhere but dead ahead they
 * were a sheet of paper standing on the grass. Each segment gets a housing
 * behind its screen, a top cap and two A-frame struts, into the structural
 * mesh. `segments` is exactly what stadium.ts lays the screens out with.
 */
export function boardHousings(sink: PitchsideSink,
  segments: { x: number; z: number; rotY: number; w: number }[], H: number): void {
  for (const s of segments) {
    // the screen faces local +z; "behind" is local -z
    const bx = -Math.sin(s.rotY), bz = -Math.cos(s.rotY);
    const w = s.w - 0.34;
    sink.box(s.x + bx * 0.09, H / 2 + 0.03, s.z + bz * 0.09, w, H + 0.1, 0.16, 0x1b1e25, 0.9, s.rotY);
    sink.box(s.x + bx * 0.07, H + 0.1, s.z + bz * 0.07, w, 0.05, 0.22, 0x2f343e, 1.0, s.rotY);
    const ax = Math.cos(s.rotY), az = -Math.sin(s.rotY);
    for (const e of [-0.42, 0.42]) {
      const px = s.x + ax * e * w, pz = s.z + az * e * w;
      sink.box(px + bx * 0.45, 0.42, pz + bz * 0.45, 0.06, 0.06, 0.95, 0x2a2e36, 0.7,
        s.rotY, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.95, s.rotY, 0, 'YXZ')));
    }
  }
}

// ----------------------------------------------------------------- canvases

const SPONSORS: [string, string, string][] = [
  // text, background, ink
  ['CLAWDE SPORTS', '#c8102e', '#ffffff'],
  ['VERTEX MUTUAL', '#f2f2f0', '#10224a'],
  ['MULBERRY32', '#111317', '#f2c230'],
  ['TOUCHLINE TYRES', '#f4c21a', '#111317'],
  ['ANTHROPIC AIR', '#0b2f6b', '#ffffff'],
  ['GOOOOOAL FM', '#1d7a3c', '#ffffff'],
  ['ONE MORE MATCH', '#e8e8e8', '#b0101e'],
  ['DEEP LYING', '#23262e', '#7fd0ff'],
];

function fitText(ctx: CanvasRenderingContext2D, text: string, room: number, size: number): void {
  ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
  const w = ctx.measureText(text).width;
  if (w > room) ctx.font = `bold ${Math.max(10, Math.floor(size * room / w))}px Helvetica, Arial, sans-serif`;
}

/**
 * The perimeter wall under the front row: static sponsor panels in a band
 * across the top, a dark kick-plate under them. One tile is 16m of wall; the
 * stadium clones the texture per wall so each repeats at its own length.
 */
export function perimeterWallTexture(): THREE.CanvasTexture {
  const W = 1024, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2c313b';
  ctx.fillRect(0, 0, W, H);
  // weathering on the kick plate
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.05 + (i % 7) * 0.012})`;
    ctx.fillRect((i * 173) % W, H * 0.62 + ((i * 37) % 40), 30 + (i % 5) * 20, 3);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const n = 4;
  const pw = W / n;
  for (let i = 0; i < n; i++) {
    const [text, bg, ink] = SPONSORS[(i * 3 + 1) % SPONSORS.length];
    ctx.fillStyle = bg;
    ctx.fillRect(i * pw + 3, 6, pw - 6, H * 0.52);
    ctx.fillStyle = ink;
    fitText(ctx, text, pw * 0.84, 34);
    ctx.fillText(text, i * pw + pw / 2, 6 + H * 0.26);
  }
  // capping strip along the top edge
  ctx.fillStyle = '#9aa2af';
  ctx.fillRect(0, 0, W, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy();
  return tex;
}

/** The LED ribbon's strip: every sponsor on its own colour, with the dot
 *  matrix across it. One tile covers RIBBON_TILE_M of fascia. */
function ribbonTexture(): THREE.CanvasTexture {
  const W = 2048, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const n = SPONSORS.length;
  const pw = W / n;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const [text, bg, ink] = SPONSORS[i];
    ctx.fillStyle = bg;
    ctx.fillRect(i * pw, 0, pw, H);
    ctx.fillStyle = ink;
    fitText(ctx, text, pw * 0.86, 40);
    ctx.fillText(text, i * pw + pw / 2, H / 2 + 1);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  for (let x = 0; x < W; x += 3) ctx.fillRect(x, 0, 1, H);
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy();
  return tex;
}

const RIBBON_TILE_M = 48;

/**
 * The LED ribbon along the balcony of the upper tier: one merged mesh over
 * every stand, one scrolling texture, one draw call. `spans` are world-space
 * frames, each placing a len x h strip whose face looks down local -z.
 */
export class LedRibbon {
  readonly mesh: THREE.Mesh;
  private tex: THREE.CanvasTexture;

  constructor(scene: THREE.Scene, spans: { frame: THREE.Matrix4; len: number; h: number }[],
    lit: boolean, hdr: boolean) {
    this.tex = ribbonTexture();
    const parts = spans.map((s) => {
      const g = new THREE.PlaneGeometry(s.len, s.h);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (s.len / RIBBON_TILE_M));
      g.rotateY(Math.PI);          // face the pitch (local -z)
      g.applyMatrix4(s.frame);
      return g;
    });
    const geo = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, fog: true });
    // same rule as the boards: at night an LED is a light source
    if (lit && hdr) mat.color.setRGB(1.55, 1.55, 1.6, THREE.LinearSRGBColorSpace);
    else mat.color.setRGB(0.92, 0.92, 0.92, THREE.LinearSRGBColorSpace);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);
  }

  update(clock: number): void {
    // a slow crawl, stepped to whole LED columns so it does not swim
    const px = Math.floor(clock * 60) / 2048;
    this.tex.offset.x = px % 1;
  }
}

/**
 * The "3D" camera carpets beside each goal: printed turf mats behind the goal
 * line, outside the posts. Lit and shadowed (they are part of the ground),
 * merged into one mesh over a two-message atlas.
 */
export function buildCarpets(scene: THREE.Scene): THREE.Mesh {
  const W = 1024, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rows: [string, string, string][] = [
    ['CLAWDE SPORTS', '#b50e28', '#ffffff'],
    ["SUPER STRIKER '26", '#0e2a66', '#ffffff'],
  ];
  rows.forEach(([text, bg, ink], r) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, r * H / 2, W, H / 2);
    ctx.fillStyle = ink;
    fitText(ctx, text, W * 0.9, 96);
    ctx.fillText(text, W / 2, r * H / 2 + H / 4 + 4);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy();

  const LEN = 5.2, DEP = 1.9;
  const parts: THREE.BufferGeometry[] = [];
  let r = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.PlaneGeometry(LEN, DEP);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) + r) / 2);
      r = 1 - r;
      // text reads from the pitch looking outward: local x -> world (0,0,sx),
      // local y (text up) -> outward (sx,0,0), normal -> +y
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 0, sx), new THREE.Vector3(sx, 0, 0), new THREE.Vector3(0, 1, 0));
      m.setPosition(sx * (HALF_L + 1.45), 0.012, sz * (GOAL_HALF_W + 1.0 + LEN / 2));
      g.applyMatrix4(m);
      parts.push(g);
    }
  }
  const geo = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshLambertMaterial({
    map: tex,
    // a printed mat, a little duller than a board
    color: 0xd8d8d8,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);
  return mesh;
}
