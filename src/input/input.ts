// Keyboard + Gamepad abstraction (spec §5), now with seats for 2P couch play
// (§3.4): keyboard vs gamepad, or two gamepads. Actions buffer for 150ms so a
// pass queued during a receive animation fires the instant the touch completes.

export type Action = 'pass' | 'loft' | 'shoot' | 'through' | 'switch' | 'tactics' | 'pause' | 'replay';
export type DeviceKind = 'merged' | 'keyboard' | 'pad';

export interface Stick { x: number; y: number; }

const BUFFER_MS = 150;
const ACTIONS: Action[] = ['pass', 'loft', 'shoot', 'through', 'switch', 'tactics', 'pause', 'replay'];

interface ActionState {
  held: boolean;
  pressedAt: number;   // performance.now() of last down edge, -1 if consumed
  releasedAt: number;  // last up edge, -1 if consumed
  heldSince: number;
}

class DeviceState {
  actions = {} as Record<Action, ActionState>;
  sprintHeld = false;
  stick: Stick = { x: 0, y: 0 };

  constructor() {
    for (const a of ACTIONS) {
      this.actions[a] = { held: false, pressedAt: -1, releasedAt: -1, heldSince: 0 };
    }
  }

  press(a: Action): void {
    const s = this.actions[a];
    s.held = true;
    s.pressedAt = performance.now();
    s.heldSince = s.pressedAt;
  }

  release(a: Action): void {
    const s = this.actions[a];
    s.held = false;
    s.releasedAt = performance.now();
  }

  clear(): void {
    for (const a of ACTIONS) {
      this.actions[a].pressedAt = -1;
      this.actions[a].releasedAt = -1;
    }
  }

  /** Drop ALL state without emitting release edges (blur / pad unplug). */
  neutralize(): void {
    this.sprintHeld = false;
    this.stick = { x: 0, y: 0 };
    for (const a of ACTIONS) {
      const s = this.actions[a];
      s.held = false;
      s.pressedAt = -1;
      s.releasedAt = -1;
    }
  }
}

const KEY_MAP: Record<string, Action | 'sprint' | 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyJ: 'pass', KeyK: 'loft', KeyL: 'shoot', KeyI: 'through',
  Space: 'switch', Tab: 'tactics',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Escape: 'pause', KeyP: 'pause',
  KeyR: 'replay',
};

// Standard mapping: 0=A pass, 1=B loft, 2=X shoot, 3=Y through, 4=LB switch,
// 7=RT sprint, 8=Back replay, 9=Start pause
const PAD_MAP: [number, Action | 'sprint'][] = [
  [0, 'pass'], [1, 'loft'], [2, 'shoot'], [3, 'through'], [4, 'switch'], [7, 'sprint'],
  [8, 'replay'], [9, 'pause'],
];

export class InputHub {
  keyboard = new DeviceState();
  private pads = new Map<number, DeviceState>();
  private prevPadButtons = new Map<number, boolean[]>();
  private keys = new Set<string>();
  /** Fired on any key/button press — unlocks audio, advances title screens. */
  onAnyButton: (() => void) | null = null;

  constructor() {
    // typing in a text field (roster editor) must never be swallowed by the
    // game bindings — WASD/JKLI/Space are half the alphabet's best letters
    const typing = (e: KeyboardEvent): boolean => {
      const t = e.target;
      return t instanceof HTMLElement
        && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const mapped = KEY_MAP[e.code];
      if (mapped) e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (mapped === 'sprint') this.keyboard.sprintHeld = true;
      else if (mapped && !isDir(mapped)) this.keyboard.press(mapped);
      this.onAnyButton?.();
    });
    window.addEventListener('keyup', (e) => {
      if (typing(e)) return;
      this.keys.delete(e.code);
      const mapped = KEY_MAP[e.code];
      if (mapped === 'sprint') this.keyboard.sprintHeld = false;
      else if (mapped && !isDir(mapped)) this.keyboard.release(mapped);
    });
    // Alt-tab with a key held: the keyup never arrives, so drop everything on
    // focus loss — otherwise the player sprints into the corner flag forever.
    const dropKeys = (): void => {
      this.keys.clear();
      this.keyboard.neutralize();
    };
    window.addEventListener('blur', dropKeys);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) dropKeys();
    });
  }

  /** Haptic pulse on every connected pad — feature-detected, fire and forget. */
  rumble(strong: number, weak: number, ms: number): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const gp of pads) {
      const act = (gp as unknown as {
        vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> };
      } | null)?.vibrationActuator;
      try {
        void act?.playEffect?.('dual-rumble', {
          duration: ms,
          strongMagnitude: Math.min(Math.max(strong, 0), 1),
          weakMagnitude: Math.min(Math.max(weak, 0), 1),
        });
      } catch { /* actuator can reject mid-effect on some pads — ignore */ }
    }
  }

  /** Indices of currently connected gamepads. */
  connectedPads(): number[] {
    const out: number[] = [];
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const gp of pads) if (gp) out.push(gp.index);
    return out;
  }

  pad(index: number): DeviceState {
    let d = this.pads.get(index);
    if (!d) { d = new DeviceState(); this.pads.set(index, d); }
    return d;
  }

  /** Poll gamepad edges once per frame (the Gamepad API has no button events). */
  pollGamepads(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    // a pad yanked mid-match must go neutral, not freeze at its last state
    const seen = new Set<number>();
    for (const gp of pads) if (gp) seen.add(gp.index);
    for (const [idx, dev] of this.pads) {
      if (!seen.has(idx)) {
        dev.neutralize();
        this.prevPadButtons.delete(idx);
      }
    }
    for (const gp of pads) {
      if (!gp) continue;
      const dev = this.pad(gp.index);
      const prev = this.prevPadButtons.get(gp.index) ?? [];
      for (const [idx, act] of PAD_MAP) {
        const down = gp.buttons[idx]?.pressed ?? false;
        const was = prev[idx] ?? false;
        if (act === 'sprint') {
          if (down !== was) dev.sprintHeld = down;
        } else {
          if (down && !was) { dev.press(act); this.onAnyButton?.(); }
          if (!down && was) dev.release(act);
        }
        prev[idx] = down;
      }
      this.prevPadButtons.set(gp.index, prev);
      const gx = gp.axes[0] ?? 0, gy = gp.axes[1] ?? 0;
      // dpad fallback (buttons 12-15)
      let dx = gx, dy = gy;
      if (gp.buttons[14]?.pressed) dx = -1;
      if (gp.buttons[15]?.pressed) dx = 1;
      if (gp.buttons[12]?.pressed) dy = -1;
      if (gp.buttons[13]?.pressed) dy = 1;
      dev.stick = Math.hypot(dx, dy) > 0.22 ? { x: dx, y: dy } : { x: 0, y: 0 };
    }
  }

  keyboardStick(): Stick {
    let x = 0, y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }

  /** A seat for one human player. 'merged' = keyboard + every pad (1P mode). */
  seat(kind: DeviceKind, padIndex = 0): PlayerInput {
    return new PlayerInput(this, kind, padIndex);
  }

  /** UI-level "any press of these actions on any device" (long window). */
  anyPress(actions: Action[], windowMs = 5000): boolean {
    const devices = [this.keyboard, ...this.pads.values()];
    for (const d of devices) {
      for (const a of actions) {
        const s = d.actions[a];
        if (s.pressedAt >= 0 && performance.now() - s.pressedAt <= windowMs) {
          s.pressedAt = -1;
          return true;
        }
      }
    }
    return false;
  }

  clearAll(): void {
    this.keyboard.clear();
    for (const d of this.pads.values()) d.clear();
  }
}

function isDir(m: string): m is 'up' | 'down' | 'left' | 'right' {
  return m === 'up' || m === 'down' || m === 'left' || m === 'right';
}

/** One player's view of the hub. The whole sim reads inputs through this. */
export class PlayerInput {
  constructor(private hub: InputHub, readonly kind: DeviceKind, private padIndex: number) {}

  private devices(): DeviceState[] {
    if (this.kind === 'keyboard') return [this.hub.keyboard];
    if (this.kind === 'pad') return [this.hub.pad(this.padIndex)];
    return [this.hub.keyboard, ...this.hub.connectedPads().map((i) => this.hub.pad(i))];
  }

  getStick(): Stick {
    if (this.kind !== 'pad') {
      const k = this.hub.keyboardStick();
      if (this.kind === 'keyboard') return k;
      // merged: pad stick wins when deflected
      for (const i of this.hub.connectedPads()) {
        const s = this.hub.pad(i).stick;
        if (Math.hypot(s.x, s.y) > 0.22) return clampStick(s);
      }
      return k;
    }
    return clampStick(this.hub.pad(this.padIndex).stick);
  }

  isSprinting(): boolean {
    return this.devices().some((d) => d.sprintHeld);
  }

  isHeld(a: Action): boolean {
    return this.devices().some((d) => d.actions[a].held);
  }

  /** How long the action has been held, in seconds (for shot power). */
  heldDuration(a: Action): number {
    let best = 0;
    for (const d of this.devices()) {
      const s = d.actions[a];
      if (s.held) best = Math.max(best, (performance.now() - s.heldSince) / 1000);
    }
    return best;
  }

  /**
   * Consume a buffered press edge if one happened within the window.
   * Gameplay uses the default 150ms; UI prompts pass a long window so a
   * press is never swallowed by a slow frame.
   */
  consumePress(a: Action, windowMs = BUFFER_MS): boolean {
    for (const d of this.devices()) {
      const s = d.actions[a];
      if (s.pressedAt >= 0 && performance.now() - s.pressedAt <= windowMs) {
        s.pressedAt = -1;
        return true;
      }
    }
    return false;
  }

  /** Consume a buffered release edge (shots fire on release). */
  consumeRelease(a: Action, windowMs = BUFFER_MS): { heldFor: number } | null {
    for (const d of this.devices()) {
      const s = d.actions[a];
      if (s.releasedAt >= 0 && performance.now() - s.releasedAt <= windowMs) {
        const heldFor = (s.releasedAt - s.heldSince) / 1000;
        s.releasedAt = -1;
        return { heldFor };
      }
    }
    return null;
  }

  clearBuffers(): void {
    for (const d of this.devices()) d.clear();
  }
}

function clampStick(s: Stick): Stick {
  const l = Math.hypot(s.x, s.y);
  return l > 1 ? { x: s.x / l, y: s.y / l } : { x: s.x, y: s.y };
}
