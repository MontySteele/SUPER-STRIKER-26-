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
import { CameraDirector } from './camera';
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

export class GameRenderer {
  sceneMgr: SceneManager;
  stadium: Stadium;
  cam: CameraDirector;
  playerMeshes: PlayerMesh[] = [];
  ballMesh: BallMesh;
  switchArrows: [THREE.Mesh, THREE.Mesh];

  // interpolation snapshots
  private prevSnaps: Snap[] = [];
  private currSnaps: Snap[] = [];
  private prevBall: [number, number, number] = [0, 0, 0];
  private currBall: [number, number, number] = [0, 0, 0];

  // replay
  private replayBuf: ReplayFrame[] = [];
  private replayAccum = 0;
  private goalSeqT = -1; // >= 0 while running the goal presentation
  private replayFrames: ReplayFrame[] = [];
  private replayIdx = 0;
  onReplayStateChange: ((on: boolean) => void) | null = null;

  private confetti: THREE.Points | null = null;
  private confettiVel: Float32Array | null = null;
  private confettiT = 0;

  constructor(canvas: HTMLCanvasElement, private match: Match, timeOfDay: TimeOfDay,
    stadiumSize: StadiumSize = 'national') {
    this.sceneMgr = new SceneManager(canvas, timeOfDay);
    buildPitch(this.sceneMgr.scene);
    this.stadium = new Stadium(this.sceneMgr.scene, timeOfDay === 'night', stadiumSize);
    this.cam = new CameraDirector(this.sceneMgr.camera);
    this.ballMesh = new BallMesh(this.sceneMgr.scene);

    const [homeKit, awayKit, gkA, gkB] = resolveKits(match.teams[0].data.kit, match.teams[1].data.kit);
    match.teams[0].players.forEach((p) => {
      this.playerMeshes.push(new PlayerMesh(p.data, p.isGK ? gkA : homeKit));
    });
    match.teams[1].players.forEach((p) => {
      this.playerMeshes.push(new PlayerMesh(p.data, p.isGK ? gkB : awayKit));
    });
    for (const pm of this.playerMeshes) this.sceneMgr.scene.add(pm.root);

    // chunky switch indicators (§5): P1 gold, P2 silver
    const mkArrow = (color: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(0.28, 0.5, 4),
        new THREE.MeshBasicMaterial({ color }),
      );
      m.rotation.x = Math.PI;
      this.sceneMgr.scene.add(m);
      return m;
    };
    this.switchArrows = [mkArrow(0xffce4a), mkArrow(0xdde4f0)];

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
    if (e.type === 'goal') {
      this.goalSeqT = 0;
      // celebration subject: the scorer's mesh
      const scorer = this.match.allPlayers.find(
        (p) => p.data.name === e.scorerName && p.teamIdx === e.teamIdx,
      );
      if (scorer) this.cam.subject.set(scorer.pos.x, 0, scorer.pos.y);
      this.cam.replayGoalSide = Math.sign(this.match.ball.pos.x) || 1;
      this.cam.setMode('celebration');
      // freeze the replay clip now
      this.replayFrames = this.replayBuf.slice(Math.max(0, this.replayBuf.length - 4 * REPLAY_FPS));
      this.replayIdx = 0;
      this.spawnConfetti(e.teamIdx);
    }
  }

  private spawnConfetti(teamIdx: number): void {
    if (this.confetti) this.sceneMgr.scene.remove(this.confetti);
    const N = 380;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const kit = new THREE.Color(this.match.teams[teamIdx].data.kit.home);
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
      // 0–2.2s celebration orbit → 2.2s+ replay
      if (this.goalSeqT > 2.2 && this.cam.mode !== 'replay' && this.replayFrames.length) {
        this.cam.setMode('replay');
        this.onReplayStateChange?.(true);
      }
    } else if (this.goalSeqT >= 0 && !inGoalSeq) {
      // sequence over — back to broadcast (UI wipe covers the cut)
      this.goalSeqT = -1;
      this.cam.setMode('broadcast');
      this.onReplayStateChange?.(false);
    }

    const replaying = this.cam.mode === 'replay' && this.replayFrames.length > 0;
    let ballX: number, ballY: number, ballZ: number;

    if (replaying) {
      // play the frozen clip at 0.55x
      this.replayIdx = Math.min(
        this.replayIdx + dtReal * REPLAY_FPS * 0.55,
        this.replayFrames.length - 1,
      );
      const f = this.replayFrames[Math.floor(this.replayIdx)];
      [ballX, ballY, ballZ] = f.ball;
      this.ballMesh.update(ballX, ballY, ballZ);
      f.players.forEach((s, i) => {
        const [anim, animT] = f.anims[i];
        this.playerMeshes[i].update(dtReal, s.x, s.y, 0, s.facing, s.speed, anim, animT);
      });
      if (this.replayIdx >= this.replayFrames.length - 1) {
        // hold last frame; celebration cam returns
        this.cam.setMode('celebration');
        this.onReplayStateChange?.(false);
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
    }

    // switch indicators hover over each seat's controlled player
    for (let i = 0; i < 2; i++) {
      const ctrl = this.match.controlled[i];
      const arrow = this.switchArrows[i];
      if (ctrl && this.match.seats[i] && !replaying && !ctrl.sentOff) {
        arrow.visible = true;
        const bob = Math.sin(performance.now() * 0.006 + i * 2) * 0.08;
        arrow.position.set(ctrl.pos.x, 2.35 + bob, ctrl.pos.y);
        arrow.rotation.y += dtReal * 2;
      } else {
        arrow.visible = false;
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

    // confetti physics
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
      if (this.confettiT > 6) {
        this.sceneMgr.scene.remove(this.confetti);
        this.confetti = null;
      }
    }

    this.stadium.update(dtReal);
    this.cam.update(dtReal, ballX, ballY, ballZ);
    this.sceneMgr.render();
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
