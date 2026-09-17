// The commentary DIRECTOR: match events in, cues out. Pure logic — no Web
// Audio, no DOM, no manifest — so the dry-run harness
// (pipeline/audio/dryrun.ts) can run a whole seeded match in node and print
// exactly what would be said and when, which is the only way to check pacing
// without ears.
//
// What the words ARE lives in pipeline/audio/lines.py and arrives at runtime
// inside public/audio/commentary.json. This file only knows GROUP NAMES.

import { RNG } from '../core/rng';
import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';

/** 3 = goals/verdicts, 2 = drama, 1 = chances, 0 = colour/restarts. */
export type Priority = 0 | 1 | 2 | 3;

export type Slot =
  | { kind: 'player'; name: string; teamIdx: number }
  | { kind: 'team'; teamIdx: number }
  | { kind: 'num'; value: number };

export interface Cue {
  /** group name in the manifest, e.g. "goal.equaliser" */
  group: string;
  priority: Priority;
  /** seconds to wait before speaking — a real commentator draws breath */
  delay: number;
  slots: Record<string, Slot>;
  /** queued to start this many seconds after the primary cue finishes */
  then?: Cue;
  /** set by the queue on a follow-up: deliberate, so it skips the chatter ration */
  isFollow?: boolean;
}

const ANALYST_GAP = 0.35;

/**
 * Turns the event stream into cues. Owns the narrative state a commentator
 * carries in his head: how many goals have gone in, who is ahead, how long
 * since anybody said anything worth saying.
 */
export class CommentaryDirector {
  private rng: RNG;
  private goals = 0;
  /** seconds of match time since the last cue of ANY priority */
  private sinceCue = 0;
  private sinceBuildup = 0;
  private sinceColour = 0;
  private excitement = 0;
  private inPlay = false;

  constructor(seed = (Math.random() * 0xffffffff) >>> 0) {
    this.rng = new RNG(seed);
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.rng = new RNG(seed);
    this.goals = 0;
    this.sinceCue = 0;
    this.sinceBuildup = 0;
    this.sinceColour = 0;
    this.excitement = 0;
    this.inPlay = false;
  }

  /** Called whenever a cue is actually accepted for speaking. */
  noteSpoken(pri: Priority): void {
    this.sinceCue = 0;
    if (pri <= 0) this.sinceColour = 0;
  }

  /**
   * Per-frame. Returns an unprompted colour line when the match has gone quiet
   * — the summariser filling a lull, which is what sells a broadcast.
   */
  tick(dt: number): Cue | null {
    if (dt <= 0) return null;
    this.sinceCue += dt;
    this.sinceBuildup += dt;
    this.sinceColour += dt;
    if (!this.inPlay) return null;
    // only in a genuine lull: nothing said for a while and nothing brewing
    if (this.sinceCue < 14 || this.sinceColour < 26 || this.excitement > 0.45) return null;
    if (this.rng.next() > 0.6) { this.sinceColour = 12; return null; }
    this.sinceColour = 0;
    return { group: 'colour.general', priority: 0, delay: 0, slots: {} };
  }

  onEvent(e: MatchEvent, m: Match): Cue | null {
    const player = (name: string, teamIdx: number): Slot =>
      ({ kind: 'player', name: surname(name), teamIdx });
    const team = (teamIdx: number): Slot => ({ kind: 'team', teamIdx });

    switch (e.type) {
      case 'kickoff': {
        this.inPlay = true;
        // post-goal restarts re-emit kickoff — don't re-announce the match
        if (m.clock >= 1) return null;
        if (e.half === 1) {
          return m.mode === 'golden'
            ? { group: 'kickoff.golden', priority: 2, delay: 0.3, slots: {} }
            : {
              group: 'kickoff.match', priority: 2, delay: 0.25,
              slots: { home: team(0), away: team(1) },
            };
        }
        // priority 2, not 1: a restart announcement must not be rationed away
        // behind the half-time scoreline that precedes it
        if (e.half === 2) return { group: 'kickoff.second', priority: 2, delay: 0.8, slots: {} };
        return { group: 'kickoff.extra', priority: 2, delay: 0.4, slots: {} };
      }

      case 'goal': {
        this.goals++;
        this.excitement = 1;
        const idx = e.scorerTeamIdx ?? e.teamIdx;
        const scorer = player(e.scorerName, idx);
        const group = this.goalGroup(e, m);
        const cue: Cue = {
          group, priority: 3,
          // let the crowd get its roar in first; the call lands on top of it
          delay: 0.45 + this.rng.range(0, 0.25),
          slots: group === 'goal.team'
            ? { scorer, team: team(e.teamIdx) }
            : { scorer },
        };
        if (this.rng.next() < 0.45) {
          cue.then = {
            group: 'colour.after_goal', priority: 1, delay: 1.1, slots: {},
          };
        }
        return cue;
      }

      case 'save':
        if (!e.shotStop || this.rng.next() > 0.55) return null;
        this.excitement = 0.7;
        return {
          group: 'save.big', priority: 1, delay: 0.2 + this.rng.range(0, 0.2),
          slots: { keeper: player(e.keeperName, e.teamIdx) },
        };

      case 'post':
        this.excitement = 0.8;
        return { group: 'post.hit', priority: 1, delay: 0.12, slots: {} };

      case 'shot':
        if (!e.onTarget || this.rng.next() > 0.12) return null;
        return { group: 'shot.effort', priority: 1, delay: 0.25, slots: {} };

      case 'miss': {
        if (this.rng.next() > 0.4) return null;
        this.excitement = 0.5;
        const cue: Cue = {
          group: 'miss.wide', priority: 1, delay: 0.45 + this.rng.range(0, 0.3),
          slots: { shooter: player(e.shooterName, e.teamIdx) },
        };
        if (this.rng.next() < 0.3) {
          cue.then = { group: 'colour.after_miss', priority: 0, delay: ANALYST_GAP, slots: {} };
        }
        return cue;
      }

      case 'corner':
        if (this.rng.next() > 0.32) return null;
        return {
          group: 'corner.won', priority: 0, delay: 0.5,
          slots: { team: team(e.teamIdx) },
        };

      case 'offside':
        if (this.rng.next() > 0.5) return null;
        return {
          group: 'offside.flag', priority: 1, delay: 0.5,
          slots: { player: player(e.playerName, e.teamIdx) },
        };

      case 'foul':
        if (this.rng.next() > 0.28) return null;
        return {
          group: 'foul.given', priority: 0, delay: 0.55,
          slots: { player: player(e.playerName, e.teamIdx) },
        };

      case 'card': {
        const red = e.color === 'red';
        const cue: Cue = {
          group: red ? 'card.red' : 'card.yellow',
          priority: red ? 2 : 1,
          delay: red ? 0.45 : 0.65,
          slots: { player: player(e.playerName, e.teamIdx) },
        };
        if (this.rng.next() < (red ? 0.7 : 0.3)) {
          cue.then = { group: 'colour.after_card', priority: 1, delay: ANALYST_GAP, slots: {} };
        }
        return cue;
      }

      case 'penaltyAwarded':
        this.excitement = 1;
        return {
          group: 'pen.awarded', priority: 2, delay: 0.5,
          slots: { team: team(e.teamIdx) },
        };

      case 'penTension':
        if (this.rng.next() > 0.4) return null;
        return { group: 'pen.tension', priority: 1, delay: 0.9, slots: {} };

      case 'penKick': {
        const group = e.result === 'goal' ? 'pen.scored'
          : e.result === 'saved' ? 'pen.saved' : 'pen.missed';
        return {
          group, priority: 2, delay: 0.35,
          slots: { taker: player(e.takerName, e.teamIdx) },
        };
      }

      case 'shootoutEnd':
        return {
          group: 'shootout.win', priority: 3, delay: 0.7,
          slots: { team: team(e.winnerIdx) },
        };

      case 'break': {
        this.inPlay = false;
        this.excitement = 0;
        const group = e.label === 'HALF-TIME' ? 'break.halftime'
          : e.label === 'PENALTIES' ? 'break.penalties' : 'break.extratime';
        const cue: Cue = { group, priority: 2, delay: 0.5, slots: {} };
        if (group === 'break.halftime') cue.then = this.scoreReport(m, 0.5);
        return cue;
      }

      case 'fulltime': {
        this.inPlay = false;
        this.excitement = 0;
        const [h, a] = m.teams;
        const draw = h.score === a.score;
        const cue: Cue = {
          group: draw ? 'fulltime.draw' : 'fulltime.win',
          priority: 3, delay: 0.6,
          slots: draw ? {} : { team: team(h.score > a.score ? 0 : 1) },
        };
        cue.then = this.scoreReport(m, 0.7);
        return cue;
      }

      case 'attackBuildup': {
        this.excitement = e.level;
        if (e.level >= 0.82 && this.sinceBuildup > 18 && this.sinceCue > 5) {
          this.sinceBuildup = 0;
          return { group: 'buildup.danger', priority: 1, delay: 0.1, slots: {} };
        }
        if (e.level >= 0.45 && e.level < 0.82 && this.sinceBuildup > 30 && this.sinceCue > 9
            && this.rng.next() < 0.35) {
          this.sinceBuildup = 0;
          // "team pushing forward" — the side actually in possession
          return {
            group: 'buildup.attack', priority: 0, delay: 0.2,
            slots: { team: team(m.possessionTeam) },
          };
        }
        return null;
      }

      default:
        return null;
    }
  }

  /** Which flavour of goal call this is, given what has happened so far. */
  private goalGroup(
    e: Extract<MatchEvent, { type: 'goal' }>, m: Match,
  ): string {
    if (e.ownGoal) return 'goal.own';
    const [h, a] = m.teams;
    // scores are already incremented by the time the event lands
    const forIdx = e.teamIdx;
    const mine = m.teams[forIdx].score;
    const theirs = m.teams[1 - forIdx].score;
    if (this.goals === 1) return 'goal.opener';
    if (h.score === a.score) return 'goal.equaliser';
    if (mine === theirs + 1 && theirs > 0) return 'goal.lead';
    if (e.minute >= 85) return 'goal.late';
    return this.rng.next() < 0.3 ? 'goal.team' : 'goal.generic';
  }

  private scoreReport(m: Match, delay: number): Cue {
    return {
      group: 'score.report', priority: 1, delay, slots: {
        home: { kind: 'team', teamIdx: 0 },
        away: { kind: 'team', teamIdx: 1 },
        num_home: { kind: 'num', value: m.teams[0].score },
        num_away: { kind: 'num', value: m.teams[1].score },
      },
    };
  }
}

export function surname(full: string): string {
  return full.split(' ').pop() ?? full;
}

// --------------------------------------------------------------------------
// The queue. Deliberately free of Web Audio so the dry-run harness exercises
// the SAME pacing rules the game does; the only thing it needs from the
// outside is how long a line takes to say.
// --------------------------------------------------------------------------

/** How long a cue stays worth saying once its delay has elapsed. */
const LIFETIME: Record<Priority, number> = { 0: 2.0, 1: 3.5, 2: 12, 3: 30 };
/** Minimum quiet between low-priority lines, so he isn't a chatterbox. */
const RATION: Record<Priority, number> = { 0: 9, 1: 3.5, 2: 0, 3: 0 };
const MAX_QUEUE = 3;

interface Waiting { cue: Cue; at: number; expires: number }

export class CommentaryQueue {
  private q: Waiting[] = [];
  private cur: { pri: Priority; endsAt: number; then?: Cue } | null = null;
  private lastLowAt = -1e9;

  clear(): void {
    this.q.length = 0;
    this.cur = null;
  }

  get speaking(): boolean {
    return this.cur !== null;
  }

  /** Offer a cue. Dropped silently when it would be noise. */
  push(cue: Cue, now: number): boolean {
    const pri = cue.priority;
    // a goal or a verdict clears the desk: nothing queued behind it matters
    if (pri >= 3) this.q.length = 0;
    else if (this.q.some((w) => w.cue.priority > pri)) return false;
    // a follow-up is the colour man answering a specific moment; it is never
    // idle chatter, so the ration does not apply to it
    if (!cue.isFollow && pri <= 1 && now - this.lastLowAt < RATION[pri]) return false;
    // don't queue a small line behind a big one that is still being said
    if (this.cur && pri <= 1 && this.cur.pri >= 2) return false;
    if (this.q.length >= MAX_QUEUE) this.q.shift();
    this.q.push({ cue, at: now + cue.delay, expires: now + cue.delay + LIFETIME[pri] });
    return true;
  }

  /**
   * The next thing to say, or null. `interrupt` means the line currently in
   * the air should be cut off — only ever for a goal, a verdict, or a piece of
   * real drama landing on top of idle chatter.
   */
  take(now: number): { cue: Cue; interrupt: boolean } | null {
    // NB: settle() must run first each tick — it is what retires a finished
    // line (and hands back its follow-up). take() never clears `cur` itself.
    if (this.q.length) {
      this.q = this.q.filter((w) => w.expires > now);
    }
    let best = -1;
    for (let i = 0; i < this.q.length; i++) {
      if (this.q[i].at > now) continue;
      if (best < 0 || this.q[i].cue.priority > this.q[best].cue.priority) best = i;
    }
    if (best < 0) return null;
    const pri = this.q[best].cue.priority;
    let interrupt = false;
    if (this.cur) {
      const canCut = pri >= 3 || (pri === 2 && this.cur.pri <= 1);
      if (!canCut) return null;
      interrupt = true;
    }
    const [w] = this.q.splice(best, 1);
    return { cue: w.cue, interrupt };
  }

  /** Register that the line is now in the air and will take `duration`. */
  began(cue: Cue, duration: number, now: number): void {
    this.cur = { pri: cue.priority, endsAt: now + duration, then: cue.then };
    if (cue.priority <= 1) this.lastLowAt = now;
  }

  /** Nothing could be said for this cue (missing clip) — release the slot. */
  abandoned(): void {
    this.cur = null;
  }

  /**
   * Call every tick: when the line in the air has finished, hands back its
   * follow-up (the colour man's reaction) for the caller to push.
   */
  settle(now: number): Cue | null {
    if (!this.cur || now < this.cur.endsAt) return null;
    const follow = this.cur.then;
    this.cur = null;
    return follow ? { ...follow, isFollow: true } : null;
  }
}
