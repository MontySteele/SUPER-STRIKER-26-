// Remote guest wire protocol (§5.4.4). The hot path is a fixed 6-byte binary
// packet — { seq: u16, buttons: u16, stickX: i8, stickY: i8 } — sampled at
// 60Hz and sent ONLY when the state actually changes, plus a 10Hz keepalive.
// No JSON ever touches it. Lobby/control chatter (name, slot, kit colors) is
// ordinary JSON on a separate reliable channel; its shapes live at the bottom
// of this file so both ends compile against one source of truth.

import { ACTIONS, type Action, type DeviceState } from '../input/input';

export const PROTOCOL_VERSION = 1;

/** Every action rides its ACTIONS index; sprint sits just above them. */
export const SPRINT_BIT = ACTIONS.length; // 8
export const INPUT_PACKET_BYTES = 6;

/** Packets under this deflection read as a centred stick (i8 quantisation). */
const STICK_DEADZONE = 0.12;

export interface InputPacket {
  seq: number;      // u16, wraps
  buttons: number;  // u16 bitfield: ACTIONS bits + SPRINT_BIT
  stickX: number;   // -1..1
  stickY: number;   // -1..1
}

/** Pack the sampled seat state into the 6-byte hot-path packet. */
export function encodeInput(seq: number, buttons: number, x: number, y: number): Uint8Array {
  const buf = new Uint8Array(INPUT_PACKET_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint16(0, seq & 0xffff);
  view.setUint16(2, buttons & 0xffff);
  view.setInt8(4, quantAxis(x));
  view.setInt8(5, quantAxis(y));
  return buf;
}

/** Decode a hot-path packet. Returns null for anything that isn't one. */
export function decodeInput(data: ArrayBuffer | ArrayBufferView): InputPacket | null {
  const view = toView(data);
  if (!view || view.byteLength !== INPUT_PACKET_BYTES) return null;
  const x = view.getInt8(4) / 127;
  const y = view.getInt8(5) / 127;
  const live = Math.hypot(x, y) > STICK_DEADZONE;
  return {
    seq: view.getUint16(0),
    buttons: view.getUint16(2),
    stickX: live ? clamp1(x) : 0,
    stickY: live ? clamp1(y) : 0,
  };
}

/**
 * Signed distance from `prev` to `seq` across the u16 wrap. Positive means
 * `seq` is newer — the host drops anything <= 0 (duplicate or reordered,
 * which an unreliable channel delivers by design).
 */
export function seqAhead(seq: number, prev: number): number {
  return (((seq - prev) & 0xffff) ^ 0x8000) - 0x8000;
}

/** Read bit `i` of a packed button field. */
export function buttonBit(buttons: number, i: number): boolean {
  return (buttons & (1 << i)) !== 0;
}

/** Action for a button-field bit index, or null for sprint / padding. */
export function actionForBit(i: number): Action | null {
  return ACTIONS[i] ?? null;
}

/**
 * Fold a decoded packet into a DeviceState. The wire carries levels, not
 * edges — the host diffs against the last accepted bitfield and synthesizes
 * the press/release the 150ms input buffer expects, so a remote guest is
 * genuinely indistinguishable from a gamepad by the time the sim reads it.
 * Returns the button field to diff the next packet against.
 */
export function applyInput(
  dev: DeviceState, pkt: InputPacket, prevButtons: number, onPress?: () => void,
): number {
  const changed = pkt.buttons ^ prevButtons;
  for (let bit = 0; bit < SPRINT_BIT; bit++) {
    if (!buttonBit(changed, bit)) continue;
    const action = actionForBit(bit);
    if (!action) continue;
    if (buttonBit(pkt.buttons, bit)) {
      dev.press(action);
      onPress?.();
    } else {
      dev.release(action);
    }
  }
  dev.sprintHeld = buttonBit(pkt.buttons, SPRINT_BIT);
  dev.stick = { x: pkt.stickX, y: pkt.stickY };
  return pkt.buttons;
}

// ------------------------------------------------------------------ ping/pong
// Latency probes ride the same unreliable channel as the input packets, so the
// number the guest displays is the one the gameplay path actually pays. Tagged
// by length: 6 bytes is always an input packet, 5 is always a probe.

export const TAG_PING = 0x01;
export const TAG_PONG = 0x02;
const PROBE_BYTES = 5;

export function encodeProbe(tag: number, stamp: number): Uint8Array {
  const buf = new Uint8Array(PROBE_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint8(0, tag);
  view.setUint32(1, stamp >>> 0);
  return buf;
}

export function decodeProbe(data: ArrayBuffer | ArrayBufferView): { tag: number; stamp: number } | null {
  const view = toView(data);
  if (!view || view.byteLength !== PROBE_BYTES) return null;
  const tag = view.getUint8(0);
  if (tag !== TAG_PING && tag !== TAG_PONG) return null;
  return { tag, stamp: view.getUint32(1) };
}

// -------------------------------------------------------------- room identity

/** No 0/O/1/I/L — a code is read off a screen and typed by a human. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function newRoomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function isRoomCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/**
 * The host's broker id, derived from the room code alone — a guest that knows
 * only "MK7Q" can reach us. The namespace + derived suffix keep us out of
 * every other PeerJS app's id space and make a blind squat of a live room
 * impractical; it is NOT a secret (anyone with the code, by design, gets in).
 */
export function hostPeerId(code: string): string {
  const salted = `SUPER-STRIKER-26/room/v${PROTOCOL_VERSION}/${code}`;
  return `ss26-v${PROTOCOL_VERSION}-${code}-${fnv1a(salted)}`;
}

/** The URL a guest opens: join.html on this origin, code pre-filled. */
export function joinUrl(code: string): string {
  const dir = location.pathname.replace(/[^/]*$/, '');
  return `${location.origin}${dir}join.html?c=${code}${brokerParam()}`;
}

// ------------------------------------------------------------------- broker
// Signaling defaults to the PeerJS public broker, which is a free service with
// no promises attached. `?b=<origin>` (persisted in localStorage) points both
// ends at your own PeerServer instead — the only reason this exists, since no
// game traffic goes through either one.

const BROKER_KEY = 'ss26-broker';

function brokerOrigin(): string {
  const fromUrl = new URLSearchParams(location.search).get('b');
  if (fromUrl !== null) {
    try { localStorage.setItem(BROKER_KEY, fromUrl); } catch { /* fine */ }
    return fromUrl;
  }
  try { return localStorage.getItem(BROKER_KEY) ?? ''; } catch { return ''; }
}

/** PeerJS constructor options: `{}` for the public broker, or your own. */
export function brokerOptions(): { debug: number; host?: string; port?: number; path?: string; secure?: boolean } {
  const origin = brokerOrigin();
  if (!origin) return { debug: 0 };
  try {
    const u = new URL(origin);
    return {
      debug: 0,
      host: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
      path: u.pathname === '/' ? '/' : u.pathname,
      secure: u.protocol === 'https:',
    };
  } catch {
    return { debug: 0 }; // unparseable: fall back to the public broker
  }
}

/** Carry a custom broker into the join URL — the guest needs the same one. */
function brokerParam(): string {
  const origin = brokerOrigin();
  return origin ? `&b=${encodeURIComponent(origin)}` : '';
}

// ------------------------------------------------------------ control channel
// Reliable + ordered, JSON, strictly off the hot path: hello, slot assignment,
// kit colors, and the guest's measured RTT for the host's lobby list.

export type GuestInputType = 'keyboard' | 'gamepad';

/** Sent as PeerJS connection metadata AND as the first control message, so the
 *  host can identify a guest even if its input channel opens first. */
export interface GuestIdentity {
  v: number;
  token: string;   // localStorage, reserves the slot across a reload/dropout
  name: string;
  input: GuestInputType;
}

export type GuestControl =
  | ({ t: 'hello' } & GuestIdentity)
  | { t: 'input'; input: GuestInputType }
  | { t: 'rtt'; ms: number };

/** What a seat means right now, in the guest's own words and kit colors. */
export interface SlotBrief {
  slot: number;        // seat slot: 0 = P1 … 3 = P4 (§5.4.6)
  teamName: string;
  teamCode: string;
  shirt: string;       // kit color the guest's banner is painted in
  text: string;        // readable text color over `shirt`
}

export type HostControl =
  | { t: 'state'; phase: 'lobby' | 'match' | 'over'; brief: SlotBrief | null; note?: string }
  | { t: 'reject'; reason: string };

export const CTL_LABEL = 'ss26-ctl';
export const IN_LABEL = 'ss26-in';

/** Runtime guard — control JSON arrives from a stranger's browser. */
export function readGuestIdentity(raw: unknown): GuestIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION) return null;
  const token = typeof m.token === 'string' ? m.token.slice(0, 64) : '';
  const name = typeof m.name === 'string' ? m.name.slice(0, 18).trim() : '';
  const input: GuestInputType = m.input === 'gamepad' ? 'gamepad' : 'keyboard';
  if (!token) return null;
  return { v: PROTOCOL_VERSION, token, name: name || 'GUEST', input };
}

// ------------------------------------------------------------------- helpers

function toView(data: ArrayBuffer | ArrayBufferView): DataView | null {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function quantAxis(v: number): number {
  const n = Number.isFinite(v) ? clamp1(v) : 0;
  return Math.max(-127, Math.min(127, Math.round(n * 127)));
}

/** FNV-1a 32-bit, base36 — small, stable, and identical on both ends. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}
