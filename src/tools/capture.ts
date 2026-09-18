// Deterministic capture mode (§7A.9): `index.html?capture=<shot>` skips the
// menus, the attract match and the audio engine, builds one CPU-vs-CPU match
// from the shot's fixed seed, steps the sim a fixed number of frames, pins the
// camera to a fixed pose, draws exactly one frame and publishes
// `window.__ss26Capture = { ready, stats }` for tools/capture.mjs to read.
//
// The contract is "same commit + same shot name => pixel-identical output".
// Everything that could break it is pinned here: the sim seed, the two teams,
// the frame count, the camera pose, and — via installDeterministicEnv — the
// render layer's Math.random and wall clock.

import { GameRenderer, skinnedPlayersWanted } from '../render/gameRenderer';
import { Presentation } from '../present/director';
import type { CamMode } from '../render/camera';
import { preloadCharacters } from '../render/characterAssets';
import { forceQuality, type QualityLevel } from '../render/quality';
import type { TimeOfDay } from '../render/scene';
import type { StadiumSize } from '../render/stadium';
import { SIM_DT } from '../sim/constants';
import { Match } from '../sim/match';
import type { PlayerEntity } from '../sim/player';
import { findTeam } from '../data/loader';
import { installDeterministicEnv } from './determinism';
import shotsJson from './shots.json';

/** A fixed camera, in scene coords (x length, y up, z across = sim y). */
export interface CamPose {
  pos: [number, number, number];
  look: [number, number, number];
  fov?: number;
}

/**
 * Roll until the match reaches a described MOMENT, instead of a tick count.
 *
 * A pinned frame number is the right contract for a shot of the pitch, the
 * stands or a camera rig: the sim is a pure function of the seed, so frame 986
 * is always the same instant. It is the WRONG contract for a shot of one
 * animation. Retuning anything in the sim — a first touch, a tackle window,
 * how long a keeper holds the ball — moves every subsequent event by a few
 * ticks, and a shot that was a keeper at full stretch quietly becomes a keeper
 * standing on his line. That is not a regression the PNG shows; it is a
 * regression the PNG hides.
 *
 * So a keeper shot says what it is a shot OF, and the roll finds it. Still
 * deterministic, still "same commit + same seed => the same pixels" — the
 * predicate is a pure function of the sim state — but it survives the sim
 * being worked on, which these shots have to.
 */
export interface ShotSeek {
  /** the shootout kick being taken, 1-based */
  penKick?: number;
  /** ...in this phase of it */
  penPhase?: 'setup' | 'aim' | 'strike' | 'resolve';
  /** a keeper whose KeeperBrain is in this state (§6.3) */
  keeperState?: string;
  /** a keeper whose armed CLIP_TABLE row is this */
  keeperClip?: string;
  /** a keeper playing this ActionAnim */
  keeperAnim?: string;
  /** seconds to roll on after the moment is first seen */
  after?: number;
  /** give up (and fail the shot) after this many ticks */
  maxTicks?: number;
}

export interface ShotSpec {
  name: string;
  note: string;
  seed: number;
  home: string;
  away: string;
  /** sim ticks to advance before the still is taken */
  frames: number;
  timeOfDay: TimeOfDay;
  stadium: StadiumSize;
  /**
   * A pinned pose, or `"director"` to shoot from wherever the CameraDirector
   * has the rig after `frames` sim ticks. The director path is still a
   * contract — the sim is a pure function of the seed and the camera is a
   * pure function of the sim — but it tests the camera work rather than a
   * hand-typed vector, which is the only way a framing regression is visible.
   */
  cam: CamPose | 'director' | 'keeper';
  /**
   * `cam: "keeper"` only. Where to stand relative to the keeper the shot found,
   * in metres: [toward the halfway line, up, across the pitch]. Mirrored by
   * which goal he is at, so one offset frames either end the same way — which
   * matters, because which end a shootout is taken at is the seed's business.
   */
  camOffset?: [number, number, number];
  /** `cam: "keeper"` only: height on the keeper the camera looks at (default 1). */
  camAim?: number;
  /** roll to a described moment instead of a tick count (see ShotSeek) */
  seek?: ShotSeek;
  /** director shots only: force a mode (e.g. 'beauty') before the extra roll */
  camMode?: CamMode;
  /** director shots only: seconds of camera-only time after the sim frames,
   *  so a canned move (a crane, a push-in) can be caught mid-flight */
  camSeconds?: number;
  /**
   * §7 presentation. Off unless a shot asks for it — a scripted walkout in
   * front of every baseline would be twenty-eight seconds of line-up nobody
   * asked to photograph. 'walkout' holds the sim for the whole roll (so
   * `frames` is the scene's own clock, in ticks); 'goal' rides along with a
   * normal roll and choreographs the celebration when the sim scores;
   * 'break'/'fulltime' are forced after the roll and photographed through
   * `cutsceneSeconds`.
   */
  cutscene?: 'walkout' | 'goal' | 'break' | 'fulltime';
  /** seconds of scene-only time after the sim frames, for a forced scene */
  cutsceneSeconds?: number;
  /** §7A.7 level to draw at. Omitted = HIGH: a baseline must never silently
   *  inherit whatever graphics setting the browser profile happens to hold. */
  quality?: QualityLevel;
  /**
   * Knockout rules, with a short period length. Together these are how a shot
   * photographs a SHOOTOUT (§6.5): a knockout tie that is level after four
   * short periods enters 'break' with label PENALTIES, and the roll below
   * already answers every break, so the shootout starts on its own and the
   * shot's `frames` counts on into it. There is no other entry — Match.
   * beginShootout is private, and a capture that reached in and called it
   * would be photographing a state the game cannot actually be in.
   */
  knockout?: boolean;
  /** seconds per period; omitted = HALF_LENGTH_SEC (no shot reaches half time) */
  halfLengthSec?: number;
}

export const SHOTS: ShotSpec[] = (shotsJson as unknown as { shots: ShotSpec[] }).shots;

export interface CaptureStats {
  drawCalls: number;
  triangles: number;
  fps: number;
}

/** Frames drawn back-to-back after the still to measure throughput. */
const FPS_FRAMES = 60;

/**
 * Has the match reached the moment this shot is of? Returns the keeper it
 * matched on (so `cam: "keeper"` frames the right man), or plain true for a
 * penalty-phase match with no particular keeper named.
 */
function seekHit(match: Match, s: ShotSeek): PlayerEntity | boolean {
  const pen = match.penalty;
  if (s.penPhase !== undefined || s.penKick !== undefined) {
    if (!pen) return false;
    if (s.penPhase && pen.phase !== s.penPhase) return false;
    if (s.penKick !== undefined) {
      const taken = pen.board
        ? pen.board.kicks[0].length + pen.board.kicks[1].length : 0;
      if (taken !== s.penKick - 1) return false;
    }
  }
  if (s.keeperState !== undefined || s.keeperClip !== undefined || s.keeperAnim !== undefined) {
    const brain = match.keepers.find((b) =>
      (s.keeperState === undefined || b.state === s.keeperState)
      && (s.keeperClip === undefined || b.animClip === s.keeperClip)
      && (s.keeperAnim === undefined || b.keeper.actionAnim === s.keeperAnim));
    return brain ? brain.keeper : false;
  }
  return pen ? pen.keeper : true;
}

/** Whichever keeper the ball is nearer — the fallback subject. */
function nearestKeeper(match: Match): PlayerEntity {
  const b = match.ball.pos;
  const [a, c] = match.keepers.map((k) => k.keeper);
  return Math.hypot(a.pos.x - b.x, a.pos.y - b.y)
    <= Math.hypot(c.pos.x - b.x, c.pos.y - b.y) ? a : c;
}

/** A camera parked at a fixed offset off one keeper, mirrored by his end. */
function keeperPose(shot: ShotSpec, k: PlayerEntity): CamPose {
  const [inward, up, across] = shot.camOffset ?? [6, 1.7, 6];
  const side = Math.sign(k.pos.x) || 1;
  return {
    pos: [k.pos.x - side * inward, up, k.pos.y + across],
    look: [k.pos.x, shot.camAim ?? 1.0, k.pos.y],
    fov: 36,
  };
}

/** Long enough that no shot ever reaches half time mid-capture. */
const HALF_LENGTH_SEC = 600;

/**
 * Run one shot to completion. Never throws: a failure is reported through
 * `window.__ss26Capture.error` so the headless runner fails loudly instead of
 * hanging on a `ready` flag that will never arrive.
 */
export async function runCapture(canvas: HTMLCanvasElement, shotName: string): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  w.__ss26CaptureShots = SHOTS.map((s) => s.name);

  const shot = SHOTS.find((s) => s.name === shotName);
  if (!shot) {
    w.__ss26Capture = { ready: true, error: `unknown shot "${shotName}"` };
    return;
  }

  try {
    const env = installDeterministicEnv(shot.seed);
    // `&quality=retro` overrides the shot's level for ad-hoc checks — the one
    // way to point the harness at a level the shot list doesn't ask for
    // (proving RETRO still boots, mostly). It deliberately does NOT touch
    // shots.json: a baseline taken this way is not the shot's baseline.
    const override = new URLSearchParams(location.search).get('quality');
    const level = override === 'high' || override === 'medium' || override === 'retro'
      ? override : shot.quality ?? 'high';
    forceQuality(level);

    // `?players=skinned` swaps the capsules for the authored characters. The
    // GLBs have to be in hand BEFORE the renderer is constructed or it falls
    // back to capsules and the shot silently measures the wrong pipeline — so
    // this await is load-bearing, not politeness.
    if (skinnedPlayersWanted()) await preloadCharacters();

    // both seats null = CPU vs CPU = the sim is a pure function of the seed
    const match = new Match({
      home: findTeam(shot.home),
      away: findTeam(shot.away),
      seats: [null, null],
      halfLengthSec: shot.halfLengthSec ?? HALF_LENGTH_SEC,
      difficulty: 'pro',
      knockout: shot.knockout ?? false,
      mode: 'match',
      seed: shot.seed,
    });
    const renderer = new GameRenderer(canvas, match, shot.timeOfDay, shot.stadium);
    // the renderer needs the event feed or a goal shot has no celebration
    // camera, no confetti and no dejected losers
    match.events.on((e) => renderer.onEvent(e));

    // §7 cutscenes, only when the shot asks (see ShotSpec.cutscene)
    const present = shot.cutscene
      ? new Presentation(renderer, match, {
        walkout: shot.cutscene === 'walkout',
        celebration: shot.cutscene === 'goal',
        walkoff: false,   // the two card scenes are FORCED below, not awaited
      })
      : null;

    // step the sim synchronously; the visual state advances with it (limb
    // damping, confetti, celebration timers) but nothing is drawn until the end
    const seek = shot.seek;
    const cap = seek ? seek.maxTicks ?? 20000 : shot.frames;
    let found = seek ? -1 : 0;
    let subject: PlayerEntity | null = null;
    const after = Math.round((seek?.after ?? 0) * 60);
    for (let i = 0; i < cap; i++) {
      // a walkout holds the tick exactly as the game loop does, so `frames`
      // for that kind of shot counts the SCENE's clock, not the match's
      if (!present?.frame()) {
        match.update();
        if (match.phase === 'break') match.continueFromBreak();
        renderer.snapshot();
      }
      renderer.advanceNoDraw(SIM_DT, 1);
      env.advanceClock(SIM_DT * 1000);
      if (!seek) continue;
      if (found < 0) {
        const hit = seekHit(match, seek);
        if (hit) { found = i; subject = hit === true ? null : hit; }
      }
      if (found >= 0 && i - found >= after) break;
    }
    if (seek) {
      if (found < 0) throw new Error(`seek never matched in ${cap} ticks`);
      console.info(`capture: ${shot.name} found its moment at frame ${found + 1}`
        + ` (+${after} → ${found + 1 + after}), t=${match.simTime.toFixed(2)}s`);
    }

    // the card scenes have no phase to wait for out here: force one and let it
    // play against a held sim for as long as the shot wants
    if (present && (shot.cutscene === 'break' || shot.cutscene === 'fulltime')) {
      present.force(shot.cutscene);
    }
    const sceneFrames = Math.round((shot.cutsceneSeconds ?? 0) * 60);
    for (let i = 0; i < sceneFrames; i++) {
      renderer.advanceNoDraw(SIM_DT, 1);
      env.advanceClock(SIM_DT * 1000);
    }

    // director shots: optionally force a mode and roll the camera on without
    // the sim, so a canned move can be caught at a chosen point in its arc.
    // want() only acts when the director's OWN intent changes, so a mode set
    // from out here survives the phase machine for as long as the phase holds.
    if (shot.cam === 'director') {
      if (shot.camMode) renderer.cam.setMode(shot.camMode, { cut: 'capture' });
      const extra = Math.round((shot.camSeconds ?? 0) * 60);
      for (let i = 0; i < extra; i++) {
        renderer.advanceNoDraw(SIM_DT, 1);
        env.advanceClock(SIM_DT * 1000);
      }
    }

    const pose = shot.cam === 'keeper'
      ? keeperPose(shot, subject ?? nearestKeeper(match))
      : shot.cam;
    const draw = (): { drawCalls: number; triangles: number } => (
      pose === 'director' ? renderer.renderStillLive() : renderer.renderStill(pose)
    );

    const still = draw();
    const tiers = renderer.lodTiers();
    console.info(`player LOD tiers (full/decimated/impostor): ${tiers.join(' / ')}`);

    // fps: redraw the identical still back-to-back and time it on the REAL
    // clock. A rAF loop would just report the vsync rate; this reports what
    // the frame actually costs.
    // `&fps=0` skips the throughput measurement. It changes no pixel — it only
    // drops 60 redraws of the same still — and exists because a wide shot
    // under software rasterization spends minutes in this loop, which makes
    // iterating on camera framing impractical. Never use it for a baseline.
    const wantFps = new URLSearchParams(location.search).get('fps') !== '0';
    const gl = renderer.sceneMgr.renderer.getContext();
    const t0 = env.realNow();
    if (wantFps) for (let i = 0; i < FPS_FRAMES; i++) draw();
    gl.finish(); // don't stop the clock while the GPU is still draining
    const fps = wantFps ? FPS_FRAMES / Math.max((env.realNow() - t0) / 1000, 1e-6) : 0;

    // draw the still one last time inside rAF so the composited surface the
    // screenshot grabs is the still itself (the canvas has no preserved
    // drawing buffer), then idle a few frames before handing over. One frame
    // used to be enough; a post-uplift frame costs over a second under
    // software rasterization, which is long enough for the compositor to miss
    // its deadline and hand the screenshot an empty surface instead.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        draw();
        let idle = 4;
        const tick = (): void => {
          if (--idle <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });

    const stats: CaptureStats = {
      drawCalls: still.drawCalls,
      triangles: still.triangles,
      fps: Math.round(fps * 10) / 10,
    };
    // the live objects, so an ad-hoc probe can re-aim the camera at one player
    // and draw again without inventing a new shot (shots.json is a contract)
    w.__ss26 = { match, renderer, present };
    w.__ss26Capture = { ready: true, shot: shot.name, stats };
  } catch (err) {
    console.error('capture failed:', err);
    w.__ss26Capture = { ready: true, error: String(err) };
  }
}
