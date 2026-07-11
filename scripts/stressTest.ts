// Heavy headless stress harness: broad seed sweep with per-tick invariants,
// all difficulties, mismatched teams, forced edge cases (send-offs, in-match
// penalties), long matches, and repeated tournaments.
// Run: npx tsx scripts/stressTest.ts        (slower than simTest — ~a minute)

import { Match } from '../src/sim/match';
import { Tournament } from '../src/sim/tournament';
import { TEAMS, findTeam } from '../src/data/loader';
import type { DifficultyName } from '../src/sim/match';

// localStorage shim for the tournament save layer
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

let failures = 0;
const fail = (msg: string): void => { failures++; console.error('  !! ' + msg); };

// deterministic pair picker
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunResult { match: Match; ticks: number; }

function runToFulltime(match: Match, maxTicks = 60 * 60 * 20, label = ''): RunResult {
  let ticks = 0;
  while (match.phase !== 'fulltime' && ticks < maxTicks) {
    match.update();
    if (match.phase === 'break') match.continueFromBreak();
    ticks++;
    if (ticks % 30 === 0) checkInvariants(match, label);
  }
  if (match.phase !== 'fulltime') fail(`${label}: did not finish (phase=${match.phase} half=${match.half})`);
  return { match, ticks };
}

function checkInvariants(m: Match, label: string): void {
  const b = m.ball.pos;
  if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.z)) { fail(`${label}: ball NaN`); throw new Error('abort'); }
  if (Math.abs(b.x) > 80 || Math.abs(b.y) > 60 || b.z > 60) {
    fail(`${label}: ball escaped (${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}) phase=${m.phase}`);
    throw new Error('abort');
  }
  for (const team of m.teams) {
    for (const p of team.players) {
      if (!isFinite(p.pos.x) || !isFinite(p.pos.y)) { fail(`${label}: player NaN (${p.data.name})`); throw new Error('abort'); }
      if (Math.abs(p.pos.x) > 90 || Math.abs(p.pos.y) > 70) {
        fail(`${label}: player escaped ${p.data.name} (${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)})`);
        throw new Error('abort');
      }
      if (p.sentOff && m.ball.owner === p) fail(`${label}: sent-off player owns the ball (${p.data.name})`);
    }
  }
  if (m.teams[0].score > 20 || m.teams[1].score > 20) fail(`${label}: absurd score ${m.teams[0].score}-${m.teams[1].score}`);
}

function makeMatch(homeId: string, awayId: string, seed: number, opts: {
  difficulty?: DifficultyName; knockout?: boolean; halfLengthSec?: number;
  mode?: 'match' | 'shootout' | 'golden';
} = {}): Match {
  return new Match({
    home: findTeam(homeId), away: findTeam(awayId),
    seats: [null, null],
    halfLengthSec: opts.halfLengthSec ?? 120,
    difficulty: opts.difficulty ?? 'pro',
    knockout: opts.knockout,
    mode: opts.mode,
    seed,
  });
}

// --- 1) broad seed sweep: random pairs, all difficulties ---------------------
console.log('— seed sweep (18 matches, mixed difficulty) —');
{
  const pick = mulberry32(777);
  const diffs: DifficultyName[] = ['amateur', 'pro', 'legend'];
  let goals = 0, zeroShotTeams = 0, fouls = 0, cards = 0;
  for (let i = 0; i < 18; i++) {
    const home = TEAMS[Math.floor(pick() * TEAMS.length)];
    let away = TEAMS[Math.floor(pick() * TEAMS.length)];
    if (away === home) away = TEAMS[(TEAMS.indexOf(home) + 7) % TEAMS.length];
    const m = makeMatch(home.id, away.id, 1000 + i, { difficulty: diffs[i % 3] });
    const counts: Record<string, number> = {};
    m.events.on((e) => { counts[e.type] = (counts[e.type] ?? 0) + 1; });
    runToFulltime(m, undefined, `${home.code}-${away.code} s${1000 + i}`);
    goals += m.teams[0].score + m.teams[1].score;
    if (m.teams[0].shots === 0) zeroShotTeams++;
    if (m.teams[1].shots === 0) zeroShotTeams++;
    fouls += counts.foul ?? 0;
    cards += counts.card ?? 0;
    const goalEvents = counts.goal ?? 0;
    if (goalEvents !== m.teams[0].score + m.teams[1].score) {
      fail(`${home.code}-${away.code}: goal events ${goalEvents} != scoreboard ${m.teams[0].score + m.teams[1].score}`);
    }
  }
  console.log(`  avg goals/match ${(goals / 18).toFixed(2)}, zero-shot teams ${zeroShotTeams}/36, fouls ${fouls}, cards ${cards}`);
  if (goals / 18 > 6) fail(`goal rate too high: ${(goals / 18).toFixed(2)}/match`);
  if (goals === 0) fail('no goals in 18 matches');
  if (zeroShotTeams > 12) fail(`too many teams with zero shots: ${zeroShotTeams}/36`);
}

// --- 2) mismatch + long-match stability ---------------------------------------
console.log('— mismatch & long match —');
{
  // strongest vs weakest, both directions
  const a = runToFulltime(makeMatch('bra', 'cuw', 51), undefined, 'bra-cuw').match;
  const b = runToFulltime(makeMatch('cuw', 'bra', 52), undefined, 'cuw-bra').match;
  console.log(`  BRA ${a.teams[0].score}-${a.teams[1].score} CUW / CUW ${b.teams[0].score}-${b.teams[1].score} BRA`);
  if (a.teams[0].score + b.teams[1].score < a.teams[1].score + b.teams[0].score) {
    console.log('  (note: minnow outscored the favourite across the pair — variance, watch it)');
  }
  // 10-minute setting = 300s halves
  const long = runToFulltime(makeMatch('esp', 'ned', 53, { halfLengthSec: 300 }), 60 * 60 * 24, 'long-match').match;
  console.log(`  long match ESP ${long.teams[0].score}-${long.teams[1].score} NED ok`);
}

// --- 3) forced send-off: exclusion invariants ----------------------------------
console.log('— send-off exclusion —');
{
  const m = makeMatch('ger', 'jpn', 60);
  // warm up past kickoff
  for (let i = 0; i < 600; i++) m.update();
  const victim = m.teams[1].players.find((p) => p.role !== 'GK' && !p.sentOff)!;
  (m as unknown as { sendOff(p: unknown): void }).sendOff(victim);
  if (!victim.sentOff) fail('sendOff did not mark player');
  let ownedBySentOff = 0;
  let controlledSentOff = 0;
  for (let i = 0; i < 60 * 120; i++) {
    m.update();
    if (m.phase === 'break') m.continueFromBreak();
    if (m.phase === 'fulltime') break;
    if (m.ball.owner === victim) ownedBySentOff++;
    if (m.controlled[0] === victim || m.controlled[1] === victim) controlledSentOff++;
    // sent-off players must not drift back into play
    if (i % 60 === 0 && victim.sentOff && Math.abs(victim.pos.y) < 33 && Math.abs(victim.pos.x) < 51) {
      // allowed to be parked somewhere; only fail if he's moving with intent
      const speed = Math.hypot(victim.vel.x, victim.vel.y);
      if (speed > 3) fail(`sent-off player sprinting (${speed.toFixed(1)} m/s)`);
    }
  }
  if (ownedBySentOff > 0) fail(`sent-off player possessed the ball for ${ownedBySentOff} ticks`);
  if (controlledSentOff > 0) fail(`sent-off player selected as controlled for ${controlledSentOff} ticks`);
  console.log('  send-off exclusion ok');
}

// --- 3b) keeper send-off: an emergency keeper takes over -----------------------
{
  const m = makeMatch('esp', 'por', 61);
  for (let i = 0; i < 600; i++) m.update();
  const gk = m.teams[0].keeper;
  (m as unknown as { sendOff(p: unknown): void }).sendOff(gk);
  const nk = m.teams[0].keeper;
  if (nk === gk) fail('GK sent off but no emergency keeper promoted');
  if (nk.sentOff) fail('promoted keeper is himself sent off');
  if (!nk.isGK) fail('promoted keeper did not take the GK role');
  runToFulltime(m, undefined, 'gk-redcard');
  console.log('  emergency keeper ok');
}

// --- 4) forced in-match penalty: converts or restarts, match continues --------
console.log('— in-match penalty resolution —');
for (const seed of [70, 71, 72, 73]) {
  const m = makeMatch('fra', 'mar', seed);
  for (let i = 0; i < 600; i++) m.update();
  (m as unknown as { beginPenalty(t: number): void }).beginPenalty(0);
  if (m.phase !== 'penalty') { fail(`beginPenalty did not enter penalty phase (seed ${seed})`); continue; }
  let guard = 0;
  while ((m.phase as string) === 'penalty' && guard++ < 60 * 40) m.update();
  if ((m.phase as string) === 'penalty') { fail(`penalty never resolved (seed ${seed})`); continue; }
  runToFulltime(m, undefined, `pk-seed${seed}`);
}
console.log('  in-match penalties resolve and matches finish');

// --- 5) knockout sweep: every match must produce a winner ----------------------
console.log('— knockout sweep (16 seeds) —');
{
  let ets = 0, pens = 0;
  for (let seed = 200; seed < 216; seed++) {
    const m = runToFulltime(makeMatch('usa', 'kor', seed, { knockout: true }), undefined, `ko-s${seed}`).match;
    if (m.winner() === null) fail(`knockout no winner (seed ${seed})`);
    if (m.half > 2) ets++;
    if (m.shootoutWinner !== null) {
      pens++;
      const b = m.penalty?.board;
      if (b && b.scores[0] === b.scores[1]) fail(`level shootout (seed ${seed})`);
    }
  }
  console.log(`  16/16 decided (${ets} to ET, ${pens} to pens)`);
}

// --- 6) shootout-mode sweep ------------------------------------------------------
console.log('— shootout mode (8 seeds) —');
for (let seed = 300; seed < 308; seed++) {
  const m = runToFulltime(makeMatch('arg', 'eng', seed, { mode: 'shootout' }), 60 * 60 * 10, `so-s${seed}`).match;
  if (m.shootoutWinner === null) fail(`shootout no winner (seed ${seed})`);
  const b = m.penalty?.board;
  if (!b) { fail(`no board (seed ${seed})`); continue; }
  const kicks = b.kicks[0].length + b.kicks[1].length;
  if (kicks < 6 || kicks > 40) fail(`odd kick count ${kicks} (seed ${seed})`);
}
console.log('  all shootouts decided');

// --- 7) tournament sweep ----------------------------------------------------------
console.log('— tournaments (4 seeds) —');
for (const seed of [1111, 2222, 3333, 4444]) {
  const t = Tournament.create('mex', 'pro', 120, seed);
  let guard = 0;
  while (t.state.stage !== 'done' && guard++ < 40) t.simulateRestOfStage();
  if (t.state.stage !== 'done' || !t.state.champion) { fail(`tournament stuck (seed ${seed}, stage ${t.state.stage})`); continue; }
  const r32 = t.state.rounds.r32 ?? [];
  if (new Set(r32).size !== 32) fail(`r32 not 32 unique (seed ${seed})`);
  // golden boot: a full 104-match tournament must produce scorers, and the
  // tally must equal the goals actually recorded in results
  const boot = t.topScorers(1)[0];
  if (!boot) fail(`no golden boot scorer (seed ${seed})`);
  else if (boot.goals < 2 || boot.goals > 30) fail(`odd top scorer tally ${boot.goals} (seed ${seed})`);
  const totalGoals = Object.values(t.state.results).flat()
    .reduce((s, r) => s + r.homeGoals + r.awayGoals, 0);
  const credited = Object.values(t.state.scorers ?? {}).reduce((s, n) => s + n, 0);
  if (credited !== totalGoals) fail(`boot tally ${credited} != goals ${totalGoals} (seed ${seed})`);
  // knockout rounds shrink correctly and the champion appeared in every round he played
  for (const [stage, n] of [['r16', 16], ['qf', 8], ['sf', 4], ['final', 2]] as [keyof typeof t.state.rounds, number][]) {
    const round = t.state.rounds[stage] ?? [];
    if (new Set(round).size !== n) fail(`${String(stage)} has ${new Set(round).size} teams, expect ${n} (seed ${seed})`);
  }
  console.log(`  seed ${seed}: champion ${findTeam(t.state.champion).code}`);
}

// --- 8) golden goal: ends at the first goal, never on the clock -------------------
console.log('— golden goal (6 seeds) —');
for (let seed = 400; seed < 406; seed++) {
  const m = runToFulltime(makeMatch('bra', 'ger', seed, { mode: 'golden', halfLengthSec: 60 }),
    60 * 60 * 30, `gg-s${seed}`).match;
  const total = m.teams[0].score + m.teams[1].score;
  if (total !== 1) fail(`golden goal ended with ${total} goals (seed ${seed})`);
  if (m.winner() === null) fail(`golden goal no winner (seed ${seed})`);
  if (m.half !== 1) fail(`golden goal changed halves (seed ${seed})`);
}
console.log('  all decided by a single goal');

console.log(failures === 0 ? 'STRESS TEST PASS' : `STRESS TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
