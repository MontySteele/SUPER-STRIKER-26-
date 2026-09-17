// The 3D crowd (§7.1 "Stadiums", §7A.5).
//
// The billboard rakes were the right call for the back of a Mega Bowl and the
// wrong one for the tier your camera is pointed at all match. A card is a
// photograph: it has no silhouette, it cannot put its arms up, and the moment
// the touchline cam drops to knee height the front row reads as wallpaper.
//
// So the tier nearest the pitch is now made of PEOPLE. One 62-triangle figure
// — legs, torso, head, two arms and a scarf that only exists when it is held
// overhead — instanced once per stand, with everything that makes a crowd a
// crowd done on the GPU:
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
const SHOULDER_X = 0.255;
const SHOULDER_Y = 1.40;
/** How far the whole upper body drops when a fan is sitting down. */
const SIT_DROP = 0.36;

/**
 * Append an axis-aligned box to the growing arrays. Hand-rolled rather than
 * BoxGeometry+merge because we need a per-vertex part id anyway, and a box is
 * twelve triangles of arithmetic.
 */
function pushBox(
  pos: number[], nrm: number[], part: number[], idx: number[],
  cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, id: number,
): void {
  const c = [cx, cy, cz];
  const h = [sx / 2, sy / 2, sz / 2];
  // One entry per face: the axis the normal points along, its sign, and the
  // two tangent axes that sweep the quad. The tangent pair is chosen so that
  // u x v == +n — get that backwards and half the box is back-facing, which on
  // a FrontSide material is a fan with no chest.
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2], [0, -1, 1, 2],
    [1, 1, 2, 0], [1, -1, 2, 0],
    [2, 1, 0, 1], [2, -1, 0, 1],
  ];
  for (const [na, ns, ua, va] of faces) {
    const base = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v3 = [c[0], c[1], c[2]];
      v3[na] += ns * h[na];
      // wind the +normal faces one way and the -normal faces the other, so
      // every triangle is front-facing from outside the box
      v3[ua] += su * ns * h[ua];
      v3[va] += sv * h[va];
      pos.push(v3[0], v3[1], v3[2]);
      const n3 = [0, 0, 0];
      n3[na] = ns;
      nrm.push(n3[0], n3[1], n3[2]);
      part.push(id);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** A single-quad panel in the XY plane facing +z (the scarf). */
function pushQuad(
  pos: number[], nrm: number[], part: number[], idx: number[],
  cx: number, cy: number, cz: number, w: number, h: number, id: number,
): void {
  const base = pos.length / 3;
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    pos.push(cx + su * w / 2, cy + sv * h / 2, cz);
    nrm.push(0, 0, 1);
    part.push(id);
  }
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * The fan. 62 triangles, origin between the feet, facing +z (i.e. toward the
 * pitch once the instance is turned round). Deliberately blocky: at the range
 * a stand is ever seen from, a rounded limb costs triangles and buys nothing —
 * what reads is the silhouette and whether the arms are up.
 */
export function buildFanGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], part: number[] = [], idx: number[] = [];
  pushBox(pos, nrm, part, idx, 0, 0.41, 0, 0.34, 0.82, 0.24, PART_LEGS);
  pushBox(pos, nrm, part, idx, 0, 1.11, 0, 0.48, 0.60, 0.26, PART_TORSO);
  pushBox(pos, nrm, part, idx, 0, 1.545, 0.005, 0.22, 0.25, 0.21, PART_HEAD);
  pushBox(pos, nrm, part, idx, -SHOULDER_X, 1.11, 0, 0.115, 0.60, 0.15, PART_ARM_L);
  pushBox(pos, nrm, part, idx, SHOULDER_X, 1.11, 0, 0.115, 0.60, 0.15, PART_ARM_R);
  pushQuad(pos, nrm, part, idx, 0, SHOULDER_Y, 0.13, 1.0, 0.18, PART_SCARF);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

/** Triangles in one fan. Published so the stadium can print its own budget. */
export const FAN_TRIS = 62;

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
          attribute vec4 aFan;   // phase, lap coordinate, allegiance, seated
          attribute vec3 aSkin;
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
            // A scarf exists only while it is held overhead. Roughly a quarter
            // of the ground owns one; the rest collapse the quad to a point,
            // which rasterises nothing and costs no branch on the GPU.
            float show = step( 0.74, rnd2 ) * smoothstep( 0.42, 0.85, armUp );
            vec3 hand = vec3( 0.0, -0.52, 0.0 );
            hand = vec3( hand.x, hand.y * ca - hand.z * sa, hand.y * sa + hand.z * ca );
            vec3 c = vec3( 0.0, shoulderY + hand.y, hand.z );
            vec3 spread = c + vec3( p.x * ( 0.62 + armUp * 0.2 ),
              ( p.y - ${SHOULDER_Y.toFixed(3)} ) * 0.9, 0.0 );
            p = mix( c, spread, show );
          }

          p.y += bob + jump;
          float upf = clamp( p.y / 1.7, 0.0, 1.0 );
          p.x += sway * upf;
          // conceding: slumped forward, head down, and nobody stands up
          p.z += sad * 0.14 * upf * ( 1.0 - isLeg );
          p.y -= sad * 0.05 * upf;

          vec3 transformed = p;

          // ---- shading: hemisphere + one key, per vertex, unlit material ----
          vec3 nn = normalize( mat3( instanceMatrix ) * normal );
          vec3 amb = mix( uGround, uSky, nn.y * 0.5 + 0.5 );
          vec3 shade = amb + uKey * max( dot( nn, uKeyDir ), 0.0 );

          vec3 shirt = vColor.rgb;
          // trousers/jeans: half the ground in something near-black, half in a
          // dark version of whatever they are wearing up top
          vec3 dark = mix( vec3( 0.030, 0.033, 0.042 ), shirt * 0.26, step( 0.55, rnd ) );
          vec3 pc = shirt;
          pc = mix( pc, aSkin, isHead );
          pc = mix( pc, dark, isLeg );
          pc = mix( pc, shirt * 1.3 + 0.04, isScarf );
          // bare forearms — taken from the UNANIMATED position so a raised arm
          // does not change colour on the way up
          pc = mix( pc, aSkin, isArm * smoothstep( 1.16, 0.94, position.y ) * 0.85 );
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
    geo.setAttribute('aFan', new THREE.InstancedBufferAttribute(fan, 4));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));

    const rng = this.rng;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    const sk = new THREE.Color();
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
        // height variation: adults, a few kids, nobody identical
        const h = rng.range(0.86, 1.06);
        scl.set(h * rng.range(0.94, 1.06), h, h);
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
    const geo = this.geo!.clone();
    geo.setAttribute('aFan', new THREE.InstancedBufferAttribute(fan, 4));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    const inst = new THREE.InstancedMesh(geo, this.mat!, spots.length);
    inst.castShadow = false;

    const rng = this.rng;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sk = new THREE.Color();
    spots.forEach((s, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY + rng.range(-0.15, 0.15));
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q,
        new THREE.Vector3(1, rng.range(0.96, 1.04), 1));
      inst.setMatrixAt(i, m);
      fan[i * 4] = rng.next();
      fan[i * 4 + 1] = (Math.atan2(s.z, s.x) / (Math.PI * 2)) + 0.5;
      fan[i * 4 + 2] = s.alle;
      fan[i * 4 + 3] = 1;
      inst.setColorAt(i, s.shirt);
      this.pickSkin(sk, rng);
      skin[i * 3] = sk.r; skin[i * 3 + 1] = sk.g; skin[i * 3 + 2] = sk.b;
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
    if (roll < 0.44) {
      // In the shirt, with real variation. The multiplier matters more than
      // the hue: a replica kit in a stand is never at full kit value — it is
      // under a coat, in the roof's shade, twenty rows back. The first pass at
      // this left the shirts at 1.0 and a sunset stand came out as a sheet of
      // white rectangles brighter than the pitch.
      out.copy(kit).multiplyScalar(rng.range(0.30, 0.72));
      out.offsetHSL(rng.range(-0.02, 0.02), rng.range(-0.14, 0.04), 0);
    } else if (roll < 0.60) {
      // a pale coat / a plain shirt
      const g = rng.range(0.15, 0.36);
      out.setRGB(g, g * 1.01, g * 1.05, THREE.LinearSRGBColorSpace);
    } else if (roll < 0.92) {
      // generic dark outerwear — a third of any real crowd, and the thing that
      // stops the stand glowing
      const g = rng.range(0.018, 0.07);
      out.setRGB(g * rng.range(0.8, 1.25), g, g * rng.range(0.9, 1.4),
        THREE.LinearSRGBColorSpace);
    } else {
      // the odd bright jacket, which is what keeps a dark crowd from reading
      // as a single grey mass — muted, because eight per cent of a stand in
      // saturated primaries reads as confetti
      out.setHSL(rng.next(), rng.range(0.22, 0.5), rng.range(0.13, 0.26));
    }
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
