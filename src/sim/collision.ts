// Body collision between players (§6.1 "tackles and loose balls should be
// emergent"): players are upright capsules of PLAYER_RADIUS on the pitch
// plane. Every tick we
//
//   1. separate overlapping pairs with an iterated, damped positional
//      correction — mass- and drive-weighted, so a sprinting attacker running
//      into a planted defender is the one who gets moved;
//   2. apply a jostle: a small normal impulse plus a shoulder-to-shoulder drag
//      that slows both men while they are leaning on each other;
//   3. mark shielding — when the carrier's body sits between the ball and a
//      defender, that defender can't win it this tick;
//   4. hand the hard contacts back to Match as foul candidates.
//
// Nothing here ever teleports: the per-tick displacement of any one player is
// capped at MAX_PUSH, corrections are damped and a CONTACT_TOL slack band
// means a settled crowd stops correcting instead of buzzing.

import { clamp, dist2, norm2, sub2, type V2 } from '../core/math';
import { effectiveRating } from '../data/loader';
import { HALF_L, HALF_W } from './constants';
import type { PlayerEntity } from './player';
import type { Match } from './match';

/** Half-width of a player's body on the pitch plane, metres. */
export const PLAYER_RADIUS = 0.35;
/** Overlap shallower than this is left alone — the anti-jitter slack band. */
const CONTACT_TOL = 0.02;
/** Relaxation passes per tick. Three is enough for a six-man goalmouth. */
const ITERATIONS = 3;
/** Fraction of the remaining overlap removed per pass (under-relaxed). */
const CORRECTION_DAMP = 0.55;
/** Hard cap on how far a body can be moved by contact in one tick (m). */
const MAX_PUSH = 0.07;
/** Bodies barely bounce. */
const RESTITUTION = 0.05;
/**
 * Shoulder-to-shoulder drag, per second of LEANING contact — scaled by how
 * hard the two are actually pressing, and capped per tick, because a man in a
 * six-body goalmouth would otherwise be dragged once per neighbour and stop
 * dead.
 */
const JOSTLE_DRAG = 1.4;
/** Lean speed (m/s) at which the drag is at full strength. */
const JOSTLE_FULL = 4;
/** Most of his speed one tick of contact may take, however big the crowd. */
const JOSTLE_MAX_TICK = 0.12;
/** Drive-in speed (m/s) at which a player counts as fully committed. */
const BRACE_SPEED = 4.5;
/** How much bracing multiplies a planted man's effective mass. */
const BRACE_GAIN = 1.1;

/** Carrier keeps the ball while an opponent is behind his body. */
const SHIELD_RANGE = 1.45;
const SHIELD_ALIGN = 0.55;
/** Seconds a shielded defender stays locked out of the ball. */
const SHIELD_LOCK = 0.2;

/** Impact speed above which a contact away from the ball is a foul candidate. */
const FOUL_CLOSING = 6.0;
/** …lower, if it lands in the victim's back. */
const FOUL_CLOSING_BEHIND = 4.2;
/** A player within this of the ball is credibly playing it, not the man. */
const PLAYING_BALL_RANGE = 1.6;
/** The contest has to be about the ball at all — this near it, in metres. */
const FOUL_BALL_RANGE = 3.0;
/** Seconds before the same offender can concede another body foul. */
const FOUL_COOLDOWN = 6;
/** Referees let a lot go: peak whistle probability for one hard contact. */
const FOUL_MAX_CHANCE = 0.3;

export interface OverlapReport { count: number; deepest: number; }

/** Diagnostic for the stats harness: how many pairs are interpenetrating. */
export function countOverlaps(players: PlayerEntity[]): OverlapReport {
  const min = PLAYER_RADIUS * 2;
  let count = 0;
  let deepest = 0;
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    if (a.sentOff) continue;
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j];
      if (b.sentOff) continue;
      const d = dist2(a.pos, b.pos);
      if (d < min - CONTACT_TOL) {
        count++;
        deepest = Math.max(deepest, min - d);
      }
    }
  }
  return { count, deepest };
}

/** Body mass proxy, kg. Defenders are built like defenders. */
export function bodyMass(p: PlayerEntity): number {
  const build = effectiveRating(p.data, 'defending');
  const frame = effectiveRating(p.data, 'stamina');
  return 68 + build * 0.16 + frame * 0.08;   // ≈ 79–92 kg
}

interface Contact {
  a: PlayerEntity;
  b: PlayerEntity;
  /** Unit normal pointing a → b. */
  nx: number;
  ny: number;
  /** Closing speed along the normal at first touch, m/s. */
  closing: number;
}

/**
 * The whole per-tick body pass. Called from Match.updatePlay once everybody
 * has integrated their own motion.
 */
export function resolveBodyCollisions(match: Match, dt: number): void {
  const players = match.allPlayers;
  const n = players.length;
  const minDist = PLAYER_RADIUS * 2;
  const contacts: Contact[] = [];
  const drag = new Map<PlayerEntity, number>();

  // --- pass 1: find contacts and take the impulse, once per pair ------------
  for (let i = 0; i < n; i++) {
    const a = players[i];
    // a keeper in mid-dive is ballistic and belongs to KeeperBrain: shoving
    // him off his line with a body would quietly break every save he makes
    if (a.sentOff || a.diving) continue;
    for (let j = i + 1; j < n; j++) {
      const b = players[j];
      if (b.sentOff || b.diving) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      if (d >= minDist || d < 1e-6) continue;

      const nx = dx / d;
      const ny = dy / d;
      const rvx = a.vel.x - b.vel.x;
      const rvy = a.vel.y - b.vel.y;
      const closing = rvx * nx + rvy * ny;   // > 0 = coming together
      contacts.push({ a, b, nx, ny, closing });

      if (closing > 0) {
        const ma = bodyMass(a);
        const mb = bodyMass(b);
        const jImp = (closing * (1 + RESTITUTION)) / (1 / ma + 1 / mb);
        a.vel.x -= (nx * jImp) / ma;
        a.vel.y -= (ny * jImp) / ma;
        b.vel.x += (nx * jImp) / mb;
        b.vel.y += (ny * jImp) / mb;
      }

      // shoulder-to-shoulder: leaning on someone costs you pace, in
      // proportion to how hard you are leaning. Banked per player and applied
      // once below, so a crowd is not 3× the drag of a duel.
      const lean = clamp(Math.abs(closing) / JOSTLE_FULL, 0, 1);
      const bleed = JOSTLE_DRAG * lean * dt;
      drag.set(a, (drag.get(a) ?? 0) + bleed);
      drag.set(b, (drag.get(b) ?? 0) + bleed);
      a.jostling = 0.12;
      b.jostling = 0.12;
    }
  }

  if (!contacts.length) return;

  for (const [p, bleed] of drag) {
    if (p.diving) continue;                 // a dive is ballistic, not a walk
    const k = 1 - Math.min(bleed, JOSTLE_MAX_TICK);
    p.vel.x *= k;
    p.vel.y *= k;
  }

  // --- pass 2: iterated positional separation -------------------------------
  // Correction share is inverse to "effective mass": a man braced against the
  // contact is heavier than one sprinting through it, so the runner bounces
  // off the planted defender rather than walking him backwards.
  const pushX = new Map<PlayerEntity, number>();
  const pushY = new Map<PlayerEntity, number>();

  for (let it = 0; it < ITERATIONS; it++) {
    for (const c of contacts) {
      const { a, b } = c;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      // act only once the overlap clears the slack band, but then separate to
      // FULL contact distance — settling just inside the band would leave the
      // pair permanently registering as overlapping
      if (d >= minDist - CONTACT_TOL) continue;
      const nx = d > 1e-6 ? dx / d : c.nx;
      const ny = d > 1e-6 ? dy / d : c.ny;
      const overlap = minDist - d;

      // how hard is each man driving INTO the contact right now
      const driveA = clamp((a.vel.x * nx + a.vel.y * ny) / BRACE_SPEED, 0, 1);
      const driveB = clamp((-(b.vel.x * nx + b.vel.y * ny)) / BRACE_SPEED, 0, 1);
      const effA = bodyMass(a) * (1 + BRACE_GAIN * (1 - driveA));
      const effB = bodyMass(b) * (1 + BRACE_GAIN * (1 - driveB));
      const shareA = effB / (effA + effB);   // lighter/committed man moves more

      const corr = overlap * CORRECTION_DAMP;
      const ax = -nx * corr * shareA;
      const ay = -ny * corr * shareA;
      const bx = nx * corr * (1 - shareA);
      const by = ny * corr * (1 - shareA);
      a.pos.x += ax; a.pos.y += ay;
      b.pos.x += bx; b.pos.y += by;
      pushX.set(a, (pushX.get(a) ?? 0) + ax);
      pushY.set(a, (pushY.get(a) ?? 0) + ay);
      pushX.set(b, (pushX.get(b) ?? 0) + bx);
      pushY.set(b, (pushY.get(b) ?? 0) + by);
    }
  }

  // --- clamp: contact never teleports, and never off the pitch apron ---------
  for (const [p, px] of pushX) {
    const py = pushY.get(p) ?? 0;
    const l = Math.hypot(px, py);
    if (l > MAX_PUSH) {
      const k = MAX_PUSH / l - 1;
      p.pos.x += px * k;
      p.pos.y += py * k;
    }
    p.pos.x = clamp(p.pos.x, -HALF_L - 4, HALF_L + 4);
    p.pos.y = clamp(p.pos.y, -HALF_W - 4, HALF_W + 4);
  }

  markShielding(match);
  judgeContacts(match, contacts);
}

/**
 * Shielding: with the carrier's body between the ball and a defender, the
 * defender is locked out of the ball for SHIELD_LOCK seconds — that is the
 * whole "back to goal, hold him off" move, and it is what stops a CPU presser
 * reaching through a striker's spine.
 */
function markShielding(match: Match): void {
  const carrier = match.ball.owner;
  if (!carrier) return;
  const ballV: V2 = { x: match.ball.pos.x, y: match.ball.pos.y };
  let shielding = false;
  for (const opp of match.teams[1 - carrier.teamIdx].players) {
    if (opp.sentOff || opp.diving) continue;
    const dOpp = dist2(opp.pos, carrier.pos);
    if (dOpp > SHIELD_RANGE) continue;
    const toCarrier = norm2(sub2(carrier.pos, opp.pos));
    const toBall = norm2(sub2(ballV, opp.pos));
    const align = toCarrier.x * toBall.x + toCarrier.y * toBall.y;
    // body genuinely in the way: aligned, and the man is nearer than the ball
    if (align > SHIELD_ALIGN && dOpp < dist2(opp.pos, ballV) + 0.15) {
      opp.shieldedOut = Math.max(opp.shieldedOut, SHIELD_LOCK);
      shielding = true;
    }
  }
  carrier.shielding = shielding;
  // arm the one-shot for the renderer without locking him: shielding is a
  // posture, not an action, so it must never cost him a step
  if (shielding && (carrier.actionAnim === 'none' || carrier.actionAnim === 'shield')) {
    if (carrier.actionAnim !== 'shield') carrier.playAnim('shield', 0);
  }
}

/**
 * Foul candidates (§6.4). A hard impact, or any impact into a man's back,
 * while the offender is NOT playing the ball, is a free kick with the existing
 * card logic. Everything else is football.
 */
function judgeContacts(match: Match, contacts: Contact[]): void {
  const ballV: V2 = { x: match.ball.pos.x, y: match.ball.pos.y };
  for (const c of contacts) {
    if (c.a.teamIdx === c.b.teamIdx) continue;         // team-mates just bump
    if (c.closing < FOUL_CLOSING_BEHIND) continue;
    // the contest has to be about the ball: a midfield shoulder 40m from play
    // is not a free kick, it is two men jogging into each other
    if (Math.min(dist2(c.a.pos, ballV), dist2(c.b.pos, ballV)) > FOUL_BALL_RANGE) continue;

    // whoever is driving into the other is the offender
    const aDrive = c.a.vel.x * c.nx + c.a.vel.y * c.ny;
    const bDrive = -(c.b.vel.x * c.nx + c.b.vel.y * c.ny);
    const offender = aDrive >= bDrive ? c.a : c.b;
    const victim = offender === c.a ? c.b : c.a;
    if (offender.contactFoulCd > 0 || offender.diving || victim.diving) continue;

    // a defender with the ball inside his own stride is playing the ball
    const dBall = dist2(offender.pos, ballV);
    if (dBall < PLAYING_BALL_RANGE) continue;
    // ...and so is the man who arrives first at a genuine 50/50
    if (dBall < dist2(victim.pos, ballV) - 0.3) continue;

    const toOff = norm2(sub2(offender.pos, victim.pos));
    const fromBehind = Math.cos(victim.facing) * toOff.x + Math.sin(victim.facing) * toOff.y < -0.2;
    if (!fromBehind && c.closing < FOUL_CLOSING) continue;

    // not every thump is whistled — referees let a lot go
    const p = clamp((c.closing - FOUL_CLOSING_BEHIND) / 14, 0.03, FOUL_MAX_CHANCE)
      * (fromBehind ? 1.4 : 0.5);
    if (match.rng.next() > p) continue;
    offender.contactFoulCd = FOUL_COOLDOWN;
    victim.contactFoulCd = Math.max(victim.contactFoulCd, 1.5);
    // a shoulder charge is not a lunge: cards are rarer than for a slide
    match.callFoul(victim, offender, { allowAdvantage: true, severity: fromBehind ? 0.5 : 0.25 });
    return;   // one whistle per tick
  }
}
