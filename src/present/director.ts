// The presentation director (§7).
//
// One object per match. It watches the sim's phase, decides which scripted
// scene that phase deserves, and owns the single hook the renderer exposes
// (GameRenderer.cutscene). Everything else in the game keeps working exactly
// as it did: this layer never writes sim state, and the only thing it asks of
// the loop is that the tick be HELD while the pre-match walkout is playing —
// because that is the one scene the sim would otherwise talk over, kicking off
// four seconds into it.
//
// Where the camera comes from, per scene:
//
//   walkout    the scene's own keyframe track (setMode('external')). The phase
//              machine wants 'setpiece' for a kickoff; it asks once, we hold
//              'external' after that, and it hands over again at the next beat.
//   goal       NOT OURS. The camera director's goal package already runs a
//              slow-mo → celebration → crowd → replay shot list. We only keep
//              cam.subject pinned to the scorer's live position so its
//              celebration rig has something to track.
//   half/full  NOT OURS either: the director cuts to its stadium beauty crane
//              for both cards. The players still perform underneath it.

import type { GameRenderer } from '../render/gameRenderer';
import type { Match, MatchPhase } from '../sim/match';
import type { ActorMesh, Cutscene } from './cutscene';
import { buildCelebration, buildWalkoff, buildWalkout } from './scenes';

export interface PresentationOpts {
  /** the pre-match walkout — the only scene that holds the sim */
  walkout?: boolean;
  /** the goal celebration under 'goalseq' */
  celebration?: boolean;
  /** the half-time and full-time walk-offs */
  walkoff?: boolean;
  /** optional audio cue (audio.stinger); called guarded, never awaited */
  stinger?: (name: string) => void;
}

/** Everything on by default; the capture harness turns the lot off. */
const ALL: Required<Omit<PresentationOpts, 'stinger'>> = {
  walkout: true, celebration: true, walkoff: true,
};

export class Presentation {
  private scene: Cutscene | null = null;
  /** the phase the running scene was built for; it ends when we leave it */
  private scenePhase: MatchPhase | null = null;
  private lastPhase: MatchPhase | null = null;
  private walkoutDone = false;
  private opts: PresentationOpts;

  constructor(private renderer: GameRenderer, private match: Match,
    opts: PresentationOpts = {}) {
    this.opts = { ...ALL, ...opts };
    renderer.cutscene = this.tick;
  }

  /** The scene playing right now, by name, or null. For the HUD and tests. */
  get playing(): string | null { return this.scene?.name ?? null; }

  /** True while the sim must not tick: only the pre-match walkout. */
  get holdsSim(): boolean { return this.scene !== null && this.scene.name === 'walkout'; }

  /**
   * Poll once a frame, BEFORE the sim would step. Starts and stops scenes on
   * phase changes and returns whether the caller must hold the tick.
   */
  frame(): boolean {
    const phase = this.match.phase;
    if (phase !== this.lastPhase) {
      this.onPhase(phase);
      this.lastPhase = phase;
    }
    // a scene outlives only the phase it was built for (the walkout is built
    // before its own phase can change, so it ends on its own clock instead)
    if (this.scene && this.scenePhase && phase !== this.scenePhase) this.end();
    return this.holdsSim;
  }

  /** Cut the current scene short — any button, from main.ts. */
  skip(): void {
    if (!this.scene) return;
    if (this.scene.name === 'walkout') this.walkoutDone = true;
    this.end();
  }

  /**
   * Start a scene by hand. The headless shot runner uses this to photograph a
   * walk-off without playing forty-five minutes of football first; nothing in
   * the game calls it.
   */
  force(kind: 'walkout' | 'goal' | 'break' | 'fulltime'): boolean {
    this.end();
    const built = kind === 'walkout' ? buildWalkout(this.match)
      : kind === 'goal' ? buildCelebration(this.match)
        : buildWalkoff(this.match, kind === 'fulltime' ? 'fulltime' : 'break');
    if (!built) return false;
    this.scene = built;
    // forced scenes are not tied to a phase: they run until they finish
    this.scenePhase = null;
    return true;
  }

  dispose(): void {
    this.end();
    if (this.renderer.cutscene === this.tick) this.renderer.cutscene = null;
  }

  // ------------------------------------------------------------- internals

  private get meshes(): ActorMesh[] {
    return this.renderer.playerMeshes as unknown as ActorMesh[];
  }

  private onPhase(phase: MatchPhase): void {
    // The walkout is the one scene with a precondition beyond the phase: it is
    // the FIRST kickoff of the match and nothing else. Every later kickoff —
    // second half, after a goal — is a restart, and a restart that made you
    // watch the teams walk out again would be unbearable.
    if (phase === 'kickoff' && this.opts.walkout && !this.walkoutDone
      && this.match.half === 1 && this.match.simTime < 0.5) {
      this.walkoutDone = true;
      this.start(buildWalkout(this.match), null);
      this.opts.stinger?.('walkout');
      return;
    }
    if (phase === 'goalseq' && this.opts.celebration) {
      this.start(buildCelebration(this.match), 'goalseq');
      return;
    }
    if ((phase === 'break' || phase === 'fulltime') && this.opts.walkoff) {
      this.start(buildWalkoff(this.match, phase === 'fulltime' ? 'fulltime' : 'break'), phase);
      this.opts.stinger?.(phase === 'fulltime' ? 'fulltime' : 'halftime');
    }
  }

  private start(scene: Cutscene | null, phase: MatchPhase | null): void {
    this.end();
    if (!scene) return;
    this.scene = scene;
    this.scenePhase = phase;
  }

  private end(): void {
    if (!this.scene) return;
    // the overlay clip keeps fading UNDER whatever drives the mesh next, which
    // is what makes handing back a blend and not a snap
    this.scene.release(this.meshes, 0.35);
    // Give the lens back explicitly if we took it. The director only re-asks
    // for a mode when its OWN intent changes, so a scene that simply stopped
    // driving `external` would leave the camera frozen on its last keyframe
    // until the phase happened to move. A long soft blend into the broadcast
    // rig is the right arrival either way — the walkout ends on that pose.
    if (this.scene.cam.length && this.renderer.cam.mode === 'external') {
      this.renderer.cam.setMode('broadcast', { blendIn: 1.2 });
    }
    this.scene = null;
    this.scenePhase = null;
  }

  /**
   * The renderer's hook. Arrow-bound so it can be handed over as a value and
   * compared by identity on dispose.
   *
   * A replay outranks a cutscene without argument: those frames ARE the
   * meshes, recorded, and a celebration advancing over the top of rewound
   * footage is the same anachronism the confetti already guards against. The
   * scene neither ticks nor writes while one is running, and picks up where it
   * left off afterwards.
   */
  private tick = (dt: number, replaying: boolean): boolean => {
    const s = this.scene;
    if (!s || replaying) return false;
    s.update(dt);
    s.applyTo(this.meshes, this.renderer.cam, dt);
    // the finishing frame's pose still stands; the release happens after it
    if (s.finished) this.end();
    return true;
  };
}

/**
 * `?walkout=0` turns the pre-match scene off (and `=1` forces it on in the
 * capture harness, where it is off by default — a shot that steps two thousand
 * sim ticks must not spend the first twenty-eight seconds of them watching a
 * line-up it did not ask for).
 */
export function walkoutWanted(fallback = true): boolean {
  const v = new URLSearchParams(location.search).get('walkout');
  if (v === '0' || v === 'off' || v === 'false') return false;
  if (v === '1' || v === 'on' || v === 'true') return true;
  return fallback;
}
