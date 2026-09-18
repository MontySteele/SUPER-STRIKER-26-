// Goalkeeper state machine (§6.3): POSITION → SET → REACT → DIVE/CLAIM/PARRY →
// RECOVER. Reaction delay scales with the Keeping stat; saves can parry into
// danger — rebounds are drama, not bugs.

import { clamp, dampAngle, dist2, norm2, sub2, v2, type V2 } from '../../core/math';
import { effectiveRating } from '../../data/loader';
import { BOX_DEPTH, BOX_HALF_W, GOAL_HALF_W, HALF_L, SIX_DEPTH } from '../constants';
import type { PlayerEntity } from '../player';
import type { Team } from '../team';
import type { Match } from '../match';

export type KState =
  | 'position' | 'set' | 'react' | 'dive' | 'getup' | 'recover' | 'hold' | 'smother';

/**
 * How long the keeper spends on the grass after a dive before he is upright.
 *
 * This is not a cosmetic delay — it is the window the get-up animation plays
 * in, and it is the reason he no longer teleports from flat on his face to a
 * standing idle in one frame. It matches the 1.0s the renderer keeps a
 * dive-bucket one-shot alive (PlayerEntity.update), so the clip finishes
 * exactly as he takes his first step back toward his line.
 */
const GETUP_SECONDS = 1.0;

/**
 * Ball height, at the point the keeper reaches it, that separates the three
 * saves he actually owns clips for (§6.3, CLIP_TABLE):
 *
 *   below LOW    a body block — chest behind it, down at his feet or at the
 *                near post. Also what a shot from inside `BLOCK_RANGE` gets
 *                whatever its height: there is no time to leave the ground.
 *   LOW..HIGH    the full-stretch diving save.
 *   above HIGH   he goes UP, not sideways — a jump catch if it is near enough
 *                to take standing, a top-corner dive if it is not.
 */
const DIVE_LOW_Z = 1.15;
const DIVE_HIGH_Z = 2.15;
/** Above this lateral distance a high ball is a dive, not a standing catch. */
const CATCH_REACH_Y = 1.1;
/** A shot struck closer than this is blocked, never dived at. */
const BLOCK_RANGE = 7;

/**
 * Below this he watches the BALL and steps sideways; above it he turns and
 * runs. Deliberately a hair under skinnedPlayer's SIDESTEP_MAX_SPEED (2.4),
 * which is the fastest a sidestep clip can be rate-matched to without going
 * past RATE_MAX — so the two hand over to each other rather than leaving a
 * band where he is facing the ball and playing a forward walk.
 */
const TRACK_MAX_SPEED = 2.3;
/** Seconds for half the turn onto the ball. Quick — a keeper's head is on it. */
const FACE_HALF_LIFE = 0.08;

// Distribution (§6.3). A throw is a PASS and is priced like one; a punt is a
// long ball and is priced like that.
/** Furthest he will roll one out by hand. Beyond it, he kicks. */
const THROW_RANGE = 30;
/** Closer than this and there is nothing to throw — he just plays it. */
const THROW_MIN = 7;
/** An opponent this close to the receiver means the short ball is a 50/50. */
const MARKED_RADIUS = 7;
/** An opponent this close to the KEEPER means get rid of it. */
const PRESSED_RADIUS = 11;
const THROW_SPEED = 15;
const PUNT_SPEED = 26;

// Smother (§6.3+): a dribbler carrying the ball deep into the box gets
// charged down and the ball claimed at their feet — the realistic answer to
// walking the ball into the net. Shots and chips still beat the charge.
const SMOTHER_TRIGGER_X = 12;   // carrier within this of the goal line
const SMOTHER_TRIGGER_Y = 13;
const SMOTHER_REACH = 7;        // keeper close enough to make the charge
const SMOTHER_BALL_MAX_Z = 0.6; // at the feet — a chip is not smotherable
// win% tuned down post-merge: with the keeper's shot coverage also fixed,
// 0.72 dragged matches to 1.56 goals — a spill to the byline still stops
// the walk-in, so the charge does its job either way
const SMOTHER_WIN_BASE = 0.55;  // + up to 0.18 by Keeping rating
const SMOTHER_COOLDOWN = 1.6;

export class KeeperBrain {
  state: KState = 'position';
  timer = 0;
  /** sim time at which the keeper reacts to the in-flight shot */
  reactAt = -1;
  holdTimer = 0;
  /**
   * The CLIP_TABLE row the renderer should play for this keeper's current
   * one-shot, or null for whatever the ActionAnim normally maps to.
   *
   * The sim's ActionAnim vocabulary is shared by every player on the pitch and
   * has three keeper entries in it ('diveL', 'diveR', 'collect'); the keeper's
   * repertoire is nine clips. Rather than widen a union that outfielders also
   * live in, the brain names the ROW and gameRenderer.feedKeeperState hands it
   * to SkinnedPlayerMesh.setKeeperState. The ANIM still comes from playAnim —
   * this only picks which animation that anim's window plays.
   */
  animClip: string | null = null;
  /** which way he went, so the get-up knows which shoulder he is on */
  private diveSide: 'L' | 'R' = 'L';
  private smotherCooldown = 0;

  constructor(public team: Team, public keeper: PlayerEntity) {}

  /** Arm a one-shot: the shared ActionAnim, plus the keeper-specific row. */
  private keeperAnim(anim: 'diveL' | 'diveR' | 'collect' | 'loft',
    clip: string | null, lock: number): void {
    this.animClip = clip;
    this.keeper.playAnim(anim, lock);
  }

  /**
   * Which save this is, from where the ball will be when he reaches it.
   * `range` is how far the shot was struck from — a close-range effort is
   * blocked whatever its height, because there is no time to leave the ground.
   */
  saveClip(side: 'L' | 'R', pz: number, dy: number, range: number): string {
    // travelling this far sideways is a full-stretch dive whatever the height:
    // a body-block clip under three metres of lateral movement is a slide
    if (Math.abs(dy) > 1.6) return `dive${side}`;
    if (range < BLOCK_RANGE || pz < DIVE_LOW_Z) return `diveLow${side}`;
    if (pz > DIVE_HIGH_Z && Math.abs(dy) < CATCH_REACH_Y) return 'catchHigh';
    return `dive${side}`;
  }

  /** True while the keeper has the ball in his hands (possession is frozen). */
  holding(): boolean {
    return this.state === 'hold';
  }

  /** Hard reset at kickoffs: stale 'hold' teleported the ball 44m into the
   *  keeper's gloves, and stale 'react' threw phantom dives at kickoff passes. */
  reset(): void {
    this.state = 'position';
    this.timer = 0;
    this.reactAt = -1;
    this.holdTimer = 0;
    this.smotherCooldown = 0;
    this.animClip = null;
    this.keeper.diving = false;
  }

  /**
   * The penalty controller drives the keeper itself (§6.5) while the brain's
   * own update() is not being ticked — the phase machine only runs KeeperBrain
   * in 'play'. Without this the renderer was fed a state left over from open
   * play for the whole shootout, which is how a diving keeper came to be
   * wearing a standing idle.
   */
  setScriptedState(state: KState, clip: string | null): void {
    if (this.state !== state) this.timer = 0;
    this.state = state;
    this.animClip = clip;
  }

  private goalX(): number {
    return -HALF_L * this.team.attackDir;
  }

  /** Called by Match when an opponent strikes a shot toward this goal. */
  onShot(match: Match): void {
    // 'getup' is in here because a keeper who is still on the grass cannot
    // throw himself at anything — his hands stay live in that state instead.
    if (this.state === 'dive' || this.state === 'hold' || this.state === 'getup') return;
    const keeping = effectiveRating(this.keeper.data, 'keeping');
    // 180–320ms by stat (§6.3); difficulty only slows CPU keepers (§6.6)
    let delay = 0.32 - (keeping / 99) * 0.14;
    if (!this.team.isHuman) delay *= match.difficulty.cpuKeeperReactMult;
    this.reactAt = match.simTime + delay;
    this.state = 'react';
  }

  /**
   * One tick of the keeper: decide, then AIM HIM.
   *
   * The aiming is a second pass on purpose. PlayerEntity.update turns every
   * player to face his own velocity, which is right for an outfielder and
   * wrong for the one man on the pitch whose job is to watch the ball while
   * moving across it — a keeper tracking a cross with his shoulders square to
   * his own run has no lateral component at all as far as the renderer is
   * concerned, so the sidestep clips never come up and he shuffles his line in
   * a walk cycle pointing the wrong way. Match runs this AFTER the players'
   * own integration (updatePlay), so what is set here is what the renderer
   * snapshots.
   */
  update(match: Match, dt: number): void {
    this.think(match, dt);
    this.faceBall(match, dt);
  }

  /**
   * Square to the ball while he is tracking; square to the RUN once he is
   * really moving, because past `TRACK_MAX_SPEED` the renderer is playing a
   * walk or a jog rather than a sidestep, and a run cycle pointed sideways is
   * the same defect from the other end.
   */
  private faceBall(match: Match, dt: number): void {
    const k = this.keeper;
    // the dive owns his body; 'hold' and 'getup' point him where they need him
    if (k.diving || this.state === 'hold' || this.state === 'getup') return;
    if (Math.hypot(k.vel.x, k.vel.y) > TRACK_MAX_SPEED) return;
    const b = match.ball.pos;
    const dx = b.x - k.pos.x, dy = b.y - k.pos.y;
    if (Math.hypot(dx, dy) < 0.4) return;
    k.facing = dampAngle(k.facing, Math.atan2(dy, dx), FACE_HALF_LIFE, dt);
  }

  private think(match: Match, dt: number): void {
    const k = this.keeper;
    const ball = match.ball;
    const gx = this.goalX();
    this.timer += dt;
    this.smotherCooldown = Math.max(0, this.smotherCooldown - dt);
    // A variant row outlives nothing. Once the sim's one-shot has expired the
    // renderer goes back to the ACTIONS default — otherwise the next ordinary
    // anim this player plays would come out as whatever the last save was.
    if (this.animClip && k.actionAnim === 'none') this.animClip = null;

    // A 3s celebration or dejection is an IN-PLACE performance that sits at
    // full weight over the locomotion layer — the chain is weighted by 1 minus
    // it, so for those three seconds his legs are switched off. Walking back to
    // his line under one is therefore a slide with a nice pose on it, and a
    // keeper who has just picked the ball out of his net has no reason to jog
    // anywhere anyway. He performs it where he stands; his hands stay live so a
    // restart taken quickly still finds a keeper, not a statue.
    if ((k.actionAnim === 'celebrate' || k.actionAnim === 'dejected')
        && this.state !== 'hold' && !k.diving) {
      k.stop();
      this.tryHands(match, 0.9);
      return;
    }

    // stray ball captured at the keeper's feet → immediate distribution
    if (ball.owner === k && this.state !== 'hold') {
      this.state = 'hold';
      this.holdTimer = 0.8;
      ball.owner = null;
      ball.vel = { x: 0, y: 0, z: 0 };
      k.facing = this.team.attackDir > 0 ? 0 : Math.PI; // face upfield, never the net
    }

    switch (this.state) {
      case 'hold': {
        // a phase change can move the ball out from under a frozen hold
        if (dist2(k.pos, { x: ball.pos.x, y: ball.pos.y }) > 3) {
          this.state = 'position';
          return;
        }
        this.holdTimer -= dt;
        ball.pos.x = clamp(k.pos.x + Math.cos(k.facing) * 0.5, -HALF_L + 0.3, HALF_L - 0.3);
        ball.pos.y = k.pos.y + Math.sin(k.facing) * 0.5;
        ball.pos.z = 0.9;
        ball.vel = { x: 0, y: 0, z: 0 };
        k.stop();
        if (this.holdTimer <= 0) this.distribute(match);
        return;
      }

      case 'dive': {
        if (!k.diving) {
          // he is on the grass, not standing: play the get-up and stay down
          // for as long as it takes. Going straight to 'recover' here is what
          // put a man flat on his face into a standing idle in one frame, and
          // then skated him back to his line.
          this.state = 'getup';
          this.timer = 0;
          this.keeperAnim(this.diveSide === 'L' ? 'diveL' : 'diveR', 'gkGetUp', GETUP_SECONDS);
        }
        this.tryHands(match, 1.15);
        return;
      }

      case 'getup': {
        k.stop();
        // hands stay live: a rebound landing next to a prone keeper is his
        this.tryHands(match, 1.0);
        if (this.timer >= GETUP_SECONDS) {
          this.animClip = null;
          this.state = 'recover';
          this.timer = 0;
        }
        return;
      }

      case 'recover': {
        k.stop();
        // the hands stay live while a shot is in flight — a micro-dive that
        // decayed instantly must not leave the keeper a ghost the ball
        // passes through (shots straight at him were automatic goals).
        // 0.85: enough to smother dead-center, not enough to erase near-miss
        // placement (1.0 dragged the match average under 2 goals)
        if (match.activeShot) this.tryHands(match, 0.85);
        // and don't go blind until that shot resolves, however long it takes
        if (this.timer > 0.7 && !match.activeShot) this.state = 'position';
        return;
      }

      case 'react': {
        // track the shot; commit to the dive once reaction time elapses —
        // but hands are live the whole time for balls already on top of him
        this.tryHands(match, 0.8);
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

    // how far the shot was struck from: a block, not a dive, inside BLOCK_RANGE
    const range = Math.hypot(ball.pos.x - k.pos.x, ball.pos.y - k.pos.y);

    if (Math.abs(dy) > reach || pz > 3.2 || pz < -0.3) {
      // can't get there — desperate full stretch anyway (looks right, sells the goal)
      const dir = Math.sign(dy || match.rng.noise());
      this.startDive(match, dir * Math.min(Math.abs(dy), reach), 0.9, pz, range);
      return;
    }
    this.startDive(match, dy, clamp(t, 0.12, 0.55), pz, range);
  }

  /**
   * `pz` is the ball's height where he reaches it and `range` how far the shot
   * came from: between them they pick WHICH save this is (saveClip). The arc
   * itself is unchanged — the animation follows the sim, never the other way
   * round.
   */
  private startDive(match: Match, dy: number, arriveIn: number,
    pz: number, range: number): void {
    const k = this.keeper;
    if (Math.abs(dy) < 0.4) {
      // straight at him: no sideways flop — hold ground in 'recover', whose
      // hands stay live every tick while the shot is in flight. (A one-shot
      // hands check here wedged him in 'set' with dead hands and made
      // dead-center the optimal finish from range.)
      this.state = 'recover';
      this.timer = 0;
      k.stop();
      // he still DOES something: a high ball straight at him is a jump catch,
      // one at his feet a body block, and neither is a man standing still
      if (pz > DIVE_HIGH_Z) this.keeperAnim('diveL', 'catchHigh', 0.6);
      else if (pz < DIVE_LOW_Z) this.keeperAnim('collect', 'collectLow', 0.4);
      this.tryHands(match, 1.0);
      return;
    }
    k.diving = true;
    k.diveVel = v2(0, dy / Math.max(arriveIn, 0.15));
    // cap dive velocity to something human
    const max = 11;
    if (Math.abs(k.diveVel.y) > max) k.diveVel.y = Math.sign(k.diveVel.y) * max;
    // 'R' is the keeper's own right, which is +y when he faces his attackDir
    this.diveSide = dy * this.team.attackDir > 0 ? 'R' : 'L';
    const anim = this.diveSide === 'R' ? 'diveR' : 'diveL';
    this.keeperAnim(anim, this.saveClip(this.diveSide, pz, dy, range), 0.9);
    this.state = 'dive';
    this.timer = 0;
  }

  /** Hands check: if the ball is within reach, catch or parry. */
  private tryHands(match: Match, radius: number): void {
    const k = this.keeper;
    const ball = match.ball;
    if (ball.noControlPlayer === k) return;
    // never rip a ball out of a player's active control — live react/recover
    // hands plus a stale activeShot could vacuum a dribbling striker's ball
    // and log a phantom 'save'
    if (ball.owner) return;
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
      match.events.emit({
        type: 'save', keeperName: k.data.name, teamIdx: this.team.idx,
        keeperNum: k.data.num, shotStop: true, // a parry is always a shot-stop
      });
      match.shotResolved('save');
    }
  }

  /**
   * Give it away (§6.3). Two deliveries, and the difference is the whole point
   * of having two clips for it:
   *
   *   THROW  a short overhand roll-out to a wide man he can actually find,
   *          when nobody is pressing. Flat, ~15 m/s, lands in front of him —
   *          which is what makes it a PASS rather than a 50/50, so it goes
   *          through registerPassAttempt like any other and the receiver comes
   *          to meet it.
   *   PUNT   the drop-kick, for when the near option is marked, pressed, or
   *          simply not there. Lofted, 26 m/s, and still registered — a
   *          contested clearance downfield is an attempted pass that usually
   *          fails, and the stats should say so.
   *
   * The clip is picked by which one this is, not by distance after the fact.
   */
  private distribute(match: Match): void {
    const k = this.keeper;
    const ball = match.ball;
    const mates = this.team.players.filter((p) => !p.isGK && !p.sentOff);
    const wide = mates.filter((p) => Math.abs(p.pos.y) > 8);
    // furthest upfield of the wide men, as before
    const pick = (list: PlayerEntity[]): PlayerEntity | null => list.length
      ? list.reduce((a, b) => ((a.pos.x - k.pos.x) * this.team.attackDir >
          (b.pos.x - k.pos.x) * this.team.attackDir ? a : b))
      : null;

    // A throw needs a man inside range who is not being sat on, and a keeper
    // who is not being closed down himself.
    const pressed = this.opponentWithin(match, k.pos, PRESSED_RADIUS);
    const near = pressed ? null : pick(wide.filter((p) => {
      const d = dist2(p.pos, k.pos);
      return d <= THROW_RANGE && d >= THROW_MIN
        && !this.opponentWithin(match, p.pos, MARKED_RADIUS);
    }));
    const target = near ?? pick(wide) ?? pick(mates) ?? this.team.players[5];
    const throwIt = near !== null;

    const dir = norm2(sub2(target.pos, k.pos));
    const aim: V2 = { x: target.pos.x, y: target.pos.y };
    if (throwIt) {
      // released from shoulder height, flat enough to arrive on the ground
      ball.pos.z = 1.5;
      ball.kick({ x: dir.x, y: dir.y, z: 0.12 }, THROW_SPEED, k);
      this.keeperAnim('loft', 'gkThrow', 0.3);
      match.events.emit({ type: 'kick', power: 0.55 });
    } else {
      ball.pos.z = 0.4;
      ball.kick({ x: dir.x * 0.75, y: dir.y * 0.75, z: 0.6 }, PUNT_SPEED, k);
      this.keeperAnim('loft', 'gkPunt', 0.3);
      match.events.emit({ type: 'kick', power: 0.9 });
    }
    // it counts as a pass either way: the receiver's come-to-the-ball
    // behaviour, the offside line check and the team's pass tally all hang off
    // this call, and a keeper's distribution is not exempt from any of them
    match.registerPassAttempt(k, target, aim);
    this.state = 'position';
  }

  /** Any opponent inside `r` of a point — pressure, in one line. */
  private opponentWithin(match: Match, at: V2, r: number): boolean {
    const them = match.teams[1 - this.team.idx];
    return them.players.some((p) => !p.sentOff && dist2(p.pos, at) < r);
  }

  private pickUp(match: Match): void {
    const ball = match.ball;
    const k = this.keeper;
    // WHICH catch, from where the ball actually is when he takes it: at his
    // feet, at his chest, or above his head — and, for a high one, whether he
    // is standing still or claiming it on the run.
    const z = ball.pos.z;
    const moving = Math.hypot(k.vel.x, k.vel.y) > 2.2;
    const clip = z > DIVE_HIGH_Z ? (moving ? 'catchHighRun' : 'catchHigh')
      : z < 0.55 ? 'collectLow' : 'collect';
    ball.owner = null;
    ball.vel = { x: 0, y: 0, z: 0 };
    this.state = 'hold';
    this.holdTimer = 1.4;
    this.keeper.facing = this.team.attackDir > 0 ? 0 : Math.PI; // never toward the net
    // a high claim needs the dive-length window (1.0s); a collect is 0.42s
    this.keeperAnim(z > DIVE_HIGH_Z ? 'diveL' : 'collect', clip, 0.5);
    match.events.emit({
      type: 'save', keeperName: this.keeper.data.name, teamIdx: this.team.idx,
      keeperNum: this.keeper.data.num,
      // only a pickup with a live shot in flight is a real stop; the rest are
      // routine collections that must not shout WHAT A SAVE or farm MOTM
      shotStop: match.activeShot !== null,
    });
    match.shotResolved('save');
  }
}
