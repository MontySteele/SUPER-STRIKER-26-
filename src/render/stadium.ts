// Stadium (§7.1/§7A.5): modeled lower bowl, a 3D instanced CROWD in the tier
// nearest the pitch, billboard cards above it, floodlight pylons that bloom at
// night, cycling LED ad boards, dugouts, a tunnel mouth, corner flags and a
// handful of waving team flags in the stands.
//
// The crowd is the change that matters, and it has now been made twice. v1.1
// was one quad per rake wearing a canvas full of 2px fan blobs — a photograph
// of a crowd, which reads as one. v1.2 replaced it with instanced billboard
// cards on a four-frame atlas: a crowd that moves, but still a crowd with no
// silhouette, which falls apart the moment the touchline camera drops to knee
// height. v1.3 (this file, plus crowd.ts) makes the tier you actually look at
// out of PEOPLE — 62-triangle figures, instanced once per stand, animated
// entirely in the vertex shader and reacting to the match through eight floats
// of uniform. The upper tiers keep the cards, because at 40m up a card is
// exactly as good and a hundredth of the cost.
//
// Everything animated here is driven by the dt the renderer hands down, which
// under capture is the harness's fixed virtual step — so a still is still a
// pure function of its shot spec.

import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import type { MatchEvent } from '../sim/matchEvents';
import { Crowd, CROWD_DETAIL, type CrowdBlock, type CrowdReaction } from './crowd';
import { applyShaderPatches, queueShaderPatch } from './materials';
import { TextureLab } from './TextureLab';
import type { QualityProfile } from './quality';
import type { TimeOfDay } from './scene';

/**
 * Fake sponsors (§7.1 names the first two). Every board cycles through three
 * of these, staggered around the pitch, so the ring is never showing one
 * frozen set of words — which is the difference between an LED board and a
 * hoarding.
 */
const AD_MESSAGES = [
  'CLAWDE SPORTS', 'ANTHROPIC AIR', "SUPER STRIKER '26", '0 MICROTRANSACTIONS',
  'ONE MORE MATCH', 'GOOOOOAL FM 101.2', 'PS3-ERA & PROUD', 'MULBERRY32 LAGER',
  'FIXED TIMESTEP WATCHES', 'THE OFFSIDE TRAP PODCAST', 'VERTEX MUTUAL',
  'TOUCHLINE TYRES', 'DEEP LYING MIDFIELD FM', 'NO VAR, NO PROBLEM',
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

/** The players' tunnel, cut into the front of the far touchline's lower tier.
 *  The block is taller than the opening because it has to hold the terrace up
 *  — which is why it interrupts the first few rows of seats. */
const TUNNEL_HALF_W = 3.4;
const TUNNEL_H = 2.6;
const TUNNEL_BLOCK_H = 3.5;
const TUNNEL_DEPTH = 8.0;

/**
 * Where the teams come out.
 *
 * Scene coords (x along the pitch length, y up, z across the width = sim y).
 * The mouth sits on the FAR touchline at the halfway line — the side the
 * broadcast camera is pointed at — flush with the front wall of the lower
 * tier, with the dugouts either side of it. `facing` is the unit vector a
 * player walks along coming out of it, i.e. straight at the pitch.
 *
 * Exported because the cutscene layer walks the line-up out from here; it is a
 * constant rather than a magic number in two files so that moving the bowl
 * moves the tunnel with it.
 */
export const TUNNEL_MOUTH: Readonly<{
  x: number; y: number; z: number; facing: readonly [number, number, number];
}> = Object.freeze({
  x: 0,
  y: 0,
  z: -(HALF_W + 11.2),
  facing: [0, 0, 1] as const,
});

export class Stadium {
  /** one entry per board segment; each holds its own cycle of messages */
  private adBoards: {
    mat: THREE.MeshBasicMaterial;
    maps: THREE.CanvasTexture[];
    idx: number;
    next: number;
  }[] = [];
  private adOffset = 0;
  /** virtual seconds since kick-off, driving every sway in the bowl */
  private clock = 0;
  private swayUniforms: { value: number }[] = [];
  floodlightHeads: THREE.Mesh[] = [];
  /** The 3D crowd. Always constructed; inert (`live === false`) on RETRO. */
  readonly crowd: Crowd;
  /** billboard cards actually laid out, for the budget line */
  private cardCount = 0;
  private cardCalls = 0;

  /**
   * `hdrLamps` drives the floodlight heads' and the LED boards' emissive
   * level. With the §7A.6 HDR chain the bloom threshold sits at 1.3, so a lamp
   * that peaks at pure white is BELOW the threshold and glows not at all — it
   * has to be pushed genuinely overbright. RETRO bloom still runs on
   * tone-mapped LDR at threshold 0.82, where plain white was always right.
   */
  constructor(scene: THREE.Scene, private lab: TextureLab, tod: TimeOfDay,
    public size: StadiumSize = 'national', private hdrLamps = true,
    private profile?: QualityProfile, homeShirt = '#c8ccd4', awayShirt = '#8a93a8') {
    const night = tod === 'night';
    this.crowd = new Crowd(
      lab.crowdRng(), tod,
      CROWD_DETAIL[this.profile?.level ?? 'high'],
      new THREE.Color(homeShirt), new THREE.Color(awayShirt),
    );
    this.buildBowl(scene, night, homeShirt);
    this.buildTunnel(scene, night);
    this.buildDugouts(scene, homeShirt, awayShirt);
    this.buildFloodlights(scene, night);
    this.buildAdBoards(scene, night);
    this.buildCornerFlags(scene);
    const b = this.crowd.budget;
    console.info(`crowd: ${b.figures} 3D figures (${b.triangles} tris, ${b.drawCalls} calls)`
      + ` + ${this.cardCount} billboard cards (${this.cardCount * 2} tris,`
      + ` ${this.cardCalls} calls) — ${b.triangles + this.cardCount * 2} tris total`);
  }

  private get retro(): boolean {
    return this.profile?.retro ?? false;
  }

  // ------------------------------------------------------------ crowd cards

  /**
   * The shared crowd-card material: the four-frame atlas plus a vertex patch
   * that picks a frame and leans the card by the instance's own phase. Unlit
   * on purpose — it is exempt from the CSM registration rule (§7A.4), and the
   * time of day is baked into the instance tints instead, which costs nothing
   * and cannot go three times too bright.
   *
   * Cards now only ever dress the UPPER tiers; the tier nearest the pitch is
   * crowd.ts's job.
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
   * Lay out one rake's worth of cards into the caller's accumulator. Every
   * upper tier of a stand shares ONE InstancedMesh, emitted by flushCards() —
   * a Mega Bowl otherwise spends eight draw calls on the two tiers nobody can
   * resolve, and the whole crowd has twelve to spend.
   */
  private layOutCards(acc: CardAcc, len: number, rakeLen: number, theta: number,
    y0: number, rise: number, depth: number, run: number,
    tierIdx: number, tierCount: number, home: THREE.Color, night: boolean): void {
    const cols = Math.max(2, Math.floor(len / CARD_STEP_X));
    const rows = Math.max(1, Math.floor(rakeLen / CARD_STEP_Y));
    const rng = this.lab.crowdRng();
    const col = new THREE.Color();

    // The stand is built with the pitch toward -z, and a PlaneGeometry faces
    // +z — so every card turns to face the pitch first, and only then leans
    // back with the rake so the front rows don't clip the row behind them.
    const facePitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), theta * 0.5);
    const q = new THREE.Quaternion().copy(facePitch).premultiply(lean);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const along = -len / 2 + CARD_STEP_X * (c + 0.5) + rng.range(-0.25, 0.25);
        const up = (r + 0.5) / rows;
        const y = y0 + rise * up + rng.range(-0.08, 0.08);
        const z = depth + run * up;
        acc.pos.push(new THREE.Vector3(along, y + CARD_H * 0.35, z));
        acc.rot.push(q);
        acc.phase.push(rng.next());

        // home-kit bias: about a third of the cards lean toward the shirt
        // colour, which is what a home end looks like from the far side
        const biased = rng.next() < 0.34;
        col.setRGB(1, 1, 1);
        if (biased) col.lerp(home, 0.62);
        else col.offsetHSL(0, 0, rng.range(-0.06, 0.06));
        // depth: the back of a rake and the upper tiers sit in the roof's
        // shade, and darkening them is most of what sells stadium scale
        const deep = (tierIdx / Math.max(1, tierCount - 1)) * 0.42 + up * 0.26;
        const lit = (night ? 0.58 : 0.88) * (1 - deep);
        acc.col.push(col.clone().multiplyScalar(lit));
      }
    }
  }

  /** Emit one stand's accumulated cards as a single InstancedMesh. */
  private flushCards(stand: THREE.Group, acc: CardAcc, mat: THREE.MeshBasicMaterial): void {
    const count = acc.pos.length;
    if (count === 0) return;
    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    inst.castShadow = false;
    const phase = new Float32Array(count);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const m = new THREE.Matrix4();
    const scl = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      m.compose(acc.pos[i], acc.rot[i], scl);
      inst.setMatrixAt(i, m);
      phase[i] = acc.phase[i];
      inst.setColorAt(i, acc.col[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // Cull the stand's cards as one object — that is the point of the
    // instancing. It has to be InstancedMesh.computeBoundingSphere (which
    // walks the instance matrices), not the geometry's: the geometry is a
    // single 2.4m card sitting at the origin, and culling against that would
    // drop the whole stand the moment the origin left frame. Pad it for sway.
    inst.computeBoundingSphere();
    if (inst.boundingSphere) inst.boundingSphere.radius += 1.5;
    stand.add(inst);
    this.cardCount += count;
    this.cardCalls += 1;
  }

  private buildBowl(scene: THREE.Scene, night: boolean, homeShirt: string): void {
    const concreteMat = new THREE.MeshPhongMaterial({ color: 0x2e3440 });
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x454e5e, shininess: 30 });
    // the back of the bowl behind the cards, so a gap between two cards shows
    // stadium shadow and not sky
    const voidMat = new THREE.MeshBasicMaterial({ color: night ? 0x0a0d14 : 0x171d27 });
    const crowdMat = this.retro ? null : this.crowdMaterial(night);
    const home = new THREE.Color(homeShirt);

    // One stand per side, built in local space with the pitch toward -z and
    // the tiers rising away toward +z, then rotated into place.
    //
    // `detail` is the §7A.5 cull-by-usefulness rule made explicit: the
    // broadcast camera lives on the +z touchline looking across at the -z one,
    // so the far stand fills every seat, the ends get most of them, and the
    // stand directly behind the camera — which is on screen for roughly one
    // replay angle a match — gets under half.
    //
    // `alle0/alle1` are the allegiance at local x = -len/2 and +len/2. The
    // away support gets the east end and bleeds a little way along each
    // touchline; everything else is a home ground.
    const stands: {
      len: number; rotY: number; cx: number; cz: number;
      detail: number; alle0: number; alle1: number;
      gaps?: [number, number][]; gapTop?: number; tunnel?: boolean;
    }[] = [
      { len: 130, rotY: 0, cx: 0, cz: HALF_W + 12, detail: 0.55, alle0: 1.0, alle1: 0.45 },
      {
        len: 130, rotY: Math.PI, cx: 0, cz: -(HALF_W + 12),
        detail: 1.0, alle0: 0.45, alle1: 1.0, tunnel: true,
        // the tunnel block eats the front rows at the halfway line; everything
        // above it is sitting on the lid and stays
        gaps: [[-TUNNEL_HALF_W - 1.7, TUNNEL_HALF_W + 1.7]], gapTop: TUNNEL_BLOCK_H,
      },
      { len: 96, rotY: Math.PI / 2, cx: HALF_L + 14, cz: 0, detail: 0.70, alle0: 0.0, alle1: 0.0 },
      { len: 96, rotY: -Math.PI / 2, cx: -(HALF_L + 14), cz: 0, detail: 0.72, alle0: 1.0, alle1: 1.0 },
    ];

    const spec = SIZES[this.size];
    stands.forEach((s, standIdx) => {
      const stand = new THREE.Group();
      const tiers = spec.tiers;
      const acc: CardAcc = { pos: [], rot: [], phase: [], col: [] };
      let depth = 0;
      tiers.forEach((t, tierIdx) => {
        const theta = Math.atan2(t.rise, t.run);
        const rakeLen = Math.hypot(t.rise, t.run);
        if (crowdMat) {
          // the terrace itself, dark, under the crowd
          const floor = new THREE.Mesh(new THREE.PlaneGeometry(s.len, rakeLen), voidMat);
          floor.rotation.x = -Math.PI / 2 - theta;
          floor.position.set(0, t.y0 + t.rise / 2, depth + t.run / 2);
          stand.add(floor);
          if (tierIdx === 0 && this.crowd.live) {
            // the tier you can actually see gets real people
            const block: CrowdBlock = {
              cx: s.cx, cz: s.cz, rotY: s.rotY, len: s.len,
              y0: t.y0, rise: t.rise, run: t.run, depth: 0,
              detail: s.detail, gaps: s.gaps, gapTop: s.gapTop,
              alle0: s.alle0, alle1: s.alle1,
            };
            this.crowd.seat(scene, block);
          } else {
            this.layOutCards(acc, s.len, rakeLen, theta, t.y0, t.rise, depth, t.run,
              tierIdx, tiers.length, home, night);
          }
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
        // Concrete front wall of the tier — split either side of the tunnel on
        // the one tier that has one, because a solid wall across the mouth is
        // a tunnel you cannot walk out of.
        const wallH = t.y0 + 0.2;
        if (s.tunnel && tierIdx === 0) {
          const half = (s.len / 2 - TUNNEL_HALF_W);
          for (const sx of [-1, 1]) {
            const w = new THREE.Mesh(new THREE.BoxGeometry(half, wallH, 0.6), concreteMat);
            w.position.set(sx * (TUNNEL_HALF_W + half / 2), wallH / 2, depth - 0.3);
            stand.add(w);
          }
        } else {
          const wall = new THREE.Mesh(new THREE.BoxGeometry(s.len, wallH, 0.6), concreteMat);
          wall.position.set(0, wallH / 2, depth - 0.3);
          stand.add(wall);
        }
        depth += t.run + 1.2;
      });
      if (crowdMat) this.flushCards(stand, acc, crowdMat);
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
    const COUNT = 10;
    const geo = new THREE.PlaneGeometry(1.15, 0.7, 4, 1);
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
            // (0.575 / 1.15 = the flag's own half-width and width)
            float grip = clamp( position.x + 0.575, 0.0, 1.15 ) / 1.15;
            float w = sin( ss26Sway * 3.4 + aPhase * 6.2831 - grip * 4.5 );
            transformed.z += w * 0.22 * grip;
            transformed.y += w * 0.06 * grip;
          }
        `);
    });
    applyShaderPatches(mat);

    const inst = new THREE.InstancedMesh(geo, mat, COUNT);
    inst.castShadow = false;
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
      // dim: a flag held up in a stand is cloth in the roof's shade, and at
      // full kit value ten of them read as ten glowing slabs
      col.copy(home).multiplyScalar(night ? 0.32 : 0.55);
      inst.setColorAt(i, col);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    if (inst.boundingSphere) inst.boundingSphere.radius += 1.0;
    stand.add(inst);
  }

  // ----------------------------------------------------------------- tunnel

  /**
   * The players' tunnel: a recessed mouth in the front wall of the far
   * touchline at the halfway line, with a lit lintel over it. Deliberately a
   * hole rather than a doorway — a dark rectangle under a bright sign is what
   * a tunnel looks like on television, and it gives the cutscene layer
   * somewhere real to walk a line-up out of (TUNNEL_MOUTH).
   */
  private buildTunnel(scene: THREE.Scene, night: boolean): void {
    const g = new THREE.Group();
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x252a35 });
    // the throat is a box drawn from the inside, so the mouth is a hole rather
    // than a black rectangle stuck on the wall
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x05070b, side: THREE.BackSide });
    const W = TUNNEL_HALF_W * 2;

    const throat = new THREE.Mesh(
      new THREE.BoxGeometry(W, TUNNEL_H, TUNNEL_DEPTH), darkMat);
    throat.position.set(0, TUNNEL_H / 2, -TUNNEL_DEPTH / 2 - 0.05);
    g.add(throat);

    // the block that holds the terrace up over the mouth: two piers and a lid
    const pierW = 1.6;
    for (const sx of [-1, 1]) {
      const pier = new THREE.Mesh(
        new THREE.BoxGeometry(pierW, TUNNEL_BLOCK_H, TUNNEL_DEPTH), wallMat);
      pier.position.set(sx * (TUNNEL_HALF_W + pierW / 2), TUNNEL_BLOCK_H / 2,
        -TUNNEL_DEPTH / 2);
      pier.castShadow = true;
      g.add(pier);
    }
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(W + pierW * 2, TUNNEL_BLOCK_H - TUNNEL_H, TUNNEL_DEPTH),
      wallMat);
    lid.position.set(0, (TUNNEL_BLOCK_H + TUNNEL_H) / 2, -TUNNEL_DEPTH / 2);
    lid.castShadow = true;
    g.add(lid);

    // A lit sign over the mouth. At night it is the one warm thing on that
    // side of the ground, which is exactly what it is in real life. The LED
    // bake draws its message twice across the texture, so show half of it.
    const signTex = this.lab.adTexture('PLAYERS').clone();
    signTex.needsUpdate = true;
    // the LED bake paints its message at u=0.25 and u=0.75; a half-width
    // window starting at 0 frames the first copy dead centre, and starting at
    // 0.25 frames the TAIL of one and the HEAD of the other ("TERS PLAY")
    signTex.repeat.x = 0.5;
    signTex.offset.x = 0;
    const signMat = new THREE.MeshBasicMaterial({ map: signTex });
    if (this.hdrLamps) {
      const k = night ? 1.9 : 1.15;
      signMat.color.setRGB(k, k * 0.97, k * 0.9, THREE.LinearSRGBColorSpace);
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.72, 0.5), signMat);
    sign.position.set(0, TUNNEL_H + 0.42, 0.06);
    g.add(sign);

    // the far stand faces +z, so the mouth already opens toward the pitch
    g.position.set(TUNNEL_MOUTH.x, 0, TUNNEL_MOUTH.z);
    scene.add(g);
  }

  // ---------------------------------------------------------------- dugouts

  /**
   * Two dugouts flanking the tunnel, each with a bench and five seated
   * figures. They use the crowd's own instancing and uniforms, so the subs
   * come off the bench on a goal for nothing.
   */
  private buildDugouts(scene: THREE.Scene, homeShirt: string, awayShirt: string): void {
    const shellMat = new THREE.MeshPhongMaterial({ color: 0x1d2230, shininess: 18 });
    const glassMat = new THREE.MeshPhongMaterial({
      color: 0x8fa8c4, transparent: true, opacity: 0.22, shininess: 90,
    });
    const benchMat = new THREE.MeshPhongMaterial({ color: 0x323a49 });
    const z = -(HALF_W + 6.4);
    const spots: {
      x: number; y: number; z: number; rotY: number; alle: number; shirt: THREE.Color;
    }[] = [];
    const rng = this.lab.crowdRng();

    [-1, 1].forEach((sx) => {
      const g = new THREE.Group();
      const W = 9.5, D = 3.0, H = 2.35;
      // back + roof + two ends; the front is open toward the pitch
      const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.25), shellMat);
      back.position.set(0, H / 2, -D / 2);
      back.castShadow = true;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.22, D + 0.5), shellMat);
      roof.position.set(0, H, 0);
      roof.castShadow = true;
      g.add(back, roof);
      for (const ex of [-1, 1]) {
        const end = new THREE.Mesh(new THREE.BoxGeometry(0.2, H, D), glassMat);
        end.position.set(ex * W / 2, H / 2, 0);
        g.add(end);
      }
      const bench = new THREE.Mesh(new THREE.BoxGeometry(W - 0.8, 0.18, 0.75), benchMat);
      bench.position.set(0, 0.46, -D / 2 + 0.75);
      g.add(bench);
      g.position.set(sx * 14.5, 0, z);
      scene.add(g);

      // the occupants: the home bench in the home tracksuit, the away bench in
      // the away one. Deterministic — this draws from the seeded dress stream.
      const kit = new THREE.Color(sx < 0 ? homeShirt : awayShirt);
      const coach = new THREE.Color(0x14171f);
      for (let i = 0; i < 5; i++) {
        spots.push({
          x: sx * 14.5 + (i - 2) * 1.55 + rng.range(-0.18, 0.18),
          y: 0.44,
          z: z - 0.62,
          rotY: Math.PI + rng.range(-0.12, 0.12),
          alle: sx < 0 ? 1 : 0,
          shirt: (i === 0 ? coach : kit).clone().offsetHSL(0, 0, rng.range(-0.05, 0.03)),
        });
      }
    });
    this.crowd.seatBench(scene, spots);
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
    // a second, much wider and much weaker sprite: the haze the rig throws
    // into the night air, which is what gives a floodlight its size
    const haloMat = flareMat ? flareMat.clone() : null;
    if (haloMat) haloMat.color.setRGB(0.5, 0.55, 0.72, THREE.LinearSRGBColorSpace);

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
      if (haloMat) {
        const halo = new THREE.Sprite(haloMat);
        halo.position.copy(head.position);
        halo.scale.setScalar(62);
        scene.add(halo);
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
      // Each board cycles three messages. The message is drawn TWICE across
      // the texture and each board shows half of it, so a wrapping offset
      // crawls the text past the board with no seam and no second copy in
      // frame; the cycle is what makes it an LED board rather than a hoarding.
      const maps: THREE.CanvasTexture[] = [];
      for (let k = 0; k < 3; k++) {
        const tex = this.lab.adTexture(AD_MESSAGES[(i * 3 + k * 5) % AD_MESSAGES.length]).clone();
        tex.needsUpdate = true;
        tex.wrapS = THREE.RepeatWrapping;
        tex.repeat.x = 0.5;
        maps.push(tex);
      }
      const mat = new THREE.MeshBasicMaterial({ map: maps[0] });
      if (this.hdrLamps && night) {
        // An LED board at night IS a light source, so the lettering has to
        // clear the 1.3 bloom threshold. 1.7x puts it a little over (~1.4
        // linear) and leaves the dark blue field at 0.25 — enough that the
        // board glows and not so much that the bloom eats the words, which is
        // what 2.4x did: a white bar where the sponsor used to be.
        mat.color.setRGB(1.7, 1.7, 1.74, THREE.LinearSRGBColorSpace);
      }
      // stagger the switch so the ring ripples round rather than blinking
      this.adBoards.push({ mat, maps, idx: 0, next: 5 + i * 0.7 });
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

  // ------------------------------------------------------------ crowd API
  // Thin pass-throughs so the renderer talks to one object. The behaviour
  // itself lives in crowd.ts.

  /** The match's running anticipation, 0..1 (§7.3's attackBuildup). */
  setExcitement(v: number): void {
    this.crowd.setExcitement(v);
  }

  /** One match beat. `teamIdx` is whose beat it is. */
  react(kind: CrowdReaction, teamIdx = 0): void {
    this.crowd.react(kind, teamIdx);
  }

  /**
   * Translate the sim's event feed into crowd behaviour. Everything the stands
   * need is already in the feed the ticker and the audio conductor read, which
   * is exactly why the crowd can never fall out of sync with the match — the
   * failure §7.3 exists to avoid.
   */
  crowdEvent(e: MatchEvent): void {
    switch (e.type) {
      case 'attackBuildup': this.crowd.setExcitement(e.level); break;
      case 'goal': this.crowd.react('goal', e.teamIdx); break;
      case 'shot': this.crowd.react('shot', e.teamIdx); break;
      // teamIdx on a save is the KEEPER's team: his end applauds, the other groans
      case 'save': this.crowd.react('save', e.teamIdx); break;
      case 'post': this.crowd.react('post'); break;
      case 'miss': this.crowd.react('miss', e.teamIdx); break;
      case 'offside': this.crowd.react('miss', e.teamIdx); break;
      case 'card': this.crowd.react('card', e.teamIdx); break;
      case 'foul': this.crowd.react('card', e.teamIdx); break;
      case 'corner': this.crowd.react('corner', e.teamIdx); break;
      case 'penaltyAwarded': this.crowd.react('penalty', e.teamIdx); break;
      case 'penTension': this.crowd.react('penalty'); break;
      case 'penKick': this.crowd.react('shot', e.teamIdx); break;
      case 'kickoff': this.crowd.react('kickoff'); break;
      // 'break' is half time and the end of extra-time periods alike: sit down
      case 'break': this.crowd.react('halftime'); break;
      case 'fulltime': this.crowd.react('fulltime'); break;
      default: break;
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
    this.crowd.update(dt);
    // the boards actually scroll: the message is drawn twice across the
    // texture and wrapS repeats, so the crawl never tears
    this.adOffset = (this.adOffset + dt * 0.045) % 1;
    for (const b of this.adBoards) {
      if (this.clock >= b.next) {
        b.idx = (b.idx + 1) % b.maps.length;
        b.mat.map = b.maps[b.idx];
        b.mat.needsUpdate = true;
        b.next = this.clock + 9;
      }
      b.maps[b.idx].offset.x = this.adOffset;
    }
  }
}

/** Card instances gathered across a stand's upper tiers before they are
 *  emitted as one InstancedMesh. */
interface CardAcc {
  pos: THREE.Vector3[];
  rot: THREE.Quaternion[];
  phase: number[];
  col: THREE.Color[];
}
