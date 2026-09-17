// The scripted scenes (§7 presentation): walkout, goal celebration, walk-off.
//
// Each builder takes the match as it stands and returns a Cutscene — a set of
// actor queues plus, where the scene owns it, a camera track. Nothing in here
// reads or writes sim state beyond taking a snapshot of where everybody is at
// the moment the scene opens: a scene is a PERFORMANCE of a sim state, never a
// change to one.
//
// All positions are sim coordinates: x along the pitch length (±52.5), y across
// the width (±34), with the broadcast camera and the near touchline at +y.
// Camera keys are scene coordinates (x, height, z = sim y).

import { CELEBRATE_CHAIN, TRUDGE_CHAIN, WALKOUT_CHAIN } from '../render/characterAssets';
import { HALF_L, HALF_W } from '../sim/constants';
import { clamp } from '../core/math';
import { RNG } from '../core/rng';
import type { Match } from '../sim/match';
import type { PlayerEntity } from '../sim/player';
import { Actor, Cutscene, type CamKey } from './cutscene';
import { TUNNEL_MOUTH } from '../render/stadium';

/** The tunnel mouth: far touchline, on the halfway line, just off the grass.
 *  The stand's front boards sit at |y| = 37, so this is the gap between. */
export const TUNNEL = { x: TUNNEL_MOUTH.x, y: -35.4 };
/** The recess itself (sim coords): where a walk-off disappears into. */
const TUNNEL_INSIDE = { x: TUNNEL_MOUTH.x, y: TUNNEL_MOUTH.z };

/** Where the two lineups stand, and how they are spaced. */
const LINE_Y = -22;
const LINE_SPACING = 1.95;
/** Half the gap left in the middle of the line, between the two teams. */
const LINE_GAP = 5.0;

/**
 * Scene clock marks for the walkout.
 *
 * WALK_SPEED is picked against what the clips are actually WORTH, measured at
 * load: the strut is 0.94 m/s and the plain walk about 1.4. At 1.45 the chain
 * sits between the two, which is a walkout pace — brisk enough that the line
 * fills in twelve seconds, slow enough that the strut is most of what you see.
 * Push it to 1.7 and the blend moves onto walk/jog and the swagger disappears.
 */
const WALK_SPEED = 1.45;
/** When the line breaks for the kickoff marks — just after the dolly lands. */
const BREAK_T = 18.8;
const JOG_SPEED = 5.8;

/** The lineup idles, handed out round-robin. Three clips × a random phase ×
 *  a random rate is enough that no two men in a line of eleven match. */
const LINEUP_IDLES = ['standA', 'standB', 'standC'];
/** What a scorer might do. Four, picked from the goal's own seed. */
const SCORER_CELEBS = ['celebrate', 'celebB', 'celebC', 'celebD'];
/** What the men who run over to him do. */
const MOB_CELEBS = ['jumpCheer', 'cheer', 'clap'];

const onPitch = (x: number, y: number): { x: number; y: number } => ({
  x: clamp(x, -HALF_L + 2, HALF_L - 2),
  y: clamp(y, -HALF_W + 2, HALF_W - 2),
});

/** One actor per player, seeded where the sim has him standing right now. */
function seedActors(match: Match): Actor[] {
  return match.allPlayers.map((p, i) => new Actor(i, p.pos.x, p.pos.y, p.facing));
}

/** A stable seed for a scene, so the same match replays the same show. */
function sceneSeed(match: Match, salt: number): RNG {
  const s = (match.opts.seed ?? 0) ^ Math.imul(salt | 0, 0x9e3779b1);
  return new RNG(s >>> 0);
}

// ---------------------------------------------------------------- 1. walkout

/**
 * PRE-MATCH WALKOUT.
 *
 * The two teams are waiting beside the tunnel mouth on the far touchline, in
 * two files running away from it. They walk out (staggered, outermost man
 * first, so the line fills from the ends inward and everybody arrives at once),
 * turn square to the near touchline, and hold — each on his own idle, at his
 * own phase, swapping to a second one at his own moment, because a line of
 * eleven men doing the same thing on the same frame is the tell.
 *
 * The camera opens low by the tunnel, drifts back and up as the line forms,
 * CUTS to the head of the home line and dollies the whole length of both
 * lineups, then cranes away as the teams break for their kickoff marks — which
 * are the sim's own kickoff positions, so the handoff is a stop, not a
 * teleport.
 */
export function buildWalkout(match: Match): Cutscene {
  const rng = sceneSeed(match, 1);
  const actors = seedActors(match);
  const all = match.allPlayers;

  for (let t = 0; t < 2; t++) {
    const side = t === 0 ? -1 : 1;
    const squad = match.teams[t].players;
    // the keeper leads his team out, which is both traditional and useful:
    // he ends up at the outer end of the line, furthest from the centre
    const order = [...squad].sort((a, b) => Number(b.isGK) - Number(a.isGK));
    for (let k = 0; k < order.length; k++) {
      const p = order[k];
      const i = all.indexOf(p);
      const a = actors[i];
      if (!a || p.sentOff) continue;

      // Waiting beside the tunnel, two files running away from its mouth, one
      // per team. The file is ordered so that the man with the OUTERMOST mark
      // is stood furthest out already: everybody then walks roughly straight
      // onto the pitch and the whole line lands inside a second of itself.
      // (Ordered the other way — which is the obvious way to write it — the
      // keeper crosses the entire line to reach his mark and arrives six
      // seconds after everyone else, a third of the way into the camera's
      // dolly along a line that is not finished yet.)
      const out = order.length - 1 - k;
      a.x = side * (1.1 + out * 1.3);
      a.y = TUNNEL.y + 0.2 - (k % 2) * 0.55;
      a.facing = Math.PI / 2;

      // his mark in the line: k = 0 (the keeper) at the outer end
      const markX = side * (LINE_GAP + out * LINE_SPACING);
      // outermost man leaves first — he still has the furthest to walk
      const delay = k * 0.18;
      const idle = LINEUP_IDLES[(i + k) % LINEUP_IDLES.length];
      const second = LINEUP_IDLES[(i + k + 1 + Math.floor(rng.next() * 2)) % LINEUP_IDLES.length];

      a.chain(WALKOUT_CHAIN)
        .play(null)
        .wait(delay)
        // a little jitter on the pace: the stagger above is tuned so the line
        // fills in one go, and without it all eleven land within half a second
        // of each other, which looks choreographed in the wrong way
        .moveTo(markX, LINE_Y, WALK_SPEED * rng.range(0.9, 1.1), { stop: 0.1 })
        .faceTo(Math.PI / 2)
        .play(idle, { fade: 0.4, phase: rng.next(), rate: rng.range(0.85, 1.15) })
        .until(13.2 + rng.range(0, 3.8))
        // the fidget: a second idle, at nobody else's moment
        .play(second, { fade: 0.45, phase: rng.next(), rate: rng.range(0.85, 1.12) })
        .until(BREAK_T + rng.range(0, 0.7))
        // ...and away: back on the sim's own chain for the jog out, to the
        // exact spot the sim is holding him at
        .play(null, { fade: 0.35 })
        .chain(null)
        .moveTo(p.pos.x, p.pos.y, JOG_SPEED, { stop: 0.25 })
        .faceTo(p.facing);
    }
  }

  const cam: CamKey[] = [
    // low by the tunnel mouth, looking along the touchline at the two files
    { t: 0, pos: [11, 2.4, -26], look: [0.5, 1.5, -34.5], fov: 38 },
    { t: 6.0, pos: [18, 4.6, -17], look: [-2, 1.3, -29], fov: 38 },
    { t: 11.0, pos: [25, 10, -6], look: [-1, 1.2, -24], fov: 40 },
    // CUT to the head of the home line, pitch level — after the last man is
    // on his mark (~12.2s; see the stagger above), never before
    { t: 12.8, pos: [-27, 2.7, -13], look: [-24, 1.5, -22], fov: 34, cut: true },
    // ...and dolly the full length of both lineups at a constant rate. A
    // smoothstep here would ease in and out of a move that should not stop.
    { t: 18.6, pos: [27, 2.7, -13], look: [24, 1.5, -22], fov: 34, ease: 'linear' },
    { t: 20.0, pos: [30, 8, -4], look: [10, 1.2, -19], fov: 36 },
    { t: 23.7, pos: [8, 20, 20], look: [0, 0.9, -8], fov: 36 },
    // land on the broadcast pose so the camera director inherits a frame it
    // would have chosen itself
    { t: 28.5, pos: [0, 24, 40], look: [0, 0.7, -1], fov: 36 },
  ];

  return new Cutscene('walkout', actors, cam, {
    endsWhenIdle: true, minDuration: BREAK_T + 1, maxDuration: 34,
  });
}

// ------------------------------------------------------------ 2. celebration

/** Who scored, from the goal the sim has just logged. Own goals have no
 *  celebrant on the scoring team, so the nearest man to the goal takes it —
 *  the same rule the sim itself uses to pick who plays the celebrate anim. */
function findScorer(match: Match): { scorer: PlayerEntity; teamIdx: number } | null {
  const goal = match.goalLog[match.goalLog.length - 1];
  if (!goal) return null;
  const team = match.teams[goal.teamIdx];
  const pool = team.players.filter((p) => !p.sentOff && !p.isGK);
  if (!pool.length) return null;
  const named = !goal.ownGoal && pool.find((p) => p.data.name === goal.scorerName);
  if (named) return { scorer: named, teamIdx: goal.teamIdx };
  const gx = HALF_L * team.attackDir;
  const near = pool.reduce((a, b) => (
    Math.hypot(a.pos.x - gx, a.pos.y) < Math.hypot(b.pos.x - gx, b.pos.y) ? a : b));
  return { scorer: near, teamIdx: goal.teamIdx };
}

/**
 * GOAL CELEBRATION, played under the 'goalseq' phase.
 *
 * The scorer peels away to the corner flag at the end he has just scored at —
 * on the near touchline where the camera lives, unless he is already deep on
 * the far side — and does one of four things, picked from the goal's seed. The
 * three nearest team-mates chase him down and cluster around him at arm's
 * length; the rest jog up and stop short, applauding. The beaten keeper is left
 * where he is, head down. The rest of the losing side turns and trudges back
 * toward their own half.
 *
 * NO CAMERA TRACK. The camera director's celebration orbit already owns this
 * moment and follows `cam.subject`, which the director keeps pinned to the
 * scorer's live position — see Presentation.
 */
export function buildCelebration(match: Match): Cutscene | null {
  const found = findScorer(match);
  if (!found) return null;
  const { scorer, teamIdx } = found;
  const all = match.allPlayers;
  const actors = seedActors(match);
  const rng = sceneSeed(match, 100 + match.goalLog.length);

  const attack = match.teams[teamIdx].attackDir;
  // the corner at the end just scored at; the near touchline unless he is
  // already deep on the far side, because a celebration with its back to the
  // main camera is a celebration nobody sees
  const cornerY = scorer.pos.y < -12 ? -(HALF_W - 6) : HALF_W - 6;
  const corner = onPitch(attack * (HALF_L - 7.5), cornerY);
  const toCrowd = cornerY > 0 ? Math.PI / 2 : -Math.PI / 2;

  const scorerIdx = all.indexOf(scorer);
  const sa = actors[scorerIdx];
  // He runs, he does not jog: the camera director gives the celebration rig
  // 2.3s–5.0s of the goal package and the whole run has to fit inside that
  // window or the arrival happens off-camera, during the crowd cutaway.
  sa.chain(CELEBRATE_CHAIN)
    .play(null)
    .moveTo(corner.x, corner.y, 7.2, { stop: 0.5 })
    .faceTo(toCrowd)
    .chain(null)
    .play(SCORER_CELEBS[Math.floor(rng.next() * SCORER_CELEBS.length)],
      { fade: 0.3, phase: rng.next(), rate: rng.range(0.95, 1.1) });

  // the mob: the three nearest team-mates, clustered around where he will end
  // up rather than where he is now — they are chasing him, not meeting him
  const mates = match.teams[teamIdx].players
    .filter((p) => p !== scorer && !p.sentOff && !p.isGK)
    .sort((a, b) => Math.hypot(a.pos.x - scorer.pos.x, a.pos.y - scorer.pos.y)
      - Math.hypot(b.pos.x - scorer.pos.x, b.pos.y - scorer.pos.y));
  // the arc they fan across: centred on the line back toward the middle of the
  // pitch, so nobody is asked to stand in the advertising hoardings
  const base = Math.atan2(-corner.y, -corner.x * 0.2);
  for (let i = 0; i < Math.min(3, mates.length); i++) {
    const p = mates[i];
    const a = actors[all.indexOf(p)];
    const th = base + (i - 1) * 0.72;
    const spot = onPitch(corner.x + Math.cos(th) * 2.2, corner.y + Math.sin(th) * 2.2);
    a.chain(CELEBRATE_CHAIN)
      .play(null)
      .wait(0.25 + i * 0.3)
      .moveTo(spot.x, spot.y, 6.8, { stop: 0.35 })
      .faceTo(Math.atan2(corner.y - spot.y, corner.x - spot.x))
      .chain(null)
      .play(MOB_CELEBS[(i + Math.floor(rng.next() * 3)) % MOB_CELEBS.length],
        { fade: 0.32, phase: rng.next(), rate: rng.range(0.9, 1.1) });
  }

  // everyone else on the scoring side drifts up and applauds from a distance
  for (const p of mates.slice(3)) {
    const a = actors[all.indexOf(p)];
    const dx = corner.x - p.pos.x;
    const dy = corner.y - p.pos.y;
    const d = Math.max(Math.hypot(dx, dy), 1e-3);
    const keep = Math.max(d - 9, 0);
    const spot = onPitch(p.pos.x + (dx / d) * keep, p.pos.y + (dy / d) * keep);
    a.chain(CELEBRATE_CHAIN)
      .play(null)
      .wait(rng.range(0.3, 1.1))
      .moveTo(spot.x, spot.y, 4.3, { stop: 0.6 })
      .faceTo(Math.atan2(corner.y - spot.y, corner.x - spot.x))
      .chain(null)
      .play('clap', { fade: 0.35, phase: rng.next(), rate: rng.range(0.9, 1.1) });
  }
  // the scoring keeper is eighty metres away: he applauds where he stands
  {
    const gk = match.teams[teamIdx].keeper;
    const a = actors[all.indexOf(gk)];
    a.play('cheer', { fade: 0.4, phase: rng.next() });
  }

  // --- the beaten side
  const lost = match.teams[1 - teamIdx];
  const beaten = lost.keeper;
  {
    const a = actors[all.indexOf(beaten)];
    // turned back up the pitch, not into his own net: a keeper looking at the
    // ball in the goal behind him is a keeper with his back to every camera
    a.faceTo(Math.atan2(-beaten.pos.y, -beaten.pos.x))
      .play('dejected', { fade: 0.4, phase: rng.next() })
      .wait(3.2 + rng.range(0, 1.5))
      .play('frustrated', { fade: 0.45, phase: rng.next() });
  }
  for (const p of lost.players) {
    if (p === beaten || p.sentOff) continue;
    const a = actors[all.indexOf(p)];
    // Back toward the HALFWAY LINE, not toward their own goal. The obvious
    // reading of "trudge back to your own half" is wrong the moment you look
    // at a capture: they have just conceded AT their own goal, so they are
    // already in their half, and sending them further that way walks the whole
    // defence into its own net. What actually happens is that everybody heads
    // for the restart.
    const dir = Math.sign(-p.pos.x) || 1;
    const spot = onPitch(p.pos.x + dir * rng.range(8, 14), p.pos.y + rng.range(-3, 3));
    a.chain(TRUDGE_CHAIN)
      .play(null)
      .wait(rng.range(0.2, 1.0))
      .moveTo(spot.x, spot.y, 1.15, { stop: 0.4 })
      .play(rng.next() < 0.5 ? 'sadIdle' : 'dejected',
        { fade: 0.4, phase: rng.next(), rate: rng.range(0.9, 1.05) });
  }

  // no camera keys: the celebration orbit owns the lens (see the docstring)
  const scene = new Cutscene('celebration', actors, [], { maxDuration: 14 });
  scene.subject = sa;
  return scene;
}

// ------------------------------------------------------------ 3. off the pitch

export type WalkoffKind = 'break' | 'fulltime';

/**
 * HALF TIME and FULL TIME: the players leave.
 *
 * At the interval it is a walk — nobody performs, they just head for the
 * tunnel, the side that is behind noticeably slower than the side in front.
 * At full time the winners turn to the crowd and applaud for a few seconds
 * before they go, the losers trudge straight off, and a draw has everybody
 * applauding. The HUD's stats card sits over the top of all of it.
 *
 * The scene runs for as long as the card is up; it never has to complete.
 */
export function buildWalkoff(match: Match, kind: WalkoffKind,
  opts: { camera?: boolean } = {}): Cutscene {
  const rng = sceneSeed(match, kind === 'fulltime' ? 7 : 5);
  const actors = seedActors(match);
  const all = match.allPlayers;
  const score: [number, number] = [match.teams[0].score, match.teams[1].score];
  const draw = score[0] === score[1];

  // Absolute scene time the applause ends. It has to leave room for the turn
  // that precedes it: squaring up to the near stand from a heading pointing up
  // the pitch is a damped 180° and costs a second and a half on its own.
  const CELEB_T = kind === 'fulltime' ? (draw ? 3.6 : 5.0) : 0;

  let lane = 0;
  for (let t = 0; t < 2; t++) {
    // at full time a side is celebrating, trudging or applauding a draw; at
    // half time nobody performs, but the side in front still walks taller
    const won = !draw && score[t] > score[1 - t];
    const celebrate = kind === 'fulltime' && (won || draw);
    const heavy = kind === 'fulltime' ? !won && !draw : score[t] < score[1 - t];

    for (const p of match.teams[t].players) {
      if (p.sentOff) continue;
      const a = actors[all.indexOf(p)];
      const ln = (lane++ - 10.5) * 0.95;

      a.wait(rng.range(0, 0.6));
      if (celebrate) {
        a.chain(CELEBRATE_CHAIN)
          .play(null)
          .faceTo(Math.PI / 2)                       // square to the near stand
          .play(won && rng.next() < 0.45 ? 'victoryIdle' : 'clap',
            { fade: 0.4, phase: rng.next(), rate: rng.range(0.9, 1.1) })
          .until(CELEB_T + rng.range(0, 1.2))
          .play(null, { fade: 0.4 });
      } else if (heavy) {
        a.chain(TRUDGE_CHAIN)
          .play('dejected', { fade: 0.4, phase: rng.next(), hold: 1.2 + rng.range(0, 0.9) })
          .play(null, { fade: 0.4 });
      } else {
        a.chain(TRUDGE_CHAIN).play(null, { fade: 0.35 });
      }

      // off: out to the halfway line first, then converge on the tunnel mouth
      const speed = heavy ? 1.15 : celebrate ? 1.75 : 1.5;
      a.moveTo(ln * 1.6, -24, speed, { stop: 0.6 })
        .moveTo(TUNNEL.x + ln * 0.35, TUNNEL.y, speed, { stop: 0.4 })
        .moveTo(TUNNEL_INSIDE.x + ln * 0.35, TUNNEL_INSIDE.y + 1.5, speed, { stop: 0.4 })
        .faceTo(-Math.PI / 2);
    }
  }

  // NO CAMERA, normally. The camera director already cuts to its stadium
  // beauty crane for both cards (pickLiveCamera), and two rigs arguing over
  // one lens is worse than either of them alone. The track below is the
  // fallback for a build whose director does not do that — and the one the
  // capture harness turns on to photograph the choreography close enough to
  // judge it.
  const cam: CamKey[] = opts.camera ? [
    { t: 0, pos: [18, 4.5, 16], look: [0, 1.2, -4], fov: 34 },
    { t: 6, pos: [30, 11, 30], look: [4, 1.0, -14], fov: 36 },
    { t: 15, pos: [46, 24, 52], look: [6, 1.0, -18], fov: 36, ease: 'linear' },
  ] : [];

  return new Cutscene(kind === 'fulltime' ? 'fulltime' : 'halftime', actors, cam,
    { maxDuration: 90 });
}
