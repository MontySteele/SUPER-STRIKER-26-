// Events the sim emits; consumed by UI (ticker/sequences), audio, and camera.

import type { PenResult } from './penalty';

export type MatchEvent =
  | { type: 'kickoff'; half: number }
  // scorerNum/scorerTeamIdx identify the credited player uniquely — display
  // names can be duplicated (roster editor, and one factory cross-team dupe)
  | { type: 'goal'; teamIdx: number; scorerName: string; ownGoal?: boolean; minute: number;
      scorerNum?: number; scorerTeamIdx?: number }
  | { type: 'shot'; teamIdx: number; onTarget: boolean; shooterName: string }
  // shotStop distinguishes a real shot-stop from a routine loose-ball smother
  // (both flow through the keeper's hands) — tickers/awards only want the real ones
  | { type: 'save'; keeperName: string; teamIdx: number; keeperNum?: number; shotStop?: boolean }
  | { type: 'post' }
  | { type: 'miss'; teamIdx: number; shooterName: string; minute: number }
  | { type: 'throwIn'; teamIdx: number }
  | { type: 'corner'; teamIdx: number; minute: number }
  | { type: 'goalKick'; teamIdx: number }
  | { type: 'offside'; teamIdx: number; playerName: string; minute: number }
  | { type: 'foul'; teamIdx: number; playerName: string; minute: number }
  | { type: 'card'; color: 'yellow' | 'red'; teamIdx: number; playerName: string; minute: number }
  | { type: 'penaltyAwarded'; teamIdx: number; minute: number }
  | { type: 'penTension' }
  | { type: 'penKick'; teamIdx: number; takerName: string; result: PenResult }
  | { type: 'shootoutEnd'; winnerIdx: number }
  | { type: 'break'; label: string }
  | { type: 'fulltime' }
  | { type: 'kick'; power: number }           // any kick, for SFX
  | { type: 'bounce'; speed: number }
  | { type: 'tackle' }
  | { type: 'attackBuildup'; level: number }  // 0..1 crowd anticipation
  | { type: 'possessionChange'; teamIdx: number };
