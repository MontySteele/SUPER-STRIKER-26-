// Stadium (§7.1/§7A.5): modeled lower bowl, INSTANCED billboard crowd,
// floodlight pylons that bloom at night, scrolling LED ad boards, corner flags
// and a handful of waving team flags in the stands.
//
// The crowd is the change that matters. A rake used to be one quad wearing a
// canvas full of 2px fan blobs — which is a photograph of a crowd, and reads
// as one: perfectly still, perfectly flat, and visibly a texture the moment
// the camera gets within twenty metres. Now each rake is an InstancedMesh of
// billboard cards drawn from a four-frame sway/cheer atlas, tinted per
// instance toward the home kit, with a per-instance phase so no two blocks
// move together and a per-instance darkening that falls off up the rake. One
// draw call per rake, exactly as before; a crowd that moves, which is new.
//
// Everything animated here is driven by the dt the renderer hands down, which
// under capture is the harness's fixed virtual step — so a still is still a
// pure function of its shot spec.

import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import { applyShaderPatches, queueShaderPatch } from './materials';
import { TextureLab } from './TextureLab';
import type { QualityProfile } from './quality';
import type { TimeOfDay } from './scene';

const AD_MESSAGES = [
  'CLAWDE SPORTS', 'ANTHROPIC AIR', "SUPER STRIKER '26", '0 MICROTRANSACTIONS',
  'ONE MORE MATCH', 'CLAWDE SPORTS', 'GOOOOOAL FM 101.2', 'PS3-ERA & PROUD',
];

/** §7.1: three tiers of venue — Mega Bowl 80k / National 45k / Municipal 18k. */
export type StadiumSize = 'municipal' | 'national' | 'mega';

interface TierSpec { rise: number; run: number; y0: number; }

const SIZES: Record<StadiumSize, { tiers: TierSpec[]; roofY: number; lightH: number }> = {
  municipal: {
    tiers: [{ rise: 6, run: 10, y0: 1.2 }],
    roofY: 10.5, lightH: 26,
  },
  national: {
    tiers: [{ rise: 7, run: 11, y0: 1.4 }, { rise: 10, run: 11, y0: 9.6 }],
    roofY: 23.5, lightH: 38,
  },
  mega: {
    tiers: [
      { rise: 7, run: 11, y0: 1.4 },
      { rise: 10, run: 11, y0: 9.6 },
      { rise: 13, run: 12, y0: 20.5 },
    ],
    roofY: 36.5, lightH: 48,
  },
};

/** Metres between crowd cards along and up a rake. Each card carries a small
 *  cluster of fans, so this is block spacing, not seat spacing. */
const CARD_STEP_X = 2.1;
const CARD_STEP_Y = 1.45;
const CARD_W = 2.4;
const CARD_H = 1.75;

export class Stadium {
  private adTextures: THREE.CanvasTexture[] = [];
  private adOffset = 0;
  /** virtual seconds since kick-off, driving every sway in the bowl */
  private clock = 0;
  private swayUniforms: { value: number }[] = [];
  floodlightHeads: THREE.Mesh[] = [];

  /**
   * `hdrLamps` drives the floodlight heads' and the LED boards' emissive
   * level. With the §7A.6 HDR chain the bloom threshold sits at 1.3, so a lamp
   * that peaks at pure white is BELOW the threshold and glows not at all — it
   * has to be pushed genuinely overbright. RETRO bloom still runs on
   * tone-mapped LDR at threshold 0.82, where plain white was always right.
   */
  constructor(scene: THREE.Scene, private lab: TextureLab, tod: TimeOfDay,
    public size: StadiumSize = 'national', private hdrLamps = true,
    private profile?: QualityProfile, homeShirt = '#c8ccd4') {
    const night = tod === 'night';
    this.buildBowl(scene, night, homeShirt);
    this.buildFloodlights(scene, night);
    this.buildAdBoards(scene, night);
    this.buildCornerFlags(scene);
  }

  private get retro(): boolean {
    return this.profile?.retro ?? false;
  }

  // ------------------------------------------------------------ crowd cards

  /**
   * The shared crowd material: the four-frame atlas plus a vertex patch that
   * picks a frame and leans the card by the instance's own phase. Unlit on
   * purpose — it is exempt from the CSM registration rule (§7A.4), and the
   * time of day is baked into the instance tints instead, which costs nothing
   * and cannot go three times too bright.
   */
  private crowdMaterial(night: boolean): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({
      map: this.lab.crowdAtlas(night),
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      fog: true,
    });
    // NOT vertexColors. InstancedMesh.instanceColor defines USE_INSTANCING_COLOR
    // on its own and that is what tints the cards; asking for vertexColors as
    // well defines USE_COLOR, whose `color` attribute the card geometry does
    // not have — and an absent attribute reads as (0,0,0), i.e. a stand full
    // of black rectangles.
    const sway = { value: 0 };
    this.swayUniforms.push(sway);
    queueShaderPatch(mat, (shader) => {
      shader.uniforms.ss26Sway = sway;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aPhase;
          uniform float ss26Sway;
        `)
        .replace('#include <uv_vertex>', /* glsl */`
          #include <uv_vertex>
          {
            // four frames across the atlas; the phase decides which one and
            // when it changes, so a stand never claps in lockstep
            float f = floor( mod( ss26Sway * 2.6 + aPhase * 4.0, 4.0 ) );
            vMapUv = vMapUv * vec2( 0.25, 1.0 ) + vec2( f * 0.25, 0.0 );
          }
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          {
            // lean the card about its own base — a crowd sways, it does not
            // slide sideways
            float s = sin( ss26Sway * 1.7 + aPhase * 6.2831 );
            float up = clamp( ( position.y + ${(CARD_H / 2).toFixed(3)} ) / ${CARD_H.toFixed(3)}, 0.0, 1.0 );
            transformed.x += s * 0.10 * up;
            transformed.y += abs( s ) * 0.045 * up;
          }
        `);
    });
    // unlit, so nothing else will ever install a hook here; hang the patch now
    applyShaderPatches(mat);
    return mat;
  }

  /**
   * One InstancedMesh per rake. The instance tint carries three things at
   * once: the home-kit bias that makes a home end read as a home end, the
   * per-block colour variation, and the depth darkening that makes the upper
   * tiers recede (§7A.5) — all for free, because a tint is an attribute the
   * card was going to carry anyway.
   */
  private buildRake(stand: THREE.Group, len: number, rakeLen: number, theta: number,
    y0: number, rise: number, depth: number, run: number,
    tierIdx: number, tierCount: number, mat: THREE.MeshBasicMaterial,
    home: THREE.Color, night: boolean): void {
    const cols = Math.max(2, Math.floor(len / CARD_STEP_X));
    const rows = Math.max(1, Math.floor(rakeLen / CARD_STEP_Y));
    const count = cols * rows;

    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const phase = new Float32Array(count);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();
    const rng = this.lab.crowdRng();

    // The stand is built with the pitch toward -z, and a PlaneGeometry faces
    // +z — so every card turns to face the pitch first, and only then leans
    // back with the rake so the front rows don't clip the row behind them.
    const facePitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), theta * 0.5);

    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const along = -len / 2 + CARD_STEP_X * (c + 0.5) + rng.range(-0.25, 0.25);
        const up = (r + 0.5) / rows;
        const y = y0 + rise * up + rng.range(-0.08, 0.08);
        const z = depth + run * up;
        pos.set(along, y + CARD_H * 0.35, z);
        q.copy(facePitch).premultiply(lean);
        m.compose(pos, q, scl);
        inst.setMatrixAt(i, m);
        phase[i] = rng.next();

        // home-kit bias: about a third of the cards lean toward the shirt
        // colour, which is what a home end looks like from the far side
        const biased = rng.next() < 0.34;
        col.setRGB(1, 1, 1);
        if (biased) col.lerp(home, 0.62);
        else col.offsetHSL(0, 0, rng.range(-0.06, 0.06));
        // depth: the back of a rake and the upper tiers sit in the roof's
        // shade, and darkening them is most of what sells stadium scale
        const deep = (tierIdx / Math.max(1, tierCount - 1)) * 0.34 + up * 0.22;
        const lit = (night ? 0.62 : 1.0) * (1 - deep);
        col.multiplyScalar(lit);
        inst.setColorAt(i, col);
        i++;
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // Cull the rake as one object — that is the point of the instancing. It
    // has to be InstancedMesh.computeBoundingSphere (which walks the instance
    // matrices), not the geometry's: the geometry is a single 2.4m card sitting
    // at the origin, and culling against that would drop the whole stand the
    // moment the origin left frame. Pad it for the sway.
    inst.computeBoundingSphere();
    inst.boundingSphere!.radius += 1.5;
    stand.add(inst);
  }

  private buildBowl(scene: THREE.Scene, night: boolean, homeShirt: string): void {
    const concreteMat = new THREE.MeshPhongMaterial({ color: 0x2e3440 });
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x454e5e, shininess: 30 });
    // the back of the bowl behind the cards, so a gap between two cards shows
    // stadium shadow and not sky
    const voidMat = new THREE.MeshBasicMaterial({ color: night ? 0x0a0d14 : 0x171d27 });
    const crowdMat = this.retro ? null : this.crowdMaterial(night);
    const home = new THREE.Color(homeShirt);

    // one stand per side; built in local space with the pitch toward -z and
    // the tiers rising away toward +z, then rotated into place
    const stands: { len: number; rotY: number; cx: number; cz: number }[] = [
      { len: 130, rotY: 0, cx: 0, cz: HALF_W + 12 },
      { len: 130, rotY: Math.PI, cx: 0, cz: -(HALF_W + 12) },
      { len: 96, rotY: Math.PI / 2, cx: HALF_L + 14, cz: 0 },
      { len: 96, rotY: -Math.PI / 2, cx: -(HALF_L + 14), cz: 0 },
    ];

    const spec = SIZES[this.size];
    stands.forEach((s, standIdx) => {
      const stand = new THREE.Group();
      const tiers = spec.tiers;
      let depth = 0;
      tiers.forEach((t, tierIdx) => {
        const theta = Math.atan2(t.rise, t.run);
        const rakeLen = Math.hypot(t.rise, t.run);
        if (crowdMat) {
          // the terrace itself, dark, under the cards
          const floor = new THREE.Mesh(new THREE.PlaneGeometry(s.len, rakeLen), voidMat);
          floor.rotation.x = -Math.PI / 2 - theta;
          floor.position.set(0, t.y0 + t.rise / 2, depth + t.run / 2);
          stand.add(floor);
          this.buildRake(stand, s.len, rakeLen, theta, t.y0, t.rise, depth, t.run,
            tierIdx, tiers.length, crowdMat, home, night);
        } else {
          // RETRO (§7A.7): the v1.1 rake, one quad wearing a crowd texture
          const map = this.lab.retroCrowdTexture(night).clone();
          map.needsUpdate = true;
          map.repeat.set(s.len / 16, rakeLen / 5);
          const m = new THREE.MeshPhongMaterial({ map });
          const rake = new THREE.Mesh(new THREE.PlaneGeometry(s.len, rakeLen), m);
          rake.rotation.x = -Math.PI / 2 - theta;
          rake.position.set(0, t.y0 + t.rise / 2, depth + t.run / 2);
          stand.add(rake);
        }
        // concrete front wall of the tier
        const wallH = t.y0 + 0.2;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(s.len, wallH, 0.6), concreteMat);
        wall.position.set(0, wallH / 2, depth - 0.3);
        stand.add(wall);
        depth += t.run + 1.2;
      });
      // roof slab over the top tier
      const roof = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.8, 13), roofMat);
      roof.position.set(0, spec.roofY, depth - 7);
      stand.add(roof);
      // back wall
      const back = new THREE.Mesh(new THREE.BoxGeometry(s.len, spec.roofY - 0.5, 1), concreteMat);
      back.position.set(0, (spec.roofY - 0.5) / 2, depth + 0.4);
      stand.add(back);

      // a few team flags in the lower tier of the two long stands (§7A.5)
      if (crowdMat && standIdx < 2) {
        this.buildCrowdFlags(stand, s.len, spec.tiers[0], home, night);
      }

      stand.position.set(s.cx, 0, s.cz);
      stand.rotation.y = s.rotY;
      scene.add(stand);
    });
  }

  /** Instanced waving flags held up in the lower tier, home-kit tinted. */
  private buildCrowdFlags(stand: THREE.Group, len: number, tier: TierSpec,
    home: THREE.Color, night: boolean): void {
    const COUNT = 14;
    const geo = new THREE.PlaneGeometry(1.6, 1.0, 4, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: this.lab.flagTexture(), transparent: true, alphaTest: 0.2,
      side: THREE.DoubleSide,
    });
    const sway = { value: 0 };
    this.swayUniforms.push(sway);
    queueShaderPatch(mat, (shader) => {
      shader.uniforms.ss26Sway = sway;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float aPhase;\nuniform float ss26Sway;')
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          {
            // a travelling wave down the cloth, anchored at the pole edge
            float grip = clamp( position.x + 0.8, 0.0, 1.6 ) / 1.6;
            float w = sin( ss26Sway * 3.4 + aPhase * 6.2831 - grip * 4.5 );
            transformed.z += w * 0.22 * grip;
            transformed.y += w * 0.06 * grip;
          }
        `);
    });
    applyShaderPatches(mat);

    const inst = new THREE.InstancedMesh(geo, mat, COUNT);
    const phase = new Float32Array(COUNT);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const rng = this.lab.crowdRng();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const along = rng.range(-len / 2 + 6, len / 2 - 6);
      const up = rng.range(0.25, 0.8);
      m.compose(
        new THREE.Vector3(along, tier.y0 + tier.rise * up + 1.4, tier.run * up * 0.6),
        q.setFromEuler(new THREE.Euler(0, rng.range(-0.4, 0.4), 0)),
        new THREE.Vector3(1, 1, 1),
      );
      inst.setMatrixAt(i, m);
      phase[i] = rng.next();
      col.copy(home).multiplyScalar(night ? 0.7 : 1.05);
      inst.setColorAt(i, col);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.boundingSphere!.radius += 1.0;
    stand.add(inst);
  }

  // ------------------------------------------------------------ floodlights

  private buildFloodlights(scene: THREE.Scene, night: boolean): void {
    const poleMat = new THREE.MeshPhongMaterial({ color: 0x3a4150 });
    const headMat = new THREE.MeshBasicMaterial({
      color: night ? 0xffffff : 0xd8dde8,
    });
    if (this.hdrLamps) {
      // linear space on purpose: these values live above 1.0 and must not be
      // run through the sRGB decode a hex colour would get
      const lamp = night ? 4.5 : 1.35;
      headMat.color.setRGB(lamp, lamp, lamp * (night ? 1 : 1.04), THREE.LinearSRGBColorSpace);
    }
    const h = SIZES[this.size].lightH;
    // the flare sprites are additive and night-only: a lens flare on a sunny
    // afternoon is a screensaver, not a broadcast
    const flareMat = night && !this.retro ? new THREE.SpriteMaterial({
      map: this.lab.flareTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    }) : null;
    if (flareMat && this.hdrLamps) {
      flareMat.color.setRGB(2.1, 2.0, 1.75, THREE.LinearSRGBColorSpace);
    }

    for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const px = x * (HALF_L + 22);
      const pz = z * (HALF_W + 24);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, h, 8), poleMat);
      pole.position.set(px, h / 2, pz);
      scene.add(pole);
      // bank of lamps angled at the pitch — MeshBasicMaterial so bloom catches it
      const head = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 0.8), headMat);
      head.position.set(px * 0.965, h + 0.5, pz * 0.95);
      head.lookAt(0, 0, 0);
      this.floodlightHeads.push(head);
      scene.add(head);
      if (flareMat) {
        const flare = new THREE.Sprite(flareMat);
        flare.position.copy(head.position);
        flare.scale.setScalar(22);
        scene.add(flare);
      }
    }
  }

  // -------------------------------------------------------------- ad boards

  private buildAdBoards(scene: THREE.Scene, night: boolean): void {
    // one board segment per message, ringed around the pitch
    const H = 1.0;
    const segments: { x: number; z: number; rotY: number; w: number }[] = [];
    const N_LONG = 8;
    for (let i = 0; i < N_LONG; i++) {
      const w = (HALF_L * 2) / N_LONG;
      const x = -HALF_L + w / 2 + i * w;
      segments.push({ x, z: HALF_W + 3, rotY: Math.PI, w });
      segments.push({ x, z: -(HALF_W + 3), rotY: 0, w });
    }
    for (let i = 0; i < 4; i++) {
      const w = (HALF_W * 2) / 4;
      const z = -HALF_W + w / 2 + i * w;
      segments.push({ x: HALF_L + 3, z, rotY: -Math.PI / 2, w });
      segments.push({ x: -(HALF_L + 3), z, rotY: Math.PI / 2, w });
    }
    segments.forEach((s, i) => {
      // the message is drawn TWICE across the texture and each board shows
      // half of it, so a wrapping offset crawls the text past the board with
      // no seam and no second copy in frame
      const tex = this.lab.adTexture(AD_MESSAGES[i % AD_MESSAGES.length]).clone();
      tex.needsUpdate = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = 0.5;
      this.adTextures.push(tex);
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      if (this.hdrLamps && night) {
        // An LED board at night IS a light source, so the lettering has to
        // clear the 1.3 bloom threshold. 1.7x puts it a little over (~1.4
        // linear) and leaves the dark blue field at 0.25 — enough that the
        // board glows and not so much that the bloom eats the words, which is
        // what 2.4x did: a white bar where the sponsor used to be.
        mat.color.setRGB(1.7, 1.7, 1.74, THREE.LinearSRGBColorSpace);
      }
      const board = new THREE.Mesh(new THREE.PlaneGeometry(s.w - 0.4, H), mat);
      board.position.set(s.x, H / 2 + 0.05, s.z);
      board.rotation.y = s.rotY;
      scene.add(board);
    });
  }

  // ----------------------------------------------------------- corner flags

  private buildCornerFlags(scene: THREE.Scene): void {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.5 });
    const clothMat = new THREE.MeshStandardMaterial({
      color: 0xffcf2e, roughness: 0.75, side: THREE.DoubleSide,
    });
    const sway = { value: 0 };
    this.swayUniforms.push(sway);
    queueShaderPatch(clothMat, (shader) => {
      shader.uniforms.ss26Sway = sway;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float ss26Sway;')
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          {
            float grip = clamp( ( position.x + 0.18 ) / 0.36, 0.0, 1.0 );
            transformed.z += sin( ss26Sway * 4.2 - grip * 5.0 ) * 0.07 * grip;
            transformed.y += cos( ss26Sway * 4.2 - grip * 5.0 ) * 0.02 * grip;
          }
        `);
    });

    const poleGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6);
    const clothGeo = new THREE.PlaneGeometry(0.36, 0.26, 5, 1);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = 0.75;
        pole.castShadow = true;
        const cloth = new THREE.Mesh(clothGeo, clothMat);
        cloth.position.set(0.18 * sx, 1.32, 0);
        g.add(pole, cloth);
        g.position.set(HALF_L * sx, 0, HALF_W * sz);
        scene.add(g);
      }
    }
  }

  /**
   * Drive the bowl. `dt` is the renderer's frame step — the real clock in a
   * match, the harness's fixed virtual step under capture, which is what keeps
   * a still reproducible while the crowd genuinely animates in play.
   */
  update(dt: number): void {
    this.clock += dt;
    for (const u of this.swayUniforms) u.value = this.clock;
    // the boards actually scroll: the message is drawn twice across the
    // texture and wrapS repeats, so the crawl never tears
    this.adOffset = (this.adOffset + dt * 0.045) % 1;
    for (const tex of this.adTextures) tex.offset.x = this.adOffset;
  }
}
