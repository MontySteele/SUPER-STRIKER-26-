// SkinnedPlayerMesh: the authored character, driven by the sim.
//
// Same contract as PlayerMesh — update(dt, x, y, z, facing, speed, anim, animT)
// — so gameRenderer's call sites do not know which one it is holding.
//
// The state machine, top to bottom:
//
//   LOCOMOTION LAYER   a chain of looping clips ordered by the ground speed
//                      they were captured at (LOCO_CHAIN: idle → trudge → walk
//                      → jog → run). The sim's speed picks the bracketing pair
//                      and crossfades them; playback rate is speed ÷ that
//                      pair's blended natural speed. That ratio is what keeps
//                      the feet on the grass instead of skating — a walk cycle
//                      captured at 1.31 m/s and played at 1.31 m/s plants its
//                      foot exactly. Adding a sprint is one row in the table.
//
//   ACTION LAYER       one shot, driven by ActionAnim. Every action names the
//                      clip it wants and the procedural stand-in to use when
//                      that clip is not on disk:
//                        • CLIP  — its time set directly from the sim's animT,
//                          so the contact frame lands on the frame the ball
//                          actually left the foot (§8), crossfaded over the
//                          locomotion layer by weight.
//                        • POSE  — a procedural override on the root and a
//                          handful of joints. Only ever evaluated when the
//                          clip is missing, so a real slide or dive landing in
//                          the library switches it off by existing.
//
//   PROCEDURAL TRIM    breathing on the idle, the lean/roll/drop a stand-in
//                      asks for, and the strike clip's hip yaw at contact taken
//                      back out — mocap actors are rarely square to the ball,
//                      and without this a pass leaves the foot 25° off where
//                      the sim aimed it.
//
// Everything above is data: ACTIONS is a table, CLIP_TABLE is a table, and the
// loader FINDS each strike's contact frame rather than being told it.

import * as THREE from 'three';
import type { PlayerData } from '../data/types';
import type { ActionAnim } from '../sim/player';
import { findBone, LOCO_CHAIN, GK_CHAIN, GK_SIDESTEP, type CharacterInstance, type CharacterRig,
  type ClipId, type PreparedClip } from './characterAssets';
import type { KitSpec } from './playerMesh';

/**
 * §7A.2 detail bands, in metres from the camera, plus the hysteresis margin.
 *
 * MEASURED against the shot list, not guessed. The distances that matter are:
 * goalmouth_scramble's camera sits 19–25m off the bodies round the ball;
 * midfield_wide is a 24m-high broadcast pose whose NEAR shape is ~25m and whose
 * FAR shape is ~50m; the tele rig on tele_midfield puts the far side of the
 * pitch at 45–55m; setpiece_corner runs 20–60m across one frame.
 *
 * The old bands were [26, 52], chosen when the whole skinned path had to fit in
 * a frame budget nobody had measured on the real GPU. That put the entire far
 * team of every broadcast shot on lod1 — a 0.35 decimation, which is the level
 * where the collapse eats the hands, squares off the shoulders and turns the
 * head into a lump. It is visible at 40m on a Retina panel, and at 40m the far
 * team is half the players on screen.
 *
 * So the bands are pushed out to cover the whole broadcast working range with
 * the full mesh:
 *   lod0 ≤ 45m   everything a broadcast camera is actually looking at
 *   lod1 ≤ 90m   the far touchline of a wide, and the far half in an establisher
 *   lod2 > 90m   a shape, and the permanent shadow caster at every distance
 *
 * The cost was MEASURED, A against B, same build, only this line changed
 * (tools/capture.mjs, --players skinned --bake):
 *
 *   midfield_wide    [26,52]  623k tris  317 calls   tiers  0 / 11 / 11
 *                    [45,90]  791k tris  319 calls   tiers  2 / 20 /  0
 *   setpiece_corner  [26,52]  579k tris  326 calls   tiers  1 /  9 / 12
 *                    [45,90]  771k tris  331 calls   tiers  6 / 14 /  2
 *
 * — about +170k to +190k triangles a frame, and essentially no extra draw
 * calls, because a level change moves a player between meshes rather than
 * adding one. `npm run app:bench -- --pin window` then prices it on the real
 * GPU at 1470x799 @ DPR 2: 60 fps in all four situations, 1% low 56.5–57.7,
 * 2.1–3.5 ms of GPU work a frame against a 16.7 ms budget. The triangles were
 * never the constraint; the draw calls were, and the shadow-proxy merge in
 * characterAssets.ts paid for this change several times over.
 *
 * The margin stops a player jogging along a band edge from flickering between
 * two detail levels once a frame. It is wider than it was because the bands are
 * further out, and a player's distance changes faster in metres per second the
 * further away he is from a camera that is itself tracking play.
 */
export const LOD_BANDS_M = [45, 90];
const LOD_HYSTERESIS_M = 5;

/**
 * Beyond this the mixer ticks at half rate.
 *
 * Deliberately just past the lod0 band plus its hysteresis: a player drawn at
 * full detail is a player close enough for a 30Hz mixer to read as a stutter in
 * his hands, and the two tests drifting apart is what produced the artefact the
 * comment in updateLOD() describes.
 */
export const SKINNED_NEAR_M = 52;

/** Playback rate is clamped: a walk cycle at 3x is a cartoon, at 0.2x it is a
 *  freeze frame, and neither is better than a small amount of foot slide. */
const RATE_MIN = 0.55;
const RATE_MAX = 1.8;

/** How fast an action's weight comes up over the locomotion layer, and how
 *  long it takes to hand back. Fast in (a strike has to read as a strike),
 *  slower out (the follow-through should settle, not snap). */
/** Above this the keeper is running, not shuffling. */
const SIDESTEP_MAX_SPEED = 2.4;
/**
 * Below this a player is standing, not travelling.
 *
 * 5cm/s: an order of magnitude under the slowest thing the chain can rate-match
 * (a walk clip at RATE_MIN is ~0.7 m/s) and an order of magnitude over the
 * jitter a 60Hz position difference carries. Anything above it is ground
 * translation and something in the chain has to be MOVING, or the player skates.
 */
const LOCO_FLOOR = 0.05;

const ACTION_IN = 0.05;
const ACTION_OUT = 0.18;

/** A procedural override, all in the character's own frame. */
interface Pose {
  /** forward lean, radians (+ = face down) */
  lean?: number;
  /** roll about the facing axis, radians */
  roll?: number;
  /** vertical offset, metres (+ = off the ground) */
  lift?: number;
  /** both arms up, 0..1 */
  arms?: number;
  /** head pitch, radians (+ = chin down) */
  head?: number;
  /** pretend the player is moving this fast for the locomotion layer */
  loco?: number;
  /**
   * Lean from the SPINE up, radians (+ = back). Unlike `lean`, which tips the
   * whole root and takes the legs with it, this bends the torso over legs that
   * are still running — which is the only way to lay a body-contact pose over
   * a locomotion cycle without costing a step.
   */
  torso?: number;
  /** Shoulders turned about the up axis, radians (+ = toward his right). */
  twist?: number;
}

interface ActionDef {
  /** one-shot clip, or a list to pick from per player for variety */
  clip?: ClipId | ClipId[];
  /** seconds the sim keeps this anim alive (mirrors PlayerEntity.update) */
  dur: number;
  /**
   * The FALLBACK, used only when none of `clip` resolved at load. Every one of
   * these is a stand-in, and when the real clip is on disk it is never
   * evaluated — which is what makes "a real slide clip drops in by changing a
   * row" true rather than aspirational.
   */
  pose?: (u: number) => Pose;
}

/**
 * ActionAnim → what to play. The sim's durations (PlayerEntity.update) are
 * mirrored here: 0.42s for a strike, 0.8 for a slide, 1.0 for a dive, 3.0 for
 * the celebration and the trudge.
 *
 * Which of these is a real animation and which is the procedural stand-in
 * depends on what is on disk, so the answer is printed at load
 * (`characters: no clip for …`) rather than asserted in a comment here.
 */
const ACTIONS: Partial<Record<ActionAnim, ActionDef>> = {
  pass: { clip: 'kickC', dur: 0.42 },
  loft: { clip: 'kickA', dur: 0.42 },
  // two strikes, picked per player, so a team does not shoot in unison
  shoot: { clip: ['kickB', 'kickD'], dur: 0.42 },

  // a header trimmed so the jump's apex is the contact frame; the stand-in is
  // a procedural hop with the head thrown at the ball
  header: {
    clip: 'header',
    dur: 0.42,
    pose: (u) => ({ lift: Math.sin(u * Math.PI) * 0.34, lean: -0.25 + u * 0.55, arms: 0.35 }),
  },

  // stand-in: pitch the whole body back and sink it, which is the read that
  // matters at broadcast distance; the legs keep running, which is not right
  // but is closer than standing up
  slide: {
    clip: 'slide',
    dur: 0.8,
    pose: (u) => ({ lean: -1.15, lift: -0.52, loco: 4.2 * (1 - u * 0.6) }),
  },

  // stand-in: roll about the facing axis and lift, arms up — reads as a dive
  // from anywhere but a close-up
  diveL: {
    clip: 'diveL',
    dur: 1.0,
    pose: (u) => ({ roll: -(0.5 + u * 0.95), lift: Math.sin(u * Math.PI) * 0.45 - u * 0.35, arms: 0.9 }),
  },
  diveR: {
    clip: 'diveR',
    dur: 1.0,
    pose: (u) => ({ roll: 0.5 + u * 0.95, lift: Math.sin(u * Math.PI) * 0.45 - u * 0.35, arms: 0.9 }),
  },

  // §6.1 first touch. A real clip, trimmed so animT 0 is the touch; the
  // stand-in reaches a foot out by dipping and turning slightly into the ball.
  trap: {
    clip: 'trap',
    dur: 0.42,
    pose: (u) => ({ lean: 0.18 * (1 - u), torso: 0.1, loco: 1.4 * (1 - u * 0.7) }),
  },

  // §6.1 shielding. NO CLIP, deliberately — this one fires while the carrier is
  // running, the sim gives it no action lock, and any one-shot would take the
  // body off the locomotion layer and cost him the step the shield exists to
  // protect. So it is pose-only: the torso turns and leans back into the man
  // behind while the legs keep the ball moving. `dur` mirrors the sim's 0.5s
  // shield window (PlayerEntity.update); collision.ts re-arms it every tick the
  // defender is still on his back, and SHIELD_HOLD below bridges the frames
  // where he is not so the torso does not saw back and forth.
  shield: {
    dur: 0.5,
    pose: () => ({ torso: 0.22, twist: 0.42, arms: 0.16 }),
  },

  // stand-in: crouch over the ball
  collect: {
    clip: 'collect',
    dur: 0.42,
    pose: () => ({ lean: 0.62, lift: -0.3, arms: 0.25, head: 0.35 }),
  },

  // stand-in: walk with the arms up and a bounce. A kick clip's follow-through
  // is emphatically NOT a celebration — the actor turns and walks off.
  celebrate: {
    clip: 'celebrate',
    dur: 3.0,
    pose: (u) => ({ arms: 1, loco: 1.05, lift: Math.abs(Math.sin(u * 18)) * 0.16, lean: -0.1 }),
  },

  // stand-in: slow trudge, head down — the locomotion chain's `trudge` entry
  // does the work
  dejected: {
    clip: 'dejected',
    dur: 3.0,
    pose: () => ({ loco: 0.55, head: 0.5, lean: 0.14 }),
  },
};

const EMPTY: Pose = {};
/**
 * Seconds the shield posture outlives the sim's 'shield' anim. The sim re-arms
 * the anim every tick the defender is genuinely in the way and drops it the
 * tick he is not, and a presser leaning off and back on again would otherwise
 * have the carrier's torso snapping upright and back down with him.
 */
const SHIELD_HOLD = 0.3;

/**
 * What a scripted scene asks of an actor for one frame (SkinnedPlayerMesh.cutscene).
 *
 * `clip` is a CLIP_TABLE row id. It must not name a clip that is also in the
 * chain `chain` selects — three hands back ONE AnimationAction per clip, so an
 * overlay and a chain entry sharing a row would be the same action fighting
 * itself. In practice the presentation rows are overlays and the chain rows are
 * cycles, and the two sets are disjoint by design.
 */
export interface ActorPose {
  /** overlay clip id, or null to leave the body to the locomotion chain */
  clip?: string | null;
  /** crossfade seconds in and out (0.25–0.4 reads as a broadcast blend) */
  fade?: number;
  /** loop the overlay (default) or play it once and clamp */
  loop?: boolean;
  /** overlay playback rate */
  rate?: number;
  /** 0..1 start offset into the overlay's cycle, applied when it is entered */
  phase?: number;
  /** 0..1 how much of the body the overlay takes from the chain (default 1) */
  weight?: number;
  /** locomotion chain to move on (WALKOUT_CHAIN &c); null = the sim's own */
  chain?: ClipId[] | null;
}

/** One locomotion clip, ready to be weighted into a blend chain. */
interface LocoEntry {
  id: ClipId;
  action: THREE.AnimationAction;
  /** metres per second the clip was captured at; 0 for an idle */
  speed: number;
  dur: number;
  /** last weight written, so a chain change can switch the strays off */
  w: number;
}

/** Rotate a bone by `angle` about a WORLD-space axis, without ever assuming
 *  which local axis runs down the bone. Survives any rig that keeps the Mixamo
 *  names but not its axes. */
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _pq = new THREE.Quaternion();
function rotateBoneWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (Math.abs(angle) < 1e-4) return;
  _q.setFromAxisAngle(axis, angle);
  (bone.parent ?? bone).getWorldQuaternion(_pq);
  bone.quaternion.premultiply(_pq.clone().invert().multiply(_q).multiply(_pq));
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class SkinnedPlayerMesh {
  /** world position + facing; the same node gameRenderer toggles for a red card */
  root = new THREE.Group();
  /** action yaw correction and the procedural lean/roll/lift live here, so the
   *  facing on `root` stays exactly what the sim asked for */
  private pivot = new THREE.Group();
  private inst: CharacterInstance;
  private mixer: THREE.AnimationMixer;

  /** every locomotion clip this player has an action for, by id */
  private locoById = new Map<ClipId, LocoEntry>();
  /** the chain in play this frame, slowest first; index 0 is the idle */
  private loco: LocoEntry[] = [];
  /** the outfield chain and, for a keeper, his own — swapped by sim state */
  private chainOutfield: LocoEntry[] = [];
  private chainKeeper: LocoEntry[] = [];

  private act: THREE.AnimationAction | null = null;
  private actClip: PreparedClip | null = null;
  private actWeight = 0;
  private curAnim: ActionAnim = 'none';
  private curDef: ActionDef | null = null;

  // ---- cutscene layer (§7 presentation). Two slots, not one, so swapping a
  // scripted actor from `clap` to `cheer` is a CROSSFADE and not a cut: the
  // outgoing action keeps its own weight and rides down while the new one
  // comes up. The locomotion chain is weighted by (1 - the pair's total), so
  // an overlay at full weight hides the idle completely and one at 0.6 leaves
  // the man's stance showing through.
  private cue: THREE.AnimationAction | null = null;
  private cueId: string | null = null;
  private cueW = 0;
  private cueTarget = 0;
  private cueFade = 0.3;
  private cuePrev: THREE.AnimationAction | null = null;
  private cuePrevW = 0;
  /** chain a cutscene swapped in (WALKOUT_CHAIN &c); null = the sim's own */
  private chainOverride: LocoEntry[] | null = null;
  private chainKey: string | null = null;

  /** damped procedural state, so an overlay eases in instead of popping */
  private lean = 0;
  private roll = 0;
  private lift = 0;
  private arms = 0;
  private headPitch = 0;
  private torso = 0;
  private twist = 0;
  /** seconds of shield posture still owed after the sim's anim lapsed */
  private shieldHold = 0;
  /** the two hand bones, looked up once on first use (see handsMidpoint) */
  private hands: [THREE.Object3D, THREE.Object3D] | null | undefined;
  private actYaw = 0;
  private breathe: number;

  private starGlow: THREE.Mesh | null = null;
  /** true on frames a cutscene is driving this mesh — see finish() */
  private scripted = false;
  private tier = -1;
  /** near enough for a mixer tick every frame (SKINNED_NEAR_M) */
  private fullRate = true;
  private halfTick = 0;
  private readonly kickPick: number;
  /** keeper state from the sim (§6.3), and how sideways he is moving */
  private gkState: string | null = null;
  private gkLateral = 0;
  /**
   * The CLIP_TABLE row the keeper's one-shot layer should play instead of the
   * one ACTIONS names for the ActionAnim the sim set.
   *
   * The sim's ActionAnim vocabulary is small and shared by every player on the
   * pitch ('diveL', 'collect', 'loft'); a keeper's repertoire is not — a body
   * block, a jump catch, a low collect, a get-up, a throw and a punt are six
   * different animations that all arrive as one of those three names. Rather
   * than widen the union for one position, KeeperBrain / PenaltyController name
   * the ROW (§6.3) and it is substituted here, keeping the sim's timing — the
   * anim's duration and animT — exactly as it was.
   */
  private gkClip: ClipId | null = null;
  /** which clip id the action layer is currently holding, variant included */
  private actClipId: ClipId | null = null;

  get lodTier(): number { return Math.max(0, this.tier); }

  constructor(public data: PlayerData, kit: KitSpec, private rig: CharacterRig) {
    this.inst = rig.instance(data, kit);
    this.kickPick = hashStr(data.name) % 997;
    this.breathe = (hashStr(data.name + 'b') % 628) / 100;

    this.pivot.add(this.inst.root);
    this.pivot.position.y = this.inst.groundOffset;
    this.root.add(this.pivot);

    this.mixer = new THREE.AnimationMixer(this.inst.root);
    // Every locomotion clip gets an action up front; which of them form the
    // chain this frame is a runtime choice, so a keeper can stand like a
    // keeper without a second mixer or a second set of actions.
    const chain = (ids: ClipId[]): LocoEntry[] => ids
      .map((id) => this.entry(id))
      .filter((e): e is LocoEntry => e !== null)
      .sort((a, b) => a.speed - b.speed);
    this.chainOutfield = chain(LOCO_CHAIN);
    this.chainKeeper = chain(GK_CHAIN);
    this.entry(GK_SIDESTEP.left);
    this.entry(GK_SIDESTEP.right);
    this.entry('gkHold');
    this.loco = this.chainOutfield;

    // star player flair (§4): pulsing gold ring at the feet, same as the
    // capsule path so the two look like the same game
    if (data.star) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.72, 24),
        new THREE.MeshBasicMaterial({
          color: 0xffce4a, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      this.root.add(ring);
      this.starGlow = ring;
    }
  }

  /** One looping locomotion action, minted once and cached by clip id. */
  private entry(id: ClipId): LocoEntry | null {
    const hit = this.locoById.get(id);
    if (hit) return hit;
    const pc = this.rig.clip(id);
    if (!pc) return null;
    const e: LocoEntry = {
      id, action: this.loop(pc), speed: pc.groundSpeed, dur: pc.clip.duration, w: 0,
    };
    this.locoById.set(id, e);
    return e;
  }

  private loop(pc: PreparedClip): THREE.AnimationAction {
    const a = this.mixer.clipAction(pc.clip);
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.enabled = false;
    a.setEffectiveWeight(0);
    // start each player at a different phase or twenty-two men march in step
    a.time = (this.kickPick / 997) * pc.clip.duration;
    a.play();
    return a;
  }

  /**
   * §7A.2 detail selection. Three pre-built levels hang off ONE skeleton, so
   * this is nothing but a visibility flag — no rebuild, no re-bind, and never
   * a frame where the swapped-in mesh has not been posed yet.
   *
   * Shadows do not follow the visible level, and no longer share a mesh with
   * it: every player carries a dedicated proxy — one merged skinned mesh at
   * the lowest detail, permanently visible, permanently on SHADOW_LAYER, which
   * the cascade cameras draw and the game camera does not. So a close player
   * is drawn once at 28k triangles and casts off ~3k into three cascades, and
   * — unlike the arrangement this replaced — he casts at every distance
   * instead of only past the last band.
   *
   * Mixer rate also drops past SKINNED_NEAR_M.
   */
  updateLOD(camera: THREE.Camera): void {
    const p = this.root.position;
    const c = camera.position;
    const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
    // Mixer rate is its OWN distance test, not the detail level's. They used to
    // share one, and moving the detail bands in tuned the animation rate down
    // with them — a player at 27m suddenly animating at 30Hz, which is much
    // easier to see than the geometry he swapped to.
    this.fullRate = d <= SKINNED_NEAR_M;
    // hysteresis: a band edge is a different distance depending on which side
    // you are already on, so a player jogging along one cannot flicker
    let tier = LOD_BANDS_M.length;
    for (let i = 0; i < LOD_BANDS_M.length; i++) {
      const edge = LOD_BANDS_M[i] + (this.tier > i ? LOD_HYSTERESIS_M : 0);
      if (d <= edge) { tier = i; break; }
    }
    tier = Math.min(tier, this.inst.levels.length - 1);
    if (tier === this.tier) return;
    this.tier = tier;
    for (let i = 0; i < this.inst.levels.length; i++) {
      const on = i === tier;
      for (const m of this.inst.levels[i].meshes) {
        // the eyeballs are two hundred triangles nobody can resolve past the
        // near band, but a draw call every frame
        m.visible = on && (tier === 0 || !/low-poly|eye/i.test(m.name));
      }
    }
    // The shadow proxy is deliberately NOT touched here. It used to be: the
    // caster was the lowest level's own meshes, and this loop re-layered them
    // every time the tier changed — but the loop above had already set
    // `visible = false` on them, and three's shadow pass skips an invisible
    // object before it looks at a layer. Every player nearer than the last
    // band cast nothing at all. The proxy is now its own mesh, permanently
    // visible and permanently on SHADOW_LAYER (CharacterRig.instance), so the
    // detail level and the shadow have nothing to say to each other.
  }

  update(dt: number, x: number, y: number, z: number, facing: number, speed: number,
    anim: ActionAnim, animT: number): void {
    this.scripted = false;
    this.root.position.set(x, z, y);
    this.root.rotation.y = Math.PI / 2 - facing;

    // ---- action layer: pick up a new one-shot the moment the sim starts it.
    // A keeper's variant row (gkClip) counts as a new one-shot too: the sim
    // re-arms 'diveL' for the get-up that follows the dive, and the anim name
    // alone cannot tell those two apart.
    const wantClip = this.gkClip ?? this.defaultClipFor(anim);
    if (anim !== this.curAnim || wantClip !== this.actClipId) {
      this.curAnim = anim;
      this.curDef = anim === 'none' ? null : ACTIONS[anim] ?? null;
      this.startClip(this.curDef, wantClip);
    }

    const def = this.curDef;
    const u = def ? Math.min(animT / def.dur, 1) : 0;
    // the procedural pose is the STAND-IN: if the clip resolved, it is what
    // plays, and nothing bends the root on top of it
    let pose = def?.pose && !this.act ? def.pose(u) : EMPTY;
    // the shield posture is held past the anim so a defender bouncing on and
    // off the carrier's back reads as one sustained hold-off, not a twitch
    if (anim === 'shield') {
      this.shieldHold = SHIELD_HOLD;
    } else if (this.shieldHold > 0 && anim === 'none') {
      this.shieldHold = Math.max(this.shieldHold - dt, 0);
      const w = this.shieldHold / SHIELD_HOLD;
      const held = ACTIONS.shield?.pose?.(1) ?? EMPTY;
      pose = { torso: (held.torso ?? 0) * w, twist: (held.twist ?? 0) * w, arms: (held.arms ?? 0) * w };
    } else {
      this.shieldHold = 0;
    }

    // Weight the one-shot clip in fast and out slow. The two ends are
    // symmetric in seconds, not in fractions, so a 3s celebration and a 0.42s
    // strike hand back the same way.
    let wantW = 0;
    if (def?.clip && this.act) {
      const inW = Math.min(animT / ACTION_IN, 1);
      const outW = Math.min(Math.max(def.dur - animT, 0) / ACTION_OUT, 1);
      wantW = Math.min(inW, outW);
    }
    // taken straight, not damped: the in/out ramps above ARE the fade, and
    // stacking a time constant on top of them cost the strike most of its
    // weight over the twenty-five frames it is on screen — a kick that reads
    // as a man standing still is the whole bug this pipeline exists to avoid
    this.actWeight = wantW;
    if (this.act && this.actClip) {
      // The sim kicked the ball and called playAnim in the same tick, so
      // animT = 0 IS the contact frame. Driving .time straight off animT (the
      // action itself stays paused) is what guarantees they stay aligned no
      // matter what the frame rate or the replay rate is doing.
      const d = this.actClip.clip.duration;
      this.act.time = Math.min(this.actClip.contact + animT, Math.max(d - 1e-4, 0));
      this.act.setEffectiveWeight(this.actWeight);
    }

    // A cutscene that has just handed back still owes a fade: the overlay clip
    // it was holding rides out UNDER the sim's own animation rather than
    // vanishing on the frame control changed hands (releaseCutscene).
    this.fadeCue(dt);

    // ---- locomotion layer: find the pair of clips that brackets this speed,
    // crossfade between them, and play both at speed ÷ their blended natural
    // ground speed so the planted foot stays planted
    const locoSpeed = pose.loco ?? speed;
    const locoW = (1 - this.actWeight) * (1 - this.cueTotal());
    this.loco = this.pickChain(locoSpeed);
    if (this.loco.length) this.blendLoco(locoSpeed, locoW);

    this.finish(dt, pose);
  }

  /**
   * The bottom half of a frame, shared by the sim-driven path and the cutscene
   * path: tick the mixer (at half rate for a distant player), ease the
   * procedural trim toward whatever the pose asked for, and write the pivot.
   * Split out so an actor being driven by a script gets exactly the same
   * breathing, damping and bone overlay as one being driven by the match.
   */
  /**
   * World-space midpoint of the two hands as the mixer last posed them.
   */
  handsMidpoint(out: THREE.Vector3): boolean {
    if (this.hands === undefined) {
      const l = findBone(this.root, 'mixamorig:LeftHand');
      const r = findBone(this.root, 'mixamorig:RightHand');
      this.hands = l && r ? [l, r] : null;
    }
    if (!this.hands) return false;
    // walk each hand's ancestor chain so this is right even on a frame that
    // has not been drawn yet (the capture harness steps many ticks per draw)
    this.hands[0].updateWorldMatrix(true, false);
    this.hands[1].updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.hands[0].matrixWorld);
    _v.setFromMatrixPosition(this.hands[1].matrixWorld);
    out.add(_v).multiplyScalar(0.5);
    return true;
  }

  private finish(dt: number, pose: Pose): void {
    // ---- tick
    let ticked = true;
    if (this.fullRate) {
      this.mixer.update(dt);
    } else {
      this.halfTick += dt;
      ticked = this.halfTick >= 1 / 30;
      if (ticked) { this.mixer.update(this.halfTick); this.halfTick = 0; }
    }

    // ---- procedural trim, damped so nothing pops
    const k = 1 - Math.pow(6e-5, dt);
    this.lean += ((pose.lean ?? 0) - this.lean) * k;
    this.roll += ((pose.roll ?? 0) - this.roll) * k;
    this.lift += ((pose.lift ?? 0) - this.lift) * k;
    this.arms += ((pose.arms ?? 0) - this.arms) * k;
    this.headPitch += ((pose.head ?? 0) - this.headPitch) * k;
    this.torso += ((pose.torso ?? 0) - this.torso) * k;
    this.twist += ((pose.twist ?? 0) - this.twist) * k;
    // the mocap actor is turned this far off his run-up on the contact frame;
    // take it back out, weighted with the clip, so the strike points where the
    // sim aimed
    this.actYaw = this.actClip ? -this.actClip.yawAtContact * this.actWeight : 0;

    // A slow breath on top of the idle. The idle clip is sixteen seconds of an
    // actor standing about, sliced to eight, and the seam where it loops is
    // visible if you stare; a little independent motion hides it and stops
    // twenty-two men from looping in lockstep.
    this.breathe += dt * 1.6;
    const breath = (this.loco[0]?.w ?? 0) * Math.sin(this.breathe) * 0.014;

    this.pivot.rotation.set(this.lean + breath, this.actYaw, this.roll);
    this.pivot.position.y = this.inst.groundOffset + this.lift;

    // only on frames the mixer actually wrote the bones: these are relative
    // rotations, and applying one twice to the same pose doubles it
    const b = this.inst.bones;
    if (ticked) {
      if (this.arms > 0.01 && b.armL && b.armR) {
        // the character's own forward axis, in world space: rotating an arm
        // about it swings it up through the side, which is what an arms-aloft
        // celebration and a keeper's dive both want
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
        rotateBoneWorld(b.armL, fwd, this.arms * 1.9);
        rotateBoneWorld(b.armR, fwd, -this.arms * 1.9);
      }
      if (Math.abs(this.headPitch) > 0.01 && b.head) {
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
        rotateBoneWorld(b.head, side, this.headPitch);
      }
      // Torso and twist go on the spine, not the root: the legs underneath
      // keep their locomotion cycle and only the trunk bends. Split across
      // Spine and Spine1 when both exist so the bend reads as a curve rather
      // than a hinge at the belt. The character faces its local +Z, so its
      // right-hand side is -X and a turn "toward his right" is a negative
      // rotation about up.
      if ((Math.abs(this.torso) > 0.01 || Math.abs(this.twist) > 0.01) && b.spine) {
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
        const up = new THREE.Vector3(0, 1, 0);
        const bones = b.spine1 ? [b.spine, b.spine1] : [b.spine];
        const share = 1 / bones.length;
        for (const bone of bones) {
          rotateBoneWorld(bone, side, -this.torso * share);
          rotateBoneWorld(bone, up, -this.twist * share);
        }
      }
    }

    // The star ring is a GAMEPLAY AFFORDANCE — "this one is special" — in the
    // same family as the switch arrow and the control ring the renderer hides
    // while a scene is running. A gold halo pulsing under one man in a
    // line-up, or under the scorer at the corner flag, reads as a HUD element
    // that escaped onto the pitch, so it goes with them.
    if (this.starGlow) {
      this.starGlow.visible = !this.scripted;
      const m = this.starGlow.material as THREE.MeshBasicMaterial;
      m.opacity = 0.35 + Math.abs(Math.sin(performance.now() * 0.004)) * 0.3;
      this.starGlow.rotation.z += dt * 0.8;
    }
  }

  /**
   * Which blend chain this frame runs on.
   *
   * A goalkeeper is the one player whose idle is a decision rather than a
   * default, and the sim already made it: KeeperBrain (§6.3) sits in
   * 'position' when play is at the other end, goes to 'set'/'react' when a
   * threat is on, and 'hold' when the ball is in his hands. So:
   *
   *   position  → a standing goalkeeper idle (hands low, watching)
   *   set/react → the outfield crouch, which is a keeper's ready stance
   *   hold      → the idle that has a ball in its hands
   *   getup     → he is on the grass; the one-shot owns the body anyway
   *
   * and while he is shuffling slowly across his line rather than running, a
   * sidestep replaces the walk — picked by which way the sim is sliding him,
   * not by a guess about where the ball is.
   *
   * `locoSpeed` here is the distance the keeper's ROOT actually covered this
   * tick, not his velocity vector: a penalty shuffle and a dive both move him
   * over the grass without ever writing PlayerEntity.vel, and a chain chosen
   * off the velocity is what put a standing idle on top of three metres of
   * translation (gameRenderer.snapshot / feedKeeperState).
   */
  private pickChain(locoSpeed: number): LocoEntry[] {
    // a cutscene's chain outranks everything: on a walkout the keeper is a man
    // in a line, not a goalkeeper
    if (this.chainOverride) return this.chainOverride;
    if (!this.gkState) return this.chainOutfield;
    if (this.gkState === 'hold') {
      const hold = this.locoById.get('gkHold');
      if (hold) return [hold];
    }
    // 'set' and 'react' want the on-the-toes crouch: that is the outfield idle
    const base = this.gkState === 'set' || this.gkState === 'react' || this.gkState === 'smother'
      ? this.chainOutfield : this.chainKeeper;
    if (!base.length) return this.chainOutfield;
    // Any sideways drift that is not a run gets a sidestep. The gate used to
    // be |lateral| > 0.6, which a keeper easing along his line never reached —
    // so the slow, mostly-sideways movement, the one case the sidesteps exist
    // for, was exactly the case that fell through to a static idle.
    if (locoSpeed > LOCO_FLOOR && locoSpeed < SIDESTEP_MAX_SPEED
        && Math.abs(this.gkLateral) > 0.45) {
      const step = this.locoById.get(
        this.gkLateral < 0 ? GK_SIDESTEP.left : GK_SIDESTEP.right);
      if (step) return [base[0], step].sort((a, b) => a.speed - b.speed);
    }
    return base;
  }

  /**
   * The sim's keeper state (§6.3), how sideways he is moving (-1 fully to his
   * left, +1 fully to his right), and the CLIP_TABLE row his one-shot layer
   * should play. Set from the renderer, which is the only place that can see
   * both the KeeperBrain and the mesh. Null state = outfielder.
   */
  setKeeperState(state: string | null, lateral: number, clip: string | null = null): void {
    this.gkState = state;
    this.gkLateral = lateral;
    this.gkClip = (clip as ClipId | null) ?? null;
  }

  /**
   * Weight and rate the locomotion chain for this frame. Split out because it
   * is the one piece of the state machine worth reading on its own.
   */
  private blendLoco(locoSpeed: number, locoW: number): void {
    const n = this.loco.length;
    // A chain of ONE is a real case, not a degenerate one: 'hold' is a single
    // clip (the keeper standing with the ball in his gloves). This used to be
    // gated out at the call site, which meant nothing wrote gkHold's weight —
    // and, worse, nothing switched the PREVIOUS chain's clips off, so a keeper
    // who had just collected went on playing whatever he had been walking on.
    let hi = Math.min(1, n - 1);
    while (hi < n - 1 && this.loco[hi].speed < locoSpeed) hi++;
    const lo = Math.max(0, hi - 1);
    const loA = this.loco[lo], loB = this.loco[hi];
    const t = n < 2 ? 0 : THREE.MathUtils.clamp(
      (locoSpeed - loA.speed) / Math.max(loB.speed - loA.speed, 1e-3), 0, 1);
    // the idle contributes no speed, so a blend against it must take its rate
    // from the moving clip alone or the rate explodes as the player stops
    const natural = loA.speed > 1e-3 ? loA.speed + (loB.speed - loA.speed) * t : loB.speed;
    const rate = THREE.MathUtils.clamp(locoSpeed / Math.max(natural, 1e-3), RATE_MIN, RATE_MAX);
    // anything outside the chain in play (the other idle, the sidesteps) has
    // to be switched off or it keeps contributing its pose at full weight
    for (const e of this.locoById.values()) {
      if (this.loco.includes(e)) continue;
      if (e.w >= 1e-3) { e.action.enabled = false; e.action.setEffectiveWeight(0); e.w = 0; }
    }
    for (let i = 0; i < n; i++) {
      const e = this.loco[i];
      const w = (i === lo ? 1 - t : i === hi ? t : 0) * locoW;
      // A zero-weight action still costs a full pass over its 156 tracks in
      // three, and there are twenty-two of these. enabled=false is the one
      // switch that actually skips that work.
      if (w < 1e-3) {
        if (e.w >= 1e-3) { e.action.enabled = false; e.action.setEffectiveWeight(0); }
        e.w = 0;
        continue;
      }
      if (e.w < 1e-3) {
        // coming in from nothing: pick up the outgoing clip's phase rather
        // than whatever the loop happened to be at, so a walk→jog blend does
        // not briefly grow a third leg
        const from = this.loco.find((x) => x !== e && x.w > 0.1);
        if (from) e.action.time = ((from.action.time % from.dur) / from.dur) * e.dur;
        e.action.enabled = true;
      }
      e.w = w;
      e.action.setEffectiveWeight(w);
      e.action.setEffectiveTimeScale(i === 0 ? 1 : rate);
    }

    // Two MOVING clips in the blend (walk+jog, jog+run...) have to take their
    // steps together. Their cycles are different lengths — a 1.37s walk
    // against a 0.83s jog — so playing both at one rate lets them drift a
    // half-step apart within a second, and a 66/34 average of a walk's
    // straight leg and a jog's bent one at unrelated points of the gait is a
    // crouched shuffle with the feet skating (the walkout, which spends the
    // whole walk mid-blend, showed it worst). So both advance through their
    // cycles at ONE rate, the one that makes the blended stride cover the
    // real ground speed, and the lighter clip is pinned to the heavier one's
    // phase so nothing can drift. The idle has no stride and keeps its own
    // clock; an idle-plus-one-mover blend comes out exactly as before.
    if (lo !== hi && loA.speed > 1e-3 && loA.w >= 1e-3 && loB.w >= 1e-3) {
      const wSum = loA.w + loB.w;
      const stride = (loA.w * loA.speed * loA.dur + loB.w * loB.speed * loB.dur) / wSum;
      const cycles = locoSpeed / Math.max(stride, 1e-3);
      for (const e of [loA, loB]) {
        e.action.setEffectiveTimeScale(THREE.MathUtils.clamp(cycles * e.dur, RATE_MIN, RATE_MAX));
      }
      const [lead, follow] = loA.w >= loB.w ? [loA, loB] : [loB, loA];
      follow.action.time = ((lead.action.time % lead.dur) / lead.dur) * follow.dur;
    }
  }

  // ------------------------------------------------------ cutscene actor API
  //
  // What a scripted scene (src/present) is allowed to do to a player, and
  // nothing more: put him somewhere, point him somewhere, tell him how fast he
  // is travelling, and lay a clip over the top. Position and facing are taken
  // RAW — the script owns the easing, because a walk-to that damps its own
  // heading and a camera keyframe that eases in time are the same kind of
  // decision and belong in one place.
  //
  // Movement still goes through the ordinary blend chain, so `speed` has to be
  // the real metres-per-second the actor covers this frame. That is the whole
  // contract: hand it the truth and the feet plant themselves.

  /**
   * Drive this mesh from a script for one frame.
   *
   * `pose.clip` names a row in CLIP_TABLE (a ClipId; an unknown name is
   * ignored rather than throwing, so a scene outlives a table edit). Passing
   * null lets the locomotion chain have the body back.
   */
  cutscene(dt: number, x: number, y: number, facing: number, speed: number,
    pose: ActorPose = {}): void {
    this.scripted = true;
    this.root.position.set(x, 0, y);
    this.root.rotation.y = Math.PI / 2 - facing;

    // the sim's one-shot layer is not in charge here; drop whatever it held
    if (this.act) {
      this.act.setEffectiveWeight(0);
      this.act.stop();
      this.act = null;
      this.actClip = null;
    }
    this.curAnim = 'none';
    this.curDef = null;
    this.actClipId = null;
    this.actWeight = 0;

    this.setLocoChain(pose.chain ?? null);
    this.setCue(pose.clip ?? null, pose.loop ?? true, pose.phase ?? 0);
    this.cueFade = Math.max(pose.fade ?? 0.3, 1e-3);
    this.cueTarget = this.cue ? THREE.MathUtils.clamp(pose.weight ?? 1, 0, 1) : 0;
    this.fadeCue(dt);
    if (this.cue) this.cue.setEffectiveTimeScale(pose.rate ?? 1);

    this.loco = this.pickChain(speed);
    if (this.loco.length) this.blendLoco(speed, 1 - this.cueTotal());

    this.finish(dt, EMPTY);
  }

  /**
   * Hand the mesh back to the sim. The overlay clip is NOT cut — it is left
   * fading over `fade` seconds while update() drives the body again, which is
   * what stops a released actor from snapping into a locomotion pose on the
   * frame the scene ended.
   */
  releaseCutscene(fade = 0.35): void {
    this.cueTarget = 0;
    this.cueFade = Math.max(fade, 1e-3);
    this.cueId = null;
    this.setLocoChain(null);
  }

  /** How much of the body the cutscene layer owns right now, 0..1. */
  private cueTotal(): number {
    return THREE.MathUtils.clamp(this.cueW + this.cuePrevW, 0, 1);
  }

  /**
   * Swap the locomotion chain for a cutscene (WALKOUT_CHAIN &c). Entries are
   * minted lazily and cached, so the second walkout costs nothing, and the
   * chain is re-sorted by MEASURED speed exactly like the sim's own — a strut
   * that turns out to be slower than the walk cannot break the bracketing.
   */
  setLocoChain(ids: ClipId[] | null): void {
    const key = ids ? ids.join(',') : null;
    if (key === this.chainKey) return;
    this.chainKey = key;
    if (!ids) { this.chainOverride = null; return; }
    const chain = ids
      .map((id) => this.entry(id))
      .filter((e): e is LocoEntry => e !== null)
      .sort((a, b) => a.speed - b.speed);
    // a chain of one cannot be blended against anything — keep the sim's
    this.chainOverride = chain.length >= 2 ? chain : null;
  }

  /** Bring the cutscene overlay's weights to where they are heading. Linear
   *  over `cueFade` seconds, because a crossfade you can time is worth more
   *  than one that is asymptotically almost finished. */
  private fadeCue(dt: number): void {
    const step = dt / this.cueFade;
    if (this.cueW < this.cueTarget) this.cueW = Math.min(this.cueTarget, this.cueW + step);
    else if (this.cueW > this.cueTarget) this.cueW = Math.max(this.cueTarget, this.cueW - step);
    if (this.cuePrev) {
      this.cuePrevW = Math.max(0, this.cuePrevW - step);
      if (this.cuePrevW <= 1e-3) {
        this.cuePrev.setEffectiveWeight(0);
        this.cuePrev.stop();
        this.cuePrev = null;
        this.cuePrevW = 0;
      } else {
        this.cuePrev.setEffectiveWeight(this.cuePrevW);
      }
    }
    if (this.cue) {
      if (this.cueW <= 1e-3 && this.cueTarget <= 0) {
        this.cue.setEffectiveWeight(0);
        this.cue.stop();
        this.cue = null;
        this.cueId = null;
        this.cueW = 0;
      } else {
        this.cue.enabled = true;
        this.cue.setEffectiveWeight(this.cueW);
      }
    }
  }

  /**
   * Point the overlay slot at a clip. A change pushes the outgoing action into
   * the second slot at its current weight so the two genuinely cross, and
   * `phase` starts the new one part-way through its cycle — which is how
   * eleven men clapping stop looking like one man copied eleven times.
   */
  private setCue(id: string | null, loop: boolean, phase: number): void {
    if (id === this.cueId) return;
    if (this.cue) {
      // only one outgoing slot: a third clip inside one fade drops the oldest
      this.cuePrev?.stop();
      this.cuePrev = this.cue;
      this.cuePrevW = this.cueW;
    }
    this.cue = null;
    this.cueW = 0;
    this.cueId = id;
    if (!id) return;
    const pc = this.rig.clip(id as ClipId);
    if (!pc) { this.cueId = null; return; }
    const a = this.mixer.clipAction(pc.clip);
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    a.paused = false;
    a.time = (phase % 1) * pc.clip.duration;
    a.setEffectiveWeight(0);
    a.play();
    this.cue = a;
  }

  /** Which CLIP_TABLE row an ActionAnim plays when nothing overrides it. */
  private defaultClipFor(anim: ActionAnim): ClipId | null {
    const def = anim === 'none' ? null : ACTIONS[anim];
    if (!def?.clip) return null;
    return Array.isArray(def.clip)
      ? def.clip[this.kickPick % def.clip.length] : def.clip;
  }

  /** Swap the one-shot clip the action layer is holding. `override` is the
   *  keeper's variant row (see gkClip); null falls back to the ACTIONS row. */
  private startClip(def: ActionDef | null, override: ClipId | null = null): void {
    if (this.act) {
      this.act.setEffectiveWeight(0);
      this.act.stop();
      this.act = null;
      this.actClip = null;
    }
    // remember what was ASKED for, not what resolved, so a variant row that is
    // not on disk does not re-enter this every frame
    this.actClipId = override ?? this.defaultClipFor(this.curAnim);
    if (!def?.clip) return;
    const fallback = Array.isArray(def.clip)
      ? def.clip[this.kickPick % def.clip.length] : def.clip;
    // a variant row that is not on disk falls back to the ACTIONS row rather
    // than to nothing: a dive with no clip is a man standing in the goalmouth
    const pc = (override ? this.rig.clip(override) : null) ?? this.rig.clip(fallback);
    if (!pc) return;
    const a = this.mixer.clipAction(pc.clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.enabled = true;
    a.paused = true;           // the sim's animT drives .time, not the mixer
    a.time = pc.contact;
    a.setEffectiveWeight(0);
    a.play();
    this.act = a;
    this.actClip = pc;
    this.actWeight = 0;
  }

  /**
   * Detach and drop the per-player bits. Deliberately does NOT dispose
   * geometry, textures or the archetype materials: those are page-level and
   * shared by every player in every match. Removing the root from the scene
   * first is what keeps SceneManager.dispose()'s traversal — which frees
   * whatever it can reach — from eating them.
   */
  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.inst.root);
    this.root.removeFromParent();
    if (this.starGlow) {
      this.starGlow.geometry.dispose();
      (this.starGlow.material as THREE.Material).dispose();
    }
  }
}

/** Which ActionAnims are running on a real clip right now and which on the
 *  procedural stand-in. Reported at match build so "what is still fake" is a
 *  line in the console rather than a thing you have to read the table for. */
export function actionClipReport(rig: CharacterRig): { real: string[]; stand: string[] } {
  const real: string[] = [];
  const stand: string[] = [];
  for (const [anim, def] of Object.entries(ACTIONS) as [ActionAnim, ActionDef][]) {
    const ids = def.clip ? (Array.isArray(def.clip) ? def.clip : [def.clip]) : [];
    (ids.length && ids.every((id) => rig.clip(id)) ? real : stand).push(anim);
  }
  return { real, stand };
}
