// Model lab (§7A.9, skinned-character pipeline).
//
// The studio viewer's neutral three-point set, but instead of the procedural
// match mesh it loads a rigged glTF character straight off disk. It exists to
// answer one question: does an authored, skinned, textured character hold up
// under THIS engine's lighting and tone mapping, before any of it is wired
// into the sim?
//
//   modellab.html                                 → live turntable
//   modellab.html?angle=front&pose=kick&capture=1 → one still, drawn once
//
// Query params:
//   angle    front | three_quarter | side | back | face
//   pose     apose (as authored) | stand | kick
//   capture  1 = draw exactly once, then publish window.__ss26ModelLab
//   label    0 = hide the stats caption (what the headless shooter passes)
//   model    override the GLB url (default models/players/p1.glb)
//   hide     comma-separated mesh-name substrings to omit, for pulling a
//            layered character apart when a seam looks wrong
//   clip     retargeted animation to play on the rig, from models/anim/<clip>.glb
//            (a clip overrides `pose` — the animation owns the skeleton)
//   t        seconds to seek the clip to, for a deterministic still
//   loop     1 = play the clip live instead of holding a single frame
//
// Nothing here touches the renderer, the sim or the match scene; it only reads
// the two shared helpers it needs (the sky bake and the shader-patch queue) so
// the lighting is the same lighting the players ship under.

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyShaderPatches } from '../render/materials';
import {
  findBone, fixCharacterMaterial, normaliseBoneName, pickClip, rebindClip, tuckUnder,
} from '../render/characterAssets';
import { bakeSkyEnvironment } from '../render/sky';
import { installDeterministicEnv } from './determinism';

export type LabAngle = 'front' | 'three_quarter' | 'side' | 'back' | 'face';
export type LabPose = 'apose' | 'stand' | 'kick';

/**
 * The viewer's camera poses, verbatim, around a subject standing at the origin
 * facing +x — plus a head close-up. Only the DIRECTION of each entry is used:
 * the distance is refit per pose from the actual skinned bounds so a kicking
 * leg cannot walk out of frame on a 16:9 plate. Keeping the numbers identical
 * to viewer.ts means a model-lab sheet and a viewer sheet line up by eye.
 */
export const ANGLES: Record<LabAngle, [number, number, number]> = {
  front: [4.4, 1.25, 0],
  three_quarter: [3.56, 1.3, 2.58],
  side: [0, 1.25, 4.4],
  back: [-4.4, 1.25, 0],
  face: [3.2, 1.95, 1.3],
};

/** The viewer's look-at; here it is only the pivot the angle vectors point at. */
const LOOK_AT = new THREE.Vector3(0, 0.92, 0);
/** Breathing room around the fitted bounds, as a fraction of the fitted size. */
const FIT_MARGIN = 1.1;
/** Same seed family as the viewer so any incidental RNG matches. */
const LAB_SEED = 0x5748;
const DEFAULT_MODEL = 'models/players/p1.glb';
/** Frames walked to size a clip's camera. Enough to catch a fully extended kick
 *  without making the one-shot survey cost real time. */
const CLIP_SURVEY_SAMPLES = 16;

const params = new URLSearchParams(location.search);
const angleParam = params.get('angle') as LabAngle | null;
const angle: LabAngle | null = angleParam && angleParam in ANGLES ? angleParam : null;
const poseParam = params.get('pose') as LabPose | null;
const pose: LabPose = poseParam === 'stand' || poseParam === 'kick' || poseParam === 'apose'
  ? poseParam : 'apose';
const captureMode = params.get('capture') === '1';
const showLabel = params.get('label') !== '0';
const modelUrl = params.get('model') ?? DEFAULT_MODEL;
const clipName = params.get('clip');
const clipTime = Number(params.get('t') ?? 0) || 0;
const clipLoop = params.get('loop') === '1';
/** Comma-separated mesh-name substrings to leave out — for pulling a layered
 *  character apart when a seam looks wrong (?hide=jean_shorts,short02). */
const hidden = (params.get('hide') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const env = installDeterministicEnv(LAB_SEED);

// ----------------------------------------------------------------- renderer
// Identical to viewer.ts: ACES, exposure 1.05, soft shadows, WebGL2 only.

const canvas = document.getElementById('lab-canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d23);

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 60);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(7, 64),
  new THREE.MeshPhongMaterial({ color: 0x3c4149, shininess: 6 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// the viewer's three-point rig, unchanged: warm key front-left, cool fill
// front-right, hard rim behind
const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
key.position.set(4.5, 5.2, 3.5);
key.castShadow = true;
{
  const sc = key.shadow.camera;
  sc.left = -3; sc.right = 3; sc.top = 3.5; sc.bottom = -1;
  sc.near = 1; sc.far = 20;
  sc.updateProjectionMatrix();
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0009;
}
const fill = new THREE.DirectionalLight(0xbcd2ff, 0.75);
fill.position.set(-3.5, 2.4, 4);
const rim = new THREE.DirectionalLight(0xffffff, 1.6);
rim.position.set(-2.5, 3.4, -4.5);
scene.add(key, key.target, fill, rim);
scene.add(new THREE.HemisphereLight(0xdfe6f2, 0x1b1e24, 0.35));

const studioEnv = bakeSkyEnvironment(renderer, {
  zenith: 0x8b909a, horizon: 0x6d727b, ground: 0x3a3e45,
  sun: 0xffffff, sunIntensity: 0, sunSize: 0.02, haze: 0.2,
  sunDir: new THREE.Vector3(0, 1, 0),
});
scene.environment = studioEnv.texture;
scene.environmentIntensity = 0.7;

/** The subject wrapper. Poses are authored in the GLB's own space (character
 *  faces +z), then the wrapper yaws it to face +x like every other studio
 *  plate — so pose maths never has to know which way the plate is pointing. */
const subject = new THREE.Group();
scene.add(subject);

// ---------------------------------------------------------------- materials

// The material surgery, the garment tuck, the bone lookup and the clip
// rebinding all live in render/characterAssets.ts now — the match players run
// through exactly the same code, which is the only way a studio plate stays
// evidence about what ships. This file keeps only the texture bookkeeping the
// caption needs.

interface TexInfo { name: string; width: number; height: number; }

const textures = new Map<THREE.Texture, TexInfo>();

function noteTexture(tex: THREE.Texture | null | undefined, label: string): void {
  if (!tex) return;
  const img = tex.image as { width?: number; height?: number } | undefined;
  if (!textures.has(tex)) {
    textures.set(tex, { name: label, width: img?.width ?? 0, height: img?.height ?? 0 });
  }
}

function fixMaterial(mat: THREE.Material, meshName: string): void {
  const std = mat as THREE.MeshStandardMaterial;
  const id = `${meshName} ${mat.name}`;
  fixCharacterMaterial(std, meshName, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  noteTexture(std.map, std.map?.name || `${id} base`);
  noteTexture(std.emissiveMap, std.emissiveMap?.name || `${id} emissive`);
  noteTexture(std.normalMap, std.normalMap?.name || `${id} normal`);
  noteTexture(std.roughnessMap, std.roughnessMap?.name || `${id} rough`);
  noteTexture(std.metalnessMap, std.metalnessMap?.name || `${id} metal`);
  noteTexture(std.aoMap, std.aoMap?.name || `${id} ao`);
  applyShaderPatches(std);
}

// -------------------------------------------------------------------- poses

/** Rotate a bone so that `from` (a direction in subject space) ends up along
 *  `to`. Convention-free: it never assumes which local axis runs down a bone,
 *  so it survives any rig that keeps the Mixamo NAMES but not its axes. */
function aimBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  const world = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const parentQ = new THREE.Quaternion();
  (bone.parent ?? bone).getWorldQuaternion(parentQ);
  const localAxisQ = parentQ.clone().invert().multiply(world).multiply(parentQ);
  bone.quaternion.premultiply(localAxisQ);
  bone.updateMatrixWorld(true);
}

/** Bone lookup by Mixamo name, spelled however the loader left it — see
 *  characterAssets.normaliseBoneName for why a literal name never matches. */
const normalise = normaliseBoneName;
const bone = findBone;

/** Current world-space direction from one joint to the next. */
function boneDir(a: THREE.Object3D, b: THREE.Object3D): THREE.Vector3 {
  const pa = a.getWorldPosition(new THREE.Vector3());
  const pb = b.getWorldPosition(new THREE.Vector3());
  return pb.sub(pa).normalize();
}

/** Joints a pose asked for and could not find — surfaced, never swallowed. */
const missing: string[] = [];

/** Point a joint at a target direction, given its child joint. */
function point(root: THREE.Object3D, boneName: string, childName: string, to: THREE.Vector3): void {
  const joint = bone(root, boneName);
  const child = bone(root, childName);
  if (!joint || !child) { missing.push(boneName); return; }
  root.updateMatrixWorld(true);
  aimBone(joint, boneDir(joint, child), to);
}

function applyPose(root: THREE.Object3D, which: LabPose): void {
  if (which === 'apose') return;
  root.updateMatrixWorld(true);

  // which way is the character's left? read it off the rig rather than assume
  const lArm = bone(root, 'mixamorig:LeftArm');
  const leftX = lArm ? Math.sign(lArm.getWorldPosition(new THREE.Vector3()).x) || 1 : 1;
  const L = leftX; // +1 or -1 along x
  const F = 1; // the GLB's forward is +z; the wrapper yaws it to +x afterwards

  if (which === 'stand') {
    // arms down the sides, a few degrees out so they clear the hips
    const down = (s: number): THREE.Vector3 => new THREE.Vector3(s * 0.16, -0.986, 0.02);
    point(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', down(L));
    point(root, 'mixamorig:RightArm', 'mixamorig:RightForeArm', down(-L));
    // forearms hang straight, with a hint of elbow so they do not read as sticks
    point(root, 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', new THREE.Vector3(L * 0.1, -0.985, F * 0.14));
    point(root, 'mixamorig:RightForeArm', 'mixamorig:RightHand', new THREE.Vector3(-L * 0.1, -0.985, F * 0.14));
    return;
  }

  // kick: right thigh swung ~60° forward of vertical, knee bent, plant leg
  // straight, torso leaned back to counterweight, arms out for balance
  point(root, 'mixamorig:RightUpLeg', 'mixamorig:RightLeg',
    new THREE.Vector3(-L * 0.06, -Math.cos(THREE.MathUtils.degToRad(60)), F * Math.sin(THREE.MathUtils.degToRad(60))));
  point(root, 'mixamorig:RightLeg', 'mixamorig:RightFoot', new THREE.Vector3(-L * 0.04, -0.94, F * 0.34));
  point(root, 'mixamorig:RightFoot', 'mixamorig:RightToeBase', new THREE.Vector3(0, -0.28, F * 0.96));
  point(root, 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', new THREE.Vector3(L * 0.1, -0.98, -F * 0.17));
  point(root, 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', new THREE.Vector3(L * 0.04, -0.995, F * 0.09));

  // lean back ~14° through the two lower spine joints
  point(root, 'mixamorig:Spine', 'mixamorig:Spine1', new THREE.Vector3(0, 0.985, -F * 0.17));
  point(root, 'mixamorig:Spine1', 'mixamorig:Spine2', new THREE.Vector3(0, 0.994, -F * 0.11));

  // arms out: left (opposite the kicking foot) forward and out, right swept back
  point(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', new THREE.Vector3(L * 0.72, -0.3, F * 0.62));
  point(root, 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', new THREE.Vector3(L * 0.52, 0.22, F * 0.82));
  point(root, 'mixamorig:RightArm', 'mixamorig:RightForeArm', new THREE.Vector3(-L * 0.8, -0.34, -F * 0.5));
  point(root, 'mixamorig:RightForeArm', 'mixamorig:RightHand', new THREE.Vector3(-L * 0.62, 0.05, -F * 0.78));
}

// ------------------------------------------------------------------ framing

/** Bounds of the SKINNED result. Box3.setFromObject reads bind-pose geometry
 *  and would frame a kicking leg as if it were still in the A-pose, so walk
 *  the skinned vertices instead (once, off the back of one pose). */
function skinnedBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const sk = obj as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh) {
      const n = sk.geometry.getAttribute('position').count;
      for (let i = 0; i < n; i++) {
        sk.getVertexPosition(i, v);
        box.expandByPoint(v.applyMatrix4(sk.matrixWorld));
      }
    } else if ((obj as THREE.Mesh).isMesh) {
      box.expandByObject(obj);
    }
  });
  return box;
}

/** Place the camera along `dir` at the distance that just contains `box`. */
function frame(box: THREE.Box3, dir: THREE.Vector3, margin: number): void {
  const centre = box.getCenter(new THREE.Vector3());
  const d = dir.clone().normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
  const up = new THREE.Vector3().crossVectors(d, right).normalize();

  const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const hTan = vTan * camera.aspect;

  let halfH = 0, halfW = 0, depth = 0;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      .sub(centre);
    halfH = Math.max(halfH, Math.abs(c.dot(up)));
    halfW = Math.max(halfW, Math.abs(c.dot(right)));
    depth = Math.max(depth, c.dot(d));
  }
  const dist = Math.max((halfH * margin) / vTan, (halfW * margin) / hTan) + depth;
  camera.position.copy(centre).addScaledVector(d, dist);
  camera.lookAt(centre);
  // Pull the near plane right up to the subject. MakeHuman-lineage garments sit
  // a fraction of a millimetre off the body, so with a loose near plane the
  // depth buffer cannot separate a sleeve from the arm inside it and the seams
  // break up into speckle. far still has to clear the 7m floor disc that
  // catches the key light's shadow.
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  camera.near = Math.max(0.02, dist - radius * 1.3);
  camera.far = dist + radius + 20;
  camera.updateProjectionMatrix();
}

/** A tight box around the head, for the face close-up. */
function headBounds(root: THREE.Object3D, body: THREE.Box3): THREE.Box3 {
  const head = bone(root, 'mixamorig:Head');
  if (!head) return body;
  const p = head.getWorldPosition(new THREE.Vector3());
  // the Mixamo Head joint sits at the base of the skull, so the joint-to-crown
  // span is very close to half a head: frame twice that, centred on the span,
  // and the close-up lands on the face with the chin and a little neck in shot
  const span = Math.max(0.08, body.max.y - p.y);
  const half = span * 0.68;
  const centre = new THREE.Vector3(p.x, p.y + span * 0.46, p.z);
  return new THREE.Box3().setFromCenterAndSize(centre, new THREE.Vector3(half * 2, half * 2, half * 2));
}

// ------------------------------------------------------------------- clips

// rebindClip() and pickClip() are shared with the match players — see
// render/characterAssets.ts.

/** World position of the rig's root joint — what the camera tracks. */
function hipsOf(root: THREE.Object3D): THREE.Vector3 {
  const h = bone(root, 'mixamorig:Hips') ?? root;
  return h.getWorldPosition(new THREE.Vector3());
}

interface ClipSurvey {
  /** Union of the skinned bounds over the clip, expressed RELATIVE TO THE HIPS,
   *  so a camera parked at hips+centre holds a constant size while the
   *  character runs away across the floor. */
  hull: THREE.Box3;
  /** Lowest skinned vertex over the sampled clip, in world y. */
  floorMinY: number;
}

/**
 * Walk the clip once and measure it. Framing off a single frame either clips a
 * swinging leg or leaves the subject tiny, and re-fitting per frame makes a
 * 6-up strip breathe; one hull over the whole clip fixes both.
 */
function surveyClip(mixer: THREE.AnimationMixer, clip: THREE.AnimationClip, samples: number): ClipSurvey {
  const hull = new THREE.Box3();
  let floorMinY = Infinity;
  for (let i = 0; i < samples; i++) {
    mixer.setTime(samples > 1 ? (clip.duration * i) / (samples - 1) : 0);
    subject.updateMatrixWorld(true);
    const b = skinnedBounds(subject);
    const h = hipsOf(subject);
    hull.expandByPoint(b.min.clone().sub(h));
    hull.expandByPoint(b.max.clone().sub(h));
    floorMinY = Math.min(floorMinY, b.min.y);
  }
  return { hull, floorMinY };
}

// ------------------------------------------------------------------ loading

interface LabStats {
  triangles: number;
  drawCalls: number;
  skinnedMeshes: number;
  bones: number;
  textures: number;
  textureSizes: string[];
  loadMs: number;
  modelHeight: number;
  vertices: number;
  /** Populated only when ?clip= is in play. */
  clip?: string;
  clipLoadMs?: number;
  clipDuration?: number;
  clipTracks?: number;
  /** Tracks whose target joint is not in the character rig — should be []. */
  clipUnbound?: string[];
  clipTime?: number;
  /** Hips xz travel from t=0 to this frame, in metres: proof of root motion. */
  rootMotion?: number;
  /** Lowest skinned vertex this frame; negative means a foot is under the floor. */
  footY?: number;
  /** Lowest skinned vertex anywhere in the clip, sampled. */
  clipFloorMinY?: number;
}

const w = window as unknown as Record<string, unknown>;
w.__ss26ModelLabAngles = Object.keys(ANGLES);
w.__ss26ModelLabPoses = ['apose', 'stand', 'kick'];

const t0 = env.realNow();
const loader = new GLTFLoader();

// A v2 archetype ships four haircuts in one GLB and the match loader drops
// three of them the moment a player is cloned (characterAssets.ts). The lab
// loads the raw file, so it has to do the same or it photographs a man in
// four wigs. The pool's `hair` list is the authority; `?hair=N` picks a cut.
const hairPick = Math.max(0, Number(params.get('hair') ?? 0) || 0);
const saneName = (s: string): string => s.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
const spareHair: Promise<Set<string>> = (async () => {
  try {
    const r = await fetch(modelUrl.replace(/(_lod\d)?\.glb$/i, '') + '_faces.json');
    if (!r.ok) return new Set<string>();
    const file = (await r.json()) as { hair?: string[] };
    const hair = (file.hair ?? []).map(saneName);
    return new Set(hair.filter((_, i) => i !== Math.min(hairPick, hair.length - 1)));
  } catch {
    return new Set<string>();
  }
})();

loader.load(modelUrl, async (gltf) => {
  const loadMs = Math.round((env.realNow() - t0) * 10) / 10;
  const root = gltf.scene;
  const spare = await spareHair;

  let skinnedMeshes = 0;
  let vertices = 0;
  let triangles = 0;
  const skeletons = new Set<THREE.Skeleton>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (hidden.some((h) => mesh.name.toLowerCase().includes(h))) { mesh.visible = false; return; }
    if (spare.has(saneName(mesh.name))) { mesh.visible = false; return; }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // a skinned mesh's bind-pose bounds do not cover a posed limb; three then
    // culls the whole character out of a tight close-up
    mesh.frustumCulled = false;
    const sk = obj as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh) {
      skinnedMeshes++;
      if (sk.skeleton) skeletons.add(sk.skeleton);
    }
    const posAttr = mesh.geometry.getAttribute('position');
    vertices += posAttr.count;
    const idx = mesh.geometry.getIndex();
    triangles += (idx ? idx.count : posAttr.count) / 3;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      fixMaterial(m, mesh.name);
    }
  });

  let bones = 0;
  for (const s of skeletons) bones += s.bones.length;

  // sink the waistband under the shirt hem (see tuckUnder for why)
  let outerTop: THREE.Mesh | undefined;
  let innerBottom: THREE.Mesh | undefined;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (/shirt|jersey|top/i.test(m.name)) outerTop ??= m;
    if (/shorts|jeans|trouser/i.test(m.name)) innerBottom ??= m;
  });
  if (outerTop && innerBottom) tuckUnder(innerBottom, outerTop, 0.02, 0.015);

  // pose in the GLB's own frame (character faces +z), then yaw to face +x.
  // A clip owns the whole skeleton, so the hand-authored poses stand aside.
  subject.rotation.set(0, 0, 0);
  subject.add(root);
  subject.updateMatrixWorld(true);
  if (!clipName) applyPose(root, pose);
  subject.rotation.y = Math.PI / 2;
  subject.updateMatrixWorld(true);
  if (missing.length) console.warn('model lab: pose joints not found:', missing.join(', '));

  const stats: LabStats = {
    triangles: Math.round(triangles),
    drawCalls: 0,
    skinnedMeshes,
    bones,
    textures: textures.size,
    textureSizes: [...textures.values()].map((t) => `${t.name} ${t.width}x${t.height}`),
    loadMs,
    modelHeight: 0,
    vertices,
  };

  if (clipName) {
    const clipUrl = `models/anim/${clipName}.glb`;
    const c0 = env.realNow();
    loader.load(clipUrl, (anim: GLTF) => {
      stats.clipLoadMs = Math.round((env.realNow() - c0) * 10) / 10;
      const clip = pickClip(anim.animations, clipName);
      if (!clip) {
        console.error('model lab: no animation in', clipUrl);
        w.__ss26ModelLab = { ready: false, error: `no animation in ${clipUrl}` };
        return;
      }
      // The clip GLBs still carry the rig AND the meshes today and will be cut
      // down to armature + animation shortly. Either way only gltf.animations is
      // touched: anim.scene is never added to anything, so a clip file with no
      // meshes at all works exactly the same.
      stats.clip = clip.name;
      stats.clipDuration = Math.round(clip.duration * 1000) / 1000;
      stats.clipTracks = clip.tracks.length;
      stats.clipUnbound = rebindClip(clip, root, anim.scene);
      if (stats.clipUnbound.length) console.warn('model lab: unbound tracks:', stats.clipUnbound.join(', '));
      const mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      run(mixer, clip);
    }, undefined, (err) => {
      console.error('model lab: failed to load clip', clipUrl, err);
      w.__ss26ModelLab = { ready: false, error: String(err) };
    });
  } else {
    run(null, null);
  }

  function run(mixer: THREE.AnimationMixer | null, clip: THREE.AnimationClip | null): void {
    let hull: THREE.Box3 | null = null;
    let origin = new THREE.Vector3();

    if (mixer && clip) {
      // ground and centre on the clip's FIRST frame, then never touch the
      // transform again: the hips track is what has to move the character
      // across the floor, and re-centring per frame would eat exactly the root
      // motion this page exists to check.
      mixer.setTime(0);
      subject.updateMatrixWorld(true);
      const first = skinnedBounds(subject);
      const h0 = hipsOf(subject);
      subject.position.x -= h0.x;
      subject.position.z -= h0.z;
      subject.position.y -= first.min.y;
      subject.updateMatrixWorld(true);

      const survey = surveyClip(mixer, clip, CLIP_SURVEY_SAMPLES);
      hull = survey.hull;
      stats.clipFloorMinY = Math.round(survey.floorMinY * 1000) / 1000;
      stats.modelHeight = Math.round((hull.max.y - hull.min.y) * 1000) / 1000;
      mixer.setTime(0);
      subject.updateMatrixWorld(true);
      origin = hipsOf(subject);
    } else {
      // drop the feet onto the floor disc and centre the subject on the origin
      const raw = skinnedBounds(subject);
      subject.position.x -= (raw.min.x + raw.max.x) / 2;
      subject.position.z -= (raw.min.z + raw.max.z) / 2;
      subject.position.y -= raw.min.y;
      subject.updateMatrixWorld(true);
      hull = null;
      stats.modelHeight = Math.round((skinnedBounds(subject).max.y - skinnedBounds(subject).min.y) * 1000) / 1000;
    }

    const still = hull ? null : skinnedBounds(subject);

    // aim the key light's shadow at the subject rather than the world origin
    key.target.position.set(0, stats.modelHeight * 0.5, 0);
    key.target.updateMatrixWorld(true);

    /** Bounds to frame right now: fixed for a static pose, hips-tracking for a
     *  clip (constant size, moving centre). */
    function liveBounds(): THREE.Box3 {
      if (!hull) return still as THREE.Box3;
      return hull.clone().translate(hipsOf(subject));
    }

    function aim(a: LabAngle): void {
      const body = liveBounds();
      const box = a === 'face' ? headBounds(subject, body) : body;
      const pivot = a === 'face' ? box.getCenter(new THREE.Vector3()) : LOOK_AT;
      const dir = new THREE.Vector3(...ANGLES[a]).sub(pivot);
      frame(box, dir, a === 'face' ? 1.04 : FIT_MARGIN);
    }

    /** Per-frame measurements the shooter records alongside the plate. */
    function measure(): void {
      if (!hull) return;
      const b = skinnedBounds(subject);
      stats.footY = Math.round(b.min.y * 1000) / 1000;
      stats.rootMotion = Math.round(hipsOf(subject).setY(0).distanceTo(origin.clone().setY(0)) * 1000) / 1000;
    }

    function caption(): void {
      const el = document.getElementById('lab-label');
      if (!el || !showLabel) return;
      const sizes = [...new Set(stats.textureSizes.map((t) => t.split(' ').pop()))].join(', ');
      const lines = [
        `MODEL LAB · ${modelUrl.split('/').pop()} · ${angle ?? 'TURNTABLE'}`
          + ` · ${stats.clip ? `CLIP ${stats.clip}` : pose.toUpperCase()}`,
        `tris ${stats.triangles.toLocaleString()} · verts ${stats.vertices.toLocaleString()}`
          + ` · draws ${stats.drawCalls} · skinned meshes ${stats.skinnedMeshes} · bones ${stats.bones}`,
        `textures ${stats.textures} [${sizes}] · height ${stats.modelHeight}m · glb load ${stats.loadMs}ms`,
      ];
      if (stats.clip) {
        lines.push(`clip ${stats.clipDuration}s · ${stats.clipTracks} tracks`
          + ` · ${stats.clipUnbound?.length ?? 0} unbound · load ${stats.clipLoadMs}ms`
          + ` · t=${(stats.clipTime ?? 0).toFixed(2)}s · travel ${stats.rootMotion}m · foot y ${stats.footY}`);
      }
      el.textContent = lines.join('\n');
      el.style.display = 'block';
    }

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      renderer.setSize(window.innerWidth, window.innerHeight);
      aim(angle ?? 'three_quarter');
    });

    const live = clipLoop || (!captureMode && !mixer);

    if (!live) {
      // one deterministic draw, then the flag the harness waits on. Two frames:
      // the first compiles every program and populates renderer.info, the second
      // is the frame that gets screenshotted with the real stats on the caption.
      if (mixer) {
        mixer.setTime(clipTime);
        subject.updateMatrixWorld(true);
        stats.clipTime = Math.round(clipTime * 1000) / 1000;
      }
      measure();
      aim(angle ?? 'three_quarter');
      renderer.render(scene, camera);
      stats.drawCalls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      caption();
      requestAnimationFrame(() => {
        renderer.render(scene, camera);
        requestAnimationFrame(() => {
          w.__ss26ModelLab = { ready: true, angle, pose, clip: stats.clip ?? null, t: stats.clipTime ?? null, stats };
        });
      });
    } else {
      aim(angle ?? 'three_quarter');
      let spin = 0;
      let last = env.realNow();
      const loop = (): void => {
        requestAnimationFrame(loop);
        const now = env.realNow();
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        env.advanceClock(dt * 1000);
        if (mixer) {
          mixer.update(dt);
          subject.updateMatrixWorld(true);
          stats.clipTime = Math.round(mixer.time * 1000) / 1000;
          aim(angle ?? 'three_quarter');
        } else if (!angle) {
          spin += dt * 0.5;
          subject.rotation.y = Math.PI / 2 + spin;
        }
        renderer.render(scene, camera);
        if (!stats.drawCalls) {
          stats.drawCalls = renderer.info.render.calls;
          stats.triangles = renderer.info.render.triangles;
        }
        caption();
      };
      loop();
      w.__ss26ModelLab = { ready: true, angle, pose, clip: stats.clip ?? null, t: null, stats };
    }
  }
}, undefined, (err) => {
  console.error('model lab: failed to load', modelUrl, err);
  w.__ss26ModelLab = { ready: false, error: String(err) };
});
