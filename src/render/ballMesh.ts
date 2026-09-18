// Thick, readable ball (§2) with classic panels and a contact shadow.
//
// The ball is the one object in the game that is always in frame, always
// moving, and regularly two metres from the lens in a replay — so it is the
// one object where a 256px albedo and a 16-segment silhouette are visible as
// what they are. It gets:
//
//  • a 1024x512 panel albedo with soft-edged pentagons and printed seams,
//  • a NORMAL map Sobel'd from the same seam mask, so the stitching catches
//    the key instead of being a painted line,
//  • a roughness map that makes the panels glossier than the seams,
//  • a 32x24 sphere (2.2k tris — the crowd spends 200k) so the silhouette is
//    round at replay distance,
//  • and a contact shadow with an actual falloff instead of a hard disc.

import * as THREE from 'three';
import { BALL_RADIUS } from '../sim/constants';
import { maxAnisotropy } from './materials';

const VISUAL_SCALE = 1.5; // chunky for readability; physics stays honest

const TEX_W = 1024;
const TEX_H = 512;
/** Pentagon spot centres in the same lattice the v1 texture used. */
const ROWS = 3;
const COLS = 6;

export class BallMesh {
  root = new THREE.Group();
  private sphere: THREE.Mesh;
  private blob: THREE.Mesh;
  private prev = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const { map, normalMap, roughnessMap } = makeBallMaps();
    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS * VISUAL_SCALE, 32, 24),
      // glossy panels: with the PMREM sky in play this is the one moving
      // specular in the frame, and the §7A.6 bloom is tuned to catch it
      new THREE.MeshStandardMaterial({
        map,
        normalMap,
        // the seams are ~1mm of relief on a 22cm ball; anything stronger and
        // the ball reads as a golf ball at a metre
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughnessMap,
        roughness: 1,      // the map carries the real value
        metalness: 0.02,
      }),
    );
    this.sphere.castShadow = true;
    this.root.add(this.sphere);

    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 2.0, 24),
      new THREE.MeshBasicMaterial({
        map: contactShadowTexture(),
        color: 0x000000,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    // the CSM cascade already draws the ball's real shadow; this is the
    // ambient-occlusion contact under it, so it renders after the pitch
    this.blob.renderOrder = 1;
    scene.add(this.blob);
    scene.add(this.root);
  }

  update(x: number, y: number, z: number): void {
    this.root.position.set(x, z, y);
    // roll from horizontal travel
    const cur = new THREE.Vector3(x, z, y);
    const delta = cur.clone().sub(this.prev);
    this.prev.copy(cur);
    const horiz = new THREE.Vector3(delta.x, 0, delta.z);
    const distMoved = horiz.length();
    if (distMoved > 1e-5) {
      const axis = new THREE.Vector3(0, 1, 0).cross(horiz).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, distMoved / (BALL_RADIUS * VISUAL_SCALE));
      this.sphere.quaternion.premultiply(q);
    }
    // contact shadow fades and shrinks with height
    this.blob.position.set(x, 0.02, y);
    const h = Math.max(z - BALL_RADIUS, 0);
    const s = Math.max(1 - h / 8, 0.25);
    this.blob.scale.setScalar(s);
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.4 * Math.max(1 - h / 10, 0.15);
  }
}

// ----------------------------------------------------------------- textures

interface BallMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/** Trace one pentagon at (x, y) with radius r into the current path. */
function pentagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Walk the pentagon lattice once; every map is painted from the same walk so
 *  albedo, seams and gloss can never drift apart. */
function eachPanel(fn: (x: number, y: number, r: number) => void): void {
  const cellW = TEX_W / COLS;
  const cellH = TEX_H / (ROWS + 0.4);
  const r = cellW * 0.25;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      fn(col * cellW + (row % 2) * cellW * 0.5 + cellW * 0.5,
        cellH * 0.8 + row * cellH, r);
    }
  }
}

function makeBallMaps(): BallMaps {
  // ---- albedo: off-white leather, black pentagons, printed seam lines
  const [albedoC, a] = canvas2d(TEX_W, TEX_H);
  a.fillStyle = '#f2f2ee';
  a.fillRect(0, 0, TEX_W, TEX_H);
  eachPanel((x, y, r) => {
    a.fillStyle = '#16191e';
    pentagon(a, x, y, r);
    a.fill();
    // a hair of relief on the panel edge: a real ball's panels are stitched
    // proud of the seam, and this is what sells the size of the thing
    a.strokeStyle = 'rgba(255,255,255,0.10)';
    a.lineWidth = Math.max(1, r * 0.06);
    a.stroke();
  });
  // the seam grid between panels, printed faintly so the ball is not a plain
  // white field between the spots
  a.strokeStyle = 'rgba(120,124,132,0.45)';
  a.lineWidth = Math.max(1, TEX_W / 340);
  eachPanel((x, y, r) => {
    pentagon(a, x, y, r * 1.62);
    a.stroke();
  });

  // ---- seam height: 1 = panel face, 0 = the groove between panels
  const [, hctx] = canvas2d(TEX_W, TEX_H);
  hctx.fillStyle = '#ffffff';
  hctx.fillRect(0, 0, TEX_W, TEX_H);
  hctx.strokeStyle = '#000000';
  hctx.lineWidth = Math.max(2, TEX_W / 200);
  eachPanel((x, y, r) => {
    pentagon(hctx, x, y, r);
    hctx.stroke();
    pentagon(hctx, x, y, r * 1.62);
    hctx.stroke();
  });
  const height = blurredHeight(hctx.getImageData(0, 0, TEX_W, TEX_H).data);

  // ---- normal + roughness, both derived from that one height field
  const normal = sobelNormal(height);
  const rough = roughnessFrom(height);

  const map = new THREE.CanvasTexture(albedoC);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, maxAnisotropy());
  return { map, normalMap: normal, roughnessMap: rough };
}

/** A 5-tap separable box blur, run twice — cheap, deterministic, and enough to
 *  turn a 5px ink line into a groove with sides. */
function blurredHeight(px: Uint8ClampedArray): Float32Array {
  const n = TEX_W * TEX_H;
  let h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = px[i * 4] / 255;
  const tmp = new Float32Array(n);
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < TEX_H; y++) {
      for (let x = 0; x < TEX_W; x++) {
        let sum = 0;
        for (let k = -R; k <= R; k++) sum += h[y * TEX_W + ((x + k + TEX_W) % TEX_W)];
        tmp[y * TEX_W + x] = sum / (R * 2 + 1);
      }
    }
    for (let y = 0; y < TEX_H; y++) {
      for (let x = 0; x < TEX_W; x++) {
        let sum = 0;
        for (let k = -R; k <= R; k++) {
          sum += tmp[Math.min(TEX_H - 1, Math.max(0, y + k)) * TEX_W + x];
        }
        h[y * TEX_W + x] = sum / (R * 2 + 1);
      }
    }
  }
  return h;
}

function sobelNormal(h: Float32Array): THREE.CanvasTexture {
  const [c, ctx] = canvas2d(TEX_W, TEX_H);
  const img = ctx.createImageData(TEX_W, TEX_H);
  const px = img.data;
  const at = (x: number, y: number): number =>
    h[Math.min(TEX_H - 1, Math.max(0, y)) * TEX_W + ((x + TEX_W) % TEX_W)];
  const STRENGTH = 3.0;
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * STRENGTH, ny = -dy * STRENGTH;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      const i = (y * TEX_W + x) * 4;
      px[i] = (nx * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * 0.5 + 0.5) * 255;
      px[i + 2] = nz * inv * 255;
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  // normal maps are DATA (see TextureLab)
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
}

/** Panel faces are polished; the stitched grooves are not. */
function roughnessFrom(h: Float32Array): THREE.CanvasTexture {
  const [c, ctx] = canvas2d(TEX_W, TEX_H);
  const img = ctx.createImageData(TEX_W, TEX_H);
  const px = img.data;
  for (let i = 0; i < h.length; i++) {
    // h 1 (face) -> 0.28 gloss, h 0 (seam) -> 0.72 matte
    const r = 0.72 - h[i] * 0.44;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = r * 255;
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
}

/**
 * The contact blob. A flat disc at a flat opacity reads as a sticker at DPR 2;
 * an ambient contact shadow is dense where the ball touches and gone by the
 * edge of it.
 */
function contactShadowTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas2d(128, 128);
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.78, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
