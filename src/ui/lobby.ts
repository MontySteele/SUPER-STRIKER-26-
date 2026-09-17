// INVITE PLAYERS lobby (§5.4.2/§5.4.6): the host's side of a remote match, 1v1
// or 2v2. Shows the join URL, the room code in large type, a corner QR, and a
// live list of guests with their input type and connection pip — then seats
// everyone and kicks off. Four slots, numbered the way the sim numbers them:
// P1/P2 are the two sides' on-ball players, P3/P4 their partners. Fill two and
// it's a 1v1; fill four and it's a 2v2.
//
// Front-end uplift: the four slots are now four seat cards side by side, the
// way a console lobby lays them out, with controller glyphs, kit colours and a
// live "PRESS ANY BUTTON TO JOIN" — an unseated pad that presses anything
// takes the first free seat by itself. Navigation is pad-first (MenuNav), the
// keyboard bindings still work, and the seating logic below is untouched.

import './menu.css';
import type { TeamData } from '../data/types';
import type { GuestHost } from '../net/hostLink';
import { slotRole, slotTeam } from '../sim/match';
import { esc } from './escape';
import { drawQr } from './qr';
import { MenuNav, type NavDir } from './menuNav';
import { promptBar } from './menuGlyphs';
import { readableOn } from './menuKit';

/** Who is driving a slot. 'guest' carries the InputHub remote index. */
export type SlotDevice =
  | { kind: 'keyboard' }
  | { kind: 'pad'; index: number }
  | { kind: 'guest'; id: number };

/** By seat slot: [team0, team1, team0 partner, team1 partner]. */
export type SlotAssignment = (SlotDevice | null)[];

interface Candidate {
  device: SlotDevice;
  label: string;
  /** Guests that aren't connected can be seated but are called out. */
  warn: boolean;
}

/** Seat accent colours — the same P1..P4 order the sim uses. */
const SEAT_ACCENT = ['#ffce4a', '#dde4f0', '#ff8c2e', '#5ec8ff'];

export class Lobby {
  /** Clash-resolved shirts, set by main so the banner matches the pitch. */
  shirts: [string, string] = ['#ffffff', '#ffffff'];

  private root: HTMLElement;
  /** The slot cards, then the START row at the end. */
  private readonly startRow: number;
  private focus: number;
  private slots: SlotAssignment;
  private nav: MenuNav;
  private padHandler: () => void;
  private pollId: number;
  private alive = true;
  /** last-seen button state per pad, for "press any button to join" */
  private padPrev = new Map<number, boolean>();

  constructor(
    private host: GuestHost,
    private teams: [TeamData, TeamData],
    private onStart: (slots: SlotAssignment) => void,
    private onCancel: () => void,
  ) {
    this.root = document.getElementById('ui-root')!;
    this.slots = new Array<SlotDevice | null>(host.slotCount).fill(null);
    this.slots[0] = { kind: 'keyboard' };
    this.startRow = host.slotCount;
    this.focus = this.startRow; // the common case is "everyone's here, go"
    this.nav = new MenuNav({
      onDir: (d) => this.onDir(d),
      onConfirm: () => this.onConfirm(),
      onBack: () => this.cancel(),
      onAlt: () => this.cycleFocused(-1),
      onShoulder: (d) => this.cycleFocused(d),
    });
    this.padHandler = () => this.refresh();
    window.addEventListener('gamepadconnected', this.padHandler);
    window.addEventListener('gamepaddisconnected', this.padHandler);
    // pips are driven by packet age, which nothing else pokes us about; the
    // same tick watches for an idle pad asking for a seat
    this.pollId = window.setInterval(() => {
      this.watchPads();
      this.refresh();
    }, 250);
    this.host.onChange = () => this.refresh();
    this.host.phase = 'lobby';
    this.host.describeSlot = (slot) => this.briefFor(slot);
    this.render();
  }

  destroy(): void {
    this.alive = false;
    window.clearInterval(this.pollId);
    this.nav.destroy();
    window.removeEventListener('gamepadconnected', this.padHandler);
    window.removeEventListener('gamepaddisconnected', this.padHandler);
    this.host.onChange = null;
    this.root.innerHTML = '';
  }

  /** Kit colors + team name the guest's slot banner is painted in. */
  private briefFor(slot: number): { teamName: string; teamCode: string; shirt: string; text: string } | null {
    const side = slotTeam(slot);
    const team = this.teams[side];
    if (!team) return null;
    const shirt = this.shirts[side];
    return {
      teamName: team.name,
      teamCode: team.code,
      shirt,
      text: readableOn(shirt),
    };
  }

  // ------------------------------------------------------------- assignment

  private candidates(slot: number): Candidate[] {
    // one device, one slot — another seat's pick never shows up in this ring
    const taken = (d: SlotDevice): boolean =>
      this.slots.some((o, i) => i !== slot && !!o && sameDevice(o, d));

    const out: Candidate[] = [];
    const push = (device: SlotDevice, label: string, warn = false): void => {
      if (!taken(device)) out.push({ device, label, warn });
    };
    push({ kind: 'keyboard' }, 'LOCAL — KEYBOARD');
    for (const i of connectedPadIndices()) push({ kind: 'pad', index: i }, `LOCAL — GAMEPAD ${i + 1}`);
    for (const g of this.host.list()) {
      const kind = g.input === 'gamepad' ? 'GAMEPAD' : 'KEYBOARD';
      push({ kind: 'guest', id: g.id }, `${g.name.toUpperCase()} — ${kind}`, !g.connected);
    }
    return out;
  }

  private labelFor(slot: number): string {
    const d = this.slots[slot];
    if (!d) return 'OPEN';
    const found = this.candidates(slot).find((c) => sameDevice(c.device, d));
    if (found) return found.label;
    // the pad was unplugged / the guest vanished between renders
    return d.kind === 'guest'
      ? `${this.host.byId(d.id)?.name.toUpperCase() ?? 'GUEST'} — GONE`
      : d.kind === 'pad' ? `GAMEPAD ${d.index + 1} — GONE` : 'LOCAL — KEYBOARD';
  }

  /** The badge on a seat card. Letters, not emoji — see the CSS note. */
  private iconFor(slot: number): string {
    const d = this.slots[slot];
    if (!d) return '+';
    if (d.kind === 'pad') return `P${d.index + 1}`;
    if (d.kind === 'guest') return 'NET';
    return 'KEY';
  }

  private cycle(slot: number, dir: number): void {
    const list = this.candidates(slot);
    if (list.length === 0) { this.slots[slot] = null; return; }
    const current = this.slots[slot];
    const at = current ? list.findIndex((c) => sameDevice(c.device, current)) : -1;
    // the ring includes "empty" so a slot can always be cleared
    const ring: (SlotDevice | null)[] = [...list.map((c) => c.device), null];
    const i = at >= 0 ? at : ring.length - 1;
    this.slots[slot] = ring[(i + dir + ring.length) % ring.length];
    this.pushAssignments();
  }

  /** Mirror the seating to the guests so their banners are truthful. */
  private pushAssignments(): void {
    for (const g of this.host.list()) {
      const slot = this.slots.findIndex((d) => d?.kind === 'guest' && d.id === g.id);
      this.host.assign(g.id, slot >= 0 ? slot : null);
    }
  }

  /** A guest who just arrived takes the first slot nobody is sitting in. */
  private autoSeat(): boolean {
    let changed = false;
    for (const g of this.host.list()) {
      if (!g.connected) continue;
      if (this.slots.some((d) => d?.kind === 'guest' && d.id === g.id)) continue;
      const free = this.slots.findIndex((d) => d === null);
      if (free < 0) continue;
      this.slots[free] = { kind: 'guest', id: g.id };
      changed = true;
    }
    return changed;
  }

  /**
   * "PRESS ANY BUTTON TO JOIN": a connected pad that nobody has seated yet
   * takes the first free seat the moment it is touched. This reads the pads
   * directly — the InputHub's poller is a match-loop thing and is not running.
   */
  private watchPads(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const down = gp.buttons.some((b) => b.pressed);
      const was = this.padPrev.get(gp.index) ?? false;
      this.padPrev.set(gp.index, down);
      if (!down || was) continue;
      const seated = this.slots.some((d) => d?.kind === 'pad' && d.index === gp.index);
      if (seated) continue;
      const free = this.slots.findIndex((d) => d === null);
      if (free < 0) continue;
      this.slots[free] = { kind: 'pad', index: gp.index };
      this.pushAssignments();
    }
  }

  /** One human a side is the minimum; the partner slots are optional. */
  private canStart(): boolean {
    return this.slots[0] !== null && this.slots[1] !== null;
  }

  /** What the START row promises: 1v1, 2v1, 2v2. */
  private lineup(): string {
    const per = [0, 1].map((t) => this.slots.filter((d, i) => d && slotTeam(i) === t).length);
    return per[0] + 'v' + per[1];
  }

  // ------------------------------------------------------------------ input

  private onDir(d: NavDir): void {
    if (d === 'left' || d === 'right') {
      if (this.focus >= this.startRow) return;
      this.focus = Math.max(0, Math.min(this.startRow - 1, this.focus + (d === 'left' ? -1 : 1)));
      this.render();
      return;
    }
    if (d === 'down') {
      this.focus = this.startRow;
      this.render();
      return;
    }
    // up out of the START row lands on the seat you were last on
    if (this.focus === this.startRow) {
      this.focus = 0;
      this.render();
    }
  }

  private onConfirm(): void {
    if (this.focus < this.startRow) this.cycleFocused(1);
    else this.start();
  }

  private cycleFocused(dir: number): void {
    if (this.focus >= this.startRow) return;
    this.cycle(this.focus, dir);
    this.render();
  }

  private cancel(): void {
    this.destroy();
    this.onCancel();
  }

  private start(): void {
    if (!this.canStart()) return;
    const slots = this.slots;
    this.destroy();
    this.onStart(slots);
  }

  // ----------------------------------------------------------------- render

  refresh(): void {
    if (!this.alive) return;
    if (this.autoSeat()) this.pushAssignments();
    this.render();
  }

  /**
   * The chrome, painted once. Everything that ticks (pips, seats, the START
   * row) is re-filled by paint() so the entry animation and the seat-card
   * transitions are not restarted four times a second.
   */
  private mount(): void {
    const url = this.host.url();
    this.root.innerHTML = `
      <div class="fe fe-skin fe--solid">
        <div class="fe-vignette"></div>
        <div class="fe-layer">
          <div class="fe-topbar">
            <div class="fe-mark">SUPER<b>STRIKER</b></div>
            <div class="fe-crumb"><span>MAIN MENU</span><i>›</i><span class="on">INVITE PLAYERS</span></div>
            <div class="fe-topbar-rule"></div>
          </div>
          <div class="fe-body">
            <div class="fe-anim">
              <div class="fe-h1">THE <em>LOBBY</em></div>
              <div class="fe-sub">SEND THE CODE · THEY PLAY FROM THEIR OWN LAPTOP · NO ACCOUNT</div>
              <div id="fe-lobby-status"></div>
              <div class="fe-invite">
                <div class="fe-invite-wrap">
                  <div class="fe-invite-k">ROOM CODE</div>
                  <div class="fe-invite-code">${esc(this.host.code)}</div>
                  <div class="fe-invite-url">${esc(url)}</div>
                </div>
                <canvas class="fe-qr"></canvas>
              </div>
              <div class="fe-guests" id="fe-lobby-guests"></div>
              <div class="fe-seats" id="fe-lobby-seats"></div>
              <div class="fe-go" id="fe-lobby-go"></div>
            </div>
          </div>
          ${promptBar([
            ['dpadLR', 'SEAT'], ['confirm', 'CHANGE'], ['l1', 'PREV'], ['r1', 'NEXT'],
            ['dpadUD', 'KICK OFF'], ['back', 'CANCEL'],
          ])}
        </div>
      </div>`;
    const qr = this.root.querySelector<HTMLCanvasElement>('.fe-qr')!;
    try {
      drawQr(qr, url, 3);
    } catch {
      qr.style.display = 'none'; // URL too long for the mini encoder
    }
    this.root.querySelector<HTMLElement>('#fe-lobby-go')?.addEventListener('click', () => this.start());
  }

  private render(): void {
    if (!this.root.querySelector('#fe-lobby-seats')) this.mount();
    const guests = this.host.list();
    const now = performance.now();

    const status = this.host.status === 'error'
      ? `<div class="fe-status">${esc(this.host.error ?? 'Signaling failed.')}</div>`
      : this.host.status !== 'ready'
        ? '<div class="fe-status warm">OPENING THE ROOM…</div>'
        : '';

    const guestRows = guests.length === 0
      ? '<div class="fe-guest empty">NOBODY YET — SEND THEM THE LINK</div>'
      : guests.map((g) => {
        const health = g.connected ? this.host.health(g.id, now) : 'lost';
        const pip = health === 'ok' ? 'ok' : health === 'degraded' ? 'warn' : '';
        const rtt = g.rttMs >= 0 ? `${g.rttMs} MS` : '—';
        const seatTag = g.slot === null ? 'WATCHING' : `PLAYER ${g.slot + 1}`;
        return `<div class="fe-guest">
            <span class="fe-pip ${pip}"></span>
            <span class="fe-gname">${esc(g.name.toUpperCase())}</span>
            <span>${g.input === 'gamepad' ? 'GAMEPAD' : 'KEYBOARD'}</span>
            <span>${rtt}</span>
            <span class="fe-gseat">${seatTag}</span>
          </div>`;
      }).join('');

    const seatCard = (i: number): string => {
      const side = slotTeam(i);
      const team = this.teams[side];
      const picked = this.slots[i];
      // an empty PARTNER slot is a choice, not a problem — only the two
      // on-ball slots get nagged about
      const seated = !!picked
        && this.candidates(i).some((c) => sameDevice(c.device, picked) && !c.warn);
      const warn = slotRole(i) === 0 ? !seated : (!!picked && !seated);
      // NB: no focus class here — it is toggled below, so moving the cursor
      // never rebuilds the cards and the lift transition actually plays
      const cls = ['fe-seat', picked ? '' : 'open', warn ? 'warn' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" data-row="${i}" style="--fe-accent:${SEAT_ACCENT[i] ?? '#55607a'}">
          <div class="fe-seat-no">PLAYER ${i + 1}</div>
          ${slotRole(i) === 0 ? '' : '<div class="fe-seat-role">2ND</div>'}
          <div class="fe-seat-team">
            <span class="fe-dot" style="background:${esc(this.shirts[side])}"></span>${esc(team.name)}
          </div>
          <div class="fe-seat-pad">${this.iconFor(i)}</div>
          <div class="fe-seat-dev"><u>◀</u>${picked ? esc(this.labelFor(i)) : 'PRESS ANY BUTTON'}<u>▶</u></div>
        </div>`;
    };

    const statusEl = this.root.querySelector<HTMLElement>('#fe-lobby-status');
    if (statusEl && statusEl.innerHTML !== status) statusEl.innerHTML = status;
    const guestEl = this.root.querySelector<HTMLElement>('#fe-lobby-guests');
    if (guestEl && guestEl.innerHTML !== guestRows) guestEl.innerHTML = guestRows;

    const seatsEl = this.root.querySelector<HTMLElement>('#fe-lobby-seats')!;
    const cards = this.slots.map((_, i) => seatCard(i)).join('');
    if (seatsEl.innerHTML !== cards) {
      seatsEl.innerHTML = cards;
      seatsEl.querySelectorAll<HTMLElement>('.fe-seat').forEach((el) => {
        el.addEventListener('click', () => {
          this.focus = Number(el.dataset.row);
          this.cycle(this.focus, 1);
          this.render();
        });
      });
    }
    seatsEl.querySelectorAll<HTMLElement>('.fe-seat').forEach((el, i) => {
      el.classList.toggle('focus', i === this.focus);
    });

    const goEl = this.root.querySelector<HTMLElement>('#fe-lobby-go')!;
    const goText = this.canStart() ? `KICK OFF! — ${this.lineup()}` : 'FILL PLAYER 1 AND PLAYER 2 TO KICK OFF';
    if (goEl.textContent?.trim() !== goText) goEl.textContent = goText;
    goEl.classList.toggle('focus', this.focus === this.startRow);
    goEl.classList.toggle('disabled', !this.canStart());
  }
}

function sameDevice(a: SlotDevice, b: SlotDevice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'pad' && b.kind === 'pad') return a.index === b.index;
  if (a.kind === 'guest' && b.kind === 'guest') return a.id === b.id;
  return true;
}

function connectedPadIndices(): number[] {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  const out: number[] = [];
  for (const gp of pads) if (gp) out.push(gp.index);
  return out;
}

/** Still exported from here: main.ts imports it from this module. */
export { readableOn };
