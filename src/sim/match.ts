// Match orchestrator: fixed-timestep sim, human control (1–2 seats), possession
// model, referee (bounds / goals / fouls / cards / penalties), extra time and
// shootouts for knockout draws, and the match state machine.

import { clamp, dist2, len2, norm2, sub2, v2, type V2 } from '../core/math';
import { EventBus } from '../core/events';
import { RNG } from '../core/rng';
import type { TeamData } from '../data/types';
import { effectiveRating } from '../data/loader';
import type { PlayerInput } from '../input/input';
import {
  bestPassTarget, executeLoft, executeShortPass, executeShot, executeThrough,
} from './actions';
import { cpuDribble, cpuOnBallDecision } from './ai/onBall';
import { assignDefense, updateDefender } from './ai/defense';
import { KeeperBrain } from './ai/keeper';
import { runTarget, shapeTarget } from './ai/teamShape';
import { Ball } from './ball';
import {
  BOX_DEPTH, BOX_HALF_W, CPU_DECISION_TICK, GOAL_HALF_W, GOAL_HEIGHT, HALF_L,
  HALF_W, PLAYER_CONTROL_RADIUS, PLAYER_TACKLE_RADIUS, SHOT_MAX_HOLD, SIM_DT,
  SIX_DEPTH,
} from './constants';
import { OffsideTracker } from './offside';
import { PenaltyController, type PenResult } from './penalty';
import type { PlayerEntity } from './player';
import { Team } from './team';

export type MatchPhase =
  | 'kickoff' | 'play' | 'restart' | 'goalseq'
  | 'break' | 'penalty' | 'shootout' | 'fulltime';
export type RestartKind = 'throwIn' | 'corner' | 'goalKick' | 'freeKick';
export type DifficultyName = 'amateur' | 'pro' | 'legend';

export interface Difficulty {
  cpuNoise: number;            // scales CPU decision jitter
  cpuKeeperReactMult: number;  // >1 = slower CPU keeper
  humanShotErrMult: number;    // <1 = more forgiving human shots
  cpuSprint: boolean;          // CPU allowed to sprint freely
}

export const DIFFICULTIES: Record<DifficultyName, Difficulty> = {
  amateur: { cpuNoise: 1.7, cpuKeeperReactMult: 1.3, humanShotErrMult: 0.75, cpuSprint: false },
  pro:     { cpuNoise: 1.0, cpuKeeperReactMult: 1.0, humanShotErrMult: 1.0, cpuSprint: true },
  legend:  { cpuNoise: 0.5, cpuKeeperReactMult: 0.85, humanShotErrMult: 1.15, cpuSprint: true },
};

interface RestartInfo {
  kind: RestartKind;
  teamIdx: number;
  pos: V2;
  timer: number;
  taker: PlayerEntity;
}

interface ActiveShot {
  shooter: PlayerEntity;
  time: number;
}

export interface MatchOptions {
  home: TeamData;
  away: TeamData;
  /** one input seat per team; null = CPU */
  seats: [PlayerInput | null, PlayerInput | null];
  halfLengthSec: number;       // real seconds per half
  difficulty: DifficultyName;
  /** knockout: a draw goes to extra time → penalties */
  knockout?: boolean;
  /** shootout: straight to penalties. golden: no clock, next goal wins. */
  mode?: 'match' | 'shootout' | 'golden';
  seed?: number;
}

export class Match {
  teams: [Team, Team];
  ball = new Ball();
  rng: RNG;
  events = new EventBus();
  offside = new OffsideTracker();
  keepers: [KeeperBrain, KeeperBrain];
  difficulty: Difficulty;
  seats: [PlayerInput | null, PlayerInput | null];

  phase: MatchPhase = 'kickoff';
  phaseTimer = 0;
  breakLabel = '';
  half = 1;
  simTime = 0;        // total sim seconds, always advancing
  clock = 0;          // in-play seconds of the current half
  halfLength: number;
  knockout: boolean;
  mode: 'match' | 'shootout' | 'golden';
  kickoffTeam = 0;
  restart: RestartInfo | null = null;
  penalty: PenaltyController | null = null;
  /** set when a knockout tie was decided on penalties */
  shootoutWinner: number | null = null;

  possessionTeam = 0;
  controlled: [PlayerEntity | null, PlayerEntity | null] = [null, null];
  /** Every goal of the match, in order — feeds the tournament Golden Boot. */
  goalLog: { teamIdx: number; scorerName: string; ownGoal: boolean; minute: number }[] = [];

  private cpuDecisionTimers = [0, 0];
  /** Seconds of possession without reaching the final third (per team). */
  buildupTime = [0, 0];
  private activeShot: ActiveShot | null = null;
  private shotCharging = [false, false];
  private buildupTimer = 0;
  private prevBallPos: V2 = v2();
  private tackleCooldowns = new Map<PlayerEntity, number>();
  private deferred: { at: number; fn: () => void }[] = [];
  private lastGoalTeamIdx = 0;
  private firstKickoffTeam = 0;
  /** teamIdx whose penalty resumes as this restart after resolve */
  private pendingPenaltyTeam: number | null = null;

  constructor(public opts: MatchOptions) {
    this.rng = new RNG(opts.seed ?? 0xC0FFEE);
    this.seats = opts.seats;
    this.teams = [
      new Team(opts.home, 0, 1, opts.seats[0] !== null),
      new Team(opts.away, 1, -1, opts.seats[1] !== null),
    ];
    this.keepers = [
      new KeeperBrain(this.teams[0], this.teams[0].keeper),
      new KeeperBrain(this.teams[1], this.teams[1].keeper),
    ];
    this.halfLength = opts.halfLengthSec;
    this.knockout = opts.knockout ?? false;
    this.mode = opts.mode ?? 'match';
    this.difficulty = DIFFICULTIES[opts.difficulty];
    this.offside.match = this;
    if (this.mode === 'shootout') {
      this.teams[0].lineUp(false);
      this.teams[1].lineUp(false);
      this.beginShootout();
    } else {
      this.setupKickoff(0);
    }
  }

  get allPlayers(): PlayerEntity[] {
    return [...this.teams[0].players, ...this.teams[1].players];
  }

  private halfLenFor(half: number): number {
    return half <= 2 ? this.halfLength : this.halfLength / 3;
  }

  /** Display minute for the HUD/ticker (45-min halves; 15-min ET periods). */
  displayMinute(): number {
    const bases = [0, 0, 45, 90, 105];
    const spans = [45, 45, 45, 15, 15];
    const base = bases[this.half] ?? 0;
    const span = spans[this.half] ?? 45;
    return Math.min(base + Math.floor((this.clock / this.halfLenFor(this.half)) * span), base + span);
  }

  secondLastDefenderX(teamIdx: number): number {
    const t = this.teams[teamIdx];
    const xs = t.players.filter((p) => !p.sentOff)
      .map((p) => p.pos.x * -t.attackDir).sort((a, b) => b - a);
    const second = xs[1] ?? 0;
    return second * -t.attackDir;
  }

  // ---------------------------------------------------------------- kickoff

  setupKickoff(kickingTeam: number): void {
    this.kickoffTeam = kickingTeam;
    this.phase = 'kickoff';
    this.phaseTimer = 0;
    this.ball.reset(0, 0);
    this.offside.clear();
    this.activeShot = null;
    this.teams[0].lineUp(kickingTeam === 0);
    this.teams[1].lineUp(kickingTeam === 1);
    for (let i = 0; i < 2; i++) {
      this.controlled[i] = this.seats[i] ? this.nearestOutfield(this.teams[i], v2(0, 0)) : null;
      this.shotCharging[i] = false;
    }
  }

  private nearestOutfield(team: Team, to: V2): PlayerEntity {
    const pool = team.players.filter((p) => !p.isGK && !p.sentOff);
    return pool.reduce((a, b) => (dist2(a.pos, to) < dist2(b.pos, to) ? a : b));
  }

  // ---------------------------------------------------------------- main tick

  update(): void {
    const dt = SIM_DT;
    this.simTime += dt;
    this.phaseTimer += dt;

    // deferred one-shots (slide resolutions, shootout → full time) run in
    // every phase — a shootout has no 'play' ticks to piggyback on
    this.deferred = this.deferred.filter((d) => {
      if (this.simTime >= d.at) { d.fn(); return false; }
      return true;
    });

    switch (this.phase) {
      case 'kickoff': this.updateKickoff(dt); break;
      case 'play': this.updatePlay(dt); break;
      case 'restart': this.updateRestart(dt); break;
      case 'goalseq': this.updateGoalSeq(dt); break;
      case 'penalty':
      case 'shootout':
        this.penalty?.update(dt);
        break;
      case 'break':
      case 'fulltime':
        break;
    }
  }

  private updateKickoff(dt: number): void {
    const t = this.teams[this.kickoffTeam];
    const taker = this.nearestOutfield(t, v2(0, 0));
    taker.moveToward(v2(0, 0), 0.8);
    for (const team of this.teams) {
      for (const p of team.players) {
        if (p === taker) continue;
        p.moveToward(p.pos, 0); // hold position
      }
    }
    for (const p of this.allPlayers) p.update(dt);

    const seat = this.seats[this.kickoffTeam];
    const ready = dist2(taker.pos, v2(0, 0)) < 1.6 && this.phaseTimer > 0.6;
    const go = ready && (seat
      ? (seat.consumePress('pass', 600) || this.phaseTimer > 4)
      : this.phaseTimer > 1.4);
    if (go) {
      // never the taker himself (norm2(0,0) would launch the ball vertically)
      const pool = t.players.filter((p) => p !== taker && p.role === 'MF' && !p.sentOff);
      const fallback = t.players.filter((p) => p !== taker && !p.isGK && !p.sentOff);
      const mate = (pool.length ? pool : fallback)
        .reduce((a, b) => (dist2(a.pos, taker.pos) < dist2(b.pos, taker.pos) ? a : b));
      const dir = norm2(sub2(mate.pos, taker.pos));
      this.ball.kick({ x: dir.x, y: dir.y, z: 0.02 }, 9, taker);
      taker.playAnim('pass', 0.2);
      this.phase = 'play';
      this.events.emit({ type: 'kickoff', half: this.half });
      if (this.seats[mate.teamIdx]) this.controlled[mate.teamIdx] = mate;
      seat?.clearBuffers();
    }
  }

  // ---------------------------------------------------------------- open play

  private updatePlay(dt: number): void {
    this.clock += dt;
    this.prevBallPos = v2(this.ball.pos.x, this.ball.pos.y);
    const prevZ = this.ball.pos.z;

    this.updatePossession(dt);
    this.updateHumanControl(dt);
    this.updateAI(dt);
    for (const p of this.allPlayers) p.update(dt);
    this.updateDribble(dt);
    this.ball.update(dt);
    this.keepers[0].update(this, dt);
    this.keepers[1].update(this, dt);
    this.checkGoalAndBounds(prevZ);
    this.updateStatsAndCrowd(dt);

    // period end (wait for a neutral-ish moment: ball below head height);
    // golden goal has no clock — it only ends when somebody scores
    if (this.mode !== 'golden'
      && this.clock >= this.halfLenFor(this.half) && this.ball.pos.z < 2 && this.phase === 'play') {
      this.endPeriod();
    }
  }

  private endPeriod(): void {
    const tied = this.teams[0].score === this.teams[1].score;
    if (this.half === 1) {
      this.enterBreak('HALF-TIME');
    } else if (this.half === 2) {
      if (this.knockout && tied) this.enterBreak('EXTRA TIME');
      else this.finishMatch();
    } else if (this.half === 3) {
      this.enterBreak('ET HALF-TIME');
    } else {
      if (tied) this.enterBreak('PENALTIES');
      else this.finishMatch();
    }
  }

  private enterBreak(label: string): void {
    this.phase = 'break';
    this.breakLabel = label;
    this.events.emit({ type: 'break', label });
  }

  private finishMatch(): void {
    if (this.phase === 'fulltime') return;
    // a knockout tie must never slip through to full time undecided
    if (this.knockout && this.mode === 'match'
      && this.teams[0].score === this.teams[1].score && this.shootoutWinner === null) {
      if (this.phase !== 'shootout') this.beginShootout();
      return;
    }
    this.phase = 'fulltime';
    this.events.emit({ type: 'fulltime' });
  }

  /** Resume from a break card (UI calls this on button press). */
  continueFromBreak(): void {
    if (this.phase !== 'break') return;
    if (this.breakLabel === 'PENALTIES') {
      this.beginShootout();
      return;
    }
    this.half++;
    this.clock = 0;
    for (const t of this.teams) t.attackDir *= -1;
    const kicking = this.half === 2 || this.half === 4
      ? 1 - this.firstKickoffTeam
      : this.firstKickoffTeam;
    this.setupKickoff(kicking);
  }

  private beginShootout(): void {
    if (this.penalty?.mode === 'shootout') return;
    this.phase = 'shootout';
    this.penalty = new PenaltyController(this, 'shootout');
    this.penalty.startShootout();
    this.events.on((e) => {
      if (e.type === 'shootoutEnd') {
        this.shootoutWinner = e.winnerIdx;
        // brief beat, then full time
        this.deferred.push({ at: this.simTime + 2.5, fn: () => this.finishMatch() });
      }
    });
  }

  /** Winner index counting a shootout if one happened (for tournaments). */
  winner(): number | null {
    if (this.teams[0].score > this.teams[1].score) return 0;
    if (this.teams[1].score > this.teams[0].score) return 1;
    return this.shootoutWinner;
  }

  // ---------------------------------------------------------------- possession

  private updatePossession(dt: number): void {
    const ball = this.ball;
    for (const [p, t] of this.tackleCooldowns) {
      const nt = t - dt;
      if (nt <= 0) this.tackleCooldowns.delete(p); else this.tackleCooldowns.set(p, nt);
    }

    if (ball.owner) {
      // tackle contests: nearby opponents nibble at the ball
      const carrier = ball.owner;
      for (const opp of this.teams[1 - carrier.teamIdx].players) {
        if (opp.diving || opp.sentOff || (this.tackleCooldowns.get(opp) ?? 0) > 0) continue;
        const d = dist2(opp.pos, carrier.pos);
        if (d < PLAYER_TACKLE_RADIUS) {
          const def = effectiveRating(opp.data, 'defending');
          const ctrl = effectiveRating(carrier.data, 'passing');
          const winChance = clamp(0.25 + (def - ctrl) / 200, 0.08, 0.55) * dt * 3.2;
          this.tackleCooldowns.set(opp, 0.5);
          if (this.rng.next() < winChance) {
            const dir = norm2({
              x: this.teams[opp.teamIdx].attackDir + this.rng.noise() * 0.8,
              y: this.rng.noise(),
            });
            ball.kick({ x: dir.x, y: dir.y, z: 0.08 }, 6 + this.rng.next() * 4, opp);
            // lock out the ROBBED man, not the tackler — the ball pops loose
            // at the carrier's feet, and without this he re-collects it before
            // it can leave his control radius (a parked carrier became
            // literally undispossessable)
            ball.noControlPlayer = carrier;
            ball.noControlTimer = 0.45;
            opp.playAnim('pass', 0.2);
            carrier.actionLock = Math.max(carrier.actionLock, 0.3);
            this.events.emit({ type: 'tackle' });
          }
        }
      }
      return;
    }

    // loose ball: who captures it?
    if (ball.pos.z > 1.5) return;
    let best: PlayerEntity | null = null;
    let bestD = PLAYER_CONTROL_RADIUS;
    for (const p of this.allPlayers) {
      if (p.diving || p.sentOff) continue;
      // keepers use hands via KeeperBrain; feet only for slow stray balls
      if (p.isGK && ball.speed() > 6) continue;
      if (ball.noControlPlayer === p) continue;
      if (p.actionAnim === 'slide') continue;
      const d = dist2(p.pos, { x: ball.pos.x, y: ball.pos.y });
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) return;

    // offside flag is raised the moment the receiver touches it
    if (this.offside.checkTouch(best)) {
      this.events.emit({
        type: 'offside', teamIdx: best.teamIdx, playerName: best.data.name,
        minute: this.displayMinute(),
      });
      this.beginRestart('freeKick', 1 - best.teamIdx, v2(best.pos.x, best.pos.y));
      return;
    }

    const sp = ball.speed();
    const skill = effectiveRating(best.data, 'passing');
    if (sp > 12) {
      const trapChance = clamp((skill / 99) * (1 - (sp - 12) / 22), 0.1, 0.92);
      if (this.rng.next() > trapChance) {
        ball.vel.x *= -0.25 + this.rng.noise() * 0.2;
        ball.vel.y *= 0.4 + this.rng.noise() * 0.3;
        ball.vel.z = Math.abs(ball.vel.z) * 0.3 + 1.2;
        ball.noControlTimer = 0.2;
        ball.noControlPlayer = best;
        ball.lastTouch = best;
        return;
      }
    }

    // clean capture
    ball.owner = best;
    ball.lastTouch = best;
    ball.vel = { x: best.vel.x, y: best.vel.y, z: 0 };
    ball.spinY = 0;
    if (this.possessionTeam !== best.teamIdx) {
      this.possessionTeam = best.teamIdx;
      this.events.emit({ type: 'possessionChange', teamIdx: best.teamIdx });
    }
    this.cpuDecisionTimers[best.teamIdx] = CPU_DECISION_TICK * 0.5;
    if (this.activeShot && best.teamIdx !== this.activeShot.shooter.teamIdx) this.activeShot = null;
    // auto-switch: humans always control the teammate on the ball
    if (this.seats[best.teamIdx]) {
      this.controlled[best.teamIdx] = best;
      this.shotCharging[best.teamIdx] = false;
    }
  }

  /** Close control: the ball is repeatedly touched ahead, never glued (§6.1). */
  private updateDribble(dt: number): void {
    const ball = this.ball;
    const owner = ball.owner;
    if (!owner) return;
    if (owner.actionLock > 0.05 && owner.actionAnim !== 'none' && owner.actionAnim !== 'pass') {
      return; // mid-kick: ball has already been struck
    }
    const speed = len2(owner.vel);
    const foot: V2 = {
      x: owner.pos.x + Math.cos(owner.facing) * 0.55,
      y: owner.pos.y + Math.sin(owner.facing) * 0.55,
    };
    const d = dist2({ x: ball.pos.x, y: ball.pos.y }, foot);

    if (owner.sprinting && speed > 5.5) {
      ball.kick(
        { x: Math.cos(owner.facing), y: Math.sin(owner.facing), z: 0.01 },
        speed * 1.18 + 1.2, owner,
      );
      ball.noControlTimer = 0.18;
      return;
    }

    if (d > PLAYER_CONTROL_RADIUS * 1.6) {
      ball.owner = null; // lost it (turn too sharp)
      return;
    }
    const pull = clamp(d * 14, 0, speed + 7);
    const dir = norm2(sub2(foot, { x: ball.pos.x, y: ball.pos.y }));
    ball.vel.x = owner.vel.x + dir.x * pull;
    ball.vel.y = owner.vel.y + dir.y * pull;
    if (ball.pos.z > 0.4) ball.vel.z = -2;
  }

  // ---------------------------------------------------------------- human control

  private updateHumanControl(dt: number): void {
    for (let i = 0; i < 2; i++) {
      const seat = this.seats[i];
      const p = this.controlled[i];
      if (!seat || !p || p.sentOff) continue;
      this.updateSeat(dt, i, seat, p);
    }
  }

  private updateSeat(dt: number, teamIdx: number, seat: PlayerInput, p: PlayerEntity): void {
    const team = this.teams[teamIdx];
    const stick = seat.getStick();
    const stickV: V2 = { x: stick.x, y: stick.y };
    const stickLen = len2(stickV);
    const sprint = seat.isSprinting();
    const onBall = this.ball.owner === p;

    if (p.diving) return;
    if (stickLen > 0.15) {
      p.moveDir(norm2(stickV), clamp(stickLen, 0, 1), sprint);
    } else if (!onBall) {
      const tgt = shapeTarget(this, team, p);
      if (dist2(p.pos, tgt) > 6) p.moveToward(tgt, 0.5); else p.stop();
    } else {
      p.stop();
    }

    const aimDir: V2 = stickLen > 0.15 ? norm2(stickV) : { x: Math.cos(p.facing), y: Math.sin(p.facing) };

    if (onBall) {
      if (seat.isHeld('shoot')) this.shotCharging[teamIdx] = true;
      const rel = seat.consumeRelease('shoot');
      const held = seat.heldDuration('shoot');
      if (rel || (this.shotCharging[teamIdx] && held >= SHOT_MAX_HOLD)) {
        const heldFor = rel ? rel.heldFor : SHOT_MAX_HOLD;
        this.shotCharging[teamIdx] = false;
        seat.clearBuffers();
        const power = clamp(heldFor / SHOT_MAX_HOLD, 0.15, 1);
        executeShot(this, p, clamp(aimDir.y * 1.4, -1, 1), power);
        return;
      }
      if (this.shotCharging[teamIdx]) return; // don't pass while charging

      if (seat.consumePress('pass')) {
        const target = bestPassTarget(this, p, aimDir, {});
        if (target) executeShortPass(this, p, target);
        else executeThrough(this, p, aimDir);
        return;
      }
      if (seat.consumePress('loft')) { executeLoft(this, p, aimDir); return; }
      if (seat.consumePress('through')) { executeThrough(this, p, aimDir); return; }
    } else {
      this.shotCharging[teamIdx] = false;
      if (seat.consumePress('switch')) this.switchPlayer(team, teamIdx);
      if (seat.isHeld('pass')) {
        p.moveToward({ x: this.ball.pos.x, y: this.ball.pos.y }, 1, sprint);
      }
      if (seat.consumePress('shoot')) this.trySlide(p);
    }
  }

  private switchPlayer(team: Team, teamIdx: number): void {
    const ball = this.ball.pos;
    const ownGoalX = -HALF_L * team.attackDir;
    let best: PlayerEntity | null = null;
    let bestScore = Infinity;
    for (const p of team.players) {
      if (p.isGK || p.sentOff || p === this.controlled[teamIdx]) continue;
      const d = dist2(p.pos, { x: ball.x, y: ball.y });
      const goalSide = (p.pos.x - ball.x) * Math.sign(ownGoalX - ball.x) > 0;
      const score = d + (goalSide ? 0 : 9);
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best) this.controlled[teamIdx] = best;
  }

  // ---------------------------------------------------------------- tackles & fouls

  /** Slide tackle: shared by human input and desperate CPU defenders. */
  trySlide(p: PlayerEntity): void {
    if (p.actionLock > 0 || p.sentOff) return;
    const ballV: V2 = { x: this.ball.pos.x, y: this.ball.pos.y };
    if (dist2(p.pos, ballV) > 4.5) return;
    p.playAnim('slide', 0.75);
    const dir = norm2(sub2(ballV, p.pos));
    p.vel = { x: dir.x * 9, y: dir.y * 9 };
    this.tackleCooldowns.set(p, 1.2);
    const check = (): void => {
      if (this.phase !== 'play') return;
      const d = dist2(p.pos, { x: this.ball.pos.x, y: this.ball.pos.y });
      const carrier = this.ball.owner;
      if (d < PLAYER_TACKLE_RADIUS + 0.4 && this.ball.pos.z < 0.9) {
        // reached the ball — but sliding through a man in possession is a
        // gamble: low Defending goes through the player first
        if (carrier && carrier.teamIdx !== p.teamIdx && dist2(p.pos, carrier.pos) < 1.7) {
          const def = effectiveRating(p.data, 'defending') / 99;
          if (this.rng.next() < 0.5 - def * 0.3) {
            this.callFoul(carrier, p);
            return;
          }
        }
        const away = norm2({ x: this.teams[p.teamIdx].attackDir + this.rng.noise(), y: this.rng.noise() * 1.4 });
        this.ball.kick({ x: away.x, y: away.y, z: 0.15 }, 11, p);
        if (carrier && carrier.teamIdx !== p.teamIdx) {
          this.ball.noControlPlayer = carrier; // slide winner: same lockout
          this.ball.noControlTimer = 0.45;
        }
        this.events.emit({ type: 'tackle' });
        return;
      }
      if (carrier && carrier.teamIdx !== p.teamIdx && dist2(p.pos, carrier.pos) < 1.4) {
        this.callFoul(carrier, p); // missed everything but the ankles
      }
    };
    this.deferred.push({ at: this.simTime + 0.22, fn: check });
  }

  private callFoul(victim: PlayerEntity, offender: PlayerEntity): void {
    const offTeam = this.teams[offender.teamIdx];
    const minute = this.displayMinute();
    this.events.emit({ type: 'foul', teamIdx: offender.teamIdx, playerName: offender.data.name, minute });
    victim.actionLock = Math.max(victim.actionLock, 0.5);
    this.ball.owner = null;

    // from behind risks cards (§6.4)
    const toOff = norm2(sub2(offender.pos, victim.pos));
    const fromBehind = Math.cos(victim.facing) * toOff.x + Math.sin(victim.facing) * toOff.y < -0.2;
    if (fromBehind || this.rng.next() < 0.25) {
      offender.yellows++;
      const straightRed = this.rng.next() < 0.1;
      const secondYellow = offender.yellows >= 2;
      if (straightRed || secondYellow) {
        this.events.emit({ type: 'card', color: 'red', teamIdx: offender.teamIdx, playerName: offender.data.name, minute });
        this.sendOff(offender);
      } else {
        this.events.emit({ type: 'card', color: 'yellow', teamIdx: offender.teamIdx, playerName: offender.data.name, minute });
      }
    }

    // in the offender's own box → penalty
    const ownGoalSide = Math.sign(-HALF_L * offTeam.attackDir);
    const inBox = victim.pos.x * ownGoalSide > HALF_L - BOX_DEPTH
      && Math.abs(victim.pos.y) < BOX_HALF_W;
    if (inBox) {
      this.events.emit({ type: 'penaltyAwarded', teamIdx: victim.teamIdx, minute });
      this.beginPenalty(victim.teamIdx);
    } else {
      this.beginRestart('freeKick', victim.teamIdx, v2(victim.pos.x, victim.pos.y));
    }
  }

  private sendOff(p: PlayerEntity): void {
    p.sentOff = true;
    if (this.ball.owner === p) this.ball.owner = null;
    const team = this.teams[p.teamIdx];
    // a red-carded keeper can't play on: an outfielder pulls on the gloves
    if (p === team.keeper) {
      const promoted = team.promoteEmergencyKeeper();
      if (promoted) {
        const brain = this.keepers[p.teamIdx];
        brain.keeper = promoted;
        brain.state = 'position';
      }
    }
    // walks (teleports) to the tunnel
    p.pos = { x: clamp(p.pos.x, -30, 30), y: (HALF_W + 6) * Math.sign(p.pos.y || 1) };
    p.vel = v2();
    p.stop();
    for (let i = 0; i < 2; i++) {
      if (this.controlled[i] === p) {
        this.controlled[i] = this.nearestOutfield(this.teams[i], p.pos);
      }
    }
  }

  // ---------------------------------------------------------------- penalties (in-match)

  private beginPenalty(teamIdx: number): void {
    this.phase = 'penalty';
    this.phaseTimer = 0;
    this.pendingPenaltyTeam = teamIdx;
    this.activeShot = null;
    this.offside.clear();
    this.penalty = new PenaltyController(this, 'single');
    this.penalty.startSingle(teamIdx);
  }

  /** Called by PenaltyController when an in-match kick resolves. */
  resolveSinglePenalty(result: PenResult): void {
    const teamIdx = this.pendingPenaltyTeam ?? 0;
    this.pendingPenaltyTeam = null;
    const pen = this.penalty;
    this.penalty = null;
    if (result === 'goal') {
      this.ball.lastTouch = pen?.taker
        ?? this.nearestOutfield(this.teams[teamIdx], v2(HALF_L * this.teams[teamIdx].attackDir, 0));
      this.scoreGoal(this.teams[teamIdx].attackDir);
    } else {
      // saved or missed: defending team restarts with a goal kick
      const defending = 1 - teamIdx;
      const gx = Math.sign(this.teams[teamIdx].attackDir) * (HALF_L - SIX_DEPTH);
      this.events.emit({ type: 'goalKick', teamIdx: defending });
      this.beginRestart('goalKick', defending, v2(gx, 4));
    }
  }

  // ---------------------------------------------------------------- CPU AI

  private updateAI(dt: number): void {
    const owner = this.ball.owner;
    const ballV: V2 = { x: this.ball.pos.x, y: this.ball.pos.y };

    // build-up urgency: possession that isn't reaching the final third loses
    // patience — without this, possession sides recycle sideways forever and
    // finish matches with zero shots
    if (owner && !owner.isGK) {
      const t = this.teams[owner.teamIdx];
      const inFinalThird = owner.pos.x * t.attackDir > HALF_L / 3;
      if (inFinalThird) this.buildupTime[owner.teamIdx] = 0;
      else this.buildupTime[owner.teamIdx] += dt;
      this.buildupTime[1 - owner.teamIdx] = 0;
    }

    for (const team of this.teams) {
      const attacking = this.possessionTeam === team.idx;
      const defense = attacking ? null : assignDefense(this, team);
      const chasers = new Set<PlayerEntity>();
      if (!owner) {
        const sorted = team.players.filter((p) => !p.isGK && !p.diving && !p.sentOff)
          .sort((a, b) => dist2(a.pos, ballV) - dist2(b.pos, ballV));
        for (const c of sorted.slice(0, 2)) chasers.add(c);
      }

      for (const p of team.players) {
        if (p.isGK) continue; // KeeperBrain owns the keeper
        if (p.sentOff) { p.stop(); continue; }
        if (this.seats[team.idx] && p === this.controlled[team.idx]) continue;
        if (p.diving) continue;

        if (owner === p) {
          this.cpuDecisionTimers[team.idx] -= dt;
          cpuDribble(this, p);
          if (this.cpuDecisionTimers[team.idx] <= 0) {
            this.cpuDecisionTimers[team.idx] = CPU_DECISION_TICK;
            if (p.actionLock <= 0) cpuOnBallDecision(this, p);
          }
          continue;
        }

        if (chasers.has(p)) {
          const lead = clamp(dist2(p.pos, ballV) * 0.12, 0, 0.9);
          p.moveToward({
            x: ballV.x + this.ball.vel.x * lead,
            y: ballV.y + this.ball.vel.y * lead,
          }, 1, this.difficulty.cpuSprint || team.isHuman);
          continue;
        }

        if (defense && defense.presser === p) {
          updateDefender(this, team, p, 'press');
          this.maybeCpuSlide(dt, team, p, owner);
          continue;
        }
        if (defense && defense.cover === p) { updateDefender(this, team, p, 'cover'); continue; }

        if (attacking && owner && owner.teamIdx === team.idx) {
          const rt = runTarget(this, team, p, owner);
          if (rt) { p.moveToward(rt, 1, p.stamina > 0.3); continue; }
        }

        p.moveToward(shapeTarget(this, team, p), 0.9);
      }
    }
  }

  /** Desperate CPU slide when the carrier is getting away. */
  private maybeCpuSlide(dt: number, team: Team, p: PlayerEntity, carrier: PlayerEntity | null): void {
    if (!carrier || this.seats[team.idx]) return; // human team defends manually
    if ((this.tackleCooldowns.get(p) ?? 0) > 0 || p.actionLock > 0) return;
    const d = dist2(p.pos, carrier.pos);
    if (d < 1.4 || d > 3.6) return;
    const escaping = len2(carrier.vel) > 4.2;
    const inOwnHalfish = carrier.pos.x * -team.attackDir > -10;
    if (escaping && inOwnHalfish && this.rng.next() < dt * 4) {
      this.trySlide(p);
    }
  }

  // ---------------------------------------------------------------- referee

  registerShot(shooter: PlayerEntity, speed: number, onTarget: boolean): void {
    this.activeShot = { shooter, time: this.simTime };
    if (onTarget) this.teams[shooter.teamIdx].shotsOnTarget++;
    const defendingTeam = 1 - shooter.teamIdx;
    this.keepers[defendingTeam].onShot(this);
  }

  shotResolved(kind: 'save' | 'goal' | 'out'): void {
    this.activeShot = null;
  }

  private checkGoalAndBounds(prevZ: number): void {
    const ball = this.ball;
    const prev = this.prevBallPos;
    const cur = ball.pos;

    for (const side of [1, -1]) {
      const planeX = HALF_L * side;
      if ((prev.x - planeX) * (cur.x - planeX) < 0) {
        const t = (planeX - prev.x) / (cur.x - prev.x);
        const yAt = prev.y + (cur.y - prev.y) * t;
        const zAt = prevZ + (cur.z - prevZ) * t;
        const movingIn = (cur.x - prev.x) * side > 0;
        if (movingIn && Math.abs(yAt) < GOAL_HALF_W && zAt < GOAL_HEIGHT) {
          const nearPost = GOAL_HALF_W - Math.abs(yAt) < 0.18;
          const nearBar = GOAL_HEIGHT - zAt < 0.15 && zAt > GOAL_HEIGHT - 0.4;
          if (nearPost || nearBar) {
            ball.vel.x *= -0.55;
            ball.vel.y += this.rng.noise() * 2;
            ball.pos.x = planeX - side * 0.3;
            this.events.emit({ type: 'post' });
            return;
          }
          this.scoreGoal(side);
          return;
        }
      }
    }

    if (Math.abs(cur.y) > HALF_W + 0.2) {
      const touchTeam = ball.lastTouch?.teamIdx ?? 0;
      const throwTeam = 1 - touchTeam;
      const pos = v2(clamp(cur.x, -HALF_L + 2, HALF_L - 2), Math.sign(cur.y) * (HALF_W - 0.3));
      this.events.emit({ type: 'throwIn', teamIdx: throwTeam });
      this.beginRestart('throwIn', throwTeam, pos);
      return;
    }
    if (Math.abs(cur.x) > HALF_L + 0.6) {
      const side = Math.sign(cur.x);
      const defendingTeam = this.teams[0].attackDir === side ? 1 : 0;
      const touchTeam = ball.lastTouch?.teamIdx ?? 0;
      if (this.activeShot && this.activeShot.shooter.teamIdx !== defendingTeam) {
        this.events.emit({
          type: 'miss', teamIdx: this.activeShot.shooter.teamIdx,
          shooterName: this.activeShot.shooter.data.name, minute: this.displayMinute(),
        });
        this.activeShot = null;
      }
      if (touchTeam === defendingTeam) {
        const cornerY = Math.sign(cur.y || 1) * (HALF_W - 0.6);
        const pos = v2(side * (HALF_L - 0.6), cornerY);
        this.events.emit({ type: 'corner', teamIdx: 1 - defendingTeam, minute: this.displayMinute() });
        this.beginRestart('corner', 1 - defendingTeam, pos);
      } else {
        const gx = side * (HALF_L - SIX_DEPTH);
        this.events.emit({ type: 'goalKick', teamIdx: defendingTeam });
        this.beginRestart('goalKick', defendingTeam, v2(gx, 4 * Math.sign(cur.y || 1)));
      }
    }
  }

  private scoreGoal(side: number): void {
    const scoringTeam = this.teams[0].attackDir === side ? 0 : 1;
    const team = this.teams[scoringTeam];
    team.score++;
    const lt = this.ball.lastTouch;
    const ownGoal = !!lt && lt.teamIdx !== scoringTeam;
    // own goal: credit the unlucky defender, celebrate whoever's nearest —
    // never a random opposition player who didn't touch it
    const scorer = !ownGoal && lt ? lt
      : this.nearestOutfield(team, { x: HALF_L * side, y: 0 });
    this.activeShot = null;
    this.lastGoalTeamIdx = scoringTeam;
    this.phase = 'goalseq';
    this.phaseTimer = 0;
    this.ball.owner = null;
    scorer.playAnim('celebrate', 2.5);
    this.keepers[1 - scoringTeam].keeper.playAnim('dejected', 2.5);
    const scorerName = ownGoal ? lt!.data.name : scorer.data.name;
    this.goalLog.push({ teamIdx: scoringTeam, scorerName, ownGoal, minute: this.displayMinute() });
    this.events.emit({
      type: 'goal', teamIdx: scoringTeam, scorerName, ownGoal,
      minute: this.displayMinute(),
    });
  }

  private updateGoalSeq(dt: number): void {
    for (const p of this.allPlayers) { p.stop(); p.update(dt); }
    this.ball.update(dt);
    const b = this.ball;
    if (Math.abs(b.pos.x) > HALF_L + 0.4) {
      b.vel.x *= Math.pow(0.001, dt);
      b.vel.y *= Math.pow(0.001, dt);
      b.vel.z = Math.min(b.vel.z, 0);
      b.pos.x = clamp(b.pos.x, -HALF_L - 2, HALF_L + 2);
      b.pos.y = clamp(b.pos.y, -GOAL_HALF_W - 1, GOAL_HALF_W + 1);
    }
    // long enough for the two-angle recap; any button still skips
    if (this.phaseTimer > 12.5 || (this.phaseTimer > 1.5 && this.anyButton())) {
      if (this.mode === 'golden') this.finishMatch();
      // a goal on the final whistle still ends the period
      else if (this.clock >= this.halfLenFor(this.half)) this.endPeriod();
      else this.setupKickoff(1 - this.lastGoalTeamIdx);
    }
  }

  private anyButton(): boolean {
    for (const seat of this.seats) {
      if (!seat) continue;
      if (seat.consumePress('pass', 600) || seat.consumePress('shoot', 600)
        || seat.consumePress('loft', 600) || seat.consumePress('through', 600)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- restarts

  beginRestart(kind: RestartKind, teamIdx: number, pos: V2): void {
    const team = this.teams[teamIdx];
    const taker = kind === 'goalKick'
      ? team.keeper
      : this.nearestOutfield(team, pos);
    this.restart = { kind, teamIdx, pos, timer: 0, taker };
    this.phase = 'restart';
    this.phaseTimer = 0;
    this.ball.reset(pos.x, pos.y);
    this.offside.clear();
    this.activeShot = null;
    for (let i = 0; i < 2; i++) {
      this.shotCharging[i] = false;
      if (!this.seats[i]) continue;
      this.controlled[i] = i === teamIdx && !taker.isGK
        ? taker
        : this.nearestOutfield(this.teams[i], pos);
    }
  }

  private updateRestart(dt: number): void {
    const r = this.restart;
    if (!r) { this.phase = 'play'; return; }
    r.timer += dt;
    const team = this.teams[r.teamIdx];

    r.taker.moveToward(r.pos, 1);
    for (const t of this.teams) {
      for (const p of t.players) {
        if (p === r.taker || p.sentOff) continue;
        if (p.isGK) {
          const gx = -HALF_L * t.attackDir;
          p.moveToward({ x: gx + t.attackDir * 2, y: 0 }, 0.9);
          continue;
        }
        let tgt = shapeTarget(this, t, p);
        if (r.kind === 'corner' && t.idx === r.teamIdx && (p.role === 'FW' || p.role === 'MF')) {
          const gx = HALF_L * t.attackDir;
          tgt = {
            x: gx - t.attackDir * (6 + Math.abs(this.rng.noise()) * 8),
            y: this.rng.noise() * 12,
          };
        }
        if (t.idx !== r.teamIdx) {
          const d = dist2(tgt, r.pos);
          if (d < 9) {
            const away = norm2(sub2(tgt, r.pos));
            tgt = { x: r.pos.x + away.x * 9, y: r.pos.y + away.y * 9 };
          }
        }
        p.moveToward(tgt, 0.85);
      }
    }
    for (const p of this.allPlayers) p.update(dt);

    const atSpot = dist2(r.taker.pos, r.pos) < 1.4;
    if (!atSpot && r.timer < 6) return;

    const seat = this.seats[r.teamIdx];
    let take = false;
    let action: 'short' | 'cross' = r.kind === 'corner' ? 'cross' : 'short';
    if (seat && r.timer > 0.5) {
      if (seat.consumePress('pass', 400)) { take = true; action = 'short'; }
      else if (seat.consumePress('loft', 400)) { take = true; action = 'cross'; }
      else if (r.timer > 7) take = true;
    } else if (!seat) {
      take = r.timer > 1.6;
    }
    if (!take) return;

    this.controlledRestartKick(r, team, action);
    this.restart = null;
    this.phase = 'play';
    seat?.clearBuffers();
  }

  private controlledRestartKick(r: RestartInfo, team: Team, action: 'short' | 'cross'): void {
    const taker = r.taker;
    taker.pos = { x: r.pos.x, y: r.pos.y };
    this.ball.reset(r.pos.x, r.pos.y);
    const seat = this.seats[r.teamIdx];
    const stick = seat ? seat.getStick() : { x: 0, y: 0 };
    const aimDir: V2 = seat && len2(stick) > 0.2
      ? norm2(stick)
      : norm2({ x: team.attackDir, y: -Math.sign(r.pos.y || 1) * 0.7 });

    switch (r.kind) {
      case 'goalKick':
        executeLoft(this, taker, { x: team.attackDir, y: this.rng.noise() * 0.5 });
        break;
      case 'corner':
        if (action === 'cross') executeLoft(this, taker, aimDir);
        else {
          const t = bestPassTarget(this, taker, aimDir, { maxDist: 30 });
          if (t) executeShortPass(this, taker, t);
          else executeLoft(this, taker, aimDir);
        }
        break;
      case 'throwIn':
      case 'freeKick':
      default: {
        const t = bestPassTarget(this, taker, aimDir, { maxDist: 32 });
        if (t) executeShortPass(this, taker, t);
        else executeLoft(this, taker, { x: team.attackDir, y: this.rng.noise() });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- ambience

  private updateStatsAndCrowd(dt: number): void {
    if (this.ball.owner) this.teams[this.ball.owner.teamIdx].possessionTicks++;
    this.buildupTimer += dt;
    if (this.buildupTimer > 0.4) {
      this.buildupTimer = 0;
      const adv = Math.abs(this.ball.pos.x) / HALF_L;
      const inFinalThird = Math.abs(this.ball.pos.x) > HALF_L / 3;
      const level = inFinalThird ? clamp((adv - 0.33) * 1.6, 0, 1) : 0;
      this.events.emit({ type: 'attackBuildup', level });
    }
  }
}
