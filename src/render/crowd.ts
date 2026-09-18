// The 3D crowd (§7.1 "Stadiums", §7A.5).
//
// The billboard rakes were the right call for the back of a Mega Bowl and the
// wrong one for the tier your camera is pointed at all match. A card is a
// photograph: it has no silhouette, it cannot put its arms up, and the moment
// the touchline cam drops to knee height the front row reads as wallpaper.
//
// So the tier nearest the pitch is now made of PEOPLE. One 116-triangle figure
// — two legs, torso, head, two arms and a scarf that only exists when it is
// held overhead — instanced once per stand, with everything that makes a crowd
// a crowd done on the GPU:
//
// v1.4 rebuilt that figure. The v1.3 one was six boxes, and six boxes is a
// silhouette no resolution can save: a cube head, a slab chest and two
// rectangles for arms read as a coloured box at every distance a broadcast
// camera uses. The parts are swept tubes now — a domed head with a jaw and a
// crown, a six-sided torso widest at the shoulders, two tapered legs with
// daylight between them — which is 1.8x the triangles for TWO THIRDS of the
// vertices, because a ring shares its vertices and a box does not. Vertices,
// not triangles, are what a 3,500-instance crowd actually pays for, so the
// figure got better AND cheaper on the axis that binds. On top of that: baked
// per-vertex occlusion so a figure has depth in its own rows, a club accent
// per instance (a scarf at the collar, a hat) kept separate from the coat, and
// a permanent low-amplitude idle so a quiet stand never freezes solid.
//
//   • per-instance phase, so no two fans are on the same beat;
//   • per-instance allegiance, so the home end can erupt while the away end
//     puts its head in its hands;
//   • per-instance seated flag, so a lull is a seated crowd and a shot on goal
//     gets them out of their seats;
//   • a per-instance coordinate around the bowl, which is all a Mexican wave
//     needs to be a travelling window rather than a JS loop over 3,500 people.
//
// Nothing here ever touches an instance buffer after build. Every reaction in
// the match is eight floats of uniform, which is why a goal costs the same as
// an empty midfield.
//
// Lighting is hand-rolled per-vertex hemisphere+key in the vertex shader, NOT
// a lit material. Two reasons: a lit material must be registered with the CSM
// rig or it takes the sun once per cascade (§7A.4), and 3,500 instances of a
// shadow-casting standard material is exactly the frame the §8 budget forbids.
// A fan under a roof is ambient-dominated anyway — the per-vertex term is
// indistinguishable at the range a stand is ever seen from, for nothing.
//
// Determinism (§7A.3): every placement draw comes from TextureLab's seeded
// dressing stream. No Math.random, ever.

import * as THREE from 'three';
import type { RNG } from '../core/rng';
import { applyShaderPatches, queueShaderPatch } from './materials';
import type { QualityLevel } from './quality';
import type { TimeOfDay } from './scene';

// ---------------------------------------------------------------- geometry

/** Which body part a vertex belongs to. Read by the vertex shader for both
 *  the pose maths and the colour, so these are a contract with the GLSL. */
const PART_TORSO = 0;
const PART_HEAD = 1;
const PART_LEGS = 2;
const PART_ARM_L = 3;
const PART_ARM_R = 4;
const PART_SCARF = 5;

/** Shoulder pivot, in the figure's local metres. Mirrored by the shader. */
const SHOULDER_X = 0.242;
const SHOULDER_Y = 1.40;
/** How far the whole upper body drops when a fan is sitting down. */
const SIT_DROP = 0.36;

/**
 * One cross-section of a body part. Parts are SWEPT TUBES now rather than
 * boxes, and that is the whole trick of the v1.4 figure: a ring costs `sides`
 * vertices and buys `sides` quads of silhouette, where a box spends four
 * vertices per face and buys a corner.
 */
interface Ring {
  y: number;
  /** half-width along x and half-depth along z — an ellipse, not a circle */
  rx: number; rz: number;
  /** lateral offset of the whole ring (the two legs, the two arms) */
  cx?: number;
  /** baked ambient occlusion. 1 = open to the sky, 0.4 = buried in the row */
  ao: number;
}

interface TubeOpts {
  sides: number;
  /** angular offset in radians. 0 puts a FACE toward +z on an even side count,
   *  which is what gives the torso a flat chest and rounded flanks. */
  phase?: number;
  /** collapse the top into one point at this y — the crown of a head */
  apexTop?: number;
  apexAO?: number;
  /** flat polygon caps, fanned off vertex 0, so `sides - 2` triangles */
  capTop?: boolean;
  capBottom?: boolean;
}

/**
 * Sweep a closed profile and append it to the growing arrays. Vertices are
 * SHARED around the ring and between rings, which is what pays for the extra
 * silhouette: the v1.3 box fan was 62 triangles across 148 vertices, this one
 * is 116 triangles across 103. Nearly twice the triangles for two thirds of the
 * vertex shader invocations — and the vertex shader is where a crowd costs.
 */
function pushTube(
  pos: number[], nrm: number[], part: number[], occ: number[], idx: number[],
  rings: Ring[], id: number, o: TubeOpts,
): void {
  const sides = o.sides;
  const phase = o.phase ?? 0;
  const base = pos.length / 3;
  const n = rings.length;
  // the apex counts as a zero-radius ring purely so the last real ring's
  // normal knows to lean in toward it
  const prof = rings.map((r) => ({ y: r.y, r: (r.rx + r.rz) * 0.5 }));
  if (o.apexTop !== undefined) prof.push({ y: o.apexTop, r: 0 });

  for (let i = 0; i < n; i++) {
    const r = rings[i];
    const a = prof[Math.max(0, i - 1)], b = prof[Math.min(prof.length - 1, i + 1)];
    const dr = b.r - a.r, dy = b.y - a.y;
    const pl = Math.hypot(dr, dy) || 1;
    // in the (radius, y) plane the outward normal of the profile is (dy, -dr)
    const nr = dy / pl, ny = -dr / pl;
    for (let s = 0; s < sides; s++) {
      const ang = phase + (s / sides) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      pos.push((r.cx ?? 0) + ca * r.rx, r.y, sa * r.rz);
      // The outward normal of an ELLIPSE is the gradient (cos/rx, sin/rz), not
      // the radius direction. Get that wrong on a 0.25 x 0.13 torso and the
      // chest lights like a cylinder — every fan in the stand with the same
      // bright band down the middle, which is exactly the "it's a texture"
      // tell the whole file is trying to avoid.
      let hx = ca / Math.max(1e-4, r.rx), hz = sa / Math.max(1e-4, r.rz);
      const hl = Math.hypot(hx, hz) || 1;
      hx /= hl; hz /= hl;
      const vx = hx * nr, vz = hz * nr;
      const vl = Math.hypot(vx, ny, vz) || 1;
      nrm.push(vx / vl, ny / vl, vz / vl);
      part.push(id);
      occ.push(r.ao);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a0 = base + i * sides + s, a1 = base + i * sides + s2;
      const b0 = base + (i + 1) * sides + s, b1 = base + (i + 1) * sides + s2;
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }
  const top = base + (n - 1) * sides;
  if (o.apexTop !== undefined) {
    const apex = pos.length / 3;
    pos.push(0, o.apexTop, 0);
    nrm.push(0, 1, 0);
    part.push(id);
    occ.push(o.apexAO ?? rings[n - 1].ao);
    for (let s = 0; s < sides; s++) idx.push(apex, top + ((s + 1) % sides), top + s);
  } else if (o.capTop) {
    pushCap(pos, nrm, part, occ, idx, rings[n - 1], sides, phase, id, 1);
  }
  if (o.capBottom) {
    pushCap(pos, nrm, part, occ, idx, rings[0], sides, phase, id, -1);
  }
}

/**
 * A flat polygon lid on a ring. It gets its OWN vertices rather than reusing
 * the ring's: the side wall's normals point outward and, on a flaring profile,
 * slightly DOWN, so a cap that borrows them shades its top surface as if it
 * were facing the floor. On the torso that surface is the shoulders, which
 * under a floodlight rig pointing almost straight down is the brightest thing
 * on a fan — borrowing the wall's normals there put the whole night crowd's
 * shoulders in shadow. `sides - 2` triangles, fanned off vertex 0.
 */
function pushCap(
  pos: number[], nrm: number[], part: number[], occ: number[], idx: number[],
  r: Ring, sides: number, phase: number, id: number, dir: 1 | -1,
): void {
  const base = pos.length / 3;
  for (let s = 0; s < sides; s++) {
    const ang = phase + (s / sides) * Math.PI * 2;
    pos.push((r.cx ?? 0) + Math.cos(ang) * r.rx, r.y, Math.sin(ang) * r.rz);
    nrm.push(0, dir, 0);
    part.push(id);
    occ.push(r.ao);
  }
  for (let s = 1; s < sides - 1; s++) {
    if (dir > 0) idx.push(base, base + s + 1, base + s);
    else idx.push(base, base + s, base + s + 1);
  }
}

/** The held-up scarf: a four-column strip, so the shader has something to flap. */
function pushScarf(
  pos: number[], nrm: number[], part: number[], occ: number[], idx: number[],
): void {
  const COLS = 3, W = 1.04, H = 0.19, Z = 0.13;
  const base = pos.length / 3;
  for (let c = 0; c <= COLS; c++) {
    const x = -W / 2 + (W * c) / COLS;
    for (const sv of [-1, 1]) {
      pos.push(x, SHOULDER_Y + sv * H / 2, Z);
      nrm.push(0, 0, 1);
      part.push(PART_SCARF);
      occ.push(1.06);
    }
  }
  for (let c = 0; c < COLS; c++) {
    const a = base + c * 2, b = a + 1, d = a + 2, e = a + 3;
    idx.push(a, d, e, a, e, b);
  }
}

/**
 * The fan. 116 triangles across 103 vertices, origin between the feet, facing
 * +z (i.e. toward the pitch once the instance is turned round).
 *
 * v1.4: the boxes are gone. What the owner saw from a broadcast camera was not
 * low resolution, it was six cuboids — a slab chest, a cube head and two
 * rectangles for arms, which is a silhouette no number of pixels can rescue.
 * So: an eight-sided head that domes into a crown, a six-sided torso widest at
 * the shoulders and tapered to the hips, TWO tapered legs with daylight between
 * them, and arms that thin toward the wrist. The gap between the ankles is
 * worth more at 15 m than anything that happens above the waist.
 *
 * Every part id, both shoulder pivots and the y/z span the seated-lap morph
 * folds are unchanged, so the pose GLSL below — the arm raise, the sit, the
 * Mexican wave — is untouched contract.
 */
export function buildFanGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], part: number[] = [],
    occ: number[] = [], idx: number[] = [];

  // Legs: two of them, spanning y 0..0.84 and z ±0.10 — the span the shader's
  // seated-lap morph folds, so sitting down still works unchanged. No sole cap:
  // the only camera that could see one is under the terrace.
  for (const sx of [-1, 1]) {
    pushTube(pos, nrm, part, occ, idx, [
      { y: 0.00, rx: 0.083, rz: 0.101, cx: sx * 0.090, ao: 0.58 },
      { y: 0.84, rx: 0.112, rz: 0.127, cx: sx * 0.090, ao: 0.80 },
    ], PART_LEGS, { sides: 4, phase: Math.PI / 4 });
  }

  // Torso: six-sided, flat chest and back. 0.46 m across the coat and 0.65 m
  // across the shoulders once the sleeves are on, which is ~85% of the 0.80 m
  // seat pitch — a sold-out stand is a near-continuous wall of shoulders, and
  // an anatomically slim figure left it reading half empty with terrace showing
  // between every fan. The RIBCAGE is still narrower than the shoulder line and
  // the ARMS still make up the rest, because that is what gives a sleeve a
  // silhouette to be seen against.
  //
  // The hem is at 0.62, well below the crotch, so the coat — not two separate
  // legs — is what the eye reads down to mid-thigh. Standing that closes the
  // daylight between the legs; seated (upper body drops 0.36, the lap lands at
  // ~0.46) the hem at 0.26 still covers the join.
  //
  // Four rings: the widest is the shoulder line at 1.31 and the one above it
  // pulls back in toward the neck, so the shoulders slope. That top ring also
  // gives the shader's scarf band one 9 cm strip to land in, instead of a
  // gradient half way down the chest that read as a printed card.
  pushTube(pos, nrm, part, occ, idx, [
    { y: 0.620, rx: 0.196, rz: 0.140, ao: 0.70 },
    { y: 1.060, rx: 0.212, rz: 0.152, ao: 0.86 },
    { y: 1.300, rx: 0.232, rz: 0.158, ao: 0.96 },
    // the collar sits ABOVE the arm pivot: a top ring level with the shoulders
    // left 7 cm of bare neck standing out of the coat on every fan in the
    // ground, which from the front row is a stand full of tortoises
    { y: 1.425, rx: 0.174, rz: 0.130, ao: 1.00 },
  ], PART_TORSO, { sides: 6, capTop: true, capBottom: true });

  // Head: neck, jaw, crown, dome. Two rings gave a cone — a party hat on a
  // rectangle — because a neck straight to a point IS a cone. The crown ring
  // pulling back in above the jaw is the whole difference between a head and a
  // traffic bollard, and it costs six triangles.
  pushTube(pos, nrm, part, occ, idx, [
    { y: 1.360, rx: 0.056, rz: 0.054, ao: 0.76 },
    { y: 1.450, rx: 0.098, rz: 0.094, ao: 0.98 },
    { y: 1.548, rx: 0.090, rz: 0.088, ao: 1.04 },
  ], PART_HEAD, { sides: 6, apexTop: 1.596, apexAO: 1.08 });

  // Arms: tapered to the wrist, grazing the torso all the way down and standing
  // 7 cm proud of it, which is the whole shoulder line. The AO is a good deal
  // darker than the chest's on purpose — an arm hanging against a body is in
  // that body's shadow, and that difference is the only thing separating a
  // sleeve from the coat it is touching when both are the same colour.
  for (const [side, id] of [[-1, PART_ARM_L], [1, PART_ARM_R]] as const) {
    pushTube(pos, nrm, part, occ, idx, [
      { y: 0.840, rx: 0.056, rz: 0.060, cx: side * SHOULDER_X, ao: 0.70 },
      { y: 1.375, rx: 0.080, rz: 0.088, cx: side * SHOULDER_X, ao: 0.90 },
    ], id, { sides: 4, phase: Math.PI / 4, capBottom: true });
  }

  pushScarf(pos, nrm, part, occ, idx);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(occ, 1));
  g.setIndex(idx);
  return g;
}

/** Triangles in one fan. Published so the stadium can print its own budget. */
export const FAN_TRIS = 116;

// ---------------------------------------------------------------- lighting

/**
 * The per-time-of-day shading constants, in LINEAR radiance — the HDR chain
 * tone-maps downstream, so these are not sRGB hex values and must not be run
 * through a colour-space decode. Tuned so a stand reads a stop or so under the
 * pitch: a crowd sits under a roof, and a crowd as bright as the grass is the
 * single loudest "this is a texture" tell there is.
 */
interface CrowdLight {
  keyDir: THREE.Vector3;
  key: THREE.Color;
  sky: THREE.Color;
  ground: THREE.Color;
}

const lin = (r: number, g: number, b: number): THREE.Color =>
  new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

const CROWD_LIGHT: Record<TimeOfDay, CrowdLight> = {
  day: {
    keyDir: new THREE.Vector3(-0.62, 0.44, 0.65).normalize(),
    key: lin(0.50, 0.48, 0.41),
    sky: lin(0.32, 0.35, 0.41),
    ground: lin(0.10, 0.11, 0.11),
  },
  sunset: {
    keyDir: new THREE.Vector3(-0.85, 0.30, 0.43).normalize(),
    key: lin(0.52, 0.38, 0.25),
    sky: lin(0.21, 0.22, 0.30),
    ground: lin(0.075, 0.07, 0.07),
  },
  night: {
    // the floodlight rig is the key and it is almost straight down, which is
    // why a night crowd is all lit tops and black fronts
    keyDir: new THREE.Vector3(-0.28, 0.92, 0.28).normalize(),
    // Ambient-dominated on purpose, and much flatter than the day preset.
    // A fan always faces the pitch, so a strongly directional key lights the
    // far stand's chests and the near stand's backs — and the establishing
    // crane, which looks DOWN at the near rake, then sees nothing but lit
    // shoulders and blows them out. Pushing most of the level into the
    // hemisphere keeps the chest reading the same from either side and holds
    // the tops a third of a stop under where a directional-only rig put them.
    key: lin(0.38, 0.40, 0.46),
    sky: lin(0.29, 0.31, 0.38),
    ground: lin(0.20, 0.21, 0.25),
  },
};

// ----------------------------------------------------------------- density

/** How much crowd each quality level actually builds. */
export interface CrowdDetail {
  /** metres between fans along a rake */
  stepAlong: number;
  /** metres between rows up a rake */
  stepUp: number;
  /** hard ceiling on figures; the far stand is filled first */
  maxFigures: number;
  /** false = no 3D figures at all (RETRO keeps the v1.1 quads) */
  figures: boolean;
}

export const CROWD_DETAIL: Record<QualityLevel, CrowdDetail> = {
  // Row spacing is looser than seat spacing on purpose: the rake is 32° and a
  // fan is 1.7m, so on any camera the game actually uses the row behind is
  // three-quarters hidden by the row in front. Spending triangles up the rake
  // buys nothing; spending them ALONG it is what fills the frame.
  high: { stepAlong: 0.80, stepUp: 1.35, maxFigures: 4200, figures: true },
  medium: { stepAlong: 1.05, stepUp: 1.70, maxFigures: 2600, figures: true },
  retro: { stepAlong: 0, stepUp: 0, maxFigures: 0, figures: false },
};

// -------------------------------------------------------------- build spec

/** One rake's worth of seats to fill, in the stand's own local space. */
export interface CrowdBlock {
  /** stand placement: local +z runs away from the pitch, then rotated by rotY */
  cx: number; cz: number; rotY: number;
  /** length of the stand along its local x */
  len: number;
  /** the tier to seat: front edge at local z = depth, rising y0 → y0+rise */
  y0: number; rise: number; run: number; depth: number;
  /** 0..1 relative density — the far stand gets 1, the one behind the camera
   *  gets a fraction of it, because nobody has ever seen it */
  detail: number;
  /** local x spans to leave empty (the tunnel mouth, the camera gantry) */
  gaps?: [number, number][];
  /** gaps only bite below this world y — a tunnel mouth interrupts the front
   *  rows, it does not cut a stripe of empty seats up the whole tier */
  gapTop?: number;
  /** allegiance at local x = -len/2 and +len/2; lerped across the stand.
   *  1 = home support, 0 = away support, 0.5 = neutral/mixed. */
  alle0: number; alle1: number;
}

/** What a stand's seating cost, for the budget line the stadium prints. */
export interface CrowdBudget {
  figures: number;
  triangles: number;
  drawCalls: number;
}

// --------------------------------------------------------------- reactions

export type CrowdReaction =
  | 'goal' | 'shot' | 'save' | 'post' | 'miss' | 'card'
  | 'corner' | 'kickoff' | 'halftime' | 'fulltime' | 'penalty';

/** Hold times, in seconds, for the transient moods. */
const JOY_HOLD = 7.0;
const SAD_HOLD = 8.5;
const APPLAUD_HOLD = 3.2;
/** A crowd that has had nothing to cheer for this long starts a wave. */
const LULL_BEFORE_WAVE = 26;
/** Laps the wave makes before it dies out, and how long one lap takes. */
const WAVE_LAPS = 1.75;
const WAVE_LAP_SEC = 9.0;

export class Crowd {
  /** every instanced mesh we own, so dispose() and the budget are honest */
  private meshes: THREE.InstancedMesh[] = [];
  private mat: THREE.MeshBasicMaterial | null = null;
  private geo: THREE.BufferGeometry | null = null;

  private uTime = { value: 0 };
  private uExcite = { value: 0.12 };
  /** x = wave head as a 0..1 lap of the bowl, y = amplitude */
  private uWave = { value: new THREE.Vector2(0, 0) };
  /** x = home support, y = away support */
  private uJoy = { value: new THREE.Vector2(0, 0) };
  private uSad = { value: new THREE.Vector2(0, 0) };
  private uApplaud = { value: 0 };

  private clock = 0;
  /** the settled baseline the match feeds us, 0..1 */
  private base = 0.12;
  private baseTarget = 0.12;
  /** a decaying transient stacked on top of the baseline */
  private spike = 0;
  private joy: [number, number] = [0, 0];
  private sad: [number, number] = [0, 0];
  private applaud = 0;
  /** seconds since anything happened worth standing up for */
  private quietFor = 0;
  /** >= 0 while a wave is travelling; counts laps */
  private waveT = -1;

  budget: CrowdBudget = { figures: 0, triangles: 0, drawCalls: 0 };

  constructor(
    private rng: RNG,
    tod: TimeOfDay,
    private detail: CrowdDetail,
    private homeShirt: THREE.Color,
    private awayShirt: THREE.Color,
  ) {
    if (!detail.figures) return;
    this.geo = buildFanGeometry();
    this.mat = this.makeMaterial(CROWD_LIGHT[tod]);
  }

  /** true when this quality level actually seats figures. */
  get live(): boolean {
    return this.detail.figures && this.mat !== null;
  }

  // ------------------------------------------------------------- material

  private makeMaterial(light: CrowdLight): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({ fog: true });
    // NOT vertexColors: InstancedMesh.instanceColor defines USE_INSTANCING_COLOR
    // by itself and that is the varying we write into. Asking for vertexColors
    // as well would define USE_COLOR and demand a `color` attribute the fan
    // geometry has not got — which reads as black.
    queueShaderPatch(mat, (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uExcite = this.uExcite;
      shader.uniforms.uWave = this.uWave;
      shader.uniforms.uJoy = this.uJoy;
      shader.uniforms.uSad = this.uSad;
      shader.uniforms.uApplaud = this.uApplaud;
      shader.uniforms.uKeyDir = { value: light.keyDir };
      shader.uniforms.uKey = { value: light.key };
      shader.uniforms.uSky = { value: light.sky };
      shader.uniforms.uGround = { value: light.ground };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aPart;
          attribute float aAO;   // baked per-vertex occlusion, 1 = open sky
          attribute vec4 aFan;   // phase, lap coordinate, allegiance, seated
          attribute vec3 aSkin;
          attribute vec4 aTrim;  // club accent rgb, + a 0..1 dressing roll
          uniform float uTime;
          uniform float uExcite;
          uniform vec2  uWave;
          uniform vec2  uJoy;
          uniform vec2  uSad;
          uniform float uApplaud;
          uniform vec3  uKeyDir;
          uniform vec3  uKey;
          uniform vec3  uSky;
          uniform vec3  uGround;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          float ph   = aFan.x;
          float alle = aFan.z;
          float seat = aFan.w;
          float t    = uTime;
          float tp   = t + ph * 6.2831853;
          float rnd  = fract( ph * 733.71 );
          float rnd2 = fract( ph * 197.13 + 0.37 );

          // allegiance 1 = home, 0 = away, 0.5 = a mixed block that gets half
          // of each — which is exactly what a neutral section looks like
          float joy = mix( uJoy.y, uJoy.x, alle );
          float sad = mix( uSad.y, uSad.x, alle );

          // The wave: a travelling window in lap coordinates, wrapped the
          // short way round so it crosses the 0/1 seam without a seam.
          float d = aFan.y - uWave.x;
          d -= floor( d + 0.5 );
          float wave = uWave.y * smoothstep( 0.055, 0.0, abs( d ) );

          float energy = clamp( uExcite + joy * 1.15 - sad * 0.7, 0.0, 1.4 );

          // who is actually on their feet. A seated fan stands for a wave, a
          // goal, or anything that pushes the ground's energy up.
          float stand = clamp( ( 1.0 - seat )
            + seat * clamp( energy * 1.55 + wave * 1.3 - sad * 1.2, 0.0, 1.0 ), 0.0, 1.0 );
          float sd = 1.0 - stand;

          // arms. The two step() terms are what stop a stand looking like one
          // animation: a fixed minority always have their arms up, and a
          // slowly-rotating minority put theirs up for a few seconds at a time.
          // Not everyone is equally demonstrative. Without this per-instance
          // gain a goal puts 1,500 identical pairs of arms in the air at once,
          // which reads as a Mexican wave frozen mid-lap rather than a crowd.
          float joyI = joy * ( 0.55 + 0.62 * rnd2 );
          float armUp = clamp(
              wave * 1.05
            + joyI * 1.45
            + uApplaud * 0.5
            + step( 0.88, rnd ) * uExcite * 0.9
            + step( 0.965, fract( rnd2 + t * 0.055 ) ) * 0.85,
            0.0, 1.0 ) * ( 1.0 - sad * 0.92 );

          float bob  = ( 0.010 + 0.105 * energy ) * abs( sin( tp * ( 2.0 + 2.4 * energy ) ) );
          float jump = joy * max( 0.0, sin( tp * 4.6 ) ) * 0.34 * stand;
          float sway = sin( tp * 0.9 ) * ( 0.012 + 0.05 * energy );

          float isLeg   = step( 1.5, aPart ) * step( aPart, 2.5 );
          float isArm   = step( 2.5, aPart ) * step( aPart, 4.5 );
          float isHead  = step( 0.5, aPart ) * step( aPart, 1.5 );
          float isScarf = step( 4.5, aPart );
          float armSide = sign( aPart - 3.5 );

          vec3 p = position;

          // legs fold into a lap when the fan is sitting
          vec3 lap = vec3( p.x, 0.46 + p.z * 0.75, ( 0.82 - p.y ) * 0.52 );
          p = mix( p, lap, isLeg * sd );
          // ...and everything above the hips comes down onto the seat
          p.y -= ( 1.0 - isLeg ) * sd * ${SIT_DROP.toFixed(3)};

          float shoulderY = ${SHOULDER_Y.toFixed(3)} - sd * ${SIT_DROP.toFixed(3)};
          // per-instance reach: 2.45 rad is arms forward-and-up, 3.05 is
          // straight overhead and slightly back. Fixing it at one angle gave a
          // celebrating end a row of identical goalposts.
          float a  = -armUp * ( 2.45 + 0.6 * rnd );
          float ca = cos( a ), sa = sin( a );

          if ( isArm > 0.5 ) {
            vec3 pivot = vec3( ${SHOULDER_X.toFixed(3)} * armSide, shoulderY, 0.0 );
            vec3 r = p - pivot;
            r.x += armSide * armUp * 0.12;
            r = vec3( r.x, r.y * ca - r.z * sa, r.y * sa + r.z * ca );
            // clapping: the forearms swing together, they do not wave
            r.x -= armSide * uApplaud * 0.095 * ( 0.5 + 0.5 * sin( t * 12.0 + ph * 47.0 ) );
            p = pivot + r;
          }

          if ( isScarf > 0.5 ) {
            // A scarf exists only while it is held overhead, and only for the
            // fans who own one (the same aTrim roll that puts a club colour
            // round their neck). The rest collapse the strip to a point, which
            // rasterises nothing and costs no branch on the GPU.
            float show = step( 0.55, aTrim.w ) * smoothstep( 0.42, 0.85, armUp );
            vec3 hand = vec3( 0.0, -0.52, 0.0 );
            hand = vec3( hand.x, hand.y * ca - hand.z * sa, hand.y * sa + hand.z * ca );
            vec3 c = vec3( 0.0, shoulderY + hand.y, hand.z );
            // cloth: the free ends flap hardest, the middle is pinned by two
            // fists, so the amplitude goes with x^2 and travels along the strip
            float fl = p.x * p.x * ( 0.30 + 0.45 * uExcite )
              * sin( t * 5.2 + ph * 31.0 + p.x * 4.1 );
            vec3 spread = c + vec3( p.x * ( 0.62 + armUp * 0.2 ),
              ( p.y - ${SHOULDER_Y.toFixed(3)} ) * 0.9 + fl * 0.22, fl );
            p = mix( c, spread, show );
          }

          p.y += bob + jump;
          float upf = clamp( p.y / 1.7, 0.0, 1.0 );
          p.x += sway * upf;
          // conceding: slumped forward, head down, and nobody stands up
          p.z += sad * 0.14 * upf * ( 1.0 - isLeg );
          p.y -= sad * 0.05 * upf;

          // ---- idle ----
          // Nobody in a stand is ever still. Two slow, per-instance, mutually
          // prime oscillations — a shift of weight and a turn of the trunk —
          // keep a 12%-excitement crowd from freezing into a photograph
          // between events, for four sin() and no extra uniform.
          float notLeg = 1.0 - isLeg;
          float tw = sin( t * ( 0.31 + 0.27 * rnd ) + ph * 39.0 )
            * ( 0.085 + 0.20 * energy ) * notLeg * upf;
          float ct2 = cos( tw ), st2 = sin( tw );
          p.xz = vec2( p.x * ct2 + p.z * st2, -p.x * st2 + p.z * ct2 );
          p.x += sin( t * ( 0.43 + 0.24 * rnd2 ) + ph * 17.0 )
            * ( 0.014 + 0.028 * energy ) * upf;
          p.y += sin( t * 1.25 + ph * 23.0 ) * 0.006 * notLeg;

          vec3 transformed = p;

          // ---- shading: hemisphere + one key, per vertex, unlit material ----
          // the trunk twist goes through the normal too, so the idle reads as a
          // shimmer of changing shading across a stand and not just as motion
          vec3 n0 = normal;
          n0.xz = vec2( n0.x * ct2 + n0.z * st2, -n0.x * st2 + n0.z * ct2 );
          vec3 nn = normalize( mat3( instanceMatrix ) * n0 );
          // Baked occlusion. It sits on the AMBIENT term (mostly) because that
          // is physically what a packed row takes away: the hips and shins of
          // the man in front of you see no sky at all, his shoulders and head
          // see all of it. This is the single biggest "these are solid bodies
          // in rows" cue in the file, and it is one multiply.
          vec3 amb = mix( uGround, uSky, nn.y * 0.5 + 0.5 ) * aAO;
          vec3 shade = amb
            + uKey * max( dot( nn, uKeyDir ), 0.0 ) * mix( 0.55, 1.0, aAO );

          vec3 body   = vColor.rgb;   // the outer garment (instanceColor)
          vec3 accent = aTrim.rgb;    // the club colour: scarf, hat, collar
          float dress = aTrim.w;

          // Legwear. Three families plus "matching the coat" — a stand in one
          // shade of trouser is a stand of mannequins, and legs are half the
          // figure from any camera that is below the front row.
          float lr = fract( ph * 91.7 + 0.11 );
          vec3 legc = mix( vec3( 0.026, 0.031, 0.045 ),
            vec3( 0.034, 0.050, 0.086 ), step( 0.40, lr ) );
          legc = mix( legc, vec3( 0.072, 0.068, 0.058 ), step( 0.74, lr ) );
          legc = mix( legc, body * 0.30, step( 0.86, rnd ) );

          vec3 pc = body;
          pc = mix( pc, aSkin, isHead );
          pc = mix( pc, legc, isLeg );

          // A scarf round the NECK: the torso's collar ring plus the base of
          // the skull. One band of club colour under the chin says "home end"
          // from 40 m, where a replica shirt is four pixels of nothing.
          float worn = step( 0.55, dress );
          // 1.425 is the torso's collar RING, so this lands in one strip
          // instead of fading half way down the chest.
          float band = max(
            smoothstep( 1.33, 1.42, position.y ) * ( 1.0 - isHead ) * ( 1.0 - isArm ),
            smoothstep( 1.45, 1.36, position.y ) * isHead );
          pc = mix( pc, accent, worn * band * 0.88 );
          // and a bobble hat on some of the ones who aren't wearing a scarf
          pc = mix( pc, accent * 0.75,
            step( dress, 0.26 ) * isHead * smoothstep( 1.46, 1.545, position.y ) );

          // the held-up scarf is two-tone along its length, like every one ever
          // sold outside a ground
          pc = mix( pc,
            mix( accent * 1.15, accent * 0.42 + 0.02,
              step( 0.5, fract( position.x * 3.4 + 0.25 ) ) ), isScarf );
          // Bare HANDS, not bare forearms — taken from the UNANIMATED position
          // so a raised arm does not change colour on the way up. The old
          // half-the-arm version put a skin-toned stick down each side of every
          // fan, which at 15 m is the single thing that made the limbs read as
          // detached: a football crowd is in sleeves, and only the cuff down is
          // skin.
          pc = mix( pc, aSkin, isArm * smoothstep( 1.00, 0.88, position.y ) * 0.9 );
          vColor.rgb = pc * shade;
        `);
    });
    // unlit, so nothing downstream will ever re-hang onBeforeCompile on it
    applyShaderPatches(mat);
    return mat;
  }

  // ---------------------------------------------------------------- build

  /**
   * Seat one stand and add it to the scene as a single InstancedMesh — one
   * draw call, and one bounding sphere, so the stand behind the camera culls
   * as a unit. Returns the number of figures actually seated.
   */
  seat(parent: THREE.Object3D, block: CrowdBlock): number {
    if (!this.live) return 0;
    const det = this.detail;
    const stepAlong = det.stepAlong / Math.max(0.35, block.detail);
    const stepUp = det.stepUp / Math.max(0.5, Math.min(1, block.detail + 0.35));
    const rakeLen = Math.hypot(block.rise, block.run);
    const cols = Math.max(2, Math.floor(block.len / stepAlong));
    const rows = Math.max(1, Math.floor(rakeLen / stepUp));

    // budget guard: never let a big venue at HIGH walk past the ceiling
    const room = det.maxFigures - this.budget.figures;
    if (room <= 0) return 0;
    const wanted = cols * rows;
    const count = Math.min(wanted, room);

    // Each stand gets its OWN geometry clone. An InstancedMesh reads its
    // per-instance attributes off the GEOMETRY, so four stands sharing one
    // geometry would share one aFan buffer and every stand would wear the last
    // one's phases. 148 vertices a clone; the duplication is free.
    const geo = this.geo!.clone();
    const inst = new THREE.InstancedMesh(geo, this.mat!, count);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    inst.frustumCulled = true;
    // a crowd is not a shadow caster; it is thousands of objects that would double
    // the cascade draw and land their shadows on a terrace nobody can see
    inst.castShadow = false;
    inst.receiveShadow = false;

    const fan = new Float32Array(count * 4);
    const skin = new Float32Array(count * 3);
    const trim = new Float32Array(count * 4);
    geo.setAttribute('aFan', new THREE.InstancedBufferAttribute(fan, 4));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aTrim', new THREE.InstancedBufferAttribute(trim, 4));

    const rng = this.rng;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    const sk = new THREE.Color();
    const ac = new THREE.Color();
    const cosR = Math.cos(block.rotY), sinR = Math.sin(block.rotY);

    let i = 0;
    for (let r = 0; r < rows && i < count; r++) {
      const up = (r + 0.5) / rows;
      const y = block.y0 + block.rise * up;
      const z = block.depth + block.run * up;
      for (let c = 0; c < cols && i < count; c++) {
        const along = -block.len / 2 + stepAlong * (c + 0.5) + rng.range(-0.16, 0.16);
        // holes: the tunnel mouth and the camera gantry have no seats in them
        if (y < (block.gapTop ?? Infinity)
          && block.gaps?.some(([a, b]) => along > a && along < b)) continue;
        // a few empty seats, more of them high up — a sold-out-to-the-rafters
        // ground is the other way a crowd reads as a pattern
        if (rng.next() < 0.015 + up * 0.05) continue;

        // stand-local -> world (rotation about y only)
        const lz = z + rng.range(-0.12, 0.12);
        pos.set(
          block.cx + along * cosR + lz * sinR,
          y,
          block.cz - along * sinR + lz * cosR,
        );
        // face the pitch, plus a little scatter so a row is not a firing squad
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0),
          block.rotY + Math.PI + rng.range(-0.22, 0.22));
        // Height AND build. Height alone gave a row of one body type at
        // different sizes, which from the front row is still a picket fence;
        // what breaks the fence is that some of them are broad and some are
        // narrow at the same height. Girth drives x hard and z about a fifth as
        // hard, because a heavy man is mostly wider, not mostly deeper.
        // the range is a touch taller than v1.3's because the v1.4 figure is
        // 1.618m to the crown where the box fan was 1.67m; without that the
        // same rake came out visibly shorter and the tier read half-empty
        const h = rng.range(0.88, 1.14);
        const girth = rng.range(0.92, 1.18);
        scl.set(h * girth, h, h * (0.92 + (girth - 1) * 0.8));
        m.compose(pos, q, scl);
        inst.setMatrixAt(i, m);

        // lap coordinate for the wave: where this fan sits around the bowl
        const lapCoord = (Math.atan2(pos.z, pos.x) / (Math.PI * 2)) + 0.5;
        const alle = block.alle0 + (block.alle1 - block.alle0) * ((along / block.len) + 0.5);
        // The front rows stand all match; the back sits until something
        // happens. That gradient alone is most of what makes a rake read as
        // a real one rather than a grid.
        const seated = rng.next() < 0.22 + up * 0.50 ? 1 : 0;
        fan[i * 4] = rng.next();
        fan[i * 4 + 1] = lapCoord;
        fan[i * 4 + 2] = alle;
        fan[i * 4 + 3] = seated;

        // Depth shade, exactly as the billboard tiers do it (§7A.5): the back
        // of a rake is under the roof and in its own shadow, and darkening it
        // is most of what sells a stand as deep rather than flat. Without it
        // the 3D tier reads BRIGHTER than the cards above it and the bowl
        // turns inside out.
        const deep = 1 - up * 0.34;
        this.pickShirt(col, alle, rng);
        col.multiplyScalar(deep);
        inst.setColorAt(i, col);
        this.pickSkin(sk, rng);
        sk.multiplyScalar(deep);
        skin[i * 3] = sk.r; skin[i * 3 + 1] = sk.g; skin[i * 3 + 2] = sk.b;
        // the club colour this fan carries on top of whatever coat they are in
        this.pickAccent(ac, alle, rng);
        ac.multiplyScalar(deep);
        trim[i * 4] = ac.r; trim[i * 4 + 1] = ac.g; trim[i * 4 + 2] = ac.b;
        trim[i * 4 + 3] = rng.next();
        i++;
      }
    }
    // the rejected seats (gaps, empties) leave the tail of the buffer unwritten
    // — an unset instance matrix is all zeros, which is a degenerate figure at
    // the origin, i.e. a black splat on the centre spot. Shrink instead.
    inst.count = i;
    if (i === 0) {
      // nothing survived (a stand entirely inside a gap, or a figure budget
      // that ran out on the first row). An empty InstancedMesh has no valid
      // bounding sphere, which is a NaN in the cull test, not a no-op.
      inst.dispose();
      geo.dispose();
      return 0;
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

    inst.computeBoundingSphere();
    if (inst.boundingSphere) inst.boundingSphere.radius += 2.0;
    parent.add(inst);
    this.meshes.push(inst);
    this.budget.figures += i;
    this.budget.triangles += i * FAN_TRIS;
    this.budget.drawCalls += 1;
    return i;
  }

  /**
   * A handful of seated figures on a bench (the dugouts). Same geometry, same
   * uniforms — so the subs are out of their seats on a goal too, which is
   * free and is exactly what happens.
   */
  seatBench(parent: THREE.Object3D, spots: { x: number; y: number; z: number; rotY: number;
    alle: number; shirt: THREE.Color }[]): void {
    if (!this.live || spots.length === 0) return;
    const fan = new Float32Array(spots.length * 4);
    const skin = new Float32Array(spots.length * 3);
    const trim = new Float32Array(spots.length * 4);
    const geo = this.geo!.clone();
    geo.setAttribute('aFan', new THREE.InstancedBufferAttribute(fan, 4));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aTrim', new THREE.InstancedBufferAttribute(trim, 4));
    const inst = new THREE.InstancedMesh(geo, this.mat!, spots.length);
    inst.castShadow = false;

    const rng = this.rng;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sk = new THREE.Color();
    spots.forEach((s, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY + rng.range(-0.15, 0.15));
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q,
        new THREE.Vector3(rng.range(0.97, 1.05), rng.range(0.96, 1.04), 1));
      inst.setMatrixAt(i, m);
      fan[i * 4] = rng.next();
      fan[i * 4 + 1] = (Math.atan2(s.z, s.x) / (Math.PI * 2)) + 0.5;
      fan[i * 4 + 2] = s.alle;
      fan[i * 4 + 3] = 1;
      inst.setColorAt(i, s.shirt);
      this.pickSkin(sk, rng);
      skin[i * 3] = sk.r; skin[i * 3 + 1] = sk.g; skin[i * 3 + 2] = sk.b;
      // a bench wears the kit, not club merchandise: accent = the bench colour,
      // and a dressing roll of 0.4 owns neither a scarf nor a hat
      trim[i * 4] = s.shirt.r; trim[i * 4 + 1] = s.shirt.g; trim[i * 4 + 2] = s.shirt.b;
      trim[i * 4 + 3] = 0.4;
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    if (inst.boundingSphere) inst.boundingSphere.radius += 1.5;
    parent.add(inst);
    this.meshes.push(inst);
    this.budget.figures += spots.length;
    this.budget.triangles += spots.length * FAN_TRIS;
    this.budget.drawCalls += 1;
  }

  /**
   * The palette. A home end is not "everyone in the home shirt" — it is a
   * majority in the shirt, a scattering of white/grey, and a lot of people in
   * a dark coat because it is a football match and it is cold.
   */
  private pickShirt(out: THREE.Color, alle: number, rng: RNG): void {
    const roll = rng.next();
    const kit = rng.next() < alle ? this.homeShirt : this.awayShirt;
    if (roll < 0.30) {
      // In the shirt, with real variation. The multiplier matters more than
      // the hue: a replica kit in a stand is never at full kit value — it is
      // under a coat, in the roof's shade, twenty rows back. The first pass at
      // this left the shirts at 1.0 and a sunset stand came out as a sheet of
      // white rectangles brighter than the pitch.
      out.copy(kit).multiplyScalar(rng.range(0.30, 0.72));
      out.offsetHSL(rng.range(-0.02, 0.02), rng.range(-0.14, 0.04), 0);
    } else if (roll < 0.46) {
      // a pale coat / a plain shirt
      const g = rng.range(0.14, 0.34);
      out.setRGB(g, g * 1.01, g * 1.05, THREE.LinearSRGBColorSpace);
    } else if (roll < 0.80) {
      // generic dark outerwear — a third of any real crowd, and the thing that
      // stops the stand glowing
      const g = rng.range(0.016, 0.065);
      out.setRGB(g * rng.range(0.8, 1.25), g, g * rng.range(0.9, 1.4),
        THREE.LinearSRGBColorSpace);
    } else if (roll < 0.94) {
      // The winter-coat rack: olive, navy, oxblood, tan, teal, brown. This is
      // the band the old palette had nothing in, and the reason a stand used to
      // read as kit-or-black. Real outerwear is desaturated and mid-dark, and a
      // seventh of the ground in it is what makes the other six sevenths look
      // like clothing rather than swatches.
      const HUES = [0.10, 0.60, 0.015, 0.09, 0.48, 0.065];
      const h = HUES[Math.min(HUES.length - 1, Math.floor(rng.next() * HUES.length))];
      out.setHSL(h + rng.range(-0.02, 0.02), rng.range(0.10, 0.36),
        rng.range(0.055, 0.135));
    } else {
      // the odd bright jacket, which is what keeps a dark crowd from reading
      // as a single grey mass — muted, because eight per cent of a stand in
      // saturated primaries reads as confetti
      out.setHSL(rng.next(), rng.range(0.22, 0.5), rng.range(0.13, 0.26));
    }
  }

  /**
   * The club colour a fan carries ON TOP of whatever coat they turned up in —
   * the scarf round the neck, the hat, the held-up scarf. This is deliberately
   * separate from the garment: most of a home end is not in the shirt, but most
   * of a home end is wearing the colours SOMEWHERE, and a band of them at the
   * collar survives to a distance a replica shirt does not.
   */
  private pickAccent(out: THREE.Color, alle: number, rng: RNG): void {
    const kit = rng.next() < alle ? this.homeShirt : this.awayShirt;
    out.copy(kit).multiplyScalar(rng.range(0.40, 0.92));
    out.offsetHSL(rng.range(-0.03, 0.03), rng.range(-0.10, 0.06), 0);
  }

  private pickSkin(out: THREE.Color, rng: RNG): void {
    const t = rng.next();
    // a plausible spread, held dark enough that a head never blooms
    const l = t < 0.45 ? rng.range(0.21, 0.32)
      : t < 0.75 ? rng.range(0.13, 0.21)
        : rng.range(0.060, 0.125);
    out.setRGB(l * 1.06, l * 0.82, l * 0.68, THREE.LinearSRGBColorSpace);
  }

  // ------------------------------------------------------------ behaviour

  /**
   * The match's running anticipation, 0..1 (§7.3's attackBuildup, mostly).
   * Floored, because a ground at literally zero is a ground nobody turned up
   * to — even a goalless 20th minute has people fidgeting.
   */
  setExcitement(v: number): void {
    this.baseTarget = 0.09 + 0.91 * Math.max(0, Math.min(1, v));
  }

  /**
   * One beat of the match. `teamIdx` is the team the beat belongs to: who
   * scored, whose keeper saved, who got booked. Everything here is a few
   * scalars — nothing walks the instance buffers.
   */
  react(kind: CrowdReaction, teamIdx = 0): void {
    const side = teamIdx === 0 ? 0 : 1;   // 0 = home support, 1 = away support
    const other = 1 - side;
    switch (kind) {
      case 'goal':
        this.joy[side] = 1;
        this.sad[other] = 1;
        this.applaud = 0.35;
        this.spike = 1;
        this.baseTarget = Math.max(this.baseTarget, 0.55);
        break;
      case 'shot':
        this.spike = Math.max(this.spike, 0.62);
        this.applaud = Math.max(this.applaud, 0.2);
        break;
      case 'save':
        // teamIdx is the KEEPER's team: his end applauds, the other end groans
        this.applaud = 1;
        this.joy[side] = Math.max(this.joy[side], 0.28);
        this.sad[other] = Math.max(this.sad[other], 0.35);
        this.spike = Math.max(this.spike, 0.7);
        break;
      case 'post':
        this.spike = Math.max(this.spike, 0.85);
        this.applaud = Math.max(this.applaud, 0.55);
        break;
      case 'miss':
        this.sad[side] = Math.max(this.sad[side], 0.5);
        this.spike = Math.max(this.spike, 0.3);
        break;
      case 'card':
        this.spike = Math.max(this.spike, 0.55);
        this.joy[other] = Math.max(this.joy[other], 0.22);
        this.sad[side] = Math.max(this.sad[side], 0.4);
        break;
      case 'corner':
      case 'penalty':
        this.spike = Math.max(this.spike, kind === 'penalty' ? 0.8 : 0.42);
        break;
      case 'kickoff':
        this.applaud = Math.max(this.applaud, 0.75);
        this.spike = Math.max(this.spike, 0.45);
        break;
      case 'halftime':
        // settle: everybody sits down, the wave dies, the mood resets
        this.baseTarget = 0.06;
        this.spike = 0;
        this.joy = [0, 0];
        this.sad = [0, 0];
        this.applaud = 0.5;
        this.waveT = -1;
        break;
      case 'fulltime':
        this.applaud = 1;
        this.spike = 0.8;
        this.baseTarget = 0.5;
        this.waveT = -1;
        break;
    }
    if (kind !== 'halftime') this.quietFor = 0;
    // anything worth reacting to kills a wave in progress — a ground that
    // keeps waving through a goalmouth scramble is a ground nobody is watching
    if (kind !== 'kickoff' && this.spike > 0.4) this.waveT = -1;
  }

  /**
   * Drive the crowd. `dt` is the renderer's frame step — the real clock in a
   * match, the harness's fixed virtual step under capture, so a still stays a
   * pure function of its shot spec.
   */
  update(dt: number): void {
    if (!this.live || dt < 0) return;
    this.clock += dt;
    this.uTime.value = this.clock;

    // baseline follows the match with a long half-life; the spike is what
    // makes a moment feel like a moment
    this.base += (this.baseTarget - this.base) * Math.min(1, dt * 0.9);
    this.spike = Math.max(0, this.spike - dt / 3.4);
    this.uExcite.value = Math.min(1.25, this.base + this.spike);

    this.joy[0] = Math.max(0, this.joy[0] - dt / JOY_HOLD);
    this.joy[1] = Math.max(0, this.joy[1] - dt / JOY_HOLD);
    this.sad[0] = Math.max(0, this.sad[0] - dt / SAD_HOLD);
    this.sad[1] = Math.max(0, this.sad[1] - dt / SAD_HOLD);
    this.applaud = Math.max(0, this.applaud - dt / APPLAUD_HOLD);
    // joy is a curve, not a ramp: the first two seconds are the eruption
    this.uJoy.value.set(easeOut(this.joy[0]), easeOut(this.joy[1]));
    this.uSad.value.set(this.sad[0], this.sad[1]);
    this.uApplaud.value = this.applaud;

    // ---- the wave ----
    if (this.waveT >= 0) {
      this.waveT += dt / WAVE_LAP_SEC;
      if (this.waveT > WAVE_LAPS) {
        this.waveT = -1;
        this.uWave.value.set(0, 0);
      } else {
        // fade in over the first third of a lap and out over the last
        const amp = Math.min(1, this.waveT * 3) * Math.min(1, (WAVE_LAPS - this.waveT) * 2.2);
        this.uWave.value.set(this.waveT % 1, amp);
      }
    } else {
      this.quietFor += dt;
      this.uWave.value.y = 0;
      if (this.quietFor > LULL_BEFORE_WAVE && this.uExcite.value < 0.34) {
        this.quietFor = 0;
        this.waveT = 0;
      }
    }
  }

  /** Force a wave to start now (the ticker's "the crowd amuse themselves"). */
  startWave(): void {
    if (this.waveT < 0) this.waveT = 0;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.dispose();
      m.geometry.dispose();
      m.removeFromParent();
    }
    this.meshes.length = 0;
    this.mat?.dispose();
    this.geo?.dispose();
  }
}

/** A goal is a bang followed by a long tail, not a linear fade. */
function easeOut(v: number): number {
  return v <= 0 ? 0 : 1 - (1 - v) * (1 - v);
}
