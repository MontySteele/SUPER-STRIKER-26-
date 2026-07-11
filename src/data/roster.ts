// Roster overrides: the editor's changes live in localStorage and are applied
// onto the in-memory TEAMS at boot. teams.json stays pristine on disk; a
// per-team factory snapshot is taken here before any override lands, so
// RESET always works.

import { TEAMS } from './loader';
import type { PlayerData, TeamData } from './types';

const LS_KEY = 'ss26.roster';

interface RosterSave {
  version: number;
  teams: Record<string, PlayerData[]>;
}

// factory snapshot — module loads before applyRosterOverrides() runs
const PRISTINE: Record<string, PlayerData[]> = {};
for (const t of TEAMS) PRISTINE[t.id] = t.players.map((p) => ({ ...p }));

const clampStat = (v: unknown, fallback: number): number =>
  typeof v === 'number' && isFinite(v) ? Math.min(99, Math.max(1, Math.round(v))) : fallback;

/** Sanitize one edited player against its factory original. */
export function sanitizePlayer(p: Partial<PlayerData>, original: PlayerData): PlayerData {
  const name = typeof p.name === 'string' && p.name.trim().length > 0
    ? p.name.trim().slice(0, 24)
    : original.name;
  return {
    name,
    num: clampStat(p.num, original.num),
    pos: original.pos, // position is structural (formation slots) — not editable
    pace: clampStat(p.pace, original.pace),
    shooting: clampStat(p.shooting, original.shooting),
    passing: clampStat(p.passing, original.passing),
    defending: clampStat(p.defending, original.defending),
    keeping: clampStat(p.keeping, original.keeping),
    stamina: clampStat(p.stamina, original.stamina),
    star: !!p.star,
  };
}

function readSave(): RosterSave {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { version: 1, teams: {} };
    const save = JSON.parse(raw) as RosterSave;
    if (save.version !== 1 || typeof save.teams !== 'object' || !save.teams) {
      return { version: 1, teams: {} };
    }
    return save;
  } catch {
    return { version: 1, teams: {} };
  }
}

function writeSave(save: RosterSave): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(save)); } catch { /* private mode */ }
}

/** Apply saved edits onto the live TEAMS. Call once at boot. */
export function applyRosterOverrides(): void {
  const save = readSave();
  for (const [id, players] of Object.entries(save.teams)) {
    const team = TEAMS.find((t) => t.id === id);
    const pristine = PRISTINE[id];
    if (!team || !pristine || !Array.isArray(players)) continue;
    team.players = pristine.map((orig, i) => sanitizePlayer(players[i] ?? orig, orig));
  }
}

/** Persist a team's current (already-applied) roster. */
export function saveTeamRoster(team: TeamData): void {
  const save = readSave();
  save.teams[team.id] = team.players;
  writeSave(save);
}

/** Restore a team to teams.json factory data and drop its override. */
export function resetTeamRoster(team: TeamData): void {
  const pristine = PRISTINE[team.id];
  if (pristine) team.players = pristine.map((p) => ({ ...p }));
  const save = readSave();
  delete save.teams[team.id];
  writeSave(save);
}

/** True if the team differs from factory (has a saved override). */
export function teamEdited(teamId: string): boolean {
  return teamId in readSave().teams;
}

export function factoryPlayers(teamId: string): PlayerData[] {
  return (PRISTINE[teamId] ?? []).map((p) => ({ ...p }));
}
