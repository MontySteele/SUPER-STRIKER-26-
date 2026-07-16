// Match HUD: score bug, clock, ticker (the always-correct commentator, §7.3),
// power bars (one per seat), penalty reticle + shootout board, card banners,
// replay dressing, goal banner, break/fulltime cards.

import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import { GOAL_HALF_W, HALF_L, SHOT_MAX_HOLD } from '../sim/constants';
import { overall } from '../data/loader';
import { esc } from './escape';
import { resolvedShirts } from '../render/playerMesh';
import type { TeamData } from '../data/types';

/** One line of the match story shown on break/full-time cards. */
interface StoryEntry {
  minute: number;
  teamIdx: number;
  icon: 'goal' | 'og' | 'yellow' | 'red';
  name: string;
}

export class HUD {
  private root: HTMLElement;
  private bugScore!: HTMLElement;
  private bugClock!: HTMLElement;
  private ticker!: HTMLElement;
  private tickerQueue: string[] = [];
  private tickerBusy = false;
  private powerWraps: HTMLElement[] = [];
  private powerFills: HTMLElement[] = [];
  private nameplates: HTMLElement[] = [];
  private goalBanner!: HTMLElement;
  private cardFlash!: HTMLElement;
  private card!: HTMLElement;
  private wipe!: HTMLElement;
  private controlsCard!: HTMLElement;
  private reticle!: HTMLElement;
  private penBoard!: HTMLElement;
  private penHint!: HTMLElement;
  private replayBug!: HTMLElement;
  private prematch!: HTMLElement;
  private controlsTimer = 14;
  private prematchTimer = 8;
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
    const [home, away] = this.match.teams;
    const seats = this.match.seats;
    const twoP = seats[0] !== null && seats[1] !== null;
    const dev = (i: number): string => (seats[i]?.kind === 'pad' ? 'GAMEPAD' : 'KEYBOARD');
    this.root.innerHTML = `
      <div class="letterbox-top"></div>
      <div class="letterbox-bot"></div>
      <div class="replay-bug">REPLAY</div>
      <div class="score-bug">
        <div class="chip" style="background:${this.shirts[0]}"></div>
        <div class="team">${home.data.code}</div>
        <div class="score">0 - 0</div>
        <div class="team">${away.data.code}</div>
        <div class="chip" style="background:${this.shirts[1]}"></div>
        <div class="clock">0'</div>
      </div>
      <div class="ticker"></div>
      <div class="power-wrap p1"><div class="power-fill"></div></div>
      <div class="power-wrap p2"><div class="power-fill"></div></div>
      <div class="nameplate np1"></div>
      <div class="nameplate np2"></div>
      <div class="goal-banner">GOAL!</div>
      <div class="card-flash"></div>
      <div class="reticle"></div>
      <div class="pen-board"></div>
      <div class="pen-hint"></div>
      <div class="match-card"></div>
      <div class="prematch">${this.prematchHtml()}</div>
      <div class="controls-card">${twoP
        ? `P1 ${dev(0)} · P2 ${dev(1)} — PASS J/A · LOFT K/B · SHOOT L/X (hold) · THROUGH I/Y · SPRINT SHIFT/RT · REPLAY R/BACK · PAUSE ESC/START`
        : 'MOVE WASD · PASS J · LOFT K · SHOOT L (hold) · THROUGH I · SPRINT SHIFT · SWITCH SPACE · REPLAY R · PAUSE ESC'}</div>
      <div class="wipe"></div>
    `;
    this.bugScore = this.root.querySelector('.score')!;
    this.bugClock = this.root.querySelector('.clock')!;
    this.ticker = this.root.querySelector('.ticker')!;
    this.powerWraps = [...this.root.querySelectorAll<HTMLElement>('.power-wrap')];
    this.powerFills = [...this.root.querySelectorAll<HTMLElement>('.power-fill')];
    this.nameplates = [...this.root.querySelectorAll<HTMLElement>('.nameplate')];
    this.goalBanner = this.root.querySelector('.goal-banner')!;
    this.cardFlash = this.root.querySelector('.card-flash')!;
    this.card = this.root.querySelector('.match-card')!;
    this.wipe = this.root.querySelector('.wipe')!;
    this.controlsCard = this.root.querySelector('.controls-card')!;
    this.reticle = this.root.querySelector('.reticle')!;
    this.penBoard = this.root.querySelector('.pen-board')!;
    this.penHint = this.root.querySelector('.pen-hint')!;
    this.replayBug = this.root.querySelector('.replay-bug')!;
    this.prematch = this.root.querySelector('.prematch')!;
    if (this.match.mode === 'shootout') this.prematchTimer = 0;
    this.prematch.classList.toggle('show', this.prematchTimer > 0);
  }

  /** Pre-match tactics strip: styles + star men, the data made visible. */
  private prematchHtml(): string {
    const side = (t: TeamData): string => {
      const idx = t === this.match.teams[0].data ? 0 : 1;
      const star = this.match.teams[idx].players
        .map((p) => p.data)
        .reduce((a, b) => (b.star || (!a.star && overall(b) > overall(a)) ? b : a));
      return `<div class="pm-side">
        <div class="pm-team" style="border-color:${this.shirts[idx]}">${t.name.toUpperCase()}</div>
        <div class="pm-info">${t.style.toUpperCase()} · ${t.formation} · ★ ${esc(star.name.split(' ').pop()?.toUpperCase() ?? '')}</div>
      </div>`;
    };
    const mid = this.match.mode === 'golden'
      ? '<div class="pm-vs golden">NEXT GOAL WINS</div>'
      : '<div class="pm-vs">TACTICS</div>';
    return side(this.match.teams[0].data) + mid + side(this.match.teams[1].data);
  }

  setReplay(on: boolean, label = 'REPLAY'): void {
    this.root.classList.toggle('replay-on', on);
    if (on) this.replayBug.textContent = label;
  }

  playWipe(): void {
    this.wipe.classList.remove('go');
    void this.wipe.offsetWidth;
    this.wipe.classList.add('go');
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
    switch (e.type) {
      case 'goal': {
        this.goalBanner.classList.remove('show');
        void this.goalBanner.offsetWidth;
        this.goalBanner.classList.add('show');
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
        this.pushTicker(`WHAT A SAVE! ${e.keeperName} denies them!`);
        this.creditMotm(e.teamIdx, e.keeperName, 1.5, e.keeperNum);
        break;
      case 'post':
        this.pushTicker(`OFF THE WOODWORK! The frame says no.`);
        break;
      case 'corner':
        this.corners[e.teamIdx]++;
        this.pushTicker(`${e.minute}' — Corner to ${teamName(e.teamIdx)}.`);
        this.playWipe();
        break;
      case 'throwIn':
      case 'goalKick':
        this.playWipe();
        break;
      case 'offside':
        this.pushTicker(`${e.minute}' — Flag's up! ${e.playerName} strayed offside.`);
        this.playWipe();
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
        this.playWipe();
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
    return `<div class="motm">★ MAN OF THE MATCH — <span style="color:${this.shirts[best.teamIdx]}">■</span> ${surname} (${code})</div>`;
  }

  private flashCard(color: 'yellow' | 'red'): void {
    this.cardFlash.className = `card-flash show ${color}`;
    setTimeout(() => this.cardFlash.classList.remove('show'), 1600);
  }

  private showCard(title: string): void {
    const [h, a] = this.match.teams;
    const total = h.possessionTicks + a.possessionTicks;
    // no open play at all (shootout mode) reads 50/50, not 0%–100%
    const hp = total ? Math.round((h.possessionTicks / total) * 100) : 50;
    const isFT = title === 'FULL-TIME';
    let hint = isFT
      ? (this.fulltimeHint ?? 'PRESS J FOR REMATCH · K FOR MENU')
      : title === 'PENALTIES' ? 'PRESS J FOR THE SHOOTOUT' : 'PRESS J TO CONTINUE';
    if (isFT && this.canReplayGoal?.()) hint += ' · L WATCH THE GOAL';
    const board = this.match.penalty?.board;
    const pens = board && this.match.shootoutWinner !== null
      ? `<div style="font-size:16px;color:#ffce4a;font-weight:800;margin-top:-8px;margin-bottom:10px">
          ${this.match.teams[this.match.shootoutWinner].data.name.toUpperCase()} WIN ${board.scores[0]}–${board.scores[1]} ON PENALTIES</div>`
      : '';
    this.prematchTimer = 0;
    this.prematch.classList.remove('show');
    this.card.innerHTML = `
      <h1>${isFT && this.match.mode === 'golden' ? 'GOLDEN GOAL!' : title}</h1>
      <div class="scoreline">
        <span style="color:${this.shirts[0]}">■</span> ${h.data.name}
        ${h.score} - ${a.score}
        ${a.data.name} <span style="color:${this.shirts[1]}">■</span>
      </div>
      ${pens}
      ${isFT ? this.motmHtml() : ''}
      ${this.storyHtml()}
      <table>
        <tr><td class="val">${hp}%</td><td class="stat">POSSESSION</td><td class="val">${100 - hp}%</td></tr>
        <tr><td class="val">${h.shots}</td><td class="stat">SHOTS</td><td class="val">${a.shots}</td></tr>
        <tr><td class="val">${h.shotsOnTarget}</td><td class="stat">ON TARGET</td><td class="val">${a.shotsOnTarget}</td></tr>
        <tr><td class="val">${this.corners[0]}</td><td class="stat">CORNERS</td><td class="val">${this.corners[1]}</td></tr>
        <tr><td class="val">${this.fouls[0]}</td><td class="stat">FOULS</td><td class="val">${this.fouls[1]}</td></tr>
      </table>
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
    const [h, a] = this.match.teams;
    this.card.innerHTML = `
      <h1>PAUSED</h1>
      <div class="scoreline">
        <span style="color:${this.shirts[0]}">■</span> ${h.data.name}
        ${h.score} - ${a.score}
        ${a.data.name} <span style="color:${this.shirts[1]}">■</span>
      </div>
      <div class="hint">PRESS J TO RESUME · K TO QUIT</div>
    `;
    this.card.classList.add('show');
  }

  /** Per-frame HUD refresh. screenPos comes from the renderer. */
  update(dt: number, screenPos: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }): void {
    const m = this.match;
    this.bugScore.textContent = `${m.teams[0].score} - ${m.teams[1].score}`;
    const inPens = m.phase === 'shootout' || m.phase === 'penalty';
    this.bugClock.textContent = m.phase === 'shootout' ? 'PENS' : `${m.displayMinute()}'`;

    // shot power bars, one per seat (penalties charge through the same bar)
    for (let i = 0; i < 2; i++) {
      const seat = m.seats[i];
      let frac = -1;
      if (seat) {
        const pen = m.penalty;
        if (inPens && pen && pen.kickingTeam === i && pen.phase === 'aim' && pen.charging) {
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
    for (let i = 0; i < 2; i++) {
      const ctrl = m.controlled[i];
      const np = this.nameplates[i];
      if (ctrl && m.seats[i] && inAction && !ctrl.sentOff) {
        const sp = screenPos(ctrl.pos.x, ctrl.pos.y, 2.6);
        if (sp.visible) {
          np.style.display = 'block';
          np.style.left = `${sp.x}%`;
          np.style.top = `${sp.y}%`;
          np.textContent = `${ctrl.data.num} ${ctrl.data.name.split(' ').pop()?.toUpperCase()}`;
        } else {
          np.style.display = 'none';
        }
      } else {
        np.style.display = 'none';
      }
    }

    this.updatePenaltyUI(screenPos);

    if (this.controlsTimer > 0) {
      this.controlsTimer -= dt;
      if (this.controlsTimer <= 0) this.controlsCard.style.display = 'none';
    }
    if (this.prematchTimer > 0) {
      this.prematchTimer -= dt;
      if (this.prematchTimer <= 0) this.prematch.classList.remove('show');
    }
  }

  private updatePenaltyUI(screenPos: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }): void {
    const m = this.match;
    const pen = m.penalty;
    const active = pen && (m.phase === 'penalty' || m.phase === 'shootout');

    // reticle: only for a human taker while aiming; fades with difficulty (§6.5)
    const showReticle = active && pen!.phase === 'aim' && m.seats[pen!.kickingTeam] !== null;
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
      const takerHuman = m.seats[pen!.kickingTeam] !== null;
      const keeperHuman = m.seats[1 - pen!.kickingTeam] !== null;
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
    this.root.innerHTML = '';
    // quitting mid-replay left this stuck on the shared root: the next match
    // played letterboxed with a blinking REPLAY bug and no nameplates
    this.root.classList.remove('replay-on');
  }
}
