// Pass assist, through balls, crosses, shot model (§5 control feel rules).
// Human control and CPU AI both call these — feel is tuned in exactly one place.

import { angleDiff, angleOf, clamp, dist2, distToSegment, norm2, sub2, type V2 } from '../core/math';
import { effectiveRating } from '../data/loader';
import { GOAL_HALF_W, GOAL_HEIGHT, HALF_L, HALF_W } from './constants';
import type { PlayerEntity } from './player';
import type { Match } from './match';

export interface PassOption {
  player: PlayerEntity;
  score: number;
  aim: V2;       // where to send the ball (leads the receiver)
  openness: number;
  /** Ball speed the aim point was solved for — the kick must use it. */
  speed: number;
  /** Seconds of flight at that speed. */
  flight: number;
}

/**
 * How clear a pass lane is of BODIES — both teams'.
 *
 * `laneOpenness` above asks a tactical question (is there an opponent in a
 * position to intercept?) with a generous 3.2m corridor. This asks the
 * physical one now that bodies are solid: will the ball actually hit somebody
 * on the way? The corridor is the real contact width plus a margin, and own
 * team-mates count too — the old code happily drilled passes through its own
 * midfielders' shins, which is where a startling share of "my pass went
 * nowhere" came from.
 */
export function passLaneClear(
  match: Match, from: V2, to: V2, teamIdx: number,
  passer: PlayerEntity, receiver: PlayerEntity,
): number {
  const CORRIDOR = 0.95;
  let worst = 1;
  const passLen = dist2(from, to);
  for (const p of [...match.teams[0].players, ...match.teams[1].players]) {
    if (p.sentOff || p === passer || p === receiver) continue;
    const along = dist2(p.pos, from);
    if (along > passLen + 1 || along < 1.2) continue;   // behind, or right on top of the passer
    const d = distToSegment(p.pos, from, to);
    if (d > CORRIDOR * 2) continue;
    const weight = p.teamIdx === teamIdx ? 0.55 : 1;    // a team-mate can step over it
    const block = clamp(1 - d / (CORRIDOR * 2), 0, 1) * weight;
    worst = Math.min(worst, 1 - block);
  }
  return worst;
}

/**
 * The ball is aimed at the receiver's FRONT foot, not his centre: this many
 * metres back down the pass line from the solved interception point.
 *
 * This is the whole fix for "my pass goes off the back of the man I aimed at".
 * The old code leaded the receiver by 0.7× of the interception solve, which is
 * systematically SHORT — for a team-mate running away from you the ball is
 * then always delivered behind him, clipping his heels. Solving the meeting
 * point properly and then stepping the aim point back toward the passer puts
 * the ball where a footballer actually wants it: arriving in front of him,
 * running onto his laces.
 */
const RECEIVE_OFFSET = 0.6;

/**
 * Solve where the ball and the receiver meet. Two fixed-point iterations are
 * plenty: the flight time barely moves after the first correction, and a fixed
 * count keeps the sim deterministic (§8).
 */
function solveReceivePoint(
  from: V2, mate: PlayerEntity, leadMult: number, boost: number,
): { aim: V2; speed: number; flight: number } {
  let aim: V2 = { x: mate.pos.x, y: mate.pos.y };
  for (let i = 0; i < 3; i++) {
    const d = dist2(from, aim);
    const flight = d / passSpeedFor(d, boost);
    aim = {
      x: mate.pos.x + mate.vel.x * flight * leadMult,
      y: mate.pos.y + mate.vel.y * flight * leadMult,
    };
  }
  const back = norm2(sub2(from, aim));
  aim = { x: aim.x + back.x * RECEIVE_OFFSET, y: aim.y + back.y * RECEIVE_OFFSET };
  const d = dist2(from, aim);
  const speed = passSpeedFor(d, boost);
  return { aim, speed, flight: d / speed };
}

/** How fast the receiver is opening the gap: + = running away from the ball. */
function openingRate(from: V2, mate: PlayerEntity): number {
  const away = norm2(sub2(mate.pos, from));
  return mate.vel.x * away.x + mate.vel.y * away.y;
}

/** Can this man take the ball where he is, facing the way he is? 0..1. */
function receivability(from: V2, mate: PlayerEntity, aim: V2): number {
  const toPasser = norm2(sub2(from, mate.pos));
  const face = { x: Math.cos(mate.facing), y: Math.sin(mate.facing) };
  const open = face.x * toPasser.x + face.y * toPasser.y;   // 1 = facing the ball
  // how far he has to swivel to play the ball on arrival
  const toAim = norm2(sub2(aim, mate.pos));
  const turn = Math.abs(angleDiff(mate.facing, angleOf(toAim)));
  const turnCost = clamp(1 - turn / Math.PI, 0, 1);
  return clamp(0.35 + 0.4 * (open * 0.5 + 0.5) + 0.25 * turnCost, 0, 1);
}

/** Distance from the arrival point to the nearest opponent (metres). */
function spaceAt(match: Match, aim: V2, teamIdx: number): number {
  let nd = 99;
  for (const opp of match.teams[1 - teamIdx].players) {
    if (opp.sentOff) continue;
    const d = dist2(opp.pos, aim);
    if (d < nd) nd = d;
  }
  return nd;
}

/** How far inside the touchlines an aim point sits (negative = out of play). */
function insideMargin(aim: V2): number {
  return Math.min(HALF_W - Math.abs(aim.y), HALF_L - Math.abs(aim.x));
}

/** How clear the lane from a to b is of opponents (1 = fully open). */
export function laneOpenness(match: Match, from: V2, to: V2, teamIdx: number): number {
  let worst = 1;
  const passLen = dist2(from, to);
  for (const opp of match.teams[1 - teamIdx].players) {
    if (opp.sentOff) continue;
    const alongDist = dist2(opp.pos, from);
    if (alongDist > passLen + 2) continue;
    const d = distToSegment(opp.pos, from, to);
    // opponents right next to the passer matter less (ball passes them fast)
    const gate = clamp(alongDist / 4, 0.25, 1);
    const block = clamp(1 - d / 3.2, 0, 1) * gate;
    worst = Math.min(worst, 1 - block);
  }
  return worst;
}

/**
 * Pass assist (§5): snap to the best team-mate near the aim direction.
 *
 * Scored on cone deviation, lane openness, distance, and three things the old
 * version ignored and which together caused "the ball goes off his back":
 * whether the arrival point is actually in play, how much space he has when it
 * lands, and whether his body is in any state to receive it.
 */
export function bestPassTarget(
  match: Match,
  passer: PlayerEntity,
  aimDir: V2,
  opts: {
    maxDist?: number; preferForward?: boolean; lead?: number;
    /** 0..1 button-hold power: scales how far the pass is willing to reach. */
    power?: number;
    /** widen the accepted cone (set-piece takers can look right around). */
    cone?: number;
  } = {},
): PassOption | null {
  const team = match.teams[passer.teamIdx];
  const power = opts.power ?? 1;
  const maxDist = (opts.maxDist ?? 38) * clamp(0.35 + power * 0.75, 0.35, 1.1);
  const leadMult = opts.lead ?? 1;
  const cone = opts.cone ?? Math.PI * 0.6;
  let best: PassOption | null = null;
  const aimAngle = angleOf(aimDir);

  for (const mate of team.players) {
    if (mate === passer || mate.sentOff) continue;
    // the keeper is an outlet backwards, never a forward option
    if (mate.isGK && (mate.pos.x - passer.pos.x) * team.attackDir > -4) continue;
    const d0 = dist2(passer.pos, mate.pos);
    if (d0 < 2.5 || d0 > maxDist) continue;

    // a man sprinting away needs the ball hit harder or it never catches him
    const boost = 1 + clamp(openingRate(passer.pos, mate) / 9, 0, 0.5);
    const { aim, speed, flight } = solveReceivePoint(passer.pos, mate, leadMult, boost);

    const dev = Math.abs(angleDiff(aimAngle, angleOf(sub2(aim, passer.pos))));
    if (dev > cone) continue;            // never pass backwards of the stick

    const margin = insideMargin(aim);
    if (margin < 0.5) continue;          // solved arrival is off the pitch

    const open = laneOpenness(match, passer.pos, aim, passer.teamIdx);
    const clear = passLaneClear(match, passer.pos, aim, passer.teamIdx, passer, mate);
    if (clear < 0.25) continue;            // there is a man's legs in the way
    const space = spaceAt(match, aim, passer.teamIdx);
    const canTake = receivability(passer.pos, mate, aim);

    let score = 0;
    score += (1 - dev / cone) * 3.0;
    if (dev < Math.PI / 6) score += 2.0;                       // inside the 30° cone
    const distPref = d0 < 8 ? d0 / 8 : clamp(1 - (d0 - 22) / 30, 0.3, 1);
    score += distPref * 1.2;
    score += open * 2.0;
    score += clear * 3.0;                                      // and nothing to hit
    score += clamp(space / 6, 0, 1) * 1.6;                     // don't feed a marked man
    score += canTake * 1.4;                                    // he can actually take it
    score += clamp(margin / 6, 0, 1) * 0.8;                    // keep it off the touchline
    score -= clamp((flight - 1.4) / 1.5, 0, 1) * 1.0;          // long hangs get cut out
    if (opts.preferForward) {
      score += ((aim.x - passer.pos.x) * team.attackDir > 2 ? 1.0 : 0);
    }
    if (!best || score > best.score) best = { player: mate, score, aim, openness: open, speed, flight };
  }
  return best;
}

function passSpeedFor(dist: number, boost = 1): number {
  return clamp((10 + dist * 0.55) * boost, 11, 28);
}

/**
 * Ground pass. `assist` 0..1 blends between where the stick pointed (0) and
 * the solved receive point (1) — §6.6 scales it by difficulty, so Legend makes
 * you aim and Amateur finds the man for you.
 */
export function executeShortPass(
  match: Match, passer: PlayerEntity, target: PassOption,
  opts: { assist?: number; aimDir?: V2 } = {},
): void {
  const assist = clamp(opts.assist ?? 1, 0, 1);
  let aim = target.aim;
  if (assist < 1 && opts.aimDir) {
    // the manual half of the pass goes exactly where the stick pointed, at the
    // range the assisted pass would have used
    const d = dist2(passer.pos, target.aim);
    const ray: V2 = { x: passer.pos.x + opts.aimDir.x * d, y: passer.pos.y + opts.aimDir.y * d };
    aim = { x: ray.x + (target.aim.x - ray.x) * assist, y: ray.y + (target.aim.y - ray.y) * assist };
  }
  const d = dist2(passer.pos, aim);
  // carry the "he's running away, hit it harder" boost the solve picked
  const boost = target.speed / passSpeedFor(dist2(passer.pos, target.aim));
  const speed = passSpeedFor(d, boost);
  const skill = effectiveRating(passer.data, 'passing');
  const err = (1 - skill / 99) * 0.09 + (1 - assist) * 0.05;
  const dir = norm2(sub2(aim, passer.pos));
  const a = angleOf(dir) + match.rng.noise() * err;
  match.ball.kick({ x: Math.cos(a), y: Math.sin(a), z: 0.02 }, speed, passer);
  match.registerPassAttempt(passer, target.player, aim);
  passer.playAnim('pass', 0.22);
  match.events.emit({ type: 'kick', power: speed / 26 });
}

/**
 * Throw-in (§6.4): two hands from the touchline. Short, gently lofted, and
 * never a 30-metre pass — which is why it gets its own function instead of
 * pretending to be a ground pass struck from outside the pitch.
 */
export function executeThrowIn(match: Match, thrower: PlayerEntity, aimDir: V2): void {
  const target = bestPassTarget(match, thrower, aimDir, { maxDist: 22, cone: Math.PI * 0.85 });
  const aim = target ? target.aim : {
    x: thrower.pos.x + aimDir.x * 12,
    y: thrower.pos.y + aimDir.y * 12 - Math.sign(thrower.pos.y) * 4,
  };
  const d = clamp(dist2(thrower.pos, aim), 4, 24);
  const a = angleOf(sub2(aim, thrower.pos)) + match.rng.noise() * 0.05;
  const speed = clamp(Math.sqrt(d * 12.5 / 0.85), 8, 19);
  match.ball.pos.z = 1.9;   // over the head, as the laws require
  match.ball.kick({ x: Math.cos(a) * 0.86, y: Math.sin(a) * 0.86, z: 0.5 }, speed, thrower);
  match.registerPassAttempt(thrower, target?.player ?? null, aim);
  thrower.playAnim('loft', 0.3);
  match.events.emit({ type: 'kick', power: 0.35 });
}

/** Lofted pass / cross (§5 K): pick a further target or drop into the box. */
export function executeLoft(match: Match, passer: PlayerEntity, aimDir: V2): void {
  const team = match.teams[passer.teamIdx];
  const inCrossZone =
    Math.abs(passer.pos.x) > HALF_L - 25 &&
    (passer.pos.x * team.attackDir > 0) &&
    Math.abs(passer.pos.y) > 12;

  let aim: V2;
  let intended: PlayerEntity | null = null;
  if (inCrossZone) {
    // cross toward the penalty spot area, aimed at the best runner if any
    const goalX = HALF_L * team.attackDir;
    const runners = team.players.filter(
      (p) => p !== passer && !p.sentOff && Math.abs(p.pos.x - goalX) < 24 && Math.abs(p.pos.y) < 16,
    );
    if (runners.length) {
      const r = runners.reduce((a, b) =>
        Math.abs(a.pos.x - goalX) < Math.abs(b.pos.x - goalX) ? a : b);
      // a cross hangs for about a second and a half — lead him for all of it
      aim = { x: r.pos.x + r.vel.x * 1.25, y: r.pos.y + r.vel.y * 1.25 };
      aim.y = clamp(aim.y, -HALF_W + 2, HALF_W - 2);
      intended = r;
    } else {
      aim = { x: goalX - 9 * team.attackDir, y: match.rng.range(-5, 5) };
    }
  } else {
    // a lofted ball hangs far longer than the ground-speed solve assumes, so
    // it needs a bigger lead or it lands behind the runner every time
    const target = bestPassTarget(match, passer, aimDir, { maxDist: 55, preferForward: true, lead: 1.6 });
    intended = target?.player ?? null;
    aim = target ? target.aim : {
      x: passer.pos.x + aimDir.x * 30,
      y: passer.pos.y + aimDir.y * 30,
    };
  }

  const d = dist2(passer.pos, aim);
  const skill = effectiveRating(passer.data, 'passing');
  const a = angleOf(sub2(aim, passer.pos)) + match.rng.noise() * (1 - skill / 99) * 0.12;
  // launch angle solves roughly for range at ~40° elevation
  const speed = clamp(Math.sqrt(d * 12.5 / 0.98), 13, 30);
  match.ball.kick(
    { x: Math.cos(a) * 0.78, y: Math.sin(a) * 0.78, z: 0.62 },
    speed, passer, match.rng.noise() * 1.2,
  );
  match.registerPassAttempt(passer, intended, aim);
  passer.playAnim('loft', 0.3);
  match.events.emit({ type: 'kick', power: speed / 30 });
}

/** Through ball (§5 I): thread into space ahead of the best runner. */
export function executeThrough(match: Match, passer: PlayerEntity, aimDir: V2): void {
  const team = match.teams[passer.teamIdx];
  let best: { p: PlayerEntity; score: number } | null = null;
  const aimAngle = angleOf(aimDir);
  for (const mate of team.players) {
    if (mate === passer || mate.isGK || mate.sentOff) continue;
    const advance = (mate.pos.x - passer.pos.x) * team.attackDir;
    if (advance < -5) continue;
    const dev = Math.abs(angleDiff(aimAngle, angleOf(sub2(mate.pos, passer.pos))));
    if (dev > Math.PI / 2.2) continue;
    let score = advance * 0.12 + (1 - dev / (Math.PI / 2.2)) * 2;
    score += (mate.vel.x * team.attackDir > 2 ? 1.5 : 0); // already running
    if (!best || score > best.score) best = { p: mate, score };
  }
  const receiver = best?.p;
  if (!receiver) {
    // no runner: just punt it up the line
    const a = angleOf(aimDir);
    match.ball.kick({ x: Math.cos(a), y: Math.sin(a), z: 0.03 }, 19, passer);
    match.registerPassAttempt(passer, null, null);
    passer.playAnim('pass', 0.22);
    match.events.emit({ type: 'kick', power: 0.7 });
    return;
  }
  // aim into space beyond the receiver, toward goal
  const leadDist = clamp(6 + receiver.maxSpeed() * 0.9, 6, 13);
  const aim: V2 = {
    x: receiver.pos.x + team.attackDir * leadDist,
    y: receiver.pos.y + receiver.vel.y * 0.8,
  };
  aim.x = clamp(aim.x, -HALF_L + 2, HALF_L - 2);
  const d = dist2(passer.pos, aim);
  const skill = effectiveRating(passer.data, 'passing');
  const a = angleOf(sub2(aim, passer.pos)) + match.rng.noise() * (1 - skill / 99) * 0.1;
  match.ball.kick({ x: Math.cos(a), y: Math.sin(a), z: 0.04 }, passSpeedFor(d) * 1.12, passer);
  match.registerPassAttempt(passer, receiver, aim);
  passer.playAnim('pass', 0.22);
  match.events.emit({ type: 'kick', power: 0.75 });
}

/**
 * Shot model (§5): hold-to-power, accuracy penalty at full power / off-balance /
 * distance / low shooting stat. aimY: -1..1 across the goal mouth from stick.
 */
export function executeShot(match: Match, shooter: PlayerEntity, aimY: number, power: number): void {
  const team = match.teams[shooter.teamIdx];
  const goalX = HALF_L * team.attackDir;
  const distToGoal = dist2(shooter.pos, { x: goalX, y: 0 });
  const skill = effectiveRating(shooter.data, 'shooting');
  const offBalance = clamp(Math.hypot(shooter.vel.x, shooter.vel.y) / shooter.maxSpeed(), 0, 1);

  // error grows: full power, off balance, distance, low skill
  let err = 0.03;
  err += Math.pow(power, 2.2) * 0.10;
  err += offBalance * 0.05;
  err += clamp((distToGoal - 12) / 60, 0, 0.6) * 0.10;
  err *= 1.45 - (skill / 99) * 0.85;
  err *= match.difficulty.humanShotErrMult && team.isHuman ? match.difficulty.humanShotErrMult : 1;

  const targetY = clamp(aimY, -1, 1) * (GOAL_HALF_W - 0.35);
  const aim: V2 = { x: goalX, y: targetY };
  const a = angleOf(sub2(aim, shooter.pos)) + match.rng.noise() * err * 3.2;

  const speed = 17 + power * 13; // finesse tap ≈ 17, blast ≈ 30
  // elevation: finesse stays low; full power risks blazing over
  let zDir = 0.06 + power * 0.16 + Math.max(0, match.rng.noise()) * power * 0.14;
  if (distToGoal > 25) zDir += 0.08; // long range needs loft
  const spin = match.rng.noise() * 0.6 + (power < 0.35 ? -Math.sign(targetY) * 0.9 : 0); // finesse curls in

  match.ball.kick({ x: Math.cos(a), y: Math.sin(a), z: zDir }, speed, shooter, spin);
  shooter.playAnim('shoot', 0.34);
  team.shots++;
  const onTarget = willHitGoal(match, shooter, a, speed, zDir);
  match.registerShot(shooter, speed, onTarget);
  match.events.emit({ type: 'kick', power: 0.6 + power * 0.4 });
  match.events.emit({ type: 'shot', teamIdx: shooter.teamIdx, onTarget, shooterName: shooter.data.name });
}

function willHitGoal(match: Match, shooter: PlayerEntity, angle: number, speed: number, zDir: number): boolean {
  const team = match.teams[shooter.teamIdx];
  const goalX = HALF_L * team.attackDir;
  const dx = goalX - shooter.pos.x;
  const vx = Math.cos(angle) * speed;
  if (Math.abs(vx) < 1) return false;
  const t = dx / vx;
  if (t < 0) return false;
  const yAt = shooter.pos.y + Math.sin(angle) * speed * t;
  const vz = zDir * speed;
  const zAt = 0.2 + vz * t - 0.5 * 12.5 * t * t;
  return Math.abs(yAt) < GOAL_HALF_W && zAt < GOAL_HEIGHT && zAt > -0.5;
}

/** Defensive clear: hoof it away from goal, vaguely toward a flank. */
export function executeClear(match: Match, player: PlayerEntity): void {
  const team = match.teams[player.teamIdx];
  const y = player.pos.y > 0 ? 1 : -1;
  const a = angleOf({ x: team.attackDir, y: y * 0.8 }) + match.rng.noise() * 0.2;
  match.ball.kick({ x: Math.cos(a) * 0.8, y: Math.sin(a) * 0.8, z: 0.55 }, 24, player);
  player.playAnim('loft', 0.3);
  match.events.emit({ type: 'kick', power: 0.85 });
}
