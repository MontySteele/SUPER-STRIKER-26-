// Commentary: a real voice calling the match, from PRE-BAKED local TTS.
//
// The old build used the browser's SpeechSynthesis API — zero assets, but the
// voice varied from "passable" to "robot reading a spreadsheet" depending on
// the machine, and there is no way to tune its delivery. Now the lines are
// rendered ahead of time by Kokoro-82M (pipeline/audio/bake_commentary.py),
// packed into Opus sprites, and spliced at runtime around baked clips of every
// team name and player surname in the game.
//
// Division of labour:
//   commentaryScript.ts  what to say and when   (pure logic — also dry-run-able)
//   commentaryBank.ts    the baked audio        (manifest, sprites, splicing)
//   this file            the plumbing           (unlock, ducking, settings)
//
// Everything degrades to silence: no manifest, no audio context, no voice pack
// on disk — the game plays on, just without a commentator. Behind the same
// settings toggle as before (COMMENTARY_KEY).

import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import { CommentaryBank, type Utterance } from './commentaryBank';
import { CommentaryDirector, CommentaryQueue, type Cue } from './commentaryScript';

export const COMMENTARY_KEY = 'ss26.commentary';

export function commentaryEnabled(): boolean {
  try {
    return localStorage.getItem(COMMENTARY_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** What the commentary engine needs from the audio engine (AudioEngine fits). */
export interface CommentaryHost {
  context(): AudioContext | null;
  /** Destination for speech — post-crowd, pre-limiter. */
  voiceBus(): GainNode | null;
  /** Pull the crowd down while he talks, like a real broadcast mix. */
  duckCrowd(on: boolean): void;
}

/** Speech starts this far in the future so the graph has time to be built. */
const SCHEDULE_AHEAD = 0.06;

export class Commentary {
  private enabled = commentaryEnabled();
  private host: CommentaryHost | null;
  private bank = new CommentaryBank();
  private director = new CommentaryDirector();
  private queue = new CommentaryQueue();
  private teamIds: string[] = [];
  private teamNames: string[] = [];
  private cancelCurrent: (() => void) | null = null;
  private clock = 0;              // seconds of "commentary time" (pause-aware)
  private prefetched = '';
  /** Last few lines actually spoken — for the headless pacing harness. */
  readonly log: { t: number; group: string; pri: number; text: string; voice: string }[] = [];

  constructor(host?: CommentaryHost) {
    this.host = host ?? null;
    // the manifest is tiny; grab it early so the first kickoff isn't silent
    void this.bank.load();
  }

  /** Re-read the settings toggle and warm this match's voice clips. */
  refresh(m?: Match): void {
    this.enabled = commentaryEnabled();
    this.stop();
    this.director.reset();
    this.clock = 0;
    this.log.length = 0;
    if (!m) return;
    this.teamIds = [m.teams[0].data.id, m.teams[1].data.id];
    this.teamNames = [m.teams[0].data.name, m.teams[1].data.name];
    this.warm();
  }

  private warm(): void {
    const ctx = this.host?.context();
    if (!ctx || !this.teamIds.length) return;
    const key = this.teamIds.join('|');
    if (this.prefetched === key) return;
    this.prefetched = key;
    void this.bank.prefetch(ctx, this.teamIds);
  }

  stop(): void {
    this.cancelCurrent?.();
    this.cancelCurrent = null;
    this.queue.clear();
    this.host?.duckCrowd(false);
  }

  /** True when a voice pack was found — the HUD can show it if it wants. */
  get hasVoice(): boolean {
    return this.bank.ready;
  }

  onEvent(e: MatchEvent, m: Match): void {
    if (!this.enabled) return;
    if (!this.teamIds.length) {
      this.teamIds = [m.teams[0].data.id, m.teams[1].data.id];
      this.teamNames = [m.teams[0].data.name, m.teams[1].data.name];
      this.warm();
    }
    const cue = this.director.onEvent(e, m);
    if (cue) this.queue.push(cue, this.clock);
    // a goal/verdict should be heard the instant it is due, not up to a frame
    // late — but everything else can wait for the next update()
    if (cue && cue.priority >= 3) this.pump();
  }

  /**
   * Per frame. `dt` should be 0 while the game is frozen (a card on screen) so
   * the commentator's sense of "how long since anyone spoke" matches the
   * player's.
   */
  update(dt: number): void {
    if (!this.enabled) return;
    this.clock += Math.max(0, dt);
    this.warm();
    const idle = this.director.tick(dt);
    if (idle) this.queue.push(idle, this.clock);
    this.pump();
  }

  private pump(): void {
    const wasSpeaking = this.queue.speaking;
    const follow = this.queue.settle(this.clock);
    if (wasSpeaking && !this.queue.speaking) {
      this.cancelCurrent = null;
      this.host?.duckCrowd(false);
    }
    if (follow) this.queue.push(follow, this.clock);
    const next = this.queue.take(this.clock);
    if (!next) return;
    if (!this.speak(next.cue, next.interrupt)) this.queue.abandoned();
  }

  private speak(cue: Cue, interrupt: boolean): boolean {
    const ctx = this.host?.context();
    const bus = this.host?.voiceBus();
    if (!ctx || !bus || !this.bank.ready) return false;
    const u = this.bank.resolve(cue, this.teamIds, Math.random, this.teamNames);
    if (!u) return false;
    if (interrupt) this.cancelCurrent?.();
    const at = ctx.currentTime + SCHEDULE_AHEAD;
    this.host?.duckCrowd(true);
    this.cancelCurrent = this.bank.play(ctx, bus, u, at, () => {
      // the queue's own clock retires the line; this just lifts the duck the
      // moment the audio really stops (interrupts land here too)
      if (!this.queue.speaking) this.host?.duckCrowd(false);
    });
    this.queue.began(cue, u.duration + SCHEDULE_AHEAD, this.clock);
    this.director.noteSpoken(cue.priority);
    this.note(cue, u);
    return true;
  }

  private note(cue: Cue, u: Utterance): void {
    this.log.push({
      t: Math.round(this.clock * 10) / 10,
      group: cue.group, pri: cue.priority, text: u.text, voice: u.voice,
    });
    if (this.log.length > 64) this.log.shift();
  }

  /** Team display names, for anything that wants to pretty-print the log. */
  get names(): string[] {
    return this.teamNames;
  }
}
