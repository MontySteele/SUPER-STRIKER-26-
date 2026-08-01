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

import { GameRenderer } from '../render/gameRenderer';
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
  cam: CamPose;
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

    // step the sim synchronously; the visual state advances with it (limb
    // damping, confetti, celebration timers) but nothing is drawn until the end
    for (let i = 0; i < shot.frames; i++) {
      match.update();
      if (match.phase === 'break') match.continueFromBreak();
      renderer.snapshot();
      renderer.advanceNoDraw(SIM_DT, 1);
      env.advanceClock(SIM_DT * 1000);
    }

    const still = renderer.renderStill(shot.cam);

    // fps: redraw the identical still back-to-back and time it on the REAL
    // clock. A rAF loop would just report the vsync rate; this reports what
    // the frame actually costs.
    const gl = renderer.sceneMgr.renderer.getContext();
    const t0 = env.realNow();
    for (let i = 0; i < FPS_FRAMES; i++) renderer.renderStill(shot.cam);
    gl.finish(); // don't stop the clock while the GPU is still draining
    const fps = FPS_FRAMES / Math.max((env.realNow() - t0) / 1000, 1e-6);

    // draw the still one last time inside rAF so the composited surface the
    // screenshot grabs is the still itself (the canvas has no preserved
    // drawing buffer), then hand over on the following frame
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        renderer.renderStill(shot.cam);
        requestAnimationFrame(() => resolve());
      });
    });

    const stats: CaptureStats = {
      drawCalls: still.drawCalls,
      triangles: still.triangles,
      fps: Math.round(fps * 10) / 10,
    };
    w.__ss26Capture = { ready: true, shot: shot.name, stats };
  } catch (err) {
    console.error('capture failed:', err);
    w.__ss26Capture = { ready: true, error: String(err) };
  }
}
