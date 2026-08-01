// The disconnect ladder for a remote seat (§5.4.5). Everything — the lobby
// pips, the HUD pip on the player's nameplate, the reconnect hold and the AI
// takeover — is a pure function of how stale that guest's last input packet
// is, so it all lives here and nobody keeps a second opinion.

/** Missed heartbeats: the seat is wobbling. Yellow pip, match plays on. */
export const DEGRADE_MS = 1500;
/** The match stops and waits, with a "P2 reconnecting…" toast. */
export const HOLD_MS = 5000;
/** Long enough — the AI pulls the shirt on and the match resumes. */
export const AI_MS = 15_000;

export type SeatHealth = 'ok' | 'degraded' | 'lost' | 'gone';

export function seatHealth(ageMs: number): SeatHealth {
  if (ageMs >= AI_MS) return 'gone';
  if (ageMs >= HOLD_MS) return 'lost';
  if (ageMs >= DEGRADE_MS) return 'degraded';
  return 'ok';
}
