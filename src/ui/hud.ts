// Match HUD: the gameplay furniture (ticker, power bars, nameplates, penalty
// reticle + shootout board, card flash, break/full-time stats card) plus the
// wiring that hands the television — score bug, lower thirds, wipes, replay
// frame, line-ups — to the broadcast package in ./broadcast.ts.
//
// Split of responsibilities: anything a viewer at home would see on TV lives in
// Broadcast; anything that exists because somebody is holding a controller
// (power bars, nameplates, control hints, reticle) lives here.

import { SEAT_SLOTS, slotTeam, type Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import { GOAL_HALF_W, HALF_L, SHOT_MAX_HOLD } from '../sim/constants';
import { esc } from './escape';
import { resolvedShirts } from '../render/playerMesh';
import { controlsSetting, type ControlsSetting } from './prefs';
import { Broadcast, type CutKind } from './broadcast';

/** One line of the match story shown on break/full-time cards. */
interface StoryEntry {
  minute: number;
  teamIdx: number;
  icon: 'goal' | 'og' | 'yellow' | 'red';
  name: string;
}

export class HUD {
  private root: HTMLElement;
  /** The TV package: score bug, lower thirds, wipes, replay frame, line-ups. */
  bc!: Broadcast;
  private ticker!: HTMLElement;
  private tickerQueue: string[] = [];
  private tickerBusy = false;
  private powerWraps: HTMLElement[] = [];
  private powerFills: HTMLElement[] = [];
  private nameplates: HTMLElement[] = [];
  private cardFlash!: HTMLElement;
  private card!: HTMLElement;
  private controlsCard!: HTMLElement;
  private reticle!: HTMLElement;
  private penBoard!: HTMLElement;
  private penHint!: HTMLElement;
  private netToast!: HTMLElement;
  /** Persistent reconnect banner; outranks any transient flash. */
  private netHold: string | null = null;
  private netFlashText = '';
  private netFlashTimer = 0;
  /** Per-slot link health, drawn as a pip on that player's nameplate. */
  private netSeat: ('ok' | 'degraded' | 'lost' | 'ai')[] = ['ok', 'ok', 'ok', 'ok'];
  private controlsTimer = 14;
  private controlsMode: ControlsSetting = controlsSetting();
  private controlsAttack = '';
  private controlsDefense = '';
  private controlsBright = 0;
  /** The lone human's TEAM for context-aware hints; -1 when more than one. */
  private soloSeat = -1;
  /** Overrides the full-time prompt (tournament mode: J and K both continue). */
  fulltimeHint: string | null = null;
  /** Set by main: whether a goal clip exists for the L-to-rewatch FT prompt. */
  canReplayGoal: (() => boolean) | null = null;
  private story: StoryEntry[] = [];
  private corners = [0, 0];
  private fouls = [0, 0];
  /** goals + saves per player, for the Man of the Match line. */
  private motm = new Map<string, { teamIdx: number; name: string; score: number }>();
  /** what each side actually wears (clash-resolved) — not raw kit.home */
  private shirts: [string, string];

  constructor(private match: Match) {
    this.root = document.getElementById('ui-root')!;
    this.shirts = resolvedShirts(match.teams[0].data.kit, match.teams[1].data.kit);
    this.build();
  }

  private build(): void {
    const seats = this.match.seats;
    const filled: number[] = [];
    for (let s = 0; s < SEAT_SLOTS; s++) if (seats[s]) filled.push(s);
    const twoP = filled.length > 1;
    const dev = (i: number): string => {
      const kind = seats[i]?.kind;
      return kind === 'pad' ? 'GAMEPAD' : kind === 'remote' ? 'REMOTE' : 'KEYBOARD';
    };
    this.root.innerHTML = `
      <div class="ticker"></div>
      <div class="power-wrap p1"><div class="power-fill"></div></div>
      <div class="power-wrap p2"><div class="power-fill"></div></div>
      <div class="power-wrap p3"><div class="power-fill"></div></div>
      <div class="power-wrap p4"><div class="power-fill"></div></div>
      <div class="nameplate np1"></div>
      <div class="nameplate np2"></div>
      <div class="nameplate np3"></div>
      <div class="nameplate np4"></div>
      <div class="card-flash"></div>
      <div class="reticle"></div>
      <div class="pen-board"></div>
      <div class="pen-hint"></div>
      <div class="match-card"></div>
      <div class="controls-card"></div>
      <div class="net-toast"></div>
    `;
    // the TV package appends itself; it must outlive nothing above, so it is
    // built AFTER the innerHTML assignment that would otherwise wipe it
    this.bc = new Broadcast(this.root, this.match, this.shirts);
    this.controlsAttack = twoP
      ? `${filled.map((i) => `P${i + 1} ${dev(i)}`).join(' · ')} — PASS J/A · LOFT K/B · SHOOT L/X (hold) · THROUGH I/Y · SPRINT SHIFT/RT · REPLAY R/BACK · PAUSE ESC/START`
      : 'MOVE WASD · PASS J · LOFT K · SHOOT L (hold) · THROUGH I · SPRINT SHIFT · SWITCH SPACE · REPLAY R · PAUSE ESC';
    // a shared couch shares one card, so it keeps the merged line; 1P swaps
    // to a defensive cheat-sheet whenever the other side has the ball
    this.controlsDefense = twoP
      ? '' : 'DEFENDING — SWITCH SPACE · CHASE hold J · SLIDE L · SPRINT SHIFT · REPLAY R · PAUSE ESC';
    if (!twoP) this.soloSeat = filled.length ? slotTeam(filled[0]) : -1;
    this.ticker = this.root.querySelector('.ticker')!;
    this.powerWraps = [...this.root.querySelectorAll<HTMLElement>('.power-wrap')];
    this.powerFills = [...this.root.querySelectorAll<HTMLElement>('.power-fill')];
    this.nameplates = [...this.root.querySelectorAll<HTMLElement>('.nameplate')];
    this.cardFlash = this.root.querySelector('.card-flash')!;
    this.card = this.root.querySelector('.match-card')!;
    this.controlsCard = this.root.querySelector('.controls-card')!;
    this.controlsCard.textContent = this.controlsAttack;
    if (this.controlsMode === 'off') this.controlsCard.style.display = 'none';
    this.reticle = this.root.querySelector('.reticle')!;
    this.penBoard = this.root.querySelector('.pen-board')!;
    this.penHint = this.root.querySelector('.pen-hint')!;
    this.netToast = this.root.querySelector('.net-toast')!;
  }

  // ---------------------------------------------------- broadcast passthrough
  // Thin wrappers so main.ts (and the cutscene agent) talk to one object.

  /** Pre-match starting XI. `hold` 0 holds it until `hideLineups()`. */
  showLineups(hold = 5): void { this.bc.showLineups(hold); }

  hideLineups(): void { this.bc.hideLineups(); }

  /** Every hard camera cut gets a broadcast wipe (camera agent's `onCut`). */
  onCameraCut(kind: CutKind): void { this.bc.onCameraCut(kind); }

  // ------------------------------------------------- remote seat health (§5.4.5)

  /** Link health for a seat — a pip rides that player's nameplate. */
  setSeatNet(idx: number, state: 'ok' | 'degraded' | 'lost' | 'ai'): void {
    this.netSeat[idx] = state;
  }

  /** Sticky banner while the match is held for a reconnect; null clears it. */
  setNetHold(text: string | null): void {
    this.netHold = text;
    this.paintNetToast();
  }

  /** One-shot announcement ("AI TAKES OVER", "P2 IS BACK"). */
  netFlash(text: string, seconds = 3.5): void {
    this.netFlashText = text;
    this.netFlashTimer = seconds;
    this.paintNetToast();
  }

  private paintNetToast(): void {
    const text = this.netHold ?? (this.netFlashTimer > 0 ? this.netFlashText : '');
    if (this.netToast.textContent !== text) this.netToast.textContent = text;
    this.netToast.classList.toggle('show', text !== '');
  }

  /** Letterbox + REPLAY corner bug, with a wipe on the way in and out. */
  setReplay(on: boolean, label = 'REPLAY'): void {
    this.bc.setReplay(on, label);
  }

  playWipe(): void {
    this.bc.playWipe();
  }

  pushTicker(msg: string): void {
    this.tickerQueue.push(msg);
    if (!this.tickerBusy) this.nextTicker();
  }

  private nextTicker(): void {
    const msg = this.tickerQueue.shift();
    if (!msg) { this.tickerBusy = false; return; }
    this.tickerBusy = true;
    this.ticker.textContent = msg;
    this.ticker.classList.add('show');
    setTimeout(() => {
      this.ticker.classList.remove('show');
      setTimeout(() => this.nextTicker(), 350);
    }, 3400);
  }

  onEvent(e: MatchEvent): void {
    const m = this.match;
    const teamName = (idx: number): string => m.teams[idx].data.name.toUpperCase();
    // the TV package takes every event first: it owns the bug, the lower
    // thirds and every wipe that isn't the camera's
    this.bc.onEvent(e);
    switch (e.type) {
      case 'goal': {
        this.pushTicker(e.ownGoal
          ? `${e.minute}' — OWN GOAL! ${e.scorerName} turns it into his own net!`
          : `${e.minute}' — GOOOAL! ${e.scorerName} scores for ${teamName(e.teamIdx)}!`);
        this.story.push({
          minute: e.minute, teamIdx: e.teamIdx,
          icon: e.ownGoal ? 'og' : 'goal', name: e.scorerName,
        });
        if (!e.ownGoal) this.creditMotm(e.teamIdx, e.scorerName, 3, e.scorerNum);
        break;
      }
      case 'miss':
        this.pushTicker(`${e.minute}' — CLOSE! ${e.shooterName} drags it wide.`);
        break;
      case 'save':
        // routine loose-ball collections also emit 'save' — only genuine
        // shot-stops deserve the shout (or MOTM credit: uncapped smother
        // farming handed the award to a keeper who conceded ten)
        if (e.shotStop) {
          this.pushTicker(`WHAT A SAVE! ${e.keeperName} denies them!`);
          this.creditMotm(e.teamIdx, e.keeperName, 1.5, e.keeperNum);
        }
        break;
      case 'post':
        this.pushTicker(`OFF THE WOODWORK! The frame says no.`);
        break;
      case 'corner':
        // the wipe on this (and every other dead ball) belongs to the
        // broadcast package now: it suppresses its own once the camera
        // director starts announcing cuts, so nothing ever wipes twice
        this.corners[e.teamIdx]++;
        this.pushTicker(`${e.minute}' — Corner to ${teamName(e.teamIdx)}.`);
        break;
      case 'offside':
        this.pushTicker(`${e.minute}' — Flag's up! ${e.playerName} strayed offside.`);
        break;
      case 'foul':
        this.fouls[e.teamIdx]++;
        this.pushTicker(`${e.minute}' — Foul by ${e.playerName}.`);
        break;
      case 'card': {
        this.flashCard(e.color);
        this.pushTicker(e.color === 'red'
          ? `${e.minute}' — RED CARD! ${e.playerName} is OFF!`
          : `${e.minute}' — Yellow card for ${e.playerName}.`);
        this.story.push({ minute: e.minute, teamIdx: e.teamIdx, icon: e.color, name: e.playerName });
        break;
      }
      case 'penaltyAwarded':
        this.pushTicker(`${e.minute}' — PENALTY to ${teamName(e.teamIdx)}!`);
        break;
      case 'penKick': {
        const msg = e.result === 'goal' ? `${e.takerName} buries it!`
          : e.result === 'saved' ? `SAVED! ${e.takerName} is denied!`
          : `${e.takerName} misses!`;
        this.pushTicker(msg);
        break;
      }
      case 'shootoutEnd':
        this.pushTicker(`${teamName(e.winnerIdx)} WIN THE SHOOTOUT!`);
        break;
      case 'kickoff':
        // every post-goal restart re-emits kickoff — only announce the period
        // on its FIRST kickoff or the ticker repeats itself after every goal
        if (m.clock >= 1) break;
        if (e.half === 1 && m.mode === 'golden') this.pushTicker(`GOLDEN GOAL — NEXT GOAL WINS IT ALL!`);
        if (e.half === 2) this.pushTicker(`Second half under way!`);
        if (e.half === 3) this.pushTicker(`Extra time — next 15 minutes decide it… maybe.`);
        break;
      case 'break':
        this.showCard(e.label);
        break;
      case 'fulltime':
        this.showCard('FULL-TIME');
        break;
      default:
        break;
    }
  }

  private creditMotm(teamIdx: number, name: string, points: number, num?: number): void {
    // key by shirt number when we have it — display names can be duplicated
    const key = `${teamIdx}|${num ?? name}`;
    const cur = this.motm.get(key) ?? { teamIdx, name, score: 0 };
    cur.score += points;
    this.motm.set(key, cur);
  }

  /** ★ MAN OF THE MATCH line for the full-time card; '' when nobody earned it. */
  private motmHtml(): string {
    let best: { teamIdx: number; name: string; score: number } | null = null;
    for (const c of this.motm.values()) {
      if (!best || c.score > best.score) best = c;
    }
    if (!best || best.score < 3) return ''; // a goal or two big saves, minimum
    const surname = esc(best.name.split(' ').pop()?.toUpperCase() ?? '');
    const code = this.match.teams[best.teamIdx].data.code;
    return `<div class="motm">★ MAN OF THE MATCH`
      + `<i class="mc-chip" style="background:${this.shirts[best.teamIdx]}"></i>${surname} `
      + `<small>${esc(code)}</small></div>`;
  }

  private flashCard(color: 'yellow' | 'red'): void {
    this.cardFlash.className = `card-flash show ${color}`;
    setTimeout(() => this.cardFlash.classList.remove('show'), 1600);
  }

  /** The scoreline block both the stats card and the pause card wear. */
  private scorelineHtml(): string {
    const [h, a] = this.match.teams;
    const side = (i: number, cls: string): string =>
      `<div class="mc-side ${cls}" style="--tv-accent:${this.shirts[i]}">
        <i></i><span>${esc(this.match.teams[i].data.name.toUpperCase())}</span>
      </div>`;
    return `<div class="scoreline">${side(0, 'home')}
      <div class="mc-score">${h.score}<em>-</em>${a.score}</div>
      ${side(1, 'away')}</div>`;
  }

  /** One stat row: value, label over a proportional two-tone bar, value. */
  private statRow(label: string, hv: number, av: number, suffix = ''): string {
    const total = hv + av;
    const hpct = total > 0 ? (hv / total) * 100 : 50;
    return `<div class="mc-row">
      <b>${hv}${suffix}</b>
      <div class="mc-mid"><span>${label}</span><div class="mc-bar">
        <i style="width:${hpct.toFixed(1)}%;background:${this.shirts[0]}"></i>
        <i style="width:${(100 - hpct).toFixed(1)}%;background:${this.shirts[1]}"></i>
      </div></div>
      <b>${av}${suffix}</b>
    </div>`;
  }

  /** Cards row: the actual little rectangles, not a bar. */
  private cardsRow(): string {
    const pips = (i: number, right: boolean): string => {
      const mine = this.story.filter((s) => s.teamIdx === i && s.icon !== 'goal' && s.icon !== 'og');
      const y = mine.filter((s) => s.icon === 'yellow').length;
      const r = mine.filter((s) => s.icon === 'red').length;
      const body = '<u class="y"></u>'.repeat(y) + '<u class="r"></u>'.repeat(r);
      return `<div class="mc-cards${right ? ' right' : ''}">${body}</div>`;
    };
    const count = (i: number): number =>
      this.story.filter((s) => s.teamIdx === i && (s.icon === 'yellow' || s.icon === 'red')).length;
    return `<div class="mc-row">
      <b>${count(0)}</b>
      <div class="mc-mid"><span>CARDS</span>
        <div style="display:flex;gap:12px">${pips(0, false)}<div style="flex:1"></div>${pips(1, true)}</div>
      </div>
      <b>${count(1)}</b>
    </div>`;
  }

  private showCard(title: string): void {
    const [h, a] = this.match.teams;
    const total = h.possessionTicks + a.possessionTicks;
    const isFT = title === 'FULL-TIME';
    let hint = isFT
      ? (this.fulltimeHint ?? 'PRESS J FOR REMATCH · K FOR MENU')
      : title === 'PENALTIES' ? 'PRESS J FOR THE SHOOTOUT' : 'PRESS J TO CONTINUE';
    if (isFT && this.canReplayGoal?.()) hint += ' · L WATCH THE GOAL';
    const board = this.match.penalty?.board;
    const pens = board && this.match.shootoutWinner !== null
      ? `<div class="mc-pens">${esc(this.match.teams[this.match.shootoutWinner].data.name.toUpperCase())}`
        + ` WIN ${board.scores[0]}–${board.scores[1]} ON PENALTIES</div>`
      : '';
    // possession is a real number the sim keeps (Team.possessionTicks); with no
    // open play at all (a straight shootout) there is nothing to report, so the
    // row is omitted rather than invented
    const poss = total > 0
      ? this.statRow('POSSESSION', Math.round((h.possessionTicks / total) * 100),
          100 - Math.round((h.possessionTicks / total) * 100), '%')
      : '';
    this.bc.clearBands();
    this.bc.hideLineups();
    const heading = isFT
      ? (this.match.mode === 'golden' ? 'GOLDEN GOAL' : 'FULL TIME')
      : title === 'HALF-TIME' ? 'HALF TIME' : title;
    this.card.innerHTML = `
      <h1>${esc(heading)}</h1>
      ${this.scorelineHtml()}
      ${pens}
      ${isFT ? this.motmHtml() : ''}
      ${this.storyHtml()}
      <div class="mc-rows">
        ${poss}
        ${this.statRow('SHOTS', h.shots, a.shots)}
        ${this.statRow('ON TARGET', h.shotsOnTarget, a.shotsOnTarget)}
        ${this.statRow('CORNERS', this.corners[0], this.corners[1])}
        ${this.statRow('FOULS', this.fouls[0], this.fouls[1])}
        ${this.cardsRow()}
      </div>
      <div class="hint">${hint}</div>
    `;
    this.card.classList.add('show');
  }

  /** The match story: goals and cards on a minute line, home left, away right. */
  private storyHtml(): string {
    if (!this.story.length) return '';
    const icon = (s: StoryEntry): string =>
      s.icon === 'goal' ? '<span class="st-ball">●</span>'
      : s.icon === 'og' ? '<span class="st-ball og">●</span>'
      : s.icon === 'yellow' ? '<span class="st-card y"></span>'
      : '<span class="st-card r"></span>';
    const rows = this.story.map((s) => {
      const surname = esc(s.name.split(' ').pop()?.toUpperCase() ?? '');
      const og = s.icon === 'og' ? ' <small>(OG)</small>' : '';
      const body = `${icon(s)} ${s.minute}' ${surname}${og}`;
      return `<div class="story-row ${s.teamIdx === 0 ? 'home' : 'away'}">${body}</div>`;
    }).join('');
    // dense mode keeps long goal-fests fully visible on the card
    return `<div class="story${this.story.length > 8 ? ' dense' : ''}">${rows}</div>`;
  }

  /** Re-show the full-time card (after an L-triggered goal replay). */
  showFulltimeCard(): void {
    this.showCard('FULL-TIME');
  }

  hideCard(): void {
    this.card.classList.remove('show');
  }

  showPauseCard(): void {
    this.card.innerHTML = `
      <h1>PAUSED</h1>
      ${this.scorelineHtml()}
      <div class="hint">PRESS J TO RESUME · K TO QUIT</div>
    `;
    this.card.classList.add('show');
  }

  /** Per-frame HUD refresh. screenPos comes from the renderer. */
  update(dt: number, screenPos: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }): void {
    const m = this.match;
    // the score bug, the lower-third queue and the line-up hold all tick here
    this.bc.update(dt);
    const inPens = m.phase === 'shootout' || m.phase === 'penalty';

    // shot power bars, one per seat slot (penalties charge through the same bar)
    for (let i = 0; i < SEAT_SLOTS; i++) {
      const seat = m.seats[i];
      let frac = -1;
      if (seat) {
        const pen = m.penalty;
        // the spot kick belongs to the side's on-ball human, not his partner
        if (inPens && pen && m.primarySlot(pen.kickingTeam) === i && pen.phase === 'aim' && pen.charging) {
          frac = Math.min(pen.chargeT / 0.9, 1); // aim-phase hold only
        } else if (!inPens && seat.isHeld('shoot') && m.ball.owner === m.controlled[i]) {
          frac = Math.min(seat.heldDuration('shoot') / SHOT_MAX_HOLD, 1);
        }
      }
      this.powerWraps[i].classList.toggle('show', frac >= 0);
      if (frac >= 0) this.powerFills[i].style.width = `${frac * 100}%`;
    }

    // nameplates over each controlled player
    const inAction = m.phase === 'play' || m.phase === 'restart' || m.phase === 'kickoff';
    for (let i = 0; i < SEAT_SLOTS; i++) {
      const ctrl = m.controlled[i];
      const np = this.nameplates[i];
      const seat = m.seats[i];
      if (ctrl && seat && inAction && !ctrl.sentOff) {
        const sp = screenPos(ctrl.pos.x, ctrl.pos.y, 2.6);
        if (sp.visible) {
          np.style.display = 'block';
          np.style.left = `${sp.x}%`;
          np.style.top = `${sp.y}%`;
          // off-ball mode tag: the defending player's input IS doing something —
          // say so right on the nameplate
          let mode = '';
          if (m.ball.owner !== ctrl) {
            if (ctrl.actionAnim === 'slide') mode = 'SLIDE!';
            else if (seat.isHeld('pass')) mode = 'CHASING';
            else if (m.ball.owner && m.ball.owner.teamIdx !== i) mode = 'DEFEND';
          }
          // a struggling remote guest gets a pip right on their own nameplate
          const net = this.netSeat[i];
          const pip = net === 'ok' ? '' : `<span class="np-pip ${net}"></span>`;
          const label = `${ctrl.data.num} ${ctrl.data.name.split(' ').pop()?.toUpperCase()}` +
            (mode ? ` <span class="np-mode">· ${mode}</span>` : '') + pip;
          if (np.innerHTML !== label) np.innerHTML = label;
        } else {
          np.style.display = 'none';
        }
      } else {
        np.style.display = 'none';
      }
    }

    this.updatePenaltyUI(screenPos);

    // controls card: persistent hint that swaps to the defensive controls
    // when the other side has the ball (1P only), and dims rather than hides
    if (this.controlsMode !== 'off') {
      if (this.controlsDefense && this.soloSeat >= 0 && inAction) {
        const owner = m.ball.owner;
        const possession = owner ? owner.teamIdx : m.possessionTeam;
        const want = possession !== this.soloSeat ? this.controlsDefense : this.controlsAttack;
        if (this.controlsCard.textContent !== want) {
          this.controlsCard.textContent = want;
          this.controlsBright = 4; // resurface the relevant hint briefly
        }
      }
      if (this.controlsMode === 'fade') {
        if (this.controlsTimer > 0) this.controlsTimer -= dt;
        if (this.controlsBright > 0) this.controlsBright -= dt;
        this.controlsCard.classList.toggle('dim',
          this.controlsTimer <= 0 && this.controlsBright <= 0);
      }
    }
    // the reconnect banner ticks on real time: dt is 0 while the match is held
    if (this.netFlashTimer > 0) {
      this.netFlashTimer -= dt;
      if (this.netFlashTimer <= 0) this.paintNetToast();
    }
  }

  private updatePenaltyUI(screenPos: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }): void {
    const m = this.match;
    const pen = m.penalty;
    const active = pen && (m.phase === 'penalty' || m.phase === 'shootout');

    // reticle: only for a human taker while aiming; fades with difficulty (§6.5)
    const showReticle = active && pen!.phase === 'aim' && m.primarySeat(pen!.kickingTeam) !== null;
    if (showReticle) {
      const gx = HALF_L * pen!.goalSide;
      const aimY = pen!.aimX * (GOAL_HALF_W - 0.25);
      const sp = screenPos(gx, aimY, 1.15);
      this.reticle.style.display = sp.visible ? 'block' : 'none';
      this.reticle.style.left = `${sp.x}%`;
      this.reticle.style.top = `${sp.y}%`;
      const op = m.difficulty.cpuNoise > 1.3 ? 0.9 : m.difficulty.cpuNoise > 0.8 ? 0.55 : 0.25;
      this.reticle.style.opacity = String(op);
    } else {
      this.reticle.style.display = 'none';
    }

    // hint line
    if (active && pen!.phase === 'aim') {
      const takerHuman = m.primarySeat(pen!.kickingTeam) !== null;
      const keeperHuman = m.primarySeat(1 - pen!.kickingTeam) !== null;
      this.penHint.style.display = 'block';
      this.penHint.textContent = takerHuman && keeperHuman
        ? 'TAKER: AIM ◀ ▶, HOLD SHOOT · KEEPER: PICK A SIDE AS THEY STRIKE'
        : takerHuman ? 'AIM ◀ ▶ · HOLD SHOOT FOR POWER, RELEASE TO STRIKE'
        : keeperHuman ? 'PICK A DIVE: HOLD ◀ OR ▶ AS THEY STRIKE' : '';
    } else {
      this.penHint.style.display = 'none';
    }

    // shootout board
    if (m.phase === 'shootout' && pen?.board) {
      const b = pen.board;
      const row = (idx: number): string => {
        const dots: string[] = [];
        const n = Math.max(5, b.kicks[0].length, b.kicks[1].length);
        for (let k = 0; k < n; k++) {
          const r = b.kicks[idx][k];
          dots.push(`<span class="pen-dot ${r ?? ''}"></span>`);
        }
        const t = m.teams[idx].data;
        return `<div class="pen-row">
          <span class="pen-code" style="color:${this.shirts[idx]}">${t.code}</span>
          <span class="pen-score">${b.scores[idx]}</span>${dots.join('')}
        </div>`;
      };
      this.penBoard.style.display = 'block';
      this.penBoard.innerHTML = row(0) + row(1)
        + (b.suddenDeath ? '<div class="pen-sd">SUDDEN DEATH</div>' : '');
    } else {
      this.penBoard.style.display = 'none';
    }
  }

  destroy(): void {
    // the package first: it clears the root classes it owns, then the HUD's own
    // markup goes. Quitting mid-replay used to leave `replay-on` stuck on the
    // shared root and the next match played letterboxed with a blinking bug.
    this.bc.destroy();
    this.root.innerHTML = '';
    this.root.classList.remove('replay-on');
  }
}
