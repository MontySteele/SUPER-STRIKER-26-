// Host side of the remote guest link (§5.4). The PeerJS public broker carries
// signaling only; once the DataChannels are up every input byte goes straight
// browser-to-browser and no game traffic touches any server. Guests land in
// the InputHub as 'remote' devices, so past that point the sim genuinely
// cannot tell a friend in another city from the pad on the coffee table.

import Peer, { type DataConnection } from 'peerjs';
import type { InputHub } from '../input/input';
import {
  CTL_LABEL, IN_LABEL, TAG_PONG,
  applyInput, brokerOptions, decodeInput, decodeProbe, encodeProbe, hostPeerId,
  joinUrl, newRoomCode, readGuestIdentity, seqAhead,
  type GuestControl, type GuestIdentity, type GuestInputType, type HostControl,
  type SlotBrief,
} from './protocol';
import { seatHealth, type SeatHealth } from './health';
import { SEAT_SLOTS } from '../sim/match';

export type HostStatus = 'idle' | 'starting' | 'ready' | 'error';

/** A full 2v2 of remote guests, and no seat left over to fight over. */
const MAX_GUESTS = SEAT_SLOTS;

export interface Guest {
  /** InputHub remote index — stable across rejoins with the same token. */
  readonly id: number;
  readonly token: string;
  name: string;
  input: GuestInputType;
  /** Seat slot (0 = P1 … 3 = P4), null = watching. Reserved across a dropout. */
  slot: number | null;
  /** RTT the guest measured on its own input channel, ms (-1 = unknown). */
  rttMs: number;
  /** Both DataChannels are open right now. */
  connected: boolean;
}

interface Entry {
  guest: Guest;
  ctl: DataConnection | null;
  input: DataConnection | null;
  /** performance.now() of the last hot-path packet — drives every timer. */
  lastPacket: number;
  lastSeq: number | null;
  prevButtons: number;
}

export class GuestHost {
  /** Regenerated every time the lobby opens; dies with close(). */
  readonly code = newRoomCode();
  /** Seat slots the lobby offers (§5.4.6): two a side, partners optional. */
  readonly slotCount = SEAT_SLOTS;

  status: HostStatus = 'idle';
  error: string | null = null;
  /** Fired on any join / leave / rename / assignment so UI can re-render. */
  onChange: (() => void) | null = null;

  /** What the host wants each slot to say on the guest's banner. */
  describeSlot: ((slot: number) => Omit<SlotBrief, 'slot'> | null) | null = null;
  phase: 'lobby' | 'match' | 'over' = 'lobby';
  note: string | null = null;

  private peer: Peer | null = null;
  /** Keyed by rejoin token so a reload lands back in the same seat. */
  private entries = new Map<string, Entry>();
  private nextId = 0;
  private closed = false;

  constructor(private hub: InputHub) {}

  /** The URL printed (and QR'd) on the lobby screen. */
  url(): string {
    return joinUrl(this.code);
  }

  open(): void {
    if (this.peer || this.closed) return;
    this.status = 'starting';
    this.error = null;
    let peer: Peer;
    try {
      peer = new Peer(hostPeerId(this.code), brokerOptions());
    } catch (err) {
      this.fail(`Could not reach the signaling broker (${String(err)}).`);
      return;
    }
    this.peer = peer;
    peer.on('open', () => {
      this.status = 'ready';
      this.onChange?.();
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('error', (err) => {
      // 'unavailable-id' means another tab already claimed this room code —
      // the fix is a fresh lobby, so say exactly that instead of "error".
      const type = (err as { type?: string }).type ?? '';
      if (type === 'unavailable-id') {
        this.fail('That room code is already in use. Close the lobby and open a new one.');
      } else if (type === 'peer-unavailable') {
        return; // a guest went away mid-handshake; not our problem
      } else {
        this.fail(`Signaling failed (${type || String(err)}). Check your connection.`);
      }
    });
    peer.on('disconnected', () => {
      // broker socket dropped: existing DataChannels keep working, but nobody
      // new can find us until it comes back
      if (!this.closed) peer.reconnect();
    });
  }

  close(): void {
    this.closed = true;
    for (const e of this.entries.values()) {
      try { e.ctl?.close(); } catch { /* already gone */ }
      try { e.input?.close(); } catch { /* already gone */ }
      this.hub.removeRemote(e.guest.id);
    }
    this.entries.clear();
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.peer = null;
    this.status = 'idle';
    this.onChange?.();
  }

  list(): Guest[] {
    return [...this.entries.values()].map((e) => e.guest).sort((a, b) => a.id - b.id);
  }

  byId(id: number): Guest | null {
    for (const e of this.entries.values()) if (e.guest.id === id) return e.guest;
    return null;
  }

  guestForSlot(slot: number): Guest | null {
    for (const e of this.entries.values()) if (e.guest.slot === slot) return e.guest;
    return null;
  }

  /**
   * Seat a guest (or un-seat it with null); one guest per slot. A no-op when
   * nothing moves — the lobby re-asserts the whole seating on every refresh.
   */
  assign(id: number, slot: number | null): void {
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.guest.id === id) {
        if (e.guest.slot !== slot) { e.guest.slot = slot; changed = true; }
      } else if (slot !== null && e.guest.slot === slot) {
        e.guest.slot = null;
        changed = true;
      }
    }
    if (!changed) return;
    this.broadcast();
    this.onChange?.();
  }

  /**
   * Milliseconds since this guest's last input packet. Infinity if it never
   * arrived — the caller's degrade/pause/AI ladder reads nothing else.
   */
  packetAge(id: number, now = performance.now()): number {
    for (const e of this.entries.values()) {
      if (e.guest.id === id) return now - e.lastPacket;
    }
    return Infinity;
  }

  health(id: number, now = performance.now()): SeatHealth {
    return seatHealth(this.packetAge(id, now));
  }

  /** Push the current slot/phase picture to every connected guest. */
  broadcast(): void {
    for (const e of this.entries.values()) this.sendState(e);
  }

  // ------------------------------------------------------------- connections

  private accept(conn: DataConnection): void {
    const id = readGuestIdentity(conn.metadata);
    if (!id) { safeClose(conn); return; }
    if (conn.label !== CTL_LABEL && conn.label !== IN_LABEL) { safeClose(conn); return; }

    let entry = this.entries.get(id.token);
    if (!entry) {
      if (this.entries.size >= MAX_GUESTS) {
        conn.on('open', () => {
          send(conn, { t: 'reject', reason: 'This match is full.' } satisfies HostControl);
          window.setTimeout(() => safeClose(conn), 200);
        });
        return;
      }
      entry = this.makeEntry(id);
      this.entries.set(id.token, entry);
    }
    entry.guest.name = id.name;
    entry.guest.input = id.input;

    if (conn.label === CTL_LABEL) this.attachControl(entry, conn);
    else this.attachInput(entry, conn);
    this.onChange?.();
  }

  private makeEntry(id: GuestIdentity): Entry {
    const guest: Guest = {
      id: this.nextId++,
      token: id.token,
      name: id.name,
      input: id.input,
      slot: null,
      rttMs: -1,
      connected: false,
    };
    this.hub.remote(guest.id); // create the device up front so seats can bind
    // the heartbeat clock starts the moment they arrive, not at the first
    // packet — otherwise a guest is "15s gone" for the frame before it speaks
    return {
      guest, ctl: null, input: null,
      lastPacket: performance.now(), lastSeq: null, prevButtons: 0,
    };
  }

  private attachControl(entry: Entry, conn: DataConnection): void {
    safeClose(entry.ctl); // a reload supersedes the stale channel
    entry.ctl = conn;
    conn.on('open', () => {
      this.refreshConnected(entry);
      this.sendState(entry);
      this.onChange?.();
    });
    conn.on('data', (raw) => this.onControl(entry, raw));
    conn.on('close', () => {
      if (entry.ctl === conn) entry.ctl = null;
      this.refreshConnected(entry);
      this.onChange?.();
    });
    conn.on('error', () => { /* close follows */ });
  }

  private attachInput(entry: Entry, conn: DataConnection): void {
    safeClose(entry.input);
    entry.input = conn;
    entry.lastSeq = null;
    conn.on('open', () => {
      entry.lastPacket = performance.now(); // a rejoin resets the ladder
      this.refreshConnected(entry);
      this.onChange?.();
    });
    conn.on('data', (raw) => this.onInput(entry, conn, raw));
    conn.on('close', () => {
      if (entry.input === conn) entry.input = null;
      // a dead channel is a dead controller: go neutral like a yanked pad, but
      // KEEP the entry so the rejoin token still owns the slot
      this.hub.remote(entry.guest.id).neutralize();
      this.refreshConnected(entry);
      this.onChange?.();
    });
    conn.on('error', () => { /* close follows */ });
  }

  private refreshConnected(entry: Entry): void {
    entry.guest.connected = !!entry.ctl?.open && !!entry.input?.open;
  }

  // ------------------------------------------------------------- hot path

  private onInput(entry: Entry, conn: DataConnection, raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const data = raw as ArrayBuffer | ArrayBufferView;

    const probe = decodeProbe(data);
    if (probe) {
      // bounce it back unchanged — the guest owns the clock, we own nothing
      if (conn.open) conn.send(encodeProbe(TAG_PONG, probe.stamp));
      return;
    }

    const pkt = decodeInput(data);
    if (!pkt) return;
    // an unreliable channel reorders and duplicates by design; only newer wins
    if (entry.lastSeq !== null && seqAhead(pkt.seq, entry.lastSeq) <= 0) return;
    entry.lastSeq = pkt.seq;
    entry.lastPacket = performance.now();

    // levels on the wire, edges in the hub — same 150ms buffer as a gamepad
    entry.prevButtons = applyInput(
      this.hub.remote(entry.guest.id), pkt, entry.prevButtons,
      () => this.hub.onAnyButton?.(), // unlocks audio / advances cards, like any pad
    );
  }

  // ------------------------------------------------------------- control path

  private onControl(entry: Entry, raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as GuestControl;
    if (msg.t === 'hello') {
      const id = readGuestIdentity(msg);
      if (!id) return;
      entry.guest.name = id.name;
      entry.guest.input = id.input;
      this.sendState(entry);
      this.onChange?.();
    } else if (msg.t === 'input') {
      entry.guest.input = msg.input === 'gamepad' ? 'gamepad' : 'keyboard';
      this.onChange?.();
    } else if (msg.t === 'rtt') {
      const ms = typeof msg.ms === 'number' && Number.isFinite(msg.ms) ? msg.ms : -1;
      entry.guest.rttMs = Math.max(-1, Math.min(9999, Math.round(ms)));
      this.onChange?.();
    }
  }

  private sendState(entry: Entry): void {
    const slot = entry.guest.slot;
    const desc = slot !== null ? this.describeSlot?.(slot) ?? null : null;
    const msg: HostControl = {
      t: 'state',
      phase: this.phase,
      brief: desc && slot !== null ? { slot, ...desc } : null,
      ...(this.note ? { note: this.note } : {}),
    };
    send(entry.ctl, msg);
  }

  private fail(message: string): void {
    this.status = 'error';
    this.error = message;
    this.onChange?.();
  }
}

function send(conn: DataConnection | null, msg: HostControl): void {
  if (conn?.open) {
    try { conn.send(msg); } catch { /* channel died between checks */ }
  }
}

function safeClose(conn: DataConnection | null): void {
  try { conn?.close(); } catch { /* already gone */ }
}
