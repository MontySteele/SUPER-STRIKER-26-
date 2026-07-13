// Phone-as-controller, game side (§wow-factor): connects to the dev/preview
// server's /ss26-input WebSocket relay and feeds phone touch input into the
// InputHub as 'remote' devices. Entirely inert when the relay is unavailable
// (static hosting) — the rest of the game never knows this file exists.

import { ACTIONS, type Action, type InputHub } from './input';

/** Messages a controller page sends, relayed to us tagged with its id. */
interface ControllerMsg {
  t: 'state' | 'btn';
  sx?: number; sy?: number; sp?: boolean;   // state: stick + sprint @30Hz
  a?: string; d?: boolean;                  // btn: action edge
}

interface RelayMsg {
  t: 'joined' | 'left' | 'in' | 'ok' | 'err';
  id?: number;
  m?: ControllerMsg;
}

export type RemoteStatus = 'connecting' | 'ready' | 'unavailable';

const STALE_MS = 1000;

export class RemoteInputHost {
  /** 4-char pairing code baked into the controller URL. */
  readonly code: string;
  status: RemoteStatus = 'connecting';
  /** Fired on join/leave/status change so UI can refresh. */
  onChange: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private lastSeen = new Map<number, number>();
  private retries = 0;
  private closed = false;

  constructor(private hub: InputHub) {
    let code = '';
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    this.code = code;
    this.connect();
    // a phone that stops sending (backgrounded, dead battery, tunnel drop)
    // must go neutral, exactly like a yanked gamepad
    window.setInterval(() => {
      const now = performance.now();
      for (const [id, seen] of this.lastSeen) {
        if (now - seen > STALE_MS) {
          this.hub.remote(id).neutralize();
          this.lastSeen.set(id, now + 60_000); // don't re-neutralize every tick
        }
      }
    }, 250);
  }

  /** URL a phone opens to become a controller. */
  controllerUrl(): string {
    return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}controller.html?c=${this.code}`;
  }

  connectedCount(): number {
    return this.hub.connectedRemotes().length;
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ss26-input?role=game&code=${this.code}`);
    } catch {
      this.setStatus('unavailable');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.setStatus('ready');
    };
    ws.onmessage = (ev) => {
      let msg: RelayMsg;
      try { msg = JSON.parse(String(ev.data)) as RelayMsg; } catch { return; }
      this.handle(msg);
    };
    ws.onclose = () => {
      // every phone goes neutral the moment we lose the relay
      for (const id of this.hub.connectedRemotes()) this.hub.removeRemote(id);
      this.lastSeen.clear();
      this.onChange?.();
      this.retry();
    };
    ws.onerror = () => { /* onclose follows and handles it */ };
  }

  private retry(): void {
    if (this.closed) return;
    this.retries++;
    if (this.retries > 5) { this.setStatus('unavailable'); return; }
    this.setStatus('connecting');
    window.setTimeout(() => this.connect(), Math.min(500 * 2 ** this.retries, 8000));
  }

  private setStatus(s: RemoteStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onChange?.();
  }

  private handle(msg: RelayMsg): void {
    if (msg.t === 'joined' && msg.id !== undefined) {
      this.hub.remote(msg.id); // create the device
      this.lastSeen.set(msg.id, performance.now());
      this.onChange?.();
      return;
    }
    if (msg.t === 'left' && msg.id !== undefined) {
      this.hub.removeRemote(msg.id);
      this.lastSeen.delete(msg.id);
      this.onChange?.();
      return;
    }
    if (msg.t !== 'in' || msg.id === undefined || !msg.m) return;
    const dev = this.hub.remote(msg.id);
    this.lastSeen.set(msg.id, performance.now());
    const m = msg.m;
    if (m.t === 'state') {
      const sx = clampAxis(m.sx), sy = clampAxis(m.sy);
      dev.stick = Math.hypot(sx, sy) > 0.18 ? { x: sx, y: sy } : { x: 0, y: 0 };
      dev.sprintHeld = m.sp === true;
    } else if (m.t === 'btn' && isAction(m.a)) {
      if (m.d) {
        dev.press(m.a);
        this.hub.onAnyButton?.(); // advances title screens like any button
      } else {
        dev.release(m.a);
      }
    }
  }
}

function clampAxis(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(-1, Math.min(1, n));
}

function isAction(a: unknown): a is Action {
  return typeof a === 'string' && (ACTIONS as string[]).includes(a);
}
