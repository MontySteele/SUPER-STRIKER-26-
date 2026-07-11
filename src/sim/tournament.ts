// Tournament (§3.2): the full 48-team format — 12 groups of 4, top two plus
// the 8 best third-placers into a 32-team knockout. Non-player matches are
// simulated from team ratings + randomness. Saved to localStorage so the run
// survives a refresh.

import { RNG } from '../core/rng';
import { TEAMS, findTeam, teamRating } from '../data/loader';
import type { TeamData } from '../data/types';
import type { DifficultyName } from './match';

export type Stage = 'md1' | 'md2' | 'md3' | 'r32' | 'r16' | 'qf' | 'sf' | 'final' | 'done';
const STAGES: Stage[] = ['md1', 'md2', 'md3', 'r32', 'r16', 'qf', 'sf', 'final', 'done'];
const KO_SIZE: Record<string, number> = { r32: 16, r16: 8, qf: 4, sf: 2, final: 1 };

export interface Result {
  homeId: string;
  awayId: string;
  homeGoals: number;
  awayGoals: number;
  /** knockout only: set when decided on penalties */
  penWinnerId?: string;
}

export interface Fixture {
  homeId: string;
  awayId: string;
  stage: Stage;
  /** knockout slot index within the round (bracket position) */
  slot?: number;
}

export interface Standing {
  teamId: string;
  played: number; won: number; drawn: number; lost: number;
  gf: number; ga: number; pts: number;
  group: string;
}

interface SaveState {
  version: number;
  playerTeamId: string;
  seed: number;
  difficulty: DifficultyName;
  halfLengthSec: number;
  stage: Stage;
  results: Partial<Record<Stage, Result[]>>;
  /** knockout brackets: team ids per round, in bracket order (pairs 2k,2k+1) */
  rounds: Partial<Record<Stage, string[]>>;
  champion?: string;
}

const LS_KEY = 'ss26.tournament';
const GROUP_NAMES = 'ABCDEFGHIJKL'.split('');

export class Tournament {
  state: SaveState;
  private rng: RNG;

  private constructor(state: SaveState) {
    this.state = state;
    this.rng = new RNG(state.seed ^ 0x5eed);
  }

  static create(playerTeamId: string, difficulty: DifficultyName, halfLengthSec: number, seed: number): Tournament {
    const t = new Tournament({
      version: 1, playerTeamId, seed, difficulty, halfLengthSec,
      stage: 'md1', results: {}, rounds: {},
    });
    t.save();
    return t;
  }

  static load(): Tournament | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw) as SaveState;
      if (state.version !== 1 || !state.playerTeamId) return null;
      return new Tournament(state);
    } catch {
      return null;
    }
  }

  static clear(): void {
    try { localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
  }

  save(): void {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); } catch { /* private mode */ }
  }

  playerTeam(): TeamData { return findTeam(this.state.playerTeamId); }

  group(name: string): TeamData[] {
    return TEAMS.filter((t) => t.group === name);
  }

  // ------------------------------------------------------------- fixtures

  /** All fixtures of the current stage (group matchday or knockout round). */
  fixtures(stage: Stage = this.state.stage): Fixture[] {
    if (stage === 'done') return [];
    if (stage.startsWith('md')) {
      const md = Number(stage[2]); // 1..3
      const out: Fixture[] = [];
      // round-robin pattern: MD1 0v1,2v3 · MD2 0v2,1v3 · MD3 0v3,1v2
      const pairs = md === 1 ? [[0, 1], [2, 3]] : md === 2 ? [[0, 2], [1, 3]] : [[0, 3], [1, 2]];
      for (const g of GROUP_NAMES) {
        const teams = this.group(g);
        for (const [a, b] of pairs) {
          out.push({ homeId: teams[a].id, awayId: teams[b].id, stage });
        }
      }
      return out;
    }
    const round = this.state.rounds[stage];
    if (!round) return [];
    const out: Fixture[] = [];
    for (let k = 0; k < round.length / 2; k++) {
      out.push({ homeId: round[k * 2], awayId: round[k * 2 + 1], stage, slot: k });
    }
    return out;
  }

  results(stage: Stage = this.state.stage): Result[] {
    return this.state.results[stage] ?? [];
  }

  private isPlayed(f: Fixture): boolean {
    return this.results(f.stage).some((r) =>
      (r.homeId === f.homeId && r.awayId === f.awayId));
  }

  /** The player's unplayed fixture in the current stage, if any. */
  playerFixture(): Fixture | null {
    const id = this.state.playerTeamId;
    for (const f of this.fixtures()) {
      if ((f.homeId === id || f.awayId === id) && !this.isPlayed(f)) return f;
    }
    return null;
  }

  playerAlive(): boolean {
    if (this.state.stage === 'done') return this.state.champion === this.state.playerTeamId;
    if (this.state.stage.startsWith('md')) return true;
    const round = this.state.rounds[this.state.stage] ?? [];
    return round.includes(this.state.playerTeamId);
  }

  /** Record the player's in-engine result, then sim the rest of the stage. */
  reportPlayerResult(homeGoals: number, awayGoals: number, penWinnerId?: string): void {
    const f = this.playerFixture();
    if (!f) return;
    this.pushResult(f.stage, {
      homeId: f.homeId, awayId: f.awayId, homeGoals, awayGoals, penWinnerId,
    });
    this.simulateRestOfStage();
  }

  /** Sim every remaining fixture of the stage and advance. */
  simulateRestOfStage(): void {
    const stage = this.state.stage;
    if (stage === 'done') return;
    for (const f of this.fixtures(stage)) {
      if (this.isPlayed(f)) continue;
      this.pushResult(stage, this.simMatch(f, !stage.startsWith('md')));
    }
    this.advanceStage();
    this.save();
  }

  private pushResult(stage: Stage, r: Result): void {
    if (!this.state.results[stage]) this.state.results[stage] = [];
    this.state.results[stage]!.push(r);
  }

  // ------------------------------------------------------------- lightweight sim

  /**
   * Per-fixture RNG: the shared stream's position is not persisted, so a
   * mid-tournament reload would replay earlier draws. Hashing (seed, fixture)
   * makes every simmed result reload-stable.
   */
  private fixtureRng(f: Fixture): RNG {
    let h = this.state.seed ^ 0x9e3779b9;
    const s = `${f.stage}:${f.homeId}:${f.awayId}`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return new RNG(h >>> 0);
  }

  private simMatch(f: Fixture, knockout: boolean): Result {
    const rng = this.fixtureRng(f);
    const a = findTeam(f.homeId), b = findTeam(f.awayId);
    const ra = teamRating(a), rb = teamRating(b);
    const adv = (ra - rb) / 11;
    const xgA = Math.min(Math.max(1.25 + adv * 0.6, 0.2), 4.2);
    const xgB = Math.min(Math.max(1.25 - adv * 0.6, 0.2), 4.2);
    let hg = this.poisson(xgA, rng);
    let ag = this.poisson(xgB, rng);
    let penWinnerId: string | undefined;
    if (knockout && hg === ag) {
      // extra time: one side may nick it
      if (rng.next() < 0.42) {
        if (rng.next() < 0.5 + adv * 0.1) hg++; else ag++;
      } else {
        // penalties: keeper quality tilts the coin slightly
        const ka = a.players.reduce((m, p) => Math.max(m, p.keeping), 0);
        const kb = b.players.reduce((m, p) => Math.max(m, p.keeping), 0);
        const pA = 0.5 + (ka - kb) / 400 + adv * 0.04;
        penWinnerId = rng.next() < pA ? a.id : b.id;
      }
    }
    return { homeId: a.id, awayId: b.id, homeGoals: hg, awayGoals: ag, penWinnerId };
  }

  private poisson(lambda: number, rng: RNG = this.rng): number {
    const l = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rng.next(); } while (p > l && k < 9);
    return k - 1;
  }

  // ------------------------------------------------------------- standings

  groupTable(name: string): Standing[] {
    const teams = this.group(name);
    const table = new Map<string, Standing>(teams.map((t) => [t.id, {
      teamId: t.id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0, group: name,
    }]));
    for (const stage of ['md1', 'md2', 'md3'] as Stage[]) {
      for (const r of this.results(stage)) {
        const h = table.get(r.homeId), aw = table.get(r.awayId);
        if (!h || !aw) continue;
        h.played++; aw.played++;
        h.gf += r.homeGoals; h.ga += r.awayGoals;
        aw.gf += r.awayGoals; aw.ga += r.homeGoals;
        if (r.homeGoals > r.awayGoals) { h.won++; aw.lost++; h.pts += 3; }
        else if (r.homeGoals < r.awayGoals) { aw.won++; h.lost++; aw.pts += 3; }
        else { h.drawn++; aw.drawn++; h.pts++; aw.pts++; }
      }
    }
    return [...table.values()].sort(cmpStanding);
  }

  /** The 12 third-placed teams ranked; first 8 qualify. */
  thirdTable(): Standing[] {
    return GROUP_NAMES.map((g) => this.groupTable(g)[2]).sort(cmpStanding);
  }

  winnerOf(r: Result): string {
    if (r.homeGoals > r.awayGoals) return r.homeId;
    if (r.awayGoals > r.homeGoals) return r.awayId;
    return r.penWinnerId ?? r.homeId;
  }

  // ------------------------------------------------------------- progression

  private advanceStage(): void {
    const stage = this.state.stage;
    const idx = STAGES.indexOf(stage);
    // group stage complete → seed the round of 32
    if (stage === 'md3') {
      this.seedR32();
      this.state.stage = 'r32';
      return;
    }
    if (stage === 'final') {
      const r = this.results('final')[0];
      this.state.champion = r ? this.winnerOf(r) : undefined;
      this.state.stage = 'done';
      return;
    }
    if (stage.startsWith('md')) {
      this.state.stage = STAGES[idx + 1];
      return;
    }
    // knockout round complete → build the next round from winners in bracket order
    const next = STAGES[idx + 1] as Stage;
    const fixtures = this.fixtures(stage);
    const winners: string[] = [];
    for (const f of fixtures) {
      const r = this.results(stage).find((x) => x.homeId === f.homeId && x.awayId === f.awayId);
      winners.push(r ? this.winnerOf(r) : f.homeId);
    }
    this.state.rounds[next] = winners;
    this.state.stage = next;
  }

  private seedR32(): void {
    const winners = GROUP_NAMES.map((g) => this.groupTable(g)[0]);
    const runners = GROUP_NAMES.map((g) => this.groupTable(g)[1]);
    const thirds = this.thirdTable().slice(0, 8);
    const seeds = [
      ...winners.sort(cmpStanding),
      ...runners.sort(cmpStanding),
      ...thirds,
    ].map((s) => s.teamId);
    // standard serpentine: seed k vs seed 31-k, laid out so 1 and 2 can only
    // meet in the final
    const order = bracketOrder(16);
    const round: string[] = [];
    for (const pos of order) {
      round.push(seeds[pos], seeds[31 - pos]);
    }
    this.state.rounds.r32 = round;
  }
}

function cmpStanding(a: Standing, b: Standing): number {
  // pts → GD → GF → team rating (better squad edges the tiebreak, which beats
  // rewarding an alphabetically early id) → id as a stable last resort
  return b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf
    || teamRating(findTeam(b.teamId)) - teamRating(findTeam(a.teamId))
    || a.teamId.localeCompare(b.teamId);
}

/** Positions of seeds 0..n-1 down the bracket so 0 and 1 land in opposite halves. */
function bracketOrder(n: number): number[] {
  let order = [0];
  while (order.length < n) {
    const size = order.length * 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s, size - 1 - s);
    }
    order = next;
  }
  return order;
}
