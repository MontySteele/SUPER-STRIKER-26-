// The cutscene engine (§7 presentation).
//
// A cutscene is a TIMELINE OF COMMANDS over actors that already exist: the
// twenty-two player meshes the renderer is holding. Nothing here touches the
// sim — while a scene plays, main.ts holds the tick (or the phase the scene
// covers is one the sim already spends standing still), the scene drives the
// meshes in render space, and when it ends the meshes are handed back to
// whatever the sim says. The sim's state is therefore never a lie: pause a
// walkout and the match is still sitting at kickoff exactly as it was.
//
// Three things make it look like television rather than like puppetry:
//
//   • MOVEMENT GOES THROUGH THE BLEND CHAIN. An actor walking to a mark is not
//     lerped there; it accelerates, decelerates into the mark and reports the
//     real metres per second it covered, which the locomotion chain turns into
//     playback rate. That is what stops the feet skating (see skinnedPlayer).
//
//   • TURNS ARE DAMPED AND RATE-LIMITED, so nobody pivots on the spot.
//
//   • CLIPS CROSSFADE, over a fade the command names, and every actor gets a
//     phase offset — eleven men on the same idle at the same phase is the one
//     thing that reads instantly as a copy-paste crowd.
//
// The camera is a separate keyframe track on the same clock. A scene that
// wants the camera says so; a scene that does not (the goal celebration, which
// belongs to the camera director's celebration orbit) simply ships no keys.

import * as THREE from 'three';
import type { ClipId } from '../render/characterAssets';
import type { ActorPose } from '../render/skinnedPlayer';
import type { CameraDirector } from '../render/camera';
import { angleDiff, clamp } from '../core/math';

/** What a cutscene needs from a player mesh. Both pipelines satisfy the
 *  update() half; only the skinned one implements the actor half, and the
 *  driver falls back to update() for the capsules. */
export interface ActorMesh {
  update(dt: number, x: number, y: number, z: number, facing: number, speed: number,
    anim: 'none', animT: number): void;
  cutscene?(dt: number, x: number, y: number, facing: number, speed: number,
    pose: ActorPose): void;
  releaseCutscene?(fade?: number): void;
  setKeeperState?(state: string | null, lateral: number): void;
}

// ------------------------------------------------------------------ commands

/** Hold still (or hold the clip that is already playing) for `dur` seconds. */
interface CmdWait { t: 'wait'; dur: number }
/**
 * Hold until an ABSOLUTE moment on the scene clock. The camera track is keyed
 * on that clock, so choreography that has to meet the camera — a line breaking
 * as the dolly reaches the end of it — has to be able to name the same
 * moments. An actor already past `time` passes straight through.
 */
interface CmdUntil { t: 'until'; time: number }
/**
 * Walk/jog/run to a mark. `speed` is the TOP speed; the actor ramps into it
 * and brakes into the mark, and the chain sees the truth either way.
 * `face` pins the heading (radians); omitted, the actor faces where it is going.
 */
interface CmdMove {
  t: 'move'; x: number; y: number; speed: number;
  face?: number; stop?: number; accel?: number;
}
/** Turn on the spot to a heading, at the actor's turn rate. */
interface CmdFace { t: 'face'; facing: number }
/** Lay a clip over the body (or clear it with id null). Instant unless `hold`. */
interface CmdClip {
  t: 'clip'; id: string | null; fade?: number; loop?: boolean;
  rate?: number; phase?: number; weight?: number; hold?: number;
}
/** Swap the locomotion chain this actor moves on. */
interface CmdChain { t: 'chain'; ids: ClipId[] | null }

export type Cmd = CmdWait | CmdUntil | CmdMove | CmdFace | CmdClip | CmdChain;

// --------------------------------------------------------------------- actor

/** Metres per second², how hard an actor gets going and how hard it brakes. */
const ACCEL = 6.5;
const DECEL = 8.0;
/** Radians per second an actor may turn, and the softening on top. */
const TURN_RATE = 3.6;
const TURN_HALFLIFE = 0.14;

/**
 * One player under script. Holds its own position and heading in SIM
 * coordinates (x along the length, y across the width) — the same frame the
 * renderer's PlayerView.update takes, so handing back is a matter of stopping.
 */
export class Actor {
  x: number;
  y: number;
  facing: number;
  /** ground speed this frame, metres per second — the chain's rate input */
  speed = 0;
  /** what the overlay layer should look like right now */
  pose: ActorPose = {};
  /** queued commands, consumed front to back */
  private queue: Cmd[] = [];
  private cur: Cmd | null = null;
  private tIn = 0;
  /** carried across frames so acceleration is continuous between commands */
  private v = 0;

  constructor(readonly index: number, x: number, y: number, facing: number) {
    this.x = x;
    this.y = y;
    this.facing = facing;
  }

  /** True once the queue has run dry. */
  get idle(): boolean { return this.cur === null && this.queue.length === 0; }

  // --- the script-facing verbs. Every one returns `this` so a scene reads as
  // one sentence per actor.

  push(...cmds: Cmd[]): this { this.queue.push(...cmds); return this; }
  wait(dur: number): this { return this.push({ t: 'wait', dur }); }
  until(time: number): this { return this.push({ t: 'until', time }); }
  moveTo(x: number, y: number, speed: number, opts: Omit<CmdMove, 't' | 'x' | 'y' | 'speed'> = {}): this {
    return this.push({ t: 'move', x, y, speed, ...opts });
  }
  faceTo(facing: number): this { return this.push({ t: 'face', facing }); }
  play(id: string | null, opts: Omit<CmdClip, 't' | 'id'> = {}): this {
    return this.push({ t: 'clip', id, ...opts });
  }
  chain(ids: ClipId[] | null): this { return this.push({ t: 'chain', ids }); }

  /** Advance one frame. Commands that finish mid-frame hand the remaining dt
   *  to the next one, so a stagger of 0.28s does not quantise to the frame. */
  step(dt: number, now: number): void {
    let left = dt;
    // Instant commands (a clip swap, a chain swap) must not each cost a frame:
    // the loop keeps pulling until one of them takes the rest of the time.
    // `guard` is the only thing standing between a scripting mistake and a
    // spin, so it is small and deliberate.
    for (let guard = 0; guard < 24; guard++) {
      if (!this.cur) {
        this.cur = this.queue.shift() ?? null;
        this.tIn = 0;
        if (!this.cur) break;
      }
      const running = this.cur;
      left -= this.run(running, left, now + (dt - left));
      if (this.cur === running) break;   // still going: it owns the rest of dt
      if (left <= 1e-6) break;
    }
    // nothing running and nothing queued: stand, and let the speed decay so
    // the chain eases down to the idle instead of dropping to it
    if (!this.cur && this.queue.length === 0) {
      this.v = Math.max(0, this.v - DECEL * dt);
      this.speed = this.v;
    }
  }

  /** Run one command for up to `dt`. Returns the seconds it consumed; a value
   *  short of `dt` means it finished and the rest belongs to the next one. */
  private run(cmd: Cmd, dt: number, now: number): number {
    switch (cmd.t) {
      case 'clip':
        this.pose = {
          ...this.pose,
          clip: cmd.id,
          fade: cmd.fade ?? 0.3,
          loop: cmd.loop ?? true,
          rate: cmd.rate ?? 1,
          phase: cmd.phase ?? 0,
          weight: cmd.weight ?? 1,
        };
        if (cmd.hold === undefined) { this.done(); return 0; }
        return this.hold(cmd.hold, dt);

      case 'chain':
        this.pose = { ...this.pose, chain: cmd.ids };
        this.done();
        return 0;

      case 'wait': {
        // decelerate to a stop rather than freezing mid-stride
        this.v = Math.max(0, this.v - DECEL * dt);
        this.speed = this.v;
        return this.hold(cmd.dur, dt);
      }

      case 'until': {
        this.v = Math.max(0, this.v - DECEL * dt);
        this.speed = this.v;
        const rest = cmd.time - now;
        if (dt >= rest) { this.done(); return Math.max(rest, 0); }
        return dt;
      }

      case 'face': {
        this.v = Math.max(0, this.v - DECEL * dt);
        this.speed = this.v;
        this.turn(cmd.facing, dt);
        if (Math.abs(angleDiff(this.facing, cmd.facing)) < 0.04) { this.done(); return 0; }
        return dt;
      }

      case 'move': {
        const stop = cmd.stop ?? 0.14;
        const dx = cmd.x - this.x;
        const dy = cmd.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= stop) {
          this.v = Math.max(0, this.v - DECEL * dt);
          this.speed = this.v;
          this.done();
          return 0;
        }
        // brake into the mark: the fastest you may be going right now is the
        // speed you can still shed over the distance left
        const brake = Math.sqrt(2 * DECEL * Math.max(dist - stop, 0));
        const want = Math.min(cmd.speed, brake);
        const accel = cmd.accel ?? ACCEL;
        this.v = this.v < want
          ? Math.min(want, this.v + accel * dt)
          : Math.max(want, this.v - DECEL * dt);
        const stepLen = Math.min(this.v * dt, dist);
        this.x += (dx / dist) * stepLen;
        this.y += (dy / dist) * stepLen;
        // THE CHAIN IS TOLD WHAT ACTUALLY HAPPENED, not what was asked for:
        // distance covered ÷ dt. Anything else and the playback rate stops
        // matching the stride and the boots start sliding.
        this.speed = dt > 1e-6 ? stepLen / dt : 0;
        this.turn(cmd.face ?? Math.atan2(dy, dx), dt);
        return dt;
      }
    }
  }

  /** Damped, rate-limited heading change. Damping alone lets a 180° turn spin
   *  a head faster than a neck; the cap is what keeps it human. */
  private turn(target: number, dt: number): void {
    const d = angleDiff(this.facing, target);
    const eased = d * (1 - Math.pow(0.5, dt / TURN_HALFLIFE));
    this.facing += clamp(eased, -TURN_RATE * dt, TURN_RATE * dt);
  }

  private hold(dur: number, dt: number): number {
    const rest = dur - this.tIn;
    if (dt >= rest) { this.done(); return Math.max(rest, 0); }
    this.tIn += dt;
    return dt;
  }

  private done(): void { this.cur = null; this.tIn = 0; }
}

// -------------------------------------------------------------- camera track

export type Ease = 'linear' | 'smooth' | 'in' | 'out';

/** One camera pose at one moment of the scene, in SCENE coords (x length,
 *  y up, z across = sim y). `ease` shapes the approach FROM the previous key. */
export interface CamKey {
  t: number;
  pos: [number, number, number];
  look: [number, number, number];
  fov?: number;
  ease?: Ease;
  /** cut to this key instead of moving to it (the previous key is abandoned) */
  cut?: boolean;
  /** extra smoothing on top of the keyframe curve; 0 (default) follows exactly */
  halfLife?: number;
}

function shape(u: number, ease: Ease): number {
  switch (ease) {
    case 'linear': return u;
    case 'in': return u * u;
    case 'out': return u * (2 - u);
    default: return u * u * (3 - 2 * u);
  }
}

// ------------------------------------------------------------------ cutscene

export interface CutsceneOpts {
  /** end as soon as every actor's queue is empty (a walkout does; a
   *  celebration that has to outlive a 12s phase does not) */
  endsWhenIdle?: boolean;
  /** hard ceiling in seconds; the scene ends whatever it is doing */
  maxDuration?: number;
  /** floor, so a scene with a camera move is never cut off by quick actors */
  minDuration?: number;
}

/**
 * A scene: a set of actors with queues, an optional camera track, and a clock.
 *
 * `update` advances the clock and the actors; `applyTo` writes the result onto
 * the meshes and the camera. They are separate because the renderer may be
 * showing a replay this frame, in which case the scene must neither advance
 * nor write — the replay owns the meshes and rewinding time under a live
 * celebration is exactly the anachronism the confetti code already guards.
 */
export class Cutscene {
  time = 0;
  finished = false;
  /** actors by player index, so a scene can look one up to retarget it */
  readonly byIndex = new Map<number, Actor>();
  /**
   * The actor the camera director should orbit, if any. A scene that ships no
   * camera keys still has a point of view: the goal celebration hands the
   * scorer over as `cam.subject` every frame and lets the director's
   * celebration rig do the shooting.
   */
  subject: Actor | null = null;
  private camPose = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 36, halfLife: 0 };
  private started = false;

  constructor(
    readonly name: string,
    readonly actors: Actor[],
    readonly cam: CamKey[] = [],
    readonly opts: CutsceneOpts = {},
  ) {
    for (const a of actors) this.byIndex.set(a.index, a);
  }

  update(dt: number): void {
    if (this.finished) return;
    // actors step against the clock at the START of the frame, which is the
    // same instant `until` marks and the camera track is keyed on
    for (const a of this.actors) a.step(dt, this.time);
    this.time += dt;
    const { maxDuration, minDuration = 0, endsWhenIdle } = this.opts;
    if (maxDuration !== undefined && this.time >= maxDuration) this.finished = true;
    else if (endsWhenIdle && this.time >= minDuration && this.actors.every((a) => a.idle)) {
      this.finished = true;
    }
  }

  /** Where the camera is right now, or null if this scene does not drive it. */
  camAt(t: number): { pos: [number, number, number]; look: [number, number, number];
    fov?: number; halfLife: number } | null {
    const keys = this.cam;
    if (!keys.length) return null;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    // before the first key, or past the last: hold it
    if (!b || t <= a.t) {
      return { pos: a.pos, look: a.look, fov: a.fov, halfLife: a.halfLife ?? 0 };
    }
    if (b.cut) {
      // a cut holds the outgoing pose right up to the frame it changes
      return { pos: a.pos, look: a.look, fov: a.fov, halfLife: a.halfLife ?? 0 };
    }
    const u = shape(clamp((t - a.t) / Math.max(b.t - a.t, 1e-3), 0, 1), b.ease ?? 'smooth');
    const mix = (p: [number, number, number], q: [number, number, number]):
    [number, number, number] => [
      p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u,
    ];
    const fov = a.fov !== undefined && b.fov !== undefined
      ? a.fov + (b.fov - a.fov) * u : b.fov ?? a.fov;
    return {
      pos: mix(a.pos, b.pos), look: mix(a.look, b.look), fov,
      halfLife: (b.halfLife ?? a.halfLife) ?? 0,
    };
  }

  /**
   * Write this frame onto the meshes and (if the scene owns it) the camera.
   *
   * Actors are driven through SkinnedPlayerMesh.cutscene when the skinned
   * pipeline is live and through the ordinary update() otherwise — the capsule
   * path has no overlay layer, but it does have a locomotion blend, so a
   * capsule walkout still walks.
   */
  applyTo(meshes: ActorMesh[], camera: CameraDirector | null, dt: number): void {
    for (const a of this.actors) {
      const m = meshes[a.index];
      if (!m) continue;
      // a scripted keeper is a man in a line, not a goalkeeper: the renderer
      // feeds keeper state every frame, so it has to be cleared every frame
      m.setKeeperState?.(null, 0);
      if (m.cutscene) m.cutscene(dt, a.x, a.y, a.facing, a.speed, a.pose);
      else m.update(dt, a.x, a.y, 0, a.facing, a.speed, 'none', 0);
    }
    if (!camera) return;
    // the orbit subject follows the actor's LIVE position — a celebration cam
    // aimed where the scorer was when the ball went in is aimed at nobody
    if (this.subject) camera.subject.set(this.subject.x, 0, this.subject.y);
    const c = this.camAt(this.time);
    if (!c) return;
    this.camPose.pos.set(c.pos[0], c.pos[1], c.pos[2]);
    this.camPose.look.set(c.look[0], c.look[1], c.look[2]);
    this.camPose.halfLife = this.started ? c.halfLife : 0;
    if (c.fov !== undefined) this.camPose.fov = c.fov;
    camera.external = this.camPose;
    if (camera.mode !== 'external') camera.setMode('external');
    this.started = true;
  }

  /** Hand every actor back to the sim, fading whatever clip it was holding. */
  release(meshes: ActorMesh[], fade = 0.35): void {
    for (const a of this.actors) meshes[a.index]?.releaseCutscene?.(fade);
  }
}
