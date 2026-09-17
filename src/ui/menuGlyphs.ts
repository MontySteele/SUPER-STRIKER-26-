// Controller glyphs for the front end (§7.1 front-end uplift).
//
// One component, two families. The Electron/controller agent is adding a
// `padStyle()` to src/input/input.ts that returns 'ps' | 'xbox' | 'generic';
// until it lands we read the module defensively (so this compiles and runs
// either way) and fall back to sniffing the Gamepad id ourselves. With no pad
// at all we show Xbox-style letters, which is what a keyboard player expects
// from a PC game.
//
// Every prompt carries the keyboard key alongside the glyph, because this game
// is played on both and a menu that only shows ✕ is useless to somebody on a
// laptop.

import * as InputModule from '../input/input';

export type PadStyle = 'ps' | 'xbox' | 'generic';

/** Logical buttons the menus prompt with. */
export type GlyphId =
  | 'confirm' | 'back' | 'alt' | 'alt2'
  | 'l1' | 'r1' | 'start' | 'select'
  | 'dpad' | 'dpadLR' | 'dpadUD' | 'stick';

/** Live pad family. Prefers input.ts's padStyle() the moment it exists. */
export function padStyle(): PadStyle {
  const exported = (InputModule as unknown as { padStyle?: () => unknown }).padStyle;
  if (typeof exported === 'function') {
    try {
      const v = exported();
      if (v === 'ps' || v === 'xbox' || v === 'generic') return v;
    } catch { /* an early call before the hub is up must not kill the menu */ }
  }
  return sniffPadStyle();
}

/** Our own read of the connected pads, for as long as padStyle() is missing. */
function sniffPadStyle(): PadStyle {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const id = gp.id.toLowerCase();
    if (/dualsense|dualshock|playstation|\b054c\b|wireless controller/.test(id)) return 'ps';
    if (/xbox|xinput|x-box|\b045e\b/.test(id)) return 'xbox';
  }
  return 'generic';
}

interface Face { label: string; cls: string; }

const PS: Record<GlyphId, Face> = {
  confirm: { label: '✕', cls: 'ps-cross' },
  back: { label: '○', cls: 'ps-circle' },
  alt: { label: '□', cls: 'ps-square' },
  alt2: { label: '△', cls: 'ps-triangle' },
  l1: { label: 'L1', cls: 'bumper' },
  r1: { label: 'R1', cls: 'bumper' },
  start: { label: 'OPTIONS', cls: 'sys' },
  select: { label: 'CREATE', cls: 'sys' },
  dpad: { label: '✛', cls: 'dpad' },
  dpadLR: { label: '◀▶', cls: 'dpad' },
  dpadUD: { label: '▲▼', cls: 'dpad' },
  stick: { label: 'L', cls: 'stick' },
};

const XB: Record<GlyphId, Face> = {
  confirm: { label: 'A', cls: 'xb-a' },
  back: { label: 'B', cls: 'xb-b' },
  alt: { label: 'X', cls: 'xb-x' },
  alt2: { label: 'Y', cls: 'xb-y' },
  l1: { label: 'LB', cls: 'bumper' },
  r1: { label: 'RB', cls: 'bumper' },
  start: { label: 'MENU', cls: 'sys' },
  select: { label: 'VIEW', cls: 'sys' },
  dpad: { label: '✛', cls: 'dpad' },
  dpadLR: { label: '◀▶', cls: 'dpad' },
  dpadUD: { label: '▲▼', cls: 'dpad' },
  stick: { label: 'L', cls: 'stick' },
};

/** The keyboard binding that does the same job (src/input/input.ts KEY_MAP). */
const KEYS: Partial<Record<GlyphId, string>> = {
  confirm: 'J',
  back: 'K',
  alt: 'L',
  alt2: 'I',
  start: 'ESC',
  dpad: 'WASD',
  dpadLR: 'A / D',
  dpadUD: 'W / S',
  l1: 'Q',
  r1: 'E',
};

/** Just the button pill. */
export function glyph(id: GlyphId, style: PadStyle = padStyle()): string {
  const face = (style === 'ps' ? PS : XB)[id];
  return `<span class="fe-g ${face.cls}">${face.label}</span>`;
}

/**
 * A full prompt: glyph, the keyboard equivalent, and what it does.
 * `dim` is for prompts that are context rather than an action.
 */
export function prompt(id: GlyphId, label: string, opts?: { dim?: boolean; style?: PadStyle }): string {
  const style = opts?.style ?? padStyle();
  const key = KEYS[id];
  const kb = key ? `<span class="fe-key">${key}</span>` : '';
  return `<span class="fe-prompt${opts?.dim ? ' dim' : ''}">${glyph(id, style)}${kb}${label}</span>`;
}

/** The bottom rail. Pass [id, label] pairs; `null` inserts the spacer. */
export function promptBar(items: ([GlyphId, string] | null)[]): string {
  const style = padStyle();
  const html = items.map((it) => (it === null
    ? '<span class="fe-prompt-spacer"></span>'
    : prompt(it[0], it[1], { style }))).join('');
  return `<div class="fe-prompts">${html}</div>`;
}

/** Free-standing "press any button" line for the title screen. */
export function anyButtonLabel(): string {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  let any = false;
  for (const gp of pads) if (gp) any = true;
  if (!any) return 'PRESS ANY KEY';
  return padStyle() === 'ps' ? 'PRESS START' : 'PRESS START';
}
