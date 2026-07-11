// Keyboard + Gamepad abstraction (spec §5). Actions are buffered for 150ms so a
// pass queued during a receive animation fires the instant the touch completes.

export type Action = 'pass' | 'loft' | 'shoot' | 'through' | 'switch' | 'tactics';

export interface Stick { x: number; y: number; }

const BUFFER_MS = 150;

interface ActionState {
  held: boolean;
  pressedAt: number;   // performance.now() of last down edge, -1 if consumed
  releasedAt: number;  // last up edge, -1 if consumed
  heldSince: number;
}

const KEY_MAP: Record<string, Action | 'sprint' | 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyJ: 'pass', KeyK: 'loft', KeyL: 'shoot', KeyI: 'through',
  Space: 'switch', Tab: 'tactics',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
};

export class InputSystem {
  private keys = new Set<string>();
  private actions: Record<Action, ActionState> = {} as Record<Action, ActionState>;
  private sprintHeld = false;
  gamepadIndex: number | null = null;
  /** Fired on any key/button press — used to unlock audio + skip sequences. */
  onAnyButton: (() => void) | null = null;

  constructor() {
    for (const a of ['pass', 'loft', 'shoot', 'through', 'switch', 'tactics'] as Action[]) {
      this.actions[a] = { held: false, pressedAt: -1, releasedAt: -1, heldSince: 0 };
    }
    window.addEventListener('keydown', (e) => {
      const mapped = KEY_MAP[e.code];
      if (mapped) e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (mapped === 'sprint') this.sprintHeld = true;
      else if (mapped && mapped !== 'up' && mapped !== 'down' && mapped !== 'left' && mapped !== 'right') {
        this.press(mapped);
      }
      this.onAnyButton?.();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const mapped = KEY_MAP[e.code];
      if (mapped === 'sprint') this.sprintHeld = false;
      else if (mapped && mapped !== 'up' && mapped !== 'down' && mapped !== 'left' && mapped !== 'right') {
        this.release(mapped);
      }
    });
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
    });
  }

  private press(a: Action): void {
    const s = this.actions[a];
    s.held = true;
    s.pressedAt = performance.now();
    s.heldSince = s.pressedAt;
  }

  private release(a: Action): void {
    const s = this.actions[a];
    s.held = false;
    s.releasedAt = performance.now();
  }

  private prevPadButtons: boolean[] = [];

  /** Poll gamepad edges once per frame (Gamepad API has no events for buttons). */
  pollGamepad(): void {
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;
    // Standard mapping: 0=A pass, 2=X shoot, 1=B loft, 3=Y through, 4=LB switch, 7=RT sprint
    const map: [number, Action | 'sprint'][] = [
      [0, 'pass'], [2, 'shoot'], [1, 'loft'], [3, 'through'], [4, 'switch'], [7, 'sprint'],
    ];
    for (const [idx, act] of map) {
      const down = gp.buttons[idx]?.pressed ?? false;
      const was = this.prevPadButtons[idx] ?? false;
      if (act === 'sprint') {
        if (down !== was) this.sprintHeld = down;
      } else {
        if (down && !was) { this.press(act); this.onAnyButton?.(); }
        if (!down && was) this.release(act);
      }
      this.prevPadButtons[idx] = down;
    }
  }

  /** Movement stick: keyboard digital + gamepad analog, normalized. */
  getStick(): Stick {
    let x = 0, y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    if (this.gamepadIndex !== null) {
      const gp = navigator.getGamepads()[this.gamepadIndex];
      if (gp) {
        const gx = gp.axes[0] ?? 0, gy = gp.axes[1] ?? 0;
        if (Math.hypot(gx, gy) > 0.22) { x = gx; y = gy; }
      }
    }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }

  isSprinting(): boolean { return this.sprintHeld; }
  isHeld(a: Action): boolean { return this.actions[a].held; }

  /** How long the action has been held, in seconds (for shot power). */
  heldDuration(a: Action): number {
    const s = this.actions[a];
    return s.held ? (performance.now() - s.heldSince) / 1000 : 0;
  }

  /**
   * Consume a buffered press edge if one happened within the window.
   * Gameplay uses the default 150ms; UI prompts (halftime, rematch) pass a
   * long window so a press is never swallowed by a slow frame.
   */
  consumePress(a: Action, windowMs = BUFFER_MS): boolean {
    const s = this.actions[a];
    if (s.pressedAt >= 0 && performance.now() - s.pressedAt <= windowMs) {
      s.pressedAt = -1;
      return true;
    }
    return false;
  }

  /** Consume a buffered release edge (shoot fires on release for power shots). */
  consumeRelease(a: Action): { heldFor: number } | null {
    const s = this.actions[a];
    if (s.releasedAt >= 0 && performance.now() - s.releasedAt <= BUFFER_MS) {
      const heldFor = (s.releasedAt - s.heldSince) / 1000;
      s.releasedAt = -1;
      return { heldFor };
    }
    return null;
  }

  clearBuffers(): void {
    for (const a of Object.keys(this.actions) as Action[]) {
      this.actions[a].pressedAt = -1;
      this.actions[a].releasedAt = -1;
    }
  }
}
