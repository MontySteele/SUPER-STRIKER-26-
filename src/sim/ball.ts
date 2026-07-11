// The ball is a real physics object, never glued to feet (§6.1).

import { v3, type V3 } from '../core/math';
import {
  BALL_AIR_DRAG, BALL_RADIUS, BALL_RESTITUTION, BALL_ROLL_FRICTION,
  GRAVITY, MAGNUS_COEFF,
} from './constants';
import type { PlayerEntity } from './player';

export class Ball {
  pos: V3 = v3(0, 0, BALL_RADIUS);
  vel: V3 = v3();
  /** Signed curl around the up axis; decays in flight. */
  spinY = 0;
  /** Player currently dribbling (close control), null when loose/in flight. */
  owner: PlayerEntity | null = null;
  /** Last player to touch — for out-of-bounds attribution and offside. */
  lastTouch: PlayerEntity | null = null;
  /** Set after a kick so the kicker doesn't instantly re-capture. */
  noControlTimer = 0;
  noControlPlayer: PlayerEntity | null = null;

  onBounce: ((speed: number) => void) | null = null;

  reset(x: number, y: number): void {
    this.pos = v3(x, y, BALL_RADIUS);
    this.vel = v3();
    this.spinY = 0;
    this.owner = null;
    this.noControlTimer = 0;
    this.noControlPlayer = null;
  }

  kick(dir: V3, speed: number, kicker: PlayerEntity, spin = 0): void {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    this.vel = v3((dir.x / l) * speed, (dir.y / l) * speed, (dir.z / l) * speed);
    this.spinY = spin;
    this.owner = null;
    this.lastTouch = kicker;
    this.noControlTimer = 0.28;
    this.noControlPlayer = kicker;
    if (this.pos.z < BALL_RADIUS) this.pos.z = BALL_RADIUS;
  }

  speed(): number {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }

  speed2d(): number {
    return Math.hypot(this.vel.x, this.vel.y);
  }

  grounded(): boolean {
    return this.pos.z <= BALL_RADIUS + 0.02 && Math.abs(this.vel.z) < 0.8;
  }

  update(dt: number): void {
    if (this.noControlTimer > 0) {
      this.noControlTimer -= dt;
      if (this.noControlTimer <= 0) this.noControlPlayer = null;
    }

    const sp = this.speed();
    if (this.grounded()) {
      this.pos.z = BALL_RADIUS;
      this.vel.z = 0;
      // rolling friction
      const s2 = this.speed2d();
      if (s2 > 0.01) {
        const dec = BALL_ROLL_FRICTION * dt;
        const f = Math.max(0, s2 - dec) / s2;
        this.vel.x *= f;
        this.vel.y *= f;
      } else {
        this.vel.x = 0;
        this.vel.y = 0;
      }
      this.spinY *= Math.pow(0.2, dt);
    } else {
      // gravity + quadratic air drag + Magnus curl
      this.vel.z -= GRAVITY * dt;
      const drag = BALL_AIR_DRAG * sp;
      this.vel.x -= this.vel.x * drag * dt;
      this.vel.y -= this.vel.y * drag * dt;
      this.vel.z -= this.vel.z * drag * dt;
      if (Math.abs(this.spinY) > 0.01) {
        // sideways acceleration perpendicular to horizontal velocity
        const s2 = this.speed2d();
        if (s2 > 1) {
          const ax = (-this.vel.y / s2) * this.spinY * MAGNUS_COEFF;
          const ay = (this.vel.x / s2) * this.spinY * MAGNUS_COEFF;
          this.vel.x += ax * dt;
          this.vel.y += ay * dt;
        }
        this.spinY *= Math.pow(0.45, dt);
      }
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // ground bounce
    if (this.pos.z < BALL_RADIUS && this.vel.z < 0) {
      this.pos.z = BALL_RADIUS;
      const impact = -this.vel.z;
      this.vel.z = impact * BALL_RESTITUTION;
      if (this.vel.z < 0.9) this.vel.z = 0;
      this.vel.x *= 0.82;
      this.vel.y *= 0.82;
      if (impact > 3 && this.onBounce) this.onBounce(impact);
    }
  }
}
