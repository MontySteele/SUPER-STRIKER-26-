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
import { findTeam } from '../data/loader';
import { installDeterministicEnv } from './determinism';
import shotsJson from './shots.json';

/** A fixed camera, in scene coords (x length, y up, z across = sim y). */
export interface CamPose {
  pos: [number, number, number];
  look: [number, number, number];
  fov?: number;
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
  cam: CamPose | 'director';
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
}

export const SHOTS: ShotSpec[] = (shotsJson as unknown as { shots: ShotSpec[] }).shots;

export interface CaptureStats {
  drawCalls: number;
  triangles: number;
  fps: number;
}

/** Frames drawn back-to-back after the still to measure throughput. */
const FPS_FRAMES = 60;

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
      halfLengthSec: HALF_LENGTH_SEC,
      difficulty: 'pro',
      knockout: false,
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
    for (let i = 0; i < shot.frames; i++) {
      // a walkout holds the tick exactly as the game loop does, so `frames`
      // for that kind of shot counts the SCENE's clock, not the match's
      if (!present?.frame()) {
        match.update();
        if (match.phase === 'break') match.continueFromBreak();
        renderer.snapshot();
      }
      renderer.advanceNoDraw(SIM_DT, 1);
      env.advanceClock(SIM_DT * 1000);
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

    const draw = (): { drawCalls: number; triangles: number } => (
      shot.cam === 'director' ? renderer.renderStillLive() : renderer.renderStill(shot.cam)
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
