// The shared player body (§7A.2).
//
// One construction, built once per match, worn by all twenty-two players. A
// team is a texture swap onto the shared KIT_UV layout and nothing else; the
// only per-player geometry in the game is zero.
//
// Two things earn their keep here.
//
// SILHOUETTE. The v1.1 body was a stack of boxes and capsules, and the thing
// that gave it away was the torso: a 0.52 x 0.58 x 0.3 slab with a sphere
// balanced on top. Everything below is lofted from an elliptical profile
// instead — collar, shoulder, chest, the taper into the waist, rounded hips,
// a real neck — because the whole readability argument for stylized players
// rests on the OUTLINE, and an outline made of right angles reads as a prop.
//
// BAKED AO. Every part carries a vertex-colour occlusion term computed at rest
// pose against a handful of occluder spheres standing in for head, chest,
// pelvis, arms and thighs. It costs one float3 attribute and no shader work,
// and it is the single cheapest trick in real-time rendering that reads as
// expensive: under-arm, inner-leg, under-chin and the shirt hem all darken
// exactly where a viewer expects contact shadow, and the model stops looking
// like it was assembled out of separately-lit parts.
//
// GLTF DROP-IN POINT. If a rigged CC0 humanoid ever lands in this project, it
// replaces buildParts() and nothing else: the animation layer (playerMesh.ts)
// only ever touches the five Groups — body, head, armL/R, legL/R — so a
// skinned mesh wires in by parenting its bones to those same Groups (or by
// mapping them onto a Skeleton with the same five joints). The LOD contract,
// the kit-atlas UV layout and the AO bake all survive that swap unchanged; see
// CREDITS.md for why we're procedural today.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KIT_UV, type KitRegion } from './TextureLab';

export type Detail = 'full' | 'lod';

/** Every geometry a player is made of, at one detail level. */
export interface BodyParts {
  /** shirt + shorts, lofted as one piece — kit atlas */
  torso: THREE.BufferGeometry;
  /** curved panel hugging the back, own per-player name/number texture */
  backPanel: THREE.BufferGeometry;
  /** skull + nose + neck stub — skin */
  skull: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  /** both eyes in one geometry, one draw call */
  eyes: THREE.BufferGeometry;
  /** shoulder cap + sleeve — kit atlas */
  armKit: THREE.BufferGeometry;
  /** forearm + mitt — skin */
  armSkin: THREE.BufferGeometry;
  /** shorts leg + sock — kit atlas */
  legKit: THREE.BufferGeometry;
  /** thigh + knee — skin */
  legSkin: THREE.BufferGeometry;
  boot: THREE.BufferGeometry;
}

// -------------------------------------------------------------- loft helper

/** [y, halfWidth, halfDepth] — the body is wider than it is deep, everywhere. */
type Ring = [number, number, number];

/**
 * Loft an elliptical profile along Y. `vSpan` maps ring index onto the atlas
 * rect's v axis; the back of the section is flattened slightly, which is what
 * gives the number panel something flat to sit on and stops the torso reading
 * as a capsule.
 */
function loft(rings: Ring[], radial: number, rect: readonly number[],
  capTop: boolean, capBottom: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const [u0, v0, u1, v1] = rect;
  // inset by a texel so bilinear filtering can't fetch the neighbouring region
  const eu0 = u0 + 0.004, eu1 = u1 - 0.004, ev0 = v0 + 0.004, ev1 = v1 - 0.004;

  const ringVerts = radial + 1; // duplicated seam vertex so u can reach 1
  for (let r = 0; r < rings.length; r++) {
    const [y, hw, hd] = rings[r];
    const v = ev1 + (ev0 - ev1) * (r / (rings.length - 1));
    for (let s = 0; s <= radial; s++) {
      const th = (s / radial) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      // theta 0 = +z = the way the player faces; the back (ct < 0) is pulled
      // in 12% so the spine is a plane and not an arc
      const depth = hd * (ct >= 0 ? 1 : 0.88);
      pos.push(st * hw, y, ct * depth);
      uv.push(eu0 + (eu1 - eu0) * (s / radial), v);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < radial; s++) {
      const a = r * ringVerts + s, b = a + 1;
      const c = a + ringVerts, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps: a fan to a centre vertex on the ring's own plane
  const cap = (r: number, up: boolean): void => {
    const base = r * ringVerts;
    const centre = pos.length / 3;
    pos.push(0, rings[r][0], 0);
    uv.push((eu0 + eu1) / 2, (ev0 + ev1) / 2);
    for (let s = 0; s < radial; s++) {
      const a = base + s, b = base + s + 1;
      if (up) idx.push(a, b, centre);
      else idx.push(b, a, centre);
    }
  };
  if (capTop) cap(0, true);
  if (capBottom) cap(rings.length - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // The seam column is duplicated so u can run 0..1, which leaves two vertices
  // in the same place each holding half a normal — and the seam sits at theta
  // 0, i.e. straight down the middle of the chest. Average them back together
  // or every player wears a shading crease down his front.
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let r = 0; r < rings.length; r++) {
    const a = r * ringVerts, b = a + radial;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const inv = 1 / Math.max(Math.hypot(nx, ny, nz), 1e-6);
    nrm.setXYZ(a, nx * inv, ny * inv, nz * inv);
    nrm.setXYZ(b, nx * inv, ny * inv, nz * inv);
  }
  nrm.needsUpdate = true;
  return geo;
}

/**
 * Rewrite a three primitive's generated UVs into an atlas rect. Nothing on the
 * body uses it today — every kit surface is lofted, and loft() writes atlas UVs
 * directly — but it is the hook a glTF body would need to wear the same kit
 * atlas without re-authoring its UVs.
 */
export function toRect(geo: THREE.BufferGeometry, region: KitRegion): THREE.BufferGeometry {
  const [u0, v0, u1, v1] = KIT_UV[region];
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i,
      u0 + 0.004 + (u1 - u0 - 0.008) * uv.getX(i),
      v0 + 0.004 + (v1 - v0 - 0.008) * uv.getY(i));
  }
  uv.needsUpdate = true;
  return geo;
}

const translate = (g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry =>
  g.translate(x, y, z);

// ------------------------------------------------------------------ profiles

// Proportions are the v1.1 ones ~5% broad (§7.1), re-cut as a profile. The
// widest point is the deltoid line and the narrowest is the waist: that
// difference IS the silhouette, and boxes cannot have it.
const SHIRT: Ring[] = [
  [1.545, 0.100, 0.090],
  [1.500, 0.150, 0.125],
  [1.455, 0.278, 0.168],
  [1.400, 0.300, 0.180],
  [1.300, 0.286, 0.180],
  [1.180, 0.250, 0.161],
  [1.070, 0.236, 0.150],
  [1.005, 0.248, 0.156],
];
const SHORTS: Ring[] = [
  [1.020, 0.250, 0.158],
  [0.945, 0.266, 0.172],
  [0.875, 0.256, 0.170],
  [0.818, 0.228, 0.163],
];
// A narrow band of trim at the base of the neck. Any taller and it stops
// reading as a collar and starts reading as a bib.
const COLLAR: Ring[] = [
  [1.542, 0.098, 0.088],
  [1.514, 0.126, 0.107],
  [1.494, 0.149, 0.125],
];
// The sleeve carries its own rounded deltoid rather than parking a hemisphere
// on top of it: a separate shoulder cap sat proud of the shoulder line, showed
// its pole, and left a seam where the two radii disagreed.
const SLEEVE: Ring[] = [
  [0.072, 0.030, 0.030],
  [0.052, 0.062, 0.062],
  [0.028, 0.081, 0.081],
  [-0.020, 0.088, 0.088],
  [-0.090, 0.080, 0.080],
  [-0.160, 0.070, 0.070],
  [-0.208, 0.063, 0.063],
];
const FOREARM: Ring[] = [
  [-0.212, 0.058, 0.058],
  [-0.310, 0.049, 0.049],
  [-0.420, 0.043, 0.043],
  [-0.478, 0.046, 0.051], // the mitt (§7.1: fingers are not modelled, ever)
  [-0.522, 0.034, 0.042],
];
const THIGH: Ring[] = [
  [-0.030, 0.104, 0.102],
  [-0.150, 0.098, 0.098],
  [-0.280, 0.086, 0.089],
  [-0.380, 0.073, 0.078], // knee
  [-0.430, 0.070, 0.075],
];
// Wider than THIGH at every shared height, or the leg saws through the hem and
// leaves a row of zigzag teeth where the two ellipses intersect.
const SHORTS_LEG: Ring[] = [
  [0.030, 0.128, 0.124],
  [-0.060, 0.120, 0.118],
  [-0.140, 0.114, 0.113],
];
const SOCK: Ring[] = [
  [-0.425, 0.074, 0.079],
  [-0.560, 0.070, 0.077],
  [-0.690, 0.058, 0.066],
  [-0.775, 0.050, 0.058],
];

// ----------------------------------------------------------------- assembly

/**
 * Build one detail level. `lod` halves the radial resolution and drops the
 * sphere segment counts — at 30m+ a player is under 60px tall and the extra
 * rings buy nothing but shadow-pass triangles.
 */
export function buildParts(detail: Detail): BodyParts {
  const full = detail === 'full';
  const radial = full ? 14 : 8;
  const sph = full ? 14 : 7;
  const sphV = full ? 11 : 6;

  // ---- torso: shirt + collar trim + shorts, one geometry, one draw call
  const torso = mergeGeometries([
    loft(SHIRT, radial, KIT_UV.shirt, false, false),
    loft(COLLAR, radial, KIT_UV.collar, false, false),
    loft(SHORTS, radial, KIT_UV.shorts, false, true),
  ])!;

  // ---- the back panel, sampled off the same profile so it sits ON the shirt
  const backPanel = buildBackPanel(full ? 6 : 3);

  // ---- head: skull + nose + neck stub, all skin
  const skullGeo = new THREE.SphereGeometry(0.15, sph + 4, sphV + 2);
  skullGeo.scale(1, 1.12, 1.04);
  const nose = new THREE.BoxGeometry(0.045, 0.045, 0.055);
  translate(nose, 0, -0.012, 0.152);
  const neck = loft([[-0.10, 0.072, 0.066], [-0.175, 0.082, 0.074],
    [-0.235, 0.094, 0.084]], full ? 10 : 6, [0, 0, 1, 1], false, false);
  const skull = mergeGeometries(full ? [skullGeo, nose, neck] : [skullGeo, neck])!;

  // ---- hair cap
  const hair = new THREE.SphereGeometry(0.158, sph + 4, sphV - 2, 0, Math.PI * 2, 0, Math.PI * 0.56);
  hair.scale(1, 1.12, 1.04);
  translate(hair, 0, 0.014, 0);

  // ---- both eyes in one geometry
  const eyeL = new THREE.SphereGeometry(0.018, 6, 4);
  translate(eyeL, -0.055, 0.02, 0.142);
  const eyeR = new THREE.SphereGeometry(0.018, 6, 4);
  translate(eyeR, 0.055, 0.02, 0.142);
  const eyes = mergeGeometries([eyeL, eyeR])!;

  // ---- arm: sleeve with its own rounded deltoid (kit), forearm + mitt (skin)
  const armKit = loft(SLEEVE, radial, KIT_UV.sleeve, true, false);
  const armSkin = loft(FOREARM, full ? 10 : 6, [0, 0, 1, 1], false, true);

  // ---- leg: shorts leg + sock (kit), thigh + knee (skin), boot
  const legKit = mergeGeometries([
    loft(SHORTS_LEG, radial, KIT_UV.shorts, false, false),
    loft(SOCK, radial, KIT_UV.socks, false, true),
  ])!;
  const legSkin = loft(THIGH, full ? 10 : 6, [0, 0, 1, 1], true, false);

  // boots stay boxy on purpose — a football boot is a wedge, and the one
  // hard-edged shape on the model reads as intent rather than as budget
  const bootBody = new THREE.BoxGeometry(0.125, 0.075, 0.20);
  translate(bootBody, 0, -0.815, 0.03);
  const toe = new THREE.BoxGeometry(0.105, 0.055, 0.08);
  translate(toe, 0, -0.825, 0.155);
  const boot = full ? mergeGeometries([bootBody, toe])! : bootBody;

  const parts: BodyParts = {
    torso, backPanel, skull, hair, eyes, armKit, armSkin, legKit, legSkin, boot,
  };
  bakeAO(parts);
  return parts;
}

/** A curved quad hugging the shirt's back between the shoulder blades. Sampled
 *  off the SHIRT profile and pushed out a few mm so it never z-fights. */
function buildBackPanel(seg: number): THREE.BufferGeometry {
  // A shirt number covers most of the back, from the shoulder blades to the
  // hem — at 1.10..1.40 it sat at chest height and read as a chest patch.
  const Y0 = 1.035, Y1 = 1.425;
  const SPREAD = 0.95; // radians either side of dead centre-back
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const profileAt = (y: number): [number, number] => {
    for (let i = 0; i < SHIRT.length - 1; i++) {
      const a = SHIRT[i], b = SHIRT[i + 1];
      if (y <= a[0] && y >= b[0]) {
        const t = (a[0] - y) / (a[0] - b[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    return [SHIRT[SHIRT.length - 1][1], SHIRT[SHIRT.length - 1][2]];
  };
  const rows = seg, cols = seg;
  for (let r = 0; r <= rows; r++) {
    const fy = r / rows;
    const y = Y1 + (Y0 - Y1) * fy;
    const [hw, hd] = profileAt(y);
    for (let c = 0; c <= cols; c++) {
      const fx = c / cols;
      const th = Math.PI + (fx - 0.5) * 2 * SPREAD;
      const ct = Math.cos(th), st = Math.sin(th);
      const depth = hd * 0.88;
      pos.push(st * (hw + 0.004), y, ct * (depth + 0.004));
      // theta runs anticlockwise past the spine, which from a camera BEHIND
      // the player runs left to right — so u tracks fx directly and the
      // number does not come out mirrored
      uv.push(fx, 1 - fy);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + 1;
      const d = a + cols + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- AO bake

/** Occluder spheres standing in for the body at rest: [x, y, z, radius]. */
const OCCLUDERS: [number, number, number, number][] = [
  [0, 1.72, 0, 0.17],    // head — casts onto the shoulders and the collar
  [0, 1.34, 0, 0.27],    // chest
  [0, 0.93, 0, 0.24],    // pelvis — the shirt hem and the inner thigh
  [-0.295, 1.38, 0, 0.11], // upper arms — the armpit
  [0.295, 1.38, 0, 0.11],
  [-0.13, 0.72, 0, 0.11], // thighs — the inner leg
  [0.13, 0.72, 0, 0.11],
];

/** Where each part sits in body space at rest, so the bake sees one body and
 *  not ten unrelated meshes. Must match the Groups playerMesh.ts builds. */
const PART_ORIGIN: Record<keyof BodyParts, [number, number, number]> = {
  torso: [0, 0, 0],
  backPanel: [0, 0, 0],
  skull: [0, 1.72, 0],
  hair: [0, 1.72, 0],
  eyes: [0, 1.72, 0],
  armKit: [0.295, 1.44, 0],
  armSkin: [0.295, 1.44, 0],
  legKit: [0.13, 0.88, 0],
  legSkin: [0.13, 0.88, 0],
  boot: [0.13, 0.88, 0],
};

const AO_FLOOR = 0.46;
const AO_STRENGTH = 0.85;

function bakeAO(parts: BodyParts): void {
  for (const key of Object.keys(parts) as (keyof BodyParts)[]) {
    const geo = parts[key];
    const [ox, oy, oz] = PART_ORIGIN[key];
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) + ox, py = pos.getY(i) + oy, pz = pos.getZ(i) + oz;
      const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      let occ = 0;
      for (const [cx, cy, cz, r] of OCCLUDERS) {
        const dx = cx - px, dy = cy - py, dz = cz - pz;
        const dist = Math.hypot(dx, dy, dz);
        // inside its own occluder: that sphere IS this part, skip it
        if (dist < r * 0.75) continue;
        const cos = (nx * dx + ny * dy + nz * dz) / dist;
        if (cos <= 0) continue;
        // the solid-angle approximation everyone uses for vertex AO: a disc of
        // radius r at distance d subtends ~r²/d², clamped so contact goes dark
        // but never black
        occ += cos * Math.min(1, (r * r) / (dist * dist));
      }
      // downward-facing surfaces see the ground bounce and not the sky, which
      // is most of what "ambient occlusion" buys on an outdoor character
      occ += Math.max(0, -ny) * 0.30;
      const ao = Math.max(AO_FLOOR, 1 - occ * AO_STRENGTH);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
}

/** The five parts that exist twice per player, mirrored. */
export type LimbPart = 'armKit' | 'armSkin' | 'legKit' | 'legSkin' | 'boot';
export type LimbSet = Record<LimbPart, THREE.BufferGeometry>;

/**
 * Mirror a limb across the body's centre plane. The AO bake above is done at
 * the RIGHT limb's rest position, so the left limb needs a genuinely mirrored
 * copy or its armpit shading lands on the outside of the arm. Winding is
 * reversed with the geometry, because a negative scale on the Group would
 * leave the renderer to sort out front faces and would mirror the animation
 * rotations along with the mesh.
 */
export function mirrorLimbs(parts: BodyParts): LimbSet {
  const keys: LimbPart[] = ['armKit', 'armSkin', 'legKit', 'legSkin', 'boot'];
  const out = {} as LimbSet;
  for (const k of keys) {
    const g = parts[k].clone();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setX(i, -pos.getX(i));
      nrm.setX(i, -nrm.getX(i));
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    idx.needsUpdate = true;
    out[k] = g;
  }
  return out;
}

/** Total triangles in one detail level — for the §7A.9 budget arithmetic. */
export function triangleCount(parts: BodyParts): number {
  let n = 0;
  const per: Record<string, number> = {
    torso: 1, backPanel: 1, skull: 1, hair: 1, eyes: 1,
    armKit: 2, armSkin: 2, legKit: 2, legSkin: 2, boot: 2,
  };
  for (const key of Object.keys(parts) as (keyof BodyParts)[]) {
    const g = parts[key];
    const tris = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    n += tris * per[key];
  }
  return n;
}

export function disposeParts(parts: BodyParts): void {
  for (const key of Object.keys(parts) as (keyof BodyParts)[]) parts[key].dispose();
}
