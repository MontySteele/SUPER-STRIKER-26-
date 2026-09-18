// Front end (§2 zero friction, §7.1 PS3 broadcast package).
//
// Flow, unchanged in meaning from v1: title → main menu → teams → settings →
// kickoff. What changed is the shape of it — a FIFA-10-era console front end
// rather than a stack of list rows:
//
//   TITLE        logo, PRESS START pulse, live two-player 3D backdrop
//   MAIN         horizontal tiles (KICK OFF / VERSUS / TOURNAMENT / TEAMS /
//                SETTINGS), each with its own vertical sub-list
//   TEAMS        side-by-side home/away panels with kit silhouettes, ratings
//                and formation, the 48-crest grid, and the match-dressing
//                strip (length / difficulty / kick-off / stadium) beneath
//   SETTINGS     the same options, restyled, with the VS banner on top
//
// Every mode the old menu could reach is still reachable and still returns the
// exact same MenuResult, including the join-by-QR guest lobby ('online') and
// the CONTINUE TOURNAMENT save. Navigation is pad-first (MenuNav polls the
// gamepads itself — the match loop's poller is not running here) with the
// keyboard bindings kept verbatim: WASD/arrows, J confirm, K back.

import './menu.css';
import { TEAMS } from '../data/loader';
import type { TeamData } from '../data/types';
import type { DifficultyName } from '../sim/match';
import type { TimeOfDay } from '../render/scene';
import type { StadiumSize } from '../render/stadium';
import { Tournament } from '../sim/tournament';
import { COMMENTARY_KEY, commentaryEnabled } from '../audio/commentary';
import { MUSIC_KEY, musicSetting, type MusicSetting } from '../audio/music';
import { VOLUME_BUSES, VOLUME_LABEL, nudgeVolume, volumeSetting, type VolumeBus } from '../audio/volume';
import { volumeRowHtml, wireVolumeRows } from './volumeRow';
import { CONTROLS_KEY, controlsSetting, type ControlsSetting } from './prefs';
import { QUALITY_OPTIONS, qualitySetting, setQuality } from '../render/quality';
import { esc } from './escape';
import { MenuNav, mouseIsLive, type NavDir } from './menuNav';
import { MenuBackdrop } from './menuBackdrop';
import { anyButtonLabel, promptBar } from './menuGlyphs';
import { crest, rating, ratingBar, shirtSvg, stars } from './menuKit';

const MUSIC_OPTIONS: [MusicSetting, string][] = [
  ['all', 'ON'], ['menus', 'MENUS ONLY'], ['off', 'OFF'],
];

const CONTROLS_OPTIONS: [ControlsSetting, string][] = [
  ['fade', 'FADE'], ['on', 'ALWAYS'], ['off', 'OFF'],
];

/** Settings-row label -> audio bus, for the four §7.3 faders. */
const VOLUME_BY_LABEL = new Map<string, VolumeBus>(
  VOLUME_BUSES.map((b) => [VOLUME_LABEL[b], b] as [string, VolumeBus]),
);

export type GameMode = 'kickoff' | 'versus' | 'online' | 'shootout' | 'golden';

export type MenuResult =
  | {
      kind: GameMode;
      home: TeamData; away: TeamData;
      halfLengthSec: number; difficulty: DifficultyName;
      timeOfDay: TimeOfDay; stadium: StadiumSize;
      /** golden goal only: 2P couch play is opt-in via the PLAYERS setting */
      golden2p?: boolean;
      /** versus only: 2v2 couch play, offered once four devices are seated */
      versus2v2?: boolean;
    }
  | { kind: 'tournament-new'; teamId: string; difficulty: DifficultyName; halfLengthSec: number }
  | { kind: 'tournament-continue' }
  | { kind: 'editor' };

type Screen = 'title' | 'main' | 'pickHome' | 'pickAway' | 'settings' | 'prefs';

const HALF_OPTIONS: [string, number][] = [['4 MIN', 120], ['6 MIN', 180], ['10 MIN', 300]];
const DIFF_OPTIONS: DifficultyName[] = ['amateur', 'pro', 'legend'];
const TOD_OPTIONS: TimeOfDay[] = ['night', 'sunset', 'day'];
const STADIUM_OPTIONS: [string, StadiumSize][] = [
  ['NATIONAL 45K', 'national'], ['MEGA BOWL 80K', 'mega'], ['MUNICIPAL 18K', 'municipal'],
];

/** Crest columns in the team grid — the grid CSS uses the same number. */
const GRID_COLS = 8;

interface SubItem {
  id: string;
  label: string;
  note: string;
  disabled?: boolean;
}

interface Tile {
  id: string;
  name: string;
  note: string;
  icon: string;
  accent: string;
  items: SubItem[];
}

export class Menu {
  private root: HTMLElement;
  private screen: Screen = 'title';
  private focus = 0;
  private tileIdx = 0;
  private subIdx = 0;
  /** team screens: which half of the screen the stick is driving */
  private zone: 'grid' | 'strip' = 'grid';
  private stripIdx = 0;
  private mode: GameMode | 'tournament' = 'kickoff';
  private home: TeamData | null = null;
  private away: TeamData | null = null;
  private halfIdx = 1;
  private diffIdx = 1;
  private todIdx = 0;
  private stadiumIdx = 0;
  private golden2p = false;
  private versus2v2 = false;
  /** START TOURNAMENT over an existing save asks for a second press. */
  private overwriteArmed = false;
  private nav: MenuNav;
  private backdrop: MenuBackdrop | null = null;
  private padHandler: () => void;
  private hasSave: boolean;
  /** The MenuNav event that opened the current screen — see gated(). */
  private gateEvent = -1;
  /** true for the first paint of a new screen — only then does it slide in */
  private entering = true;
  private anim = '';
  private body!: HTMLElement;
  private foot!: HTMLElement;

  constructor(
    private onResult: (r: MenuResult) => void,
    private padCount: () => number,
  ) {
    this.root = document.getElementById('ui-root')!;
    this.hasSave = Tournament.load() !== null;
    this.mount();

    this.nav = new MenuNav({
      onDir: (d) => this.onDir(d),
      onConfirm: () => this.onConfirm(),
      onBack: () => this.onBack(),
      onShoulder: (d) => this.onShoulder(d),
      onStart: () => this.onStart(),
      onAlt: () => this.onAlt(),
      onAny: () => this.onAny(),
    });

    // VERSUS unlocks live when a pad is plugged in while the menu is up, and
    // the glyphs switch family with it
    this.padHandler = () => { if (this.screen === 'main' || this.screen === 'title') this.paint(); };
    window.addEventListener('gamepadconnected', this.padHandler);
    window.addEventListener('gamepaddisconnected', this.padHandler);
    this.paint();
  }

  destroy(): void {
    this.nav.destroy();
    this.backdrop?.destroy();
    this.backdrop = null;
    window.removeEventListener('gamepadconnected', this.padHandler);
    window.removeEventListener('gamepaddisconnected', this.padHandler);
    this.root.innerHTML = '';
    (window as unknown as Record<string, unknown>).__ss26Menu = null;
    // the attract match is main.ts's; it went to sleep while our own 3D
    // backdrop was on screen (see the listener in main.ts). Async, so a menu
    // that is tearing down INTO a match never builds one just to drop it.
    setTimeout(() => window.dispatchEvent(new CustomEvent('ss26-attract-resume')), 0);
  }

  // ------------------------------------------------------------------ mount

  private mount(): void {
    this.root.innerHTML = `
      <div class="fe fe-skin">
        <div class="fe-vignette"></div>
        <div class="fe-layer">
          <div class="fe-topbar">
            <div class="fe-mark">SUPER<b>STRIKER</b></div>
            <div class="fe-crumb" id="fe-crumb"></div>
            <div class="fe-topbar-rule"></div>
          </div>
          <div class="fe-body" id="fe-body"></div>
          <div id="fe-foot"></div>
        </div>
      </div>`;
    this.body = this.root.querySelector<HTMLElement>('#fe-body')!;
    this.foot = this.root.querySelector<HTMLElement>('#fe-foot')!;

    // the front end owns the screen while it is up: the CPU-vs-CPU attract
    // match behind it is suspended so the only 3D cost is our two players
    window.dispatchEvent(new CustomEvent('ss26-attract-suspend'));
    const fe = this.root.querySelector<HTMLElement>('.fe')!;
    try {
      this.backdrop = new MenuBackdrop(fe);
      const pair = randomPair();
      this.backdrop.setTeams(pair[0], pair[1]);
    } catch {
      this.backdrop = null; // a styled fallback is already in the markup
    }
    // debug hook for automated testing, same shape as __ss26 / __ss26Attract
    (window as unknown as Record<string, unknown>).__ss26Menu = {
      backdrop: this.backdrop,
      screen: () => this.screen,
    };
  }

  // ------------------------------------------------------------------ input

  private go(screen: Screen): void {
    this.screen = screen;
    this.gateEvent = this.nav?.eventId ?? -1;
    this.entering = true;
    this.paint();
  }

  /**
   * True while the input event that opened this screen is still being handled.
   *
   * This is per EVENT, not per millisecond, and that matters both ways. One
   * keydown runs onAny() and then onConfirm() back to back, so without a guard
   * a single tap of J walked from the title screen into a team pick — and a
   * wall-clock window could not fix it, because the render in between can
   * easily outlast any window you would want to pick. Equally, a time window
   * DROPS presses: if the main thread stalls, two keydowns 260ms apart arrive
   * back to back and the second one dies inside the first one's window. An
   * event id has neither failure. Held keys are handled upstream (MenuNav
   * ignores auto-repeat for confirm/back) and a held pad button only ever
   * produces one edge.
   */
  private gated(): boolean {
    return this.nav?.eventId === this.gateEvent;
  }

  private onAny(): void {
    if (this.screen !== 'title') return;
    this.tileIdx = 0;
    this.subIdx = 0;
    this.go('main');
  }

  private onStart(): void {
    if (this.screen === 'title') return; // onAny already took it
    this.onBack();
  }

  private onAlt(): void {
    // square / L: cycle the focused option backwards, wherever there is one
    if (this.gated()) return;
    if ((this.screen === 'pickHome' || this.screen === 'pickAway') && this.zone === 'strip') {
      this.cycleKey(this.stripKeys()[this.stripIdx], -1);
      this.paint();
    } else if (this.screen === 'settings' || this.screen === 'prefs') {
      this.onDir('left');
    }
  }

  private onShoulder(d: -1 | 1): void {
    if (this.screen === 'main') {
      this.moveTile(d);
    } else if (this.screen === 'pickHome' || this.screen === 'pickAway') {
      if (this.zone === 'strip') {
        const n = this.stripKeys().length;
        this.stripIdx = Math.max(0, Math.min(n - 1, this.stripIdx + d));
        this.refocusStrip();
      } else {
        // page the grid by three rows — 48 crests is a long walk otherwise
        const n = TEAMS.length;
        this.focus = Math.max(0, Math.min(n - 1, this.focus + d * GRID_COLS * 3));
        this.refocusGrid();
      }
    }
  }

  private onDir(d: NavDir): void {
    switch (this.screen) {
      case 'title': return;
      case 'main': return this.navMain(d);
      case 'pickHome':
      case 'pickAway': return this.navTeams(d);
      case 'settings': return this.navSettings(d);
      case 'prefs': return this.navPrefs(d);
    }
  }

  private onConfirm(): void {
    if (this.gated()) return;
    switch (this.screen) {
      case 'title': return;
      case 'main': {
        const items = this.tiles()[this.tileIdx].items;
        const it = items[this.subIdx];
        if (it) this.pickMode(it.id, it.disabled);
        return;
      }
      case 'pickHome':
      case 'pickAway': {
        if (this.zone === 'strip') {
          this.cycleKey(this.stripKeys()[this.stripIdx], 1);
          this.paint();
        } else {
          this.pick(this.sortedTeams()[this.focus]);
        }
        return;
      }
      case 'settings': {
        const rows = this.settingsRows();
        if (this.focus === rows.length) this.launch();
        else { this.cycleSetting(this.focus, 1); this.paint(); }
        return;
      }
      case 'prefs': {
        const rows = this.prefRows();
        if (this.focus === rows.length) this.go('main');
        else { this.cycleKey(rows[this.focus][0], 1); this.paint(); }
        return;
      }
    }
  }

  private onBack(): void {
    if (this.gated()) return;
    switch (this.screen) {
      case 'title': return;
      case 'main':
        this.go('title');
        return;
      case 'pickHome':
        if (this.zone === 'strip') { this.zone = 'grid'; this.paint(); return; }
        this.go('main');
        return;
      case 'pickAway':
        if (this.zone === 'strip') { this.zone = 'grid'; this.paint(); return; }
        this.home = null;
        this.zone = 'grid';
        this.go('pickHome');
        return;
      case 'settings': {
        const prev = this.mode === 'tournament' ? this.home : this.away;
        this.away = null;
        this.zone = 'grid';
        this.focus = Math.max(0, this.sortedTeams().findIndex((t) => t.id === prev?.id));
        this.overwriteArmed = false;
        this.go(this.mode === 'tournament' ? 'pickHome' : 'pickAway');
        return;
      }
      case 'prefs':
        this.go('main');
        return;
    }
  }

  // --------------------------------------------------------- per-screen nav

  private moveTile(d: number): void {
    const tiles = this.tiles();
    const next = Math.max(0, Math.min(tiles.length - 1, this.tileIdx + d));
    if (next === this.tileIdx) return;
    this.tileIdx = next;
    this.subIdx = 0;
    this.refocusTiles();
  }

  private navMain(d: NavDir): void {
    if (d === 'left') return this.moveTile(-1);
    if (d === 'right') return this.moveTile(1);
    const items = this.tiles()[this.tileIdx].items;
    const next = d === 'up'
      ? Math.max(0, this.subIdx - 1)
      : Math.min(items.length - 1, this.subIdx + 1);
    if (next === this.subIdx) return;
    this.subIdx = next;
    this.refocusSub();
  }

  private navTeams(d: NavDir): void {
    if (this.zone === 'strip') {
      const keys = this.stripKeys();
      if (d === 'up') { this.zone = 'grid'; this.paint(); return; }
      if (d === 'left' || d === 'right') {
        const next = Math.max(0, Math.min(keys.length - 1, this.stripIdx + (d === 'left' ? -1 : 1)));
        if (next === this.stripIdx) return;
        this.stripIdx = next;
        this.refocusStrip();
      }
      return;
    }
    const n = TEAMS.length;
    let f = this.focus;
    if (d === 'left') f = Math.max(0, f - 1);
    else if (d === 'right') f = Math.min(n - 1, f + 1);
    else if (d === 'up') f = f - GRID_COLS >= 0 ? f - GRID_COLS : f;
    else if (d === 'down') {
      if (f + GRID_COLS <= n - 1) f += GRID_COLS;
      else if (this.stripKeys().length > 0) { this.zone = 'strip'; this.stripIdx = 0; this.paint(); return; }
    }
    if (f === this.focus) return;
    this.focus = f;
    this.refocusGrid();
  }

  private navSettings(d: NavDir): void {
    const rows = this.settingsRows().length + 1; // + GO row
    if (d === 'up' || d === 'down') {
      this.overwriteArmed = false;
      const next = d === 'up' ? Math.max(0, this.focus - 1) : Math.min(rows - 1, this.focus + 1);
      if (next === this.focus) return;
      this.focus = next;
      this.refocusRows();
      return;
    }
    if (this.focus >= rows - 1) return;
    this.cycleSetting(this.focus, d === 'left' ? -1 : 1);
    this.paint();
  }

  private navPrefs(d: NavDir): void {
    const rows = this.prefRows();
    if (d === 'up' || d === 'down') {
      const next = d === 'up' ? Math.max(0, this.focus - 1) : Math.min(rows.length, this.focus + 1);
      if (next === this.focus) return;
      this.focus = next;
      this.refocusRows();
      return;
    }
    if (this.focus >= rows.length) return;
    this.cycleKey(rows[this.focus][0], d === 'left' ? -1 : 1);
    this.paint();
  }

  // ------------------------------------------------------------------ model

  private sortedTeams(): TeamData[] {
    return [...TEAMS].sort((a, b) => a.name.localeCompare(b.name));
  }

  private tiles(): Tile[] {
    const padded = this.padCount() > 0;
    const versusNote = !padded
      ? '2P couch play · CONNECT A GAMEPAD'
      : this.canCouch2v2()
        ? '2P or 2v2 couch play · everyone on the sofa'
        : '2P couch play · keyboard vs gamepad';
    const tour: SubItem[] = [];
    if (this.hasSave) {
      tour.push({ id: 'tournament-continue', label: 'CONTINUE TOURNAMENT', note: 'Pick up your saved run' });
    }
    tour.push({ id: 'tournament', label: 'NEW TOURNAMENT', note: '48 teams · groups · knockout · glory' });

    return [
      {
        id: 'kickoff', name: 'KICK OFF', note: 'PLAY NOW', icon: '⚽', accent: '#3f8ddc',
        items: [
          { id: 'kickoff', label: 'QUICK MATCH', note: '1P vs CPU · pick any two teams' },
          { id: 'golden', label: 'GOLDEN GOAL', note: 'Party mode · no clock · next goal wins' },
          { id: 'shootout', label: 'PENALTY SHOOTOUT', note: 'Straight to the spot' },
        ],
      },
      {
        id: 'versus', name: 'VERSUS', note: '2-4 PLAYERS', icon: '🎮', accent: '#d9503f',
        items: [
          { id: 'versus', label: 'LOCAL VERSUS', note: versusNote, disabled: !padded },
          { id: 'online', label: 'INVITE PLAYERS', note: 'Room code + QR · 1v1 or 2v2 from their own laptops' },
        ],
      },
      {
        id: 'tournament', name: 'TOURNAMENT',
        note: this.hasSave ? 'SAVE FOUND' : '48 TEAMS', icon: '🏆', accent: '#ffce4a',
        items: tour,
      },
      {
        id: 'teams', name: 'TEAMS', note: 'SQUAD EDITOR', icon: '👕', accent: '#4fb98a',
        items: [
          { id: 'editor', label: 'EDIT TEAMS', note: 'Rename players, boost ratings — put your friend up front' },
        ],
      },
      {
        id: 'settings', name: 'SETTINGS', note: 'PREFERENCES', icon: '⚙', accent: '#8a93c8',
        items: [
          { id: 'prefs', label: 'GAME SETTINGS', note: 'Graphics, commentary, music, controls hint' },
        ],
      },
    ];
  }

  private pickMode(id: string, disabled?: boolean): void {
    if (disabled) return;
    if (id === 'tournament-continue') { this.finish({ kind: 'tournament-continue' }); return; }
    if (id === 'editor') { this.finish({ kind: 'editor' }); return; }
    if (id === 'prefs') { this.focus = 0; this.go('prefs'); return; }
    this.mode = id as GameMode | 'tournament';
    this.zone = 'grid';
    this.stripIdx = 0;
    this.focus = Math.max(0, this.sortedTeams().findIndex((t) => t.id === 'bra'));
    this.go('pickHome');
  }

  /** The four global preference rows — shared by MATCH SETTINGS and SETTINGS. */
  private basePrefRows(): [string, string][] {
    return [
      ['GRAPHICS', (QUALITY_OPTIONS.find(([v]) => v === qualitySetting()) ?? QUALITY_OPTIONS[0])[1]],
      ['COMMENTARY', commentaryEnabled() ? 'ON' : 'OFF'],
      ['MUSIC', (MUSIC_OPTIONS.find(([v]) => v === musicSetting()) ?? MUSIC_OPTIONS[0])[1]],
      ['CONTROLS HINT', (CONTROLS_OPTIONS.find(([v]) => v === controlsSetting()) ?? CONTROLS_OPTIONS[0])[1]],
    ];
  }

  /**
   * GAME SETTINGS only: the toggles plus the four volume faders. MATCH SETTINGS
   * keeps the short list — you are one press from kick-off there, and the mix
   * is not a per-match decision.
   */
  private prefRows(): [string, string][] {
    return [
      ...this.basePrefRows(),
      ...VOLUME_BUSES.map((b): [string, string] => [VOLUME_LABEL[b], String(volumeSetting(b))]),
    ];
  }

  private settingsRows(): [string, string][] {
    const prefs = this.basePrefRows();
    if (this.mode === 'tournament') {
      return [
        ['MATCH LENGTH', HALF_OPTIONS[this.halfIdx][0]],
        ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
        ...prefs,
      ];
    }
    if (this.mode === 'shootout' || this.mode === 'golden') {
      const rows: [string, string][] = [
        ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
        ['KICK-OFF', TOD_OPTIONS[this.todIdx].toUpperCase()],
        ['STADIUM', STADIUM_OPTIONS[this.stadiumIdx][0]],
        ...prefs,
      ];
      if (this.mode === 'golden') {
        rows.unshift(['PLAYERS', this.padCount() === 0
          ? '1P VS CPU'
          : this.golden2p ? '2P — KEYBOARD VS PAD' : '1P VS CPU']);
      }
      return rows;
    }
    const rows: [string, string][] = [
      ['MATCH LENGTH', HALF_OPTIONS[this.halfIdx][0]],
      ['DIFFICULTY', DIFF_OPTIONS[this.diffIdx].toUpperCase()],
      ['KICK-OFF', TOD_OPTIONS[this.todIdx].toUpperCase()],
      ['STADIUM', STADIUM_OPTIONS[this.stadiumIdx][0]],
      ...prefs,
    ];
    // 2v2 on one couch needs four sticks between everyone, so it only shows
    // up once there are four — otherwise VERSUS is the 1v1 it always was
    if (this.mode === 'versus' && this.canCouch2v2()) {
      rows.unshift(['PLAYERS', this.versus2v2 ? '2v2 — FOUR PLAYERS' : '1v1 — TWO PLAYERS']);
    }
    return rows;
  }

  /** The match-dressing subset, shown as the strip under the team grid. */
  private stripKeys(): string[] {
    const have = new Set(this.settingsRows().map((r) => r[0]));
    return ['PLAYERS', 'MATCH LENGTH', 'DIFFICULTY', 'KICK-OFF', 'STADIUM']
      .filter((k) => have.has(k));
  }

  private valueOf(key: string): string {
    return (this.settingsRows().find(([k]) => k === key) ?? [key, ''])[1];
  }

  /** Keyboard plus the pads: four humans need four devices between them. */
  private canCouch2v2(): boolean {
    return this.padCount() + 1 >= 4;
  }

  private cycleSetting(row: number, d: number): void {
    const labels = this.settingsRows().map((r) => r[0]);
    this.cycleKey(labels[row], d);
  }

  private cycleKey(key: string, d: number): void {
    this.overwriteArmed = false;
    // §7.3 faders: ±5 per press, and MenuNav's hold-to-repeat makes that a
    // steady slide. The write itself fires ss26-volume-change (main.ts ramps
    // the gain and ticks the fader), so there is nothing else to do here.
    const bus = VOLUME_BY_LABEL.get(key);
    if (bus) { nudgeVolume(bus, d); return; }
    if (key === 'PLAYERS' && this.mode === 'golden' && this.padCount() > 0) {
      this.golden2p = !this.golden2p;
    }
    if (key === 'PLAYERS' && this.mode === 'versus') this.versus2v2 = !this.versus2v2;
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
    if (key === 'GRAPHICS') {
      const i = QUALITY_OPTIONS.findIndex(([v]) => v === qualitySetting());
      setQuality(QUALITY_OPTIONS[(i + d + QUALITY_OPTIONS.length) % QUALITY_OPTIONS.length][0]);
      // the attract match behind the menu is a live renderer: rebuild it so the
      // level you just picked is the one you're looking at (§7A.7)
      window.dispatchEvent(new CustomEvent('ss26-quality-change'));
    }
    if (key === 'CONTROLS HINT') {
      const i = CONTROLS_OPTIONS.findIndex(([v]) => v === controlsSetting());
      const next = CONTROLS_OPTIONS[(i + d + CONTROLS_OPTIONS.length) % CONTROLS_OPTIONS.length][0];
      try {
        localStorage.setItem(CONTROLS_KEY, next);
      } catch { /* private browsing: toggle just won't persist */ }
    }
  }

  private pick(team: TeamData): void {
    if (this.screen === 'pickHome') {
      this.home = team;
      if (this.mode === 'tournament') {
        this.focus = this.settingsRows().length; // GO row
        this.dressBackdrop();
        this.go('settings');
      } else {
        this.focus = this.sortedTeams().findIndex((t) => t.id !== team.id);
        this.go('pickAway');
      }
    } else {
      if (this.home && team.id === this.home.id) return;
      this.away = team;
      this.focus = this.settingsRows().length;
      this.dressBackdrop();
      this.go('settings');
    }
  }

  /** Put the picked kits on the two players behind the menu. */
  private dressBackdrop(): void {
    if (!this.backdrop || !this.home) return;
    const away = this.away ?? TEAMS.find((t) => t.id !== this.home!.id) ?? this.home;
    this.backdrop.setTeams(this.home, away);
  }

  private launch(): void {
    if (this.mode === 'tournament') {
      if (!this.home) return;
      // an evening-long saved run must not vanish on one accidental press
      if (Tournament.load() !== null && !this.overwriteArmed) {
        this.overwriteArmed = true;
        this.paint();
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
      versus2v2: this.mode === 'versus' ? this.versus2v2 && this.canCouch2v2() : undefined,
    });
  }

  private finish(r: MenuResult): void {
    this.destroy();
    this.onResult(r);
  }

  // ----------------------------------------------------------------- render

  private paint(): void {
    // a value change inside a screen must not replay the screen's slide-in
    this.anim = this.entering ? 'fe-anim' : '';
    this.entering = false;
    const fe = this.root.querySelector<HTMLElement>('.fe');
    fe?.classList.toggle('fe--title', this.screen === 'title');
    // title = poster (figures centred, lightly defocused); menus = the figures
    // step aside and go properly soft so the type sits on darkness
    this.backdrop?.setFocus(this.screen !== 'title');
    const bar = this.root.querySelector<HTMLElement>('.fe-topbar');
    if (bar) bar.style.visibility = this.screen === 'title' ? 'hidden' : 'visible';
    this.paintCrumb();
    switch (this.screen) {
      case 'title': return this.renderTitle();
      case 'main': return this.renderMain();
      case 'pickHome':
      case 'pickAway': return this.renderTeams();
      case 'settings': return this.renderSettings();
      case 'prefs': return this.renderPrefs();
    }
  }

  private paintCrumb(): void {
    const el = this.root.querySelector<HTMLElement>('#fe-crumb');
    if (!el) return;
    const modeName = this.mode === 'tournament' ? 'TOURNAMENT'
      : this.mode === 'shootout' ? 'PENALTY SHOOTOUT'
      : this.mode === 'golden' ? 'GOLDEN GOAL'
      : this.mode === 'online' ? 'INVITE PLAYERS'
      : this.mode === 'versus' ? 'LOCAL VERSUS' : 'KICK OFF';
    const trail: string[] = ['MAIN MENU'];
    if (this.screen === 'prefs') trail.push('SETTINGS');
    if (this.screen === 'pickHome' || this.screen === 'pickAway' || this.screen === 'settings') {
      trail.push(modeName);
      trail.push(this.screen === 'settings' ? 'MATCH SETTINGS' : 'TEAM SELECT');
    }
    el.innerHTML = trail
      .map((t, i) => `<span class="${i === trail.length - 1 ? 'on' : ''}">${t}</span>`)
      .join('<i>›</i>');
  }

  private setFoot(html: string): void {
    this.foot.innerHTML = html;
  }

  // ------------------------------------------------------------------ title

  private renderTitle(): void {
    this.body.innerHTML = `
      <div class="fe-title ${this.anim ? 'fe-anim-up' : ''}">
        <div class="fe-logo">
          <div class="fe-logo-sup">SUPER</div>
          <div class="fe-logo-main">STRIKER</div>
          <div class="fe-logo-rule"><span class="fe-logo-year">'26</span></div>
          <div class="fe-tagline">THE PEOPLE'S FOOTBALL</div>
        </div>
        <div class="fe-start">${anyButtonLabel()}</div>
      </div>
      <div class="fe-title-foot">RUNS LOCALLY · 60FPS · 0 MICROTRANSACTIONS · NO ACCOUNT REQUIRED</div>`;
    this.setFoot('');
    this.body.querySelector('.fe-start')?.addEventListener('click', () => this.onAny());
    this.body.querySelector('.fe-title')?.addEventListener('click', () => this.onAny());
  }

  // -------------------------------------------------------------- main menu

  private renderMain(): void {
    const tiles = this.tiles();
    const tilesHtml = tiles.map((t, i) => `
      <div class="fe-tile${i === this.tileIdx ? ' focus' : ''}" data-tile="${i}"
        style="--fe-accent:${t.accent}">
        <div class="fe-tile-ico">${t.icon}</div>
        <div class="fe-tile-name">${t.name}</div>
        <div class="fe-tile-note">${t.note}</div>
      </div>`).join('');
    this.body.innerHTML = `
      <div class="${this.anim}">
        <div class="fe-h1">MAIN <em>MENU</em></div>
        <div class="fe-sub">PICK A MODE — EVERYTHING RUNS RIGHT HERE, RIGHT NOW</div>
        <div class="fe-tilerow" id="fe-tiles">${tilesHtml}</div>
        <div class="fe-sublist" id="fe-sub"></div>
      </div>`;
    this.paintSub();
    this.setFoot(promptBar([
      ['dpadLR', 'MODE'], ['dpadUD', 'SELECT'], ['confirm', 'CONFIRM'], ['back', 'TITLE'],
    ]));
    this.body.querySelectorAll<HTMLElement>('.fe-tile').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        if (!mouseIsLive()) return;
        this.tileIdx = Number(el.dataset.tile);
        this.subIdx = 0;
        this.refocusTiles();
      });
      el.addEventListener('click', () => {
        this.tileIdx = Number(el.dataset.tile);
        this.subIdx = 0;
        this.refocusTiles();
      });
    });
  }

  private paintSub(): void {
    const host = this.body.querySelector<HTMLElement>('#fe-sub');
    if (!host) return;
    const items = this.tiles()[this.tileIdx].items;
    host.innerHTML = items.map((it, i) => `
      <div class="fe-subrow${i === this.subIdx ? ' focus' : ''}${it.disabled ? ' disabled' : ''}" data-sub="${i}">
        <span class="fe-subrow-label">${it.label}</span>
        <span class="fe-subrow-note">${esc(it.note)}</span>
        <span class="fe-subrow-go">▶</span>
      </div>`).join('');
    host.querySelectorAll<HTMLElement>('.fe-subrow').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        if (!mouseIsLive()) return;
        this.subIdx = Number(el.dataset.sub);
        this.refocusSub();
      });
      el.addEventListener('click', () => {
        const i = Number(el.dataset.sub);
        this.subIdx = i;
        const it = this.tiles()[this.tileIdx].items[i];
        this.pickMode(it.id, it.disabled);
      });
    });
  }

  private refocusTiles(): void {
    this.body.querySelectorAll<HTMLElement>('.fe-tile').forEach((el, i) => {
      el.classList.toggle('focus', i === this.tileIdx);
    });
    this.paintSub();
  }

  private refocusSub(): void {
    this.body.querySelectorAll<HTMLElement>('.fe-subrow').forEach((el, i) => {
      el.classList.toggle('focus', i === this.subIdx);
    });
  }

  // ------------------------------------------------------------ team select

  private renderTeams(): void {
    const teams = this.sortedTeams();
    const picking = this.screen === 'pickHome' ? 0 : 1;
    const heading = this.mode === 'tournament'
      ? 'PICK YOUR <em>NATION</em>'
      : picking === 0 ? 'PICK YOUR <em>TEAM</em>'
      : this.mode === 'versus' || this.mode === 'online'
        ? 'PLAYER 2 — PICK YOUR <em>TEAM</em>' : 'PICK YOUR <em>OPPONENT</em>';

    const cells = teams.map((t, i) => {
      const taken = this.home && this.screen === 'pickAway' && t.id === this.home.id;
      return `<div class="fe-cell${i === this.focus && this.zone === 'grid' ? ' focus' : ''}${taken ? ' taken' : ''}" data-idx="${i}">
        ${crest(t)}
        <span class="fe-cell-name">${esc(t.name)}</span>
        <span class="fe-cell-tier">${'★'.repeat(Math.max(1, Math.min(5, t.tier)))}</span>
      </div>`;
    }).join('');

    const solo = this.mode === 'tournament';
    this.body.innerHTML = `
      <div class="${this.anim}">
        <div class="fe-h1">${heading}</div>
        <div class="fe-sub">${solo ? 'ONE NATION, SEVEN GAMES, ONE TROPHY' : 'HOME AND AWAY — THE KITS ARE RESOLVED ON THE PITCH'}</div>
        <div class="fe-versus">
          ${this.sidePanel(0, picking === 0)}
          <div class="fe-vsbadge">${solo ? '★' : 'VS'}</div>
          ${this.sidePanel(1, picking === 1)}
        </div>
        <div class="fe-grid" id="fe-grid">${cells}</div>
        ${this.stripHtml()}
      </div>`;

    this.setFoot(promptBar(this.zone === 'strip'
      ? [['dpadLR', 'OPTION'], ['confirm', 'CHANGE'], ['alt', 'BACK ONE'], ['dpadUD', 'TEAMS'], ['back', 'BACK']]
      : [['dpad', 'MOVE'], ['r1', 'PAGE'], ['confirm', 'SELECT'], ['back', 'BACK'], ['dpadUD', 'MATCH SETUP']]));

    this.body.querySelectorAll<HTMLElement>('.fe-cell').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        if (!mouseIsLive()) return;
        this.zone = 'grid';
        this.focus = Number(el.dataset.idx);
        this.refocusGrid();
      });
      el.addEventListener('click', () => {
        this.zone = 'grid';
        this.focus = Number(el.dataset.idx);
        this.pick(this.sortedTeams()[this.focus]);
      });
    });
    this.wireStrip();
    this.scrollFocusIntoView();
  }

  /** One half of the VS banner. `side` 0 = home, 1 = away. */
  private sidePanel(side: 0 | 1, active: boolean): string {
    const teams = this.sortedTeams();
    const solo = this.mode === 'tournament';
    let team: TeamData | null = side === 0 ? this.home : this.away;
    // the side being picked previews whatever the grid cursor is sitting on
    if (active) team = teams[this.focus] ?? team;
    const tag = solo
      ? (side === 0 ? 'YOUR NATION' : 'THE FIELD')
      : side === 0 ? 'HOME' : 'AWAY';
    if (!team || (solo && side === 1)) {
      return `<div class="fe-side ${side === 0 ? 'home' : 'away'} empty${active ? ' active' : ''}">
        <div class="fe-side-tag">${tag}</div>
        <div class="fe-side-info">
          <div class="fe-side-name">${solo && side === 1 ? '47 RIVALS' : '— — —'}</div>
          <div class="fe-side-code">${solo && side === 1 ? 'WORLD' : 'SELECT'}</div>
        </div>
      </div>`;
    }
    return `<div class="fe-side ${side === 0 ? 'home' : 'away'}${active ? ' active' : ''}">
      <div class="fe-side-tag">${tag}</div>
      ${shirtSvg(team, { num: 10 })}
      <div class="fe-side-info">
        <div class="fe-side-name">${esc(team.name)}</div>
        <div class="fe-side-code">${esc(team.code)}</div>
        <div class="fe-side-meta">
          <span>${stars(team.tier)}</span>
          <span>OVR <b>${rating(team)}</b></span>
          <span>${esc(team.formation)}</span>
          <span>${esc(team.style.toUpperCase())}</span>
        </div>
        ${ratingBar(team)}
      </div>
    </div>`;
  }

  private stripHtml(): string {
    const keys = this.stripKeys();
    if (keys.length === 0) return '';
    const items = keys.map((k, i) => `
      <div class="fe-stripitem${this.zone === 'strip' && i === this.stripIdx ? ' focus' : ''}" data-strip="${i}">
        <div class="fe-stripitem-k">${k}</div>
        <div class="fe-stripitem-v"><u>◀</u>${esc(this.valueOf(k))}<u>▶</u></div>
      </div>`).join('');
    return `<div class="fe-strip" id="fe-strip">${items}</div>`;
  }

  private wireStrip(): void {
    this.body.querySelectorAll<HTMLElement>('.fe-stripitem').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        if (!mouseIsLive()) return;
        this.zone = 'strip';
        this.stripIdx = Number(el.dataset.strip);
        this.refocusStrip();
      });
      el.addEventListener('click', () => {
        this.zone = 'strip';
        this.stripIdx = Number(el.dataset.strip);
        this.cycleKey(this.stripKeys()[this.stripIdx], 1);
        this.paint();
      });
    });
  }

  /** Focus-only update: keeps the CSS transitions alive between moves. */
  private refocusGrid(): void {
    this.body.querySelectorAll<HTMLElement>('.fe-cell').forEach((el, i) => {
      el.classList.toggle('focus', i === this.focus && this.zone === 'grid');
    });
    this.body.querySelectorAll<HTMLElement>('.fe-stripitem').forEach((el) => el.classList.remove('focus'));
    this.repaintActiveSide();
    this.scrollFocusIntoView();
  }

  private refocusStrip(): void {
    this.body.querySelectorAll<HTMLElement>('.fe-stripitem').forEach((el, i) => {
      el.classList.toggle('focus', i === this.stripIdx);
    });
    this.body.querySelectorAll<HTMLElement>('.fe-cell').forEach((el) => el.classList.remove('focus'));
  }

  private repaintActiveSide(): void {
    const active = this.body.querySelector<HTMLElement>('.fe-side.active');
    if (!active) return;
    const side: 0 | 1 = active.classList.contains('home') ? 0 : 1;
    const html = this.sidePanel(side, true);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.firstElementChild as HTMLElement | null;
    if (!next) return;
    // swap the contents, not the node: the panel's own box keeps its place
    // (and its box-shadow transition) while the crest/name/bar change
    active.className = next.className;
    active.innerHTML = next.innerHTML;
  }

  private scrollFocusIntoView(): void {
    const grid = this.body.querySelector<HTMLElement>('#fe-grid');
    const cell = grid?.querySelector<HTMLElement>('.fe-cell.focus');
    if (!grid || !cell) return;
    const top = cell.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop) grid.scrollTop = top - 4;
    else if (top + cell.offsetHeight > grid.scrollTop + grid.clientHeight) {
      grid.scrollTop = top + cell.offsetHeight - grid.clientHeight + 4;
    }
  }

  // --------------------------------------------------------------- settings

  private renderSettings(): void {
    const rows = this.settingsRows();
    const goLabel = this.mode === 'tournament'
      ? (this.overwriteArmed ? '⚠ OVERWRITES YOUR SAVED RUN — PRESS AGAIN' : 'START TOURNAMENT')
      : this.mode === 'shootout' ? 'TO THE SPOT!'
      : this.mode === 'golden' ? 'NEXT GOAL WINS!'
      : this.mode === 'online' ? 'INVITE PLAYERS' : 'KICK OFF!';

    this.body.innerHTML = `
      <div class="${this.anim}">
        <div class="fe-h1">${this.mode === 'tournament' ? 'TOURNAMENT <em>SETTINGS</em>' : 'MATCH <em>SETTINGS</em>'}</div>
        <div class="fe-sub">LAST LOOK BEFORE THE WHISTLE</div>
        <div class="fe-versus">
          ${this.sidePanel(0, false)}
          <div class="fe-vsbadge">${this.mode === 'tournament' ? '★' : 'VS'}</div>
          ${this.sidePanel(1, false)}
        </div>
        <div class="fe-rows" id="fe-rows">
          ${rows.map(([k, v], i) => this.rowHtml(k, v, i)).join('')}
          <div class="fe-go${this.focus === rows.length ? ' focus' : ''}${this.overwriteArmed ? ' armed' : ''}" data-row="${rows.length}">${goLabel}</div>
        </div>
      </div>`;
    this.setFoot(promptBar([
      ['dpadUD', 'SELECT'], ['dpadLR', 'CHANGE'], ['confirm', 'CONFIRM'], ['back', 'BACK'],
    ]));
    this.wireRows(rows.length, () => this.launch());
  }

  private renderPrefs(): void {
    const rows = this.prefRows();
    const notes: Record<string, string> = {
      GRAPHICS: 'HIGH is the full uplift · RETRO is the v1.1 renderer, on purpose',
      COMMENTARY: 'Broadcast ticker and crowd calls',
      MUSIC: 'Menu and match music',
      'CONTROLS HINT': 'The in-match controls card',
      [VOLUME_LABEL.master]: 'Everything the game makes · also on the pause card',
      [VOLUME_LABEL.music]: 'The front-end anthem and the match groove',
      [VOLUME_LABEL.sfx]: 'Terraces, whistles, boots and the woodwork',
      [VOLUME_LABEL.voice]: 'How loud the man in the box is',
    };
    this.body.innerHTML = `
      <div class="${this.anim}">
        <div class="fe-h1">GAME <em>SETTINGS</em></div>
        <div class="fe-sub">SAVED TO THIS BROWSER · NO ACCOUNT, NO CLOUD</div>
        <div class="fe-rows" id="fe-rows">
          ${rows.map(([k, v], i) => this.rowHtml(k, v, i, notes[k])).join('')}
          <div class="fe-go${this.focus === rows.length ? ' focus' : ''}" data-row="${rows.length}">BACK TO MENU</div>
        </div>
      </div>`;
    this.setFoot(promptBar([
      ['dpadUD', 'SELECT'], ['dpadLR', 'CHANGE'], ['confirm', 'CONFIRM'], ['back', 'BACK'],
    ]));
    this.wireRows(rows.length, () => this.go('main'));
  }

  private rowHtml(k: string, v: string, i: number, note?: string): string {
    const bus = VOLUME_BY_LABEL.get(k);
    const value = bus ? volumeRowHtml(bus, k) : esc(v);
    return `<div class="fe-row${bus ? ' fe-row--vol' : ''}${i === this.focus ? ' focus' : ''}" data-row="${i}">
      <span class="fe-row-k">${esc(k)}${note ? `<small class="fe-row-sub">${esc(note)}</small>` : ''}</span>
      <span class="fe-row-v"><u>◀</u>${value}<u>▶</u></span>
    </div>`;
  }

  private wireRows(goRow: number, onGo: () => void): void {
    wireVolumeRows(this.body);
    this.body.querySelectorAll<HTMLElement>('.fe-row').forEach((el) => {
      const row = Number(el.dataset.row);
      el.addEventListener('mouseenter', () => {
        if (!mouseIsLive()) return; this.focus = row; this.refocusRows(); });
      el.addEventListener('click', () => {
        this.focus = row;
        if (this.screen === 'prefs') this.cycleKey(this.prefRows()[row][0], 1);
        else this.cycleSetting(row, 1);
        this.paint();
      });
    });
    const go = this.body.querySelector<HTMLElement>('.fe-go');
    go?.addEventListener('mouseenter', () => {
        if (!mouseIsLive()) return; this.focus = goRow; this.refocusRows(); });
    go?.addEventListener('click', () => { this.focus = goRow; onGo(); });
  }

  private refocusRows(): void {
    this.body.querySelectorAll<HTMLElement>('.fe-row').forEach((el) => {
      el.classList.toggle('focus', Number(el.dataset.row) === this.focus);
    });
    const go = this.body.querySelector<HTMLElement>('.fe-go');
    go?.classList.toggle('focus', Number(go.dataset.row) === this.focus);
  }
}

/** Two different, decent teams to dress the title-screen backdrop in. */
function randomPair(): [TeamData, TeamData] {
  const pool = TEAMS.filter((t) => t.tier >= 4);
  const src = pool.length >= 2 ? pool : TEAMS;
  const a = src[Math.floor(Math.random() * src.length)];
  let b = a;
  let guard = 0;
  while (b.id === a.id && guard++ < 50) b = src[Math.floor(Math.random() * src.length)];
  return [a, b];
}
