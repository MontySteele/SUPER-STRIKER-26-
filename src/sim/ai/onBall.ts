// Layer 2 (§6.2): CPU ball-carrier. Every 0.3s score ~5 options — safe pass,
// forward pass, through ball, dribble, shoot — with style bias and
// rating-scaled decision noise. Deliberately imperfect: minnows play honest.

import { clamp, dist2, norm2, sub2, type V2 } from '../../core/math';
import { effectiveRating, teamRating } from '../../data/loader';
import { executeClear, executeLoft, executeShortPass, executeShot, executeThrough, bestPassTarget, laneOpenness } from '../actions';
import { HALF_L } from '../constants';
import type { PlayerEntity } from '../player';
import type { Match } from '../match';

interface StyleBias {
  safe: number; forward: number; through: number; dribble: number; shoot: number; cross: number;
}

const STYLES: Record<string, StyleBias> = {
  possession: { safe: 1.35, forward: 1.0, through: 0.85, dribble: 1.05, shoot: 0.9, cross: 0.9 },
  counter:    { safe: 0.85, forward: 1.2, through: 1.3, dribble: 1.0, shoot: 1.1, cross: 1.0 },
  balanced:   { safe: 1.0, forward: 1.0, through: 1.0, dribble: 1.0, shoot: 1.0, cross: 1.0 },
  defensive:  { safe: 1.3, forward: 0.9, through: 0.8, dribble: 0.8, shoot: 0.85, cross: 1.1 },
};

export function cpuOnBallDecision(match: Match, carrier: PlayerEntity): void {
  const team = match.teams[carrier.teamIdx];
  const bias = STYLES[team.data.style] ?? STYLES.balanced;
  const rng = match.rng;
  const rating = teamRating(team.data);
  // decision noise scales inversely with team rating and difficulty (§6.2, §6.6)
  const noise = (1.15 - rating / 99) * match.difficulty.cpuNoise;

  const goalX = HALF_L * team.attackDir;
  const distGoal = dist2(carrier.pos, { x: goalX, y: 0 });
  const pressure = nearestOpponentDist(match, carrier);
  const inOwnThird = carrier.pos.x * team.attackDir < -HALF_L / 3;
  // patience runs out: after ~10s of possession that never reaches the final
  // third, sideways recycling loses value and forward options gain it
  const urgency = clamp(match.buildupTime[carrier.teamIdx] / 10, 0, 1);

  const dirGoal = norm2(sub2({ x: goalX, y: carrier.pos.y * 0.3 }, carrier.pos));

  // --- score options ---
  const shootScore = (() => {
    if (distGoal > 34) return 0;
    const open = laneOpenness(match, carrier.pos, { x: goalX, y: 0 }, carrier.teamIdx);
    const angle = 1 - clamp(Math.abs(carrier.pos.y) / 30, 0, 1);
    const skill = effectiveRating(carrier.data, 'shooting') / 99;
    const inBox = distGoal < 17 && Math.abs(carrier.pos.y) < 20 ? 1.8 : 0;
    // every factor is floored: a purely multiplicative gate collapses to ~0
    // against a set defense and good teams end matches with zero shots
    return ((1 - distGoal / 40) * 3.0 + inBox)
      * (0.55 + angle * 0.6) * (0.7 + open * 0.6) * (0.55 + skill * 0.6) * bias.shoot;
  })();

  const fwd = bestPassTarget(match, carrier, dirGoal, { preferForward: true });
  const forwardScore = fwd
    ? (fwd.score / 8) * 1.25 * bias.forward * (pressure < 4 ? 1.25 : 1) * (1 + urgency * 0.6)
    : 0;

  const anyDir = norm2({ x: team.attackDir * 0.3 + rng.noise() * 0.5, y: rng.noise() });
  const safe = bestPassTarget(match, carrier, anyDir, { maxDist: 26 });
  const safeScore = safe
    ? (safe.score / 8) * (safe.openness * 1.3) * bias.safe * (pressure < 3.5 ? 1.5 : 0.9) * (1 - urgency * 0.55)
    : 0;

  const throughScore = (() => {
    let best = 0;
    for (const mate of team.players) {
      if (mate === carrier || mate.isGK || mate.sentOff) continue;
      const adv = (mate.pos.x - carrier.pos.x) * team.attackDir;
      if (adv < 4) continue;
      const running = mate.vel.x * team.attackDir > 2.5 ? 1.4 : 1;
      const space = laneOpenness(match, carrier.pos, {
        x: mate.pos.x + team.attackDir * 8, y: mate.pos.y,
      }, carrier.teamIdx);
      best = Math.max(best, (adv / 30) * running * space);
    }
    return best * 2.1 * bias.through * (1 + urgency * 0.7);
  })();

  const dribbleScore = (() => {
    const ahead: V2 = { x: carrier.pos.x + dirGoal.x * 8, y: carrier.pos.y + dirGoal.y * 8 };
    const open = laneOpenness(match, carrier.pos, ahead, carrier.teamIdx);
    const pace = effectiveRating(carrier.data, 'pace') / 99;
    return open * (0.5 + pace * 0.9) * 1.35 * bias.dribble * (pressure > 3 ? 1.15 : 0.55) * (1 + urgency * 0.5);
  })();

  const crossScore = (() => {
    const wide = Math.abs(carrier.pos.y) > 14 && carrier.pos.x * team.attackDir > HALF_L - 30;
    return wide ? 1.7 * bias.cross : 0;
  })();

  const clearScore = inOwnThird && pressure < 3 ? 2.2 : 0;

  const options: [string, number][] = [
    ['shoot', shootScore], ['forward', forwardScore], ['safe', safeScore],
    ['through', throughScore], ['dribble', dribbleScore], ['cross', crossScore],
    ['clear', clearScore],
  ];
  let bestOpt = 'dribble';
  let bestScore = -1;
  for (const [name, s] of options) {
    const jittered = s + rng.noise() * noise;
    if (jittered > bestScore) { bestScore = jittered; bestOpt = name; }
  }

  switch (bestOpt) {
    case 'shoot': {
      const aimY = clamp(-carrier.pos.y / 20, -0.7, 0.7) + rng.noise() * 0.3;
      executeShot(match, carrier, aimY, clamp(0.35 + distGoal / 40 + rng.next() * 0.25, 0.2, 1));
      break;
    }
    case 'forward':
      if (fwd) executeShortPass(match, carrier, fwd);
      break;
    case 'safe':
      if (safe) executeShortPass(match, carrier, safe);
      break;
    case 'through':
      executeThrough(match, carrier, dirGoal);
      break;
    case 'cross':
      executeLoft(match, carrier, dirGoal);
      break;
    case 'clear':
      executeClear(match, carrier);
      break;
    case 'dribble':
    default:
      // handled continuously by cpuDribble; nothing to kick this tick
      break;
  }
}

/** Continuous dribble steering between decision ticks. */
export function cpuDribble(match: Match, carrier: PlayerEntity): void {
  const team = match.teams[carrier.teamIdx];
  const goalX = HALF_L * team.attackDir;
  const dirGoal = norm2(sub2({ x: goalX, y: carrier.pos.y * 0.25 }, carrier.pos));
  // veer away from the nearest opponent
  let veer: V2 = { x: 0, y: 0 };
  let nd = 1e9;
  for (const opp of match.teams[1 - carrier.teamIdx].players) {
    if (opp.sentOff) continue;
    const d = dist2(opp.pos, carrier.pos);
    if (d < nd) { nd = d; veer = norm2(sub2(carrier.pos, opp.pos)); }
  }
  const w = clamp(1 - nd / 7, 0, 0.8);
  const dir = norm2({ x: dirGoal.x * (1 - w) + veer.x * w, y: dirGoal.y * (1 - w) + veer.y * w });
  const sprint = nd > 4 && carrier.stamina > 0.25 && match.difficulty.cpuSprint;
  carrier.moveDir(dir, 1, sprint);
}

export function nearestOpponentDist(match: Match, p: PlayerEntity): number {
  let nd = 1e9;
  for (const opp of match.teams[1 - p.teamIdx].players) {
    if (opp.sentOff) continue;
    const d = dist2(opp.pos, p.pos);
    if (d < nd) nd = d;
  }
  return nd;
}
