// Keyboard + Gamepad abstraction (spec §5), now with seats for 2P couch play
// (§3.4): keyboard vs gamepad, or two gamepads. Actions buffer for 150ms so a
// pass queued during a receive animation fires the instant the touch completes.
//
// §5.4 native shell: DualSense/DualShock detection, a rumble vocabulary with a
// per-pad rate limiter, radial-deadzone sticks, and hot-plug callbacks so a pad
// arriving in the menus can take a seat and one yanked mid-match pauses.

export type Action = 'pass' | 'loft' | 'shoot' | 'through' | 'switch' | 'tactics' | 'pause' | 'replay';
export type DeviceKind = 'merged' | 'keyboard' | 'pad' | 'remote';

export interface Stick { x: number; y: number; }

const BUFFER_MS = 150;
export const ACTIONS: Action[] = ['pass', 'loft', 'shoot', 'through', 'switch', 'tactics', 'pause', 'replay'];

interface ActionState {
  held: boolean;
  pressedAt: number;   // performance.now() of last down edge, -1 if consumed
  releasedAt: number;  // last up edge, -1 if consumed
  heldSince: number;
}

export class DeviceState {
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
    const now = performance.now();
    for (const a of ACTIONS) {
      const s = this.actions[a];
      s.pressedAt = -1;
      s.releasedAt = -1;
      // rebase hold time: wall-clock charge must not keep counting across a
      // pause/replay freeze and fire a max-power shot on resume
      if (s.held) s.heldSince = now;
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

// ------------------------------------------------------------- pad identity

/** Which glyph family a pad wants drawn: Sony, Microsoft, or neither. */
export type PadStyle = 'ps' | 'xbox' | 'generic';

/** Sony USB product ids we can name outright (vendor 054c). */
const SONY_PRODUCTS: Record<string, string> = {
  '0ce6': 'DualSense',
  '0df2': 'DualSense Edge',
  '05c4': 'DualShock 4',
  '09cc': 'DualShock 4 (v2)',
  '0ba0': 'DualShock 4 USB adapter',
  '0268': 'DualShock 3',
};

const SONY_VENDOR = '054c';
const MS_VENDOR = '045e';

/**
 * Chromium's gamepad id on macOS looks like
 *   "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
 * and Firefox's like "054c-0ce6-Wireless Controller". Parse both, then fall
 * back to name sniffing for pads behind a driver that hides the ids.
 */
export function padVendorProduct(id: string): { vendor: string; product: string } | null {
  const chromium = /vendor:\s*([0-9a-f]{4}).*?product:\s*([0-9a-f]{4})/i.exec(id);
  if (chromium) return { vendor: chromium[1].toLowerCase(), product: chromium[2].toLowerCase() };
  const firefox = /^([0-9a-f]{4})-([0-9a-f]{4})/i.exec(id.trim());
  if (firefox) return { vendor: firefox[1].toLowerCase(), product: firefox[2].toLowerCase() };
  return null;
}

/**
 * 'ps' | 'xbox' | 'generic' for one gamepad id string.
 *
 * On macOS a Sony pad reaches Chromium down one of two roads. Over the IOHID
 * fetcher the id carries "Vendor: 054c Product: 0ce6" and this is trivial.
 * Over the Game Controller framework (which Chromium prefers for PlayStation
 * pads on macOS) the id is only `"<vendor name> (STANDARD GAMEPAD)"` — no hex
 * at all — so the name has to carry the decision, and a bare "Wireless
 * Controller" on a Mac is, in practice, always a DualShock/DualSense.
 */
export function detectPadStyle(id: string): PadStyle {
  const vp = padVendorProduct(id);
  if (vp?.vendor === SONY_VENDOR) return 'ps';
  if (vp?.vendor === MS_VENDOR) return 'xbox';
  const n = id.toLowerCase();
  // xbox first: "Xbox Wireless Controller" must not fall into the Sony catch-all
  if (/xbox|xinput|microsoft/.test(n)) return 'xbox';
  if (/dualsense|dualshock|playstation|\bps[345]\b|\bsony\b/.test(n)) return 'ps';
  if (/wireless controller/.test(n)) return 'ps';
  return 'generic';
}

/** Best human name for a pad — "DualSense", "DualShock 4", or its raw id. */
export function detectPadModel(id: string): string {
  const vp = padVendorProduct(id);
  if (vp?.vendor === SONY_VENDOR && SONY_PRODUCTS[vp.product]) return SONY_PRODUCTS[vp.product];
  const n = id.toLowerCase();
  if (n.includes('dualsense edge')) return 'DualSense Edge';
  if (n.includes('dualsense')) return 'DualSense';
  if (n.includes('dualshock')) return 'DualShock';
  if (n.includes('xbox')) return 'Xbox Controller';
  // strip Chromium's "(STANDARD GAMEPAD Vendor: … )" / "(STANDARD GAMEPAD)" tail
  return id
    .replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:.*$/i, '')
    .replace(/\s*\(STANDARD GAMEPAD\)\s*$/i, '')
    .trim() || id;
}

/**
 * Which glyph family the couch is holding, with no InputHub handle needed —
 * the menus' glyph component (src/ui/menuGlyphs.ts) calls exactly this. The
 * lowest-indexed connected pad decides, so a mixed pair still shows one family
 * rather than flickering between two; pass an index for one specific pad.
 */
export function padStyle(index?: number): PadStyle {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  let best: Gamepad | null = null;
  for (const gp of pads) {
    if (!gp) continue;
    if (index !== undefined) { if (gp.index === index) return detectPadStyle(gp.id); continue; }
    if (!best || gp.index < best.index) best = gp;
  }
  return best ? detectPadStyle(best.id) : 'generic';
}

/** Everything the pad test page and the menus need to describe a pad. */
export interface PadInfo {
  index: number;
  id: string;
  style: PadStyle;
  model: string;
  /** Chromium's mapping string — 'standard' for every pad we care about. */
  mapping: string;
  buttons: number;
  axes: number;
  /** A dual-rumble actuator is present (DualSense has one over USB and BT). */
  hasRumble: boolean;
  connected: boolean;
}

// --------------------------------------------------------------- button map

/**
 * The standard-mapping button indices, as data, so the menus agent can render
 * glyphs without duplicating this table. Indices 16/17 are Chromium extensions
 * beyond the 16-button standard mapping: 16 is the PS/Guide button (macOS
 * reserves it — see README) and 17 is the DualSense touchpad click.
 */
export interface PadBinding {
  /** Game action, or a pseudo-action for the movement/system rows. */
  action: Action | 'sprint' | 'move';
  /** Standard-mapping button index, null for the sticks. */
  button: number | null;
  /** Glyph/short name per style. */
  ps: string;
  xbox: string;
  generic: string;
  /** What it does, in the game's own words. */
  label: string;
}

export const PAD_BINDINGS: readonly PadBinding[] = [
  { action: 'move', button: null, ps: 'L-Stick / D-Pad', xbox: 'L-Stick / D-Pad', generic: 'L-Stick / D-Pad', label: 'Move' },
  { action: 'pass', button: 0, ps: '✕', xbox: 'A', generic: 'Button 1', label: 'Short pass / Pressure' },
  { action: 'loft', button: 1, ps: '○', xbox: 'B', generic: 'Button 2', label: 'Lofted pass / Cross / Header' },
  { action: 'shoot', button: 2, ps: '□', xbox: 'X', generic: 'Button 3', label: 'Shoot (hold) / Slide tackle' },
  { action: 'through', button: 3, ps: '△', xbox: 'Y', generic: 'Button 4', label: 'Through ball' },
  { action: 'switch', button: 4, ps: 'L1', xbox: 'LB', generic: 'L1', label: 'Switch player' },
  { action: 'tactics', button: 6, ps: 'L2', xbox: 'LT', generic: 'L2', label: 'Tactics quick-menu (hold)' },
  { action: 'sprint', button: 7, ps: 'R2', xbox: 'RT', generic: 'R2', label: 'Sprint (hold)' },
  { action: 'replay', button: 8, ps: 'Create', xbox: 'Back', generic: 'Select', label: 'Instant replay' },
  { action: 'pause', button: 9, ps: 'Options', xbox: 'Start', generic: 'Start', label: 'Pause' },
  { action: 'replay', button: 17, ps: 'Touchpad', xbox: '—', generic: '—', label: 'Instant replay (alias)' },
];

/** The glyph a given style shows for an action, e.g. padGlyph('shoot','ps') → '□'. */
export function padGlyph(action: Action | 'sprint' | 'move', style: PadStyle): string {
  const b = PAD_BINDINGS.find((x) => x.action === action);
  if (!b) return '?';
  return style === 'ps' ? b.ps : style === 'xbox' ? b.xbox : b.generic;
}

// Standard mapping: 0=A/✕ pass, 1=B/○ loft, 2=X/□ shoot, 3=Y/△ through,
// 4=LB/L1 switch, 6=LT/L2 tactics, 7=RT/R2 sprint, 8=Back/Create replay,
// 9=Start/Options pause, 17=DualSense touchpad click (replay alias).
const PAD_MAP: [number, Action | 'sprint'][] = PAD_BINDINGS
  .filter((b): b is PadBinding & { button: number } => b.button !== null)
  .map((b) => [b.button, b.action as Action | 'sprint']);

// ------------------------------------------------------------------ sticks

/**
 * Below this the stick is noise; DualSense sticks rest around 0.02–0.08 new
 * and drift to ~0.10 worn. Kept low on purpose: the rescaling below means the
 * *useful* walk threshold ends up near the old flat 0.22 gate anyway.
 */
export const STICK_DEADZONE = 0.12;
/** Worn sticks rarely reach 1.0 in a corner — saturate a hair early. */
export const STICK_SATURATION = 0.92;
/** Anything past this counts as "the player meant it" (menus, merged seats). */
export const STICK_ACTIVE = 0.22;

/**
 * Radial deadzone with rescaling: the magnitude is remapped from
 * [dead, saturation] onto [0, 1] while the *direction* is preserved, so a
 * diagonal is as reachable as a cardinal and nothing snaps at the edge.
 */
export function applyDeadzone(
  x: number, y: number, dead = STICK_DEADZONE, sat = STICK_SATURATION,
): Stick {
  const l = Math.hypot(x, y);
  if (!(l > dead)) return { x: 0, y: 0 };
  const scaled = Math.min((l - dead) / Math.max(sat - dead, 1e-4), 1);
  return { x: (x / l) * scaled, y: (y / l) * scaled };
}

/**
 * "Stick or d-pad": whichever is deflected wins, d-pad first (it is binary and
 * unambiguous, and a resting stick must never dilute a d-pad diagonal).
 */
export function padMovement(gp: Gamepad): Stick {
  let dx = 0, dy = 0;
  if (gp.buttons[14]?.pressed) dx -= 1;
  if (gp.buttons[15]?.pressed) dx += 1;
  if (gp.buttons[12]?.pressed) dy -= 1;
  if (gp.buttons[13]?.pressed) dy += 1;
  if (dx !== 0 || dy !== 0) {
    const l = Math.hypot(dx, dy);
    return { x: dx / l, y: dy / l }; // d-pad is always full tilt
  }
  return applyDeadzone(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
}

// ------------------------------------------------------------------ haptics

/** The game's rumble vocabulary — named so callers never invent magnitudes. */
export type RumbleCue =
  | 'kickLight' | 'kickMedium' | 'kickHeavy'
  | 'tackle' | 'goal' | 'post' | 'whistle'
  | 'switch' | 'save' | 'card' | 'ui';

interface CueSpec {
  strong: number;
  weak: number;
  ms: number;
  /** Higher wins: a goal interrupts a kick, a kick never interrupts a goal. */
  priority: number;
}

export const RUMBLE_CUES: Record<RumbleCue, CueSpec> = {
  ui: { strong: 0, weak: 0.15, ms: 30, priority: 0 },
  switch: { strong: 0, weak: 0.2, ms: 40, priority: 1 },
  kickLight: { strong: 0, weak: 0.18, ms: 50, priority: 1 },
  kickMedium: { strong: 0.15, weak: 0.3, ms: 80, priority: 2 },
  kickHeavy: { strong: 0.45, weak: 0.3, ms: 140, priority: 3 },
  tackle: { strong: 0.5, weak: 0.2, ms: 110, priority: 3 },
  save: { strong: 0.4, weak: 0.3, ms: 130, priority: 3 },
  card: { strong: 0.3, weak: 0.5, ms: 220, priority: 4 },
  whistle: { strong: 0.25, weak: 0.45, ms: 180, priority: 4 },
  post: { strong: 0.8, weak: 0.4, ms: 220, priority: 5 },
  goal: { strong: 1, weak: 1, ms: 550, priority: 6 },
};

/** Never fire two effects closer together than this on one pad. */
const RUMBLE_MIN_GAP_MS = 25;

interface PadHaptic {
  /** performance.now() when the running effect ends. */
  until: number;
  priority: number;
}

interface VibrationActuator {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
  reset?: () => Promise<unknown>;
}

function actuatorOf(gp: Gamepad | null): VibrationActuator | undefined {
  return (gp as unknown as { vibrationActuator?: VibrationActuator } | null)?.vibrationActuator;
}

// --------------------------------------------------------------------- hub

export class InputHub {
  keyboard = new DeviceState();
  private pads = new Map<number, DeviceState>();
  private prevPadButtons = new Map<number, boolean[]>();
  /** Remote guest controllers (fed by GuestHost over a WebRTC channel). */
  private remotes = new Map<number, DeviceState>();
  private keys = new Set<string>();
  /** Fired on any key/button press — unlocks audio, advances title screens. */
  onAnyButton: (() => void) | null = null;

  /** Hot-plug: a pad appeared (menus can offer it a seat). */
  onPadConnected: ((info: PadInfo) => void) | null = null;
  /** Hot-plug: a pad vanished (a seated one must pause the match). */
  onPadDisconnected: ((index: number) => void) | null = null;

  /** Last-seen identity per pad index, kept so disconnects can still name it. */
  private padInfos = new Map<number, PadInfo>();
  private haptics = new Map<number, PadHaptic>();
  /** Seat slot → pad indices, set by main when a match is seated. */
  private seatPads = new Map<number, number[]>();
  /** Master switch for haptics (a settings row can flip it). */
  rumbleEnabled = true;

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
    // The Gamepad API's own events are the fast path for hot-plug; pollGamepads
    // re-checks every frame so a missed event can never strand a seat.
    window.addEventListener('gamepadconnected', () => this.syncPadRoster());
    window.addEventListener('gamepaddisconnected', () => this.syncPadRoster());
  }

  // ------------------------------------------------------------- identity

  private static live(): (Gamepad | null)[] {
    return typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  }

  private static infoOf(gp: Gamepad): PadInfo {
    return {
      index: gp.index,
      id: gp.id,
      style: detectPadStyle(gp.id),
      model: detectPadModel(gp.id),
      mapping: gp.mapping || 'unknown',
      buttons: gp.buttons.length,
      axes: gp.axes.length,
      hasRumble: !!actuatorOf(gp)?.playEffect,
      connected: true,
    };
  }

  /** Identity of every connected pad, cheapest way for UI to list them. */
  padList(): PadInfo[] {
    const out: PadInfo[] = [];
    for (const gp of InputHub.live()) if (gp) out.push(InputHub.infoOf(gp));
    return out.sort((a, b) => a.index - b.index);
  }

  /** Identity of one pad (last seen, if it has since been unplugged). */
  padInfo(index: number): PadInfo | null {
    for (const gp of InputHub.live()) if (gp && gp.index === index) return InputHub.infoOf(gp);
    const remembered = this.padInfos.get(index);
    return remembered ? { ...remembered, connected: false } : null;
  }

  /** Glyph family for one pad, or for the whole rig when index is omitted. */
  padStyle(index?: number): PadStyle {
    if (index !== undefined) return this.padInfo(index)?.style ?? 'generic';
    // no index: the first connected pad decides, so the menus show one family
    const list = this.padList();
    return list[0]?.style ?? 'generic';
  }

  /** Reconcile the roster and fire hot-plug callbacks. Idempotent. */
  private syncPadRoster(): void {
    const seen = new Set<number>();
    for (const gp of InputHub.live()) {
      if (!gp) continue;
      seen.add(gp.index);
      const info = InputHub.infoOf(gp);
      const had = this.padInfos.get(gp.index);
      this.padInfos.set(gp.index, info);
      if (!had) this.onPadConnected?.(info);
    }
    for (const index of [...this.padInfos.keys()]) {
      if (seen.has(index)) continue;
      this.padInfos.delete(index);
      // a pad yanked mid-match must go neutral, not freeze at its last state
      this.pads.get(index)?.neutralize();
      this.prevPadButtons.delete(index);
      this.haptics.delete(index);
      this.onPadDisconnected?.(index);
    }
  }

  // -------------------------------------------------------------- haptics

  /**
   * Back-compatible blunt instrument: pulse every connected pad. Prefer
   * `cue()` / `cueSeat()`, which rate-limit and can target one player.
   */
  rumble(strong: number, weak: number, ms: number): void {
    for (const info of this.padList()) this.play(info.index, strong, weak, ms, 3);
  }

  /** Play a named cue on every pad (or the given ones). */
  cue(name: RumbleCue, pads?: number[], scale = 1): void {
    const spec = RUMBLE_CUES[name];
    const targets = pads ?? this.padList().map((p) => p.index);
    for (const i of targets) {
      this.play(i, spec.strong * scale, spec.weak * scale, spec.ms, spec.priority);
    }
  }

  /** Play a named cue on the pad(s) sitting in a seat slot (§5.4.6). */
  cueSeat(slot: number, name: RumbleCue, scale = 1): void {
    const pads = this.seatPads.get(slot);
    if (!pads || pads.length === 0) return;
    this.cue(name, pads, scale);
  }

  /** True when at least one pad is wired to that seat slot. */
  seatHasPad(slot: number): boolean {
    return (this.seatPads.get(slot)?.length ?? 0) > 0;
  }

  /**
   * Tell the hub which pads drive which seat slots, so cues can be aimed at
   * one player. `null` entries (AI / keyboard / guest) just get no pads.
   */
  registerSeatPads(seats: readonly (SeatLike | null)[]): void {
    this.seatPads.clear();
    for (let slot = 0; slot < seats.length; slot++) {
      const s = seats[slot];
      if (!s) continue;
      if (s.kind === 'pad') this.seatPads.set(slot, [s.padIndex]);
      // a 1P 'merged' seat is every local pad at once
      else if (s.kind === 'merged') this.seatPads.set(slot, this.padList().map((p) => p.index));
    }
  }

  clearSeatPads(): void {
    this.seatPads.clear();
  }

  /**
   * Fire one effect, rate-limited per pad: a cue is dropped while a
   * same-or-higher-priority effect is still running, so a scrum of kicks and
   * tackles reads as distinct thumps instead of one continuous buzz.
   */
  private play(index: number, strong: number, weak: number, ms: number, priority: number): void {
    if (!this.rumbleEnabled) return;
    const now = performance.now();
    const state = this.haptics.get(index);
    if (state) {
      if (now < state.until && priority <= state.priority) return;
      if (now < state.until + RUMBLE_MIN_GAP_MS && priority <= state.priority) return;
    }
    let gp: Gamepad | null = null;
    for (const p of InputHub.live()) if (p && p.index === index) gp = p;
    const act = actuatorOf(gp);
    if (!act?.playEffect) return;
    this.haptics.set(index, { until: now + ms, priority });
    try {
      void act.playEffect('dual-rumble', {
        // startDelay 0 keeps the effect from queueing behind the previous one
        startDelay: 0,
        duration: Math.max(ms, 1),
        strongMagnitude: clamp01(strong),
        weakMagnitude: clamp01(weak),
      })?.catch?.(() => { /* actuator can reject mid-effect — ignore */ });
    } catch { /* actuator can reject mid-effect on some pads — ignore */ }
  }

  /** Stop every motor now (pause card, match teardown, settings toggle off). */
  stopRumble(): void {
    this.haptics.clear();
    for (const gp of InputHub.live()) {
      const act = actuatorOf(gp);
      try {
        void (act?.reset?.() ?? act?.playEffect?.('dual-rumble', {
          duration: 1, strongMagnitude: 0, weakMagnitude: 0,
        }));
      } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- seats

  /** Indices of currently connected gamepads. */
  connectedPads(): number[] {
    const out: number[] = [];
    for (const gp of InputHub.live()) if (gp) out.push(gp.index);
    return out.sort((a, b) => a - b);
  }

  pad(index: number): DeviceState {
    let d = this.pads.get(index);
    if (!d) { d = new DeviceState(); this.pads.set(index, d); }
    return d;
  }

  /** Device state for a connected remote guest (created on join). */
  remote(index: number): DeviceState {
    let d = this.remotes.get(index);
    if (!d) { d = new DeviceState(); this.remotes.set(index, d); }
    return d;
  }

  /** A guest left — its player must go neutral, like a yanked pad. */
  removeRemote(index: number): void {
    this.remotes.get(index)?.neutralize();
    this.remotes.delete(index);
  }

  /** Indices of currently connected remote guests. */
  connectedRemotes(): number[] {
    return [...this.remotes.keys()].sort((a, b) => a - b);
  }

  /** Poll gamepad edges once per frame (the Gamepad API has no button events). */
  pollGamepads(): void {
    // hot-plug first: connect/disconnect callbacks fire before any edge work,
    // so a seat handed a brand-new pad sees its very first press this frame
    this.syncPadRoster();
    for (const gp of InputHub.live()) {
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
      dev.stick = padMovement(gp);
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
    const devices = [this.keyboard, ...this.pads.values(), ...this.remotes.values()];
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
    for (const d of this.remotes.values()) d.clear();
  }
}

/** The shape `registerSeatPads` reads — PlayerInput satisfies it. */
export interface SeatLike {
  readonly kind: DeviceKind;
  readonly padIndex: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isDir(m: string): m is 'up' | 'down' | 'left' | 'right' {
  return m === 'up' || m === 'down' || m === 'left' || m === 'right';
}

/** One player's view of the hub. The whole sim reads inputs through this. */
export class PlayerInput implements SeatLike {
  constructor(private hub: InputHub, readonly kind: DeviceKind, readonly padIndex: number) {}

  private devices(): DeviceState[] {
    if (this.kind === 'keyboard') return [this.hub.keyboard];
    if (this.kind === 'pad') return [this.hub.pad(this.padIndex)];
    if (this.kind === 'remote') return [this.hub.remote(this.padIndex)];
    return [
      this.hub.keyboard,
      ...this.hub.connectedPads().map((i) => this.hub.pad(i)),
      ...this.hub.connectedRemotes().map((i) => this.hub.remote(i)),
    ];
  }

  getStick(): Stick {
    if (this.kind === 'pad') return clampStick(this.hub.pad(this.padIndex).stick);
    if (this.kind === 'remote') return clampStick(this.hub.remote(this.padIndex).stick);
    const k = this.hub.keyboardStick();
    if (this.kind === 'keyboard') return k;
    // merged: any deflected pad/guest stick wins over the keyboard
    for (const i of this.hub.connectedPads()) {
      const s = this.hub.pad(i).stick;
      if (Math.hypot(s.x, s.y) > STICK_ACTIVE) return clampStick(s);
    }
    for (const i of this.hub.connectedRemotes()) {
      const s = this.hub.remote(i).stick;
      if (Math.hypot(s.x, s.y) > STICK_ACTIVE) return clampStick(s);
    }
    return k;
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
