// Events the sim emits; consumed by UI (ticker/sequences), audio, and camera.

export type MatchEvent =
  | { type: 'kickoff'; half: number }
  | { type: 'goal'; teamIdx: number; scorerName: string; minute: number }
  | { type: 'shot'; teamIdx: number; onTarget: boolean; shooterName: string }
  | { type: 'save'; keeperName: string; teamIdx: number }
  | { type: 'post' }
  | { type: 'miss'; teamIdx: number; shooterName: string; minute: number }
  | { type: 'throwIn'; teamIdx: number }
  | { type: 'corner'; teamIdx: number; minute: number }
  | { type: 'goalKick'; teamIdx: number }
  | { type: 'offside'; teamIdx: number; playerName: string; minute: number }
  | { type: 'halftime' }
  | { type: 'fulltime' }
  | { type: 'kick'; power: number }           // any kick, for SFX
  | { type: 'bounce'; speed: number }
  | { type: 'tackle' }
  | { type: 'attackBuildup'; level: number }  // 0..1 crowd anticipation
  | { type: 'possessionChange'; teamIdx: number };
