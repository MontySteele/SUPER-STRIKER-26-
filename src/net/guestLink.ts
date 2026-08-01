// Guest side of the remote guest link (§5.4). Opens two DataChannels to the
// host: a reliable one for lobby chatter, and a fire-and-forget one for the
// 6-byte input packets. The guest is a dumb terminal — it ships inputs and
// renders nothing of the match.

import Peer, { type DataConnection } from 'peerjs';
import {
  CTL_LABEL, IN_LABEL, PROTOCOL_VERSION, TAG_PING, TAG_PONG,
  brokerOptions, encodeInput, encodeProbe, decodeProbe, hostPeerId,
  type GuestControl, type GuestIdentity, type GuestInputType, type HostControl,
} from './protocol';

export type LinkStatus = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';

/** Resend the current state this often even when nothing moved (§5.4.4). */
const KEEPALIVE_MS = 100;
const PING_MS = 500;
/** Nothing back from the host for this long: the pip goes red. */
const SILENCE_MS = 2500;

export class GuestLink {
  status: LinkStatus = 'connecting';
  error: string | null = null;
  /** Round trip measured on the input channel itself, ms (-1 = unknown). */
  rttMs = -1;
  /** Latest picture the host pushed: our slot, team and kit colors. */
  state: Extract<HostControl, { t: 'state' }> | null = null;
  onChange: (() => void) | null = null;

  private peer: Peer | null = null;
  private ctl: DataConnection | null = null;
  private input: DataConnection | null = null;
  private seq = 0;
  private lastButtons = -1;
  private lastX = 0;
  private lastY = 0;
  private lastSent = 0;
  private lastPong = 0;
  private timers: number[] = [];
  private closed = false;

  constructor(private code: string, private identity: GuestIdentity) {}

  start(): void {
    if (this.peer || this.closed) return;
    let peer: Peer;
    try {
      peer = new Peer(brokerOptions());
    } catch (err) {
      this.fail(`Could not reach the signaling broker (${String(err)}).`);
      return;
    }
    this.peer = peer;
    peer.on('open', () => this.dial(peer));
    peer.on('error', (err) => {
      const type = (err as { type?: string }).type ?? '';
      if (type === 'peer-unavailable') {
        this.fail(`No game is hosting room ${this.code}. Check the code, or ask the host to open the INVITE PLAYERS screen.`);
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        this.fail('Lost the signaling broker. Check your connection and try again.');
      } else {
        this.fail(`Connection failed (${type || String(err)}).`);
      }
    });
    this.timers.push(window.setInterval(() => this.tickHealth(), 250));
    this.timers.push(window.setInterval(() => this.ping(), PING_MS));
    this.timers.push(window.setInterval(() => this.reportRtt(), 1000));
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    try { this.ctl?.close(); } catch { /* already gone */ }
    try { this.input?.close(); } catch { /* already gone */ }
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.peer = null;
    this.status = 'closed';
    this.onChange?.();
  }

  /** Tell the host we swapped between the keyboard card and the pad card. */
  setInputType(input: GuestInputType): void {
    if (this.identity.input === input) return;
    this.identity.input = input;
    this.sendControl({ t: 'input', input });
  }

  /**
   * Hand the sampler's current state to the wire. Sends only on a real change
   * plus the 10Hz keepalive — a still thumb costs 60 packets a minute, not
   * 3600.
   */
  sendInput(buttons: number, x: number, y: number): void {
    const conn = this.input;
    if (!conn?.open) return;
    const now = performance.now();
    const moved = buttons !== this.lastButtons
      || Math.abs(x - this.lastX) > 0.008 || Math.abs(y - this.lastY) > 0.008;
    if (!moved && now - this.lastSent < KEEPALIVE_MS) return;
    this.lastButtons = buttons;
    this.lastX = x;
    this.lastY = y;
    this.lastSent = now;
    this.seq = (this.seq + 1) & 0xffff;
    try { conn.send(encodeInput(this.seq, buttons, x, y)); } catch { /* channel died */ }
  }

  // ---------------------------------------------------------------- internals

  private dial(peer: Peer): void {
    const host = hostPeerId(this.code);
    const metadata: GuestIdentity = { ...this.identity, v: PROTOCOL_VERSION };

    // control first: the reliable channel is what tells us we're actually in
    const ctl = peer.connect(host, {
      label: CTL_LABEL, reliable: true, serialization: 'json', metadata,
    });
    this.ctl = ctl;
    ctl.on('open', () => {
      this.sendControl({ t: 'hello', ...this.identity, v: PROTOCOL_VERSION });
      this.settle();
    });
    ctl.on('data', (raw) => this.onControl(raw));
    ctl.on('close', () => { this.ctl = null; this.settle(); });
    ctl.on('error', () => { /* close follows */ });

    const input = connectUnreliable(peer, host, metadata);
    this.input = input;
    input.on('open', () => {
      this.lastPong = performance.now();
      this.settle();
    });
    input.on('data', (raw) => this.onProbe(raw));
    input.on('close', () => { this.input = null; this.settle(); });
    input.on('error', () => { /* close follows */ });

    // WebRTC can fail silently behind a symmetric NAT / restrictive firewall:
    // no error event, just a channel that never opens. Say so plainly.
    window.setTimeout(() => {
      if (!this.closed && this.status === 'connecting') {
        this.fail('Could not open a direct connection to the host. A strict firewall or VPN is usually the cause — try another network.');
      }
    }, 20_000);
  }

  private settle(): void {
    if (this.closed || this.status === 'error') return;
    const live = !!this.ctl?.open && !!this.input?.open;
    this.status = live ? 'live' : this.status === 'live' ? 'reconnecting' : 'connecting';
    this.onChange?.();
  }

  private ping(): void {
    const conn = this.input;
    if (!conn?.open) return;
    try { conn.send(encodeProbe(TAG_PING, Math.round(performance.now()))); } catch { /* fine */ }
  }

  private onProbe(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const probe = decodeProbe(raw as ArrayBuffer | ArrayBufferView);
    if (!probe || probe.tag !== TAG_PONG) return;
    // u32 of ms: the wrap is 49 days away, but a negative reading is nonsense
    const rtt = Math.round(performance.now()) - probe.stamp;
    if (rtt >= 0 && rtt < 10_000) {
      this.rttMs = this.rttMs < 0 ? rtt : Math.round(this.rttMs * 0.7 + rtt * 0.3);
    }
    this.lastPong = performance.now();
    this.onChange?.();
  }

  private reportRtt(): void {
    if (this.rttMs >= 0) this.sendControl({ t: 'rtt', ms: this.rttMs });
  }

  private tickHealth(): void {
    if (this.status !== 'live') return;
    if (performance.now() - this.lastPong > SILENCE_MS) {
      this.status = 'reconnecting';
      this.onChange?.();
    }
  }

  private onControl(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as HostControl;
    if (msg.t === 'state') {
      this.state = msg;
      this.onChange?.();
    } else if (msg.t === 'reject') {
      this.fail(typeof msg.reason === 'string' ? msg.reason : 'The host turned you away.');
    }
  }

  private sendControl(msg: GuestControl): void {
    if (this.ctl?.open) {
      try { this.ctl.send(msg); } catch { /* channel died between checks */ }
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.status = 'error';
    this.error = message;
    this.onChange?.();
  }
}

/**
 * PeerJS's `reliable: false` only flips `ordered` — it never sets
 * `maxRetransmits`, so the "unreliable" channel still retransmits and a lost
 * input packet can stall the ones behind it. The DataChannel is created
 * synchronously inside `peer.connect()`, so a scoped patch around that single
 * call gets us the real thing: ordered false, maxRetransmits 0 (§5.4.3).
 * Only the offerer's config matters; the host just answers.
 */
function connectUnreliable(peer: Peer, host: string, metadata: GuestIdentity): DataConnection {
  const proto = RTCPeerConnection.prototype;
  const original = proto.createDataChannel;
  proto.createDataChannel = function patched(
    this: RTCPeerConnection, label: string, init?: RTCDataChannelInit,
  ): RTCDataChannel {
    const cfg = label === IN_LABEL ? { ...init, ordered: false, maxRetransmits: 0 } : init;
    return original.call(this, label, cfg);
  };
  try {
    return peer.connect(host, {
      label: IN_LABEL, reliable: false, serialization: 'raw', metadata,
    });
  } finally {
    proto.createDataChannel = original;
  }
}
