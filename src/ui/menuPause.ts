// The in-match pause overlay (front end, not HUD).
//
// The HUD owns the in-match TV graphics; the pause screen is a front-end
// screen that happens to sit over a match, so it lives here and wears the same
// dark-glossy package as the menus. It is deliberately presentational: main.ts
// still owns the pause state machine (pass = resume, loft = quit), so this
// cannot desync from it and cannot swallow a press.

import './menu.css';
import { esc } from './escape';
import { prompt } from './menuGlyphs';
import { MenuNav } from './menuNav';
import { VOLUME_LABEL, nudgeVolume } from '../audio/volume';
import { refreshVolumeRows, volumeRowHtml, wireVolumeRows } from './volumeRow';

export interface PauseInfo {
  home?: string;
  away?: string;
  homeColor?: string;
  awayColor?: string;
  /** Where the quit option goes: 'MAIN MENU' or 'TOURNAMENT HUB'. */
  quitTo?: string;
  /** Set when the graphics context died rather than the player pausing. */
  reason?: string;
}

let node: HTMLElement | null = null;
/**
 * Left/right on the MASTER row while paused. It is a MenuNav rather than a
 * hook into main.ts's pause branch because MenuNav only READS the pads — it
 * cannot desync the hub's edge detection that the pause state machine runs on
 * — and it handles nothing but onDir, so it can never swallow resume or quit.
 */
let volNav: MenuNav | null = null;

export function showPauseOverlay(info: PauseInfo = {}): void {
  const root = document.getElementById('ui-root');
  if (!root) return;
  hidePauseOverlay();
  const el = document.createElement('div');
  el.className = 'fe fe-pause fe-skin';
  const chip = (name?: string, color?: string): string => (name
    ? `<span class="fe-seat-team" style="display:inline-flex">
        <span class="fe-dot" style="background:${esc(color ?? '#ffffff')}"></span>${esc(name)}</span>`
    : '');
  const line = info.home || info.away
    ? `<div class="fe-side-meta" style="margin:0 0 18px;gap:14px;align-items:center">
        ${chip(info.home, info.homeColor)}
        <span style="color:var(--fe-gold)">VS</span>
        ${chip(info.away, info.awayColor)}
      </div>`
    : '';
  el.innerHTML = `
    <div class="fe-pause-card">
      <div class="fe-pause-h">PAUSED</div>
      <div class="fe-pause-sub">${esc(info.reason ?? 'THE MATCH IS HOLDING')}</div>
      ${line}
      <div class="fe-pause-opt primary">${prompt('confirm', 'RESUME MATCH')}</div>
      <div class="fe-pause-opt">${prompt('back', `QUIT TO ${esc(info.quitTo ?? 'MAIN MENU')}`)}</div>
      <div class="fe-pause-opt fe-pause-vol">
        <span class="fe-row-k">${esc(VOLUME_LABEL.master)}</span>
        <span class="fe-row-v"><u>◀</u>${volumeRowHtml('master', VOLUME_LABEL.master)}<u>▶</u></span>
      </div>
    </div>`;
  root.appendChild(el);
  node = el;
  wireVolumeRows(el);

  const nudge = (dir: -1 | 1): void => {
    nudgeVolume('master', dir);
    if (node) refreshVolumeRows(node);
  };
  volNav?.destroy();
  // padOnly: MenuNav's keyboard map treats A/D as left/right, and A/D are
  // gameplay keys — a paused player must not move the fader by resting on one.
  // The arrows are unambiguous, so they get their own listener.
  volNav = new MenuNav({
    onDir: (d) => { if (d === 'left' || d === 'right') nudge(d === 'left' ? -1 : 1); },
  }, { padOnly: true });
  window.addEventListener('keydown', onPauseKey);
}

function onPauseKey(e: KeyboardEvent): void {
  if (!node) return;
  if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
  nudgeVolume('master', e.code === 'ArrowLeft' ? -1 : 1);
  refreshVolumeRows(node);
}

export function hidePauseOverlay(): void {
  window.removeEventListener('keydown', onPauseKey);
  volNav?.destroy();
  volNav = null;
  node?.remove();
  node = null;
}

/** True while the overlay is up — handy for a caller that re-enters pause. */
export function pauseOverlayVisible(): boolean {
  return node !== null;
}
