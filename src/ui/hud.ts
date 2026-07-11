// Match HUD: score bug, clock, ticker (the always-correct commentator, §7.3),
// power bar, nameplate, replay dressing, goal banner, halftime/fulltime cards.

import type { Match } from '../sim/match';
import type { MatchEvent } from '../sim/matchEvents';
import type { InputSystem } from '../input/input';
import { SHOT_MAX_HOLD } from '../sim/constants';

export class HUD {
  private root: HTMLElement;
  private bugScore!: HTMLElement;
  private bugClock!: HTMLElement;
  private ticker!: HTMLElement;
  private tickerQueue: string[] = [];
  private tickerBusy = false;
  private powerWrap!: HTMLElement;
  private powerFill!: HTMLElement;
  private nameplate!: HTMLElement;
  private goalBanner!: HTMLElement;
  private card!: HTMLElement;
  private wipe!: HTMLElement;
  private controlsCard!: HTMLElement;
  private controlsTimer = 14;

  constructor(private match: Match, private input: InputSystem) {
    this.root = document.getElementById('ui-root')!;
    this.build();
  }

  private build(): void {
    const [home, away] = this.match.teams;
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
      <div class="power-wrap"><div class="power-fill"></div></div>
      <div class="nameplate"></div>
      <div class="goal-banner">GOAL!</div>
      <div class="match-card"></div>
      <div class="controls-card">MOVE WASD &nbsp;·&nbsp; PASS J &nbsp;·&nbsp; LOFT K &nbsp;·&nbsp; SHOOT L (hold) &nbsp;·&nbsp; THROUGH I &nbsp;·&nbsp; SPRINT SHIFT &nbsp;·&nbsp; SWITCH SPACE</div>
      <div class="wipe"></div>
    `;
    this.bugScore = this.root.querySelector('.score')!;
    this.bugClock = this.root.querySelector('.clock')!;
    this.ticker = this.root.querySelector('.ticker')!;
    this.powerWrap = this.root.querySelector('.power-wrap')!;
    this.powerFill = this.root.querySelector('.power-fill')!;
    this.nameplate = this.root.querySelector('.nameplate')!;
    this.goalBanner = this.root.querySelector('.goal-banner')!;
    this.card = this.root.querySelector('.match-card')!;
    this.wipe = this.root.querySelector('.wipe')!;
    this.controlsCard = this.root.querySelector('.controls-card')!;
  }

  setReplay(on: boolean): void {
    this.root.classList.toggle('replay-on', on);
  }

  playWipe(): void {
    this.wipe.classList.remove('go');
    void this.wipe.offsetWidth; // restart the animation
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
        this.pushTicker(`${e.minute}' — GOOOAL! ${e.scorerName} scores for ${teamName(e.teamIdx)}!`);
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
      case 'kickoff':
        if (e.half === 2) this.pushTicker(`Second half under way!`);
        break;
      case 'halftime':
        this.showCard('HALF-TIME');
        break;
      case 'fulltime':
        this.showCard('FULL-TIME');
        break;
      default:
        break;
    }
  }

  private showCard(title: string): void {
    const [h, a] = this.match.teams;
    const total = Math.max(h.possessionTicks + a.possessionTicks, 1);
    const hp = Math.round((h.possessionTicks / total) * 100);
    const hint = title === 'FULL-TIME' ? 'PRESS J FOR REMATCH · K FOR MENU' : 'PRESS J TO CONTINUE';
    this.card.innerHTML = `
      <h1>${title}</h1>
      <div class="scoreline">
        <span style="color:${h.data.kit.home}">■</span> ${h.data.name}
        ${h.score} - ${a.score}
        ${a.data.name} <span style="color:${a.data.kit.home}">■</span>
      </div>
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

  get cardVisible(): boolean {
    return this.card.classList.contains('show');
  }

  /** Per-frame HUD refresh. screenPos comes from the renderer. */
  update(dt: number, screenPos: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }): void {
    const m = this.match;
    this.bugScore.textContent = `${m.teams[0].score} - ${m.teams[1].score}`;
    this.bugClock.textContent = `${m.displayMinute()}'`;

    // shot power bar
    const charging = m.humanTeamIdx !== null && this.input.isHeld('shoot')
      && m.ball.owner === m.controlled && m.controlled !== null;
    this.powerWrap.classList.toggle('show', !!charging);
    if (charging) {
      const p = Math.min(this.input.heldDuration('shoot') / SHOT_MAX_HOLD, 1);
      this.powerFill.style.width = `${p * 100}%`;
    }

    // nameplate under the controlled player
    const ctrl = m.controlled;
    const inAction = m.phase === 'play' || m.phase === 'restart' || m.phase === 'kickoff';
    if (ctrl && inAction) {
      const sp = screenPos(ctrl.pos.x, ctrl.pos.y, 2.6);
      if (sp.visible) {
        this.nameplate.style.display = 'block';
        this.nameplate.style.left = `${sp.x}%`;
        this.nameplate.style.top = `${sp.y}%`;
        this.nameplate.textContent = `${ctrl.data.num} ${ctrl.data.name.split(' ').pop()?.toUpperCase()}`;
      } else {
        this.nameplate.style.display = 'none';
      }
    } else {
      this.nameplate.style.display = 'none';
    }

    // fade the controls reminder after a while
    if (this.controlsTimer > 0) {
      this.controlsTimer -= dt;
      if (this.controlsTimer <= 0) this.controlsCard.style.display = 'none';
    }
  }

  destroy(): void {
    this.root.innerHTML = '';
  }
}
