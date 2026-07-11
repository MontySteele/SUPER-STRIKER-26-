// The pitch: canvas-painted grass with mowed stripes, line markings, worn
// goalmouths (§7.1), plus goal frames with nets.

import * as THREE from 'three';
import {
  BOX_DEPTH, BOX_HALF_W, CENTER_CIRCLE_R, GOAL_DEPTH, GOAL_HALF_W, GOAL_HEIGHT,
  HALF_L, HALF_W, PENALTY_SPOT, PITCH_LENGTH, PITCH_WIDTH, SIX_DEPTH, SIX_HALF_W,
} from '../sim/constants';

const TEX_W = 2048;
const TEX_H = Math.round(TEX_W * (PITCH_WIDTH + 12) / (PITCH_LENGTH + 12));
const MARGIN = 6; // metres of apron painted into the same texture

function worldToTex(x: number, y: number): [number, number] {
  const u = (x + HALF_L + MARGIN) / (PITCH_LENGTH + MARGIN * 2);
  const v = (y + HALF_W + MARGIN) / (PITCH_WIDTH + MARGIN * 2);
  return [u * TEX_W, v * TEX_H];
}

function mPx(): number {
  return TEX_W / (PITCH_LENGTH + MARGIN * 2);
}

export function buildPitch(scene: THREE.Scene): void {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;

  // base grass + mowed stripes along the length
  const STRIPES = 16;
  for (let i = 0; i < STRIPES; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#2c7a35' : '#256d2e';
    ctx.fillRect((TEX_W / STRIPES) * i, 0, TEX_W / STRIPES + 1, TEX_H);
  }
  // grain noise so the grass doesn't look flat-shaded
  ctx.save();
  for (let i = 0; i < 60000; i++) {
    const x = Math.random() * TEX_W, y = Math.random() * TEX_H;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)';
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.restore();

  // worn goalmouths + centre circle wear
  for (const gx of [-HALF_L, HALF_L]) {
    const [cx, cy] = worldToTex(gx, 0);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 7 * mPx());
    g.addColorStop(0, 'rgba(148,124,72,0.55)');
    g.addColorStop(0.6, 'rgba(148,124,72,0.22)');
    g.addColorStop(1, 'rgba(148,124,72,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 8 * mPx(), cy - 8 * mPx(), 16 * mPx(), 16 * mPx());
  }
  {
    const [cx, cy] = worldToTex(0, 0);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 4 * mPx());
    g.addColorStop(0, 'rgba(148,124,72,0.3)');
    g.addColorStop(1, 'rgba(148,124,72,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 5 * mPx(), cy - 5 * mPx(), 10 * mPx(), 10 * mPx());
  }

  // markings
  ctx.strokeStyle = 'rgba(250,250,250,0.92)';
  ctx.lineWidth = 0.13 * mPx() * 2;
  ctx.lineCap = 'round';

  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    const [a, b] = worldToTex(x1, y1);
    const [c, d] = worldToTex(x2, y2);
    ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
  };
  const rect = (x: number, y: number, w: number, h: number): void => {
    line(x, y, x + w, y); line(x + w, y, x + w, y + h);
    line(x + w, y + h, x, y + h); line(x, y + h, x, y);
  };
  const circle = (x: number, y: number, r: number, a0 = 0, a1 = Math.PI * 2): void => {
    const [cx, cy] = worldToTex(x, y);
    ctx.beginPath(); ctx.arc(cx, cy, r * mPx(), a0, a1); ctx.stroke();
  };
  const spot = (x: number, y: number): void => {
    const [cx, cy] = worldToTex(x, y);
    ctx.beginPath(); ctx.arc(cx, cy, 0.22 * mPx(), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(250,250,250,0.92)'; ctx.fill();
  };

  rect(-HALF_L, -HALF_W, PITCH_LENGTH, PITCH_WIDTH);
  line(0, -HALF_W, 0, HALF_W);
  circle(0, 0, CENTER_CIRCLE_R);
  spot(0, 0);
  for (const s of [1, -1]) {
    const gx = HALF_L * s;
    rect(gx - BOX_DEPTH * s, -BOX_HALF_W, BOX_DEPTH * s, BOX_HALF_W * 2);
    rect(gx - SIX_DEPTH * s, -SIX_HALF_W, SIX_DEPTH * s, SIX_HALF_W * 2);
    spot(gx - PENALTY_SPOT * s, 0);
    // penalty arc
    const a = s > 0 ? Math.PI * 0.65 : -Math.PI * 0.35;
    circle(gx - PENALTY_SPOT * s, 0, CENTER_CIRCLE_R, a, a + Math.PI * 0.7);
    // corner arcs
    circle(gx, -HALF_W, 1, 0, Math.PI * 2);
    circle(gx, HALF_W, 1, 0, Math.PI * 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mat = new THREE.MeshPhongMaterial({
    map: tex,
    specular: new THREE.Color(0x2a3a2a),
    shininess: 18, // floodlight sheen (§7.1)
  });
  const geo = new THREE.PlaneGeometry(PITCH_LENGTH + MARGIN * 2, PITCH_WIDTH + MARGIN * 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // dark surround so the pitch reads as an island of light
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 480),
    new THREE.MeshPhongMaterial({ color: 0x101816 }),
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.05;
  surround.receiveShadow = true;
  scene.add(surround);

  buildGoal(scene, 1);
  buildGoal(scene, -1);
}

function makeNetTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 128; i += 10) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildGoal(scene: THREE.Scene, side: number): void {
  const group = new THREE.Group();
  const postMat = new THREE.MeshPhongMaterial({ color: 0xf8f8f8, shininess: 60 });
  const r = 0.07;
  const postGeo = new THREE.CylinderGeometry(r, r, GOAL_HEIGHT, 10);
  for (const y of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(0, GOAL_HEIGHT / 2, y);
    post.castShadow = true;
    group.add(post);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, GOAL_HALF_W * 2 + r * 2, 10), postMat);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(0, GOAL_HEIGHT, 0);
  bar.castShadow = true;
  group.add(bar);

  // net: back + sides + roof, semi-transparent grid
  const netTex = makeNetTexture();
  const netMat = new THREE.MeshBasicMaterial({
    map: netTex, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_HALF_W * 2, GOAL_HEIGHT), netMat);
  (back.material as THREE.MeshBasicMaterial).map!.repeat.set(6, 2);
  back.rotation.y = Math.PI / 2;
  back.position.set(GOAL_DEPTH, GOAL_HEIGHT / 2, 0);
  group.add(back);
  for (const y of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HEIGHT), netMat);
    sideNet.position.set(GOAL_DEPTH / 2, GOAL_HEIGHT / 2, y);
    group.add(sideNet);
  }
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HALF_W * 2), netMat);
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = Math.PI / 2;
  roof.position.set(GOAL_DEPTH / 2, GOAL_HEIGHT, 0);
  group.add(roof);

  group.position.x = HALF_L * side;
  if (side < 0) group.rotation.y = Math.PI;
  scene.add(group);
}
