// Layer 1 (§6.2): elastic formation. Every off-ball player blends toward
// home + pull*(ball - home) + phase shift, so the block moves like a team.

import { clamp, type V2 } from '../../core/math';
import { FORMATIONS } from '../../data/loader';
import { HALF_L, HALF_W, PITCH_LENGTH } from '../constants';
import type { PlayerEntity } from '../player';
import type { Team } from '../team';
import { fracToPitch } from '../team';
import type { Match } from '../match';

export function shapeTarget(match: Match, team: Team, p: PlayerEntity): V2 {
  const meta = FORMATIONS.meta;
  const home = fracToPitch(p.homeFrac, team.attackDir);
  const pull = meta.pull[p.role];
  const attacking = match.possessionTeam === team.idx;
  const phase = (attacking ? meta.phase_shift_x.attacking : meta.phase_shift_x.defending)
    * PITCH_LENGTH * team.attackDir;

  const ball = match.ball.pos;
  let x = home.x + (ball.x - home.x) * pull + phase;
  let y = home.y + (ball.y - home.y) * pull * 0.8;

  // Defensive line discipline: back line stays goal-side of the ball and
  // holds a line for the offside trap (§6.2 through-ball counter).
  if (p.role === 'DF' && !attacking) {
    const ballX = ball.x * team.attackDir; // + = upfield
    const lineX = clamp(Math.min(ballX - 4, -6), -HALF_L + 6, 0);
    const cur = x * team.attackDir;
    if (cur > lineX) x = lineX * team.attackDir;
  }

  // Attackers stay onside: never beyond the second-last defender before the pass
  if (p.role === 'FW' && attacking) {
    const offsideLine = match.secondLastDefenderX(1 - team.idx);
    const lim = offsideLine * team.attackDir - 0.5;
    if (x * team.attackDir > lim && ball.x * team.attackDir < x * team.attackDir) {
      x = lim * team.attackDir;
    }
  }

  return {
    x: clamp(x, -HALF_L + 1, HALF_L - 1),
    y: clamp(y, -HALF_W + 1, HALF_W - 1),
  };
}

/**
 * Attacking runs (§6.2): when the carrier is in the final third, forwards make
 * near-post / far-post / channel runs instead of holding shape.
 */
export function runTarget(match: Match, team: Team, p: PlayerEntity, carrier: PlayerEntity): V2 | null {
  const goalX = HALF_L * team.attackDir;
  const carrierAdv = carrier.pos.x * team.attackDir;
  if (carrierAdv < HALF_L - 38) return null;         // not in the attacking zone yet
  if (p.role !== 'FW' && !(p.role === 'MF' && Math.abs(p.homeFrac[1] - 0.5) > 0.25)) return null;
  if (p === carrier) return null;

  const offsideLine = match.secondLastDefenderX(1 - team.idx);
  const nearPost = p.homeFrac[1] < 0.5;
  const wide = Math.abs(carrier.pos.y) > 12;
  let target: V2;
  if (wide) {
    // carrier is wide → attack the box: near post or penalty spot
    target = nearPost
      ? { x: goalX - 6 * team.attackDir, y: Math.sign(carrier.pos.y) * 3 }
      : { x: goalX - 11 * team.attackDir, y: -Math.sign(carrier.pos.y) * 4 };
  } else {
    // carrier central → channel runs either side
    target = { x: goalX - 10 * team.attackDir, y: nearPost ? -9 : 9 };
  }
  // stay onside
  const lim = offsideLine * team.attackDir - 0.6;
  if (target.x * team.attackDir > lim) target.x = lim * team.attackDir;
  return target;
}
