// Football-shape regression harness for the sim (§6, §8).
//
// Plays N seeded CPU-vs-CPU matches at full speed and reports the numbers that
// say "this is football": goals, pass completion, shots, fouls, plus the
// physical-health numbers the collision work is judged on — average body
// overlaps per tick (should be ~0), peak player speed (should stay human),
// and stuck-ball events. Finally it replays seed 0 twice and hashes the two
// runs to prove the sim is still deterministic (§8: the guest link replays
// inputs, so any divergence desyncs a remote seat).
//
//   npx tsx scripts/footballStats.ts                 # 8 matches, 6 min each
//   npx tsx scripts/footballStats.ts --matches 16 --half 180
//   npx tsx scripts/footballStats.ts --difficulty legend

import { Match, type DifficultyName } from '../src/sim/match';
import { PLAYER_RADIUS, countOverlaps, resolveBodyCollisions } from '../src/sim/collision';
import { ballBodyContacts } from '../src/sim/ballContact';
import { findTeam } from '../src/data/loader';
import { HALF_L, HALF_W } from '../src/sim/constants';

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const MATCHES = Number(arg('matches', '8'));
const HALF_SEC = Number(arg('half', '180'));   // 2 × 180s = a 6-minute match
const DIFFICULTY = arg('difficulty', 'pro') as DifficultyName;

const FIXTURES: [string, string][] = [
  ['bra', 'aus'], ['esp', 'fra'], ['ger', 'jpn'], ['arg', 'mar'],
  ['eng', 'usa'], ['bel', 'kor'], ['ned', 'sen'], ['por', 'mex'],
];

interface Stats {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  passes: number;
  passesCompleted: number;
  fouls: number;
  cards: number;
  offsides: number;
  corners: number;
  saves: number;
  throwIns: number;
  tackles: number;
  overlapTicks: number;     // Σ overlapping pairs over play ticks
  playTicks: number;
  maxOverlapDepth: number;  // deepest interpenetration seen, metres
  maxSpeed: number;
  stuckEvents: number;
  outOfBounds: number;      // ticks with a player far off the pitch apron
}

const zero = (): Stats => ({
  goals: 0, shots: 0, shotsOnTarget: 0, passes: 0, passesCompleted: 0,
  fouls: 0, cards: 0, offsides: 0, corners: 0, saves: 0, throwIns: 0,
  tackles: 0, overlapTicks: 0, playTicks: 0, maxOverlapDepth: 0,
  maxSpeed: 0, stuckEvents: 0, outOfBounds: 0,
});

/** FNV-1a over the state we care about; any sim divergence moves it. */
function hashState(match: Match, h: number): number {
  const push = (v: number): void => {
    const n = Math.round(v * 1000) | 0;
    h ^= n & 0xff; h = Math.imul(h, 16777619);
    h ^= (n >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (n >>> 16) & 0xff; h = Math.imul(h, 16777619);
  };
  push(match.ball.pos.x); push(match.ball.pos.y); push(match.ball.pos.z);
  push(match.ball.vel.x); push(match.ball.vel.y); push(match.ball.vel.z);
  for (const p of match.allPlayers) { push(p.pos.x); push(p.pos.y); push(p.facing); }
  push(match.teams[0].score); push(match.teams[1].score);
  return h >>> 0;
}

function playMatch(home: string, away: string, seed: number, into: Stats, hash?: { h: number }): void {
  const match = new Match({
    home: findTeam(home), away: findTeam(away),
    seats: [null, null],
    halfLengthSec: HALF_SEC,
    difficulty: DIFFICULTY,
    seed,
  });
  match.events.on((e) => {
    if (e.type === 'goal') into.goals++;
    else if (e.type === 'shot') { into.shots++; if (e.onTarget) into.shotsOnTarget++; }
    else if (e.type === 'foul') into.fouls++;
    else if (e.type === 'card') into.cards++;
    else if (e.type === 'offside') into.offsides++;
    else if (e.type === 'corner') into.corners++;
    else if (e.type === 'save') into.saves++;
    else if (e.type === 'throwIn') into.throwIns++;
    else if (e.type === 'tackle') into.tackles++;
  });

  let ticks = 0;
  let stuckFor = 0;
  const MAX = 60 * 60 * 20;
  while (match.phase !== 'fulltime' && ticks < MAX) {
    match.update();
    if (match.phase === 'break') match.continueFromBreak();
    ticks++;
    if (hash && ticks % 37 === 0) hash.h = hashState(match, hash.h);

    if (match.phase !== 'play') { stuckFor = 0; continue; }
    into.playTicks++;

    // body overlaps
    const ov = countOverlaps(match.allPlayers);
    into.overlapTicks += ov.count;
    if (ov.deepest > into.maxOverlapDepth) into.maxOverlapDepth = ov.deepest;

    // player speeds / escapes
    for (const p of match.allPlayers) {
      if (p.sentOff) continue;
      const sp = Math.hypot(p.vel.x, p.vel.y);
      if (sp > into.maxSpeed) into.maxSpeed = sp;
      if (Math.abs(p.pos.x) > HALF_L + 5 || Math.abs(p.pos.y) > HALF_W + 5) into.outOfBounds++;
    }

    // stuck ball: nobody owns it, it isn't moving, for 3 straight seconds.
    // A keeper with it in his gloves is not a stuck ball, it is a keeper.
    const held = match.keepers[0].holding() || match.keepers[1].holding();
    const still = !held && !match.ball.owner && match.ball.speed() < 0.25;
    stuckFor = still ? stuckFor + 1 / 60 : 0;
    if (stuckFor > 3) { into.stuckEvents++; stuckFor = 0; }
  }
  if (match.phase !== 'fulltime') console.error(`  !! ${home}-${away} seed ${seed} never finished (${match.phase})`);

  for (const t of match.teams) {
    into.passes += t.passes;
    into.passesCompleted += t.passesCompleted;
  }
}

// ---------------------------------------------------------------- run
const total = zero();
const t0 = Date.now();
console.log(`${MATCHES} matches, ${(HALF_SEC * 2 / 60).toFixed(1)} min each, difficulty ${DIFFICULTY}, player radius ${PLAYER_RADIUS}m`);
for (let i = 0; i < MATCHES; i++) {
  const [h, a] = FIXTURES[i % FIXTURES.length];
  const before = total.goals;
  playMatch(h, a, 1000 + i, total);
  console.log(`  ${h}-${a} seed ${1000 + i}: ${total.goals - before} goals`);
}
const secs = (Date.now() - t0) / 1000;

const per = (v: number): string => (v / MATCHES).toFixed(2);
console.log('\n=============== per match ===============');
console.log(`goals            ${per(total.goals)}`);
console.log(`shots            ${per(total.shots)}  (on target ${per(total.shotsOnTarget)})`);
console.log(`passes           ${per(total.passes)}  completed ${per(total.passesCompleted)}` +
  `  = ${(100 * total.passesCompleted / Math.max(1, total.passes)).toFixed(1)}%`);
console.log(`fouls            ${per(total.fouls)}  cards ${per(total.cards)}`);
console.log(`offsides         ${per(total.offsides)}`);
console.log(`corners          ${per(total.corners)}  throw-ins ${per(total.throwIns)}`);
console.log(`saves            ${per(total.saves)}  tackles ${per(total.tackles)}`);
console.log('=============== physical ================');
console.log(`overlaps/tick    ${(total.overlapTicks / Math.max(1, total.playTicks)).toFixed(3)}` +
  `   deepest ${total.maxOverlapDepth.toFixed(3)}m`);
console.log(`max player speed ${total.maxSpeed.toFixed(2)} m/s`);
console.log(`stuck-ball       ${total.stuckEvents}   off-pitch ticks ${total.outOfBounds}`);
console.log(`wall clock       ${secs.toFixed(1)}s`);

// ---------------------------------------------------------------- rules probes
// Cheap, targeted checks for the rules that almost never fire in a CPU match
// (so the aggregate numbers above can't prove they work) and for the two new
// physics paths. All deterministic: fixed positions, fixed seed.
let probeFails = 0;
const probe = (ok: boolean, what: string): void => {
  if (!ok) { probeFails++; console.error(`  !! ${what}`); } else console.log(`  ok   ${what}`);
};
console.log('=============== rules probes ============');
{
  const m = new Match({
    home: findTeam('bra'), away: findTeam('aus'), seats: [null, null],
    halfLengthSec: 60, difficulty: 'pro', seed: 7,
  });
  while (m.phase === 'kickoff') m.update();

  // --- offside: a receiver beyond the second-last defender at the moment of
  // the pass, who then touches it, is flagged.
  const att = m.teams[0];
  const def = m.teams[1];
  const passer = att.players[7];
  const receiver = att.players[10];
  passer.pos = { x: 10, y: 0 };
  for (const p of def.players) p.pos = { x: 20 + def.players.indexOf(p) * 0.1, y: 10 };
  def.keeper.pos = { x: 50, y: 0 };
  receiver.pos = { x: 35, y: 0 };          // well beyond the line
  m.ball.pos = { x: 10, y: 0, z: 0.18 };
  m.offside.registerPass(passer, receiver);
  probe(m.offside.checkTouch(receiver), 'offside: a runner beyond the line is flagged on his touch');

  receiver.pos = { x: 12, y: 0 };          // level with play, clearly onside
  m.offside.registerPass(passer, receiver);
  probe(!m.offside.checkTouch(receiver), 'offside: an onside runner is not');
}
{
  // --- body separation: two men dumped on the same blade of grass are pushed
  // apart over a handful of ticks, and never teleported.
  const m = new Match({
    home: findTeam('bra'), away: findTeam('aus'), seats: [null, null],
    halfLengthSec: 60, difficulty: 'pro', seed: 9,
  });
  while (m.phase === 'kickoff') m.update();
  const a = m.teams[0].players[5];
  const b = m.teams[1].players[5];
  a.pos = { x: 0, y: 0 }; a.vel = { x: 0, y: 0 };
  b.pos = { x: 0.05, y: 0 }; b.vel = { x: 0, y: 0 };
  let maxStep = 0;
  for (let i = 0; i < 40; i++) {
    const before = { x: a.pos.x, y: a.pos.y };
    resolveBodyCollisions(m, 1 / 60);
    maxStep = Math.max(maxStep, Math.hypot(a.pos.x - before.x, a.pos.y - before.y));
  }
  const apart = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  probe(apart > PLAYER_RADIUS * 2 - 0.05, `body separation: co-located players end ${apart.toFixed(2)}m apart`);
  probe(maxStep < 0.1, `body separation: never teleports (max ${maxStep.toFixed(3)}m in one tick)`);
}
{
  // --- ball vs body: a ball drilled at a standing man is deflected; the same
  // ball lofted over his head is not.
  const m = new Match({
    home: findTeam('bra'), away: findTeam('aus'), seats: [null, null],
    halfLengthSec: 60, difficulty: 'pro', seed: 11,
  });
  while (m.phase === 'kickoff') m.update();
  const wall = m.teams[1].players[4];
  for (const p of m.allPlayers) { p.pos = { x: -40, y: 30 }; p.vel = { x: 0, y: 0 }; }
  wall.pos = { x: 5, y: 0 }; wall.vel = { x: 0, y: 0 };
  m.ball.owner = null;
  m.ball.noControlPlayer = null;
  m.ball.pos = { x: 5, y: 0, z: 0.4 };
  m.ball.vel = { x: 20, y: 0, z: 0 };
  ballBodyContacts(m, { x: 4.67, y: 0, z: 0.4 });
  probe(m.ball.vel.x < 5, `ball vs body: a drilled ball is blocked (vx ${m.ball.vel.x.toFixed(1)})`);

  m.ball.noControlPlayer = null;
  m.ball.pos = { x: 5, y: 0, z: 3.2 };
  m.ball.vel = { x: 20, y: 0, z: 0 };
  ballBodyContacts(m, { x: 4.67, y: 0, z: 3.2 });
  probe(m.ball.vel.x > 15, 'ball vs body: a lofted ball clears him');
}

{
  // --- shielding: with the carrier's body between them, a defender standing
  // right on top of him cannot take the ball.
  const m = new Match({
    home: findTeam('bra'), away: findTeam('aus'), seats: [null, null],
    halfLengthSec: 60, difficulty: 'pro', seed: 13,
  });
  while (m.phase === 'kickoff') m.update();
  for (const p of m.allPlayers) { p.pos = { x: -40, y: 30 }; p.vel = { x: 0, y: 0 }; }
  const carrier = m.teams[0].players[9];
  const marker = m.teams[1].players[9];
  carrier.pos = { x: 0, y: 0 };
  carrier.facing = 0;                       // back to the marker behind him
  marker.pos = { x: -0.6, y: 0 };           // goal-side, shut out by the body
  m.ball.owner = carrier;
  m.ball.pos = { x: 0.5, y: 0, z: 0.18 };   // in front of the carrier
  resolveBodyCollisions(m, 1 / 60);
  probe(marker.shieldedOut > 0, 'shielding: a defender behind the carrier is locked out of the ball');
  probe(carrier.shielding, 'shielding: and the carrier knows he is doing it (renderer flag)');
}

// ---------------------------------------------------------------- determinism
const runA = { h: 2166136261 };
const runB = { h: 2166136261 };
playMatch('bra', 'aus', 4242, zero(), runA);
playMatch('bra', 'aus', 4242, zero(), runB);
console.log('=============== determinism =============');
console.log(`hash A ${runA.h.toString(16)}   hash B ${runB.h.toString(16)}   ` +
  (runA.h === runB.h ? 'MATCH' : '*** DIVERGED ***'));
const ok = runA.h === runB.h && probeFails === 0;
console.log(ok ? 'FOOTBALL STATS PASS' : `FOOTBALL STATS FAIL (${probeFails} probe(s))`);
process.exit(ok ? 0 : 1);
