// Renderer orchestrator: syncs meshes from sim snapshots (interpolated),
// records a replay ring buffer, runs the live camera package (tele cam / set
// pieces / cards) and the goal presentation (slow-mo of the line → tracking
// celebration → crowd cutaway → three moving replay angles), confetti,
// switch indicator.

import * as THREE from 'three';
import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import type { PlayerEntity, ActionAnim } from '../sim/player';
import { SceneManager, type TimeOfDay } from './scene';
import { buildPitch } from './pitch';
import { Divots } from './divots';
import { Stadium, type StadiumSize } from './stadium';
import { PlayerMesh, PlayerRig, resolveKits } from './playerMesh';
import { CharacterRig, charactersReady } from './characterAssets';
import { SkinnedPlayerMesh, actionClipReport } from './skinnedPlayer';
import { TextureLab } from './TextureLab';
import { BallMesh } from './ballMesh';
import { CameraDirector, type CamMode, type ModeOptions } from './camera';
import { Rain } from './rain';
import { effectiveTimeOfDay, weatherProfile } from './weather';
import { HALF_L, SIM_DT } from '../sim/constants';

/**
 * Ground speed above which a position change is a TELEPORT, not locomotion.
 *
 * A sprint tops out around 10 m/s and a keeper's dive is capped at 11; a
 * penalty being set up moves twenty-two men across the pitch in one tick.
 * Anything past this is the sim cutting, and asking a run cycle to cover it
 * would give the whole squad one frame at RATE_MAX.
 */
const TELEPORT_SPEED = 14;

interface Snap {
  x: number; y: number; facing: number; speed: number;
}

/**
 * The two player pipelines share exactly this much. PlayerMesh (procedural
 * capsules, §7.1) and SkinnedPlayerMesh (authored glTF characters) both
 * implement it, which is why every call site below is blind to which is live.
 */
export interface PlayerView {
  root: THREE.Group;
  readonly lodTier: number;
  updateLOD(camera: THREE.Camera): void;
  /** §6.3 keeper state, for a pipeline that can use it. Outfielders get null;
   *  the capsule path does not implement this at all. */
  setKeeperState?(state: string | null, lateral: number, clip?: string | null): void;
  /** World-space midpoint of the two hands, for drawing a HELD ball in the
   *  gloves rather than at the sim's fixed chest offset. False when the
   *  pipeline has no hands to speak of (capsules). */
  handsMidpoint?(out: THREE.Vector3): boolean;
  update(dt: number, x: number, y: number, z: number, facing: number, speed: number,
    anim: ActionAnim, animT: number): void;
  dispose(): void;
}

/**
 * Which player pipeline to build. Flip this to true to make the authored
 * characters the default; `?players=skinned` / `?players=capsule` overrides it
 * either way, and the skinned path silently falls back to capsules if the
 * assets have not finished loading (see preloadCharacters).
 */
export const SKINNED_PLAYERS_DEFAULT = true;

export function skinnedPlayersWanted(): boolean {
  const p = new URLSearchParams(location.search).get('players');
  if (p === 'skinned') return true;
  if (p === 'capsule' || p === 'capsules') return false;
  return SKINNED_PLAYERS_DEFAULT;
}

/** Switch-indicator colors by seat slot: P1, P2, P3, P4 (§5.4.6). */
export const SEAT_COLORS = [0xffce4a, 0xdde4f0, 0xff8c2e, 0x5ec8ff];

const REPLAY_SECONDS = 6;
const REPLAY_FPS = 30;

interface ReplayFrame {
  ball: [number, number, number];
  players: Snap[];
  anims: [ActionAnim, number][];
}

/** One camera angle over some slice of the frozen clip. */
interface ReplayPass {
  mode: CamMode;
  rate: number;   // playback speed (1 = real time)
  from: number;   // start point as a fraction of the clip
  /** end point as a fraction of the clip (default 1 = play it out) */
  to?: number;
  /** corner bug text; defaults to REPLAY / REPLAY · ANGLE n */
  label?: string;
}

/**
 * The goal recap, three MOVING rigs over the frozen clip (§7.2). Durations
 * below are for the full 4s clip: 2.0s + 2.0s + 1.9s ≈ 5.9s, which is what
 * the goalseq timeline budgets for it.
 */
const GOAL_REPLAY_PASSES: ReplayPass[] = [
  { mode: 'goalCrane', rate: 1.00, from: 0.18, to: 0.68 }, // high crane, drifting
  { mode: 'goalDolly', rate: 0.85, from: 0.52, to: 0.95 }, // low sideline dolly
  { mode: 'ballCam', rate: 0.55, from: 0.74, to: 1.00 },   // chase the ball in
];

/** On-demand replay of the last few seconds of open play. */
const LIVE_PASSES: ReplayPass[] = [
  { mode: 'cine', rate: 0.75, from: 0, to: 0.55 },
  { mode: 'ballCam', rate: 0.55, from: 0.50, to: 1.0 },
];

// ----------------------------------------------------------- goal timeline
// Seconds from the goal event. The sim gives us a 12.5s goalseq window
// (updateGoalSeq) and any button skips, so everything has to land inside it
// with a beat to spare.
const GOAL_SLOWMO_END = 2.30;  // ball crossing the line, ~0.85s of clip at 0.38x
const GOAL_CELEB_END = 5.00;   // tracking celebration cam with a push-in
const GOAL_CROWD_END = 6.20;   // 1.2s crowd cutaway
// 6.20 → ~12.1: the three moving replay angles, then hold on the celebration.

/** Where the goal presentation is up to. Public so the cutscene layer can
 *  tell when the camera is its to drive (only during 'celebration'). */
export type GoalStage = 'slowmo' | 'celebration' | 'crowd' | 'replay' | 'hold';

const clampUnit = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class GameRenderer {
  sceneMgr: SceneManager;
  stadium: Stadium;
  lab: TextureLab;
  /** exactly one of these two is built; the other stays null */
  rig: PlayerRig | null = null;
  charRig: CharacterRig | null = null;
  cam: CameraDirector;
  playerMeshes: PlayerView[] = [];
  /**
   * §7 presentation hook. Set by the cutscene layer (src/present), which owns
   * everything behind it. Called once a frame with the render dt and whether a
   * replay is rewinding time; returning true means "I have posed the player
   * meshes and, if I brought a camera track, taken the rig" and this file
   * leaves both alone for that frame. Deliberately a bare function so the
   * renderer never learns what a cutscene is.
   */
  cutscene: ((dt: number, replaying: boolean) => boolean) | null = null;
  ballMesh: BallMesh;
  switchArrows: THREE.Mesh[];
  controlRings: THREE.Mesh[];
  private ringPulse = [0, 0, 0, 0];

  // interpolation snapshots
  private prevSnaps: Snap[] = [];
  private currSnaps: Snap[] = [];
  private prevBall: [number, number, number] = [0, 0, 0];
  private currBall: [number, number, number] = [0, 0, 0];

  // replay
  private replayBuf: ReplayFrame[] = [];
  private replayAccum = 0;
  private goalSeqT = -1; // >= 0 while running the goal presentation
  private goalStage: GoalStage | null = null;
  private passes: ReplayPass[] = [];
  private passIdx = 0;
  private passFrames: ReplayFrame[] = [];
  private replayIdx = 0;
  private passFrom = 0;
  private passTo = 1;
  private manualReplay = false; // user-triggered; main freezes the sim for us
  private lastGoalClip: { frames: ReplayFrame[]; side: number } | null = null;
  onReplayStateChange: ((on: boolean, label?: string) => void) | null = null;
  /** Fires whenever the director hard-cuts, with a kind ('corner', 'replay',
   *  'beauty', …). The broadcast package hangs its 0.6s wipe off this. */
  get onCut(): ((kind: string) => void) | null { return this.cam.onCut; }
  set onCut(fn: ((kind: string) => void) | null) { this.cam.onCut = fn; }
  /** Fires on every goal-presentation stage change. */
  onGoalStage: ((stage: GoalStage) => void) | null = null;

  /**
   * What the director WANTS to be in, as opposed to what mode the camera is
   * actually in. The two differ whenever something outside (a cutscene) has
   * taken the camera with setMode('external'); by only acting when our own
   * intent changes we hand it back at the next real beat instead of fighting
   * for the camera every frame.
   */
  private camIntent: CamMode | null = null;
  private restartKey = '';
  /** seconds of pre-match beauty crane still owed before the live package starts */
  private beautyHold = 0;

  private confetti: THREE.Points | null = null;
  private confettiVel: Float32Array | null = null;
  private confettiT = 0;
  /** clash-resolved outfield shirt colors, [home, away] */
  private shirts: [string, string] = ['#ffffff', '#ffffff'];
  // comet trail behind the ball during replays (additive, fades to the tail)
  private trail: THREE.Points | null = null;
  private trailPts: [number, number, number][] = [];
  /** capture harness (§7A.9): when set, update() drives state but skips the draw */
  private skipDraw = false;
  /** §7A.3c: the marks slide tackles leave on the turf. Null at RETRO, which
   *  is the v1.1 pitch and did not have them. */
  private divots: Divots | null = null;
  private handsTmp = new THREE.Vector3();
  private lensTmp = new THREE.Vector3();
  /** §7A.4c: only ever non-null when the weather is wet */
  private rain: Rain | null = null;

  constructor(canvas: HTMLCanvasElement, private match: Match, timeOfDayIn: TimeOfDay,
    stadiumSize: StadiumSize = 'national') {
    this.sceneMgr = new SceneManager(canvas, timeOfDayIn);
    // §7A.4c. SceneManager resolves this for itself; everything DOWNSTREAM of
    // it — the crowd bake, the seat shading, the capsule impostor tints — has
    // to agree, or a floodlit match gets a daylight crowd in it.
    const timeOfDay = this.sceneMgr.profile.retro
      ? timeOfDayIn : effectiveTimeOfDay(timeOfDayIn);

    // §7A.3: one lab per match, seeded, disposed with the match. Everything
    // textured below draws its maps from it, so the whole scene is a pure
    // function of LAB_SEED and nothing bakes twice.
    this.lab = new TextureLab();
    const [homeKit, awayKit, gkA, gkB] = resolveKits(match.teams[0].data.kit, match.teams[1].data.kit);
    this.shirts = [homeKit.shirt, awayKit.shirt];

    buildPitch(this.sceneMgr.scene, this.lab, this.sceneMgr.profile);
    // §7A.3c: the divot store has to exist before atmos.register() below — its
    // material is Lambert, and a lit material that misses registration takes
    // the non-CSM branch (and never gets its per-instance fade patch applied).
    // RETRO is excluded for the same reason it has no shell turf.
    if (!this.sceneMgr.profile.retro && this.sceneMgr.profile.divots > 0) {
      this.divots = new Divots(this.sceneMgr.scene, this.lab, this.sceneMgr.profile);
    }
    this.stadium = new Stadium(this.sceneMgr.scene, this.lab, timeOfDay, stadiumSize,
      !this.sceneMgr.profile.retro, this.sceneMgr.profile, homeKit.shirt, awayKit.shirt);
    this.cam = new CameraDirector(this.sceneMgr.camera);
    // the beauty crane has to clear the bowl it is orbiting, and a Mega Bowl
    // is 50m deeper than a municipal one
    const bowl = { municipal: [96, 40], national: [122, 58], mega: [150, 84] }[stadiumSize];
    this.cam.beautyRadius = bowl[0];
    this.cam.beautyHeight = bowl[1];
    this.ballMesh = new BallMesh(this.sceneMgr.scene);

    // §7A.2 players. The skinned path needs its GLBs in hand — it is built
    // only if preloadCharacters() has already resolved, because a half-loaded
    // match is worse than a capsule one. When it IS live, PlayerRig is never
    // constructed at all: no capsule geometry, no kit atlas, no impostor cards.
    const assets = skinnedPlayersWanted() ? charactersReady() : null;
    if (assets) {
      this.charRig = new CharacterRig(assets);
      const cr = this.charRig;
      match.teams[0].players.forEach((p) => {
        this.playerMeshes.push(new SkinnedPlayerMesh(p.data, p.isGK ? gkA : homeKit, cr));
      });
      match.teams[1].players.forEach((p) => {
        this.playerMeshes.push(new SkinnedPlayerMesh(p.data, p.isGK ? gkB : awayKit, cr));
      });
    } else {
      if (skinnedPlayersWanted()) {
        console.warn('players=skinned asked for, but the character assets are not'
          + ' loaded yet — falling back to the capsule path');
      }
      this.rig = new PlayerRig(this.lab, timeOfDay);
      const rig = this.rig;
      match.teams[0].players.forEach((p) => {
        this.playerMeshes.push(new PlayerMesh(p.data, p.isGK ? gkA : homeKit, rig));
      });
      match.teams[1].players.forEach((p) => {
        this.playerMeshes.push(new PlayerMesh(p.data, p.isGK ? gkB : awayKit, rig));
      });
    }
    for (const pm of this.playerMeshes) this.sceneMgr.scene.add(pm.root);

    // chunky switch indicators (§5), one per seat slot (§5.4.6): warm for the
    // home pair (P1 gold, P3 amber), cool for the away pair (P2 silver, P4
    // ice) — arrow overhead plus a glowing ring at the feet so "who am I?"
    // reads at a glance even with four of them on the pitch
    const mkArrow = (color: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(0.36, 0.68, 4),
        new THREE.MeshBasicMaterial({ color }),
      );
      m.rotation.x = Math.PI;
      this.sceneMgr.scene.add(m);
      return m;
    };
    this.switchArrows = SEAT_COLORS.map(mkArrow);
    const mkRing = (color: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.8, 32),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.65,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.04;
      this.sceneMgr.scene.add(m);
      return m;
    };
    this.controlRings = SEAT_COLORS.map(mkRing);

    // Everything lit is now built, so hand the whole scene to the lighting rig
    // (§7A.4). This is not optional bookkeeping: CSM patches three's global
    // lighting chunk, and any lit material that misses registration takes the
    // non-CSM branch and receives the sun once PER CASCADE. Anything added
    // after this point (confetti, the ball trail, the star rings) is
    // unlit/basic and deliberately stays out of it.
    // §7A.4d: at night the other three pylon banks become real lights (and the
    // players' fake criss-cross shadows) — before the first compile, so the
    // spot count is in every program from the start
    this.sceneMgr.atmos.attachFloodlights(
      this.stadium.floodlightHeads.map((h) => h.position),
      this.playerMeshes.map((pm) => pm.root), this.ballMesh.root);
    this.sceneMgr.atmos.register(this.sceneMgr.scene);

    // §7A.4c weather: one instanced, camera-relative, seeded particle system,
    // built last because it is unlit and additive and must stay OUT of the
    // CSM registration pass above.
    const wx = weatherProfile();
    if (wx.rain > 0 && !this.sceneMgr.profile.retro) {
      this.rain = new Rain(this.sceneMgr.scene, this.lab.stream(0x2a17),
        wx.rain, timeOfDay === 'night' ? 0xdce8ff : 0xc6d4e4);
    }
    // ...but the >60m impostors are unlit billboards, and their material is
    // only minted when a player first crosses the threshold. Registering them
    // would be a no-op (registerMaterial ignores anything unlit) — the reason
    // they're safe is that they never enter the CSM branch at all.

    // §7A.3 budget report, plus the per-tier triangle arithmetic that keeps
    // twenty-two players inside the 150k scene ceiling
    if (this.rig) {
      const b = this.rig.budget();
      console.info(`player LOD: full ${b.full} tris / decimated ${b.lod} / impostor ${b.impostor}`
        + ` — 22 players worst case ${b.full * 22} tris`);
    } else if (this.charRig) {
      const t = this.charRig.budget();
      const r = actionClipReport(this.charRig);
      console.info(`player LOD: skinned ${t.map((n, i) => `lod${i} ${n}`).join(' / ')} tris`
        + ` — 22 at lod0 would be ${t[0] * 22} tris; shadows cast off lod${t.length - 1}`
        + `\n  animated actions: ${r.real.join(', ') || 'none'}`
        + `\n  procedural stand-ins: ${r.stand.join(', ') || 'none'}`);
    }
    this.lab.report();

    this.snapshot();
    this.snapshot();
    this.cam.jumpTo(0, 30, 60, 0, 0, 0);
    this.prewarm();
  }

  /**
   * Draw everything once, now, while the match is still loading.
   *
   * WebGL compiles a program the first time a material is DRAWN and uploads a
   * buffer the first time a geometry is, and nothing here ever asked for either
   * early: the bench showed the same 83-167 ms stall at the same sim step of
   * every run, on the frame the tele cam first brought players into LOD0 (their
   * eye and hair programs, their morphed buffers), and again on the first close
   * cam (the DoF pass's three programs and targets). So: every object visible
   * and unculled, the lens open, one full frame through shadows and the
   * composer, then everything put back exactly as it was. Anything created
   * later (confetti, replay props) still pays on first use.
   */
  private prewarm(): void {
    // `?prewarm=0` — the A/B switch for the bench
    if (typeof location !== 'undefined' && /[?&]prewarm=0/.test(location.search)) return;
    const scene = this.sceneMgr.scene;
    const saved: [THREE.Object3D, boolean, boolean][] = [];
    scene.traverse((o) => {
      saved.push([o, o.visible, o.frustumCulled]);
      o.visible = true;
      o.frustumCulled = false;
    });
    this.sceneMgr.setDepthOfField(1, 10);
    try {
      this.sceneMgr.render();
    } finally {
      for (const [o, v, f] of saved) { o.visible = v; o.frustumCulled = f; }
      this.sceneMgr.setDepthOfField(0, 10);
    }
  }


  /**
   * Pick every player's detail tier against the camera that is about to draw
   * (§7A.2). Called from both draw paths — the animated loop and the capture
   * harness's pinned still — so the two never disagree about what is on
   * screen.
   */
  private updateLOD(): void {
    const cam = this.sceneMgr.camera;
    for (const pm of this.playerMeshes) pm.updateLOD(cam);
  }

  /** How the 22 players split across the tiers right now. The headless runner
   *  prints this next to the triangle count, because "why did that shot get
   *  cheaper" is otherwise a guess. */
  lodTiers(): [number, number, number] {
    const t: [number, number, number] = [0, 0, 0];
    for (const pm of this.playerMeshes) t[pm.lodTier]++;
    return t;
  }

  /**
   * Hand each mesh the sim's view of its player's job.
   *
   * Only the keeper has one: §6.3's KeeperBrain already knows whether he is
   * watching play at the other end, set for a shot, or holding the ball, and
   * a renderer that guessed that from ball distance would be a second, worse
   * copy of a state machine that already exists. `lateral` is how sideways he
   * is moving, +1 to his right, so a shuffle along the line can pick the
   * sidestep that matches instead of breaking into a walk.
   */
  private feedKeeperState(): void {
    const all = this.match.allPlayers;
    for (let i = 0; i < all.length; i++) {
      this.playerMeshes[i]?.setKeeperState?.(null, 0, null);
    }
    for (const brain of this.match.keepers) {
      const i = all.indexOf(brain.keeper);
      if (i < 0) continue;
      const k = brain.keeper;
      // Which way he is sliding, measured the same way snapshot() measures his
      // speed: off the ground he actually covered, not off vel. A dive and a
      // penalty shuffle both move him without ever writing vel, and reading
      // vel there returned a lateral of 0 — so the sidestep never came up and
      // the sidestep is the entire reason this number exists.
      const cur = this.currSnaps[i];
      const prv = this.prevSnaps[i];
      let dx = k.vel.x, dy = k.vel.y;
      if (cur && prv) {
        const mx = (cur.x - prv.x) / SIM_DT, my = (cur.y - prv.y) / SIM_DT;
        const m = Math.hypot(mx, my);
        if (m > Math.hypot(dx, dy) && m < TELEPORT_SPEED) { dx = mx; dy = my; }
      }
      const sp = Math.hypot(dx, dy);
      // his own right, in sim coords: forward is (cos f, sin f)
      const lateral = sp > 0.05
        ? (dx * Math.sin(k.facing) - dy * Math.cos(k.facing)) / sp : 0;
      this.playerMeshes[i]?.setKeeperState?.(brain.state, lateral, brain.animClip);
    }
  }

  /** Called after every fixed sim tick. */
  snapshot(): void {
    this.prevSnaps = this.currSnaps;
    this.prevBall = this.currBall;
    const players = this.match.allPlayers;
    this.currSnaps = players.map((p, i) => {
      // The animation layer is rate-matched against the ground the body
      // actually covers, and PlayerEntity.vel is NOT that number in every
      // case: a keeper's dive integrates pos straight off diveVel and never
      // touches vel, and a phase machine that writes pos directly (the penalty
      // controller's sway on the line used to) does not touch it either. Both
      // of those reported speed 0 while translating metres — which is the
      // definition of a slide, and is exactly what the goalkeeper was doing
      // through a whole shootout.
      //
      // So: take the larger of the velocity and the distance actually covered.
      // Never the smaller — a player accelerating from a standstill is moving
      // his feet before the position catches up — and never a teleport.
      let speed = Math.hypot(p.vel.x, p.vel.y);
      const q = this.prevSnaps[i];
      if (q) {
        const moved = Math.hypot(p.pos.x - q.x, p.pos.y - q.y) / SIM_DT;
        if (moved > speed && moved < TELEPORT_SPEED) speed = moved;
      }
      return { x: p.pos.x, y: p.pos.y, facing: p.facing, speed };
    });
    const b = this.match.ball.pos;
    this.currBall = [b.x, b.y, b.z];

    // replay recording at 30fps
    this.replayAccum += 1;
    if (this.replayAccum >= 60 / REPLAY_FPS) {
      this.replayAccum = 0;
      this.replayBuf.push({
        ball: [b.x, b.y, b.z],
        players: this.currSnaps.map((s) => ({ ...s })),
        anims: players.map((p) => [p.actionAnim, p.actionAnimT]),
      });
      if (this.replayBuf.length > REPLAY_SECONDS * REPLAY_FPS) this.replayBuf.shift();
    }
  }

  onEvent(e: MatchEvent): void {
    if (e.type === 'switch') {
      this.ringPulse[e.slot] = 0.3;
      return;
    }
    // §7A.5: the crowd is a second commentator. Everything it needs is in the
    // event feed already, so this is the whole wiring — the stands react to
    // exactly what the ticker and the audio conductor react to, which is why
    // they can never drift out of sync with the match.
    this.stadium.crowdEvent(e);
    if (e.type === 'tackle') this.markTackle();
    if (e.type === 'goal') {
      this.goalSeqT = 0;
      this.goalStage = null;
      // celebration subject: the scorer's mesh — matched by shirt number,
      // since display names can be duplicated (roster editor, factory dupe)
      const scorer = e.ownGoal ? undefined : this.match.allPlayers.find(
        (p) => p.teamIdx === e.teamIdx
          && (e.scorerNum !== undefined ? p.data.num === e.scorerNum : p.data.name === e.scorerName),
      );
      // own goals name a player on the other team — fall back to the ball
      if (scorer) this.cam.subject.set(scorer.pos.x, 0, scorer.pos.y);
      else this.cam.subject.set(this.match.ball.pos.x, 0, this.match.ball.pos.y);
      this.cam.replayGoalSide = Math.sign(this.match.ball.pos.x) || 1;
      // freeze the clip now — the goal sequence recaps it, and the full-time
      // card can bring it back
      this.lastGoalClip = {
        frames: this.replayBuf.slice(Math.max(0, this.replayBuf.length - 4 * REPLAY_FPS)),
        side: this.cam.replayGoalSide,
      };
      this.spawnConfetti(e.teamIdx);
      // the timeline itself is driven from update(); entering stage 0 here
      // would run a frame of slow-mo before the sim has even flagged goalseq
    }
  }

  /**
   * §7A.3c: leave a scuff where a slide tackle happened.
   *
   * `{ type: 'tackle' }` carries NO payload — it is fired for a won slide, for
   * a standing dispossession and for a defender's block, and the sim is not
   * ours to change for a decal. So the renderer reads the position back out of
   * the live match state: a divot is owed only if someone is actually in a
   * slide animation at the moment the event lands, and the tackler is the
   * sliding player nearest the ball (two men can be down at once in a box).
   * Standing tackles and blocks find nobody sliding and leave no mark, which is
   * the correct outcome rather than a missed one.
   */
  private markTackle(): void {
    if (!this.divots) return;
    const b = this.match.ball.pos;
    let tackler: PlayerEntity | null = null;
    let bestD = Infinity;
    for (const p of this.match.allPlayers) {
      if (p.actionAnim !== 'slide') continue;
      const dx = p.pos.x - b.x, dy = p.pos.y - b.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; tackler = p; }
    }
    if (!tackler) return;
    // the slide direction is the velocity while he is still travelling; once
    // he has been pulled up by the friction in PlayerEntity.update, facing is
    // the only record of the way he went in
    let dx = tackler.vel.x, dy = tackler.vel.y;
    if (Math.hypot(dx, dy) < 0.5) {
      dx = Math.cos(tackler.facing);
      dy = Math.sin(tackler.facing);
    }
    this.divots.add(tackler.pos.x, tackler.pos.y, dx, dy);
  }

  // ------------------------------------------------------------- replay passes

  private beginPasses(frames: ReplayFrame[], passes: ReplayPass[]): void {
    this.passFrames = frames;
    this.passes = passes;
    this.startPass(0);
  }

  private startPass(i: number): void {
    this.passIdx = i;
    const p = this.passes[i];
    const last = Math.max(this.passFrames.length - 1, 1);
    this.passFrom = clampUnit(p.from) * last;
    this.passTo = Math.max(clampUnit(p.to ?? 1) * last, this.passFrom + 1);
    this.replayIdx = this.passFrom;
    this.cam.passT = 0;
    this.clearTrail(); // the angle cut rewinds time — no stale streak
    // an angle change IS a cut, and a legal one: the ball is dead
    this.camIntent = p.mode;
    this.cam.setMode(p.mode, { cut: 'replay' });
    this.onReplayStateChange?.(true,
      p.label ?? (i === 0 ? 'REPLAY' : `REPLAY · ANGLE ${i + 1}`));
  }

  private clearPasses(): void {
    this.passes = [];
    this.passFrames = [];
  }

  /**
   * The first pass of the goal package: the last ~0.85s before the ball
   * crossed the line, at 0.38x, from behind the net. Built at runtime because
   * how much footage exists depends on how early in the half the goal came.
   */
  private goalLinePass(frames: ReplayFrame[]): ReplayPass[] {
    const last = Math.max(frames.length - 1, 1);
    const pre = Math.min(0.85 * REPLAY_FPS, last - 1);
    return [{
      mode: 'goalLine', rate: 0.38, from: (last - pre) / last, to: 1,
      label: 'SLOW MOTION',
    }];
  }

  /** True while a user-triggered replay is playing (main freezes the sim). */
  isReplaying(): boolean {
    return this.manualReplay;
  }

  hasGoalClip(): boolean {
    return this.lastGoalClip !== null;
  }

  /**
   * Start a user-triggered replay: 'live' rewinds the last few seconds of
   * open play; 'goal' re-runs the multi-angle recap of the last goal.
   * Returns false when there's nothing worth showing yet.
   */
  startManualReplay(source: 'live' | 'goal'): boolean {
    if (this.manualReplay || this.passes.length > 0) return false;
    if (source === 'goal') {
      if (!this.lastGoalClip || this.lastGoalClip.frames.length < 20) return false;
      const frames = this.lastGoalClip.frames;
      this.cam.replayGoalSide = this.lastGoalClip.side;
      this.manualReplay = true;
      // the strike in slow-mo, then the three moving angles — ~8s, skippable
      this.beginPasses(frames, [...this.goalLinePass(frames), ...GOAL_REPLAY_PASSES]);
    } else {
      if (this.replayBuf.length < 1.5 * REPLAY_FPS) return false;
      this.manualReplay = true;
      // last ~3.6s over two moving angles ≈ 6s of wall clock — long enough to
      // relive the moment, short enough that a frozen match doesn't feel hung
      this.beginPasses(this.replayBuf.slice(-Math.floor(3.6 * REPLAY_FPS)), LIVE_PASSES);
    }
    return true;
  }

  /** Cut a manual replay short (any button skips). */
  stopManualReplay(): void {
    if (!this.manualReplay) return;
    this.manualReplay = false;
    this.clearPasses();
    // let the phase machine re-pick the mode on the next frame
    this.camIntent = null;
    this.onReplayStateChange?.(false);
  }

  private pushTrail(x: number, y: number, z: number): void {
    const N = 22;
    if (!this.trail) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      this.trail = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 0.26, vertexColors: true, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.trail.frustumCulled = false;
      this.sceneMgr.scene.add(this.trail);
    }
    this.trailPts.push([x, y, z]);
    if (this.trailPts.length > N) this.trailPts.shift();
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      const real = i < this.trailPts.length;
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)];
      pos.setXYZ(i, p[0], p[2] + 0.11, p[1]); // sim (x, ground-y, height-z) → scene (x, y, z)
      // padding slots are invisible — head-bright padding stacked ~12x
      // overbright at the start of every replay angle
      const b = real ? Math.pow((i + 1) / this.trailPts.length, 1.6) * 0.55 : 0;
      col.setXYZ(i, b, b, b * 0.9);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  private clearTrail(): void {
    this.trailPts = [];
    if (this.trail) {
      this.sceneMgr.scene.remove(this.trail);
      this.trail.geometry.dispose();
      (this.trail.material as THREE.Material).dispose();
      this.trail = null;
    }
  }

  private removeConfetti(): void {
    if (!this.confetti) return;
    this.sceneMgr.scene.remove(this.confetti);
    this.confetti.geometry.dispose();
    (this.confetti.material as THREE.Material).dispose();
    this.confetti = null;
  }

  private spawnConfetti(teamIdx: number): void {
    this.removeConfetti();
    const N = 380;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const kit = new THREE.Color(this.shirts[teamIdx]); // what they actually wear
    const gold = new THREE.Color(0xffce4a);
    const gx = HALF_L * Math.sign(this.match.ball.pos.x || 1);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = gx + (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = 12 + Math.random() * 14;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 46;
      vel[i * 3] = (Math.random() - 0.5) * 2;
      vel[i * 3 + 1] = -(1.2 + Math.random() * 1.8);
      vel[i * 3 + 2] = (Math.random() - 0.5) * 2;
      const c = Math.random() > 0.5 ? kit : gold;
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.confetti = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.35, vertexColors: true, transparent: true, opacity: 0.95,
    }));
    this.confettiVel = vel;
    this.confettiT = 0;
    this.sceneMgr.scene.add(this.confetti);
  }

  // -------------------------------------------------------- live camera

  /**
   * What the tele cam needs that the ball position alone can't tell it: which
   * way the play is travelling (so the frame can lead it) and how stretched
   * it is (so the rig can back off a counter-attack and tighten on a scrap in
   * the corner). Keepers are excluded — a keeper on his line 60m away would
   * peg the spread at maximum for the whole match.
   */
  private feedPlayContext(ballX: number, ballY: number): void {
    const v = this.match.ball.vel;
    this.cam.play.vx = v.x;
    this.cam.play.vy = v.y;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let n = 0;
    for (const p of this.match.allPlayers) {
      if (p.sentOff || p.isGK) continue;
      const dx = p.pos.x - ballX;
      const dy = p.pos.y - ballY;
      if (dx * dx + dy * dy > 32 * 32) continue;
      n++;
      if (p.pos.x < minX) minX = p.pos.x;
      if (p.pos.x > maxX) maxX = p.pos.x;
      if (p.pos.y < minY) minY = p.pos.y;
      if (p.pos.y > maxY) maxY = p.pos.y;
    }
    this.cam.play.spreadX = n >= 3 ? maxX - minX : 18;
    this.cam.play.spreadY = n >= 3 ? maxY - minY : 14;
  }

  /**
   * Ask for a camera mode, but only when OUR intent actually changes. That is
   * what lets a cutscene hold the rig with setMode('external') without the
   * phase machine snatching it back sixty times a second — it gets handed
   * over again at the next real beat instead.
   */
  private want(m: CamMode, opt?: ModeOptions): void {
    if (this.camIntent === m) return;
    this.camIntent = m;
    this.cam.setMode(m, opt);
  }

  /**
   * The live shot list (§7.2). Dead balls are allowed a hard cut — which the
   * broadcast package covers with a 0.6s wipe via onCut — and the way back
   * into open play is always a long damped blend, never a cut.
   */
  private pickLiveCamera(dt: number): void {
    if (this.beautyHold > 0) {
      this.beautyHold -= dt;
      return;
    }
    const ph = this.match.phase;
    if (ph === 'penalty' || ph === 'shootout') {
      this.cam.penaltySide = this.match.penalty?.goalSide ?? 1;
      this.restartKey = '';
      this.want('penalty', { cut: 'penalty' });
      return;
    }
    if (ph === 'break' || ph === 'fulltime') {
      this.restartKey = '';
      this.want('beauty', { cut: 'beauty' });
      return;
    }
    if (ph === 'kickoff') {
      this.cam.setPiece = {
        kind: 'kickoff', x: 0, y: 0,
        attackDir: this.match.teams[this.match.kickoffTeam].attackDir,
      };
      if (this.restartKey !== 'kickoff') {
        this.restartKey = 'kickoff';
        this.camIntent = 'setpiece';
        this.cam.setMode('setpiece', { cut: 'kickoff' });
      }
      return;
    }
    const r = ph === 'restart' ? this.match.restart : null;
    if (r) {
      // a fresh restart re-cuts even if the last one was also a corner; the
      // key is the spot, so a second corner from the other flag gets its own
      const key = `${r.kind}@${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)}`;
      this.cam.setPiece = {
        kind: r.kind, x: r.pos.x, y: r.pos.y,
        attackDir: this.match.teams[r.teamIdx].attackDir,
      };
      if (key !== this.restartKey) {
        this.restartKey = key;
        this.camIntent = 'setpiece';
        this.cam.setMode('setpiece', { cut: r.kind });
      }
      return;
    }
    this.restartKey = '';
    this.want('broadcast', { blendIn: 1.2 });
  }

  /**
   * Open on the stadium beauty crane and hold it for `seconds` before the
   * live package takes the rig — the pre-match establishing shot, and what
   * the attract match behind the menu runs on.
   */
  openOnBeauty(seconds = 6): void {
    this.beautyHold = seconds;
    this.camIntent = 'beauty';
    this.cam.setMode('beauty', { cut: 'beauty' });
  }

  // ---------------------------------------------------- goal presentation

  /**
   * The goal package, on a fixed clock inside the sim's 12.5s goalseq window:
   *
   *   0.00 – 2.30  the ball crossing the line, 0.38x, from behind the net
   *   2.30 – 5.00  celebration rig tracking cam.subject, low, pushing in
   *   5.00 – 6.20  crowd cutaway into the near rake behind the scoring end
   *   6.20 – ~12.1 three moving replay angles (crane → dolly → ball cam)
   *   ~12.1 –      hold on the celebration until the sim kicks off again
   *
   * Every stage boundary is a cut, announced through onCut, and every stage
   * is entered once — which is also what makes it safe for a cutscene to take
   * the camera during 'celebration' and give it back at the next boundary.
   */
  private runGoalTimeline(): void {
    if (this.goalStage === 'hold') return;
    const t = this.goalSeqT;
    const clip = this.lastGoalClip;
    const haveClip = !!clip && clip.frames.length >= 8;
    let want: GoalStage;
    if (t < GOAL_SLOWMO_END) want = haveClip ? 'slowmo' : 'celebration';
    else if (t < GOAL_CELEB_END) want = 'celebration';
    else if (t < GOAL_CROWD_END) want = 'crowd';
    else want = haveClip ? 'replay' : 'celebration';
    if (want !== this.goalStage) this.enterGoalStage(want);
  }

  private enterGoalStage(stage: GoalStage): void {
    this.goalStage = stage;
    const clip = this.lastGoalClip;
    switch (stage) {
      case 'slowmo':
        if (clip) {
          this.cam.replayGoalSide = clip.side;
          this.beginPasses(clip.frames, this.goalLinePass(clip.frames));
        }
        break;
      case 'celebration':
        this.clearPasses();
        this.onReplayStateChange?.(false);
        this.camIntent = 'celebration';
        this.cam.setMode('celebration', { cut: 'celebration' });
        break;
      case 'crowd':
        this.clearPasses();
        this.onReplayStateChange?.(false);
        this.camIntent = 'crowd';
        this.cam.setMode('crowd', { cut: 'crowd' });
        break;
      case 'replay':
        if (clip) {
          this.cam.replayGoalSide = clip.side;
          this.beginPasses(clip.frames, GOAL_REPLAY_PASSES);
        }
        break;
      case 'hold':
        this.clearPasses();
        this.onReplayStateChange?.(false);
        this.camIntent = 'celebration';
        this.cam.setMode('celebration', { cut: 'celebration' });
        break;
    }
    this.onGoalStage?.(stage);
  }

  /** dtReal = wall-clock frame dt; alpha = interpolation between sim ticks. */
  update(dtReal: number, alpha: number): void {
    const inGoalSeq = this.match.phase === 'goalseq';
    if (inGoalSeq && this.goalSeqT >= 0) {
      this.goalSeqT += dtReal;
      this.runGoalTimeline();
    } else if (this.goalSeqT >= 0 && !inGoalSeq) {
      // sequence over (or skipped) — back to the live package (the phase
      // machine below picks the mode; the UI wipe covers the cut)
      this.goalSeqT = -1;
      this.goalStage = null;
      if (!this.manualReplay) {
        this.clearPasses();
        this.camIntent = null;
        this.onReplayStateChange?.(false);
      }
    }

    this.feedKeeperState();

    const replaying = this.passes.length > 0;
    const scripted = this.cutscene?.(dtReal, replaying) === true;
    let ballX: number, ballY: number, ballZ: number;

    if (replaying) {
      const pass = this.passes[this.passIdx];
      this.replayIdx = Math.min(this.replayIdx + dtReal * REPLAY_FPS * pass.rate, this.passTo);
      // the moving rigs ride this: every canned move is expressed as a
      // function of how far through its own pass it is, so a pass that is
      // cut short still lands on a pose it was heading for
      this.cam.passT = clampUnit((this.replayIdx - this.passFrom)
        / Math.max(this.passTo - this.passFrom, 1e-6));
      // interpolate between the 30fps recorded frames — nearest-frame
      // stepping stutters badly at slow-mo rates
      const i0 = Math.floor(this.replayIdx);
      const i1 = Math.min(i0 + 1, this.passFrames.length - 1);
      const frac = this.replayIdx - i0;
      const f0 = this.passFrames[i0];
      const f1 = this.passFrames[i1];
      ballX = f0.ball[0] + (f1.ball[0] - f0.ball[0]) * frac;
      ballY = f0.ball[1] + (f1.ball[1] - f0.ball[1]) * frac;
      ballZ = f0.ball[2] + (f1.ball[2] - f0.ball[2]) * frac;
      // the chase rig needs a heading, and the recorded clip is the only
      // place the ball has one while the sim is frozen
      this.cam.play.vx = (f1.ball[0] - f0.ball[0]) * REPLAY_FPS;
      this.cam.play.vy = (f1.ball[1] - f0.ball[1]) * REPLAY_FPS;
      this.ballMesh.update(ballX, ballY, ballZ);
      // paused frames (dt 0) must not stack identical points into one
      // over-bright additive dot
      if (dtReal > 0) this.pushTrail(ballX, ballY, ballZ);
      f0.players.forEach((s, i) => {
        const s1 = f1.players[i];
        const x = s.x + (s1.x - s.x) * frac;
        const y = s.y + (s1.y - s.y) * frac;
        let df = s1.facing - s.facing;
        if (df > Math.PI) df -= Math.PI * 2;
        if (df < -Math.PI) df += Math.PI * 2;
        const [anim, animT] = f0.anims[i];
        // slow the run cycles with the footage or slow-mo players foot-skate
        this.playerMeshes[i].update(dtReal * pass.rate, x, y, 0, s.facing + df * frac,
          s.speed + (s1.speed - s.speed) * frac, anim, animT);
      });
      if (this.replayIdx >= this.passTo - 1e-6) {
        if (this.passIdx < this.passes.length - 1) {
          this.startPass(this.passIdx + 1);
        } else {
          this.clearPasses();
          this.onReplayStateChange?.(false);
          if (this.manualReplay) {
            this.manualReplay = false;
            this.camIntent = null; // the phase machine takes it back
          } else if (this.goalStage === 'replay') {
            // goal sequence: hold on the celebration until the sim moves on
            this.enterGoalStage('hold');
          } else {
            this.camIntent = null;
          }
        }
      }
    } else {
      // interpolated live rendering (a cutscene has already posed the meshes)
      const players = this.match.allPlayers;
      for (let i = 0; !scripted && i < players.length; i++) {
        const a = this.prevSnaps[i] ?? this.currSnaps[i];
        const b = this.currSnaps[i];
        const x = a.x + (b.x - a.x) * alpha;
        const y = a.y + (b.y - a.y) * alpha;
        let f0 = a.facing, f1 = b.facing;
        let df = f1 - f0;
        if (df > Math.PI) df -= Math.PI * 2;
        if (df < -Math.PI) df += Math.PI * 2;
        this.playerMeshes[i].update(
          dtReal, x, y, 0, f0 + df * alpha, b.speed,
          players[i].actionAnim, players[i].actionAnimT,
        );
      }
      ballX = this.prevBall[0] + (this.currBall[0] - this.prevBall[0]) * alpha;
      ballY = this.prevBall[1] + (this.currBall[1] - this.prevBall[1]) * alpha;
      ballZ = this.prevBall[2] + (this.currBall[2] - this.prevBall[2]) * alpha;
      // A keeper holding the ball: the sim parks it half a metre ahead of him
      // at chest height, which is where the CAPSULE's hands were. The skinned
      // keeper's gloves are wherever his clip put them — low over a collect,
      // at the hip in the hold idle — so the ball goes where the gloves are.
      // Gameplay still reads the sim's position; only the picture moves.
      for (const brain of this.match.keepers) {
        if (brain.state !== 'hold') continue;
        const i = this.match.allPlayers.indexOf(brain.keeper);
        const view = i >= 0 ? this.playerMeshes[i] : undefined;
        if (!view?.handsMidpoint?.(this.handsTmp)) continue;
        const f = brain.keeper.facing;
        // a hand's width forward so it sits in the palms, not on the wrists
        ballX = this.handsTmp.x + Math.cos(f) * 0.10;
        ballY = this.handsTmp.z + Math.sin(f) * 0.10;
        ballZ = Math.max(this.handsTmp.y, 0.11);
      }
      this.ballMesh.update(ballX, ballY, ballZ);
      if (this.trailPts.length) this.clearTrail();
      this.feedPlayContext(ballX, ballY);
    }

    // switch indicators hover over each seat's controlled player (live play
    // only — a cone bobbing through the penalty cinematic reads as a glitch)
    const inAction = this.match.phase === 'play' || this.match.phase === 'restart'
      || this.match.phase === 'kickoff';
    for (let i = 0; i < SEAT_COLORS.length; i++) {
      const ctrl = this.match.controlled[i];
      const arrow = this.switchArrows[i];
      const ring = this.controlRings[i];
      this.ringPulse[i] = Math.max(0, this.ringPulse[i] - dtReal);
      if (ctrl && this.match.seats[i] && !replaying && !scripted && inAction && !ctrl.sentOff) {
        arrow.visible = true;
        ring.visible = true;
        const bob = Math.sin(performance.now() * 0.006 + i * 2) * 0.08;
        arrow.position.set(ctrl.pos.x, 2.35 + bob, ctrl.pos.y);
        arrow.rotation.y += dtReal * 2;
        // ring pulses outward for a beat right after a switch
        const pulse = this.ringPulse[i] / 0.3;
        ring.position.set(ctrl.pos.x, 0.04, ctrl.pos.y);
        ring.scale.setScalar(1 + pulse * 1.2);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.65 + pulse * 0.35;
      } else {
        arrow.visible = false;
        ring.visible = false;
      }
    }

    // sent-off players leave the pitch (and the scene)
    const all = this.match.allPlayers;
    for (let i = 0; i < all.length; i++) {
      this.playerMeshes[i].root.visible = !all[i].sentOff;
    }

    // the live camera package — skipped while a replay owns the rig, and
    // while the goal timeline is running its own shot list
    if (!replaying && this.goalSeqT < 0) this.pickLiveCamera(dtReal);

    // confetti physics (hidden while a replay rewinds time — celebration
    // confetti raining through the pre-goal build-up is anachronistic)
    if (this.confetti) this.confetti.visible = !replaying;
    if (this.confetti && this.confettiVel) {
      this.confettiT += dtReal;
      const posAttr = this.confetti.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += (this.confettiVel[i] + Math.sin(this.confettiT * 3 + i) * 0.6) * dtReal;
        arr[i + 1] += this.confettiVel[i + 1] * dtReal;
        arr[i + 2] += this.confettiVel[i + 2] * dtReal;
        if (arr[i + 1] < 0.1) arr[i + 1] = 0.1;
      }
      posAttr.needsUpdate = true;
      (this.confetti.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - this.confettiT / 6);
      if (this.confettiT > 6) this.removeConfetti();
    }

    // §7A.3c: divots age on the WALL clock, not on the replay's clock — a mark
    // laid down ninety seconds ago is ninety seconds old however many times the
    // camera has rewound to look at it since
    this.divots?.update(dtReal);

    this.stadium.update(dtReal);
    this.cam.update(dtReal, ballX, ballY, ballZ);
    // the curtain rides on the camera, so it is stepped AFTER the director has
    // moved the rig and before anything draws
    this.rain?.update(dtReal, this.sceneMgr.camera);
    if (!this.skipDraw) {
      this.updateLOD();
      this.syncLens();
      // §7A.7: frame pressure buys back pixels, never features. Only the
      // animated path feeds this — advanceNoDraw and renderStill must stay
      // bit-identical run to run for the capture contract.
      this.sceneMgr.adaptPixelRatio(dtReal);
      this.sceneMgr.render();
    }
  }

  /**
   * §7A.6c — the LENS, once per drawn frame.
   *
   * Two jobs, both of which have to happen after the camera has been posed
   * (by the director OR by a pinned capture pose) and before the draw: keep
   * the rain curtain centred on the lens, and decide whether this frame has a
   * focal plane at all.
   *
   * DOF_MODES is the whole policy. A broadcast tele lens covering a football
   * match is a long lens stopped well down — the near touchline and the far
   * stand are both acceptably sharp, and defocusing either is the single
   * fastest way to make a match look like a game instead of like television.
   * The CLOSE rigs are the opposite: a scorer 3.8m from the lens on a 36°
   * field of view has a depth of field measured in centimetres, and a
   * celebration with the whole crowd in focus behind it is the tell-tale of a
   * render. So: cutscenes, the celebration rig, the penalty and goal-line
   * cams and the crowd cutaway get a lens; open play never does.
   */
  private syncLens(): void {
    const camera = this.sceneMgr.camera;
    if (this.rain) this.rain.update(0, camera);
    const mode = this.cam.mode;
    const close = mode === 'celebration' || mode === 'penalty' || mode === 'goalLine'
      || mode === 'cine' || mode === 'crowd' || mode === 'external';
    if (!close) {
      this.sceneMgr.setDepthOfField(0, 10);
      return;
    }
    // Focus on what the shot is OF. The celebration and cutscene rigs are
    // pointed at a man (cam.subject, which the presentation layer moves); the
    // dead-ball rigs are pointed at the ball.
    const subj = this.cam.subject;
    const useSubject = (mode === 'celebration' || mode === 'external' || mode === 'crowd')
      && subj.lengthSq() > 1e-6;
    // The nearest player in front of the lens. Every close camera is a shot
    // of players, and a man three metres from the glass rendered as a smear
    // does not read as a lens, it reads as a low-res model.
    const fwd = camera.getWorldDirection(this.lensTmp);
    let nearest: THREE.Vector3 | null = null;
    let nearD = Infinity;
    for (const pm of this.playerMeshes) {
      const p = pm.root.position;
      const dx = p.x - camera.position.x, dy = p.y - camera.position.y, dz = p.z - camera.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1.5 || d >= nearD) continue;
      // in front of the lens, and not so far off-axis that he is out of frame
      if ((dx * fwd.x + dy * fwd.y + dz * fwd.z) / d < 0.8) continue;
      nearD = d; nearest = p;
    }
    // An external pose with no subject (the walkout, the line-up, the
    // handshake) is aimed at empty grass with the files 12 m off; the ball is
    // on the centre spot behind it all. Focus on the nearest man instead.
    let target: THREE.Vector3 = this.ballMesh.root.position;
    if (useSubject) target = subj;
    else if (mode === 'external') target = nearest ?? this.cam.lookPoint;
    let focus = camera.position.distanceTo(target);
    // the focal ZONE scales with the distance, the way a real one does: a
    // third of the subject distance is roughly an f/4 lens at these focal
    // lengths, and it keeps a whole sprinting player sharp rather than just
    // his shirt number...
    let range = Math.max(1.6, focus * 0.34);
    // ...and it is pulled forward to take in the nearest man when he is
    // closer than that. The crowd forty metres back stays defocused either
    // way; what changes is that the team-mate running past the lens does not
    // dissolve.
    if (nearest && nearD < focus - range) {
      const lo = nearD - 0.5;
      const hi = focus + range * 0.5;
      focus = (lo + hi) * 0.5;
      range = Math.max(1.6, (hi - lo) * 0.5);
    }
    this.sceneMgr.setDepthOfField(1, focus, range);
  }

  // ------------------------------------------------------ capture harness
  // Two generic hooks for the headless shot runner (§7A.9): advance the
  // visuals without drawing, and draw one frame from an arbitrary camera
  // pose. Neither knows anything about the post chain, so a post-stack
  // rewrite leaves them valid.

  /**
   * Advance the visual state one frame WITHOUT drawing. Lets a still be
   * composed from thousands of sim frames without paying for thousands of
   * fully post-processed renders.
   */
  advanceNoDraw(dtReal: number, alpha: number): void {
    this.skipDraw = true;
    try {
      this.update(dtReal, alpha);
    } finally {
      this.skipDraw = false;
    }
  }

  /**
   * Pin the camera to a fixed pose and draw exactly one frame, bypassing the
   * camera director. Returns that frame's GPU counters.
   */
  renderStill(pose: {
    pos: [number, number, number];
    look: [number, number, number];
    fov?: number;
  }): { drawCalls: number; triangles: number } {
    const camera = this.sceneMgr.camera;
    if (pose.fov !== undefined && camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
    this.cam.jumpTo(pose.pos[0], pose.pos[1], pose.pos[2],
      pose.look[0], pose.look[1], pose.look[2]);
    // the pinned pose is usually nowhere near the director's, so the tiers
    // have to be re-picked before the counters are read or the still reports
    // triangles for a camera that isn't drawing it
    this.updateLOD();
    this.syncLens();

    // one composer.render() is many gl draws — autoReset would leave us
    // reading only the last pass
    const info = this.sceneMgr.renderer.info;
    const prevAutoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    this.sceneMgr.render();
    const stats = { drawCalls: info.render.calls, triangles: info.render.triangles };
    info.autoReset = prevAutoReset;
    return stats;
  }

  /**
   * Draw one frame from wherever the DIRECTOR has the camera, rather than a
   * pinned pose. This is how the shot list exercises the camera work itself
   * (`"cam": "director"`): the pose is whatever the tele cam, the set-piece
   * rig or the goal timeline chose after N deterministic sim frames, so the
   * PNG is a test of the camera and not of a hand-typed vector.
   */
  renderStillLive(): { drawCalls: number; triangles: number } {
    this.updateLOD();
    this.syncLens();
    const info = this.sceneMgr.renderer.info;
    const prevAutoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    this.sceneMgr.render();
    const stats = { drawCalls: info.render.calls, triangles: info.render.triangles };
    info.autoReset = prevAutoReset;
    return stats;
  }

  /** Release all GPU resources — call when the match ends. */
  dispose(): void {
    this.removeConfetti();
    this.clearTrail();
    this.divots?.dispose();
    this.divots = null;
    this.rain?.dispose();
    this.rain = null;
    // the scene traversal in SceneManager frees whatever is attached to the
    // scene; the rig's shared geometries and the lab's texture caches are held
    // outside it and have to be freed by hand or a tournament strands them
    for (const pm of this.playerMeshes) pm.dispose();
    this.rig?.dispose();
    this.charRig?.dispose();
    this.lab.dispose();
    this.sceneMgr.dispose();
  }

  /** Project a sim position to screen % for HTML nameplates. */
  screenPos(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, z, y).project(this.sceneMgr.camera);
    return {
      x: (v.x * 0.5 + 0.5) * 100,
      y: (-v.y * 0.5 + 0.5) * 100,
      visible: v.z < 1,
    };
  }
}
