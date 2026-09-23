// The floodlit night rig (§7A.4d): what makes a night match read as a night
// match and not as a dark day.
//
// A floodlit pitch has three looks no single directional key can fake:
//
//   • POOLS. Four pylon banks at the corners, each brighter on its own quarter
//     than across the pitch — the gentle bright/less-bright patchwork a TV
//     camera sees under any real rig. Three of the banks are real SpotLights
//     (unshadowed); the fourth IS the CSM key, aimed down from that pylon's
//     azimuth, so the one real shadow map in the scene belongs to a lamp you
//     can see. Only the players and the ball run the spot loops — flat turf
//     reads the banks' diffuse from a map baked once (groundMap), and
//     everything else is lit by the key alone, masked to the bowl's
//     footprint (Atmosphere.floodPatch). That split is the whole budget.
//   • CRISS-CROSS SHADOWS. Every player drags three or four faint soft shadows,
//     one away from each bank. The key's is the real cascade shadow; the other
//     three are cheap ground decals (one instanced draw for the whole squad and
//     the ball), each one oriented away from its pylon and as long as similar
//     triangles say a 1.8m man is under a lamp that high and that far away.
//     They darken what is under them by a fraction — the fraction of the light
//     that bank contributes — which is exactly what a real shadow from one of
//     four banks does.
//   • MULTI-DIRECTIONAL SPECULAR. Because the banks are real lights, the ball,
//     the kits and wet skin catch a highlight from each of them, through the
//     same BRDF as everything else.
//
// Everything is built only for a scene DRESSED for night on a non-RETRO
// profile; a day scene never pays for it.

import * as THREE from 'three';
import { SHADOW_LAYER } from './materials';

/** Height of a standing player for the fake-shadow similar triangles. */
const MAN_H = 1.8;
/** Just above the tips of the shell turf (grass.ts, ~42mm), so the decal is
 *  not buried inside the blades. */
const DECAL_Y = 0.048;
/** 3 banks x (22 men + ball) is 69; headroom for a capsule path with extras */
const MAX_DECALS = 3 * 32;

export interface FloodRigOptions {
  /** world positions of the four pylon heads (Stadium.floodlightHeads) */
  heads: THREE.Vector3[];
  /** which head the CSM key stands in for; that one gets no SpotLight and no
   *  fake shadow, because it already has a real one */
  keyHead: number;
  /** linear colour of the lamps */
  color: THREE.Color;
  /** SpotLight intensity (candela-ish; see three's getDistanceAttenuation) */
  intensity: number;
  /** distance exponent: 2 is physical for a point, but a bank is a 6x3 array
   *  of throw lamps and reads much flatter than that across a pitch */
  decay: number;
  /** darkening of one fake shadow at the reference distance, 0..1 */
  shadowStrength: number;
}

interface Caster {
  obj: THREE.Object3D;
  /** height of the caster's bottom above its root, and its height */
  base: number;
  height: number;
  /** half-width of the shadow */
  width: number;
  /** 1 = a man (tapered), 0 = a ball (ellipse) */
  shape: number;
}

const VERT = /* glsl */ `
  attribute vec4 aSeg;    // origin x, origin z, start offset, end offset (m)
  attribute vec4 aDir;    // dir x, dir z, half-width, strength
  attribute float aShape;
  varying vec2 vUv;
  varying float vStrength;
  varying float vShape;
  varying float vLen;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec2 d = aDir.xy;
    vec2 n = vec2(-d.y, d.x);
    // position.x in [-1,1] across, position.y in [0,1] along
    float along = mix(aSeg.z, aSeg.w, position.y);
    vec2 xz = aSeg.xy + d * along + n * position.x * aDir.z;
    vec4 mv = modelViewMatrix * vec4(xz.x, ${DECAL_Y.toFixed(3)}, xz.y, 1.0);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vStrength = aDir.w;
    vShape = aShape;
    vLen = aSeg.w - aSeg.z;
    #include <logdepthbuf_vertex>
  }
`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vStrength;
  varying float vShape;
  varying float vLen;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    float v = vUv.y;
    // A man's shadow: narrow at the boots, broad through the shoulders, a
    // head at the end. A ball's: an ellipse.
    float man = 0.42 + 0.58 * sin(3.14159 * clamp(v * 0.92 + 0.06, 0.0, 1.0));
    float ball = sqrt(max(1.0 - pow(v * 2.0 - 1.0, 2.0), 0.0));
    float w = max(mix(ball, man, vShape), 0.001);
    float across = abs(vUv.x) / w;
    // the penumbra of a lamp 90m away is already wide at the boots and grows
    // with distance from the contact point
    float soft = mix(0.35, 0.85, v);
    float a = 1.0 - smoothstep(1.0 - soft, 1.0, across);
    // fade in right at the contact point and out toward the head
    a *= smoothstep(0.0, 0.10, v) * (1.0 - smoothstep(0.62, 1.0, v));
    a *= 1.0 - 0.45 * v;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a * vStrength);
  }
`;

export class FloodRig {
  readonly lights: THREE.SpotLight[] = [];
  private decals: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private seg: THREE.InstancedBufferAttribute;
  private dir: THREE.InstancedBufferAttribute;
  private shape: THREE.InstancedBufferAttribute;
  private casters: Caster[] = [];
  private banks: THREE.Vector3[] = [];
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private o: FloodRigOptions) {
    o.heads.forEach((h, i) => {
      if (i === o.keyHead) return;
      this.banks.push(h.clone());
      const s = new THREE.SpotLight(o.color, o.intensity, 0, 0.9, 0.75, o.decay);
      s.position.copy(h);
      // Each bank favours its own quarter. Aimed at the centre spot, all
      // three would pile up in the middle and the corners would go grey;
      // aimed a third of the way into their own quarter, the pitch gets its
      // pools and the centre still sees all of them.
      s.target.position.set(h.x * 0.30, 0, h.z * 0.28);
      s.castShadow = false;
      s.layers.enable(SHADOW_LAYER);
      scene.add(s, s.target);
      s.target.updateMatrixWorld();
      this.lights.push(s);
    });

    const quad = new THREE.PlaneGeometry(2, 1, 1, 1);
    quad.translate(0, 0.5, 0);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.seg = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS * 4), 4);
    this.dir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS * 4), 4);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS), 1);
    for (const a of [this.seg, this.dir, this.shape]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aSeg', this.seg);
    this.geo.setAttribute('aDir', this.dir);
    this.geo.setAttribute('aShape', this.shape);
    this.geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // dst * (1 - a): a pure multiply toward black that leaves alpha alone
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.decals = new THREE.Mesh(this.geo, mat);
    this.decals.frustumCulled = false;
    // after the turf and the ball's contact blob, before any additive sprite
    this.decals.renderOrder = 2;
    scene.add(this.decals);
  }

  private ground: { tex: THREE.DataTexture; rect: THREE.Vector4 } | null = null;

  /**
   * The three banks' DIFFUSE irradiance on flat turf, baked once.
   *
   * The shell turf (grass.ts) draws seven layers per pixel and the pitch
   * plane covers most of every frame; three real spot loops (GGX on the
   * plane) on each of those was the whole cost of this rig. Flat ground
   * has one normal, so what the three lamps put on it is a function of (x, z)
   * alone: the same maths three runs per fragment (getSpotLightInfo — cone
   * smoothstep, 1/d^decay, N.L with N = up) evaluated here per texel, and one
   * bilinear tap per fragment instead. What is lost is the banks' specular
   * on the turf — a roughness-0.9 lobe nobody could point to (the shells are
   * Lambert and never had one).
   */
  groundMap(): { tex: THREE.DataTexture; rect: THREE.Vector4 } {
    if (this.ground) return this.ground;
    const W = 192, H = 144, X0 = -96, Z0 = -72, SX = 192, SZ = 144;
    const data = new Uint16Array(W * H * 4);
    const dir = new THREE.Vector3();
    const l = new THREE.Vector3();
    const Y = 0.03;
    const lights = this.lights.map((s) => {
      dir.subVectors(s.position, s.target.position).normalize();
      return {
        pos: s.position.clone(), dir: dir.clone(),
        coneCos: Math.cos(s.angle), penCos: Math.cos(s.angle * (1 - s.penumbra)),
        col: s.color.clone().multiplyScalar(s.intensity), decay: s.decay,
      };
    });
    const smooth = (a: number, b: number, t: number): number => {
      const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return k * k * (3 - 2 * k);
    };
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = X0 + ((i + 0.5) / W) * SX;
        const z = Z0 + ((j + 0.5) / H) * SZ;
        let r = 0, g = 0, b = 0;
        for (const L of lights) {
          l.set(L.pos.x - x, L.pos.y - Y, L.pos.z - z);
          const d = l.length();
          l.divideScalar(d);
          const att = smooth(L.coneCos, L.penCos, l.dot(L.dir));
          if (att <= 0) continue;
          const k = att * Math.max(l.y, 0) / Math.max(Math.pow(d, L.decay), 0.01);
          r += L.col.r * k; g += L.col.g * k; b += L.col.b * k;
        }
        const o = (j * W + i) * 4;
        data[o] = THREE.DataUtils.toHalfFloat(r);
        data[o + 1] = THREE.DataUtils.toHalfFloat(g);
        data[o + 2] = THREE.DataUtils.toHalfFloat(b);
        data[o + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.ground = { tex, rect: new THREE.Vector4(X0, Z0, 1 / SX, 1 / SZ) };
    return this.ground;
  }

  /** Players (root at the boots) and the ball (root at its centre). */
  setCasters(players: THREE.Object3D[], ball: THREE.Object3D | null, ballRadius = 0.165): void {
    this.casters = players.map((obj) => ({ obj, base: 0, height: MAN_H, width: 0.27, shape: 1 }));
    if (ball) {
      this.casters.push({ obj: ball, base: -ballRadius, height: ballRadius * 2,
        width: ballRadius * 0.95, shape: 0 });
    }
  }

  /** Once per drawn frame. ~70 decals of CPU arithmetic, one upload. */
  update(): void {
    const seg = this.seg.array as Float32Array;
    const dir = this.dir.array as Float32Array;
    const shp = this.shape.array as Float32Array;
    let n = 0;
    for (const c of this.casters) {
      if (!c.obj.visible || !c.obj.parent) continue;
      const p = c.obj.getWorldPosition(this.tmp);
      const y0 = Math.max(0, p.y + c.base);
      const y1 = y0 + c.height;
      for (const b of this.banks) {
        if (n >= MAX_DECALS) break;
        const dx = p.x - b.x, dz = p.z - b.z;
        const dh = Math.hypot(dx, dz);
        if (dh < 1) continue;
        const hp = b.y;
        if (y1 >= hp - 1) continue;
        // similar triangles: where the caster's bottom and top land
        const s0 = (y0 * dh) / (hp - y0);
        const s1 = (y1 * dh) / (hp - y1);
        // a far bank throws less light, so its shadow removes less; a caster
        // in the air loses its shadow into the penumbra
        const reach = THREE.MathUtils.clamp(95 / dh, 0.55, 1.35);
        const lift = THREE.MathUtils.clamp(1 - y0 / 3.5, 0, 1);
        const k = this.o.shadowStrength * reach * lift;
        if (k < 0.01) continue;
        seg[n * 4] = p.x; seg[n * 4 + 1] = p.z;
        seg[n * 4 + 2] = s0 - (c.shape > 0.5 ? 0.12 : 0);
        seg[n * 4 + 3] = s1;
        dir[n * 4] = dx / dh; dir[n * 4 + 1] = dz / dh;
        // the shadow widens slightly with its length (a wider penumbra)
        dir[n * 4 + 2] = c.width * (1 + 0.05 * (s1 - s0));
        dir[n * 4 + 3] = k;
        shp[n] = c.shape;
        n++;
      }
    }
    this.geo.instanceCount = n;
    this.seg.needsUpdate = true;
    this.dir.needsUpdate = true;
    this.shape.needsUpdate = true;
  }

  dispose(): void {
    for (const l of this.lights) {
      this.scene.remove(l, l.target);
      l.dispose();
    }
    this.scene.remove(this.decals);
    this.ground?.tex.dispose();
    this.geo.dispose();
    (this.decals.material as THREE.Material).dispose();
  }
}
