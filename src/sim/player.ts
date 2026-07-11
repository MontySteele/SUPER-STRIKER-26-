import { clamp, dampAngle, len2, v2, type V2 } from '../core/math';
import type { PlayerData, Pos } from '../data/types';
import { effectiveRating } from '../data/loader';
import { BASE_SPEED, HALF_L, HALF_W, PACE_SPEED, PLAYER_ACCEL, SPRINT_MULT } from './constants';

/** One-shot action animations the renderer plays over locomotion. */
export type ActionAnim =
  | 'none' | 'pass' | 'loft' | 'shoot' | 'slide' | 'header'
  | 'diveL' | 'diveR' | 'collect' | 'celebrate' | 'dejected';

export class PlayerEntity {
  pos: V2;
  vel: V2 = v2();
  facing = 0;
  /** Where movement logic wants this player to go this tick. */
  desired: V2 = v2();
  desiredSpeedMult = 1; // 0..1 walk→run, >1 sprint
  sprinting = false;

  stamina = 1; // 0..1, drains while sprinting
  /** Brief lockout after a kick/tackle so animations land (never blocks buffered input reads). */
  actionLock = 0;
  actionAnim: ActionAnim = 'none';
  actionAnimT = 0;

  // keeper dive state (render + physics both read this)
  diving = false;
  diveVel: V2 = v2();

  constructor(
    public data: PlayerData,
    public teamIdx: number,
    public role: Pos,
    /** formation slot as fractions of pitch (own goal → opponent goal). */
    public homeFrac: [number, number],
    x: number,
    y: number,
  ) {
    this.pos = v2(x, y);
    this.facing = teamIdx === 0 ? 0 : Math.PI;
  }

  get isGK(): boolean { return this.role === 'GK'; }

  maxSpeed(): number {
    const pace = effectiveRating(this.data, 'pace');
    let s = BASE_SPEED + pace * PACE_SPEED;
    if (this.sprinting) s *= SPRINT_MULT * (0.82 + 0.18 * this.stamina);
    return s;
  }

  /** Set movement target velocity from a direction (unnormalized ok) and speed multiplier. */
  moveToward(target: V2, speedMult = 1, sprint = false): void {
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const d = Math.hypot(dx, dy);
    // ease in when arriving so players settle instead of orbiting
    const arrive = clamp(d / 1.2, 0, 1);
    if (d > 1e-4) {
      this.desired = v2((dx / d) * arrive, (dy / d) * arrive);
    } else {
      this.desired = v2();
    }
    this.desiredSpeedMult = speedMult;
    this.sprinting = sprint && d > 2;
  }

  moveDir(dir: V2, speedMult = 1, sprint = false): void {
    this.desired = dir;
    this.desiredSpeedMult = speedMult;
    this.sprinting = sprint;
  }

  stop(): void {
    this.desired = v2();
    this.sprinting = false;
  }

  update(dt: number): void {
    if (this.actionLock > 0) this.actionLock -= dt;
    if (this.actionAnim !== 'none') {
      this.actionAnimT += dt;
      const dur = this.actionAnim === 'slide' ? 0.8
        : this.actionAnim === 'diveL' || this.actionAnim === 'diveR' ? 1.0
        : this.actionAnim === 'celebrate' || this.actionAnim === 'dejected' ? 3.0
        : 0.42;
      if (this.actionAnimT > dur) { this.actionAnim = 'none'; this.actionAnimT = 0; }
    }

    if (this.diving) {
      // ballistic slide along dive velocity, decaying
      this.pos.x += this.diveVel.x * dt;
      this.pos.y += this.diveVel.y * dt;
      this.diveVel.x *= Math.pow(0.05, dt);
      this.diveVel.y *= Math.pow(0.05, dt);
      if (len2(this.diveVel) < 0.5) this.diving = false;
      this.clampToField();
      return;
    }

    const slowedByAction = this.actionLock > 0 ? 0.35 : 1;
    const target = {
      x: this.desired.x * this.maxSpeed() * this.desiredSpeedMult * slowedByAction,
      y: this.desired.y * this.maxSpeed() * this.desiredSpeedMult * slowedByAction,
    };
    const ax = target.x - this.vel.x;
    const ay = target.y - this.vel.y;
    const al = Math.hypot(ax, ay);
    const maxA = PLAYER_ACCEL * dt;
    if (al > maxA) {
      this.vel.x += (ax / al) * maxA;
      this.vel.y += (ay / al) * maxA;
    } else {
      this.vel.x = target.x;
      this.vel.y = target.y;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.clampToField();

    const sp = len2(this.vel);
    if (sp > 0.4) {
      this.facing = dampAngle(this.facing, Math.atan2(this.vel.y, this.vel.x), 0.07, dt);
    }

    // stamina (§4): drains on sprint, trickles back otherwise
    const stam = effectiveRating(this.data, 'stamina');
    if (this.sprinting && sp > 4) {
      this.stamina = Math.max(0, this.stamina - dt / (18 + stam * 0.35));
    } else {
      this.stamina = Math.min(1, this.stamina + dt / 40);
    }
  }

  private clampToField(): void {
    // small apron beyond lines so players can chase balls out
    this.pos.x = clamp(this.pos.x, -HALF_L - 4, HALF_L + 4);
    this.pos.y = clamp(this.pos.y, -HALF_W - 4, HALF_W + 4);
  }

  playAnim(a: ActionAnim, lock = 0.25): void {
    this.actionAnim = a;
    this.actionAnimT = 0;
    this.actionLock = Math.max(this.actionLock, lock);
  }
}
