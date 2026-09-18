// Rain (§7A.4c). ONE instanced draw, camera-relative, seeded.
//
// Three decisions, all of them the same decision — do not pay for what the
// lens cannot resolve:
//
//  • CAMERA-RELATIVE. The streaks live in a box that is carried along with the
//    camera and wrapped modulo its own size, so 2400 of them cover every shot
//    in the game, from a keeper's face at 4m to the establishing crane at
//    180m. Filling a stadium-sized volume at the same density would be a
//    quarter of a million particles to light the same forty thousand pixels.
//
//  • STRETCHED QUADS, NOT DROPS. A raindrop at 1/50s of shutter is a streak,
//    and the streak is what a broadcast camera records. The card is stretched
//    along the fall vector in the VERTEX shader, so the length is a uniform
//    and a gust costs nothing.
//
//  • ADDITIVE, UNLIT, NO DEPTH WRITE. Rain in front of a floodlight is bright
//    and rain in front of the dark stand is nearly invisible, which additive
//    blending gives for free and any lit model would have to be told.
//
// Determinism: every position comes from the TextureLab's seeded stream and
// every subsequent frame is a pure function of the accumulated virtual clock,
// which the capture harness drives. No Math.random anywhere.

import * as THREE from 'three';
import type { RNG } from '../core/rng';

/** Half-extent of the wrap box, metres. Big enough that the near plane never
 *  sees the edge of it and small enough to stay dense. */
const BOX = new THREE.Vector3(26, 16, 26);

export class Rain {
  private mesh: THREE.InstancedMesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private uTime = { value: 0 };
  private uCam = { value: new THREE.Vector3() };
  private clock = 0;

  /**
   * @param intensity 0..1 — scales the count, the opacity and the fall speed
   *        together, because a heavier shower is all three at once.
   */
  constructor(scene: THREE.Scene, rng: RNG, intensity: number, tint = 0xc8d8ea) {
    const count = Math.max(1, Math.round(5200 * intensity));

    // one unit quad, stretched along -y in the shader
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = quad;
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed[i * 4 + 0] = rng.range(-BOX.x, BOX.x);
      seed[i * 4 + 1] = rng.range(-BOX.y, BOX.y);
      seed[i * 4 + 2] = rng.range(-BOX.z, BOX.z);
      // per-drop speed and length jitter, so the curtain has depth in it
      seed[i * 4 + 3] = rng.range(0.72, 1.45);
    }
    quad.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uCam: this.uCam,
        uBox: { value: BOX.clone() },
        uFall: { value: 15.0 + intensity * 9.0 },
        // a streak is 0.42m at this shutter; the wind shear is the x/z lean
        // 0.26m at full intensity, not the 0.9m this started at. A streak is
        // sized in METRES and read in PIXELS: at the 3-4m the nearest drops in
        // a camera-carried box actually sit, 0.9m is a quarter of the frame
        // height, and a dozen of those is not rain, it is scaffolding.
        uLen: { value: 0.14 + intensity * 0.12 },
        // a real shower leans: a vertical streak reads as a scratch on the
        // lens, and the lean is most of what makes it look like weather
        uWind: { value: new THREE.Vector2(4.4, -1.6) },
        uColor: { value: new THREE.Color(tint) },
        uOpacity: { value: 0.055 + intensity * 0.055 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform vec3 uCam;
        uniform vec3 uBox;
        uniform float uFall;
        uniform float uLen;
        uniform vec2 uWind;
        varying float vFade;

        void main() {
          // The wrap. Fall, lean with the wind, then fold the whole thing back
          // into the box that is carried on the camera — mod() on the CAMERA-
          // relative offset, so the curtain neither slides past the lens when
          // the rig pans nor pops when it cuts.
          vec3 p = aSeed.xyz;
          float sp = aSeed.w;
          p.y -= uTime * uFall * sp;
          p.xz += uWind * uTime * sp;
          vec3 rel = mod(p - uCam + uBox, uBox * 2.0) - uBox;
          vec3 world = uCam + rel;

          // Billboard the card around the FALL axis: a streak always faces the
          // camera across its width and never rotates about its length, which
          // is what keeps it a line and not a lozenge.
          vec3 fall = normalize(vec3(uWind.x, -uFall, uWind.y));
          vec3 toEye = normalize(cameraPosition - world);
          vec3 side = normalize(cross(fall, toEye));
          float len = uLen * sp;
          vec3 off = side * (position.x * 0.018) + fall * (position.y * len);
          vec4 mv = viewMatrix * vec4(world + off, 1.0);
          // fade the nearest half-metre out: a streak that clips the near
          // plane is a grey slab across the lens
          vFade = smoothstep(1.4, 5.5, -mv.z) * (1.0 - smoothstep(20.0, 34.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vFade;
        void main() {
          gl_FragColor = vec4(uColor * (uOpacity * vFade), 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(quad, this.mat, count);
    this.mesh.frustumCulled = false;   // it is always around the camera
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // after the opaque scene, before the sprites' own additive layer
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);
  }

  /** `dt` is the renderer's step — real in play, the harness's fixed virtual
   *  step under capture, which is what keeps a still reproducible. */
  update(dt: number, camera: THREE.Camera): void {
    this.clock += dt;
    this.uTime.value = this.clock;
    this.uCam.value.copy(camera.position);
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
