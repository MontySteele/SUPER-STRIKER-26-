// Tackle divots (§7A.3c) — the marks a slide tackle leaves on the turf.
//
// WHY THIS EXISTS. The pitch is the one surface on screen for the whole match,
// and until now nothing that happened on it ever changed it. A slide tackle is
// the most violent thing a player does to the grass and it used to leave the
// grass exactly as it found it, which is the single clearest tell that the turf
// is a texture rather than a place. One scuff per tackle, lying where the boot
// went and pointing the way it was going, is a cheap thing that makes the pitch
// accumulate a history of its own match.
//
// COST. One InstancedMesh, so ONE extra draw call no matter how many marks are
// standing, and 2 triangles per instance — 48 at HIGH. Nothing here allocates
// after construction: the matrices are written once at add() time (a mark never
// moves), and the only thing that changes per frame is one float per instance
// in a preallocated Float32Array. The whole update loop is a walk over 24
// floats, which is beneath measurement.
//
// BOUNDED BY CONSTRUCTION. The store is a RING BUFFER of `profile.divots`
// slots: the 25th tackle of a match overwrites the oldest mark rather than
// growing anything. There is no path by which a long game, a replay, or a
// thousand tackles in a corner costs more than the fixed allocation made here.
// The 90s life is therefore a look, not a budget — the budget is the ring.
//
// Z-FIGHTING. The quad is lifted 12mm and carries a polygon offset on top. The
// lift is what actually does the work (a millimetre of depth precision at
// pitch-side distances is nothing to a 24-bit buffer); the offset is belt and
// braces for the grazing end-zone cameras, where the quad and the plane are
// nearly parallel to the view ray and the interpolated depths converge.
//
// THE SHELLS DRAW OVER IT, AND THAT IS THE COMPROMISE IN THIS PASS. The shell
// turf (grass.ts) starts at SHELL_BASE * GRASS_H ≈ 14mm, so it stands just
// above the decal and the mark is seen THROUGH the gaps between blades: a
// darkened patch of ground under grass that is still standing up straight. From
// the tele cam that reads correctly — the gaps are most of what you see of the
// ground at that angle. From a knee-height camera the blades over a divot
// should be flattened and torn, and they are not.
//
// What actually flattening them would take: the shells already carry a wake
// deformer for the ball (ss26Ball in grass.ts, a single vec4 uniform that
// pushes blades radially out of the ball's footprint and kills their height
// inside it). The same shader path generalises to a small array of oriented
// capsules — say vec4[8] of centre/half-length plus a direction and a fade —
// which the vertex shader would test per vertex, scaling ss26T (the per-shell
// height) down to near zero inside the capsule and shearing the surviving
// blades along the slide direction. That is ~8 extra vec4 uniforms and a short
// loop in the vertex stage, and the reason it is not in this pass is that it
// couples the divot store to the shell patch's uniform block: the store would
// have to publish its N nearest-to-camera marks every frame in shell space, and
// the grass patch would have to be told when the store changes. Worth doing,
// but it is a grass change, not a decal change.

import * as THREE from 'three';
import type { TextureLab } from './TextureLab';
import { queueShaderPatch } from './materials';
import type { QualityProfile } from './quality';

/** Seconds a mark stays on the pitch. Long enough that a divot is still there
 *  when play comes back through the same channel, short enough that the pitch
 *  is not a minefield by the 80th minute. */
const LIFE = 90;
/** A mark does not pop into existence at full strength — a quarter of a second
 *  of ramp is under a blink and kills the pop. */
const FADE_IN = 0.25;
/** Metres above the pitch plane. See the header: this, not polygonOffset, is
 *  what keeps the decal off the plane. */
const LIFT = 0.012;
/** Peak opacity. A fresh divot is not a hole — the studs take the top off the
 *  mat, they do not excavate. */
const PEAK = 0.85;

const LEN_MIN = 1.3;
const LEN_MAX = 2.1;
/**
 * Quad width, which is NOT the width of the mark. The bake fills the full
 * length of its map but only the middle ~55% of its width (the rest is the
 * transparent margin the ragged edge wanders into), so a 0.40m gouge — about
 * what a hip and a trailing leg actually take out — needs a 0.72m quad.
 */
const WIDTH = 0.6;

/** Below this the slide has no direction worth reading and we fall back to the
 *  player's facing. */
const MIN_DIR = 1e-4;

export class Divots {
  readonly mesh: THREE.InstancedMesh;
  private mat: THREE.MeshLambertMaterial;
  private readonly cap: number;

  /** per-slot opacity, uploaded as the aFade instanced attribute */
  private fade: Float32Array;
  private fadeAttr: THREE.InstancedBufferAttribute;
  /** seconds since the slot was written; only meaningful where live */
  private age: Float32Array;
  private live: Uint8Array;
  private liveCount = 0;
  private head = 0;

  // scratch, allocated once and mutated in place — see the header
  private m = new THREE.Matrix4();
  /** rotX(-90°): lays the plane down. Built once, right-multiplied into every
   *  instance matrix so the yaw stays a plain world-space rotation. */
  private flat = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  private scl = new THREE.Vector3();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  /** Deterministic jitter. NOT Math.random: the capture harness replays a sim
   *  and expects the same still twice, and a mark whose length changed between
   *  runs would put a diff in every shot that contains one. */
  private seed = 0x9e3779b9;

  constructor(scene: THREE.Scene, lab: TextureLab, profile: QualityProfile) {
    this.cap = Math.max(1, Math.round(profile.divots));
    this.fade = new Float32Array(this.cap);
    this.age = new Float32Array(this.cap);
    this.live = new Uint8Array(this.cap);

    // one unit quad; the instance matrix stretches it to the mark's own size
    const geo = new THREE.PlaneGeometry(1, 1);
    this.fadeAttr = new THREE.InstancedBufferAttribute(this.fade, 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFade', this.fadeAttr);

    // LAMBERT, and lit, deliberately. An unlit decal is the classic mistake
    // here: it holds its brightness when the sun goes behind the stand and
    // glows on a night pitch, which is exactly when a dark patch of soil should
    // disappear. Lambert costs one more registered material and puts the mark
    // under the same key, fill and cascade shadow as the plane it is lying on,
    // so it dims with the turf instead of floating over it.
    this.mat = new THREE.MeshLambertMaterial({
      map: lab.scuffTexture(),
      transparent: true,
      // a decal writing depth would occlude the grass shells standing in it
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.FrontSide,
    });

    // per-instance opacity. The alpha has to be attenuated AFTER the map is
    // sampled and before anything reads diffuseColor.a, which is what
    // map_fragment is the anchor for.
    queueShaderPatch(this.mat, (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float aFade;\nvarying float ss26vFade;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  ss26vFade = aFade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float ss26vFade;')
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n  diffuseColor.a *= ss26vFade;');
    });

    this.mesh = new THREE.InstancedMesh(geo, this.mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // every slot starts as a zero-area quad: no clipping, no rasterisation, and
    // no need for `count` bookkeeping when the ring wraps
    for (let i = 0; i < this.cap; i++) this.mesh.setMatrixAt(i, this.zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    // a 4cm-tall mark casting a shadow would be a second shadow-pass draw for
    // something with no silhouette
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    // the instance matrices move, and three's instanced bounding sphere is
    // computed once; the mesh is one draw and is hidden outright when no mark
    // is standing, which is a better cull than the frustum would give
    this.mesh.frustumCulled = false;
    // ground decals go under every other transparent effect (confetti, the ball
    // trail, the control rings), all of which are above them in the world too
    this.mesh.renderOrder = -1;
    this.mesh.visible = false;
    scene.add(this.mesh);
    scene.userData.ss26Divots = this;
  }

  /** 0..1, deterministic. */
  private rand(): number {
    // xorshift32 — four instructions, no allocation, no shared state
    let s = this.seed;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.seed = s;
    return s / 0x100000000;
  }

  /**
   * Lay a mark down. `x, y` is the SIM position of the boot (sim x,y is the
   * ground plane; this converts to three's x,z itself), `dirX, dirY` the
   * direction the slide is travelling — it need not be normalised, and a zero
   * vector is accepted and drawn pointing along +x rather than dropped.
   */
  add(x: number, y: number, dirX: number, dirY: number): void {
    const len = Math.hypot(dirX, dirY);
    const dx = len > MIN_DIR ? dirX / len : 1;
    const dy = len > MIN_DIR ? dirY / len : 0;

    const l = LEN_MIN + (LEN_MAX - LEN_MIN) * this.rand();
    const w = WIDTH * (0.82 + 0.36 * this.rand());

    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (!this.live[i]) this.liveCount++;
    this.live[i] = 1;
    this.age[i] = 0;
    this.fade[i] = 0;

    // The texture's heel is at u=0 and the boot is still moving, so the mark
    // trails BEHIND the contact point: shifting the quad's centre back along
    // the slide puts the deep end roughly where the studs actually bit.
    const cx = x - dx * l * 0.35;
    const cy = y - dy * l * 0.35;

    // rotY(t) sends local +x to (cos t, 0, -sin t); we want it on (dx, 0, dy)
    this.m.makeRotationY(Math.atan2(-dy, dx));
    this.m.multiply(this.flat);
    this.m.scale(this.scl.set(l, w, 1));
    this.m.setPosition(cx, LIFT, cy);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
  }

  /** Age every standing mark. `dt` is real seconds. */
  update(dt: number): void {
    if (this.liveCount === 0) return;
    let matrixDirty = false;
    for (let i = 0; i < this.cap; i++) {
      if (!this.live[i]) continue;
      const a = this.age[i] + dt;
      this.age[i] = a;
      if (a >= LIFE) {
        this.live[i] = 0;
        this.liveCount--;
        this.fade[i] = 0;
        // retire the quad to zero area: a dead slot stops being rasterised
        // instead of being drawn fully transparent forever
        this.mesh.setMatrixAt(i, this.zero);
        matrixDirty = true;
        continue;
      }
      // a quick ramp in, then a long ease-out — the pow keeps the mark at
      // close to full strength for the first half of its life and spends the
      // whole second half disappearing, which is how a scuff actually recovers
      const k = a < FADE_IN
        ? a / FADE_IN
        : (1 - (a - FADE_IN) / (LIFE - FADE_IN)) ** 1.7;
      this.fade[i] = k * PEAK;
    }
    this.fadeAttr.needsUpdate = true;
    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = this.liveCount > 0;
  }

  /** Standing marks — for tooling and tests; the ring is capped, so this is
   *  bounded by profile.divots by construction. */
  count(): number {
    return this.liveCount;
  }

  dispose(): void {
    // read the parent BEFORE detaching, or the userData slot is never cleared
    const ud = this.mesh.parent?.userData;
    if (ud && ud.ss26Divots === this) ud.ss26Divots = null;
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}
