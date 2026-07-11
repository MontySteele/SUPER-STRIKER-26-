// Headless full-speed sims: CPU vs CPU league matches, knockout draws with
// extra time + shootouts, standalone shootouts, and a full tournament run.
// Run: npx tsx scripts/simTest.ts

import { Match } from '../src/sim/match';
import { Tournament } from '../src/sim/tournament';
import { findTeam } from '../src/data/loader';

// localStorage shim for the tournament save layer
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

let failures = 0;
const fail = (msg: string): void => { failures++; console.error('  !! ' + msg); };

function runMatch(homeId: string, awayId: string, opts: { knockout?: boolean; mode?: 'match' | 'shootout'; seed: number }): Match {
  const match = new Match({
    home: findTeam(homeId), away: findTeam(awayId),
    seats: [null, null],
    halfLengthSec: 150,
    difficulty: 'pro',
    knockout: opts.knockout,
    mode: opts.mode,
    seed: opts.seed,
  });
  const counts: Record<string, number> = {};
  match.events.on((e) => { counts[e.type] = (counts[e.type] ?? 0) + 1; });
  (match as unknown as { counts: Record<string, number> }).counts = counts;

  let ticks = 0;
  const MAX = 60 * 60 * 16;
  while (match.phase !== 'fulltime' && ticks < MAX) {
    match.update();
    if (match.phase === 'break') match.continueFromBreak();
    ticks++;
    if (ticks % 60 === 0) {
      const b = match.ball.pos;
      if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.z)) { fail(`ball NaN`); break; }
      if (Math.abs(b.x) > 80 || Math.abs(b.y) > 60 || b.z > 60) {
        fail(`ball escaped: ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)} phase=${match.phase}`);
        break;
      }
    }
  }
  if (match.phase !== 'fulltime') fail(`did not finish (${match.phase}) ${homeId}-${awayId}`);
  return match;
}

// --- 1) league matches -----------------------------------------------------
console.log('— league matches —');
let totalFouls = 0, totalCards = 0, totalPens = 0;
for (const [h, a, seed] of [['bra', 'aus', 1], ['esp', 'fra', 2], ['hai', 'cuw', 3], ['ger', 'jpn', 4]] as [string, string, number][]) {
  const m = runMatch(h, a, { seed });
  const c = (m as unknown as { counts: Record<string, number> }).counts;
  totalFouls += c.foul ?? 0;
  totalCards += c.card ?? 0;
  totalPens += c.penaltyAwarded ?? 0;
  console.log(`${m.teams[0].data.code} ${m.teams[0].score}-${m.teams[1].score} ${m.teams[1].data.code}` +
    ` (shots ${m.teams[0].shots}/${m.teams[1].shots}, fouls ${c.foul ?? 0}, cards ${c.card ?? 0}, pens ${c.penaltyAwarded ?? 0}, saves ${c.save ?? 0})`);
}
console.log(`aggregate: fouls ${totalFouls}, cards ${totalCards}, penalties ${totalPens}`);

// --- 2) knockout draws → extra time → shootout ------------------------------
console.log('— knockout matches —');
let sawET = false, sawShootout = false;
for (let seed = 10; seed < 22; seed++) {
  const m = runMatch('ger', 'jpn', { knockout: true, seed });
  if (m.half > 2) sawET = true;
  if (m.shootoutWinner !== null) {
    sawShootout = true;
    const b = m.penalty?.board;
    if (!b) fail('shootout without board');
    else if (b.scores[0] === b.scores[1]) fail(`shootout ended level ${b.scores[0]}-${b.scores[1]}`);
    console.log(`  seed ${seed}: ${m.teams[0].score}-${m.teams[1].score} aet, pens ${b?.scores[0]}-${b?.scores[1]} → ${m.teams[m.winner()!].data.code}`);
  } else if (m.winner() === null) {
    fail(`knockout with no winner (seed ${seed})`);
  }
}
if (!sawET) fail('no knockout match reached extra time in 12 seeds');
if (!sawShootout) console.log('  (no shootout in 12 seeds — acceptable but unusual)');

// --- 3) standalone shootout --------------------------------------------------
console.log('— standalone shootout —');
{
  const m = runMatch('bra', 'arg', { mode: 'shootout', seed: 99 });
  const b = m.penalty?.board;
  if (m.shootoutWinner === null) fail('standalone shootout: no winner');
  if (!b) fail('standalone shootout: no board');
  else {
    const kicks = b.kicks[0].length + b.kicks[1].length;
    if (kicks < 6) fail(`suspiciously few kicks: ${kicks}`);
    console.log(`  BRA ${b.scores[0]}-${b.scores[1]} ARG after ${kicks} kicks → ${m.teams[m.shootoutWinner!].data.code}`);
  }
}

// --- 4) full tournament simulation -------------------------------------------
console.log('— tournament engine —');
{
  const t = Tournament.create('bra', 'pro', 120, 424242);
  let guard = 0;
  while (t.state.stage !== 'done' && guard++ < 40) {
    // sim EVERY match including the player's (engine-level test)
    t.simulateRestOfStage();
  }
  if (t.state.stage !== 'done') fail(`tournament never finished (stage ${t.state.stage})`);
  if (!t.state.champion) fail('no champion');
  else console.log(`  champion: ${findTeam(t.state.champion).name}`);
  // structural checks
  const r32 = t.state.rounds.r32 ?? [];
  if (new Set(r32).size !== 32) fail(`r32 has ${new Set(r32).size} unique teams`);
  for (const g of 'ABCDEFGHIJKL') {
    const table = t.groupTable(g);
    const games = table.reduce((s, x) => s + x.played, 0);
    if (games !== 12) fail(`group ${g} played ${games} (expect 12 team-games)`);
  }
  const saved = Tournament.load();
  if (!saved || saved.state.champion !== t.state.champion) fail('persistence roundtrip failed');
}

console.log(failures === 0 ? 'SIM TEST PASS' : `SIM TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
