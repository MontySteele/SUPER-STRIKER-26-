// Thick, readable ball (§2) with classic panels and a contact blob shadow.

import * as THREE from 'three';
import { BALL_RADIUS } from '../sim/constants';

const VISUAL_SCALE = 1.5; // chunky for readability; physics stays honest

export class BallMesh {
  root = new THREE.Group();
  private sphere: THREE.Mesh;
  private blob: THREE.Mesh;
  private prev = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const tex = this.makeTexture();
    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS * VISUAL_SCALE, 18, 14),
      new THREE.MeshPhongMaterial({ map: tex, shininess: 55, specular: new THREE.Color(0x888888) }),
    );
    this.sphere.castShadow = true;
    this.root.add(this.sphere);

    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.7, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    scene.add(this.blob);
    scene.add(this.root);
  }

  private makeTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f4f4f2';
    ctx.fillRect(0, 0, 256, 128);
    // classic pentagon spots
    ctx.fillStyle = '#15181d';
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 6; col++) {
        const x = col * 44 + (row % 2) * 22;
        const y = 20 + row * 44;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
          const px = x + Math.cos(a) * 11;
          const py = y + Math.sin(a) * 11;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
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
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.32 * Math.max(1 - h / 10, 0.15);
  }
}
