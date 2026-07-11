// Camera director (§7.2): smooth-damped broadcast follow, celebration orbit,
// behind-goal replay. No hard cuts during open play, ever.

import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import { HALF_L } from '../sim/constants';

export type CamMode = 'broadcast' | 'celebration' | 'replay' | 'penalty';

export class CameraDirector {
  mode: CamMode = 'broadcast';
  private pos = new THREE.Vector3(0, 26, 48);
  private look = new THREE.Vector3(0, 0, 0);
  private orbitT = 0;
  /** subject for celebration orbit (world coords) */
  subject = new THREE.Vector3();
  replayGoalSide = 1;
  penaltySide = 1;

  constructor(private camera: THREE.PerspectiveCamera) {}

  setMode(m: CamMode): void {
    this.mode = m;
    this.orbitT = 0;
  }

  /** ballX/ballY are sim coords; ballZ height. dt is render dt. */
  update(dt: number, ballX: number, ballY: number, ballZ: number): void {
    let tx: number, ty: number, tz: number;
    let lx: number, ly: number, lz: number;
    const halfLife = 0.28;

    switch (this.mode) {
      case 'celebration': {
        this.orbitT += dt * 0.55;
        const r = 7.5;
        tx = this.subject.x + Math.cos(this.orbitT) * r;
        ty = 2.6 + Math.sin(this.orbitT * 0.7) * 0.8;
        tz = this.subject.z + Math.sin(this.orbitT) * r;
        lx = this.subject.x; ly = 1.2; lz = this.subject.z;
        break;
      }
      case 'penalty': {
        // behind the taker, low, goal filling the frame
        const gx = HALF_L * this.penaltySide;
        tx = gx - this.penaltySide * 24;
        ty = 5.2;
        tz = 7.5;
        lx = gx - this.penaltySide * 4; ly = 1.2; lz = 0;
        break;
      }
      case 'replay': {
        // low corner angle at the scoring end — sees shooter, keeper and net
        const gx = HALF_L * this.replayGoalSide;
        tx = gx - this.replayGoalSide * 18;
        ty = 3.4;
        tz = 26;
        lx = ballX; ly = Math.max(ballZ, 0.6); lz = ballY;
        break;
      }
      case 'broadcast':
      default: {
        // elevated side-on, slight zoom-out as play stretches (§7.2)
        const cx = clamp(ballX * 0.86, -40, 40);
        const stretch = Math.abs(ballY) * 0.2;
        tx = cx;
        ty = 22 + stretch * 0.7;
        tz = 40 + stretch;
        lx = clamp(ballX * 0.94, -46, 46);
        ly = 0.5 + ballZ * 0.25;
        lz = ballY * 0.55 - 2;
        break;
      }
    }

    const hl = this.mode === 'broadcast' ? halfLife : 0.12;
    this.pos.x = damp(this.pos.x, tx, hl, dt);
    this.pos.y = damp(this.pos.y, ty, hl, dt);
    this.pos.z = damp(this.pos.z, tz, hl, dt);
    this.look.x = damp(this.look.x, lx, hl * 0.8, dt);
    this.look.y = damp(this.look.y, ly, hl * 0.8, dt);
    this.look.z = damp(this.look.z, lz, hl * 0.8, dt);

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  /** Hard-set for mode entries that SHOULD cut (replay is a broadcast cut). */
  snap(): void {
    this.pos.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
  }

  jumpTo(x: number, y: number, z: number, lx: number, ly: number, lz: number): void {
    this.pos.set(x, y, z);
    this.look.set(lx, ly, lz);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
