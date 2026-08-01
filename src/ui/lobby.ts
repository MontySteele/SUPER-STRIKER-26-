// INVITE PLAYERS lobby (§5.4.2): the host's side of a remote 1v1. Shows the
// join URL, the room code in large type, a corner QR, and a live list of
// guests with their input type and connection pip — then seats everyone and
// kicks off. Navigated exactly like the rest of the menus (WASD + J / K).

import type { TeamData } from '../data/types';
import type { GuestHost } from '../net/hostLink';
import { esc } from './escape';
import { drawQr } from './qr';

/** Who is driving a slot. 'guest' carries the InputHub remote index. */
export type SlotDevice =
  | { kind: 'keyboard' }
  | { kind: 'pad'; index: number }
  | { kind: 'guest'; id: number };

export type SlotAssignment = [SlotDevice | null, SlotDevice | null];

interface Candidate {
  device: SlotDevice;
  label: string;
  /** Guests that aren't connected can be seated but are called out. */
  warn: boolean;
}

export class Lobby {
  /** Clash-resolved shirts, set by main so the banner matches the pitch. */
  shirts: [string, string] = ['#ffffff', '#ffffff'];

  private root: HTMLElement;
  private focus = 2; // START row: the common case is "everyone's here, go"
  private slots: SlotAssignment = [{ kind: 'keyboard' }, null];
  private keyHandler: (e: KeyboardEvent) => void;
  private padHandler: () => void;
  private pollId: number;
  private alive = true;

  constructor(
    private host: GuestHost,
    private teams: [TeamData, TeamData],
    private onStart: (slots: SlotAssignment) => void,
    private onCancel: () => void,
  ) {
    this.root = document.getElementById('ui-root')!;
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    this.padHandler = () => this.refresh();
    window.addEventListener('gamepadconnected', this.padHandler);
    window.addEventListener('gamepaddisconnected', this.padHandler);
    // pips are driven by packet age, which nothing else pokes us about
    this.pollId = window.setInterval(() => this.refresh(), 500);
    this.host.onChange = () => this.refresh();
    this.host.phase = 'lobby';
    this.host.describeSlot = (slot) => this.briefFor(slot);
    this.render();
  }

  destroy(): void {
    this.alive = false;
    window.clearInterval(this.pollId);
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('gamepadconnected', this.padHandler);
    window.removeEventListener('gamepaddisconnected', this.padHandler);
    this.host.onChange = null;
    this.root.innerHTML = '';
  }

  /** Kit colors + team name the guest's slot banner is painted in. */
  private briefFor(slot: number): { teamName: string; teamCode: string; shirt: string; text: string } | null {
    const team = this.teams[slot];
    if (!team) return null;
    const shirt = this.shirts[slot];
    return {
      teamName: team.name,
      teamCode: team.code,
      shirt,
      text: readableOn(shirt),
    };
  }

  // ------------------------------------------------------------- assignment

  private candidates(slot: number): Candidate[] {
    const other = this.slots[1 - slot];
    // one device, one slot — the other seat's pick never shows up in this ring
    const taken = (d: SlotDevice): boolean => !!other && sameDevice(other, d);

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
    if (!d) return '— EMPTY —';
    const found = this.candidates(slot).find((c) => sameDevice(c.device, d));
    if (found) return found.label;
    // the pad was unplugged / the guest vanished between renders
    return d.kind === 'guest'
      ? `${this.host.byId(d.id)?.name.toUpperCase() ?? 'GUEST'} — GONE`
      : d.kind === 'pad' ? `GAMEPAD ${d.index + 1} — GONE` : 'LOCAL — KEYBOARD';
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

  private canStart(): boolean {
    return this.slots[0] !== null && this.slots[1] !== null;
  }

  // ------------------------------------------------------------------ input

  private onKey(e: KeyboardEvent): void {
    const code = e.code;
    const confirm = code === 'KeyJ' || code === 'Enter' || code === 'Space';
    const back = code === 'KeyK' || code === 'Escape' || code === 'Backspace';
    if (e.repeat && (confirm || back)) return;
    const up = code === 'KeyW' || code === 'ArrowUp';
    const down = code === 'KeyS' || code === 'ArrowDown';
    const left = code === 'KeyA' || code === 'ArrowLeft';
    const right = code === 'KeyD' || code === 'ArrowRight';

    if (up) { this.focus = Math.max(0, this.focus - 1); this.render(); }
    else if (down) { this.focus = Math.min(2, this.focus + 1); this.render(); }
    else if ((left || right) && this.focus < 2) {
      this.cycle(this.focus, left ? -1 : 1);
      this.render();
    } else if (confirm) {
      if (this.focus < 2) { this.cycle(this.focus, 1); this.render(); }
      else this.start();
    } else if (back) {
      this.destroy();
      this.onCancel();
    }
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

  private render(): void {
    const url = this.host.url();
    const guests = this.host.list();
    const now = performance.now();

    const status = this.host.status === 'error'
      ? `<div class="lobby-err">${esc(this.host.error ?? 'Signaling failed.')}</div>`
      : this.host.status !== 'ready'
        ? '<div class="lobby-err warm">OPENING THE ROOM…</div>'
        : '';

    const guestRows = guests.length === 0
      ? '<div class="guest-row empty">NOBODY YET — SEND THEM THE LINK</div>'
      : guests.map((g) => {
        const health = g.connected ? this.host.health(g.id, now) : 'lost';
        const pip = health === 'ok' ? 'ok' : health === 'degraded' ? 'warn' : '';
        const rtt = g.rttMs >= 0 ? `${g.rttMs} MS` : '—';
        const seatTag = g.slot === null ? 'WATCHING' : `PLAYER ${g.slot + 1}`;
        return `<div class="guest-row">
            <span class="pip ${pip}"></span>
            <span class="gname">${esc(g.name.toUpperCase())}</span>
            <span class="gkind">${g.input === 'gamepad' ? 'GAMEPAD' : 'KEYBOARD'}</span>
            <span class="grtt">${rtt}</span>
            <span class="gseat">${seatTag}</span>
          </div>`;
      }).join('');

    const slotRow = (i: number): string => {
      const team = this.teams[i];
      const picked = this.slots[i];
      const warn = !picked
        || !this.candidates(i).some((c) => sameDevice(c.device, picked) && !c.warn);
      return `<div class="setting-row${this.focus === i ? ' focus' : ''}" data-row="${i}">
          <span>PLAYER ${i + 1}
            <small class="slot-sub"><span class="swatch-dot" style="background:${esc(this.shirts[i])}"></span>${esc(team.name)}</small>
          </span>
          <span class="value${warn ? ' warn' : ''}">◀ ${esc(this.labelFor(i))} ▶</span>
        </div>`;
    };

    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">INVITE PLAYERS</div>
        ${status}
        <div class="lobby-invite">
          <div class="lobby-code-wrap">
            <div class="lobby-code-label">ROOM CODE</div>
            <div class="lobby-code">${esc(this.host.code)}</div>
            <div class="lobby-url">${esc(url)}</div>
          </div>
          <canvas class="lobby-qr"></canvas>
        </div>
        <div class="guest-list">${guestRows}</div>
        <div class="settings-list">
          ${slotRow(0)}
          ${slotRow(1)}
          <div class="setting-row go${this.focus === 2 ? ' focus' : ''}${this.canStart() ? '' : ' disabled'}" data-row="2">
            ${this.canStart() ? 'KICK OFF!' : 'FILL BOTH SLOTS TO KICK OFF'}
          </div>
        </div>
        <div class="controls-card">W/S SELECT · A/D CHANGE · J CONFIRM · K CANCEL</div>
      </div>`;

    const qr = this.root.querySelector<HTMLCanvasElement>('.lobby-qr')!;
    try {
      drawQr(qr, url, 3);
    } catch {
      qr.style.display = 'none'; // URL too long for the mini encoder
    }
    this.root.querySelectorAll('.setting-row').forEach((el) => {
      el.addEventListener('click', () => {
        const row = Number((el as HTMLElement).dataset.row);
        if (row === 2) this.start();
        else { this.focus = row; this.cycle(row, 1); this.render(); }
      });
    });
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

/** Black or white, whichever survives on the given kit color. */
export function readableOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return '#ffffff';
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#0a0d12' : '#ffffff';
}
