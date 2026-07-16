// Menu flow (§2 zero friction): title → mode → teams → settings → kickoff.
// Keyboard (WASD/arrows + J confirm / K back) and mouse both work.

import { TEAMS, teamRating } from '../data/loader';
import type { TeamData } from '../data/types';
import type { DifficultyName } from '../sim/match';
import type { TimeOfDay } from '../render/scene';
import type { StadiumSize } from '../render/stadium';
import { Tournament } from '../sim/tournament';
import { COMMENTARY_KEY, commentaryEnabled } from '../audio/commentary';
import { MUSIC_KEY, musicSetting, type MusicSetting } from '../audio/music';

const MUSIC_OPTIONS: [MusicSetting, string][] = [
  ['all', 'ON'], ['menus', 'MENUS ONLY'], ['off', 'OFF'],
];

export type GameMode = 'kickoff' | 'versus' | 'shootout' | 'golden';

export type MenuResult =
  | {
      kind: GameMode;
      home: TeamData; away: TeamData;
      halfLengthSec: number; difficulty: DifficultyName;
      timeOfDay: TimeOfDay; stadium: StadiumSize;
      /** golden goal only: 2P couch play is opt-in via the PLAYERS setting */
      golden2p?: boolean;
    }
  | { kind: 'tournament-new'; teamId: string; difficulty: DifficultyName; halfLengthSec: number }
  | { kind: 'tournament-continue' }
  | { kind: 'editor' };

type Screen = 'title' | 'mode' | 'pickHome' | 'pickAway' | 'settings';

const HALF_OPTIONS: [string, number][] = [['4 MIN', 120], ['6 MIN', 180], ['10 MIN', 300]];
const DIFF_OPTIONS: DifficultyName[] = ['amateur', 'pro', 'legend'];
const TOD_OPTIONS: TimeOfDay[] = ['night', 'sunset', 'day'];
const STADIUM_OPTIONS: [string, StadiumSize][] = [
  ['NATIONAL 45K', 'national'], ['MEGA BOWL 80K', 'mega'], ['MUNICIPAL 18K', 'municipal'],
];

export class Menu {
  private root: HTMLElement;
  private screen: Screen = 'title';
  private focus = 0;
  private mode: GameMode | 'tournament' = 'kickoff';
  private home: TeamData | null = null;
  private away: TeamData | null = null;
  private halfIdx = 1;
  private diffIdx = 1;
  private todIdx = 0;
  private stadiumIdx = 0;
  private golden2p = false;
  /** START TOURNAMENT over an existing save asks for a second press. */
  private overwriteArmed = false;
  private keyHandler: (e: KeyboardEvent) => void;
  private padHandler: () => void;
  private hasSave: boolean;

  constructor(
    private onResult: (r: MenuResult) => void,
    private padCount: () => number,
  ) {
    this.root = document.getElementById('ui-root')!;
    this.hasSave = Tournament.load() !== null;
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    // VERSUS unlocks live when a pad is plugged in while the menu is up
    this.padHandler = () => { if (this.screen === 'mode') this.render(); };
    window.addEventListener('gamepadconnected', this.padHandler);
    window.addEventListener('gamepaddisconnected', this.padHandler);
    this.render();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('gamepadconnected', this.padHandler);
    window.removeEventListener('gamepaddisconnected', this.padHandler);
    this.root.innerHTML = '';
  }

  private sortedTeams(): TeamData[] {
    return [...TEAMS].sort((a, b) => a.name.localeCompare(b.name));
  }

  private modeRows(): { label: string; sub: string; id: string; disabled?: boolean }[] {
    const rows = [];
    if (this.hasSave) {
      rows.push({ label: 'CONTINUE TOURNAMENT', sub: 'Pick up your saved run', id: 'tournament-continue' });
    }
    rows.push(
      { label: 'KICK-OFF', sub: '1P vs CPU · pick any two teams', id: 'kickoff' },
      {
        label: 'VERSUS', sub: this.padCount() > 0
          ? '2P couch play · keyboard vs gamepad'
          : '2P couch play · CONNECT A GAMEPAD', id: 'versus',
        disabled: this.padCount() === 0,
      },
      { label: 'GOLDEN GOAL', sub: 'Party mode · no clock · next goal wins', id: 'golden' },
      { label: 'TOURNAMENT', sub: '48 teams · groups · knockout · glory', id: 'tournament' },
      { label: 'PENALTY SHOOTOUT', sub: 'Straight to the spot', id: 'shootout' },
      { label: 'EDIT TEAMS', sub: 'Rename players, boost ratings — put your friend up front', id: 'editor' },
    );
    return rows;
  }

  private onKey(e: KeyboardEvent): void {
    // OS auto-repeat must not chain-confirm through five screens into a match
    if (e.repeat) return;
    const code = e.code;
    if (this.screen === 'title') {
      this.screen = 'mode';
      this.focus = 0;
      this.render();
      return;
    }
    const confirm = code === 'KeyJ' || code === 'Enter' || code === 'Space';
    const back = code === 'KeyK' || code === 'Escape' || code === 'Backspace';
    const up = code === 'KeyW' || code === 'ArrowUp';
    const down = code === 'KeyS' || code === 'ArrowDown';
    const left = code === 'KeyA' || code === 'ArrowLeft';
    const right = code === 'KeyD' || code === 'ArrowRight';

    if (this.screen === 'mode') {
      const rows = this.modeRows();
      if (up) { this.focus = Math.max(0, this.focus - 1); this.render(); }
      else if (down) { this.focus = Math.min(rows.length - 1, this.focus + 1); this.render(); }
      else if (confirm) this.pickMode(rows[this.focus].id, rows[this.focus].disabled);
      return;
    }

    if (this.screen === 'pickHome' || this.screen === 'pickAway') {
      const n = TEAMS.length;
      const cols = 6;
      const nav = (d: number): void => {
        this.focus = Math.max(0, Math.min(n - 1, this.focus + d));
        this.render();
      };
      if (left) nav(-1);
      else if (right) nav(1);
      else if (up) nav(-cols);
      else if (down) nav(cols);
      else if (confirm) this.pick(this.sortedTeams()[this.focus]);
      else if (back) {
        if (this.screen === 'pickAway') { this.screen = 'pickHome'; this.home = null; }
        else { this.screen = 'mode'; this.focus = 0; }
        this.render();
      }
      return;
    }

    if (this.screen === 'settings') {
      const rows = this.settingsRows().length + 1; // + GO row
      if (up || down || back) this.overwriteArmed = false;
      if (up) { this.focus = Math.max(0, this.focus - 1); this.render(); }
      else if (down) { this.focus = Math.min(rows - 1, this.focus + 1); this.render(); }
      else if (left || right) {
        this.cycleSetting(this.focus, left ? -1 : 1);
        this.render();
      } else if (confirm) {
        if (this.focus === rows - 1) this.launch();
        else { this.cycleSetting(this.focus, 1); this.render(); }
      } else if (back) {
        this.screen = this.mode === 'tournament' ? 'pickHome' : 'pickAway';
        const prev = this.mode === 'tournament' ? this.home : this.away;
        this.away = null;
        this.focus = Math.max(0, this.sortedTeams().findIndex((t) => t.id === prev?.id));
        this.render();
      }
    }
  }

  private pickMode(id: string, disabled?: boolean): void {
    if (disabled) return;
    if (id === 'tournament-continue') {
      this.finish({ kind: 'tournament-continue' });
      return;
    }
    if (id === 'editor') {
      this.finish({ kind: 'editor' });
      return;
    }
    this.mode = id as GameMode | 'tournament';
    this.screen = 'pickHome';
    this.focus = Math.max(0, this.sortedTeams().findIndex((t) => t.id === 'bra'));
    this.render();
  }

  private settingsRows(): [string, string][] {
    const commentary: [string, string] = ['COMMENTARY', commentaryEnabled() ? 'ON' : 'OFF'];
    const music: [string, string] = [
      'MUSIC', (MUSIC_OPTIONS.find(([v]) => v === musicSetting()) ?? MUSIC_OPTIONS[0])[1],
    ];
    if (this.mode === 'tournament') {
      return [
        ['MATCH LENGTH', HALF_OPTIONS[this.halfIdx][0]],
        ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
        commentary,
        music,
      ];
    }
    if (this.mode === 'shootout' || this.mode === 'golden') {
      const rows: [string, string][] = [
        ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
        ['KICK-OFF', TOD_OPTIONS[this.todIdx].toUpperCase()],
        ['STADIUM', STADIUM_OPTIONS[this.stadiumIdx][0]],
        commentary,
        music,
      ];
      if (this.mode === 'golden') {
        rows.unshift(['PLAYERS', this.padCount() === 0
          ? '1P VS CPU'
          : this.golden2p ? '2P — KEYBOARD VS PAD' : '1P VS CPU']);
      }
      return rows;
    }
    return [
      ['MATCH LENGTH', HALF_OPTIONS[this.halfIdx][0]],
      ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
      ['KICK-OFF', TOD_OPTIONS[this.todIdx].toUpperCase()],
      ['STADIUM', STADIUM_OPTIONS[this.stadiumIdx][0]],
      commentary,
      music,
    ];
  }

  private cycleSetting(row: number, d: number): void {
    this.overwriteArmed = false;
    const labels = this.settingsRows().map((r) => r[0]);
    const key = labels[row];
    if (key === 'PLAYERS' && this.padCount() > 0) this.golden2p = !this.golden2p;
    if (key === 'MATCH LENGTH') this.halfIdx = (this.halfIdx + d + HALF_OPTIONS.length) % HALF_OPTIONS.length;
    if (key === 'DIFFICULTY') this.diffIdx = (this.diffIdx + d + DIFF_OPTIONS.length) % DIFF_OPTIONS.length;
    if (key === 'KICK-OFF') this.todIdx = (this.todIdx + d + TOD_OPTIONS.length) % TOD_OPTIONS.length;
    if (key === 'STADIUM') this.stadiumIdx = (this.stadiumIdx + d + STADIUM_OPTIONS.length) % STADIUM_OPTIONS.length;
    if (key === 'COMMENTARY') {
      try {
        localStorage.setItem(COMMENTARY_KEY, commentaryEnabled() ? 'off' : 'on');
      } catch { /* private browsing: toggle just won't persist */ }
    }
    if (key === 'MUSIC') {
      const i = MUSIC_OPTIONS.findIndex(([v]) => v === musicSetting());
      const next = MUSIC_OPTIONS[(i + d + MUSIC_OPTIONS.length) % MUSIC_OPTIONS.length][0];
      try {
        localStorage.setItem(MUSIC_KEY, next);
      } catch { /* private browsing: toggle just won't persist */ }
      window.dispatchEvent(new CustomEvent('ss26-music-change'));
    }
  }

  private pick(team: TeamData): void {
    if (this.screen === 'pickHome') {
      this.home = team;
      if (this.mode === 'tournament') {
        this.screen = 'settings';
        this.focus = this.settingsRows().length; // GO row
      } else {
        this.screen = 'pickAway';
        this.focus = this.sortedTeams().findIndex((t) => t.id !== team.id);
      }
      this.render();
    } else {
      if (this.home && team.id === this.home.id) return;
      this.away = team;
      this.screen = 'settings';
      this.focus = this.settingsRows().length;
      this.render();
    }
  }

  private launch(): void {
    if (this.mode === 'tournament') {
      if (!this.home) return;
      // an evening-long saved run must not vanish on one accidental press
      if (Tournament.load() !== null && !this.overwriteArmed) {
        this.overwriteArmed = true;
        this.render();
        return;
      }
      Tournament.clear();
      this.finish({
        kind: 'tournament-new',
        teamId: this.home.id,
        difficulty: DIFF_OPTIONS[this.diffIdx],
        halfLengthSec: HALF_OPTIONS[this.halfIdx][1],
      });
      return;
    }
    if (!this.home || !this.away) return;
    this.finish({
      kind: this.mode,
      home: this.home,
      away: this.away,
      halfLengthSec: HALF_OPTIONS[this.halfIdx][1],
      difficulty: DIFF_OPTIONS[this.diffIdx],
      timeOfDay: TOD_OPTIONS[this.todIdx],
      stadium: STADIUM_OPTIONS[this.stadiumIdx][1],
      golden2p: this.mode === 'golden' ? this.golden2p && this.padCount() > 0 : undefined,
    });
  }

  private finish(r: MenuResult): void {
    this.destroy();
    this.onResult(r);
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
      case 'mode':
        this.renderMode();
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

  private renderMode(): void {
    const rows = this.modeRows();
    const html = rows.map((r, i) =>
      `<div class="setting-row mode-row${i === this.focus ? ' focus' : ''}${r.disabled ? ' disabled' : ''}" data-row="${i}">
        <span>${r.label}<small class="mode-sub">${r.sub}</small></span><span class="value">▶</span>
      </div>`).join('');
    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">SELECT MODE</div>
        <div class="settings-list">${html}</div>
        <div class="controls-card">W/S SELECT · J CONFIRM</div>
      </div>`;
    this.root.querySelectorAll('.mode-row').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number((el as HTMLElement).dataset.row);
        this.focus = i;
        this.pickMode(this.modeRows()[i].id, this.modeRows()[i].disabled);
      });
    });
  }

  private renderTeamPick(): void {
    const picking = this.mode === 'tournament'
      ? 'PICK YOUR NATION'
      : this.screen === 'pickHome' ? 'PICK YOUR TEAM'
      : this.mode === 'versus' ? 'PLAYER 2 — PICK YOUR TEAM' : 'PICK YOUR OPPONENT';
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
    const picked = this.home && this.screen === 'pickAway' ? `<div class="vs-strip">
        <div class="slot"><div class="swatch" style="background:${this.home.kit.home};width:16px;height:16px;border-radius:3px"></div>${this.home.name}</div>
        <div class="vs">VS</div>
        <div class="slot" style="opacity:0.5">?</div>
      </div>` : '';
    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">${picking}</div>
        ${picked}
        <div class="team-grid">${cells}</div>
        <div class="controls-card">WASD MOVE · J SELECT · K BACK</div>
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
    this.root.querySelector('.team-cell.focus')?.scrollIntoView({ block: 'nearest' });
  }

  private renderSettings(): void {
    const rows = this.settingsRows();
    const goLabel = this.mode === 'tournament'
      ? (this.overwriteArmed ? '⚠ OVERWRITES YOUR SAVED RUN — PRESS AGAIN' : 'START TOURNAMENT')
      : this.mode === 'shootout' ? 'TO THE SPOT!'
      : this.mode === 'golden' ? 'NEXT GOAL WINS!' : 'KICK OFF!';
    const rowsHtml = rows.map(([k, v], i) =>
      `<div class="setting-row${i === this.focus ? ' focus' : ''}" data-row="${i}">
        <span>${k}</span><span class="value">◀ ${v} ▶</span>
      </div>`).join('');
    const strip = this.mode === 'tournament'
      ? `<div class="vs-strip"><div class="slot">
          <div class="swatch" style="background:${this.home!.kit.home};width:16px;height:16px;border-radius:3px"></div>
          ${this.home!.name} <small>(${Math.round(teamRating(this.home!))})</small></div></div>`
      : `<div class="vs-strip">
          <div class="slot"><div class="swatch" style="background:${this.home!.kit.home};width:16px;height:16px;border-radius:3px"></div>${this.home!.name} <small>(${Math.round(teamRating(this.home!))})</small></div>
          <div class="vs">VS</div>
          <div class="slot"><div class="swatch" style="background:${this.away!.kit.home};width:16px;height:16px;border-radius:3px"></div>${this.away!.name} <small>(${Math.round(teamRating(this.away!))})</small></div>
        </div>`;
    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">${this.mode === 'tournament' ? 'TOURNAMENT SETTINGS' : 'MATCH SETTINGS'}</div>
        ${strip}
        <div class="settings-list">
          ${rowsHtml}
          <div class="setting-row go${this.focus === rows.length ? ' focus' : ''}" data-row="${rows.length}">${goLabel}</div>
        </div>
        <div class="controls-card">W/S SELECT · A/D CHANGE · J CONFIRM · K BACK</div>
      </div>`;
    this.root.querySelectorAll('.setting-row').forEach((el) => {
      el.addEventListener('click', () => {
        const row = Number((el as HTMLElement).dataset.row);
        if (row === rows.length) this.launch();
        else { this.focus = row; this.cycleSetting(row, 1); this.renderSettings(); }
      });
    });
  }
}
