// Pass assist, through balls, crosses, shot model (§5 control feel rules).
// Human control and CPU AI both call these — feel is tuned in exactly one place.

import { angleDiff, angleOf, clamp, dist2, distToSegment, norm2, sub2, type V2 } from '../core/math';
import { effectiveRating } from '../data/loader';
import { GOAL_HALF_W, GOAL_HEIGHT, HALF_L } from './constants';
import type { PlayerEntity } from './player';
import type { Match } from './match';

export interface PassOption {
  player: PlayerEntity;
  score: number;
  aim: V2;       // where to send the ball (leads the receiver)
  openness: number;
}

/** How clear the lane from a to b is of opponents (1 = fully open). */
export function laneOpenness(match: Match, from: V2, to: V2, teamIdx: number): number {
  let worst = 1;
  const passLen = dist2(from, to);
  for (const opp of match.teams[1 - teamIdx].players) {
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
 * Pass assist (§5): snap to the best teammate near the aim direction, weighted
 * by cone deviation, distance and lane openness. Cone is 30° at full assist,
 * relaxing outward so there is always *some* target.
 */
export function bestPassTarget(
  match: Match,
  passer: PlayerEntity,
  aimDir: V2,
  opts: { maxDist?: number; preferForward?: boolean; lead?: number } = {},
): PassOption | null {
  const team = match.teams[passer.teamIdx];
  const maxDist = opts.maxDist ?? 38;
  const lead = opts.lead ?? 0.35;
  let best: PassOption | null = null;
  const aimAngle = angleOf(aimDir);

  for (const mate of team.players) {
    if (mate === passer) continue;
    // lead the runner: aim where they'll be when the ball arrives
    const d0 = dist2(passer.pos, mate.pos);
    if (d0 < 2 || d0 > maxDist) continue;
    const flight = d0 / passSpeedFor(d0);
    const aim: V2 = {
      x: mate.pos.x + mate.vel.x * flight * (lead * 2),
      y: mate.pos.y + mate.vel.y * flight * (lead * 2),
    };
    const toMate = sub2(aim, passer.pos);
    const dev = Math.abs(angleDiff(aimAngle, angleOf(toMate)));
    if (dev > Math.PI * 0.6) continue; // never pass backwards of the stick
    const open = laneOpenness(match, passer.pos, aim, passer.teamIdx);
    // scoring: tight cone strongly preferred, mid distances preferred, open lanes preferred
    let score = 0;
    score += (1 - dev / (Math.PI * 0.6)) * 3.0;
    if (dev < Math.PI / 6) score += 2.0; // inside the 30° cone
    const distPref = d0 < 8 ? d0 / 8 : clamp(1 - (d0 - 22) / 30, 0.3, 1);
    score += distPref * 1.2;
    score += open * 2.0;
    if (opts.preferForward) {
      score += ((aim.x - passer.pos.x) * team.attackDir > 2 ? 1.0 : 0);
    }
    if (!best || score > best.score) best = { player: mate, score, aim, openness: open };
  }
  return best;
}

function passSpeedFor(dist: number): number {
  return clamp(10 + dist * 0.55, 11, 26);
}

export function executeShortPass(match: Match, passer: PlayerEntity, target: PassOption): void {
  const d = dist2(passer.pos, target.aim);
  const speed = passSpeedFor(d);
  const skill = effectiveRating(passer.data, 'passing');
  const err = (1 - skill / 99) * 0.09;
  const dir = norm2(sub2(target.aim, passer.pos));
  const a = angleOf(dir) + match.rng.noise() * err;
  match.ball.kick({ x: Math.cos(a), y: Math.sin(a), z: 0.02 }, speed, passer);
  passer.playAnim('pass', 0.22);
  match.events.emit({ type: 'kick', power: speed / 26 });
}

/** Lofted pass / cross (§5 K): pick a further target or drop into the box. */
export function executeLoft(match: Match, passer: PlayerEntity, aimDir: V2): void {
  const team = match.teams[passer.teamIdx];
  const inCrossZone =
    Math.abs(passer.pos.x) > HALF_L - 25 &&
    (passer.pos.x * team.attackDir > 0) &&
    Math.abs(passer.pos.y) > 12;

  let aim: V2;
  if (inCrossZone) {
    // cross toward the penalty spot area, aimed at the best runner if any
    const goalX = HALF_L * team.attackDir;
    const runners = team.players.filter(
      (p) => p !== passer && Math.abs(p.pos.x - goalX) < 24 && Math.abs(p.pos.y) < 16,
    );
    if (runners.length) {
      const r = runners.reduce((a, b) =>
        Math.abs(a.pos.x - goalX) < Math.abs(b.pos.x - goalX) ? a : b);
      aim = { x: r.pos.x + r.vel.x * 0.7, y: r.pos.y + r.vel.y * 0.7 };
    } else {
      aim = { x: goalX - 9 * team.attackDir, y: match.rng.range(-5, 5) };
    }
  } else {
    const target = bestPassTarget(match, passer, aimDir, { maxDist: 55, preferForward: true, lead: 0.5 });
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
  passer.playAnim('loft', 0.3);
  match.events.emit({ type: 'kick', power: speed / 30 });
}

/** Through ball (§5 I): thread into space ahead of the best runner. */
export function executeThrough(match: Match, passer: PlayerEntity, aimDir: V2): void {
  const team = match.teams[passer.teamIdx];
  let best: { p: PlayerEntity; score: number } | null = null;
  const aimAngle = angleOf(aimDir);
  for (const mate of team.players) {
    if (mate === passer || mate.isGK) continue;
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
  passer.playAnim('pass', 0.22);
  match.offside.registerPass(passer, receiver);
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
