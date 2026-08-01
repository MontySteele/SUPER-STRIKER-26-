// Studio character viewer (§7A.9): one player model, alone, on a neutral
// three-point-lit set. No stadium, no pitch, no post stack — the rig for
// judging silhouette, proportions, kit colours and shading in isolation.
//
//   viewer.html                       → slow turntable, live in the browser
//   viewer.html?team=bra&angle=side   → one pinned angle, drawn once, then still
//
// Query params: team (3-letter id), angle (front|three_quarter|side|back),
// slot (index into the starting XI), gk (1 = keeper kit + the keeper),
// label (0 = hide the caption, which is what the headless shooter passes).

import * as THREE from 'three';
import { findTeam, pickStartingXI } from '../data/loader';
import { PlayerMesh, resolveKits } from '../render/playerMesh';
import { SIM_DT } from '../sim/constants';
import { installDeterministicEnv } from './determinism';

export type ViewAngle = 'front' | 'three_quarter' | 'side' | 'back';

/**
 * Camera poses around a player standing at the origin facing +x. Every angle
 * shares a distance and a look-at so a four-up contact sheet lines up.
 */
export const ANGLES: Record<ViewAngle, [number, number, number]> = {
  front: [4.4, 1.25, 0],
  three_quarter: [3.56, 1.3, 2.58],
  side: [0, 1.25, 4.4],
  back: [-4.4, 1.25, 0],
};

// low enough that the boots stay in frame on a portrait plate
const LOOK_AT = new THREE.Vector3(0, 0.92, 0);
/** Kit resolution only ever swaps the AWAY side, so a neutral grey opponent
 *  gives back exactly the shirt this team wears at home. */
const NEUTRAL_OPPONENT = { home: '#808080', away: '#808080' };
/** Sim ticks of idle animation before a pinned angle is drawn — enough for the
 *  damped limb pose to settle, and a constant so the still is reproducible. */
const SETTLE_FRAMES = 90;
/** Seed for the shimmed render RNG (skin/hair are hashed from the name, but
 *  the idle limb phase and any UUID minting are not). */
const VIEWER_SEED = 0x5747;

const params = new URLSearchParams(location.search);
const teamId = (params.get('team') ?? 'bra').toLowerCase();
const angleParam = params.get('angle') as ViewAngle | null;
const angle = angleParam && angleParam in ANGLES ? angleParam : null;
const gkMode = params.get('gk') === '1';
const showLabel = params.get('label') !== '0';

const env = installDeterministicEnv(VIEWER_SEED);

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d23);

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 60);

// neutral set: a mid-grey floor disc that catches the key light's shadow, and
// nothing else — anything more would colour-cast the kit under review
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(7, 64),
  new THREE.MeshPhongMaterial({ color: 0x3c4149, shininess: 6 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// three-point rig: warm key front-left, cool fill front-right, hard rim behind
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

// the subject: the real match mesh, with the real kit resolution
const team = findTeam(teamId);
const [outfieldKit, , gkKit] = resolveKits(team.kit, NEUTRAL_OPPONENT);
const xi = pickStartingXI(team);
const slot = gkMode ? 0 : Math.min(Math.max(Number(params.get('slot') ?? xi.length - 1), 0), xi.length - 1);
const player = xi[slot];
const mesh = new PlayerMesh(player, gkMode ? gkKit : outfieldKit);
scene.add(mesh.root);

if (showLabel) {
  const label = document.getElementById('viewer-label');
  if (label) {
    label.textContent = `${team.name.toUpperCase()} · #${player.num} ${player.name}`
      + ` · ${angle ?? 'TURNTABLE'}`;
    label.style.display = 'block';
  }
}

function place(pose: [number, number, number]): void {
  camera.position.set(pose[0], pose[1], pose[2]);
  camera.lookAt(LOOK_AT);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const w = window as unknown as Record<string, unknown>;
w.__ss26ViewerAngles = Object.keys(ANGLES);

if (angle) {
  // pinned: settle the idle pose over a fixed number of fixed-dt ticks, draw
  // once, and stop — no rAF loop, so the frame is a pure function of the query
  place(ANGLES[angle]);
  for (let i = 0; i < SETTLE_FRAMES; i++) {
    mesh.update(SIM_DT, 0, 0, 0, 0, 0, 'none', 0);
    env.advanceClock(SIM_DT * 1000);
  }
  requestAnimationFrame(() => {
    renderer.render(scene, camera);
    requestAnimationFrame(() => { w.__ss26Viewer = { ready: true, angle, team: team.id }; });
  });
} else {
  // live turntable: the model spins, the camera stays on the 3/4 mark
  place(ANGLES.three_quarter);
  let facing = 0;
  let last = env.realNow();
  const loop = (): void => {
    requestAnimationFrame(loop);
    const now = env.realNow();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    facing += dt * 0.5;
    env.advanceClock(dt * 1000);
    mesh.update(dt, 0, 0, 0, facing, 0, 'none', 0);
    renderer.render(scene, camera);
  };
  loop();
  w.__ss26Viewer = { ready: true, angle: null, team: team.id };
}
