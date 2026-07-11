// Menu flow (§2 zero friction): title → pick teams → match settings → kickoff.
// Keyboard (WASD/arrows + J confirm / K back) and mouse both work.

import { TEAMS, teamRating } from '../data/loader';
import type { TeamData } from '../data/types';
import type { DifficultyName } from '../sim/match';
import type { TimeOfDay } from '../render/scene';

export interface MatchSetup {
  home: TeamData;
  away: TeamData;
  halfLengthSec: number;
  difficulty: DifficultyName;
  timeOfDay: TimeOfDay;
}

type Screen = 'title' | 'pickHome' | 'pickAway' | 'settings';

const HALF_OPTIONS: [string, number][] = [['4 MIN', 120], ['6 MIN', 180], ['10 MIN', 300]];
const DIFF_OPTIONS: DifficultyName[] = ['amateur', 'pro', 'legend'];
const TOD_OPTIONS: TimeOfDay[] = ['night', 'sunset', 'day'];

export class Menu {
  private root: HTMLElement;
  private screen: Screen = 'title';
  private focus = 0;
  private home: TeamData | null = null;
  private away: TeamData | null = null;
  private halfIdx = 1;
  private diffIdx = 1;
  private todIdx = 0;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(private onStart: (setup: MatchSetup) => void) {
    this.root = document.getElementById('ui-root')!;
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    this.render();
  }

  private sortedTeams(): TeamData[] {
    return [...TEAMS].sort((a, b) => a.name.localeCompare(b.name));
  }

  private onKey(e: KeyboardEvent): void {
    const cols = 6;
    const nav = (dx: number, dy: number, count: number): void => {
      this.focus = Math.max(0, Math.min(count - 1, this.focus + dx + dy * cols));
      this.render();
    };
    const code = e.code;
    if (this.screen === 'title') {
      this.screen = 'pickHome';
      this.focus = this.sortedTeams().findIndex((t) => t.id === 'bra');
      if (this.focus < 0) this.focus = 0;
      this.render();
      return;
    }
    const confirm = code === 'KeyJ' || code === 'Enter' || code === 'Space';
    const back = code === 'KeyK' || code === 'Escape' || code === 'Backspace';

    if (this.screen === 'pickHome' || this.screen === 'pickAway') {
      const n = TEAMS.length;
      if (code === 'KeyA' || code === 'ArrowLeft') nav(-1, 0, n);
      else if (code === 'KeyD' || code === 'ArrowRight') nav(1, 0, n);
      else if (code === 'KeyW' || code === 'ArrowUp') nav(0, -1, n);
      else if (code === 'KeyS' || code === 'ArrowDown') nav(0, 1, n);
      else if (confirm) this.pick(this.sortedTeams()[this.focus]);
      else if (back && this.screen === 'pickAway') {
        this.screen = 'pickHome';
        this.home = null;
        this.render();
      }
    } else if (this.screen === 'settings') {
      const rows = 4;
      if (code === 'KeyW' || code === 'ArrowUp') { this.focus = Math.max(0, this.focus - 1); this.render(); }
      else if (code === 'KeyS' || code === 'ArrowDown') { this.focus = Math.min(rows - 1, this.focus + 1); this.render(); }
      else if (code === 'KeyA' || code === 'ArrowLeft' || code === 'KeyD' || code === 'ArrowRight') {
        const d = (code === 'KeyA' || code === 'ArrowLeft') ? -1 : 1;
        this.cycleSetting(this.focus, d);
        this.render();
      } else if (confirm) {
        if (this.focus === 3) this.launch();
        else { this.cycleSetting(this.focus, 1); this.render(); }
      } else if (back) {
        this.screen = 'pickAway';
        this.away = null;
        this.render();
      }
    }
  }

  private cycleSetting(row: number, d: number): void {
    if (row === 0) this.halfIdx = (this.halfIdx + d + HALF_OPTIONS.length) % HALF_OPTIONS.length;
    if (row === 1) this.diffIdx = (this.diffIdx + d + DIFF_OPTIONS.length) % DIFF_OPTIONS.length;
    if (row === 2) this.todIdx = (this.todIdx + d + TOD_OPTIONS.length) % TOD_OPTIONS.length;
  }

  private pick(team: TeamData): void {
    if (this.screen === 'pickHome') {
      this.home = team;
      this.screen = 'pickAway';
      this.focus = this.sortedTeams().findIndex((t) => t.id !== team.id);
      this.render();
    } else {
      if (this.home && team.id === this.home.id) return; // can't play yourself
      this.away = team;
      this.screen = 'settings';
      this.focus = 3;
      this.render();
    }
  }

  private launch(): void {
    if (!this.home || !this.away) return;
    window.removeEventListener('keydown', this.keyHandler);
    this.root.innerHTML = '';
    this.onStart({
      home: this.home,
      away: this.away,
      halfLengthSec: HALF_OPTIONS[this.halfIdx][1],
      difficulty: DIFF_OPTIONS[this.diffIdx],
      timeOfDay: TOD_OPTIONS[this.todIdx],
    });
  }

  private render(): void {
    switch (this.screen) {
      case 'title':
        this.root.innerHTML = `
          <div class="menu-screen">
            <h1 class="menu-title">SUPER STRIKER '26</h1>
            <div class="menu-sub">THE PEOPLE'S FOOTBALL</div>
            <div class="menu-hint">PRESS ANY KEY</div>
            <div class="controls-card">RUNS LOCALLY · 60FPS · 0 MICROTRANSACTIONS · NO PHONE REQUIRED</div>
          </div>`;
        break;
      case 'pickHome':
      case 'pickAway':
        this.renderTeamPick();
        break;
      case 'settings':
        this.renderSettings();
        break;
    }
  }

  private renderTeamPick(): void {
    const picking = this.screen === 'pickHome' ? 'PICK YOUR TEAM' : 'PICK YOUR OPPONENT';
    const teams = this.sortedTeams();
    const cells = teams.map((t, i) => {
      const stars = '★'.repeat(Math.max(1, Math.min(5, t.tier))); // tier 5 = elite
      const focused = i === this.focus ? ' focus' : '';
      const taken = this.home && t.id === this.home.id ? ' style="opacity:0.35"' : '';
      return `<div class="team-cell${focused}" data-idx="${i}"${taken}>
        <div class="swatch" style="background:${t.kit.home}"></div>
        <span>${t.name}</span><span class="tier">${stars}</span>
      </div>`;
    }).join('');
    const picked = this.home ? `<div class="vs-strip">
        <div class="slot"><div class="swatch" style="background:${this.home.kit.home};width:16px;height:16px;border-radius:3px"></div>${this.home.name}</div>
        <div class="vs">VS</div>
        <div class="slot" style="opacity:0.5">?</div>
      </div>` : '';
    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">${picking}</div>
        ${picked}
        <div class="team-grid">${cells}</div>
        <div class="controls-card">WASD MOVE · J SELECT${this.screen === 'pickAway' ? ' · K BACK' : ''}</div>
      </div>`;
    this.root.querySelectorAll('.team-cell').forEach((el) => {
      el.addEventListener('click', () => {
        this.focus = Number((el as HTMLElement).dataset.idx);
        this.pick(this.sortedTeams()[this.focus]);
      });
      el.addEventListener('mouseenter', () => {
        this.focus = Number((el as HTMLElement).dataset.idx);
        this.root.querySelectorAll('.team-cell').forEach((c) => c.classList.remove('focus'));
        el.classList.add('focus');
      });
    });
    // keep focused cell in view
    const focusedEl = this.root.querySelector('.team-cell.focus');
    focusedEl?.scrollIntoView({ block: 'nearest' });
  }

  private renderSettings(): void {
    const rows = [
      ['MATCH LENGTH', HALF_OPTIONS[this.halfIdx][0]],
      ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
      ['KICK-OFF', TOD_OPTIONS[this.todIdx].toUpperCase()],
    ];
    const rowsHtml = rows.map(([k, v], i) =>
      `<div class="setting-row${i === this.focus ? ' focus' : ''}" data-row="${i}">
        <span>${k}</span><span class="value">◀ ${v} ▶</span>
      </div>`).join('');
    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">MATCH SETTINGS</div>
        <div class="vs-strip">
          <div class="slot"><div class="swatch" style="background:${this.home!.kit.home};width:16px;height:16px;border-radius:3px"></div>${this.home!.name} <small>(${Math.round(teamRating(this.home!))})</small></div>
          <div class="vs">VS</div>
          <div class="slot"><div class="swatch" style="background:${this.away!.kit.home};width:16px;height:16px;border-radius:3px"></div>${this.away!.name} <small>(${Math.round(teamRating(this.away!))})</small></div>
        </div>
        <div class="settings-list">
          ${rowsHtml}
          <div class="setting-row go${this.focus === 3 ? ' focus' : ''}" data-row="3">KICK OFF!</div>
        </div>
        <div class="controls-card">W/S SELECT · A/D CHANGE · J CONFIRM · K BACK</div>
      </div>`;
    this.root.querySelectorAll('.setting-row').forEach((el) => {
      el.addEventListener('click', () => {
        const row = Number((el as HTMLElement).dataset.row);
        if (row === 3) this.launch();
        else { this.focus = row; this.cycleSetting(row, 1); this.renderSettings(); }
      });
    });
  }
}
