// Ball vs. body (§6.1: "the ball is never glued to feet" cuts both ways — a
// loose ball has to be able to hit people).
//
// Everything a loose or in-flight ball can run into goes through here: shins,
// torsos, a defender throwing himself in front of a shot, a striker attacking
// a cross with his head, and the keeper's body when his hands have already had
// their chance. Height decides which: a ball at knee height hits legs, at
// chest height hits the body, above head height sails over — which is exactly
// why a lofted pass clears a crowd and a drilled one does not.
//
// Deterministic: every random draw comes from match.rng (§8).

import { clamp, dist2, norm2, sub2, type V2, type V3 } from '../core/math';
import { effectiveRating } from '../data/loader';
import { BALL_RADIUS, GOAL_HALF_W, HALF_L } from './constants';
import { PLAYER_RADIUS } from './collision';
import type { PlayerEntity } from './player';
import type { Match } from './match';

/** Shin/boot radius — the part of a player a rolling ball meets. */
const LEG_RADIUS = 0.26;
/**
 * Torso radius. Wider than the legs (bodies block shots, ankles deflect them)
 * and deliberately the same capsule the body-collision pass uses, so "solid
 * enough to bump into" and "solid enough to block" are one number.
 */
const BODY_RADIUS = PLAYER_RADIUS;
/** Ball below this is at the feet. */
const LEG_TOP = 0.7;
/** Ball above this clears a standing player entirely. */
const BODY_TOP = 1.85;

/** Pace a body keeps out of the ball (1 - absorption). */
const LEG_ABSORB = 0.68;
const BODY_ABSORB = 0.5;
/** How much of the blocker's own momentum the ball takes on. */
const BODY_CARRY = 0.6;
/** Scatter on a deflection, radians of angular jitter at full strength. */
const SCATTER = 0.38;
/** Seconds the deflector can't immediately hoover up his own ricochet. */
const DEFLECT_LOCKOUT = 0.2;

// ---- heading (§ FIFA basics: crosses have to have a payoff) ----------------
/** Ball height band a standing player can attack with his head. */
const HEAD_MIN_Z = 1.25;
const HEAD_MAX_Z = 2.45;
/** Horizontal reach of a header, metres. */
const HEAD_REACH = 1.15;
/** Attacking headers inside this range of goal are shots, not clearances. */
const HEAD_SHOT_RANGE = 18;
const HEAD_COOLDOWN = 0.6;

/**
 * Run every body against the ball's path this tick.
 *
 * `prev` is the ball position before integration, so a 28 m/s shot is swept
 * rather than point-sampled — at 60Hz it moves half a metre per tick, which is
 * wider than a leg.
 */
export function ballBodyContacts(match: Match, prev: V3): void {
  const ball = match.ball;
  // A carried ball belongs to the dribble/tackle model; bouncing it off the
  // bodies crowding the carrier as well would just fight with it.
  if (ball.owner) return;
  if (match.phase !== 'play') return;

  const cur = ball.pos;
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  const segLen2 = dx * dx + dy * dy;

  let hit: { p: PlayerEntity; u: number; z: number; d: number } | null = null;
  for (const p of match.allPlayers) {
    if (p.sentOff) continue;
    if (ball.noControlPlayer === p) continue;

    // closest approach of the ball's path to this body, as a fraction u of
    // the tick's travel
    let u = 0;
    if (segLen2 > 1e-8) {
      u = clamp(((p.pos.x - prev.x) * dx + (p.pos.y - prev.y) * dy) / segLen2, 0, 1);
    }
    const bx = prev.x + dx * u;
    const by = prev.y + dy * u;
    const d = Math.hypot(bx - p.pos.x, by - p.pos.y);
    const z = prev.z + (cur.z - prev.z) * u;

    const part = z < LEG_TOP ? LEG_RADIUS : z < BODY_TOP ? BODY_RADIUS : 0;
    const headable = z >= HEAD_MIN_Z && z <= HEAD_MAX_Z;
    const reach = headable ? Math.max(part + BALL_RADIUS, HEAD_REACH) : part + BALL_RADIUS;
    if (part === 0 && !headable) continue;      // lofted clean over him
    if (d > reach) continue;

    // earliest contact along the path wins, so a ball does not pass through
    // one man to bounce off the one behind him
    if (!hit || u < hit.u) hit = { p, u, z, d };
  }
  if (!hit) return;

  const { p, u, z } = hit;
  const bx = prev.x + dx * u;
  const by = prev.y + dy * u;

  // the man the ball was played to, with time to take it, cushions it down
  // instead of heading it into the stands
  if (ball.intendedReceiver === p && canHead(p) && nearestOpponent(match, p) > 2.6) {
    cushion(match, p, z);
    return;
  }
  if (z >= HEAD_MIN_Z && z <= HEAD_MAX_Z && canHead(p) && hit.d <= HEAD_REACH
    && worthHeading(match, p)) {
    header(match, p, { x: bx, y: by }, z);
    return;
  }
  deflect(match, p, { x: bx, y: by }, z);
}

function nearestOpponent(match: Match, p: PlayerEntity): number {
  let nd = 99;
  for (const opp of match.teams[1 - p.teamIdx].players) {
    if (opp.sentOff) continue;
    const d = dist2(opp.pos, p.pos);
    if (d < nd) nd = d;
  }
  return nd;
}

/**
 * Aerial first touch: chest/thigh the ball down dead at your own feet. This is
 * what makes a lofted pass a pass rather than a 50/50 — without it every ball
 * out of the air was a scramble.
 */
function cushion(match: Match, p: PlayerEntity, z: number): void {
  const ball = match.ball;
  const skill = effectiveRating(p.data, 'passing');
  const slop = (1 - skill / 99) * 1.6 + 0.25;
  ball.pos.x = p.pos.x + Math.cos(p.facing) * 0.35;
  ball.pos.y = p.pos.y + Math.sin(p.facing) * 0.35;
  ball.pos.z = Math.max(z * 0.35, BALL_RADIUS);
  ball.vel.x = p.vel.x * 0.5 + match.rng.noise() * slop;
  ball.vel.y = p.vel.y * 0.5 + match.rng.noise() * slop;
  ball.vel.z = -1.5;
  ball.spinY = 0;
  ball.lastTouch = p;
  ball.noControlPlayer = null;
  ball.noControlTimer = 0;
  p.playAnim('trap', 0.14);
  match.events.emit({ type: 'bounce', speed: 2 });
}

function canHead(p: PlayerEntity): boolean {
  return !p.isGK && !p.diving && p.actionLock <= 0 && p.touchCd <= 0
    && p.actionAnim !== 'slide';
}

/**
 * Is this a ball you'd actually go up for? A dropping cross or a driven ball
 * at chest height, yes. The second bounce of a stray clearance wandering
 * through the same height band, no — otherwise every loose ball in the match
 * becomes a header.
 */
function worthHeading(match: Match, p: PlayerEntity): boolean {
  const ball = match.ball;
  const sp = ball.speed();
  if (sp < 4) return false;
  if (ball.vel.z > 1.5) return false;          // still climbing away from him
  const toBall = norm2(sub2({ x: ball.pos.x, y: ball.pos.y }, p.pos));
  const face = Math.cos(p.facing) * toBall.x + Math.sin(p.facing) * toBall.y;
  // he has to be looking at it, or it has to be dropping right on his head
  return face > -0.1 || dist2(p.pos, { x: ball.pos.x, y: ball.pos.y }) < 0.6;
}

/**
 * Ricochet. The ball keeps a fraction of its pace, picks up some of the
 * blocker's momentum, pops up off a shin and scatters a little — the
 * deterministic RNG component that makes a crowded box chaotic instead of
 * a billiard table.
 */
function deflect(match: Match, p: PlayerEntity, at: V2, z: number): void {
  const ball = match.ball;
  const legs = z < LEG_TOP;
  const radius = legs ? LEG_RADIUS : BODY_RADIUS;
  const absorb = legs ? LEG_ABSORB : BODY_ABSORB;

  let n = norm2(sub2(at, p.pos));
  if (n.x === 0 && n.y === 0) n = norm2({ x: -ball.vel.x, y: -ball.vel.y });
  if (n.x === 0 && n.y === 0) n = { x: 1, y: 0 };

  // reflect in the blocker's frame
  const rvx = ball.vel.x - p.vel.x;
  const rvy = ball.vel.y - p.vel.y;
  const vn = rvx * n.x + rvy * n.y;
  let ox = rvx;
  let oy = rvy;
  if (vn < 0) {                       // only if it is actually going into him
    ox = rvx - vn * (1 + absorb) * n.x;
    oy = rvy - vn * (1 + absorb) * n.y;
  }
  ox = ox * absorb + p.vel.x * BODY_CARRY;
  oy = oy * absorb + p.vel.y * BODY_CARRY;

  // scatter, scaled by impact — a gentle roll into a shin barely wobbles
  const sp = Math.hypot(ox, oy);
  const impact = clamp(Math.abs(vn) / 18, 0, 1);
  const a = Math.atan2(oy, ox) + match.rng.noise() * SCATTER * (0.35 + impact);
  ball.vel.x = Math.cos(a) * sp;
  ball.vel.y = Math.sin(a) * sp;
  // shins pop it up; a chest takes the pace out of it and drops it
  ball.vel.z = legs
    ? Math.max(ball.vel.z * -0.3, 0) + impact * (1.4 + match.rng.next() * 2.4)
    : ball.vel.z * 0.25 - impact * 0.8;

  // push the ball clear so the same body can't catch it again next tick —
  // but never across a goal line, or the goal/bounds sweep would read the
  // reposition as the ball crossing the plane and award a goal off a block
  const wasIn = Math.abs(at.x) < HALF_L;
  ball.pos.x = p.pos.x + n.x * (radius + BALL_RADIUS + 0.03);
  ball.pos.y = p.pos.y + n.y * (radius + BALL_RADIUS + 0.03);
  if (wasIn) ball.pos.x = clamp(ball.pos.x, -HALF_L + 0.05, HALF_L - 0.05);
  ball.pos.z = Math.max(ball.pos.z, BALL_RADIUS);
  ball.spinY *= 0.3;

  ball.lastTouch = p;
  ball.noControlPlayer = p;
  ball.noControlTimer = DEFLECT_LOCKOUT;
  match.events.emit({ type: 'bounce', speed: Math.abs(vn) });

  // a defender getting a body in the way ends the shot: it is a block, and
  // the rebound is a new phase of play rather than a ball still "on target"
  const shot = match.activeShot;
  if (shot && shot.shooter.teamIdx !== p.teamIdx && Math.abs(vn) > 8) {
    match.events.emit({ type: 'tackle' });
    match.shotResolved('out');
  }
}

/**
 * Header. An attacker inside the box heads at goal (and it counts as a shot);
 * anyone else heads it clear — which is what a defender does with a cross, and
 * the reason a lofted ball into a packed box is no longer a free goal.
 */
function header(match: Match, p: PlayerEntity, at: V2, z: number): void {
  const ball = match.ball;
  const team = match.teams[p.teamIdx];
  const goalX = HALF_L * team.attackDir;
  const dGoal = dist2(p.pos, { x: goalX, y: 0 });
  const power = effectiveRating(p.data, 'shooting');
  const head = effectiveRating(p.data, 'defending');

  p.playAnim('header', 0.42);
  p.touchCd = HEAD_COOLDOWN;
  ball.lastTouch = p;
  ball.owner = null;
  ball.noControlPlayer = p;
  ball.noControlTimer = 0.3;
  ball.spinY = 0;
  ball.pos.z = Math.max(z, 1.4);

  if (dGoal < HEAD_SHOT_RANGE) {
    // downward header toward a corner of the goal
    const aimY = clamp(-p.pos.y / 14, -0.85, 0.85);
    const target: V2 = { x: goalX, y: aimY * 3.2 };
    const err = (1 - power / 99) * 0.16 + 0.05;
    const a = Math.atan2(target.y - p.pos.y, target.x - p.pos.x) + match.rng.noise() * err;
    // flat and hard, not a lob into the turf: at -0.16 the ball pitched five
    // metres out every time and arrived as a bouncing gift for the keeper
    const speed = 14 + (power / 99) * 7;
    ball.kick({ x: Math.cos(a) * 0.995, y: Math.sin(a) * 0.995, z: -0.07 }, speed, p);
    ball.pos.z = Math.max(z, 1.5);
    team.shots++;
    // did that header actually go between the sticks? Straight-line projection
    // onto the goal plane, same question the foot shot model asks.
    const dxGoal = goalX - p.pos.x;
    const vx = Math.cos(a);
    const onTarget = Math.abs(vx) > 0.05 && dxGoal / vx > 0
      && Math.abs(p.pos.y + (Math.sin(a) / vx) * dxGoal) < GOAL_HALF_W;
    match.registerShot(p, speed, onTarget);
    match.events.emit({ type: 'shot', teamIdx: p.teamIdx, onTarget, shooterName: p.data.name });
    match.events.emit({ type: 'kick', power: 0.7 });
    return;
  }

  // defensive header: up and UP the pitch, only slightly wide — heading
  // straight into touch every time is a throw-in machine, not defending
  const away = Math.sign(p.pos.y || match.rng.noise() || 1);
  const a = Math.atan2(away * 0.35, team.attackDir) + match.rng.noise() * 0.2;
  const speed = 12 + (head / 99) * 8;
  ball.kick({ x: Math.cos(a) * 0.72, y: Math.sin(a) * 0.72, z: 0.7 }, speed, p);
  ball.pos.z = Math.max(z, 1.5);
  match.events.emit({ type: 'kick', power: 0.6 });
}
