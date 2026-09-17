// The broadcast graphics package (§7.1 "UI", §7.2): a late-2000s TV kit —
// glossy dark bars with team-colour accents, a condensed bold face for every
// number and a clean sans for names, lens-flare wipes between cuts, and a
// letterboxed replay frame with a REPLAY corner bug.
//
// Everything lives in one detachable container inside #ui-root, so the HUD can
// own the gameplay furniture (power bars, nameplates, reticle) and delegate the
// television to this module. Two rules hold the whole file together:
//
//  1. Idle costs nothing. The per-frame `update` only touches the DOM when a
//     rendered string actually changed, and every move is a CSS transform or
//     opacity — never a width/top/left animation.
//  2. Every settled graphic is a CLASS state reached through a transition, not
//     a keyframe that ends somewhere. That is what lets the capture harness add
//     `.bc-static`, freeze the package mid-broadcast and screenshot it.

import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import { esc } from './escape';

// --------------------------------------------------------------- camera hooks

/** Hard-cut kinds the camera director announces. Open to extension: the camera
 *  owns the vocabulary, we only choose a wipe flavour per kind. */
export type CutKind =
  | 'corner' | 'freeKick' | 'throwIn' | 'goalKick' | 'kickoff' | 'replay' | 'beauty'
  | (string & {});

/**
 * The slice of the renderer this module talks to. Declared HERE rather than
 * imported so the wiring in main.ts compiles before the camera agent lands
 * `GameRenderer.onCut` — assigning the field early is harmless, and the day the
 * renderer starts calling it the graphics light up with no further change.
 */
export interface CameraCutSource {
  onCut?: ((kind: CutKind) => void) | null;
}

// ------------------------------------------------------------- lower thirds

/** Band priority: a goal outranks a big moment outranks routine furniture. */
export const BAND_GOAL = 3;
export const BAND_BIG = 2;
export const BAND_INFO = 1;

export interface BandSpec {
  /** de-dupes a repeat of the same graphic already queued */
  key: string;
  prio: number;
  /** word in the team-colour block ("GOAL", "CORNER", "PENALTY"); '' to omit */
  flag: string;
  /** accent colour — team shirt, or the card colour */
  color: string;
  /** the big line: usually a player name */
  title: string;
  /** the small line under it */
  sub: string;
  /** seconds on screen */
  hold: number;
  /** draws a mini card in the flag block */
  card?: 'yellow' | 'red';
  /** right-hand scoreline chip, goal bands only */
  score?: string;
  /** extra gloss + a wider flag for the goal variant */
  big?: boolean;
}

// ------------------------------------------------------------------ helpers

/** Readable ink for text sitting on a team colour. */
function inkOn(hex: string): string {
  const v = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(v)) return '#fff';
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return (r * 0.299 + g * 0.587 + b * 0.114) > 150 ? '#0b0d12' : '#ffffff';
}

/** SURNAME, upper-cased — the broadcast convention for a name plate. */
function surname(name: string): string {
  return (name.split(' ').pop() ?? name).toUpperCase();
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Period bases/spans mirror Match.displayMinute() so the bug and the ticker
 *  never disagree about what minute it is. */
const PERIOD_BASE = [0, 0, 45, 90, 105];
const PERIOD_SPAN = [45, 45, 45, 15, 15];
const PERIOD_TAG = ['', '1ST', '2ND', 'ET1', 'ET2'];

export class Broadcast {
  private el: HTMLElement;
  // score bug
  private bug!: HTMLElement;
  private bugScore: [HTMLElement, HTMLElement];
  private bugTime!: HTMLElement;
  private bugHalf!: HTMLElement;
  private bugAdd!: HTMLElement;
  private scorers!: HTMLElement;
  private scorerLines: [HTMLElement, HTMLElement];
  // lower third
  private band!: HTMLElement;
  private queue: BandSpec[] = [];
  private live: BandSpec | null = null;
  private hold = 0;
  private gap = 0;
  // transitions
  private wipe!: HTMLElement;
  private wipeCool = 0;
  /** set the first time the camera announces a cut: after that the camera, not
   *  the event feed, owns the wipes (or dead balls would wipe twice) */
  private cutsWired = false;
  // replay
  private replayBug!: HTMLElement;
  private replayLabel!: HTMLElement;
  // lineups
  private lineups!: HTMLElement;
  private lineupHold = 0;
  private lineupsShown = false;
  // score-bug cache, so the per-frame update writes nothing when nothing moved
  private lastTime = '';
  private lastHalf = '';
  private lastAdd = '';
  private lastScore: [string, string] = ['', ''];
  private goals: { teamIdx: number; name: string; minute: number; own: boolean }[] = [];
  /**
   * Optional audio cue, assigned by main.ts. Called with a cue name on the
   * graphics that want one: 'whoosh' under a wipe, 'goal' under the goal band.
   * Guarded everywhere — the package is silent if nothing is listening.
   */
  stinger: ((name: string) => void) | null = null;

  constructor(
    private root: HTMLElement,
    private match: Match,
    private shirts: [string, string],
  ) {
    this.el = document.createElement('div');
    this.el.className = 'bc';
    this.el.innerHTML = this.template();
    root.appendChild(this.el);

    const q = <T extends HTMLElement>(sel: string): T => this.el.querySelector<T>(sel)!;
    this.bug = q('.bc-bug');
    this.bugScore = [q('.bc-t0 .bc-sc'), q('.bc-t1 .bc-sc')];
    this.bugTime = q('.bc-time');
    this.bugHalf = q('.bc-half');
    this.bugAdd = q('.bc-add');
    this.scorers = q('.bc-scorers');
    this.scorerLines = [q('.bc-sl0'), q('.bc-sl1')];
    this.band = q('.bc-lt');
    this.wipe = q('.bc-wipe');
    this.replayBug = q('.bc-replay');
    this.replayLabel = q('.bc-replay-label');
    this.lineups = q('.bc-lineups');

    // the bug rides in on its own the moment the package goes live
    this.slideInBug();
  }

  // ------------------------------------------------------------------ markup

  private template(): string {
    const [h, a] = this.match.teams;
    const seg = (i: number, code: string): string => {
      const c = this.shirts[i];
      return `<div class="bc-seg bc-t bc-t${i}" style="--tv-accent:${c};--tv-ink:${inkOn(c)}">
        <i class="bc-acc"></i>
        <span class="bc-code">${esc(code.toUpperCase())}</span>
        <span class="bc-sc">0</span>
      </div>`;
    };
    return `
      <div class="bc-lb bc-lb-top"></div>
      <div class="bc-lb bc-lb-bot"></div>
      <div class="bc-bug">
        ${seg(0, h.data.code)}
        ${seg(1, a.data.code)}
        <div class="bc-seg bc-clock">
          <span class="bc-half">1ST</span>
          <span class="bc-time">00:00</span>
          <span class="bc-add"></span>
        </div>
      </div>
      <div class="bc-scorers"><div class="bc-sl bc-sl0"></div><div class="bc-sl bc-sl1"></div></div>
      <div class="bc-lt"></div>
      <div class="bc-replay">
        <i class="bc-dot"></i>REPLAY<span class="bc-replay-label"></span>
      </div>
      <div class="bc-lineups"></div>
      <div class="bc-wipe"><i class="bc-wipe-band"></i><i class="bc-wipe-flare"></i></div>
    `;
  }

  // ------------------------------------------------------------- score bug

  /** Re-play the bug's slide-in (match start, and every period kickoff). */
  slideInBug(): void {
    this.bug.classList.remove('in');
    void this.bug.offsetWidth; // one forced reflow per period, not per frame
    this.bug.classList.add('in');
  }

  /**
   * Per-frame refresh. Deliberately string-compares before touching the DOM:
   * the clock only changes 60 times a minute, so 59 of every 60 frames this is
   * pure arithmetic and zero layout.
   */
  update(dt: number): void {
    const m = this.match;

    // ---- clock
    const shootout = m.phase === 'shootout';
    const half = Math.max(1, Math.min(4, m.half));
    const base = PERIOD_BASE[half] ?? 0;
    const span = PERIOD_SPAN[half] ?? 45;
    const halfLen = half <= 2 ? m.halfLength : m.halfLength / 3;
    const raw = base + (m.clock / Math.max(halfLen, 1e-6)) * span;
    let time: string;
    let add = '';
    if (shootout) {
      time = '--:--';
    } else {
      // stoppage time keeps counting, exactly like a real broadcast clock, and
      // the added-time badge says how far past the whistle we are
      const mins = Math.floor(raw);
      time = `${two(mins)}:${two(Math.floor((raw - mins) * 60))}`;
      if (m.mode !== 'golden' && m.clock > halfLen) {
        add = `+${Math.max(1, Math.ceil(((m.clock - halfLen) / halfLen) * span))}`;
      }
    }
    const tag = shootout ? 'PENS' : m.mode === 'golden' ? 'GOLD' : (PERIOD_TAG[half] || '1ST');
    if (time !== this.lastTime) { this.bugTime.textContent = time; this.lastTime = time; }
    if (tag !== this.lastHalf) { this.bugHalf.textContent = tag; this.lastHalf = tag; }
    if (add !== this.lastAdd) {
      this.bugAdd.textContent = add;
      this.bugAdd.classList.toggle('on', add !== '');
      this.lastAdd = add;
    }

    // ---- score
    for (let i = 0; i < 2; i++) {
      const s = String(m.teams[i].score);
      if (s !== this.lastScore[i]) {
        this.bugScore[i].textContent = s;
        this.lastScore[i] = s;
      }
    }

    // ---- lower-third queue
    if (this.live) {
      this.hold -= dt;
      if (this.hold <= 0) {
        this.band.classList.remove('show');
        this.live = null;
        this.gap = 0.3;
      }
    } else if (this.queue.length) {
      this.gap -= dt;
      if (this.gap <= 0) this.showNext();
    }

    if (this.lineupHold > 0) {
      this.lineupHold -= dt;
      if (this.lineupHold <= 0) this.hideLineups();
    }
    if (this.wipeCool > 0) this.wipeCool -= dt;
  }

  /** Scorer line under the bug: FIFA's "OKAFOR 34'", home row then away row. */
  private paintScorers(): void {
    for (let i = 0; i < 2; i++) {
      const mine = this.goals.filter((g) => g.teamIdx === i);
      const line = this.scorerLines[i];
      if (!mine.length) { line.innerHTML = ''; line.classList.remove('on'); continue; }
      const c = this.shirts[i];
      const body = mine
        .map((g) => `${esc(surname(g.name))} ${g.minute}'${g.own ? ' <em>og</em>' : ''}`)
        .join('<span class="bc-sep">·</span>');
      line.innerHTML = `<i style="background:${c}"></i>${body}`;
      line.classList.add('on');
    }
    this.scorers.classList.toggle('on', this.goals.length > 0);
  }

  // ---------------------------------------------------------- lower thirds

  /**
   * Queue a name plate. A higher priority preempts whatever is on screen (a
   * goal never waits behind a corner), equal or lower joins the queue.
   */
  pushBand(spec: BandSpec): void {
    if (this.live?.key === spec.key) return;
    if (this.queue.some((b) => b.key === spec.key)) return;
    if (this.live && spec.prio > this.live.prio) {
      this.live = null;
      this.band.classList.remove('show');
      this.queue.unshift(spec);
      this.gap = 0.18;
      return;
    }
    if (!this.live && !this.queue.length && this.gap <= 0) {
      this.queue.push(spec);
      this.showNext();
      return;
    }
    this.queue.push(spec);
    // a set-piece plate that has waited out its moment is stale, not a backlog
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
  }

  private showNext(): void {
    // always take the most important thing waiting, oldest first within a tier
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].prio > this.queue[best].prio) best = i;
    }
    const spec = this.queue.splice(best, 1)[0];
    if (!spec) return;
    // the goal band brings its own sting on the event; everything else gets
    // the short TV hit as it slides on
    if (spec.card) this.stinger?.('cardSting');
    else if (spec.prio < BAND_GOAL) this.stinger?.('sting');
    this.live = spec;
    this.hold = spec.hold;
    const ink = inkOn(spec.color);
    const flag = spec.card
      ? `<div class="bc-lt-flag card"><i class="bc-lt-card ${spec.card}"></i></div>`
      : spec.flag
        ? `<div class="bc-lt-flag">${esc(spec.flag)}</div>`
        : '';
    const score = spec.score ? `<div class="bc-lt-score">${spec.score}</div>` : '';
    this.band.className = `bc-lt${spec.big ? ' big' : ''}`;
    this.band.setAttribute('style', `--tv-accent:${spec.color};--tv-ink:${ink}`);
    this.band.innerHTML = `<i class="bc-lt-bar"></i>${flag}
      <div class="bc-lt-txt">
        <div class="bc-lt-t">${esc(spec.title)}</div>
        <div class="bc-lt-s">${spec.sub}</div>
      </div>${score}<i class="bc-lt-tail"></i>`;
    void this.band.offsetWidth;
    this.band.classList.add('show');
  }

  /** Drop everything on screen (period breaks, full time). */
  clearBands(): void {
    this.queue.length = 0;
    this.live = null;
    this.hold = 0;
    this.band.classList.remove('show');
  }

  // ------------------------------------------------------------ transitions

  /** The 0.6s broadcast wipe: a diagonal gloss streak with a lens flare riding
   *  its leading edge. Cheap — two transformed elements, one animation. */
  playWipe(): void {
    if (this.wipeCool > 0) return;
    this.wipeCool = 0.45;
    this.stinger?.('whoosh');
    this.wipe.classList.remove('go');
    void this.wipe.offsetWidth;
    this.wipe.classList.add('go');
  }

  /** Every hard camera cut gets a wipe; the camera owns them once it speaks. */
  onCameraCut(kind: CutKind): void {
    this.cutsWired = true;
    // a beauty shot dissolves rather than snapping — a wipe there reads wrong
    if (kind === 'beauty') return;
    this.playWipe();
  }

  /** True once the camera director has announced at least one cut. */
  get cameraDrivesCuts(): boolean {
    return this.cutsWired;
  }

  /** Dead-ball wipe fired from the event feed — suppressed as soon as the
   *  camera's own cut callback is alive, so a corner never wipes twice. */
  eventWipe(): void {
    if (!this.cutsWired) this.playWipe();
  }

  // ---------------------------------------------------------------- replay

  setReplay(on: boolean, label = 'REPLAY'): void {
    const was = this.root.classList.contains('replay-on');
    this.root.classList.toggle('replay-on', on);
    if (on) {
      // "REPLAY · ANGLE 2" arrives as one string; the angle rides as a tag
      const [, extra] = label.split('·').map((s) => s.trim());
      this.replayLabel.textContent = extra ?? '';
      this.replayLabel.classList.toggle('on', !!extra);
    }
    if (was !== on) {
      this.stinger?.(on ? 'replayIn' : 'replayOut');
      this.playWipe(); // in and out of the package both cut
    }
  }

  // --------------------------------------------------------------- lineups

  /**
   * Pre-match starting XI graphic. `hold` seconds then it fades itself out;
   * pass 0 to hold until `hideLineups()` (what the walkout cutscene wants).
   */
  showLineups(hold = 5): void {
    if (!this.lineups.innerHTML) this.lineups.innerHTML = this.lineupHtml();
    this.lineups.classList.add('show');
    this.lineupHold = hold;
    this.lineupsShown = true;
  }

  hideLineups(): void {
    this.lineups.classList.remove('show');
    this.lineupHold = 0;
  }

  /** Has anything shown the lineups yet this match? */
  get lineupsWereShown(): boolean {
    return this.lineupsShown;
  }

  private lineupHtml(): string {
    const col = (i: number): string => {
      const t = this.match.teams[i];
      const c = this.shirts[i];
      const rows = t.players.map((p) => {
        const star = p.data.star ? '<em>★</em>' : '';
        return `<li><b>${p.data.num}</b><span>${esc(p.data.name)}</span>${star}
          <u>${p.role}</u></li>`;
      }).join('');
      return `<div class="bc-lu-col">
        <div class="bc-lu-team" style="--tv-accent:${c};--tv-ink:${inkOn(c)}">
          <i></i><span class="bc-lu-name">${esc(t.data.name.toUpperCase())}</span>
          <span class="bc-lu-code">${esc(t.data.code)}</span>
        </div>
        <div class="bc-lu-form">${esc(t.data.formation)}<span>·</span>${esc(t.data.style.toUpperCase())}</div>
        <ol>${rows}</ol>
      </div>`;
    };
    return `<div class="bc-lu-panel">
      <div class="bc-lu-head"><i></i>STARTING LINE-UPS<i></i></div>
      <div class="bc-lu-cols">${col(0)}<div class="bc-lu-v"><span>VS</span></div>${col(1)}</div>
    </div>`;
  }

  // ----------------------------------------------------------------- events

  /** Graphics driven straight off the sim's event feed. */
  onEvent(e: MatchEvent): void {
    const m = this.match;
    const name = (i: number): string => m.teams[i].data.name.toUpperCase();
    switch (e.type) {
      case 'goal': {
        this.goals.push({
          teamIdx: e.teamIdx, name: e.scorerName, minute: e.minute, own: !!e.ownGoal,
        });
        this.paintScorers();
        this.hideLineups();
        const c = this.shirts[e.teamIdx];
        const sc = `<b>${esc(m.teams[0].data.code)}</b> ${m.teams[0].score}`
          + `<i>-</i>${m.teams[1].score} <b>${esc(m.teams[1].data.code)}</b>`;
        this.pushBand({
          key: `goal${this.goals.length}`,
          prio: BAND_GOAL,
          flag: e.ownGoal ? 'O.G.' : 'GOAL',
          color: c,
          title: surname(e.scorerName),
          sub: e.ownGoal
            ? `OWN GOAL <span class="bc-min">${e.minute}'</span> · ${esc(name(1 - e.teamIdx))}`
            : `${esc(name(e.teamIdx))} <span class="bc-min">${e.minute}'</span>`,
          score: sc,
          hold: 4,
          big: true,
        });
        this.stinger?.('goal');
        break;
      }
      case 'penaltyAwarded':
        this.pushBand({
          key: `pen${e.minute}`, prio: BAND_BIG, flag: 'PENALTY', color: this.shirts[e.teamIdx],
          title: name(e.teamIdx), sub: `SPOT KICK <span class="bc-min">${e.minute}'</span>`,
          hold: 3.2,
        });
        this.eventWipe();
        break;
      case 'card':
        this.pushBand({
          key: `card${e.minute}${e.playerName}`, prio: BAND_BIG,
          flag: '', color: e.color === 'red' ? '#d0342a' : '#f0c020',
          card: e.color,
          title: surname(e.playerName),
          sub: `${e.color === 'red' ? 'RED CARD' : 'BOOKED'} · ${esc(name(e.teamIdx))} `
            + `<span class="bc-min">${e.minute}'</span>`,
          hold: 3.4,
        });
        break;
      case 'corner':
        this.pushBand({
          key: `corner${e.minute}${e.teamIdx}`, prio: BAND_INFO, flag: 'CORNER',
          color: this.shirts[e.teamIdx], title: name(e.teamIdx),
          sub: `CORNER KICK <span class="bc-min">${e.minute}'</span>`, hold: 2.6,
        });
        this.eventWipe();
        break;
      case 'foul':
        this.pushBand({
          key: `foul${e.minute}${e.playerName}`, prio: BAND_INFO, flag: 'FREE KICK',
          color: this.shirts[1 - e.teamIdx], title: name(1 - e.teamIdx),
          sub: `FOUL BY ${esc(surname(e.playerName))} <span class="bc-min">${e.minute}'</span>`,
          hold: 2.6,
        });
        break;
      case 'offside':
        this.pushBand({
          key: `off${e.minute}${e.playerName}`, prio: BAND_INFO, flag: 'OFFSIDE',
          color: this.shirts[e.teamIdx], title: surname(e.playerName),
          sub: `FLAG UP · ${esc(name(e.teamIdx))} <span class="bc-min">${e.minute}'</span>`,
          hold: 2.4,
        });
        this.eventWipe();
        break;
      case 'save':
        if (!e.shotStop) break;
        this.pushBand({
          key: `save${e.keeperName}${m.displayMinute()}`, prio: BAND_INFO, flag: 'SAVE',
          color: this.shirts[e.teamIdx], title: surname(e.keeperName),
          sub: `SHOT STOPPED · ${esc(name(e.teamIdx))}`, hold: 2.4,
        });
        break;
      case 'throwIn':
      case 'goalKick':
        this.eventWipe();
        break;
      case 'kickoff':
        // every post-goal restart re-emits kickoff; only a period start is news
        if (m.clock >= 1) break;
        this.slideInBug();
        if (e.half === 1 && !this.lineupsShown && m.mode !== 'shootout') this.showLineups(5);
        else this.hideLineups();
        break;
      case 'break':
      case 'fulltime':
        this.clearBands();
        this.hideLineups();
        break;
      default:
        break;
    }
  }

  /** Goals so far, for the stats card's timeline. */
  get goalList(): readonly { teamIdx: number; name: string; minute: number; own: boolean }[] {
    return this.goals;
  }

  // ------------------------------------------------------------ capture aid

  /**
   * Freeze the package for a deterministic screenshot (§7A.9): transitions and
   * blinks off, every showing graphic pinned at its settled state. `wipeAt`
   * parks the wipe mid-sweep instead of running it.
   */
  freezeForCapture(wipeAt = -1): void {
    this.root.classList.add('bc-static');
    if (wipeAt >= 0) {
      this.wipe.classList.add('go', 'freeze');
      this.wipe.style.setProperty('--tv-wipe-at', `${-wipeAt}s`);
    }
  }

  destroy(): void {
    this.queue.length = 0;
    this.live = null;
    this.el.remove();
    this.root.classList.remove('replay-on', 'bc-static');
  }
}
