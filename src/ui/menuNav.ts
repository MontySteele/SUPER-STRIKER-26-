// Pad-first menu navigation.
//
// The match loop is the only thing that calls InputHub.pollGamepads(), and it
// is not running while the menus are up — so a gamepad did literally nothing
// in the front end. This is the menus' own poller: it READS navigator's pads
// (never writes to the hub, so it cannot desync the sim's edge detection) and
// turns sticks, d-pad and face buttons into the same four directions plus
// confirm / back / shoulders that the keyboard already produced.
//
// Every front-end screen drives itself through one of these, which is what
// makes "pick a team with the stick, ✕ to confirm" work everywhere.

export type NavDir = 'up' | 'down' | 'left' | 'right';

export interface NavHandlers {
  onDir?: (d: NavDir) => void;
  onConfirm?: () => void;
  onBack?: () => void;
  /** L1 / R1 — used for side switching and tab paging. */
  onShoulder?: (d: -1 | 1) => void;
  /** Options / Start / Escape. */
  onStart?: () => void;
  /** Square / X — the "secondary" action (cycle backwards, reset, …). */
  onAlt?: () => void;
  /** Any key or any pad button at all: the title screen's "PRESS START". */
  onAny?: () => void;
}

/** Repeat feel: one step, a beat, then a steady scroll. */
const REPEAT_DELAY_MS = 400;
const REPEAT_RATE_MS = 110;
const AXIS_ON = 0.55;
const AXIS_OFF = 0.35;

const DIR_KEYS: Record<string, NavDir> = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

const CONFIRM_KEYS = new Set(['KeyJ', 'Enter', 'NumpadEnter', 'Space']);
const BACK_KEYS = new Set(['KeyK', 'Backspace']);
const ALT_KEYS = new Set(['KeyL']);
const START_KEYS = new Set(['Escape']);
const SHOULDER_KEYS: Record<string, -1 | 1> = { KeyQ: -1, KeyE: 1 };

/** Standard mapping: 0 cross/A, 1 circle/B, 2 square/X, 4/5 bumpers, 9 start. */
const PAD_CONFIRM = 0;
const PAD_BACK = 1;
const PAD_ALT = 2;
const PAD_L1 = 4;
const PAD_R1 = 5;
const PAD_START = 9;
const PAD_DPAD: [number, NavDir][] = [[12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
const WATCHED_BUTTONS = [PAD_CONFIRM, PAD_BACK, PAD_ALT, PAD_L1, PAD_R1, PAD_START, 3, 6, 7, 8, 10, 11, 16];

export class MenuNav {
  /**
   * Ticks once per input event (a keydown, or one pass of the pad poller).
   *
   * Screens use it to tell "this is the press that got me here" from "this is
   * a new press": a wall-clock gate is not enough, because a single keydown
   * runs onAny() and then onConfirm() synchronously, and the render in between
   * can easily outlast a 180ms window on a slow machine — which is exactly how
   * one tap of J used to walk from the title screen into a team pick.
   */
  eventId = 0;

  private keyHandler: (e: KeyboardEvent) => void;
  private raf = 0;
  private alive = true;
  /** per pad index, per button index: was it down last poll */
  private prev = new Map<number, boolean[]>();
  /** per pad index: which direction is held, and when it next repeats */
  private held = new Map<number, { dir: NavDir | null; next: number }>();

  /**
   * `padOnly` leaves the keyboard alone — for screens (the roster editor) that
   * already have their own key handling and only want the gamepad added.
   */
  constructor(private h: NavHandlers, private opts: { padOnly?: boolean } = {}) {
    this.keyHandler = (e) => this.onKey(e);
    if (!opts.padOnly) window.addEventListener('keydown', this.keyHandler);
    this.raf = requestAnimationFrame(() => this.poll());
  }

  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    if (!this.opts.padOnly) window.removeEventListener('keydown', this.keyHandler);
  }

  /** Swap the handlers without tearing the poller down (screen changes). */
  setHandlers(h: NavHandlers): void {
    this.h = h;
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(e: KeyboardEvent): void {
    this.eventId++;
    const t = e.target;
    // the roster editor has real text inputs — never steal a keystroke there
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      || (t instanceof HTMLElement && t.isContentEditable)) return;

    const dir = DIR_KEYS[e.code];
    if (dir) {
      // auto-repeat may scroll a 48-team grid, which is the whole point of
      // holding a direction
      this.h.onDir?.(dir);
      if (!e.repeat) this.h.onAny?.();
      return;
    }
    // …but a held confirm/back must never chain through two screens (this is
    // the bug that used to launch a match straight off the title screen)
    if (e.repeat) return;
    this.h.onAny?.();
    if (CONFIRM_KEYS.has(e.code)) { this.h.onConfirm?.(); return; }
    if (BACK_KEYS.has(e.code)) { this.h.onBack?.(); return; }
    if (ALT_KEYS.has(e.code)) { this.h.onAlt?.(); return; }
    if (START_KEYS.has(e.code)) {
      // Escape is "back" everywhere in the menus, and Start on the title
      if (this.h.onStart) this.h.onStart();
      else this.h.onBack?.();
      return;
    }
    const sh = SHOULDER_KEYS[e.code];
    if (sh) this.h.onShoulder?.(sh);
  }

  // --------------------------------------------------------------- gamepads

  private poll(): void {
    if (!this.alive) return;
    this.raf = requestAnimationFrame(() => this.poll());
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const now = performance.now();

    for (const gp of pads) {
      if (!gp) continue;
      this.eventId++;
      const prev = this.prev.get(gp.index) ?? [];
      const edge = (i: number): boolean => {
        const down = gp.buttons[i]?.pressed ?? false;
        const was = prev[i] ?? false;
        prev[i] = down;
        return down && !was;
      };

      let pressedSomething = false;
      for (const i of WATCHED_BUTTONS) {
        const down = gp.buttons[i]?.pressed ?? false;
        if (down && !(prev[i] ?? false)) pressedSomething = true;
      }

      if (edge(PAD_CONFIRM)) this.h.onConfirm?.();
      if (edge(PAD_BACK)) this.h.onBack?.();
      if (edge(PAD_ALT)) this.h.onAlt?.();
      if (edge(PAD_L1)) this.h.onShoulder?.(-1);
      if (edge(PAD_R1)) this.h.onShoulder?.(1);
      if (edge(PAD_START)) {
        if (this.h.onStart) this.h.onStart();
        else this.h.onConfirm?.();
      }
      // everything else we watch is only there to feed "press any button"
      for (const i of WATCHED_BUTTONS) prev[i] = gp.buttons[i]?.pressed ?? false;
      this.prev.set(gp.index, prev);

      // one direction at a time, stick or d-pad, with hold-to-repeat
      let dir: NavDir | null = null;
      for (const [i, d] of PAD_DPAD) if (gp.buttons[i]?.pressed) dir = d;
      if (!dir) {
        const st = this.held.get(gp.index);
        const on = st?.dir ? AXIS_OFF : AXIS_ON; // hysteresis: no jitter at the edge
        const x = gp.axes[0] ?? 0, y = gp.axes[1] ?? 0;
        if (Math.abs(x) > Math.abs(y)) {
          if (x <= -on) dir = 'left'; else if (x >= on) dir = 'right';
        } else {
          if (y <= -on) dir = 'up'; else if (y >= on) dir = 'down';
        }
      }
      const state = this.held.get(gp.index) ?? { dir: null, next: 0 };
      if (dir !== state.dir) {
        state.dir = dir;
        state.next = now + REPEAT_DELAY_MS;
        if (dir) { this.h.onDir?.(dir); pressedSomething = true; }
      } else if (dir && now >= state.next) {
        state.next = now + REPEAT_RATE_MS;
        this.h.onDir?.(dir);
      }
      this.held.set(gp.index, state);

      if (pressedSomething) this.h.onAny?.();
    }
  }
}
