// Goalkeeper state machine (§6.3): POSITION → SET → REACT → DIVE/CLAIM/PARRY →
// RECOVER. Reaction delay scales with the Keeping stat; saves can parry into
// danger — rebounds are drama, not bugs.

import { clamp, dist2, norm2, sub2, v2, type V2 } from '../../core/math';
import { effectiveRating } from '../../data/loader';
import { BOX_DEPTH, BOX_HALF_W, GOAL_HALF_W, HALF_L, SIX_DEPTH } from '../constants';
import type { PlayerEntity } from '../player';
import type { Team } from '../team';
import type { Match } from '../match';

type KState = 'position' | 'set' | 'react' | 'dive' | 'recover' | 'hold' | 'smother';

// Smother (§6.3+): a dribbler carrying the ball deep into the box gets
// charged down and the ball claimed at their feet — the realistic answer to
// walking the ball into the net. Shots and chips still beat the charge.
const SMOTHER_TRIGGER_X = 12;   // carrier within this of the goal line
const SMOTHER_TRIGGER_Y = 13;
const SMOTHER_REACH = 7;        // keeper close enough to make the charge
const SMOTHER_BALL_MAX_Z = 0.6; // at the feet — a chip is not smotherable
const SMOTHER_WIN_BASE = 0.72;  // + up to 0.18 by Keeping rating
const SMOTHER_COOLDOWN = 1.6;

export class KeeperBrain {
  state: KState = 'position';
  timer = 0;
  /** sim time at which the keeper reacts to the in-flight shot */
  reactAt = -1;
  holdTimer = 0;
  private smotherCooldown = 0;

  constructor(public team: Team, public keeper: PlayerEntity) {}

  private goalX(): number {
    return -HALF_L * this.team.attackDir;
  }

  /** Called by Match when an opponent strikes a shot toward this goal. */
  onShot(match: Match): void {
    if (this.state === 'dive' || this.state === 'hold') return;
    const keeping = effectiveRating(this.keeper.data, 'keeping');
    // 180–320ms by stat (§6.3); difficulty only slows CPU keepers (§6.6)
    let delay = 0.32 - (keeping / 99) * 0.14;
    if (!this.team.isHuman) delay *= match.difficulty.cpuKeeperReactMult;
    this.reactAt = match.simTime + delay;
    this.state = 'react';
  }

  update(match: Match, dt: number): void {
    const k = this.keeper;
    const ball = match.ball;
    const gx = this.goalX();
    this.timer += dt;
    this.smotherCooldown = Math.max(0, this.smotherCooldown - dt);

    // stray ball captured at the keeper's feet → immediate distribution
    if (ball.owner === k && this.state !== 'hold') {
      this.state = 'hold';
      this.holdTimer = 0.8;
      ball.owner = null;
      ball.vel = { x: 0, y: 0, z: 0 };
    }

    switch (this.state) {
      case 'hold': {
        this.holdTimer -= dt;
        ball.pos.x = k.pos.x + Math.cos(k.facing) * 0.5;
        ball.pos.y = k.pos.y + Math.sin(k.facing) * 0.5;
        ball.pos.z = 0.9;
        ball.vel = { x: 0, y: 0, z: 0 };
        k.stop();
        if (this.holdTimer <= 0) {
          // distribute: lofted ball toward a wide midfielder upfield
          const mates = this.team.players.filter((p) => !p.isGK && !p.sentOff && Math.abs(p.pos.y) > 8);
          const target = mates.length
            ? mates.reduce((a, b) => ((a.pos.x - k.pos.x) * this.team.attackDir >
                (b.pos.x - k.pos.x) * this.team.attackDir ? a : b))
            : this.team.players.find((p) => !p.isGK && !p.sentOff) ?? this.team.players[5];
          const dir = norm2(sub2(target.pos, k.pos));
          ball.pos.z = 0.4;
          ball.kick({ x: dir.x * 0.75, y: dir.y * 0.75, z: 0.6 }, 26, k);
          k.playAnim('loft', 0.3);
          match.events.emit({ type: 'kick', power: 0.9 });
          this.state = 'position';
        }
        return;
      }

      case 'dive': {
        if (!k.diving) {
          this.state = 'recover';
          this.timer = 0;
        }
        this.tryHands(match, 1.15);
        return;
      }

      case 'recover': {
        k.stop();
        if (this.timer > 0.7) this.state = 'position';
        return;
      }

      case 'react': {
        // track the shot; commit to the dive once reaction time elapses
        if (match.simTime >= this.reactAt) {
          this.commitDive(match);
        }
        return;
      }

      case 'smother': {
        const target = ball.owner;
        if (!target || target.teamIdx === this.team.idx ||
            ball.pos.z > 1.2 || Math.abs(target.pos.x - gx) > SMOTHER_TRIGGER_X + 2) {
          this.state = 'position'; // dribbled clear, passed, or chipped
          return;
        }
        // attack the BALL, leading the carrier's run slightly
        k.moveToward({
          x: ball.pos.x + target.vel.x * 0.15,
          y: ball.pos.y + target.vel.y * 0.15,
        }, 1, true);
        const d = dist2(k.pos, { x: ball.pos.x, y: ball.pos.y });
        if (d < 1.5) {
          const keeping = effectiveRating(k.data, 'keeping');
          const winP = SMOTHER_WIN_BASE + (keeping / 99) * 0.18;
          this.smotherCooldown = SMOTHER_COOLDOWN;
          if (match.rng.next() < winP) {
            this.pickUp(match); // swallowed at the dribbler's feet
          } else {
            // spilled: poke it toward the byline — often a corner
            const outY = Math.sign(ball.pos.y || match.rng.noise());
            ball.kick({ x: -this.team.attackDir * 0.4, y: outY, z: 0.15 },
              7 + match.rng.next() * 4, k);
            ball.noControlTimer = 0.4;
            this.state = 'recover';
            this.timer = 0;
          }
        }
        return;
      }

      case 'set':
      case 'position':
      default:
        break;
    }

    // --- claims: high ball dropping inside the six-yard area, unchallenged (§6.3)
    const inBoxAir = ball.pos.z > 1.2 && Math.abs(ball.pos.x - gx) < SIX_DEPTH + 4 &&
      Math.abs(ball.pos.y) < GOAL_HALF_W + 6 && ball.owner === null;
    if (inBoxAir) {
      const land = this.predictLanding(match);
      if (land && Math.abs(land.x - gx) < SIX_DEPTH + 3 && Math.abs(land.y) < 10) {
        k.moveToward(land, 1, true);
        this.tryHands(match, 1.0);
        return;
      }
    }

    // --- loose ball pickup in the box
    if (ball.owner === null && ball.grounded() && ball.speed2d() < 7) {
      const d = dist2(k.pos, { x: ball.pos.x, y: ball.pos.y });
      const inBox = Math.abs(ball.pos.x - gx) < BOX_DEPTH && Math.abs(ball.pos.y) < BOX_HALF_W;
      if (inBox && d < 8) {
        k.moveToward({ x: ball.pos.x, y: ball.pos.y }, 1, d > 3);
        if (d < 1.1) this.pickUp(match);
        return;
      }
    }

    // --- smother: carrier deep in the box with the ball at their feet gets
    // charged down (outranks passive angle-narrowing; a struck shot still
    // flips us to react via onShot)
    const carrier = ball.owner;
    if (carrier && carrier.teamIdx !== this.team.idx &&
        Math.abs(carrier.pos.x - gx) < SMOTHER_TRIGGER_X &&
        Math.abs(carrier.pos.y) < SMOTHER_TRIGGER_Y &&
        dist2(k.pos, carrier.pos) < SMOTHER_REACH &&
        ball.pos.z < SMOTHER_BALL_MAX_Z &&
        this.smotherCooldown <= 0) {
      this.state = 'smother';
      return;
    }

    // --- 1v1: close down to narrow the angle (§6.3) — chips punish this
    const oneVsOne = carrier && carrier.teamIdx !== this.team.idx &&
      Math.abs(carrier.pos.x - gx) < 22 && Math.abs(carrier.pos.y) < 14 &&
      this.noDefenderBetween(match, carrier);
    if (oneVsOne && carrier) {
      const out = norm2(sub2(carrier.pos, { x: gx, y: 0 }));
      const closeDepth = clamp(10 - dist2(carrier.pos, { x: gx, y: 0 }) * 0.25, 2, 8);
      k.moveToward({ x: gx + out.x * closeDepth, y: out.y * closeDepth }, 1, true);
      this.state = 'set';
      return;
    }

    // --- default positioning: bisect ball-to-goal angle, depth by distance (§6.3)
    const ballV: V2 = { x: ball.pos.x, y: ball.pos.y };
    const distBall = dist2(ballV, { x: gx, y: 0 });
    const out = norm2(sub2(ballV, { x: gx, y: 0 }));
    const depth = clamp(0.9 + (distBall - 12) * 0.06, 0.7, 3.4);
    const target: V2 = {
      x: gx + out.x * depth,
      y: clamp(out.y * depth, -GOAL_HALF_W + 0.4, GOAL_HALF_W - 0.4),
    };
    const threat = carrier && carrier.teamIdx !== this.team.idx && distBall < 26;
    this.state = threat ? 'set' : 'position';
    k.moveToward(target, threat ? 1 : 0.85, false);
  }

  private noDefenderBetween(match: Match, carrier: PlayerEntity): boolean {
    const gx = this.goalX();
    for (const p of this.team.players) {
      if (p.isGK || p.sentOff) continue;
      const between = (p.pos.x - carrier.pos.x) * Math.sign(gx - carrier.pos.x) > 0.5 &&
        Math.abs(p.pos.x - gx) < Math.abs(carrier.pos.x - gx);
      if (between && Math.abs(p.pos.y - carrier.pos.y * 0.5) < 8) return false;
    }
    return true;
  }

  private predictLanding(match: Match): V2 | null {
    // integrate a copy of the ball forward until it hits the deck
    const b = match.ball;
    let { x, y, z } = b.pos;
    let { x: vx, y: vy, z: vz } = b.vel;
    for (let t = 0; t < 3; t += 1 / 30) {
      vz -= 12.5 / 30;
      x += vx / 30; y += vy / 30; z += vz / 30;
      if (z <= 0.5 && vz < 0) return { x, y };
    }
    return null;
  }

  private commitDive(match: Match): void {
    const k = this.keeper;
    const ball = match.ball;
    // predict where the ball crosses the keeper's x-plane
    const dx = k.pos.x - ball.pos.x;
    const vx = ball.vel.x;
    if (Math.abs(vx) < 2 || dx * vx < 0) {
      // shot not coming across our plane (deflected/slow) — just attack the ball
      k.moveToward({ x: ball.pos.x, y: ball.pos.y }, 1, true);
      this.state = 'position';
      return;
    }
    const t = dx / vx;
    const py = ball.pos.y + ball.vel.y * t;
    const pz = ball.pos.z + ball.vel.z * t - 0.5 * 12.5 * t * t;
    const keeping = effectiveRating(this.keeper.data, 'keeping');
    const reach = 2.4 + (keeping / 99) * 1.1;
    const dy = py - k.pos.y;

    if (Math.abs(dy) > reach || pz > 3.2 || pz < -0.3) {
      // can't get there — desperate full stretch anyway (looks right, sells the goal)
      const dir = Math.sign(dy || match.rng.noise());
      this.startDive(match, dir * Math.min(Math.abs(dy), reach), 0.9);
      return;
    }
    this.startDive(match, dy, clamp(t, 0.12, 0.55));
  }

  private startDive(match: Match, dy: number, arriveIn: number): void {
    const k = this.keeper;
    k.diving = true;
    k.diveVel = v2(0, dy / Math.max(arriveIn, 0.15));
    // cap dive velocity to something human
    const max = 11;
    if (Math.abs(k.diveVel.y) > max) k.diveVel.y = Math.sign(k.diveVel.y) * max;
    k.playAnim(dy * this.team.attackDir > 0 ? 'diveR' : 'diveL', 0.9);
    this.state = 'dive';
    this.timer = 0;
  }

  /** Hands check: if the ball is within reach, catch or parry. */
  private tryHands(match: Match, radius: number): void {
    const k = this.keeper;
    const ball = match.ball;
    if (ball.noControlPlayer === k) return;
    const d3 = Math.hypot(ball.pos.x - k.pos.x, ball.pos.y - k.pos.y, (ball.pos.z - 1.0) * 0.7);
    if (d3 > radius) return;
    const sp = ball.speed();
    const keeping = effectiveRating(this.keeper.data, 'keeping');
    const catchable = sp < 14 + (keeping / 99) * 8;
    if (catchable && ball.pos.z < 2.2) {
      this.pickUp(match);
    } else {
      // parry: kill most of the pace, deflect out and up — rebounds create drama
      const outY = Math.sign(ball.pos.y - 0) || 1;
      const away = this.team.attackDir; // away from our goal
      ball.vel = {
        x: Math.abs(ball.vel.x) * 0.25 * away + away * 4,
        y: outY * (4 + match.rng.next() * 6),
        z: 3 + match.rng.next() * 3,
      };
      ball.owner = null;
      ball.noControlTimer = 0.3;
      ball.noControlPlayer = k;
      match.events.emit({ type: 'save', keeperName: k.data.name, teamIdx: this.team.idx });
      match.shotResolved('save');
    }
  }

  private pickUp(match: Match): void {
    const ball = match.ball;
    ball.owner = null;
    ball.vel = { x: 0, y: 0, z: 0 };
    this.state = 'hold';
    this.holdTimer = 1.4;
    this.keeper.playAnim('collect', 0.5);
    match.events.emit({ type: 'save', keeperName: this.keeper.data.name, teamIdx: this.team.idx });
    match.shotResolved('save');
  }
}
