// Speech-synthesis commentary: a real voice calling the match, straight from
// the browser's SpeechSynthesis API — zero assets, like everything else here.
// Big moments interrupt small ones; small ones are rationed so the voice
// never talks over itself. Behind a settings toggle (voice quality varies
// wildly by machine).

import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';

export const COMMENTARY_KEY = 'ss26.commentary';

export function commentaryEnabled(): boolean {
  try {
    return localStorage.getItem(COMMENTARY_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Priorities: 3 = goals/verdicts, 2 = drama, 1 = chances, 0 = color. */
type Priority = 0 | 1 | 2 | 3;

const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)];
const last = (name: string): string => name.split(' ').pop() ?? name;

export class Commentary {
  private enabled = commentaryEnabled();
  private supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  private voice: SpeechSynthesisVoice | null = null;
  private currentPriority: Priority = 0;
  private current: SpeechSynthesisUtterance | null = null;
  private lastLowAt = -1e9;

  constructor() {
    if (!this.supported) return;
    // Chrome loads voices asynchronously
    this.pickVoice();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
  }

  /** Re-read the settings toggle (called at every match start). */
  refresh(): void {
    this.enabled = commentaryEnabled();
    if (!this.enabled) this.stop();
  }

  stop(): void {
    if (this.supported) window.speechSynthesis.cancel();
    this.currentPriority = 0;
    this.current = null;
  }

  private pickVoice(): void {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    // a British voice sells the broadcast; otherwise any English, then default
    this.voice = voices.find((v) => v.lang === 'en-GB' && v.localService)
      ?? voices.find((v) => v.lang === 'en-GB')
      ?? voices.find((v) => v.lang.startsWith('en') && v.localService)
      ?? voices.find((v) => v.lang.startsWith('en'))
      ?? voices[0];
  }

  private say(text: string, priority: Priority): void {
    if (!this.enabled || !this.supported) return;
    const synth = window.speechSynthesis;
    const now = performance.now();
    if (synth.speaking || synth.pending) {
      // never step on a bigger call; equal-or-bigger cuts in
      if (priority < this.currentPriority) return;
      synth.cancel();
    } else if (priority <= 1) {
      // ration the chatter
      if (now - this.lastLowAt < 4500) return;
    }
    if (priority <= 1) this.lastLowAt = now;
    this.currentPriority = priority;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.12;
    u.pitch = 1.0;
    u.volume = 1.0;
    // a cancelled utterance's onend fires AFTER the replacement started —
    // only the live utterance may release the priority, or chatter can
    // interrupt a goal call
    this.current = u;
    const release = (): void => {
      if (this.current === u) { this.currentPriority = 0; this.current = null; }
    };
    u.onend = release;
    u.onerror = release;
    synth.speak(u);
  }

  onEvent(e: MatchEvent, m: Match): void {
    if (!this.enabled || !this.supported) return;
    const team = (idx: number): string => m.teams[idx].data.name;
    switch (e.type) {
      case 'kickoff':
        // post-goal restarts re-emit kickoff — don't re-announce the match
        if (m.clock >= 1) break;
        if (e.half === 1) {
          this.say(m.mode === 'golden'
            ? `${team(0)} against ${team(1)} — golden goal, next one wins it, here we go!`
            : pick([
              `${team(0)} against ${team(1)}. Here we go!`,
              `And we're under way — ${team(0)} versus ${team(1)}!`,
            ]), 2);
        } else if (e.half === 2) {
          this.say(pick(['Second half under way.', 'Back out for the second half.']), 1);
        } else if (e.half === 3) {
          this.say('Extra time. The next thirty minutes decide it.', 2);
        }
        break;
      case 'goal': {
        const name = last(e.scorerName);
        this.say(e.ownGoal
          ? pick([
            `Oh no — it's an own goal! ${name} has turned it into his own net!`,
            `Disaster for ${name} — an own goal!`,
          ])
          : pick([
            `GOAL! What a strike from ${name}!`,
            `${name} scores! ${team(e.teamIdx)} have it! Unbelievable!`,
            `It's in! ${name}, with a goal ${team(e.teamIdx)} fans will remember!`,
            `GOAL for ${team(e.teamIdx)}! ${name} finds the net!`,
          ]), 3);
        break;
      }
      case 'save':
        if (Math.random() < 0.6) {
          this.say(pick([
            `What a save by ${last(e.keeperName)}!`,
            `Brilliant from ${last(e.keeperName)} — kept it out!`,
            `Denied! ${last(e.keeperName)} says no!`,
          ]), 1);
        }
        break;
      case 'post':
        this.say(pick(['Off the woodwork!', 'The post! So close!', 'Rattled the frame!']), 1);
        break;
      case 'miss':
        if (Math.random() < 0.4) {
          this.say(pick([
            `Wide! ${last(e.shooterName)} will want that one back.`,
            `Just off target from ${last(e.shooterName)}.`,
          ]), 1);
        }
        break;
      case 'card':
        this.say(e.color === 'red'
          ? `It's a red card! ${last(e.playerName)} is off — down to ten men!`
          : `Yellow card. Into the book goes ${last(e.playerName)}.`,
        e.color === 'red' ? 2 : 1);
        break;
      case 'penaltyAwarded':
        this.say(`Penalty! The referee points to the spot — huge moment for ${team(e.teamIdx)}!`, 2);
        break;
      case 'penKick':
        this.say(e.result === 'goal' ? pick([`${last(e.takerName)} buries it!`, 'He scores! Ice cold!'])
          : e.result === 'saved' ? pick(['Saved! Incredible!', 'The keeper guesses right — saved!'])
          : `He's missed it! ${last(e.takerName)} puts it wide!`, 2);
        break;
      case 'shootoutEnd':
        this.say(`${team(e.winnerIdx)} win the shootout! What drama!`, 3);
        break;
      case 'break':
        this.say(e.label === 'HALF-TIME'
          ? `That's half time. ${this.scoreline(m, false)}`
          : e.label === 'PENALTIES' ? 'We are going to penalties!'
          : 'The whistle goes — we need extra time.', 2);
        break;
      case 'fulltime':
        this.say(`There's the final whistle! ${this.scoreline(m, true)}`, 3);
        break;
      default:
        break;
    }
  }

  private scoreline(m: Match, final: boolean): string {
    const [h, a] = m.teams;
    if (h.score === a.score) return `${h.data.name} ${h.score}, ${a.data.name} ${a.score}.`;
    const [w, l] = h.score > a.score ? [h, a] : [a, h];
    return `${w.data.name} ${final ? 'beat' : 'lead'} ${l.data.name}, ${w.score} to ${l.score}.`;
  }
}
