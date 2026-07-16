// Penalties (§6.5): shooter aims with the stick (reticle fades at higher
// difficulty), holds for power — full power risks blazing over. Keeper picks a
// dive just before contact (human: stick; CPU: tendency read + bias noise).
// Used for both in-match penalty kicks and full shootouts. Sudden death after 5.

import { clamp, v2, type V2 } from '../core/math';
import { effectiveRating } from '../data/loader';
import { GOAL_HALF_W, GOAL_HEIGHT, HALF_L, PENALTY_SPOT } from './constants';
import type { PlayerEntity } from './player';
import type { Match } from './match';

export type PenPhase = 'setup' | 'aim' | 'strike' | 'resolve' | 'done';
export type PenResult = 'goal' | 'saved' | 'missed';

export interface ShootoutBoard {
  kicks: [PenResult[], PenResult[]];
  scores: [number, number];
  kickingTeam: number;
  round: number;
  suddenDeath: boolean;
}

export class PenaltyController {
  phase: PenPhase = 'setup';
  timer = 0;
  /** which end the kicks are taken at (+1 → +x goal) */
  goalSide = 1;
  taker!: PlayerEntity;
  keeper!: PlayerEntity;
  kickingTeam = 0;
  /** live reticle position while aiming: -1..1 across goal */
  aimX = 0;
  aimPower = 0;
  charging = false;
  /** power hold time accumulated DURING the aim phase only — a shoot button
   *  still held from before the whistle must not fire an instant max shot */
  chargeT = 0;
  private cpuAimTarget = 0;
  private cpuStrikeAt = 0;
  private keeperGuess = 0; // -1 | 0 | 1 (pitch-y sign)
  private resolveResult: PenResult | null = null;
  private keeperTouched = false;

  // shootout state (unused for single in-match kicks)
  board: ShootoutBoard | null = null;
  winnerIdx: number | null = null;

  constructor(private match: Match, public mode: 'single' | 'shootout') {}

  /** Begin a shootout series. */
  startShootout(): void {
    this.board = {
      kicks: [[], []],
      scores: [0, 0],
      kickingTeam: this.match.rng.next() < 0.5 ? 0 : 1,
      round: 1,
      suddenDeath: false,
    };
    this.goalSide = 1;
    this.beginKick(this.board.kickingTeam);
  }

  /** Begin a single in-match penalty for `teamIdx` at the goal they attack. */
  startSingle(teamIdx: number): void {
    this.goalSide = this.match.teams[teamIdx].attackDir;
    this.beginKick(teamIdx);
  }

  private beginKick(teamIdx: number): void {
    const m = this.match;
    this.kickingTeam = teamIdx;
    const team = m.teams[teamIdx];
    const defending = m.teams[1 - teamIdx];
    // best available shooter steps up; shootouts rotate through the list
    const shooters = team.players
      .filter((p) => !p.isGK && !p.sentOff)
      .sort((a, b) => effectiveRating(b.data, 'shooting') - effectiveRating(a.data, 'shooting'));
    const kickNum = this.board ? this.board.kicks[teamIdx].length : 0;
    this.taker = shooters[kickNum % shooters.length];
    this.keeper = defending.keeper;
    this.phase = 'setup';
    this.timer = 0;
    this.aimX = 0;
    this.aimPower = 0;
    this.charging = false;
    this.chargeT = 0;
    this.resolveResult = null;
    this.keeperTouched = false;
    this.keeperGuess = 0;

    const gx = HALF_L * this.goalSide;
    const spot: V2 = { x: gx - PENALTY_SPOT * this.goalSide, y: 0 };
    m.ball.reset(spot.x, spot.y);
    this.taker.pos = { x: spot.x - 4 * this.goalSide, y: 1.5 };
    this.taker.facing = this.goalSide > 0 ? 0 : Math.PI;
    this.taker.vel = v2();
    this.keeper.pos = { x: gx - 0.5 * this.goalSide, y: 0 };
    this.keeper.facing = this.goalSide > 0 ? Math.PI : 0;
    this.keeper.vel = v2();
    this.keeper.diving = false;
    this.keeper.actionAnim = 'none';
    // everyone else waits around the arc
    let i = 0;
    for (const t of m.teams) {
      for (const p of t.players) {
        if (p === this.taker || p === this.keeper || p.sentOff) continue;
        const a = Math.PI * 0.55 + (i % 12) * 0.16;
        p.pos = {
          x: spot.x - Math.cos(a) * (11 + (i % 3)) * this.goalSide * 0.9 - 8 * this.goalSide,
          y: Math.sin(a) * (i % 2 ? 1 : -1) * (10 + (i % 5)),
        };
        p.vel = v2();
        p.facing = this.goalSide > 0 ? 0 : Math.PI;
        i++;
      }
    }
    // CPU shooter picks its spot now
    const skill = effectiveRating(this.taker.data, 'shooting') / 99;
    this.cpuAimTarget = (m.rng.next() < 0.5 ? -1 : 1) * (0.55 + m.rng.next() * 0.4);
    this.cpuStrikeAt = 1.1 + m.rng.next() * 0.9;
    void skill;
    m.events.emit({ type: 'penTension' });
  }

  private takerSeat() {
    return this.match.seats[this.kickingTeam];
  }

  private keeperSeat() {
    return this.match.seats[1 - this.kickingTeam];
  }

  update(dt: number): void {
    const m = this.match;
    this.timer += dt;
    const gx = HALF_L * this.goalSide;

    switch (this.phase) {
      case 'setup': {
        if (this.timer > 1.3) {
          this.phase = 'aim';
          this.timer = 0;
          this.takerSeat()?.clearBuffers();
        }
        break;
      }

      case 'aim': {
        const seat = this.takerSeat();
        if (seat) {
          // human taker: stick aims (screen-right = stick-right whichever end),
          // hold shoot for power, release to strike
          const stick = seat.getStick();
          this.aimX = clamp(this.aimX + stick.x * this.goalSide * dt * 2.4, -1, 1);
          if (seat.isHeld('shoot')) {
            this.charging = true;
            this.chargeT += dt; // only aim-phase hold time counts toward power
          }
          const rel = seat.consumeRelease('shoot');
          if (rel || (this.charging && this.chargeT > 0.9)) {
            this.aimPower = clamp(this.chargeT / 0.9, 0.25, 1);
            this.strike();
          } else if (this.charging && !seat.isHeld('shoot')) {
            // held state dropped with no release edge (blur / pad unplugged):
            // cancel the charge — the kick must never take itself
            this.charging = false;
            this.chargeT = 0;
          } else if (this.timer > 9) {
            // dawdling: the ref makes you take it
            this.aimPower = 0.55;
            this.strike();
          }
        } else {
          // CPU taker: settle on target, strike on its own clock
          this.aimX = this.aimX + (this.cpuAimTarget - this.aimX) * dt * 3;
          if (this.timer >= this.cpuStrikeAt) {
            this.aimPower = 0.55 + m.rng.next() * 0.4;
            this.strike();
          }
        }
        // keeper sways on the line
        this.keeper.pos.y = Math.sin(this.timer * 2.2) * 0.35;
        break;
      }

      case 'strike': {
        // ball is in flight; keeper dive already committed
        m.ball.update(dt);
        this.containBall();
        this.keeper.update(dt);
        this.taker.update(dt); // follow-through — don't freeze mid wind-up
        this.checkKeeperHands();
        const b = m.ball.pos;
        const pastLine = (b.x - gx) * this.goalSide > 0.1;
        const stopped = m.ball.speed() < 2 && this.timer > 0.6;
        if (pastLine || stopped || this.timer > 2.2) {
          this.resolveKick(pastLine);
        }
        break;
      }

      case 'resolve': {
        m.ball.update(dt);
        this.containBall();
        this.keeper.update(dt);
        for (const p of [this.taker]) p.update(dt);
        if (this.timer > 2.4) this.advance();
        break;
      }

      case 'done':
        break;
    }
  }

  /** The net (or the hoardings) stop the ball — it never leaves the world. */
  private containBall(): void {
    const b = this.match.ball;
    if (Math.abs(b.pos.x) > HALF_L + 0.4) {
      b.vel.x *= 0.75;
      b.vel.y *= 0.75;
      b.vel.z = Math.min(b.vel.z, 0);
      b.pos.x = clamp(b.pos.x, -HALF_L - 2, HALF_L + 2);
      b.pos.y = clamp(b.pos.y, -GOAL_HALF_W - 2, GOAL_HALF_W + 2);
    }
  }

  private strike(): void {
    const m = this.match;
    const skill = effectiveRating(this.taker.data, 'shooting') / 99;
    // error: low skill and high power spray the shot
    const err = (1 - skill) * 0.35 + Math.pow(this.aimPower, 2.5) * 0.3;
    const aimY = this.aimX * (GOAL_HALF_W - 0.25) + m.rng.noise() * err * 2.4;
    let height = 0.35 + this.aimPower * 1.15 + Math.max(0, m.rng.noise()) * err * 1.6;
    // full power blazes over sometimes (§6.5)
    if (this.aimPower > 0.88 && m.rng.next() < 0.35) height = GOAL_HEIGHT + 0.6 + m.rng.next();

    const gx = HALF_L * this.goalSide;
    const dx = (gx - m.ball.pos.x) * this.goalSide; // 11m
    const speed = 17 + this.aimPower * 10;
    const flight = dx / (speed * 0.96);
    // solve rough z velocity to arrive at `height` at the line
    const vz = (height - m.ball.pos.z + 0.5 * 12.5 * flight * flight) / flight;
    const dirY = (aimY - m.ball.pos.y) / dx;
    m.ball.kick({ x: this.goalSide, y: dirY, z: vz / speed }, speed, this.taker);
    this.taker.playAnim('shoot', 0.4);
    m.events.emit({ type: 'kick', power: this.aimPower });

    // keeper commits: human picks with stick, CPU guesses with a slight read
    const kSeat = this.keeperSeat();
    if (kSeat) {
      // human keeper: stick left/right (screen space) picks the dive
      const s = kSeat.getStick();
      this.keeperGuess = Math.abs(s.x) > 0.3 ? Math.sign(s.x) * this.goalSide : 0;
    } else {
      const read = m.rng.next() < (m.difficulty.cpuNoise < 0.8 ? 0.45 : 0.3);
      if (read) this.keeperGuess = Math.sign(aimY) || 0;
      else {
        const r = m.rng.next();
        this.keeperGuess = r < 0.42 ? -1 : r < 0.84 ? 1 : 0;
      }
    }
    const keeping = effectiveRating(this.keeper.data, 'keeping') / 99;
    const diveSpeed = (6.5 + keeping * 3.5) * (this.keeperGuess === 0 ? 0 : 1);
    this.keeper.diving = this.keeperGuess !== 0;
    this.keeper.diveVel = v2(0, this.keeperGuess * diveSpeed);
    if (this.keeperGuess !== 0) {
      this.keeper.playAnim(
        (this.keeperGuess > 0) === (this.goalSide > 0) ? 'diveL' : 'diveR', 1.0,
      );
    }
    this.phase = 'strike';
    this.timer = 0;
  }

  private checkKeeperHands(): void {
    if (this.keeperTouched) return;
    const m = this.match;
    const b = m.ball.pos;
    const keeping = effectiveRating(this.keeper.data, 'keeping') / 99;
    const reach = 0.9 + keeping * 0.35;
    const d = Math.hypot(b.x - this.keeper.pos.x, b.y - this.keeper.pos.y, (b.z - 1.2) * 0.75);
    if (d < reach && b.z < 2.4) {
      this.keeperTouched = true;
      // parry: kill pace, deflect away from goal
      m.ball.vel = {
        x: -this.goalSide * (3 + m.rng.next() * 5),
        y: Math.sign(b.y || 1) * (2 + m.rng.next() * 4),
        z: 2.5 + m.rng.next() * 2,
      };
    }
  }

  private resolveKick(pastLine: boolean): void {
    const m = this.match;
    const b = m.ball.pos;
    let result: PenResult;
    if (pastLine && Math.abs(b.y) < GOAL_HALF_W && b.z < GOAL_HEIGHT) {
      result = 'goal';
    } else if (this.keeperTouched) {
      result = 'saved';
    } else {
      result = 'missed';
    }
    this.resolveResult = result;
    this.phase = 'resolve';
    this.timer = 0;

    if (result === 'goal') this.taker.playAnim('celebrate', 2);
    else this.taker.playAnim('dejected', 2);
    if (result === 'saved') this.keeper.playAnim('celebrate', 2);

    if (this.board) {
      this.board.kicks[this.kickingTeam].push(result);
      if (result === 'goal') this.board.scores[this.kickingTeam]++;
    }
    m.events.emit({
      type: 'penKick',
      teamIdx: this.kickingTeam,
      takerName: this.taker.data.name,
      result,
    });
  }

  private advance(): void {
    const m = this.match;
    if (this.mode === 'single') {
      this.phase = 'done';
      m.resolveSinglePenalty(this.resolveResult ?? 'missed');
      return;
    }
    const bd = this.board!;
    // decided? compare with kicks remaining in the current set of 5
    const [a, b] = bd.scores;
    const taken = [bd.kicks[0].length, bd.kicks[1].length];
    if (!bd.suddenDeath) {
      const remA = 5 - taken[0], remB = 5 - taken[1];
      if (a > b + remB || b > a + remA) return this.finish(a > b ? 0 : 1);
      if (taken[0] >= 5 && taken[1] >= 5) {
        if (a !== b) return this.finish(a > b ? 0 : 1);
        bd.suddenDeath = true;
      }
    } else if (taken[0] === taken[1] && a !== b) {
      return this.finish(a > b ? 0 : 1);
    }
    // next kicker: alternate
    bd.kickingTeam = 1 - bd.kickingTeam;
    bd.round = Math.max(taken[0], taken[1]) + 1;
    this.beginKick(bd.kickingTeam);
  }

  private finish(winnerIdx: number): void {
    this.winnerIdx = winnerIdx;
    this.phase = 'done';
    this.match.events.emit({ type: 'shootoutEnd', winnerIdx });
  }
}
