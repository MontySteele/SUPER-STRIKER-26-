import teamsJson from './teams.json';
import formationsJson from './formations.json';
import type { TeamData, PlayerData, FormationsFile, FormationDef, Pos } from './types';

export const TEAMS: TeamData[] = (teamsJson as { teams: TeamData[] }).teams;
export const FORMATIONS = formationsJson as unknown as FormationsFile;

export function overall(p: PlayerData): number {
  switch (p.pos) {
    case 'GK': return p.keeping * 0.7 + p.passing * 0.1 + p.pace * 0.1 + p.stamina * 0.1;
    case 'DF': return p.defending * 0.5 + p.pace * 0.2 + p.passing * 0.15 + p.stamina * 0.15;
    case 'MF': return p.passing * 0.4 + p.pace * 0.2 + p.shooting * 0.15 + p.defending * 0.1 + p.stamina * 0.15;
    case 'FW': return p.shooting * 0.45 + p.pace * 0.3 + p.passing * 0.1 + p.stamina * 0.15;
  }
}

export function teamRating(t: TeamData): number {
  const xi = pickStartingXI(t);
  return xi.reduce((s, p) => s + overall(p), 0) / xi.length;
}

/**
 * Pick the best starting XI for the team's formation. Slots are filled by
 * position; if a position group is short (roster shapes vary), the best
 * remaining player from adjacent groups fills in.
 */
export function pickStartingXI(team: TeamData): PlayerData[] {
  const def: FormationDef = FORMATIONS.formations[team.formation] ?? FORMATIONS.formations['4-4-2'];
  const need: [Pos, number][] = [
    ['GK', def.GK.length],
    ['DF', def.DF.length],
    ['MF', def.MF.length],
    ['FW', def.FW.length],
  ];
  const pool = [...team.players];
  const fallbacks: Record<Pos, Pos[]> = {
    GK: ['GK'],
    DF: ['DF', 'MF'],
    MF: ['MF', 'FW', 'DF'],
    FW: ['FW', 'MF'],
  };
  const xi: PlayerData[] = [];
  for (const [pos, count] of need) {
    for (let i = 0; i < count; i++) {
      let best: PlayerData | null = null;
      let bestScore = -1;
      for (const alt of fallbacks[pos]) {
        for (const p of pool) {
          if (p.pos !== alt) continue;
          const s = overall(p) + (p.star ? 10 : 0);
          if (s > bestScore) { best = p; bestScore = s; }
        }
        if (best) break; // only fall through to the next position group if empty
      }
      if (!best) { best = pool[0]; }
      xi.push(best);
      pool.splice(pool.indexOf(best), 1);
    }
  }
  return xi;
}

/** Star players get +10 to all ratings per spec §4, capped at 99. */
export function effectiveRating(p: PlayerData, key: Exclude<keyof PlayerData, 'name' | 'num' | 'pos' | 'star'>): number {
  const v = p[key] as number;
  return Math.min(99, p.star ? v + 10 : v);
}

export function findTeam(id: string): TeamData {
  const t = TEAMS.find((t) => t.id === id);
  if (!t) throw new Error(`unknown team ${id}`);
  return t;
}
