// Broadcast-graphics capture mode: `index.html?broadcast=<shot>` boots a
// deterministic CPU-vs-CPU match exactly like the §7A.9 still harness, builds
// the real HUD over it, drives ONE graphic of the TV package into its settled
// state and freezes the whole thing so a headless screenshot is reproducible.
//
// It is deliberately a sibling of src/tools/capture.ts rather than an extension
// of it: shots.json is the render team's pixel contract, and a UI shot has a
// different job (does the package read as television?) and a different budget
// (the 3D behind it is backdrop). Keeping them apart means a font tweak here
// can never invalidate a lighting baseline there.
//
//   npm run capture-tv                          # every graphic, 1080p + 720p
//   npm run capture-tv -- --shots goal_banner    # one of them
//   npm run capture-tv -- --size 1280x720        # one size only

import { GameRenderer } from '../render/gameRenderer';
import { forceQuality } from '../render/quality';
import type { TimeOfDay } from '../render/scene';
import type { StadiumSize } from '../render/stadium';
import { Match } from '../sim/match';
import { findTeam } from '../data/loader';
import { installDeterministicEnv } from '../tools/determinism';
import { HUD } from './hud';
import { CONTROLS_KEY } from './prefs';

/** Which graphic the shot is of. */
export type TvGraphic = 'bug' | 'goal' | 'lowerthird' | 'card' | 'replay' | 'lineups' | 'stats';

export interface TvShot {
  name: string;
  note: string;
  graphic: TvGraphic;
  seed: number;
  home: string;
  away: string;
  /** sim ticks before the graphic is driven */
  frames: number;
  timeOfDay: TimeOfDay;
  stadium: StadiumSize;
  cam: { pos: [number, number, number]; look: [number, number, number]; fov?: number };
}

/** Broadcast-height side-on. Frames cleanly at both 16:9 sizes the package is
 *  judged at, which a taller/further pose does not. */
const TELE: TvShot['cam'] = { pos: [-4, 20, 40], look: [-6, 1.2, 0], fov: 36 };
/** Same rig at night in the big bowl: the package over a bright, busy frame. */
const NIGHT_WIDE: TvShot['cam'] = TELE;

export const TV_SHOTS: TvShot[] = [
  {
    name: 'bug_and_scorers',
    note: 'Score bug + goal-scorer strip over open play. Seed 22343 has scored by frame 1760, so the strip and the 1-0 are real sim state, not typed in. (The ticker is on a wall-clock timer the harness cannot freeze — see the lower_third shots for it.)',
    graphic: 'bug', seed: 22343, home: 'cze', away: 'ger', frames: 1790,
    timeOfDay: 'night', stadium: 'mega', cam: NIGHT_WIDE,
  },
  {
    name: 'goal_banner',
    note: "The goal lower third, driven by the sim's own 'goal' event 54 ticks after it fired.",
    graphic: 'goal', seed: 22343, home: 'cze', away: 'ger', frames: 1760,
    timeOfDay: 'night', stadium: 'mega', cam: NIGHT_WIDE,
  },
  {
    name: 'lower_third_corner',
    note: 'The routine set-piece name plate (CORNER) — the lowest tier of the priority queue.',
    graphic: 'lowerthird', seed: 12648430, home: 'cze', away: 'ger', frames: 600,
    timeOfDay: 'day', stadium: 'national', cam: TELE,
  },
  {
    name: 'lower_third_card',
    note: 'The card variant: the colour block carries a printed card instead of a word.',
    graphic: 'card', seed: 12648430, home: 'cze', away: 'ger', frames: 600,
    timeOfDay: 'day', stadium: 'national', cam: TELE,
  },
  {
    name: 'replay_package',
    note: 'Letterbox + REPLAY corner bug + the wipe parked a third of the way across.',
    graphic: 'replay', seed: 8230, home: 'cze', away: 'ger', frames: 986,
    timeOfDay: 'day', stadium: 'national',
    cam: { pos: [-63, 6, 1], look: [-44, 1.5, 3.6], fov: 36 },
  },
  {
    name: 'lineups',
    note: 'The pre-match starting XI graphic over the kickoff shape.',
    graphic: 'lineups', seed: 12648430, home: 'cze', away: 'ger', frames: 40,
    timeOfDay: 'night', stadium: 'mega', cam: NIGHT_WIDE,
  },
  {
    name: 'stats_card',
    note: 'The FULL TIME stats card. 9000 ticks of real match first, so possession, shots, corners, fouls and cards are all sim output. The bug still reads 1ST because the harness stops the sim rather than blowing the whistle.',
    graphic: 'stats', seed: 22343, home: 'cze', away: 'ger', frames: 9000,
    timeOfDay: 'night', stadium: 'mega', cam: NIGHT_WIDE,
  },
];

/** Renderer frames fed at the end of the run; earlier ticks are sim-only. */
const VISUAL_TAIL = 24;

/** A screenPos stub: UI shots never want live nameplates over a frozen still. */
const OFFSCREEN = (): { x: number; y: number; visible: boolean } =>
  ({ x: 0, y: 0, visible: false });

export async function runBroadcastShot(canvas: HTMLCanvasElement, shotName: string): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  w.__ss26CaptureShots = TV_SHOTS.map((s) => s.name);

  const shot = TV_SHOTS.find((s) => s.name === shotName);
  if (!shot) {
    w.__ss26Capture = { ready: true, error: `unknown broadcast shot "${shotName}"` };
    return;
  }

  try {
    const env = installDeterministicEnv(shot.seed);
    forceQuality('high');
    // the controls cheat-sheet is a gameplay affordance, not television: it
    // would sit across the bottom of every one of these PNGs
    try { localStorage.setItem(CONTROLS_KEY, 'off'); } catch { /* private mode */ }

    const match = new Match({
      home: findTeam(shot.home),
      away: findTeam(shot.away),
      seats: [null, null],
      halfLengthSec: 600,
      difficulty: 'pro',
      knockout: false,
      mode: 'match',
      seed: shot.seed,
    });
    const renderer = new GameRenderer(canvas, match, shot.timeOfDay, shot.stadium);
    const hud = new HUD(match);
    match.events.on((e) => {
      renderer.onEvent(e);
      hud.onEvent(e);
    });

    // Only the last stretch is fed to the renderer: a UI shot needs a plausible
    // frame behind it, not a frame-accurate one, and stepping 9000 ticks of
    // limb damping under software rasterization costs minutes we don't owe.
    const tail = Math.max(0, shot.frames - VISUAL_TAIL);
    for (let i = 0; i < shot.frames; i++) {
      match.update();
      if (match.phase === 'break') match.continueFromBreak();
      if (i >= tail) {
        renderer.snapshot();
        renderer.advanceNoDraw(1 / 60, 1);
      }
      env.advanceClock((1 / 60) * 1000);
    }

    driveGraphic(hud, match, shot.graphic);
    // two ticks so the bug's clock string and the band's layout are painted;
    // dt is tiny so nothing on a hold timer expires
    hud.update(1 / 60, OFFSCREEN);
    hud.update(1 / 60, OFFSCREEN);
    hud.bc.freezeForCapture(shot.graphic === 'replay' ? 0.21 : -1);

    renderer.renderStill(shot.cam);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        renderer.renderStill(shot.cam);
        let idle = 4;
        const tick = (): void => {
          if (--idle <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });

    w.__ss26 = { match, renderer, hud };
    w.__ss26Capture = {
      ready: true,
      shot: shot.name,
      stats: {
        score: `${match.teams[0].score}-${match.teams[1].score}`,
        shots: `${match.teams[0].shots}/${match.teams[1].shots}`,
        minute: match.displayMinute(),
      },
    };
  } catch (err) {
    console.error('broadcast capture failed:', err);
    w.__ss26Capture = { ready: true, error: String(err) };
  }
}

/** Put one graphic of the package on screen, through the real code paths. */
function driveGraphic(hud: HUD, match: Match, graphic: TvGraphic): void {
  const minute = match.displayMinute();
  // real names off the real roster: a broadcast plate reading "PLAYER ONE"
  // proves nothing about how the graphic handles the names it will carry
  const outfield = (teamIdx: number, n: number) =>
    match.teams[teamIdx].players.filter((p) => !p.isGK)[n].data;
  // the line-up hold only expires inside HUD.update, which a capture barely
  // ticks — so every other shot dismisses it explicitly
  if (graphic !== 'lineups') hud.hideLineups();

  switch (graphic) {
    case 'bug':
      // this shot is about the bug, the scorer strip and the ticker: the goal
      // band from the sim's own goal would sit on top of all three
      hud.bc.clearBands();
      hud.pushTicker(`${minute}' — ${outfield(1, 3).name.split(' ').pop()} drives at the back four.`);
      break;
    case 'goal':
      // the sim's own goal event (frame 1706 of seed 22343) already drove the
      // band; nothing to do but let it stand
      break;
    case 'lowerthird':
      hud.onEvent({ type: 'corner', teamIdx: 0, minute });
      break;
    case 'card':
      hud.onEvent({
        type: 'card', color: 'yellow', teamIdx: 1,
        playerName: outfield(1, 2).name, minute,
      });
      break;
    case 'replay':
      hud.setReplay(true, 'REPLAY · ANGLE 2');
      break;
    case 'lineups':
      hud.showLineups(0);
      break;
    case 'stats':
      hud.onEvent({ type: 'fulltime' });
      break;
    default:
      break;
  }
}
