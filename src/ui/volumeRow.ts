// The volume fader widget (§7.3), shared by GAME SETTINGS and the pause card.
//
// Markup only — it stores nothing itself. Every move goes through
// setVolumeSetting(), which persists and fires `ss26-volume-change`; main.ts
// is what turns that into a gain ramp plus the confirm tick. That split is
// deliberate: the front end never holds a reference to the audio engine.
//
// Mouse drag repaints the bar IN PLACE rather than asking the screen to
// re-render, because a re-render swaps the element out from under the pointer
// capture and the drag dies on the first move.

import { esc } from './escape';
import {
  clampVolume, setVolumeSetting, volumeSetting, type VolumeBus,
} from '../audio/volume';

/** The `<span class="fe-vol">` a settings row puts in its value slot. */
export function volumeRowHtml(bus: VolumeBus, label: string): string {
  const v = volumeSetting(bus);
  return `<span class="fe-vol" data-vol="${esc(bus)}" role="slider" tabindex="-1"
      aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}">
      <span class="fe-vol-groove"><span class="fe-vol-fill" style="width:${v}%"></span></span>
      <b class="fe-vol-num">${v}</b>
    </span>`;
}

/** Drag/click-to-set on every fader inside `root`. Safe to call after a repaint. */
export function wireVolumeRows(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.fe-vol').forEach((el) => {
    const bus = el.dataset.vol as VolumeBus | undefined;
    const groove = el.querySelector<HTMLElement>('.fe-vol-groove');
    const fill = el.querySelector<HTMLElement>('.fe-vol-fill');
    const num = el.querySelector<HTMLElement>('.fe-vol-num');
    if (!bus || !groove || !fill || !num) return;

    const pctAt = (clientX: number): number => {
      const r = groove.getBoundingClientRect();
      if (r.width <= 0) return volumeSetting(bus);
      return clampVolume(((clientX - r.left) / r.width) * 100);
    };
    const show = (v: number): void => {
      fill.style.width = `${v}%`;
      num.textContent = String(v);
      el.setAttribute('aria-valuenow', String(v));
    };

    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      // the row behind us treats a click as "cycle this setting" — not here
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch { /* no capture: still works */ }
      show(setVolumeSetting(bus, pctAt(e.clientX)));
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const v = pctAt(e.clientX);
      if (v === volumeSetting(bus)) return;   // one tick per step, not per pixel
      show(setVolumeSetting(bus, v));
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => e.stopPropagation());
  });
}

/** Repaint a fader's bar from storage without re-rendering the screen. */
export function refreshVolumeRows(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.fe-vol').forEach((el) => {
    const bus = el.dataset.vol as VolumeBus | undefined;
    if (!bus) return;
    const v = volumeSetting(bus);
    const fill = el.querySelector<HTMLElement>('.fe-vol-fill');
    const num = el.querySelector<HTMLElement>('.fe-vol-num');
    if (fill) fill.style.width = `${v}%`;
    if (num) num.textContent = String(v);
    el.setAttribute('aria-valuenow', String(v));
  });
}
