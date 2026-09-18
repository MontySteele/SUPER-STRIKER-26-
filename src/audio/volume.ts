// Volume settings (§7.3): four persisted faders, 0..100 in steps of 5.
//
// Lives next to the engine rather than in src/ui/prefs.ts for the same reason
// MUSIC_KEY lives in music.ts and COMMENTARY_KEY in commentary.ts — the audio
// layer owns its own settings, and the front end imports them. Nothing here
// touches an AudioContext, so the headless smoke check can import it too.
//
// Storage is plain integers under `ss26.vol.*`; a write also fires
// `ss26-volume-change` so main.ts can push the new level into the live graph
// (and tick the fader so you HEAR where you just put it).

export type VolumeBus = 'master' | 'music' | 'sfx' | 'voice';

export const VOLUME_BUSES: VolumeBus[] = ['master', 'music', 'sfx', 'voice'];

export const VOLUME_KEY: Record<VolumeBus, string> = {
  master: 'ss26.vol.master',
  music: 'ss26.vol.music',
  sfx: 'ss26.vol.sfx',
  voice: 'ss26.vol.voice',
};

/** Shipping mix: these four values reproduce the pre-slider balance exactly. */
export const VOLUME_DEFAULT: Record<VolumeBus, number> = {
  master: 80,
  music: 60,
  sfx: 100,
  voice: 100,
};

/** Row labels in the front end (also the key the menu maps back to a bus). */
export const VOLUME_LABEL: Record<VolumeBus, string> = {
  master: 'MASTER VOLUME',
  music: 'MUSIC VOLUME',
  sfx: 'CROWD & SFX',
  voice: 'COMMENTARY VOL',
};

export const VOLUME_STEP = 5;

/** The event a fader write dispatches; detail is { bus, value }. */
export const VOLUME_EVENT = 'ss26-volume-change';

export interface VolumeChangeDetail { bus: VolumeBus; value: number }

/** 0..100, snapped to the step. Anything unparseable lands on 0. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const snapped = Math.round(v / VOLUME_STEP) * VOLUME_STEP;
  return Math.max(0, Math.min(100, snapped));
}

export function volumeSetting(bus: VolumeBus): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY[bus]);
    if (raw !== null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampVolume(n);
    }
  } catch { /* private browsing */ }
  return VOLUME_DEFAULT[bus];
}

/** Persist + announce. Returns the value actually stored. */
export function setVolumeSetting(bus: VolumeBus, v: number): number {
  const next = clampVolume(v);
  try {
    localStorage.setItem(VOLUME_KEY[bus], String(next));
  } catch { /* private browsing: the fader still works, it just won't persist */ }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<VolumeChangeDetail>(VOLUME_EVENT, {
      detail: { bus, value: next },
    }));
  }
  return next;
}

/** One step left or right (`dir` is -1 / +1), clamped at the ends. */
export function nudgeVolume(bus: VolumeBus, dir: number): number {
  return setVolumeSetting(bus, volumeSetting(bus) + (dir < 0 ? -VOLUME_STEP : VOLUME_STEP));
}

/**
 * Perceptual taper. Loudness is roughly the square root of power, so a square
 * law on the fader is what makes 50 sound like "half" instead of "barely
 * quieter" — the same curve every console mixer uses. 0 is true silence.
 */
export function volumeGain(pct: number): number {
  const v = Math.max(0, Math.min(100, pct)) / 100;
  return v * v;
}
