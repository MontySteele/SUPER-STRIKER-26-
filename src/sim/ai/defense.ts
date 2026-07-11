// Defending (§6.2): contain (goal-side mirror), press (closest man + one
// cover), everyone else keeps shape. Center-backs' line discipline lives in
// teamShape.ts.

import { dist2, len2, norm2, sub2, type V2 } from '../../core/math';
import { HALF_L } from '../constants';
import type { PlayerEntity } from '../player';
import type { Team } from '../team';
import type { Match } from '../match';

export interface DefenseAssignments {
  presser: PlayerEntity | null;
  cover: PlayerEntity | null;
}

/** Pick who presses and who covers for the defending team this tick. */
export function assignDefense(match: Match, team: Team): DefenseAssignments {
  const ball = match.ball.pos;
  const candidates = team.players
    .filter((p) => !p.isGK && !p.diving && !p.sentOff)
    .sort((a, b) => dist2(a.pos, ball) - dist2(b.pos, ball));
  return { presser: candidates[0] ?? null, cover: candidates[1] ?? null };
}

/** Contain: sit on the line between ball and own goal, mirroring the carrier. */
export function containTarget(match: Match, team: Team, jockeyDist: number): V2 {
  const ball = match.ball.pos;
  const ownGoalX = -HALF_L * team.attackDir;
  const toGoal = norm2(sub2({ x: ownGoalX, y: 0 }, { x: ball.x, y: ball.y }));
  return {
    x: ball.x + toGoal.x * jockeyDist,
    y: ball.y + toGoal.y * jockeyDist,
  };
}

export function updateDefender(
  match: Match, team: Team, p: PlayerEntity, assignment: 'press' | 'cover',
): void {
  const ball = match.ball.pos;
  const carrier = match.ball.owner;
  if (assignment === 'press') {
    // close down the ball; commit harder the closer we are
    const d = dist2(p.pos, { x: ball.x, y: ball.y });
    if (d > 6) {
      p.moveToward({ x: ball.x, y: ball.y }, 1, match.difficulty.cpuSprint && d > 10);
    } else {
      // jockey goal-side, then step in when the touch is loose — or when the
      // carrier just stands there (jockeying at 1.4m sits outside the 1.3m
      // tackle radius, so a parked carrier could otherwise never be robbed)
      const target = containTarget(match, team, 1.4);
      const looseTouch = !carrier || dist2({ x: ball.x, y: ball.y }, carrier.pos) > 1.5;
      // 0.6: truly parked. Higher thresholds also caught sharp turns, traps
      // and shot-charging humans, who'd get robbed mid-windup.
      const carrierIdle = !!carrier && len2(carrier.vel) < 0.6;
      p.moveToward(looseTouch || carrierIdle ? { x: ball.x, y: ball.y } : target, 1, false);
    }
  } else {
    // cover: protect the space behind the presser
    const target = containTarget(match, team, 7);
    p.moveToward(target, 0.92, false);
  }
}
