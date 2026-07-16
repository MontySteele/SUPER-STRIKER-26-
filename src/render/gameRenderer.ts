// Renderer orchestrator: syncs meshes from sim snapshots (interpolated),
// records a replay ring buffer, runs the goal sequence (slow-mo celebration →
// replay → back), confetti, switch indicator.

import * as THREE from 'three';
import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import type { PlayerEntity, ActionAnim } from '../sim/player';
import { SceneManager, type TimeOfDay } from './scene';
import { buildPitch } from './pitch';
import { Stadium, type StadiumSize } from './stadium';
import { PlayerMesh, resolveKits } from './playerMesh';
import { BallMesh } from './ballMesh';
import { CameraDirector, type CamMode } from './camera';
import { HALF_L } from '../sim/constants';

interface Snap {
  x: number; y: number; facing: number; speed: number;
}

const REPLAY_SECONDS = 6;
const REPLAY_FPS = 30;

interface ReplayFrame {
  ball: [number, number, number];
  players: Snap[];
  anims: [ActionAnim, number][];
}

/** One camera angle over some slice of the frozen clip. */
interface ReplayPass {
  mode: CamMode;
  rate: number;   // playback speed (1 = real time)
  from: number;   // start point as a fraction of the clip
}

// The goal recap: full build-up from behind the goal, then the strike again
// from pitch level in heavy slow-mo.
const GOAL_PASSES: ReplayPass[] = [
  { mode: 'replay', rate: 0.6, from: 0.2 },
  { mode: 'replayLow', rate: 0.35, from: 0.62 },
];

export class GameRenderer {
  sceneMgr: SceneManager;
  stadium: Stadium;
  cam: CameraDirector;
  playerMeshes: PlayerMesh[] = [];
  ballMesh: BallMesh;
  switchArrows: [THREE.Mesh, THREE.Mesh];
  controlRings: [THREE.Mesh, THREE.Mesh];
  private ringPulse = [0, 0];

  // interpolation snapshots
  private prevSnaps: Snap[] = [];
  private currSnaps: Snap[] = [];
  private prevBall: [number, number, number] = [0, 0, 0];
  private currBall: [number, number, number] = [0, 0, 0];

  // replay
  private replayBuf: ReplayFrame[] = [];
  private replayAccum = 0;
  private goalSeqT = -1; // >= 0 while running the goal presentation
  private goalReplayPending = false;
  private passes: ReplayPass[] = [];
  private passIdx = 0;
  private passFrames: ReplayFrame[] = [];
  private replayIdx = 0;
  private manualReplay = false; // user-triggered; main freezes the sim for us
  private lastGoalClip: { frames: ReplayFrame[]; side: number } | null = null;
  onReplayStateChange: ((on: boolean, label?: string) => void) | null = null;

  private confetti: THREE.Points | null = null;
  private confettiVel: Float32Array | null = null;
  private confettiT = 0;
  /** clash-resolved outfield shirt colors, [home, away] */
  private shirts: [string, string] = ['#ffffff', '#ffffff'];
  // comet trail behind the ball during replays (additive, fades to the tail)
  private trail: THREE.Points | null = null;
  private trailPts: [number, number, number][] = [];

  constructor(canvas: HTMLCanvasElement, private match: Match, timeOfDay: TimeOfDay,
    stadiumSize: StadiumSize = 'national') {
    this.sceneMgr = new SceneManager(canvas, timeOfDay);
    buildPitch(this.sceneMgr.scene);
    this.stadium = new Stadium(this.sceneMgr.scene, timeOfDay === 'night', stadiumSize);
    this.cam = new CameraDirector(this.sceneMgr.camera);
    this.ballMesh = new BallMesh(this.sceneMgr.scene);

    const [homeKit, awayKit, gkA, gkB] = resolveKits(match.teams[0].data.kit, match.teams[1].data.kit);
    this.shirts = [homeKit.shirt, awayKit.shirt];
    match.teams[0].players.forEach((p) => {
      this.playerMeshes.push(new PlayerMesh(p.data, p.isGK ? gkA : homeKit));
    });
    match.teams[1].players.forEach((p) => {
      this.playerMeshes.push(new PlayerMesh(p.data, p.isGK ? gkB : awayKit));
    });
    for (const pm of this.playerMeshes) this.sceneMgr.scene.add(pm.root);

    // chunky switch indicators (§5): P1 gold, P2 silver — arrow overhead
    // plus a glowing ring at the feet so "who am I?" reads at a glance
    const mkArrow = (color: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(0.36, 0.68, 4),
        new THREE.MeshBasicMaterial({ color }),
      );
      m.rotation.x = Math.PI;
      this.sceneMgr.scene.add(m);
      return m;
    };
    this.switchArrows = [mkArrow(0xffce4a), mkArrow(0xdde4f0)];
    const mkRing = (color: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.8, 32),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.65,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.04;
      this.sceneMgr.scene.add(m);
      return m;
    };
    this.controlRings = [mkRing(0xffce4a), mkRing(0xdde4f0)];

    this.snapshot();
    this.snapshot();
    this.cam.jumpTo(0, 30, 60, 0, 0, 0);
  }

  /** Called after every fixed sim tick. */
  snapshot(): void {
    this.prevSnaps = this.currSnaps;
    this.prevBall = this.currBall;
    const players = this.match.allPlayers;
    this.currSnaps = players.map((p) => ({
      x: p.pos.x, y: p.pos.y, facing: p.facing,
      speed: Math.hypot(p.vel.x, p.vel.y),
    }));
    const b = this.match.ball.pos;
    this.currBall = [b.x, b.y, b.z];

    // replay recording at 30fps
    this.replayAccum += 1;
    if (this.replayAccum >= 60 / REPLAY_FPS) {
      this.replayAccum = 0;
      this.replayBuf.push({
        ball: [b.x, b.y, b.z],
        players: this.currSnaps.map((s) => ({ ...s })),
        anims: players.map((p) => [p.actionAnim, p.actionAnimT]),
      });
      if (this.replayBuf.length > REPLAY_SECONDS * REPLAY_FPS) this.replayBuf.shift();
    }
  }

  onEvent(e: MatchEvent): void {
    if (e.type === 'switch') {
      this.ringPulse[e.teamIdx] = 0.3;
      return;
    }
    if (e.type === 'goal') {
      this.goalSeqT = 0;
      // celebration subject: the scorer's mesh — matched by shirt number,
      // since display names can be duplicated (roster editor, factory dupe)
      const scorer = e.ownGoal ? undefined : this.match.allPlayers.find(
        (p) => p.teamIdx === e.teamIdx
          && (e.scorerNum !== undefined ? p.data.num === e.scorerNum : p.data.name === e.scorerName),
      );
      // own goals name a player on the other team — fall back to the ball
      if (scorer) this.cam.subject.set(scorer.pos.x, 0, scorer.pos.y);
      else this.cam.subject.set(this.match.ball.pos.x, 0, this.match.ball.pos.y);
      this.cam.replayGoalSide = Math.sign(this.match.ball.pos.x) || 1;
      this.cam.setMode('celebration');
      // freeze the clip now — the goal sequence recaps it, and the full-time
      // card can bring it back
      this.lastGoalClip = {
        frames: this.replayBuf.slice(Math.max(0, this.replayBuf.length - 4 * REPLAY_FPS)),
        side: this.cam.replayGoalSide,
      };
      this.goalReplayPending = true;
      this.spawnConfetti(e.teamIdx);
    }
  }

  // ------------------------------------------------------------- replay passes

  private beginPasses(frames: ReplayFrame[], passes: ReplayPass[]): void {
    this.passFrames = frames;
    this.passes = passes;
    this.startPass(0);
  }

  private startPass(i: number): void {
    this.passIdx = i;
    const p = this.passes[i];
    this.replayIdx = Math.floor(this.passFrames.length * p.from);
    this.clearTrail(); // the angle cut rewinds time — no stale streak
    this.cam.setMode(p.mode);
    this.onReplayStateChange?.(true, i === 0 ? 'REPLAY' : `REPLAY · ANGLE ${i + 1}`);
  }

  private clearPasses(): void {
    this.passes = [];
    this.passFrames = [];
  }

  /** True while a user-triggered replay is playing (main freezes the sim). */
  isReplaying(): boolean {
    return this.manualReplay;
  }

  hasGoalClip(): boolean {
    return this.lastGoalClip !== null;
  }

  /**
   * Start a user-triggered replay: 'live' rewinds the last few seconds of
   * open play; 'goal' re-runs the multi-angle recap of the last goal.
   * Returns false when there's nothing worth showing yet.
   */
  startManualReplay(source: 'live' | 'goal'): boolean {
    if (this.manualReplay || this.passes.length > 0) return false;
    if (source === 'goal') {
      if (!this.lastGoalClip || this.lastGoalClip.frames.length < 20) return false;
      this.cam.replayGoalSide = this.lastGoalClip.side;
      this.manualReplay = true;
      this.beginPasses(this.lastGoalClip.frames, GOAL_PASSES);
    } else {
      if (this.replayBuf.length < 1.5 * REPLAY_FPS) return false;
      this.manualReplay = true;
      // last ~4.5s at 0.6x ≈ 7.5s of wall clock — long enough to relive the
      // moment, short enough that a frozen match doesn't feel hung
      this.beginPasses(this.replayBuf.slice(-Math.floor(4.5 * REPLAY_FPS)),
        [{ mode: 'cine', rate: 0.6, from: 0 }]);
    }
    return true;
  }

  /** Cut a manual replay short (any button skips). */
  stopManualReplay(): void {
    if (!this.manualReplay) return;
    this.manualReplay = false;
    this.clearPasses();
    this.cam.setMode('broadcast');
    this.onReplayStateChange?.(false);
  }

  private pushTrail(x: number, y: number, z: number): void {
    const N = 22;
    if (!this.trail) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      this.trail = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 0.26, vertexColors: true, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.trail.frustumCulled = false;
      this.sceneMgr.scene.add(this.trail);
    }
    this.trailPts.push([x, y, z]);
    if (this.trailPts.length > N) this.trailPts.shift();
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      const real = i < this.trailPts.length;
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)];
      pos.setXYZ(i, p[0], p[2] + 0.11, p[1]); // sim (x, ground-y, height-z) → scene (x, y, z)
      // padding slots are invisible — head-bright padding stacked ~12x
      // overbright at the start of every replay angle
      const b = real ? Math.pow((i + 1) / this.trailPts.length, 1.6) * 0.55 : 0;
      col.setXYZ(i, b, b, b * 0.9);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  private clearTrail(): void {
    this.trailPts = [];
    if (this.trail) {
      this.sceneMgr.scene.remove(this.trail);
      this.trail.geometry.dispose();
      (this.trail.material as THREE.Material).dispose();
      this.trail = null;
    }
  }

  private removeConfetti(): void {
    if (!this.confetti) return;
    this.sceneMgr.scene.remove(this.confetti);
    this.confetti.geometry.dispose();
    (this.confetti.material as THREE.Material).dispose();
    this.confetti = null;
  }

  private spawnConfetti(teamIdx: number): void {
    this.removeConfetti();
    const N = 380;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const kit = new THREE.Color(this.shirts[teamIdx]); // what they actually wear
    const gold = new THREE.Color(0xffce4a);
    const gx = HALF_L * Math.sign(this.match.ball.pos.x || 1);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = gx + (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = 12 + Math.random() * 14;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 46;
      vel[i * 3] = (Math.random() - 0.5) * 2;
      vel[i * 3 + 1] = -(1.2 + Math.random() * 1.8);
      vel[i * 3 + 2] = (Math.random() - 0.5) * 2;
      const c = Math.random() > 0.5 ? kit : gold;
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.confetti = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.35, vertexColors: true, transparent: true, opacity: 0.95,
    }));
    this.confettiVel = vel;
    this.confettiT = 0;
    this.sceneMgr.scene.add(this.confetti);
  }

  /** dtReal = wall-clock frame dt; alpha = interpolation between sim ticks. */
  update(dtReal: number, alpha: number): void {
    const inGoalSeq = this.match.phase === 'goalseq';
    if (inGoalSeq && this.goalSeqT >= 0) {
      this.goalSeqT += dtReal;
      // 0–2.2s celebration orbit → multi-angle recap
      if (this.goalSeqT > 2.2 && this.goalReplayPending && this.lastGoalClip) {
        this.goalReplayPending = false;
        this.beginPasses(this.lastGoalClip.frames, GOAL_PASSES);
      }
    } else if (this.goalSeqT >= 0 && !inGoalSeq) {
      // sequence over (or skipped) — back to broadcast (UI wipe covers the cut)
      this.goalSeqT = -1;
      this.goalReplayPending = false;
      if (!this.manualReplay) {
        this.clearPasses();
        this.cam.setMode('broadcast');
        this.onReplayStateChange?.(false);
      }
    }

    const replaying = this.passes.length > 0;
    let ballX: number, ballY: number, ballZ: number;

    if (replaying) {
      const pass = this.passes[this.passIdx];
      this.replayIdx = Math.min(
        this.replayIdx + dtReal * REPLAY_FPS * pass.rate,
        this.passFrames.length - 1,
      );
      // interpolate between the 30fps recorded frames — nearest-frame
      // stepping stutters badly at slow-mo rates
      const i0 = Math.floor(this.replayIdx);
      const i1 = Math.min(i0 + 1, this.passFrames.length - 1);
      const frac = this.replayIdx - i0;
      const f0 = this.passFrames[i0];
      const f1 = this.passFrames[i1];
      ballX = f0.ball[0] + (f1.ball[0] - f0.ball[0]) * frac;
      ballY = f0.ball[1] + (f1.ball[1] - f0.ball[1]) * frac;
      ballZ = f0.ball[2] + (f1.ball[2] - f0.ball[2]) * frac;
      this.ballMesh.update(ballX, ballY, ballZ);
      // paused frames (dt 0) must not stack identical points into one
      // over-bright additive dot
      if (dtReal > 0) this.pushTrail(ballX, ballY, ballZ);
      f0.players.forEach((s, i) => {
        const s1 = f1.players[i];
        const x = s.x + (s1.x - s.x) * frac;
        const y = s.y + (s1.y - s.y) * frac;
        let df = s1.facing - s.facing;
        if (df > Math.PI) df -= Math.PI * 2;
        if (df < -Math.PI) df += Math.PI * 2;
        const [anim, animT] = f0.anims[i];
        // slow the run cycles with the footage or slow-mo players foot-skate
        this.playerMeshes[i].update(dtReal * pass.rate, x, y, 0, s.facing + df * frac,
          s.speed + (s1.speed - s.speed) * frac, anim, animT);
      });
      if (this.replayIdx >= this.passFrames.length - 1) {
        if (this.passIdx < this.passes.length - 1) {
          this.startPass(this.passIdx + 1);
        } else {
          this.clearPasses();
          this.onReplayStateChange?.(false);
          if (this.manualReplay) {
            this.manualReplay = false;
            this.cam.setMode('broadcast');
          } else {
            // goal sequence: hold on the celebration until the sim moves on
            this.cam.setMode('celebration');
          }
        }
      }
    } else {
      // interpolated live rendering
      const players = this.match.allPlayers;
      for (let i = 0; i < players.length; i++) {
        const a = this.prevSnaps[i] ?? this.currSnaps[i];
        const b = this.currSnaps[i];
        const x = a.x + (b.x - a.x) * alpha;
        const y = a.y + (b.y - a.y) * alpha;
        let f0 = a.facing, f1 = b.facing;
        let df = f1 - f0;
        if (df > Math.PI) df -= Math.PI * 2;
        if (df < -Math.PI) df += Math.PI * 2;
        this.playerMeshes[i].update(
          dtReal, x, y, 0, f0 + df * alpha, b.speed,
          players[i].actionAnim, players[i].actionAnimT,
        );
      }
      ballX = this.prevBall[0] + (this.currBall[0] - this.prevBall[0]) * alpha;
      ballY = this.prevBall[1] + (this.currBall[1] - this.prevBall[1]) * alpha;
      ballZ = this.prevBall[2] + (this.currBall[2] - this.prevBall[2]) * alpha;
      this.ballMesh.update(ballX, ballY, ballZ);
      if (this.trailPts.length) this.clearTrail();
    }

    // switch indicators hover over each seat's controlled player (live play
    // only — a cone bobbing through the penalty cinematic reads as a glitch)
    const inAction = this.match.phase === 'play' || this.match.phase === 'restart'
      || this.match.phase === 'kickoff';
    for (let i = 0; i < 2; i++) {
      const ctrl = this.match.controlled[i];
      const arrow = this.switchArrows[i];
      const ring = this.controlRings[i];
      this.ringPulse[i] = Math.max(0, this.ringPulse[i] - dtReal);
      if (ctrl && this.match.seats[i] && !replaying && inAction && !ctrl.sentOff) {
        arrow.visible = true;
        ring.visible = true;
        const bob = Math.sin(performance.now() * 0.006 + i * 2) * 0.08;
        arrow.position.set(ctrl.pos.x, 2.35 + bob, ctrl.pos.y);
        arrow.rotation.y += dtReal * 2;
        // ring pulses outward for a beat right after a switch
        const pulse = this.ringPulse[i] / 0.3;
        ring.position.set(ctrl.pos.x, 0.04, ctrl.pos.y);
        ring.scale.setScalar(1 + pulse * 1.2);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.65 + pulse * 0.35;
      } else {
        arrow.visible = false;
        ring.visible = false;
      }
    }

    // sent-off players leave the pitch (and the scene)
    const all = this.match.allPlayers;
    for (let i = 0; i < all.length; i++) {
      this.playerMeshes[i].root.visible = !all[i].sentOff;
    }

    // penalty / shootout camera
    const penPhase = this.match.phase === 'penalty' || this.match.phase === 'shootout';
    if (penPhase && this.cam.mode !== 'penalty') {
      this.cam.penaltySide = this.match.penalty?.goalSide ?? 1;
      this.cam.setMode('penalty');
    } else if (!penPhase && this.cam.mode === 'penalty') {
      this.cam.setMode('broadcast');
    }

    // confetti physics (hidden while a replay rewinds time — celebration
    // confetti raining through the pre-goal build-up is anachronistic)
    if (this.confetti) this.confetti.visible = !replaying;
    if (this.confetti && this.confettiVel) {
      this.confettiT += dtReal;
      const posAttr = this.confetti.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += (this.confettiVel[i] + Math.sin(this.confettiT * 3 + i) * 0.6) * dtReal;
        arr[i + 1] += this.confettiVel[i + 1] * dtReal;
        arr[i + 2] += this.confettiVel[i + 2] * dtReal;
        if (arr[i + 1] < 0.1) arr[i + 1] = 0.1;
      }
      posAttr.needsUpdate = true;
      (this.confetti.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - this.confettiT / 6);
      if (this.confettiT > 6) this.removeConfetti();
    }

    this.stadium.update(dtReal);
    this.cam.update(dtReal, ballX, ballY, ballZ);
    this.sceneMgr.render();
  }

  /** Release all GPU resources — call when the match ends. */
  dispose(): void {
    this.removeConfetti();
    this.clearTrail();
    this.sceneMgr.dispose();
  }

  /** Project a sim position to screen % for HTML nameplates. */
  screenPos(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, z, y).project(this.sceneMgr.camera);
    return {
      x: (v.x * 0.5 + 0.5) * 100,
      y: (-v.y * 0.5 + 0.5) * 100,
      visible: v.z < 1,
    };
  }
}
