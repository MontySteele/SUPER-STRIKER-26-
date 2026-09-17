// pad.html — the controller bench (§5.4). Lists every pad Chromium will admit
// to, names it (DualSense / DualShock / Xbox / generic), shows live axes and
// buttons with the game's own binding names against them, draws the raw vs
// deadzoned stick, and fires the rumble vocabulary on one pad at a time.
//
// Deliberately standalone: it constructs an InputHub only to reuse the
// detection/deadzone/rumble code, and never touches the sim or the renderer.

import {
  InputHub, PAD_BINDINGS, RUMBLE_CUES, applyDeadzone, padMovement,
  STICK_DEADZONE, STICK_SATURATION,
  type PadInfo, type PadStyle, type RumbleCue,
} from '../input/input';

const root = document.getElementById('root')!;
const hub = new InputHub();

/** Standard-mapping button names, per glyph family. */
const BUTTON_NAMES: Record<PadStyle, string[]> = {
  ps: ['Cross ✕', 'Circle ○', 'Square □', 'Triangle △', 'L1', 'R1', 'L2', 'R2',
    'Create', 'Options', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right',
    'PS', 'Touchpad', 'Mute'],
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
    'Back', 'Start', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right',
    'Guide', '—', '—'],
  generic: ['B0', 'B1', 'B2', 'B3', 'L1', 'R1', 'L2', 'R2',
    'Select', 'Start', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right',
    'Home', 'B17', 'B18'],
};

const AXIS_NAMES = ['L-Stick X', 'L-Stick Y', 'R-Stick X', 'R-Stick Y'];

/** Binding label for a button index, e.g. 2 → 'SHOOT'. */
function bindingFor(index: number): string {
  const b = PAD_BINDINGS.find((x) => x.button === index);
  return b ? b.action.toUpperCase() : '';
}

const CUES = Object.keys(RUMBLE_CUES) as RumbleCue[];

interface Row {
  el: HTMLElement;
  buttons: HTMLElement[];
  buttonRows: HTMLElement[];
  buttonVals: HTMLElement[];
  axes: HTMLElement[];
  axisVals: HTMLElement[];
  dotRaw: HTMLElement;
  dotDead: HTMLElement;
  readout: HTMLElement;
  info: PadInfo;
}

const rows = new Map<number, Row>();

function buildRow(info: PadInfo): Row {
  const names = BUTTON_NAMES[info.style];
  const el = document.createElement('div');
  el.className = 'pad';

  const btnRows: string[] = [];
  for (let i = 0; i < info.buttons; i++) {
    btnRows.push(`<tr data-b="${i}">
      <td class="n">${i}</td>
      <td class="name">${names[i] ?? `B${i}`}</td>
      <td class="name" style="color:var(--dim)">${bindingFor(i)}</td>
      <td><div class="bar"><i></i></div></td>
      <td class="v">0.00</td>
    </tr>`);
  }
  const axRows: string[] = [];
  for (let i = 0; i < info.axes; i++) {
    axRows.push(`<tr data-a="${i}">
      <td class="n">${i}</td>
      <td class="name">${AXIS_NAMES[i] ?? `Axis ${i}`}</td>
      <td><div class="bar axis"><i></i></div></td>
      <td class="v">+0.00</td>
    </tr>`);
  }

  el.innerHTML = `
    <h2>Pad ${info.index + 1} — ${esc(info.model)}</h2>
    <div class="id">${esc(info.id)}</div>
    <div class="tags">
      <span class="tag">style <b>${info.style}</b></span>
      <span class="tag ${info.mapping === 'standard' ? 'ok' : 'no'}">mapping <b>${esc(info.mapping)}</b></span>
      <span class="tag">buttons <b>${info.buttons}</b></span>
      <span class="tag">axes <b>${info.axes}</b></span>
      <span class="tag ${info.hasRumble ? 'ok' : 'no'}">dual-rumble <b>${info.hasRumble ? 'yes' : 'no'}</b></span>
    </div>
    <div class="cols">
      <div class="col">
        <h3>Buttons</h3>
        <table class="btns"><tbody>${btnRows.join('')}</tbody></table>
      </div>
      <div class="col">
        <h3>Axes</h3>
        <table class="axes"><tbody>${axRows.join('')}</tbody></table>
        <h3 style="margin-top:14px">Left stick</h3>
        <div class="stickbox">
          <div class="dot raw"></div>
          <div class="dot dead"></div>
        </div>
        <div class="stick-label">
          blue = raw · yellow = after radial deadzone
          (${STICK_DEADZONE} → ${STICK_SATURATION})
          <div class="readout">—</div>
        </div>
      </div>
      <div class="col">
        <h3>Rumble</h3>
        <div class="cuebox"></div>
        <div class="legend">
          Each button fires that cue on <b>this pad only</b>. If nothing is felt,
          check the pad is on USB or freshly paired — macOS sometimes keeps a
          stale Bluetooth link that enumerates but will not vibrate.
        </div>
      </div>
    </div>`;

  const cuebox = el.querySelector('.cuebox')!;
  for (const cue of CUES) {
    const b = document.createElement('button');
    b.textContent = cue;
    b.addEventListener('click', () => hub.cue(cue, [info.index]));
    cuebox.appendChild(b);
  }
  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'stop';
  stopBtn.addEventListener('click', () => hub.stopRumble());
  cuebox.appendChild(stopBtn);

  const buttonRows = [...el.querySelectorAll<HTMLElement>('table.btns tr')];
  const axisRows = [...el.querySelectorAll<HTMLElement>('table.axes tr')];
  return {
    el,
    buttonRows,
    buttons: buttonRows.map((r) => r.querySelector<HTMLElement>('.bar i')!),
    buttonVals: buttonRows.map((r) => r.querySelector<HTMLElement>('.v')!),
    axes: axisRows.map((r) => r.querySelector<HTMLElement>('.bar i')!),
    axisVals: axisRows.map((r) => r.querySelector<HTMLElement>('.v')!),
    dotRaw: el.querySelector<HTMLElement>('.dot.raw')!,
    dotDead: el.querySelector<HTMLElement>('.dot.dead')!,
    readout: el.querySelector<HTMLElement>('.readout')!,
    info,
  };
}

const empty = document.createElement('div');
empty.className = 'empty';
empty.textContent = 'No pads yet — press a button on a connected controller.';
root.appendChild(empty);

function sync(): void {
  const live = hub.padList();
  const seen = new Set<number>();
  for (const info of live) {
    seen.add(info.index);
    const row = rows.get(info.index);
    // a re-plug can change the id/shape under the same index: rebuild then
    if (!row || row.info.id !== info.id || row.info.buttons !== info.buttons) {
      row?.el.remove();
      const fresh = buildRow(info);
      rows.set(info.index, fresh);
      root.appendChild(fresh.el);
    }
  }
  for (const [index, row] of rows) {
    if (seen.has(index)) continue;
    row.el.remove();
    rows.delete(index);
  }
  empty.style.display = rows.size === 0 ? '' : 'none';
}

function frame(): void {
  requestAnimationFrame(frame);
  hub.pollGamepads(); // drives hot-plug + the shared edge detection
  sync();

  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const row = rows.get(gp.index);
    if (!row) continue;

    for (let i = 0; i < row.buttons.length; i++) {
      const b = gp.buttons[i];
      const v = b ? b.value || (b.pressed ? 1 : 0) : 0;
      row.buttons[i].style.width = `${Math.round(v * 100)}%`;
      row.buttonVals[i].textContent = v.toFixed(2);
      row.buttonRows[i].classList.toggle('on', !!b?.pressed);
    }
    for (let i = 0; i < row.axes.length; i++) {
      const v = gp.axes[i] ?? 0;
      // bar shows |v|; the number keeps the sign
      row.axes[i].style.width = `${Math.round(Math.abs(v) * 100)}%`;
      row.axisVals[i].textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
    }

    const rx = gp.axes[0] ?? 0, ry = gp.axes[1] ?? 0;
    const dz = applyDeadzone(rx, ry);
    const mv = padMovement(gp);
    place(row.dotRaw, rx, ry);
    place(row.dotDead, dz.x, dz.y);
    row.readout.textContent =
      `raw ${fmt(rx)}, ${fmt(ry)} (${Math.hypot(rx, ry).toFixed(2)}) · `
      + `move ${fmt(mv.x)}, ${fmt(mv.y)} (${Math.hypot(mv.x, mv.y).toFixed(2)})`;
  }
}

function place(dot: HTMLElement, x: number, y: number): void {
  dot.style.left = `${50 + Math.max(-1, Math.min(1, x)) * 48}%`;
  dot.style.top = `${50 + Math.max(-1, Math.min(1, y)) * 48}%`;
}

function fmt(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

hub.onPadConnected = (info) => console.log('[padtest] connected', info);
hub.onPadDisconnected = (i) => console.log('[padtest] disconnected', i);
frame();

// automated checks poke this instead of a real pad
(window as unknown as Record<string, unknown>).__ss26Pads = {
  hub, list: () => hub.padList(), rows: () => [...rows.keys()],
};
