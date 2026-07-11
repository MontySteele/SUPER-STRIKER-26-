// Match HUD: score bug, clock, ticker (the always-correct commentator, §7.3),
// power bars (one per seat), penalty reticle + shootout board, card banners,
// replay dressing, goal banner, break/fulltime cards.

import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import { GOAL_HALF_W, HALF_L, SHOT_MAX_HOLD } from '../sim/constants';

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
  private controlsTimer = 14;
  /** Overrides the full-time prompt (tournament mode: J and K both continue). */
  fulltimeHint: string | null = null;

  constructor(private match: Match) {
    this.root = document.getElementById('ui-root')!;
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
        <div class="chip" style="background:${home.data.kit.home}"></div>
        <div class="team">${home.data.code}</div>
        <div class="score">0 - 0</div>
        <div class="team">${away.data.code}</div>
        <div class="chip" style="background:${away.data.kit.home}"></div>
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
      <div class="controls-card">${twoP
        ? `P1 ${dev(0)} · P2 ${dev(1)} — PASS J/A · LOFT K/B · SHOOT L/X (hold) · THROUGH I/Y · SPRINT SHIFT/RT · PAUSE ESC/START`
        : 'MOVE WASD · PASS J · LOFT K · SHOOT L (hold) · THROUGH I · SPRINT SHIFT · SWITCH SPACE · PAUSE ESC'}</div>
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
  }

  setReplay(on: boolean): void {
    this.root.classList.toggle('replay-on', on);
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
        break;
      }
      case 'miss':
        this.pushTicker(`${e.minute}' — CLOSE! ${e.shooterName} drags it wide.`);
        break;
      case 'save':
        this.pushTicker(`WHAT A SAVE! ${e.keeperName} denies them!`);
        break;
      case 'post':
        this.pushTicker(`OFF THE WOODWORK! The frame says no.`);
        break;
      case 'corner':
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
        this.pushTicker(`${e.minute}' — Foul by ${e.playerName}.`);
        break;
      case 'card': {
        this.flashCard(e.color);
        this.pushTicker(e.color === 'red'
          ? `${e.minute}' — RED CARD! ${e.playerName} is OFF!`
          : `${e.minute}' — Yellow card for ${e.playerName}.`);
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

  private flashCard(color: 'yellow' | 'red'): void {
    this.cardFlash.className = `card-flash show ${color}`;
    setTimeout(() => this.cardFlash.classList.remove('show'), 1600);
  }

  private showCard(title: string): void {
    const [h, a] = this.match.teams;
    const total = Math.max(h.possessionTicks + a.possessionTicks, 1);
    const hp = Math.round((h.possessionTicks / total) * 100);
    const isFT = title === 'FULL-TIME';
    const hint = isFT
      ? (this.fulltimeHint ?? 'PRESS J FOR REMATCH · K FOR MENU')
      : title === 'PENALTIES' ? 'PRESS J FOR THE SHOOTOUT' : 'PRESS J TO CONTINUE';
    const board = this.match.penalty?.board;
    const pens = board && this.match.shootoutWinner !== null
      ? `<div style="font-size:16px;color:#ffce4a;font-weight:800;margin-top:-8px;margin-bottom:10px">
          ${this.match.teams[this.match.shootoutWinner].data.name.toUpperCase()} WIN ${board.scores[0]}–${board.scores[1]} ON PENALTIES</div>`
      : '';
    this.card.innerHTML = `
      <h1>${title}</h1>
      <div class="scoreline">
        <span style="color:${h.data.kit.home}">■</span> ${h.data.name}
        ${h.score} - ${a.score}
        ${a.data.name} <span style="color:${a.data.kit.home}">■</span>
      </div>
      ${pens}
      <table>
        <tr><td class="val">${hp}%</td><td class="stat">POSSESSION</td><td class="val">${100 - hp}%</td></tr>
        <tr><td class="val">${h.shots}</td><td class="stat">SHOTS</td><td class="val">${a.shots}</td></tr>
        <tr><td class="val">${h.shotsOnTarget}</td><td class="stat">ON TARGET</td><td class="val">${a.shotsOnTarget}</td></tr>
      </table>
      <div class="hint">${hint}</div>
    `;
    this.card.classList.add('show');
  }

  hideCard(): void {
    this.card.classList.remove('show');
  }

  showPauseCard(): void {
    const [h, a] = this.match.teams;
    this.card.innerHTML = `
      <h1>PAUSED</h1>
      <div class="scoreline">
        <span style="color:${h.data.kit.home}">■</span> ${h.data.name}
        ${h.score} - ${a.score}
        ${a.data.name} <span style="color:${a.data.kit.home}">■</span>
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
          frac = Math.min(seat.heldDuration('shoot') / 0.9, 1);
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
          <span class="pen-code" style="color:${t.kit.home}">${t.code}</span>
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
  }
}
