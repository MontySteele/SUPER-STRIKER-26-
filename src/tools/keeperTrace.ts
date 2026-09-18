// Goalkeeper locomotion trace (§6.3 / §7A).
//
//   npx tsx src/tools/keeperTrace.ts                  # seeded shootout, summary
//   npx tsx src/tools/keeperTrace.ts --ticks          # every tick, in full
//   npx tsx src/tools/keeperTrace.ts --seed 8230 --open   # open play instead
//   npx tsx src/tools/keeperTrace.ts --find           # scan seeds for a 0-0
//   npx tsx src/tools/keeperTrace.ts --legacy-sway    # re-inject the old bug
//
// WHAT IT PROVES. The renderer rate-matches a player's stepping animation
// against the ground his root covers (SkinnedPlayerMesh.blendLoco): hand it the
// truth and the feet plant themselves. So every tick in which the keeper's
// position changes must be covered by something — a velocity the locomotion
// chain can be driven from, a dive whose one-shot owns the body, or a
// deliberate cut. A tick that moves him with none of those is, by definition, a
// slide, and that is what this harness fails on.
//
// The bug it was written for: PenaltyController used to write
// `keeper.pos.y = Math.sin(t) * 0.35` every tick of the aim phase. vel stayed
// at zero, the renderer was told "standing still", and the mesh skated across
// the six-yard box for the length of a shootout.

import { Match } from '../sim/match';
import { SIM_DT } from '../sim/constants';
import { findTeam } from '../data/loader';
import type { PlayerEntity } from '../sim/player';
import type { KeeperBrain } from '../sim/ai/keeper';

// The project's tsconfig is a BROWSER one (lib DOM, no @types/node) and this
// file is the one thing under src/ that runs in node. Declaring the two members
// it touches is cheaper — and far less invasive — than pulling node's whole
// type surface into the game's compile.
declare const process: { argv: string[]; exit(code?: number): never };

/** Mirrors skinnedPlayer.LOCO_FLOOR: below this a player is standing. */
const LOCO_FLOOR = 0.05;
/** Mirrors gameRenderer.TELEPORT_SPEED: above this the sim cut, it did not move. */
const TELEPORT_SPEED = 14;
/** Mirrors skinnedPlayer.SIDESTEP_MAX_SPEED. */
const SIDESTEP_MAX = 2.4;
/**
 * How far a keeper may travel UNCOVERED, in one unbroken run, before it counts
 * as a slide. 15cm, which is half a boot: below that the body-contact
 * separation impulses and a velocity decaying through the LOCO_FLOOR are
 * millimetres and nobody can see them; above it a foot visibly leaves the
 * grass it was planted on. `--legacy-sway` re-injects the bug this harness was
 * written for and shows what a real one looks like against the same number.
 */
const SLIDE_METRES = 0.15;

interface Tick {
  t: number;
  phase: string;
  gk: string;
  state: string;
  clip: string;
  anim: string;
  animT: number;
  x: number; y: number;
  vx: number; vy: number;
  moved: number;      // m/s of actual ground translation
  reported: number;   // m/s the renderer's snapshot() hands the mesh
  lateral: number;
  chain: string;      // what pickChain() would choose
  teleport: boolean;
  slide: boolean;     // moved, with nothing driving the animation
  masked: boolean;    // moved under a long one-shot that owns the whole body
}

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const opt = (n: string, d: number): number => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

/**
 * What SkinnedPlayerMesh.pickChain would choose this frame, reproduced here so
 * the trace says which CLIP is meant to be covering the ground rather than just
 * asserting that one is.
 */
function chainFor(state: string, speed: number, lateral: number, anim: string): string {
  if (anim !== 'none') return `one-shot:${anim}`;
  if (state === 'hold') return 'gkHold';
  const base = state === 'set' || state === 'react' || state === 'smother'
    ? 'idle(outfield)' : 'gkIdle';
  if (speed <= LOCO_FLOOR) return base;
  if (speed < SIDESTEP_MAX && Math.abs(lateral) > 0.45) {
    return `${base}+gkStep${lateral < 0 ? 'L' : 'R'}`;
  }
  return `${base}→walk/jog/run`;
}

function sample(m: Match, brain: KeeperBrain, k: PlayerEntity,
  prev: { x: number; y: number } | null): Tick {
  const moved = prev ? Math.hypot(k.pos.x - prev.x, k.pos.y - prev.y) / SIM_DT : 0;
  const v = Math.hypot(k.vel.x, k.vel.y);
  const teleport = moved >= TELEPORT_SPEED;
  const reported = !teleport && moved > v ? moved : v;
  const sp = Math.hypot(k.vel.x, k.vel.y) > moved || teleport ? v : moved;
  let lateral = 0;
  if (prev && !teleport && sp > LOCO_FLOOR) {
    const dx = moved > v ? (k.pos.x - prev.x) / SIM_DT : k.vel.x;
    const dy = moved > v ? (k.pos.y - prev.y) / SIM_DT : k.vel.y;
    const d = Math.hypot(dx, dy);
    lateral = (dx * Math.sin(k.facing) - dy * Math.cos(k.facing)) / d;
  }
  // THE ASSERTION. Ground covered with no velocity behind it, no dive
  // integrating it and no one-shot owning the body is a slide.
  const slide = !teleport && moved > LOCO_FLOOR && v < LOCO_FLOOR
    && !k.diving && k.actionAnim === 'none';
  // A three-second celebration sits at weight 1 for almost its whole length,
  // and the locomotion chain is weighted by 1 - that. So ground covered under
  // one is ground covered with the legs switched off — a slide with a nicer
  // pose on it. (A 0.42s strike is not in here: it hands back too fast to read
  // as anything but a follow-through, which the whole codebase already accepts.)
  const masked = !teleport && !k.diving && moved > 0.4
    && (k.actionAnim === 'celebrate' || k.actionAnim === 'dejected');
  return {
    t: m.simTime, phase: m.phase, gk: k.data.name,
    state: brain.state, clip: brain.animClip ?? '-',
    anim: k.actionAnim, animT: k.actionAnimT,
    x: k.pos.x, y: k.pos.y, vx: k.vel.x, vy: k.vel.y,
    moved, reported, lateral,
    chain: chainFor(brain.state, reported, lateral, k.actionAnim),
    teleport, slide, masked,
  };
}

function buildMatch(seed: number, knockout: boolean, halfSec: number): Match {
  return new Match({
    home: findTeam('cze'),
    away: findTeam('ger'),
    seats: [null, null],
    halfLengthSec: halfSec,
    difficulty: 'pro',
    knockout,
    mode: 'match',
    seed,
  });
}

/** Roll a knockout match to full time; returns it once a shootout has begun. */
function rollToShootout(seed: number, halfSec: number, maxTicks: number): Match | null {
  const m = buildMatch(seed, true, halfSec);
  for (let i = 0; i < maxTicks; i++) {
    m.update();
    if (m.phase === 'break') m.continueFromBreak();
    if (m.phase === 'shootout') return m;
    if (m.phase === 'fulltime') return null;
  }
  return null;
}

// ---------------------------------------------------------------- seed search

if (flag('find')) {
  const halfSec = opt('half', 40);
  for (let seed = 1; seed <= opt('scan', 400); seed++) {
    const m = rollToShootout(seed, halfSec, 200_000);
    if (m) {
      console.log(`seed ${seed}: shootout at t=${m.simTime.toFixed(1)}s `
        + `(${m.teams[0].score}-${m.teams[1].score})`);
    }
  }
  process.exit(0);
}

// -------------------------------------------------------------------- the run

const seed = opt('seed', 3);
const halfSec = opt('half', 40);
const openPlay = flag('open');
const legacy = flag('legacy-sway');
const ticks: Tick[] = [];

function openMatch(): Match {
  return buildMatch(seed, false, 600);
}
function shootoutMatch(): Match {
  const found = rollToShootout(seed, halfSec, 200_000);
  if (!found) {
    console.error(`seed ${seed} did not reach a shootout at half=${halfSec}s — `
      + 'run with --find to pick one');
    process.exit(1);
  }
  console.log(`seed ${seed}: shootout begins at t=${found.simTime.toFixed(1)}s`);
  return found;
}
const m: Match = openPlay ? openMatch() : shootoutMatch();

// Trace the keeper who is actually being shot at. In a shootout that is the
// defending keeper of the moment, so follow the controller rather than pinning
// one man; in open play, follow both.
const prev = new Map<PlayerEntity, { x: number; y: number }>();
const limit = openPlay ? opt('frames', 3600) : opt('frames', 2400);
for (let i = 0; i < limit; i++) {
  const watched: KeeperBrain[] = openPlay ? [...m.keepers]
    : m.penalty ? [m.keepers[1 - m.penalty.kickingTeam]] : [...m.keepers];
  m.update();
  // --legacy-sway: the ORIGINAL line, re-injected after the tick, so the
  // harness can be shown failing on the defect it exists to catch. It writes
  // the position directly and leaves vel at zero, which is the whole bug.
  if (legacy && m.penalty && m.penalty.phase === 'aim') {
    const lk = m.penalty.keeper;
    lk.pos.y = Math.sin(m.penalty.timer * 2.2) * 0.35;
    lk.vel.x = 0; lk.vel.y = 0;   // as it was: a position write, nothing behind it
  }
  if (m.phase === 'break') m.continueFromBreak();
  for (const brain of watched) {
    const k = brain.keeper;
    ticks.push(sample(m, brain, k, prev.get(k) ?? null));
    prev.set(k, { x: k.pos.x, y: k.pos.y });
  }
  if (m.phase === 'fulltime') break;
}

// ------------------------------------------------------------------- report

const fmt = (t: Tick): string =>
  `${t.t.toFixed(3).padStart(8)} ${t.phase.padEnd(9)} ${t.state.padEnd(8)} `
  + `pos(${t.x.toFixed(2).padStart(7)},${t.y.toFixed(2).padStart(6)}) `
  + `vel(${t.vx.toFixed(2).padStart(6)},${t.vy.toFixed(2).padStart(6)}) `
  + `moved ${t.moved.toFixed(2).padStart(5)} shown ${t.reported.toFixed(2).padStart(5)} `
  + `lat ${t.lateral.toFixed(2).padStart(5)} anim ${t.anim.padEnd(9)}`
  + `${t.animT.toFixed(2)} clip ${t.clip.padEnd(12)} ${t.chain}`
  + `${t.teleport ? '  [CUT]' : ''}${t.slide ? '  <<< SLIDE' : ''}`
  + `${t.masked ? '  <<< MASKED' : ''}`;

if (flag('ticks')) for (const t of ticks) console.log(fmt(t));

// Group the uncovered ticks into unbroken runs and measure each in METRES.
// An instantaneous rate is the wrong unit: a single tick at 0.5 m/s is nine
// millimetres, and a hundred ticks at 0.5 m/s is most of a metre.
interface Run { from: number; to: number; metres: number; ticks: number; sample: Tick }
const runs: Run[] = [];
let open_: Run | null = null;
for (const t of ticks) {
  if (t.slide) {
    if (!open_) { open_ = { from: t.t, to: t.t, metres: 0, ticks: 0, sample: t }; runs.push(open_); }
    open_.to = t.t;
    open_.metres += t.moved * SIM_DT;
    open_.ticks++;
  } else {
    open_ = null;
  }
}
const bad = runs.filter((r) => r.metres > SLIDE_METRES);
const slides = ticks.filter((t) => t.slide);
const cuts = ticks.filter((t) => t.teleport);
const moving = ticks.filter((t) => t.moved > LOCO_FLOOR && !t.teleport);

// which chain covered the moving ticks, and how much ground each covered
const byChain = new Map<string, { n: number; metres: number }>();
for (const t of moving) {
  const e = byChain.get(t.chain) ?? { n: 0, metres: 0 };
  e.n++; e.metres += t.moved * SIM_DT;
  byChain.set(t.chain, e);
}
// and which keeper states were entered, with the clip each armed
const byState = new Map<string, Set<string>>();
for (const t of ticks) {
  if (!byState.has(t.state)) byState.set(t.state, new Set());
  byState.get(t.state)!.add(t.clip);
}

console.log(`\n${ticks.length} keeper ticks traced `
  + `(${(ticks.length * SIM_DT).toFixed(1)}s of keeper time)`);
console.log(`  moving ticks : ${moving.length}`);
console.log(`  cuts         : ${cuts.length} (teleports: phase resets, not locomotion)`);
console.log('\nground covered, by the chain the renderer would pick:');
for (const [chain, e] of [...byChain].sort((a, b) => b[1].metres - a[1].metres)) {
  console.log(`  ${chain.padEnd(26)} ${e.n.toString().padStart(5)} ticks `
    + `${e.metres.toFixed(1).padStart(7)} m`);
}
console.log('\nkeeper states entered → clips armed:');
for (const [s, clips] of byState) {
  console.log(`  ${s.padEnd(10)} ${[...clips].join(', ')}`);
}

const masked = ticks.filter((t) => t.masked);
if (masked.length) {
  console.log(`\nWARN: ${masked.length} tick(s) moved the keeper under a full-weight `
    + 'celebration/dejection, which switches the locomotion layer off:');
  for (const t of masked.slice(0, 6)) console.log(`  ${fmt(t)}`);
}

const uncovered = runs.reduce((a, r) => a + r.metres, 0);
console.log(`\nuncovered translation: ${uncovered.toFixed(3)} m over ${runs.length} run(s)`
  + `, longest ${(runs.reduce((a, r) => Math.max(a, r.metres), 0)).toFixed(3)} m`
  + ` (threshold ${SLIDE_METRES} m)`);

if (bad.length) {
  console.log(`\nFAIL: ${bad.length} run(s) slid the keeper further than ${SLIDE_METRES}m `
    + 'with no velocity, no dive and no one-shot to cover it:');
  for (const r of bad.slice(0, 10)) {
    console.log(`  t=${r.from.toFixed(2)}..${r.to.toFixed(2)}  ${r.metres.toFixed(2)}m `
      + `over ${r.ticks} ticks`);
    console.log(`    ${fmt(r.sample)}`);
  }
  process.exit(1);
}
console.log(`PASS: no run of keeper ground translation exceeds ${SLIDE_METRES}m uncovered`
  + `${slides.length ? ` (${slides.length} sub-threshold tick(s))` : ''}.`);
