// Persistent UI preferences (localStorage, same pattern as ss26.music).

export const CONTROLS_KEY = 'ss26.controls';
export type ControlsSetting = 'on' | 'fade' | 'off';

/** In-match controls hint: always shown, dimmed after a while, or hidden. */
export function controlsSetting(): ControlsSetting {
  try {
    const v = localStorage.getItem(CONTROLS_KEY);
    if (v === 'on' || v === 'off') return v;
  } catch { /* private browsing */ }
  return 'fade';
}
