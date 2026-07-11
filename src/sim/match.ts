// Match orchestrator: fixed-timestep sim, human control, possession model,
// referee (out of bounds / goals / restarts), and the match state machine.

import { clamp, dist2, len2, norm2, sub2, v2, type V2 } from '../core/math';
import { EventBus } from '../core/events';
import { RNG } from '../core/rng';
import type { TeamData } from '../data/types';
import { effectiveRating } from '../data/loader';
import type { InputSystem } from '../input/input';
import {
  bestPassTarget, executeLoft, executeShortPass, executeShot, executeThrough,
} from './actions';
import { cpuDribble, cpuOnBallDecision } from './ai/onBall';
import { assignDefense, updateDefender } from './ai/defense';
import { KeeperBrain } from './ai/keeper';
import { runTarget, shapeTarget } from './ai/teamShape';
import { Ball } from './ball';
import {
  CPU_DECISION_TICK, GOAL_HALF_W, GOAL_HEIGHT, HALF_L, HALF_W,
  PLAYER_CONTROL_RADIUS, PLAYER_TACKLE_RADIUS, SHOT_MAX_HOLD, SIM_DT, SIX_DEPTH,
} from './constants';
import { OffsideTracker } from './offside';
import type { PlayerEntity } from './player';
import { Team } from './team';

export type MatchPhase = 'kickoff' | 'play' | 'restart' | 'goalseq' | 'halftime' | 'fulltime';
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
  humanTeamIdx: number | null; // null = CPU vs CPU (attract mode)
  halfLengthSec: number;       // real seconds per half
  difficulty: DifficultyName;
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

  phase: MatchPhase = 'kickoff';
  phaseTimer = 0;
  half = 1;
  simTime = 0;        // total sim seconds, always advancing
  clock = 0;          // in-play seconds of the current half
  halfLength: number;
  kickoffTeam = 0;
  restart: RestartInfo | null = null;

  possessionTeam = 0;
  humanTeamIdx: number | null;
  controlled: PlayerEntity | null = null;

  private cpuDecisionTimers = [0, 0];
  private activeShot: ActiveShot | null = null;
  private shotCharging = false;
  private buildupTimer = 0;
  private prevBallPos: V2 = v2();
  private tackleCooldowns = new Map<PlayerEntity, number>();
  /** last non-GK player who gained clean control per team, for switch logic */
  lastPossessor: PlayerEntity | null = null;

  constructor(public opts: MatchOptions, private input: InputSystem) {
    this.rng = new RNG(opts.seed ?? 0xC0FFEE);
    this.teams = [
      new Team(opts.home, 0, 1, opts.humanTeamIdx === 0),
      new Team(opts.away, 1, -1, opts.humanTeamIdx === 1),
    ];
    this.keepers = [
      new KeeperBrain(this.teams[0], this.teams[0].keeper),
      new KeeperBrain(this.teams[1], this.teams[1].keeper),
    ];
    this.humanTeamIdx = opts.humanTeamIdx;
    this.halfLength = opts.halfLengthSec;
    this.difficulty = DIFFICULTIES[opts.difficulty];
    this.offside.match = this;
    this.setupKickoff(0);
  }

  get allPlayers(): PlayerEntity[] {
    return [...this.teams[0].players, ...this.teams[1].players];
  }

  humanTeam(): Team | null {
    return this.humanTeamIdx === null ? null : this.teams[this.humanTeamIdx];
  }

  /** Display minute for the HUD/ticker (45-min halves compressed). */
  displayMinute(): number {
    const base = this.half === 2 ? 45 : 0;
    return Math.min(base + Math.floor((this.clock / this.halfLength) * 45), this.half === 2 ? 90 : 45);
  }

  secondLastDefenderX(teamIdx: number): number {
    // x of the second-last defender (incl. keeper), in that team's defensive sense
    const t = this.teams[teamIdx];
    const xs = t.players.map((p) => p.pos.x * -t.attackDir).sort((a, b) => b - a);
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
    this.controlled = this.humanTeamIdx !== null
      ? this.nearestOutfield(this.teams[this.humanTeamIdx], v2(0, 0))
      : null;
  }

  private nearestOutfield(team: Team, to: V2): PlayerEntity {
    return team.players
      .filter((p) => !p.isGK)
      .reduce((a, b) => (dist2(a.pos, to) < dist2(b.pos, to) ? a : b));
  }

  // ---------------------------------------------------------------- main tick

  update(): void {
    const dt = SIM_DT;
    this.simTime += dt;
    this.phaseTimer += dt;

    switch (this.phase) {
      case 'kickoff': this.updateKickoff(dt); break;
      case 'play': this.updatePlay(dt); break;
      case 'restart': this.updateRestart(dt); break;
      case 'goalseq': this.updateGoalSeq(dt); break;
      case 'halftime':
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

    const humanKicking = this.humanTeamIdx === this.kickoffTeam;
    const ready = dist2(taker.pos, v2(0, 0)) < 1.6 && this.phaseTimer > 0.6;
    const go = ready && (humanKicking
      ? (this.input.consumePress('pass', 600) || this.phaseTimer > 4)
      : this.phaseTimer > 1.4);
    if (go) {
      // roll it back to a midfielder
      const mate = t.players.filter((p) => p.role === 'MF')
        .reduce((a, b) => (dist2(a.pos, taker.pos) < dist2(b.pos, taker.pos) ? a : b));
      const dir = norm2(sub2(mate.pos, taker.pos));
      this.ball.kick({ x: dir.x, y: dir.y, z: 0.02 }, 9, taker);
      taker.playAnim('pass', 0.2);
      this.phase = 'play';
      this.events.emit({ type: 'kickoff', half: this.half });
      if (this.humanTeamIdx !== null) this.controlled = mate.teamIdx === this.humanTeamIdx ? mate : this.controlled;
      this.input.clearBuffers();
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

    // half/full time (wait for a neutral-ish moment: ball below head height)
    if (this.clock >= this.halfLength && this.ball.pos.z < 2 && this.phase === 'play') {
      if (this.half === 1) {
        this.phase = 'halftime';
        this.events.emit({ type: 'halftime' });
      } else {
        this.phase = 'fulltime';
        this.events.emit({ type: 'fulltime' });
      }
    }
  }

  /** Resume from the halftime card (UI calls this on button press). */
  startSecondHalf(): void {
    if (this.phase !== 'halftime') return;
    this.half = 2;
    this.clock = 0;
    for (const t of this.teams) t.attackDir *= -1;
    this.setupKickoff(1 - this.firstKickoffTeam);
  }

  private firstKickoffTeam = 0;

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
        if (opp.diving || (this.tackleCooldowns.get(opp) ?? 0) > 0) continue;
        const d = dist2(opp.pos, carrier.pos);
        if (d < PLAYER_TACKLE_RADIUS) {
          const def = effectiveRating(opp.data, 'defending');
          const ctrl = effectiveRating(carrier.data, 'passing');
          const winChance = clamp(0.25 + (def - ctrl) / 200, 0.08, 0.55) * dt * 3.2;
          this.tackleCooldowns.set(opp, 0.5);
          if (this.rng.next() < winChance) {
            // poke it loose toward the tackler's attacking side
            const dir = norm2({
              x: this.teams[opp.teamIdx].attackDir + this.rng.noise() * 0.8,
              y: this.rng.noise(),
            });
            ball.kick({ x: dir.x, y: dir.y, z: 0.08 }, 6 + this.rng.next() * 4, opp);
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
      if (p.diving) continue;
      // keepers use hands via KeeperBrain inside the box; feet only for
      // stray balls at their feet, and only when the ball is slow
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
      // fast ball: chance of a clean trap vs a heavy deflection
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
    this.lastPossessor = best;
    this.cpuDecisionTimers[best.teamIdx] = CPU_DECISION_TICK * 0.5; // small settle before deciding
    // shot is dead once anyone controls it
    if (this.activeShot && best.teamIdx !== this.activeShot.shooter.teamIdx) this.activeShot = null;
    // auto-switch: human always controls the teammate on the ball
    if (this.humanTeamIdx !== null && best.teamIdx === this.humanTeamIdx) {
      this.controlled = best;
      this.shotCharging = false;
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
      // sprint knock-on: push it 2–3m ahead and chase (emergent tackles live here)
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
    // close control: spring the ball toward the foot point
    const pull = clamp(d * 14, 0, speed + 7);
    const dir = norm2(sub2(foot, { x: ball.pos.x, y: ball.pos.y }));
    ball.vel.x = owner.vel.x + dir.x * pull;
    ball.vel.y = owner.vel.y + dir.y * pull;
    if (ball.pos.z > 0.4) ball.vel.z = -2;
  }

  // ---------------------------------------------------------------- human control

  private updateHumanControl(dt: number): void {
    const team = this.humanTeam();
    if (!team || !this.controlled) return;
    const p = this.controlled;
    const stick = this.input.getStick();
    const stickV: V2 = { x: stick.x, y: stick.y };
    const stickLen = len2(stickV);
    const sprint = this.input.isSprinting();
    const onBall = this.ball.owner === p;

    // movement (stick is screen-space; camera looks down +y → sim x = screen x, sim y = screen y)
    if (p.diving) return;
    if (stickLen > 0.15) {
      p.moveDir(norm2(stickV), clamp(stickLen, 0, 1), sprint);
    } else if (!onBall) {
      // no input off-ball: drift gently toward shape so the player isn't stranded
      const tgt = shapeTarget(this, team, p);
      if (dist2(p.pos, tgt) > 6) p.moveToward(tgt, 0.5); else p.stop();
    } else {
      p.stop();
    }

    const aimDir: V2 = stickLen > 0.15 ? norm2(stickV) : { x: Math.cos(p.facing), y: Math.sin(p.facing) };

    if (onBall) {
      // --- shooting: hold to power, fires on release (or auto at max hold)
      if (this.input.isHeld('shoot')) this.shotCharging = true;
      const rel = this.input.consumeRelease('shoot');
      const held = this.input.heldDuration('shoot');
      if (rel || (this.shotCharging && held >= SHOT_MAX_HOLD)) {
        const heldFor = rel ? rel.heldFor : SHOT_MAX_HOLD;
        this.shotCharging = false;
        this.input.clearBuffers();
        const power = clamp(heldFor / SHOT_MAX_HOLD, 0.15, 1);
        const aimY = this.lateralAim(team, aimDir);
        executeShot(this, p, aimY, power);
        return;
      }
      if (this.shotCharging) return; // don't pass while charging a shot

      if (this.input.consumePress('pass')) {
        const target = bestPassTarget(this, p, aimDir, {});
        if (target) executeShortPass(this, p, target);
        else executeThrough(this, p, aimDir); // nobody near the cone: hopeful ball
        return;
      }
      if (this.input.consumePress('loft')) { executeLoft(this, p, aimDir); return; }
      if (this.input.consumePress('through')) { executeThrough(this, p, aimDir); return; }
    } else {
      this.shotCharging = false;
      // --- defense: switch, pressure, slide tackle
      if (this.input.consumePress('switch')) this.switchPlayer(team);
      if (this.input.isHeld('pass')) {
        // pressure assist: controlled player homes in on the ball
        p.moveToward({ x: this.ball.pos.x, y: this.ball.pos.y }, 1, sprint);
      }
      if (this.input.consumePress('shoot')) this.slideTackle(p);
    }
  }

  /**
   * Stick direction → -1..1 across the goal mouth. The camera sits on the +y
   * sideline, so screen-vertical IS pitch y — stick y aims across the goal
   * directly, whichever end we attack.
   */
  private lateralAim(team: Team, aimDir: V2): number {
    return clamp(aimDir.y * 1.4, -1, 1);
  }

  private switchPlayer(team: Team): void {
    // best-positioned defender (§5): near the ball AND goal-side of it
    const ball = this.ball.pos;
    const ownGoalX = -HALF_L * team.attackDir;
    let best: PlayerEntity | null = null;
    let bestScore = Infinity;
    for (const p of team.players) {
      if (p.isGK || p === this.controlled) continue;
      const d = dist2(p.pos, { x: ball.x, y: ball.y });
      const goalSide = (p.pos.x - ball.x) * Math.sign(ownGoalX - ball.x) > 0;
      const score = d + (goalSide ? 0 : 9);
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best) this.controlled = best;
  }

  private slideTackle(p: PlayerEntity): void {
    if (p.actionLock > 0) return;
    const ballV: V2 = { x: this.ball.pos.x, y: this.ball.pos.y };
    if (dist2(p.pos, ballV) > 4.5) return;
    p.playAnim('slide', 0.75);
    const dir = norm2(sub2(ballV, p.pos));
    p.vel = { x: dir.x * 9, y: dir.y * 9 };
    // resolve after a beat: if the lunge reaches the ball, poke it clear
    const check = (): void => {
      const d = dist2(p.pos, { x: this.ball.pos.x, y: this.ball.pos.y });
      if (d < PLAYER_TACKLE_RADIUS + 0.4 && this.ball.pos.z < 0.9) {
        const away = norm2({ x: this.teams[p.teamIdx].attackDir + this.rng.noise(), y: this.rng.noise() * 1.4 });
        this.ball.kick({ x: away.x, y: away.y, z: 0.15 }, 11, p);
        this.events.emit({ type: 'tackle' });
      }
    };
    this.deferred.push({ at: this.simTime + 0.22, fn: check });
  }

  private deferred: { at: number; fn: () => void }[] = [];

  // ---------------------------------------------------------------- CPU AI

  private updateAI(dt: number): void {
    // run deferred one-shots (slide tackle resolution)
    this.deferred = this.deferred.filter((d) => {
      if (this.simTime >= d.at) { d.fn(); return false; }
      return true;
    });

    const owner = this.ball.owner;
    const ballV: V2 = { x: this.ball.pos.x, y: this.ball.pos.y };

    for (const team of this.teams) {
      const attacking = this.possessionTeam === team.idx;
      const defense = attacking ? null : assignDefense(this, team);
      // designated loose-ball chasers (both teams send their closest)
      const chasers = new Set<PlayerEntity>();
      if (!owner) {
        const sorted = team.players.filter((p) => !p.isGK && !p.diving)
          .sort((a, b) => dist2(a.pos, ballV) - dist2(b.pos, ballV));
        for (const c of sorted.slice(0, 2)) chasers.add(c);
      }

      for (const p of team.players) {
        if (p.isGK) continue; // KeeperBrain owns the keeper
        if (this.humanTeamIdx === team.idx && p === this.controlled) continue;
        if (p.diving) continue;

        if (owner === p) {
          // CPU ball carrier
          this.cpuDecisionTimers[team.idx] -= dt;
          cpuDribble(this, p);
          if (this.cpuDecisionTimers[team.idx] <= 0) {
            this.cpuDecisionTimers[team.idx] = CPU_DECISION_TICK;
            if (p.actionLock <= 0) cpuOnBallDecision(this, p);
          }
          continue;
        }

        if (chasers.has(p)) {
          // intercept: run to where the ball is going
          const lead = clamp(dist2(p.pos, ballV) * 0.12, 0, 0.9);
          p.moveToward({
            x: ballV.x + this.ball.vel.x * lead,
            y: ballV.y + this.ball.vel.y * lead,
          }, 1, this.difficulty.cpuSprint || team.isHuman);
          continue;
        }

        if (defense && defense.presser === p) { updateDefender(this, team, p, 'press'); continue; }
        if (defense && defense.cover === p) { updateDefender(this, team, p, 'cover'); continue; }

        // attacking runs override shape in the final third
        if (attacking && owner && owner.teamIdx === team.idx) {
          const rt = runTarget(this, team, p, owner);
          if (rt) { p.moveToward(rt, 1, p.stamina > 0.3); continue; }
        }

        p.moveToward(shapeTarget(this, team, p), 0.9);
      }
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

    // goal-line / goal-frame crossings on either end
    for (const side of [1, -1]) {
      const planeX = HALF_L * side;
      if ((prev.x - planeX) * (cur.x - planeX) < 0 || Math.abs(cur.x) > HALF_L) {
        const crossed = (prev.x - planeX) * (cur.x - planeX) < 0;
        if (crossed) {
          const t = (planeX - prev.x) / (cur.x - prev.x);
          const yAt = prev.y + (cur.y - prev.y) * t;
          const zAt = prevZ + (cur.z - prevZ) * t;
          const movingIn = (cur.x - prev.x) * side > 0;
          if (movingIn && Math.abs(yAt) < GOAL_HALF_W && zAt < GOAL_HEIGHT) {
            // woodwork: clip near the frame edges
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
    }

    // out of bounds
    if (Math.abs(cur.y) > HALF_W + 0.2) {
      const touchTeam = ball.lastTouch?.teamIdx ?? 0;
      const throwTeam = 1 - touchTeam;
      const pos = v2(clamp(cur.x, -HALF_L + 2, HALF_L - 2), Math.sign(cur.y) * (HALF_W - 0.3));
      this.events.emit({ type: 'throwIn', teamIdx: throwTeam });
      this.beginRestart('throwIn', throwTeam, pos);
      return;
    }
    if (Math.abs(cur.x) > HALF_L + 0.6) {
      const side = Math.sign(cur.x); // which end
      const defendingTeam = this.teams[0].attackDir === side ? 1 : 0; // team defending that end
      const touchTeam = ball.lastTouch?.teamIdx ?? 0;
      // a shot that misses ends here
      if (this.activeShot && this.activeShot.shooter.teamIdx !== defendingTeam) {
        this.events.emit({
          type: 'miss', teamIdx: this.activeShot.shooter.teamIdx,
          shooterName: this.activeShot.shooter.data.name, minute: this.displayMinute(),
        });
        this.activeShot = null;
      }
      if (touchTeam === defendingTeam) {
        // defender touched it out over their own line → corner
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
    // side = +1 means ball crossed +x line → team attacking +x scored
    const scoringTeam = this.teams[0].attackDir === side ? 0 : 1;
    const team = this.teams[scoringTeam];
    team.score++;
    const scorer = this.ball.lastTouch && this.ball.lastTouch.teamIdx === scoringTeam
      ? this.ball.lastTouch
      : team.players[team.players.length - 1];
    this.activeShot = null;
    this.lastGoalTeamIdx = scoringTeam;
    this.phase = 'goalseq';
    this.phaseTimer = 0;
    this.ball.owner = null;
    scorer.playAnim('celebrate', 2.5);
    this.keepers[1 - scoringTeam].keeper.playAnim('dejected', 2.5);
    this.events.emit({
      type: 'goal', teamIdx: scoringTeam, scorerName: scorer.data.name,
      minute: this.displayMinute(),
    });
  }

  private updateGoalSeq(dt: number): void {
    // celebration runs on its own; players idle, clock frozen
    for (const p of this.allPlayers) { p.stop(); p.update(dt); }
    this.ball.update(dt);
    // the net catches the ball — don't let it roll into the stands
    const b = this.ball;
    if (Math.abs(b.pos.x) > HALF_L + 0.4) {
      b.vel.x *= Math.pow(0.001, dt);
      b.vel.y *= Math.pow(0.001, dt);
      b.vel.z = Math.min(b.vel.z, 0);
      b.pos.x = clamp(b.pos.x, -HALF_L - 2, HALF_L + 2);
      b.pos.y = clamp(b.pos.y, -GOAL_HALF_W - 1, GOAL_HALF_W + 1);
    }
    if (this.phaseTimer > 6.2 || (this.phaseTimer > 1.5 && this.anyButton())) {
      this.setupKickoff(1 - this.lastGoalTeamIdx);
    }
  }

  private lastGoalTeamIdx = 0;

  private anyButton(): boolean {
    return this.input.consumePress('pass', 600) || this.input.consumePress('shoot', 600)
      || this.input.consumePress('loft', 600) || this.input.consumePress('through', 600);
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
    this.shotCharging = false;
    if (this.humanTeamIdx === teamIdx) this.controlled = taker.isGK ? this.nearestOutfield(team, pos) : taker;
    else if (this.humanTeamIdx !== null) {
      this.controlled = this.nearestOutfield(this.teams[this.humanTeamIdx], pos);
    }
  }

  private updateRestart(dt: number): void {
    const r = this.restart;
    if (!r) { this.phase = 'play'; return; }
    r.timer += dt;
    const team = this.teams[r.teamIdx];

    // taker walks to the spot; everyone else breathes back into shape
    r.taker.moveToward(r.pos, 1);
    for (const t of this.teams) {
      for (const p of t.players) {
        if (p === r.taker) continue;
        if (p.isGK) {
          const gx = -HALF_L * t.attackDir;
          p.moveToward({ x: gx + t.attackDir * 2, y: 0 }, 0.9);
          continue;
        }
        let tgt = shapeTarget(this, t, p);
        // corner: attackers crowd the box
        if (r.kind === 'corner' && t.idx === r.teamIdx && (p.role === 'FW' || p.role === 'MF')) {
          const gx = HALF_L * t.attackDir;
          tgt = {
            x: gx - t.attackDir * (6 + Math.abs(this.rng.noise()) * 8),
            y: this.rng.noise() * 12,
          };
        }
        // opponents retreat out of the restart bubble
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

    const isHumanTaker = this.humanTeamIdx === r.teamIdx;
    let take = false;
    let action: 'short' | 'cross' = r.kind === 'corner' ? 'cross' : 'short';
    if (isHumanTaker && r.timer > 0.5) {
      if (this.input.consumePress('pass', 400)) { take = true; action = 'short'; }
      else if (this.input.consumePress('loft', 400)) { take = true; action = 'cross'; }
      else if (r.timer > 7) take = true;
    } else {
      take = r.timer > 1.6;
    }
    if (!take) return;

    // execute the restart with the shared action toolbox
    this.controlledRestartKick(r, team, action);
    this.restart = null;
    this.phase = 'play';
    this.input.clearBuffers();
  }

  private controlledRestartKick(r: RestartInfo, team: Team, action: 'short' | 'cross'): void {
    const taker = r.taker;
    taker.pos = { x: r.pos.x, y: r.pos.y };
    this.ball.reset(r.pos.x, r.pos.y);
    const stick = this.input.getStick();
    const aimDir: V2 = this.humanTeamIdx === r.teamIdx && len2(stick) > 0.2
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
      // crowd anticipation: ball deep in a final third, higher when attacking the ball fast
      const adv = Math.abs(this.ball.pos.x) / HALF_L;
      const inFinalThird = Math.abs(this.ball.pos.x) > HALF_L / 3;
      const level = inFinalThird ? clamp((adv - 0.33) * 1.6, 0, 1) : 0;
      this.events.emit({ type: 'attackBuildup', level });
    }
  }
}
