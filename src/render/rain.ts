// Rain (§7A.4c, v2). Two instanced draws, camera-carried, seeded.
//
// v1 was 5200 hard additive sticks in a 26m box around the lens. On the tele
// cam — the camera the game is actually played through, 60m from the action
// on a 20° lens — that box put ~80 streaks in frame, every one of them a
// crisp 0.4m white bar a few metres from a lens that is focused on the far
// side of the pitch. Broadcast rain is the opposite on every axis: thousands
// of fine, short, soft streaks, visible against the dark stands and the night
// sky, all but invisible against the bright turf, fading into a sheet with
// distance and lit up where they cross a floodlight beam. v2 is built from
// the lens outward to get there:
//
//  • TWO WRAP BOXES. A small dense box on the camera for the close rigs, and
//    a big one pushed 45m down the view axis for the tele cam, so the drops
//    actually sit where a long lens looks. Both wrap modulo a FIXED period in
//    world space, so a drop is anchored to the world — pans and zooms never
//    make the curtain swim — and only the wrap window moves with the rig.
//
//  • A LENS, NOT A LINE RASTER. Each streak's width and length are grown to
//    (a) the circle of confusion of a lens focused where the camera is
//    looking and (b) at least ~1.3 device pixels, and its opacity is divided
//    by the same factor. Energy is conserved, so: the drop 3m in front of a
//    tele lens becomes a huge, faint smear (nothing — which is what the real
//    lens shows), the one at 30m is a crisp one-pixel hairline, and the
//    thousands past 70m add up to a soft grey sheet instead of aliasing into
//    sparkle. A close rig has a short lens and a small aperture, so its near
//    drops stay sharp streaks: same shader, the physics does the layering.
//
//  • LIT LIKE WATER, NOT ADDED LIKE LIGHT. A streak is a smear of a
//    transparent droplet: it shows the average radiance around it and hides a
//    little of what is behind it. Premultiplied over-blend with a colour of
//    "ambient + floodlight" gives exactly the broadcast read: a pale streak
//    against a dark stand or sky, ~nothing against a bright pitch, and a
//    bright one where it crosses a lamp's beam or sits in front of a head
//    (forward scattering), which is where rain is most visible at night.
//
// Determinism: positions from the TextureLab's seeded stream, and every frame
// a pure function of the accumulated virtual clock, which the capture harness
// drives. No Math.random. `?rainT=<s>` offsets the clock (capture-only aid:
// two stills a frame or two apart show the motion a still cannot); `?rain=0`
// hides the streaks for a same-tree bench A/B.

import * as THREE from 'three';
import type { RNG } from '../core/rng';

interface Layer {
  /** half-extent of the wrap box, metres (fixed: it is the wrap period) */
  box: THREE.Vector3;
  /** how far down the view axis (horizontal part) the box centre is pushed */
  ahead: number;
  /** drops at intensity 1 */
  count: number;
  /** view-depth fade: in over [near0, near1], out over [far0, far1] */
  fade: [number, number, number, number];
}

const LAYERS: Layer[] = [
  // the close rigs: celebration, penalty, cutscenes, keeper cams
  { box: new THREE.Vector3(9, 7, 9), ahead: 4, count: 2600, fade: [0.6, 2.2, 11, 14] },
  // the tele cam and everything wide: from the gantry out to the far stand
  // (the tele rig sits ~75m off the pitch centre, the far stand is 120-150m)
  { box: new THREE.Vector3(84, 30, 84), ahead: 72, count: 90000, fade: [9, 14, 125, 165] },
];

const MAX_LAMPS = 4;

export interface RainLight {
  /** world positions of the floodlight heads (Stadium.floodlightHeads) */
  lamps: THREE.Vector3[];
  /** are they burning */
  lit: boolean;
  /** the scene is dressed for night: dark ambient, the lamps carry it */
  night: boolean;
}

export class Rain {
  private meshes: THREE.InstancedMesh[] = [];
  private geo: THREE.PlaneGeometry;
  private mats: THREE.ShaderMaterial[] = [];
  private uTime = { value: 0 };
  private uCam = { value: new THREE.Vector3() };
  private uFwd = { value: new THREE.Vector3(0, 0, -1) };
  private uFocus = { value: 60 };
  private uViewH = { value: 1080 };
  private clock = 0;
  private tmpV = new THREE.Vector2();

  /**
   * @param intensity 0..1 — scales the count, the opacity and the fall speed
   *        together, because a heavier shower is all three at once.
   */
  constructor(scene: THREE.Scene, rng: RNG, intensity: number, tint = 0xc8d8ea,
    light: RainLight = { lamps: [], lit: false, night: false }) {
    this.geo = new THREE.PlaneGeometry(1, 1);
    try {
      const t = Number(new URLSearchParams(location.search).get('rainT'));
      if (Number.isFinite(t)) this.clock = t;
    } catch { /* no location */ }

    const lampArr: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_LAMPS; i++) {
      lampArr.push(light.lamps[i] ? light.lamps[i].clone() : new THREE.Vector3(0, -1e4, 0));
    }
    // Linear radiance a streak picks up. Day: the overcast lid, which is the
    // brightest thing a droplet can see. Night: very little of its own — the
    // lamps do the work, through the beam and the forward lobe.
    const amb = new THREE.Color(tint).multiplyScalar(light.night ? 0.045 : 0.26);
    const lampK = !light.lit || light.lamps.length === 0 ? 0 : light.night ? 1.0 : 0.35;

    const geo = this.geo;
    LAYERS.forEach((L, li) => {
      const count = Math.max(1, Math.round(L.count * intensity));
      const g = new THREE.BufferGeometry();
      g.setIndex(geo.index);
      g.setAttribute('position', geo.getAttribute('position'));
      const seed = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        seed[i * 4 + 0] = rng.range(-1, 1) * L.box.x;
        seed[i * 4 + 1] = rng.range(-1, 1) * L.box.y;
        seed[i * 4 + 2] = rng.range(-1, 1) * L.box.z;
        // per-drop speed and length jitter, so the curtain has depth in it
        seed[i * 4 + 3] = rng.range(0.75, 1.3);
      }
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: this.uTime,
          uCam: this.uCam,
          uFwd: this.uFwd,
          uFocus: this.uFocus,
          uViewH: this.uViewH,
          uBox: { value: L.box.clone() },
          uAhead: { value: L.ahead },
          uFade: { value: new THREE.Vector4(...L.fade) },
          // the close layer only exists for the close rigs: a tele camera sits
          // under a gantry roof, and on its long lens a drop 3m out is a
          // frame-high smear
          uTeleCut: { value: li === 0 ? 1 : 0 },
          // ~terminal velocity of a heavy-shower drop, plus the gust
          uFall: { value: 9.5 + intensity * 3.5 },
          // one frame's fall at a 1/60s shutter: any shorter and a streak
          // jumps further each frame than it is long, which strobes in motion
          uLen: { value: (9.5 + intensity * 3.5) / 60 * 0.85 },
          // a water streak is a couple of millimetres across before any lens
          uWidth: { value: 0.0024 },
          // aperture (m) per unit of projectionMatrix[1][1]: 10mm at 20°
          uAperture: { value: 0.0018 },
          uWind: { value: new THREE.Vector2(2.2, -0.8) },
          uAmb: { value: amb },
          uLampCol: { value: new THREE.Color(1.0, 0.97, 0.9).multiplyScalar(lampK) },
          uLamps: { value: lampArr },
          // opacity of a fully resolved, in-focus streak
          uOpacity: { value: (0.42 + intensity * 0.33) * (li === 0 ? 0.85 : 1.0) },
        },
        vertexShader: /* glsl */ `
          attribute vec4 aSeed;
          uniform float uTime;
          uniform vec3 uCam;
          uniform vec3 uFwd;
          uniform float uAhead;
          uniform vec3 uBox;
          uniform vec4 uFade;
          uniform float uTeleCut;
          uniform float uFall;
          uniform float uLen;
          uniform float uWidth;
          uniform float uAperture;
          uniform float uFocus;
          uniform float uViewH;
          uniform vec2 uWind;
          uniform vec3 uAmb;
          uniform vec3 uLampCol;
          uniform vec3 uLamps[${MAX_LAMPS}];
          uniform float uOpacity;
          varying vec2 vUv;
          varying float vAlpha;
          varying vec3 vLight;

          void main() {
            // The wrap: fall, lean with the wind, fold back into a box of
            // FIXED size whose centre rides the rig. Only the window moves.
            vec3 centre = uCam + uFwd * uAhead;
            vec3 p = aSeed.xyz;
            float sp = aSeed.w;
            p.y -= uTime * uFall * sp;
            p.xz += uWind * uTime * sp;
            vec3 rel = mod(p - centre + uBox, uBox * 2.0) - uBox;
            vec3 world = centre + rel;

            vec4 mv0 = viewMatrix * vec4(world, 1.0);
            float depth = -mv0.z;
            float fade = smoothstep(uFade.x, uFade.y, depth)
              * (1.0 - smoothstep(uFade.z, uFade.w, depth))
              * step(0.0, world.y);

            // --- the lens ----------------------------------------------------
            float p11 = projectionMatrix[1][1];
            fade *= 1.0 - uTeleCut * smoothstep(3.3, 5.0, p11);
            float pxPerM = p11 * uViewH * 0.5 / max(depth, 0.1);
            float coc = uAperture * p11 * abs(depth - uFocus) / uFocus;
            float len = uLen * sp;
            // 1.3px floor: under it a streak is a sampling problem, not rain
            float w = max(max(uWidth, coc), 1.3 / pxPerM);
            float l = len + coc;
            // NOT fully conserved: sqrt. At true density (a few hundred drops
            // per cubic metre) the far field integrates to a sheet; with a
            // budget of ~0.03/m³ the physical answer is "nothing", so a far
            // streak keeps more of itself than its width says it should.
            float energy = sqrt((uWidth / w) * (len / l));

            // --- light -------------------------------------------------------
            vec3 toEye = normalize(cameraPosition - world);
            float lamp = 0.0;
            for (int i = 0; i < ${MAX_LAMPS}; i++) {
              vec3 d = world - uLamps[i];
              float dist = length(d);
              vec3 dn = d / max(dist, 1e-3);
              // in the beam: the heads are aimed down at the pitch
              float beam = smoothstep(0.35, 0.85, dot(dn, normalize(-uLamps[i])));
              // backlit: the lamp is behind the drop as the lens sees it
              float fwd = max(dot(dn, toEye), 0.0);
              float fwd2 = fwd * fwd; float fwd4 = fwd2 * fwd2; float fwd16 = fwd4 * fwd4 * fwd4 * fwd4;
              lamp += (beam * 0.32 + fwd16 * 5.0) / (1.0 + dist * dist * (1.0 / 3600.0));
            }
            vLight = uAmb + uLampCol * lamp;
            vAlpha = uOpacity * energy * fade;

            // Billboard around the FALL axis, stretched to the lens-grown size.
            // 2x the width so the soft profile's tails fit on the card.
            vec3 fall = normalize(vec3(uWind.x, -uFall, uWind.y));
            vec3 side = normalize(cross(fall, toEye));
            vec3 off = side * (position.x * w * 2.0) + fall * (position.y * l);
            vUv = vec2(position.x * 2.0, position.y * 2.0);
            if (vAlpha < 0.0015) {
              // culled: collapse the card, it costs no fragments
              gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
              return;
            }
            gl_Position = projectionMatrix * viewMatrix * vec4(world + off, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          varying float vAlpha;
          varying vec3 vLight;
          void main() {
            // gaussian-ish across (the card is 2 widths wide), soft ends along
            float x = vUv.x * 2.0;
            float across = exp(-x * x * 1.6);
            float along = 1.0 - smoothstep(0.35, 1.0, abs(vUv.y));
            float a = vAlpha * across * along * 1.6;
            // premultiplied: the droplet's own light, over 70% of its cover
            gl_FragColor = vec4(vLight * a, a * 0.7);
          }
        `,
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });

      const mesh = new THREE.InstancedMesh(g, mat, count);
      mesh.frustumCulled = false;   // it is always around the camera
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // after the opaque scene, before the sprites' own additive layer
      mesh.renderOrder = 8;
      mesh.onBeforeRender = (renderer) => {
        const rt = renderer.getRenderTarget();
        this.uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(this.tmpV).y;
      };
      // `?rain=0`: build it, never draw it — the same-tree A/B for the bench
      try {
        if (new URLSearchParams(location.search).get('rain') === '0') mesh.visible = false;
      } catch { /* no location */ }
      scene.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    });
  }

  /** `dt` is the renderer's step — real in play, the harness's fixed virtual
   *  step under capture, which is what keeps a still reproducible. */
  update(dt: number, camera: THREE.Camera): void {
    this.clock += dt;
    this.uTime.value = this.clock;
    this.uCam.value.copy(camera.position);
    // the far box rides the HORIZONTAL view axis: pitching the camera down
    // must not bury the box under the pitch
    const f = camera.getWorldDirection(this.uFwd.value);
    // focus: where the view axis meets the turf (a broadcast lens is focused
    // on play), clamped for a camera looking at the sky or into a stand
    const focus = f.y < -0.02 ? camera.position.y / -f.y : 80;
    this.uFocus.value = Math.min(Math.max(focus, 4), 120);
    f.y = 0;
    if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
    f.normalize();
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.geo.dispose();
    for (const m of this.mats) m.dispose();
  }
}
