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
// out of PEOPLE — swept low-poly figures (116 triangles in v1.4, up from v1.3's
// 62 boxes), instanced once per stand, animated entirely in the vertex shader
// and reacting to the match through eight floats of uniform. The upper tiers
// keep the cards, because at 40m up a card is exactly as good and a hundredth
// of the cost.
//
// v1.5 is the BOWL AROUND the crowd, which had the same problem one layer out:
// a stand made of people standing on a black slab under a black slab is still
// a photograph of a stadium. So the terrace is now rows of seats with the step
// shadow baked per row (TextureLab.terraceSeats, tiled at the crowd's own row
// pitch so a seat lands under every figure), the roof has a soffit, trusses, a
// fascia and columns, the masts have real heads, the stands have vomitories,
// railings and a gantry, and the Mega Bowl has a band of executive glazing
// that lights up at night. All of it is ONE instanced draw call — see Piece.
//
// Everything animated here is driven by the dt the renderer hands down, which
// under capture is the harness's fixed virtual step — so a still is still a
// pure function of its shot spec.

import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import type { MatchEvent } from '../sim/matchEvents';
import { Crowd, CROWD_DETAIL, type CrowdBlock, type CrowdReaction } from './crowd';
import { applyShaderPatches, queueShaderPatch, SHADOW_LAYER } from './materials';
import { floodlightsLit } from './weather';
import { FACADE_TILE_M, TERRACE_TILE_M, TextureLab } from './TextureLab';
import {
  boardHousings, buildCarpets, dressPitchside, LedRibbon, perimeterWallTexture, pitchsideEnabled,
  type BenchSpot, type PitchsideSink,
} from './pitchside';
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
/**
 * §7A.5b — THE BUILT BOWL.
 *
 * Every hard surface added in v1.5 (roof trusses, the fascia, columns,
 * pilasters, vomitory slots, railings, the gantry, the floodlight lattice and
 * the Mega Bowl's tier lip) is a UNIT BOX in ONE InstancedMesh, tinted per
 * instance. That is the whole budget trick: a stadium's structure is a few
 * hundred boxes, and a few hundred boxes drawn one at a time is four hundred
 * draw calls, which is the entire frame. Drawn as instances it is ONE, and the
 * shade each piece sits in is baked into its instance colour the same way the
 * crowd bakes its own — a truss under a roof is dark because it is under a
 * roof, not because a light says so.
 *
 * Positions are built in STAND-LOCAL space (pitch toward -z, tiers rising
 * toward +z) and multiplied by the stand's own frame on the way in, so the
 * code reads the way the stand is drawn and the mesh still lives in the scene.
 */
interface Piece { m: THREE.Matrix4; c: THREE.Color; }

/** Metres between roof cross-trusses, roof columns, exterior pilasters and
 *  front-rail posts. Spacings, not counts: a 96m end and a 130m touchline get
 *  the same rhythm, which is what stops the ends reading as a different
 *  building. */
const TRUSS_STEP = 5.5;
const COLUMN_STEP = 11;
const PILASTER_STEP = 8;
const RAIL_POST_STEP = 3;
/** Vomitory slots land on every other terrace aisle. */
const VOM_STEP = TERRACE_TILE_M * 2;

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
  /** the board layout, kept for the housings behind the screens (§7A.5c) */
  private boardSegments: { x: number; z: number; rotY: number; w: number }[] = [];
  /** virtual seconds since kick-off, driving every sway in the bowl */
  private clock = 0;
  private swayUniforms: { value: number }[] = [];
  /** One per mast, carrying the head's position and aim. Since v1.5 the head
   *  is a lattice of instances rather than a slab, so outside RETRO this mesh
   *  is an invisible LOCATOR — the flares hang off its transform. */
  floodlightHeads: THREE.Mesh[] = [];
  /** The 3D crowd. Always constructed; inert (`live === false`) on RETRO. */
  readonly crowd: Crowd;
  /** billboard cards actually laid out, for the budget line */
  private cardCount = 0;
  private cardCalls = 0;
  /** §7A.5b: every structural box in the bowl, drawn as one InstancedMesh */
  private pieces: Piece[] = [];
  /** the Mega Bowl's executive glazing — its own mesh because the panes are
   *  unlit and, at night, overbright enough for the bloom to find them */
  private panes: Piece[] = [];
  /** lamp cells in the floodlight heads, ditto */
  private lamps: Piece[] = [];
  /**
   * §7A.4b — THE ROOF SHADOW.
   *
   * The bowl used to cast nothing, on the argument that "the structure that
   * would throw a shadow anywhere the camera looks is 25m above the pitch and
   * the sun is never low enough for it to reach". That is arithmetically
   * wrong. The 'day' key sits at 26° of elevation, so a roof lip 23.5m up
   * throws its line 48m along the ground — and the near touchline's roof lip
   * is 22m outside the touchline, which lands the line at z ≈ +22, a third of
   * the way across the pitch. That missing line is most of why the picture
   * reads as "rendered, not filmed": a real late-afternoon broadcast is half
   * sunlit grass and half roof shade, and the players cross the boundary.
   *
   * These are PROXIES, not the real roofs: four unit boxes in one
   * InstancedMesh, on SHADOW_LAYER and nothing else, so the game camera never
   * draws them and the cascades pay one draw call each. Casting off the real
   * roof meshes would be four draws per cascade for the same silhouette; the
   * trusses and columns under the roof are deliberately NOT casters, because
   * at 48m of throw a 0.34m truss is a ~1-texel stripe that only ever reads as
   * shadow-map aliasing.
   */
  private casters: Piece[] = [];
  /** §7A.5c: every seated person outside the stands (dugouts, photographers,
   *  stewards, officials), flushed as ONE Crowd.seatBench instance mesh */
  private benchSpots: BenchSpot[] = [];
  /** the balcony LED ribbon (pitchside.ts); null on RETRO / one-tier bowls */
  private ribbon: LedRibbon | null = null;
  /** balcony spans collected by buildBowl for the ribbon */
  private ribbonSpans: { frame: THREE.Matrix4; len: number; h: number }[] = [];

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
    // §7A.4c: the LAMPS are not the same question as the TIME. A wet Tuesday
    // afternoon has the floodlights on and daylight in the stands, and the
    // crowd bake, the seat shading and the impostor tints all still want
    // 'day'. `night` dresses the bowl; `lampsLit` switches the rig on.
    const lampsLit = floodlightsLit(tod);
    this.crowd = new Crowd(
      lab.crowdRng(), tod,
      CROWD_DETAIL[this.profile?.level ?? 'high'],
      new THREE.Color(homeShirt), new THREE.Color(awayShirt),
    );
    this.buildBowl(scene, night, homeShirt, awayShirt);
    this.buildTunnel(scene, night);
    this.buildDugouts(scene, homeShirt, awayShirt);
    this.buildFloodlights(scene, lampsLit);
    this.buildAdBoards(scene, lampsLit);
    this.buildCornerFlags(scene);
    this.buildPitchside(scene, lampsLit);
    this.flushStructure(scene);
    const b = this.crowd.budget;
    console.info(`crowd: ${b.figures} 3D figures (${b.triangles} tris, ${b.drawCalls} calls)`
      + ` + ${this.cardCount} billboard cards (${this.cardCount * 2} tris,`
      + ` ${this.cardCalls} calls) — ${b.triangles + this.cardCount * 2} tris total`);
  }

  // ------------------------------------------------------------- structure

  /**
   * Place one unit box inside a stand's frame. `shade` is the fraction of the
   * surface colour the piece keeps — the roof's underside is the same concrete
   * as its top, it is simply never lit, and a 0.3 here is cheaper and steadier
   * than trying to get a shadow map to say so from 40 metres up.
   */
  private piece(frame: THREE.Matrix4, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, hex: number, shade = 1,
    into: Piece[] = this.pieces, rot?: THREE.Quaternion): void {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      rot ?? new THREE.Quaternion(),
      new THREE.Vector3(sx, sy, sz),
    );
    into.push({ m: m.premultiply(frame), c: new THREE.Color(hex).multiplyScalar(shade) });
  }

  /** Emit one InstancedMesh from an accumulator, or nothing if it is empty. */
  private emit(scene: THREE.Scene, list: Piece[], geo: THREE.BufferGeometry,
    mat: THREE.Material): THREE.InstancedMesh | null {
    if (list.length === 0) { geo.dispose(); mat.dispose(); return null; }
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // The DRAWN bowl never casts into the cascades — see `casters` above for
    // the proxy that does. Receiving is off for the same reason instance shade
    // is baked.
    inst.castShadow = false;
    inst.receiveShadow = false;
    for (let i = 0; i < list.length; i++) {
      inst.setMatrixAt(i, list[i].m);
      inst.setColorAt(i, list[i].c);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
    return inst;
  }

  /**
   * One draw call for the whole bowl's structure, one for its glazing, one for
   * its lamps. Called once, after every builder has had its say.
   */
  private flushStructure(scene: THREE.Scene): void {
    const boxes = this.pieces.length + this.panes.length + this.lamps.length;
    this.emit(scene, this.pieces, new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 12 }));
    this.emit(scene, this.panes, new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }));
    this.emit(scene, this.lamps, new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }));
    this.flushCasters(scene);
    if (boxes) {
      console.info(`stadium: ${this.pieces.length} structure + ${this.panes.length} panes`
        + ` + ${this.lamps.length} lamps = ${boxes} instances`
        + ` (${this.pieces.length * 12 + this.panes.length * 2 + this.lamps.length * 12} tris,`
        + ' 3 calls)');
    }
  }

  /**
   * The shadow-caster proxy (see `casters`). One InstancedMesh whose layer mask
   * is SHADOW_LAYER and nothing else, which is the project's standing
   * convention for "drawn by the cascades, invisible to the game camera" — the
   * same one the skinned players' shadow proxies use (see SceneManager.
   * letShadowsSeeProxies).
   */
  private flushCasters(scene: THREE.Scene): void {
    if (this.retro || this.casters.length === 0) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // never shaded, never seen: the depth material is all that is ever drawn
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const inst = new THREE.InstancedMesh(geo, mat, this.casters.length);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let i = 0; i < this.casters.length; i++) inst.setMatrixAt(i, this.casters[i].m);
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = false;
    // a 130m roof is never usefully culled against a cascade that covers the
    // play area, and the bounding sphere of four stands is the whole bowl
    inst.frustumCulled = false;
    inst.layers.set(SHADOW_LAYER);
    inst.computeBoundingSphere();
    scene.add(inst);
    console.info(`stadium: ${this.casters.length} roof shadow casters (1 call/cascade)`);
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

  private buildBowl(scene: THREE.Scene, night: boolean,
    homeShirt: string, awayShirt: string): void {
    const concreteMat = new THREE.MeshPhongMaterial({ color: 0x2e3440 });
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x454e5e, shininess: 30 });
    const crowdMat = this.retro ? null : this.crowdMaterial(night);
    const home = new THREE.Color(homeShirt);
    // Club seat plastic, not club shirt: a stand full of shirt-saturated seats
    // reads as a paint chip. Half-way to slate is where it stops being a swatch
    // and starts being twenty thousand moulded chairs.
    const plastic = (hex: string): string =>
      `#${new THREE.Color(hex).lerp(new THREE.Color(0x39404e), 0.46).getHexString()}`;
    const homeSeat = plastic(homeShirt);
    const awaySeat = plastic(awayShirt);

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
    const facade = this.retro ? null : this.lab.standFacade();
    // §7A.5c: the front wall under the first row is a run of static sponsor
    // panels, not bare concrete — it is a 1.6m band across every tele frame
    const wallSign = this.retro || !pitchsideEnabled() ? null : perimeterWallTexture();
    const signMat = (len: number): THREE.Material => {
      if (!wallSign) return concreteMat;
      const map = wallSign.clone();
      map.needsUpdate = true;
      map.repeat.set(len / 16, 1);
      return new THREE.MeshPhongMaterial({ map, shininess: 8 });
    };
    stands.forEach((s, standIdx) => {
      const stand = new THREE.Group();
      const tiers = spec.tiers;
      const acc: CardAcc = { pos: [], rot: [], phase: [], col: [] };
      // the stand's own frame, for the structural instances (§7A.5b)
      const frame = new THREE.Matrix4().makeRotationY(s.rotY).setPosition(s.cx, 0, s.cz);
      // whose colours this end wears. alle 1 = home support, 0 = away.
      const seatHex = (s.alle0 + s.alle1) / 2 >= 0.5 ? homeSeat : awaySeat;
      const tierDepth: number[] = [];
      let depth = 0;
      tiers.forEach((t, tierIdx) => {
        const theta = Math.atan2(t.rise, t.run);
        const rakeLen = Math.hypot(t.rise, t.run);
        tierDepth.push(depth);
        if (crowdMat) {
          // The terrace itself: rows of seats, stepped, under the crowd. The
          // texture is one ROW tall, so repeat.y is literally the row count —
          // and for the tier with real people in it that count is the crowd's
          // own, which is what puts a seat under every figure instead of a
          // seat pattern behind them.
          const rows = this.crowd.live   // crowd v2 seats every tier
            ? this.crowdRows(s.detail, rakeLen)
            : Math.max(2, Math.floor(rakeLen / CARD_STEP_Y));
          const floor = new THREE.Mesh(
            this.terraceGeometry(s.len, rakeLen, tierIdx, tiers.length, night),
            this.terraceMaterial(seatHex, s.len, rows, standIdx * 0.137));
          floor.rotation.x = -Math.PI / 2 - theta;
          floor.position.set(0, t.y0 + t.rise / 2, depth + t.run / 2);
          stand.add(floor);
          if (this.crowd.live) {
            // crowd v2 (crowd.ts): every tier gets the baked-human impostors
            const block: CrowdBlock = {
              cx: s.cx, cz: s.cz, rotY: s.rotY, len: s.len,
              y0: t.y0, rise: t.rise, run: t.run, depth,
              detail: s.detail, gaps: tierIdx === 0 ? s.gaps : undefined, gapTop: s.gapTop,
              alle0: s.alle0, alle1: s.alle1, tier: tierIdx, tierCount: tiers.length,
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
            const w = new THREE.Mesh(new THREE.BoxGeometry(half, wallH, 0.6), signMat(half));
            w.position.set(sx * (TUNNEL_HALF_W + half / 2), wallH / 2, depth - 0.3);
            stand.add(w);
          }
        } else {
          const wall = new THREE.Mesh(new THREE.BoxGeometry(s.len, wallH, 0.6),
            tierIdx === 0 ? signMat(s.len) : concreteMat);
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
      // ...and its shadow (§7A.4b). The proxy runs from the roof lip all the
      // way back to the outside wall, so nothing leaks between the slab's back
      // edge and the facade at a low sun — the box is never seen, only its
      // silhouette, so it costs nothing to make it the whole lid.
      const lidD = 13 + (depth + 0.9 - (depth - 0.5));
      this.piece(frame, 0, spec.roofY, depth - 7 + (lidD - 13) / 2,
        s.len, 0.8, lidD, 0x000000, 1, this.casters);
      // Back wall — the only part of this building anyone sees from OUTSIDE,
      // which is the establishing shot's whole job. Precast panels and
      // stairwell glazing, tiled from the one facade bake.
      const backH = spec.roofY - 0.5;
      const back = new THREE.Mesh(new THREE.BoxGeometry(s.len, backH, 1),
        facade ? this.facadeMaterial(facade, s.len, backH) : concreteMat);
      back.position.set(0, backH / 2, depth + 0.4);
      stand.add(back);

      if (!this.retro && tiers.length >= 2 && pitchsideEnabled()) {
        // The LED ribbon on the balcony of the second tier (§7A.5c): a
        // parapet on top of that tier's front wall, carrying the strip.
        const top = tiers[1].y0 + 0.2;
        const ry = top + 0.4, rz = tierDepth[1] - 0.95;
        this.piece(frame, 0, ry, rz + 0.14, s.len, 0.8, 0.24, 0x1a1e26, 0.8);
        this.ribbonSpans.push({
          frame: frame.clone().multiply(new THREE.Matrix4().makeTranslation(0, ry, rz)),
          len: s.len, h: 0.72,
        });
      }
      if (!this.retro) {
        this.buildRoofStructure(frame, s.len, spec.roofY, depth, standIdx === 1);
        this.buildStandStructure(frame, s.len, spec.roofY, depth, tiers, tierDepth, s.gaps);
        if (this.size === 'mega' && tiers.length >= 3) {
          this.buildExecutiveBand(frame, s.len, tierDepth[2], night,
            tiers[1].y0 + tiers[1].rise);
        }
      }

      // a few team flags in the lower tier of the two long stands (§7A.5)
      if (crowdMat && standIdx < 2) {
        this.buildCrowdFlags(stand, s.len, spec.tiers[0], home, night);
      }

      stand.position.set(s.cx, 0, s.cz);
      stand.rotation.y = s.rotY;
      scene.add(stand);
    });
  }

  // ----------------------------------------------------------- the terrace

  /**
   * Rows of seats on THIS rake, matching crowd.seat()'s arithmetic exactly.
   * Duplicated on purpose and duplicated small: the alternative is the crowd
   * publishing its layout, and the layout is one line of arithmetic that the
   * detail knob already makes per-stand.
   */
  private crowdRows(detail: number, rakeLen: number): number {
    const det = CROWD_DETAIL[this.profile?.level ?? 'high'];
    if (det.stepUp <= 0) return Math.max(2, Math.floor(rakeLen / CARD_STEP_Y));
    const stepUp = det.stepUp / Math.max(0.5, Math.min(1, detail + 0.35));
    return Math.max(1, Math.floor(rakeLen / stepUp));
  }

  /**
   * The terrace plane, with the rake's depth gradient in its vertex colours.
   *
   * The seat texture carries the AO WITHIN a row (the riser in the shade of
   * the row above). This carries the AO ALONG the rake: the front row is in
   * daylight, the back rows are twenty metres under a roof, and the upper
   * tiers are further under it again. Eight segments is enough for a gradient
   * and costs fourteen triangles.
   */
  private terraceGeometry(len: number, rakeLen: number, tierIdx: number,
    tierCount: number, night: boolean): THREE.PlaneGeometry {
    const geo = new THREE.PlaneGeometry(len, rakeLen, 1, 8);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    // the plane's local +y points at the pitch once it is raked into place, so
    // v = 1 is the FRONT of the tier and v = 0 the back, under the roof
    const deep = 1 - (tierIdx / Math.max(1, tierCount - 1)) * 0.30;
    const base = (night ? 0.44 : 0.98) * deep;
    for (let i = 0; i < pos.count; i++) {
      const v = (pos.getY(i) + rakeLen / 2) / rakeLen;
      const k = base * (0.40 + 0.60 * v * v);
      col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k * 1.03;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }

  /**
   * One rake's seat material. Unlit, like the crowd cards and for the same
   * reason (§7A.4): the time of day is already baked into the vertex gradient
   * above, and a lit terrace at night is a terrace that has to be re-tuned
   * every time the key moves.
   */
  private terraceMaterial(seatHex: string, len: number, rows: number,
    phase: number): THREE.MeshBasicMaterial {
    const map = this.lab.terraceSeats(seatHex).clone();
    map.needsUpdate = true;
    map.repeat.set(len / TERRACE_TILE_M, rows);
    // shift the aisles stand to stand, so the four sides of the bowl are not
    // one stand shown four times
    map.offset.set(phase, 0);
    return new THREE.MeshBasicMaterial({ map, vertexColors: true, fog: true });
  }

  /** Back-wall concrete, tiled from the facade bake. */
  private facadeMaterial(tex: THREE.Texture, len: number, h: number): THREE.MeshPhongMaterial {
    const map = tex.clone();
    map.needsUpdate = true;
    map.repeat.set(len / FACADE_TILE_M, h / FACADE_TILE_M);
    return new THREE.MeshPhongMaterial({ map, color: 0xb6bdc9, shininess: 6 });
  }

  // --------------------------------------------------------- roof structure

  /**
   * What is under a stadium roof: a dark soffit, cross-trusses every few
   * metres, three purlins running the length, and — the piece that does more
   * work than the rest of them together — a bright fascia along the front
   * edge. A roof with a lit edge band reads as a roof from 150m; the same roof
   * without one reads as a slab of night sky.
   */
  private buildRoofStructure(frame: THREE.Matrix4, len: number, roofY: number,
    depth: number, gantry: boolean): void {
    const zMid = depth - 7;      // the roof slab's own centre
    const zFront = depth - 13.5; // its pitch-side edge
    // soffit: the ceiling the trusses hang off
    this.piece(frame, 0, roofY - 0.47, zMid, len, 0.12, 12.6, 0x3d4453, 0.34);
    // cross-trusses
    const nT = Math.max(2, Math.round(len / TRUSS_STEP));
    for (let i = 0; i < nT; i++) {
      const x = -len / 2 + (i + 0.5) * (len / nT);
      this.piece(frame, x, roofY - 0.98, zMid, 0.34, 0.78, 12.4, 0x6a7384, 0.46);
      // the diagonal that makes it a truss and not a joist
      this.piece(frame, x, roofY - 1.30, zMid, 0.2, 0.2, 12.4, 0x6a7384, 0.34);
    }
    // purlins running the length of the stand
    for (const dz of [-4.6, 0, 4.6]) {
      this.piece(frame, 0, roofY - 1.42, zMid + dz, len, 0.3, 0.3, 0x6a7384, 0.42);
    }
    // the fascia band and the shadow line under it
    this.piece(frame, 0, roofY - 0.1, zFront - 0.3, len, 1.3, 0.6, 0xa2abbb, 1.0);
    this.piece(frame, 0, roofY - 0.92, zFront - 0.22, len, 0.4, 0.44, 0x2b313d, 0.6);
    // a capping cornice along the back, so the outside has a top edge
    this.piece(frame, 0, roofY + 0.5, depth + 0.5, len, 0.55, 1.9, 0x79828f, 1.0);

    if (!gantry) return;
    // The broadcast gantry, slung under the roof of the stand the tele camera
    // looks AT — which is where a real one hangs and, not coincidentally,
    // the only place the tele camera can ever see it.
    const gy = roofY - 4.6, gz = zFront + 2.2;
    this.piece(frame, 0, gy, gz, 7.2, 0.26, 2.6, 0x7b8494, 0.78);
    this.piece(frame, 0, gy + 0.62, gz - 1.25, 7.2, 0.07, 0.07, 0xb9c1cd, 0.9);
    for (const sx of [-1, 1]) {
      this.piece(frame, sx * 3.3, gy + 2.3, gz, 0.16, 4.5, 0.16, 0x666f7e, 0.6);
      this.piece(frame, sx * 3.3, gy + 0.62, gz - 1.25, 0.07, 1.2, 0.07, 0xb9c1cd, 0.9);
    }
    // the camera itself: a dark box on a head, which is all anyone ever sees
    this.piece(frame, 1.1, gy + 0.55, gz - 1.5, 0.9, 0.5, 1.3, 0x12161d, 1.0);
  }

  // -------------------------------------------------------- stand structure

  /**
   * Columns, exterior pilasters, vomitory slots and the front rail — the four
   * things that stop a rake being a ramp with people on it.
   */
  private buildStandStructure(frame: THREE.Matrix4, len: number, roofY: number,
    depth: number, tiers: TierSpec[], tierDepth: number[],
    gaps?: [number, number][]): void {
    const blocked = (x: number): boolean =>
      !!gaps?.some(([a, b]) => x > a - 1 && x < b + 1);

    // roof columns, in the gap between the top rake and the back wall
    const nC = Math.max(2, Math.round(len / COLUMN_STEP));
    for (let i = 0; i < nC; i++) {
      const x = -len / 2 + (i + 0.5) * (len / nC);
      this.piece(frame, x, (roofY - 0.6) / 2 + 0.6, depth - 1.0,
        0.62, roofY - 1.2, 0.62, 0x5c6473, 0.5);
    }
    // exterior pilasters: the relief that turns the outside of the bowl from
    // a slab into a building
    const nP = Math.max(2, Math.round(len / PILASTER_STEP));
    for (let i = 0; i < nP; i++) {
      const x = -len / 2 + (i + 0.5) * (len / nP);
      this.piece(frame, x, (roofY - 0.9) / 2, depth + 1.1,
        1.05, roofY - 0.9, 0.75, 0x767f8f, 0.55);
    }
    // Vomitories: the dark slots the stand empties through, cut into the front
    // wall of the SECOND tier — where the aisles in the terrace below them run
    // out of terrace, and the one such wall any camera in the game can see.
    for (let ti = 1; ti < Math.min(2, tiers.length); ti++) {
      const t = tiers[ti];
      const below = tiers[ti - 1];
      const y0 = below.y0 + below.rise;        // the concourse floor behind
      const y1 = t.y0 + 0.2;                   // the top of this tier's wall
      if (y1 - y0 < 0.8) continue;
      const nV = Math.max(2, Math.round(len / VOM_STEP));
      for (let i = 0; i < nV; i++) {
        const x = -len / 2 + (i + 0.5) * (len / nV);
        if (blocked(x)) continue;
        this.piece(frame, x, (y0 + y1) / 2, tierDepth[ti] - 0.34,
          2.9, y1 - y0, 0.85, 0x05070b, 1.0);
        // the lit lintel over the mouth — a slot with a bright lip reads as a
        // hole in a wall; the same slot without one reads as a black sticker
        this.piece(frame, x, y1 + 0.12, tierDepth[ti] - 0.62,
          3.3, 0.24, 0.5, 0xaab2c0, 0.55);
      }
    }
    // The perimeter rail at the front of the near tier. Segmented so the
    // tunnel mouth stays a mouth.
    const railY = tiers[0].y0 + 0.75;
    const nR = Math.max(4, Math.round(len / RAIL_POST_STEP));
    for (let i = 0; i < nR; i++) {
      const x = -len / 2 + (i + 0.5) * (len / nR);
      if (blocked(x)) continue;
      this.piece(frame, x, railY - 0.28, -0.45, 0.075, 0.56, 0.075, 0xc8cfda, 0.95);
      // the rail itself, one short span per post: cheaper than a boolean and
      // it lets the tunnel gap fall out of the same test
      this.piece(frame, x, railY, -0.45, len / nR, 0.085, 0.085, 0xd6dce6, 1.0);
    }
  }

  // ------------------------------------------------------- executive boxes

  /**
   * MEGA only (§7.1's 80k bowl): the overhanging lip of the third tier and the
   * band of executive boxes tucked under it. At night the glazing is the one
   * warm line across the top of the bowl, which is what an 80,000-seat ground
   * looks like on television and what a 45,000-seat one does not.
   */
  private buildExecutiveBand(frame: THREE.Matrix4, len: number,
    depth: number, night: boolean, prevTop: number): void {
    // Where the band can physically go. The tier below fills everything up to
    // `prevTop`, and the tier above starts at `depth` — so the boxes have to
    // CANTILEVER forward, out over the back rows of the tier below, which is
    // exactly what they do in a real ground. Buried flush with the third
    // tier's front wall (the first attempt) they are behind twenty rows of
    // seats and nobody ever sees a single lit window.
    const y0 = prevTop + 0.25;
    const y1 = y0 + 2.5;
    const zC = depth - 1.7;    // 3.4m of overhang
    this.piece(frame, 0, (y0 + y1) / 2, zC, len, y1 - y0, 3.4, 0x141922, 1.0);
    // the third tier's leading edge, sitting on top of the band
    this.piece(frame, 0, y1 + 0.6, zC - 0.2, len, 1.2, 4.2, 0x8f98a7, 1.0);
    // and the shadow the overhang throws on the rows underneath it
    this.piece(frame, 0, y0 - 0.2, zC, len, 0.4, 3.4, 0x11151c, 0.7);

    const rng = this.lab.stream(0xb0c5e5);
    const step = 3.6;
    const n = Math.max(2, Math.round(len / step));
    // the panes face the pitch, i.e. local -z, and a PlaneGeometry faces +z
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const warm = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + (i + 0.5) * (len / n);
      if (night) {
        // not every box is sold: a band of identical lit windows is an office
        // block, and a band with a few dark ones is a stadium
        const on = rng.next() > 0.22;
        const k = on ? rng.range(0.95, 1.5) : rng.range(0.10, 0.18);
        // linear space: with the HDR chain these have to clear the 1.3 bloom
        // threshold to glow at all, and the hex path would sRGB-decode them
        if (this.hdrLamps) warm.setRGB(k * 1.5, k * 1.28, k * 0.92, THREE.LinearSRGBColorSpace);
        else warm.setRGB(k * 0.9, k * 0.82, k * 0.64, THREE.LinearSRGBColorSpace);
      } else {
        // daylight: glass is a dark mirror of the sky, with a little variance
        warm.setHex(0x2b3648).multiplyScalar(rng.range(0.8, 1.25));
      }
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, (y0 + y1) / 2, zC - 1.76), q,
        new THREE.Vector3(len / n - 0.7, 1.8, 1),
      );
      this.panes.push({ m: m.premultiply(frame), c: warm.clone() });
    }
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
    // +0.01: the pitch plane now runs to the stand line (§7A.5c) and would
    // z-fight the throat's floor for the last metre of the mouth
    throat.position.set(0, TUNNEL_H / 2 + 0.01, -TUNNEL_DEPTH / 2 - 0.05);
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
          y: 0.06,   // the FLOOR: the figure folds its lap to ~0.46 (pitchside.ts BenchSpot)
          z: z - 0.62,
          rotY: Math.PI + rng.range(-0.12, 0.12),
          alle: sx < 0 ? 1 : 0,
          shirt: (i === 0 ? coach : kit).clone().offsetHSL(0, 0, rng.range(-0.05, 0.03)),
        });
      }
    });
    // flushed with the rest of the pitch-side people in buildPitchside()
    this.benchSpots.push(...spots);
  }

  // ------------------------------------------------------------- pitchside

  /**
   * §7A.5c: everything between the boards and the stands — see pitchside.ts.
   * Boxes join the structure mesh, people join the bench mesh, and the ribbon
   * and the camera carpets are one draw call each. RETRO keeps the v1.1 bowl.
   */
  private buildPitchside(scene: THREE.Scene, lit: boolean): void {
    if (!this.retro && pitchsideEnabled()) {
      const id = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const sink: PitchsideSink = {
        box: (x, y, z, sx, sy, sz, hex, shade = 1, rotY = 0, tilt) => {
          this.piece(id, x, y, z, sx, sy, sz, hex, shade, this.pieces,
            tilt ? tilt.clone() : q.setFromAxisAngle(up, rotY).clone());
        },
        glow: (x, y, z, sx, sy, sz, c) => {
          const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
            new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
          this.lamps.push({ m, c: c.clone() });
        },
        people: this.benchSpots,
      };
      dressPitchside(sink, this.lab.stream(0x9175e), lit, this.hdrLamps);
      boardHousings(sink, this.boardSegments, 1.0);
      if (this.ribbonSpans.length) {
        this.ribbon = new LedRibbon(scene, this.ribbonSpans, lit, this.hdrLamps);
      }
      buildCarpets(scene);
    }
    this.crowd.seatBench(scene, this.benchSpots);
  }

  // ------------------------------------------------------------ floodlights

  /** `lit` is floodlightsLit(), NOT "is it night" — see the constructor. */
  private buildFloodlights(scene: THREE.Scene, lit: boolean): void {
    const night = lit;
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
    // §7A.4d: dimmer and less blue than it was — four of these at 62m washed
    // the whole night sky navy; the bowl's own air glow now lives in sky.ts
    if (haloMat) haloMat.color.setRGB(0.30, 0.33, 0.42, THREE.LinearSRGBColorSpace);
    // (v1 also hung a 96m anamorphic streak on every head. A broadcast zoom
    // is a spherical lens: it has no anamorphic flare, and four 15:1 smears
    // plus the old twelve-spoke star read as a cross-filter, not a camera.)
    for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const px = x * (HALF_L + 22);
      const pz = z * (HALF_W + 24);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, h, 8), poleMat);
      pole.position.set(px, h / 2, pz);
      scene.add(pole);

      // The head. v1.4 was one 7x4.5 white slab: at 150m that is a lamp, and
      // at 60m — which is where the establishing shot and every corner replay
      // put it — it is a glowing domino. A real head is a dark steel frame
      // carrying a GRID of lamps, and the gaps between the lamps are what give
      // the bloom its shape instead of a rectangle.
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), headMat);
      head.position.set(px * 0.965, h + 0.5, pz * 0.95);
      head.lookAt(0, 0, 0);
      head.visible = false;   // a locator, not a mesh: the lamps are instanced
      this.floodlightHeads.push(head);
      scene.add(head);
      if (!this.retro) this.buildFloodlightHead(head, px, pz, h, night);
      else {
        // RETRO keeps v1.1's single slab, and keeps it drawn
        head.geometry.dispose();
        head.geometry = new THREE.BoxGeometry(7, 4.5, 0.8);
        head.visible = true;
      }

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

  /**
   * One floodlight head, built in the head's own frame: a steel backing frame,
   * a cross-braced lattice behind it, the outrigger arms back to the mast, and
   * a 6x3 grid of lamp cells. The cells go in their own overbright instanced
   * mesh; everything else joins the bowl's structure mesh, so four heads cost
   * one extra draw call between them and the four slab meshes they replace
   * hand three back.
   */
  private buildFloodlightHead(head: THREE.Mesh, px: number, pz: number,
    h: number, lit: boolean): void {
    const night = lit;
    const frame = new THREE.Matrix4().compose(
      head.position, head.quaternion, new THREE.Vector3(1, 1, 1));
    // the frame: dark, and a little larger than the lamps it carries
    this.piece(frame, 0, 0, -0.35, 7.4, 4.9, 0.45, 0x2a3040, 0.85);
    // lattice bracing across the back of it
    for (const gx of [-2.4, 0, 2.4]) {
      this.piece(frame, gx, 0, -0.85, 0.22, 5.1, 0.7, 0x424b5c, 0.8);
    }
    for (const gy of [-1.9, 1.9]) {
      this.piece(frame, 0, gy, -0.85, 7.6, 0.22, 0.7, 0x424b5c, 0.8);
    }
    // the outriggers back to the mast head, and the mast's own top lattice
    for (const sx of [-1, 1]) {
      this.piece(frame, sx * 2.6, -2.2, -1.5, 0.2, 2.6, 2.2, 0x424b5c, 0.7);
    }
    const mast = new THREE.Matrix4().setPosition(px, 0, pz);
    for (let i = 0; i < 5; i++) {
      const y = h - 11 + i * 2.6;
      this.piece(mast, 0, y, 0, 3.0, 0.2, 0.2, 0x424b5c, 0.75);
      this.piece(mast, 0, y + 1.3, 0, 0.2, 0.2, 3.0, 0x424b5c, 0.75);
    }
    for (const sx of [-1, 1]) {
      this.piece(mast, sx * 1.4, h - 5.5, 0, 0.22, 11.5, 0.22, 0x4d566a, 0.8);
    }

    // The lamps. Overbright in LINEAR space so the §7A.6 bloom (threshold 1.3)
    // actually finds them; the outer cells are dimmed a little, which is what
    // stops a 6x3 grid reading as one rectangle again.
    const col = new THREE.Color();
    const rng = this.lab.stream(0x1a3b7 + Math.round(px + pz));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        const lx = (c - 2.5) * 1.12;
        const ly = (r - 1) * 1.45;
        const edge = 1 - (Math.abs(c - 2.5) / 2.5) * 0.18 - Math.abs(r - 1) * 0.07;
        const k = (night ? 4.6 : 1.3) * edge * rng.range(0.94, 1.06);
        if (this.hdrLamps) col.setRGB(k, k, k * (night ? 1.02 : 1.05), THREE.LinearSRGBColorSpace);
        else col.setRGB(1, 1, 1);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(lx, ly, 0.02),
          new THREE.Quaternion(),
          new THREE.Vector3(0.95, 1.25, 0.22),
        );
        this.lamps.push({ m: m.premultiply(frame), c: col.clone() });
      }
    }
  }

  // -------------------------------------------------------------- ad boards

  private buildAdBoards(scene: THREE.Scene, lit: boolean): void {
    const night = lit;
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
    this.boardSegments = segments;
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
    this.ribbon?.update(this.clock);
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
