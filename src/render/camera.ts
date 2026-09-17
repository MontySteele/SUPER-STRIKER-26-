// Camera director (§7.2). One rig, many jobs: a damped tele-broadcast follow
// that leads the play and swings up at the ends, a set-piece package that is
// ALLOWED to cut (dead ball only), a goal presentation built from moving
// replay rigs, and a stadium beauty crane for the cards.
//
// Two rules the whole file is built around:
//   1. No hard cuts during open play, ever. Every open-play pose is reached by
//      exponential damping, and the only thing that changes is the target.
//   2. Cuts are explicit and announced. `cut()` hard-sets the pose and fires
//      onCut(kind) so the broadcast package can lay a 0.6s wipe over it.

import * as THREE from 'three';
import { angleDiff, clamp, damp, dampAngle, lerp } from '../core/math';
import { HALF_L, HALF_W } from '../sim/constants';

export type CamMode =
  // open play
  | 'broadcast'
  // dead-ball package
  | 'setpiece' | 'penalty'
  // goal presentation
  | 'goalLine' | 'celebration' | 'crowd'
  // replay rigs (all moving)
  | 'goalCrane' | 'goalDolly' | 'ballCam' | 'cine'
  // legacy static replay angles, kept so old call sites still type-check
  | 'replay' | 'replayLow'
  // cards / pre-match
  | 'beauty'
  // driven from outside (cutscenes)
  | 'external';

/** A pose handed in from outside (cutscene scripts, set-piece directors). */
export interface ExternalPose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov?: number;
  /** seconds of smoothing half-life; 0 = hard set (a broadcast cut) */
  halfLife?: number;
}

export type SetPieceKind = 'kickoff' | 'corner' | 'freeKick' | 'goalKick' | 'throwIn';

/** What the set-piece rig needs to know. Sim coords; attackDir is +1 when the
 *  team taking it attacks toward +x. */
export interface SetPieceInfo {
  kind: SetPieceKind;
  x: number;
  y: number;
  attackDir: number;
}

/** Options for a mode change. */
export interface ModeOptions {
  /** Hard-cut into the new mode and announce it. Dead balls only. */
  cut?: string;
  /** Seconds spent easing the damping back to normal — a long, soft arrival
   *  used when sliding out of a set piece into open play. */
  blendIn?: number;
}

/** Live play context for the tele cam. The renderer refreshes it every frame. */
export interface PlayContext {
  /** ball velocity, sim m/s */
  vx: number;
  vy: number;
  /** bounding size of the outfielders around the ball, metres */
  spreadX: number;
  spreadY: number;
}

const ease = (t: number): number => t * t * (3 - 2 * t);

/** Celebration rig: how close the lens may EVER get to the scorer, measured
 *  flat on the pitch, and how low it may sit. A tracking rig damped onto a
 *  sprinting subject will otherwise coast into his face. */
const CELEB_MIN_R = 3.2;
const CELEB_MIN_Y = 1.4;

export class CameraDirector {
  mode: CamMode = 'broadcast';
  private pos = new THREE.Vector3(0, 26, 48);
  private look = new THREE.Vector3(0, 0, 0);
  /** seconds spent in the current mode — drives every canned move */
  private modeT = 0;
  private cutPending = false;
  private blendT = 0;
  private blendLen = 1;

  /** subject for the celebration rig (world coords; the cutscene layer moves it) */
  subject = new THREE.Vector3();
  replayGoalSide = 1;
  penaltySide = 1;
  /** drives the camera while mode === 'external' (owner: cutscenes / set-piece directors) */
  external: ExternalPose = { pos: new THREE.Vector3(0, 26, 48), look: new THREE.Vector3() };
  /** drives the camera while mode === 'setpiece' */
  setPiece: SetPieceInfo | null = null;

  /** Fires on every hard cut, with a kind ('corner', 'replay', 'beauty', …).
   *  The broadcast package hangs its wipe off this; the director never draws
   *  a transition itself. */
  onCut: ((kind: string) => void) | null = null;

  play: PlayContext = { vx: 0, vy: 0, spreadX: 18, spreadY: 14 };
  /** progress 0..1 through the current replay pass; the moving rigs ride it */
  passT = 0;

  /** stadium-scale beauty crane; set from the venue tier */
  beautyRadius = 120;
  beautyHeight = 46;

  // --- smoothed tele-cam internals -----------------------------------------
  /** dead-zoned ball anchor, sim coords */
  private anchorX = 0;
  private anchorY = 0;
  /** velocity look-ahead, smoothed */
  private leadX = 0;
  private leadY = 0;
  /** 0 = tight compact play, 1 = stretched/fast: drives height, distance, fov */
  private zoom = 0;
  /** 0 = midfield, 1 = deep in either end: drives the goalmouth swing */
  private endT = 0;
  private fov: number;
  /** smoothed ball heading for the chase rig */
  private ballDirA = 0;
  private ballDirSet = false;
  /** last frame's subject, and its smoothed velocity, for the celebration rig */
  private subjPrev = new THREE.Vector3();
  private subjVel = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {
    this.fov = camera.fov;
  }

  setMode(m: CamMode, opt?: ModeOptions): void {
    const same = this.mode === m;
    this.mode = m;
    if (!same) this.modeT = 0;
    if (m === 'ballCam') this.ballDirSet = false;
    if (m === 'celebration' && !same) {
      // the subject usually TELEPORTS into place on the frame we cut to him
      // (it is set to the scorer, wherever he is); starting the tracker from
      // rest stops that jump being read as a 400 m/s sprint
      this.subjPrev.copy(this.subject);
      this.subjVel.set(0, 0, 0);
    }
    if (opt?.cut) this.cut(opt.cut);
    if (opt?.blendIn) {
      this.blendLen = opt.blendIn;
      this.blendT = opt.blendIn;
    }
  }

  /** Hard-cut on the next update and announce it (dead balls only, §7.2). */
  cut(kind: string): void {
    this.cutPending = true;
    this.blendT = 0;
    this.onCut?.(kind);
  }

  /** Half-life of the damping for the mode we are in, in seconds. */
  private modeHalfLife(): number {
    switch (this.mode) {
      case 'broadcast': return 0.30;
      case 'setpiece': return 0.50;
      case 'celebration': return 0.22;
      case 'crowd': return 0.70;
      case 'beauty': return 0.85;
      case 'goalLine': return 0.22;
      case 'goalCrane': return 0.26;
      case 'goalDolly': return 0.45;
      case 'ballCam': return 0.16;
      case 'cine': return 0.30;
      case 'penalty': return 0.20;
      case 'external': return this.external.halfLife ?? 0.12;
      default: return 0.14;
    }
  }

  /**
   * The tele cam's ball tracker, run every frame whatever the mode is so the
   * rig is already warm when we blend back into open play.
   *
   * A dead zone (the camera simply ignores ball motion inside a small box)
   * is what stops a stepover from shaking the whole frame; a slow pull back
   * toward the ball on top of it keeps the offset from becoming permanent.
   * The look-ahead leads the play the way a human operator does — the frame
   * moves before the ball gets there, not after.
   */
  private trackPlay(dt: number, bx: number, by: number): void {
    const DZX = 2.4;
    const DZY = 1.7;
    const dx = bx - this.anchorX;
    if (dx > DZX) this.anchorX = bx - DZX;
    else if (dx < -DZX) this.anchorX = bx + DZX;
    const dy = by - this.anchorY;
    if (dy > DZY) this.anchorY = by - DZY;
    else if (dy < -DZY) this.anchorY = by + DZY;
    this.anchorX = damp(this.anchorX, bx, 1.6, dt);
    this.anchorY = damp(this.anchorY, by, 2.0, dt);

    const p = this.play;
    this.leadX = damp(this.leadX, clamp(p.vx * 0.40, -10, 10), 0.40, dt);
    this.leadY = damp(this.leadY, clamp(p.vy * 0.22, -5, 5), 0.45, dt);

    const speed = Math.hypot(p.vx, p.vy);
    const zt = clamp(p.spreadX / 40, 0, 1) * 0.55
      + clamp(p.spreadY / 34, 0, 1) * 0.2
      + clamp(speed / 22, 0, 1) * 0.25;
    this.zoom = damp(this.zoom, clamp(zt, 0, 1), 0.9, dt);

    const ax = this.anchorX + this.leadX;
    this.endT = damp(this.endT, ease(clamp((Math.abs(ax) - 26) / 17, 0, 1)), 0.55, dt);
  }

  /**
   * Differentiate `subject` — the only signal the cutscene layer gives us —
   * into a smoothed velocity the celebration rig can lead. Clamped because a
   * subject that is re-pointed at a different player is a teleport, not a run.
   */
  private trackSubject(dt: number): void {
    if (dt > 1e-6) {
      const vx = clamp((this.subject.x - this.subjPrev.x) / dt, -12, 12);
      const vz = clamp((this.subject.z - this.subjPrev.z) / dt, -12, 12);
      this.subjVel.x = damp(this.subjVel.x, vx, 0.25, dt);
      this.subjVel.z = damp(this.subjVel.z, vz, 0.25, dt);
    }
    this.subjPrev.copy(this.subject);
  }

  /**
   * The celebration rig's hard floor, applied to the DAMPED pose rather than
   * the target: a target that respects the minimum is not enough, because the
   * lag behind a 7 m/s subject is what closes the gap. Pushes the lens back
   * out along its own bearing, so the shot keeps its angle and only loses the
   * last metre of the push-in.
   */
  private enforceCelebrationFloor(): void {
    let dx = this.pos.x - this.subject.x;
    let dz = this.pos.z - this.subject.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-3) { dx = 0; dz = 1; d = 1; } // degenerate: pick the near side
    if (d < CELEB_MIN_R) {
      this.pos.x = this.subject.x + (dx / d) * CELEB_MIN_R;
      this.pos.z = this.subject.z + (dz / d) * CELEB_MIN_R;
    }
    if (this.pos.y < CELEB_MIN_Y) this.pos.y = CELEB_MIN_Y;
  }

  /** ballX/ballY are sim coords; ballZ height. dt is render dt. */
  update(dt: number, ballX: number, ballY: number, ballZ: number): void {
    this.modeT += dt;
    this.trackPlay(dt, ballX, ballY);
    this.trackSubject(dt);

    let tx: number, ty: number, tz: number;
    let lx: number, ly: number, lz: number;
    let fovT = this.fov;

    switch (this.mode) {
      case 'external': {
        const e = this.external;
        tx = e.pos.x; ty = e.pos.y; tz = e.pos.z;
        lx = e.look.x; ly = e.look.y; lz = e.look.z;
        if (e.fov !== undefined) fovT = e.fov;
        break;
      }

      // ------------------------------------------------------- goal package
      case 'celebration': {
        // Low, TV-height, arcing slowly around the scorer with a push-in.
        // The subject is live and FAST — the cutscene layer sprints him at the
        // corner flag — so the rig anchors on where he is about to be rather
        // than where he was, and the push-in eases toward CELEB_MIN_R instead
        // of through it. The damped rig still lags a sprint by a metre or two,
        // which is why there is also a hard floor applied after the damping.
        const push = ease(clamp(this.modeT / 3.0, 0, 1));
        const r = lerp(9.0, CELEB_MIN_R + 0.8, push);
        const a = 1.15 + this.modeT * 0.20;
        // lead him: the rig anchor a little, the aim a little more, so a
        // 7 m/s run drifts toward the middle of frame instead of out of it
        const ax = this.subject.x + this.subjVel.x * 0.20;
        const az = this.subject.z + this.subjVel.z * 0.20;
        // kept inside the goal line so a celebration that drifts behind the
        // net does not put the rig inside the netting
        tx = clamp(ax + Math.cos(a) * r * 0.8, -(HALF_L - 2), HALF_L - 2);
        tz = clamp(az + Math.sin(a) * r, -43, 43);
        ty = lerp(2.55, 1.9, push);
        lx = this.subject.x + this.subjVel.x * 0.32;
        ly = 1.35;
        lz = this.subject.z + this.subjVel.z * 0.32;
        fovT = lerp(36, 30, push);
        break;
      }
      case 'crowd': {
        // The cutaway. Not a tight lens on a rake — at this card density that
        // is an unreadable wall of noise. The shot that works is the corner of
        // the bowl: two stands meeting, a floodlight pylon, and a sliver of
        // the pitch and the ad boards along the bottom for scale.
        const t = this.modeT;
        const s = this.replayGoalSide;
        tx = s * (8 + t * 2);
        ty = 7 + t * 0.5;
        tz = -18 + t * 3;
        lx = s * 48; ly = 11; lz = 42;
        fovT = 40;
        break;
      }
      case 'goalLine': {
        // The moment itself: behind the net, creeping toward the post. Far
        // enough back that the netting frames the shot instead of filling it.
        const s = this.replayGoalSide;
        const t = this.passT;
        tx = s * (HALF_L + 12.5 - t * 2.5);
        ty = 2.8 + t * 1.4;
        tz = 9.8 - t * 4.2;
        lx = ballX; ly = Math.max(ballZ, 0.55); lz = ballY;
        fovT = 29;
        break;
      }

      // ------------------------------------------------------- replay rigs
      case 'goalCrane': {
        // High crane behind the goal, drifting across the width of it. It
        // aims between the ball and the goalmouth, not at the ball: a crane
        // that tracks the ball alone during the build-up is pointing at bare
        // grass with no goal in shot, which is the one thing this angle owes.
        const s = this.replayGoalSide;
        const t = ease(this.passT);
        tx = s * (HALF_L + 13 - t * 3);
        ty = 10.5 - t * 3.0;
        tz = -9 + t * 16;
        lx = lerp(s * (HALF_L - 6), ballX, 0.6);
        ly = Math.max(ballZ * 0.6, 1.2);
        lz = ballY * 0.35;
        fovT = 40;
        break;
      }
      case 'goalDolly': {
        // Low sideline dolly: rides the ball along the touchline (the lag is
        // the mode's long half-life, not a hand-authored curve) and pushes in.
        const t = ease(this.passT);
        tx = clamp(ballX, -46, 46);
        ty = 2.0 - t * 0.4 + ballZ * 0.12;
        // never dolly INSIDE the field of play when the ball hugs the near
        // touchline — a TV dolly lives outside the line, always
        tz = Math.max(27.5 - t * 5.5, ballY + 9);
        lx = ballX; ly = Math.max(ballZ * 0.75, 0.8) + 1.1; lz = ballY * 0.5;
        fovT = 34 - t * 2;
        break;
      }
      case 'ballCam': {
        // A few metres off the ball's own trajectory, looking down it. The
        // heading is the ball's velocity pulled a third of the way toward the
        // goal it is heading for — a pure velocity chase whips around on
        // every touch of a dribble and ends up facing the ad boards.
        const p = this.play;
        const speed = Math.hypot(p.vx, p.vy);
        const gAng = Math.atan2(-ballY, HALF_L * this.replayGoalSide - ballX);
        let aT = gAng;
        if (speed > 0.8) {
          const vAng = Math.atan2(p.vy, p.vx);
          aT = vAng + angleDiff(vAng, gAng) * 0.35;
        }
        if (!this.ballDirSet) { this.ballDirA = aT; this.ballDirSet = true; }
        else this.ballDirA = dampAngle(this.ballDirA, aT, 0.35, dt);
        const dx = Math.cos(this.ballDirA);
        const dy = Math.sin(this.ballDirA);
        tx = clamp(ballX - dx * 7.5, -(HALF_L + 6), HALF_L + 6);
        tz = clamp(ballY - dy * 7.5, -43, 43);
        ty = Math.max(ballZ * 0.6 + 2.6, 1.8);
        lx = ballX + dx * 3.5; ly = Math.max(ballZ, 0.5) + 0.55; lz = ballY + dy * 3.5;
        fovT = 40;
        break;
      }
      case 'cine': {
        // On-demand replay: low sideline tracker that creeps in as it runs.
        const t = ease(this.passT);
        tx = clamp(ballX * 0.95, -46, 46);
        ty = 3.4 - t * 1.0 + ballZ * 0.25;
        tz = Math.max(22 - t * 4.5, ballY + 8);
        lx = ballX; ly = Math.max(ballZ * 0.7, 0.7) + 0.9; lz = ballY * 0.6;
        fovT = 34 - t * 2;
        break;
      }
      case 'replay': {
        // legacy static angle: low corner at the scoring end
        const gx = HALF_L * this.replayGoalSide;
        tx = gx - this.replayGoalSide * 18;
        ty = 3.4;
        tz = 26;
        lx = ballX; ly = Math.max(ballZ, 0.6); lz = ballY;
        break;
      }
      case 'replayLow': {
        // legacy static angle: pitch-level from the far post
        const gx = HALF_L * this.replayGoalSide;
        tx = gx - this.replayGoalSide * 9;
        ty = 1.3;
        tz = -21;
        lx = ballX; ly = Math.max(ballZ, 0.8); lz = ballY;
        break;
      }

      // -------------------------------------------------- dead-ball package
      case 'penalty': {
        // behind the taker, low, goal filling the frame, creeping in
        const gx = HALF_L * this.penaltySide;
        const t = ease(clamp(this.modeT / 4, 0, 1));
        tx = gx - this.penaltySide * (24 - t * 2.5);
        ty = 5.2 - t * 0.5;
        tz = 7.5 - t * 0.8;
        lx = gx - this.penaltySide * 4; ly = 1.2; lz = 0;
        fovT = 34;
        break;
      }
      case 'setpiece': {
        const sp = this.setPiece;
        const t = this.modeT;
        // every set-piece pose breathes a little; a dead still reads as a bug
        const dxr = Math.cos(t * 0.40) * 0.7;
        const dzr = Math.sin(t * 0.55) * 0.9;
        const d = sp ? sp.attackDir : 1;
        const sx = sp ? sp.x : 0;
        const sy = sp ? sp.y : 0;
        const kind: SetPieceKind = sp ? sp.kind : 'kickoff';
        if (kind === 'kickoff') {
          // high, wide, centred: the whole pitch and both shapes
          tx = dxr; ty = 33; tz = 55 + dzr;
          lx = 0; ly = 1.2; lz = -3.5;
          fovT = 34;
        } else if (kind === 'corner') {
          // behind and above the flag, looking down the six-yard box: goal on
          // one edge, the whole crowded box across the frame
          const gx = HALF_L * d;
          const cy = Math.sign(sy) || 1;
          tx = gx + d * 7.5 + dxr;
          ty = 12.0;
          tz = cy * 42 + dzr;
          lx = gx - d * 8.5; ly = 1.5; lz = cy * 4;
          fovT = 30;
        } else if (kind === 'freeKick') {
          // behind the taker, slightly elevated, down the line of the shot
          const gx = HALF_L * d;
          const vx = gx - sx;
          const vy = 0 - sy;
          const l = Math.hypot(vx, vy) || 1;
          const ux = vx / l;
          const uy = vy / l;
          tx = clamp(sx - ux * 17, -(HALF_L + 6), HALF_L + 6) + dxr;
          tz = clamp(sy - uy * 17, -42, 42) + dzr;
          ty = 6.8;
          lx = sx + ux * 14; ly = 1.9; lz = sy + uy * 14;
          fovT = 33;
        } else if (kind === 'goalKick') {
          // behind the keeper, wide, the length of the pitch ahead of him
          const ogx = -HALF_L * d;
          tx = ogx - d * 9.5 + dxr;
          ty = 12.0;
          tz = 9.5 + dzr;
          lx = ogx + d * 26; ly = 2.2; lz = 0;
          fovT = 38;
        } else {
          // Throw-in: touchline, medium. ALWAYS shot from the broadcast side,
          // even for a far-side throw — flipping the pitch left-to-right on a
          // dead ball is the single most disorienting cut there is. A far-side
          // throw is covered the way TV covers it instead: same side, long
          // lens, which is what the distance-driven fov below is doing.
          tx = clamp(sx - d * 10, -58, 58) + dxr;
          ty = 7.5;
          tz = 41 + dzr;
          lx = sx + d * 4; ly = 1.4; lz = sy + (41 - sy) * 0.08;
          const dist = Math.hypot(tx - lx, ty - ly, tz - lz);
          fovT = clamp(560 / dist, 15, 36);
        }
        break;
      }

      // ------------------------------------------------------------ cards
      case 'beauty': {
        // slow stadium crane: half-time, full-time, pre-match attract
        const t = this.modeT;
        const a = 0.9 + t * 0.055;
        const r = this.beautyRadius + Math.sin(t * 0.09) * 8;
        tx = Math.cos(a) * r;
        tz = Math.sin(a) * r;
        ty = this.beautyHeight + Math.sin(t * 0.07) * 5;
        lx = 0; ly = 4 + Math.sin(t * 0.05) * 2; lz = 0;
        fovT = 32;
        break;
      }

      // -------------------------------------------------------- open play
      case 'broadcast':
      default: {
        // Elevated side-on tele cam. The rig lives past the +y touchline, so
        // the two halves of the pitch are NOT symmetric: play on the near
        // side is metres from the lens and needs a much bigger rise and
        // pull-back than play on the far side, which is already 70m away.
        const ax = this.anchorX + this.leadX;
        const ay = this.anchorY + this.leadY;
        const s = Math.sign(ax) || 1;
        const near = clamp(ay, 0, HALF_W);
        const far = clamp(-ay, 0, HALF_W);
        const lateral = near * 0.44 + far * 0.17;
        const e = this.endT;

        tx = clamp(ax * 0.86, -40, 40);
        // End zone: the rig holds back off the goal line, drops its height and
        // PULLS UP — tilts and pans onto the goalmouth, which is what a tele
        // operator actually does — so net, keeper and shooter share a frame.
        // Rising here instead would give a tactical top-down, not TV.
        tx = lerp(tx, s * (HALF_L - 24), e * 0.68);
        // Height stays near broadcast-gantry height whatever happens: play on
        // the near touchline is answered by BACKING OFF, not by climbing.
        // Climbing gives a 40-degree tactical top-down, which is the one
        // camera note the reference footage never has. tz is capped so the
        // rig never ends up inside the near stand's upper tiers.
        ty = 19.5 + lateral * 0.12 + this.zoom * 7.0 - e * 4.0;
        tz = Math.min(37.0 + lateral * 1.5 + this.zoom * 10.5, 58);

        lx = lerp(clamp(ax * 0.94, -46, 46), s * (HALF_L - 4), e * 0.65);
        ly = lerp(0.6 + ballZ * 0.25, 1.8, e);
        lz = lerp(ay * 0.5 - 1, ay * 0.35 - 4, e);
        fovT = 34.5 + this.zoom * 2.5 - e * 3.0;
        break;
      }
    }

    let hl = this.modeHalfLife();
    if (this.blendT > 0) {
      // a long, soft arrival out of a dead-ball pose into open play
      hl = lerp(hl, 0.62, this.blendT / this.blendLen);
      this.blendT = Math.max(0, this.blendT - dt);
    }

    const hard = this.cutPending || hl <= 0;
    this.cutPending = false;
    if (hard) {
      this.pos.set(tx, ty, tz);
      this.look.set(lx, ly, lz);
      this.fov = fovT;
    } else {
      this.pos.x = damp(this.pos.x, tx, hl, dt);
      this.pos.y = damp(this.pos.y, ty, hl, dt);
      this.pos.z = damp(this.pos.z, tz, hl, dt);
      this.look.x = damp(this.look.x, lx, hl * 0.8, dt);
      this.look.y = damp(this.look.y, ly, hl * 0.8, dt);
      this.look.z = damp(this.look.z, lz, hl * 0.8, dt);
      this.fov = damp(this.fov, fovT, hl * 1.8, dt);
    }

    if (this.mode === 'celebration') this.enforceCelebrationFloor();

    if (Math.abs(this.camera.fov - this.fov) > 1e-3) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(this.pos);
    // up is always +y, so the horizon can never roll
    this.camera.lookAt(this.look);
  }

  /** Hard-set for mode entries that SHOULD cut (replay is a broadcast cut). */
  snap(): void {
    this.pos.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
  }

  jumpTo(x: number, y: number, z: number, lx: number, ly: number, lz: number): void {
    this.pos.set(x, y, z);
    this.look.set(lx, ly, lz);
    this.fov = this.camera.fov;
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
