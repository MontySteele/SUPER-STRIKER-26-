// Headless checks for 2v2 Versus (§5.4.6): the four-slot seat model, the
// paired-human switch arbitration (who the second human gets, and how hard it
// is to shake him loose), the per-slot disconnect ladder, and a 1v1 regression
// so none of it leaked into the mode everyone actually plays.
// Run: npx tsx scripts/versusTest.ts

import { Match, SEAT_SLOTS, slotRole, slotTeam, teamSlot } from '../src/sim/match';
import type { Action, PlayerInput } from '../src/input/input';
import type { PlayerEntity } from '../src/sim/player';
import { findTeam } from '../src/data/loader';

let failures = 0;
const check = (ok: boolean, what: string): void => {
  if (ok) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  !!   ${what}`); }
};

/**
 * A seat with no clock and no DOM: presses are queued by the test and taken
 * exactly once, so a run is reproducible tick for tick.
 */
class TestSeat {
  readonly kind = 'pad';
  stick = { x: 0, y: 0 };
  sprint = false;
  held = new Set<Action>();
  private queued = new Set<Action>();
  private released = new Map<Action, number>();

  press(a: Action): void { this.queued.add(a); }
  release(a: Action, heldFor: number): void { this.released.set(a, heldFor); }
  getStick(): { x: number; y: number } { return this.stick; }
  isSprinting(): boolean { return this.sprint; }
  isHeld(a: Action): boolean { return this.held.has(a); }
  heldDuration(): number { return 0; }
  consumePress(a: Action): boolean { return this.queued.delete(a); }
  consumeRelease(a: Action): { heldFor: number } | null {
    const h = this.released.get(a);
    if (h === undefined) return null;
    this.released.delete(a);
    return { heldFor: h };
  }
  clearBuffers(): void { this.queued.clear(); this.released.clear(); }
}

const asSeat = (s: TestSeat): PlayerInput => s as unknown as PlayerInput;

/** The two privates the rigged scenarios below have to reach. */
interface Internals {
  assignPartner(teamIdx: number, force?: boolean, avoid?: PlayerEntity | null): void;
  switchPlayer(slot: number): void;
}
const inner = (m: Match): Internals => m as unknown as Internals;

function fourSeats(): TestSeat[] {
  return [new TestSeat(), new TestSeat(), new TestSeat(), new TestSeat()];
}

function make2v2(seed: number, seats: TestSeat[]): Match {
  return new Match({
    home: findTeam('bra'), away: findTeam('fra'),
    seats: seats.map(asSeat),
    halfLengthSec: 120, difficulty: 'pro', seed,
  });
}

/** Roll the sim into open play; every test wants a live ball. */
function toPlay(m: Match): void {
  for (let i = 0; i < 900 && m.phase !== 'play'; i++) m.update();
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

// ------------------------------------------------------------- slot geometry
console.log('— seat slots —');
{
  check(SEAT_SLOTS === 4, 'four seat slots');
  check([0, 1, 2, 3].map(slotTeam).join(',') === '0,1,0,1', 'slots alternate sides: P1/P3 home, P2/P4 away');
  check([0, 1, 2, 3].map(slotRole).join(',') === '0,0,1,1', 'slots 0-1 are the on-ball drivers, 2-3 the partners');
  check(teamSlot(0, 0) === 0 && teamSlot(1, 0) === 1, 'a 1v1 still sits in slots 0 and 1');
  check(teamSlot(0, 1) === 2 && teamSlot(1, 1) === 3, 'the partners sit behind them');
}

// ------------------------------------------------------------- construction
console.log('— 4-seat construction —');
{
  const seats = fourSeats();
  const m = make2v2(11, seats);
  check(m.seats.length === SEAT_SLOTS, 'the match keeps a full slot array');
  check(m.teams[0].isHuman && m.teams[1].isHuman, 'both sides read as human');
  check(m.primarySlot(0) === 0 && m.primarySlot(1) === 1, 'each side\'s first seat is its on-ball driver');
  check(m.partnerSlot(0) === 2 && m.partnerSlot(1) === 3, 'each side\'s second seat is its partner');
  for (let s = 0; s < SEAT_SLOTS; s++) {
    if (!m.controlled[s]) { check(false, `slot ${s} has a player from kick-off`); break; }
  }
  check(m.controlled.every((c) => c !== null), 'all four slots hold a player from kick-off');
  check(m.controlled[0] !== m.controlled[2] && m.controlled[1] !== m.controlled[3],
    'no side starts with both humans on one shirt');

  // partial fills: three humans is a legal 2v1
  const three = new Match({
    home: findTeam('bra'), away: findTeam('fra'),
    seats: [asSeat(new TestSeat()), asSeat(new TestSeat()), asSeat(new TestSeat()), null],
    halfLengthSec: 120, difficulty: 'pro', seed: 12,
  });
  check(three.partnerSlot(0) === 2 && three.partnerSlot(1) === -1, '2v1 seats the spare on the home side');
  check(three.controlled[3] === null, 'the empty slot steers nobody');

  // a partner-only side: the lone human drives on the ball, as he must
  const orphan = new Match({
    home: findTeam('bra'), away: findTeam('fra'),
    seats: [null, asSeat(new TestSeat()), asSeat(new TestSeat()), null],
    halfLengthSec: 120, difficulty: 'pro', seed: 13,
  });
  check(orphan.teams[0].isHuman, 'a side seated only in its partner slot is still human');
  check(orphan.primarySlot(0) === 2 && orphan.partnerSlot(0) === -1,
    'that lone human is promoted to the on-ball driver');
}

// ------------------------------------------- invariants across simulated play
console.log('— arbitration invariants over 60s of play —');
{
  const seats = fourSeats();
  const m = make2v2(23, seats);
  toPlay(m);

  let ticks = 0;
  let collide = 0;
  let gkPartner = 0;
  let ghost = 0;
  let handovers = 0;
  // "drift" = the scorer alone moved the partner: same phase, same side in
  // possession, the on-ball human still on the same man. Restart re-seats,
  // turnovers and switch swaps are all legitimate reasons to change and are
  // counted separately, so this is the number that would blow up if the
  // hysteresis were missing.
  let drift = 0;
  let defendRankSum = 0;
  let defendSamples = 0;
  let advantageSum = 0;
  let attackSamples = 0;
  const prev: (PlayerEntity | null)[] = [null, null, null, null];
  const prevPrimary: (PlayerEntity | null)[] = [null, null];
  let prevPoss = m.possessionTeam;
  let prevPhase: string = m.phase;

  for (let i = 0; i < 3600; i++) {
    // four humans all running: circular sticks at different rates
    for (let s = 0; s < SEAT_SLOTS; s++) {
      const a = i * (0.011 + s * 0.004) + s;
      seats[s].stick = { x: Math.cos(a), y: Math.sin(a) };
      seats[s].sprint = (i + s * 17) % 90 < 30;
    }
    if (i % 61 === 0) seats[i % 4].press('switch');
    if (i % 47 === 0) seats[i % 4].press('pass');
    m.update();
    if (m.phase !== 'play') continue;
    ticks++;

    for (let t = 0; t < 2; t++) {
      const primary = m.controlled[m.primarySlot(t)];
      const partner = m.controlled[m.partnerSlot(t)];
      if (!primary || !partner) { ghost++; continue; }
      if (primary === partner) collide++;
      if (partner.isGK) gkPartner++;
      if (partner.sentOff || primary.sentOff) ghost++;

      const ball = { x: m.ball.pos.x, y: m.ball.pos.y };
      const pool = m.teams[t].players.filter((p) => !p.isGK && !p.sentOff && p !== primary);
      if (m.possessionTeam !== t) {
        // defending: how near the front of the queue-for-the-ball is he?
        const rank = pool.filter((p) => dist(p.pos, ball) < dist(partner.pos, ball)).length;
        defendRankSum += rank;
        defendSamples++;
      } else {
        // attacking: is he further up the pitch than his side's average?
        const dir = m.teams[t].attackDir;
        const mean = pool.reduce((a, p) => a + p.pos.x * dir, 0) / Math.max(1, pool.length);
        advantageSum += partner.pos.x * dir - mean;
        attackSamples++;
      }
    }
    for (let s = 2; s < SEAT_SLOTS; s++) {
      const t = s - 2;
      if (m.controlled[s] !== prev[s] && prev[s] !== null) {
        handovers++;
        if (prevPhase === 'play' && m.possessionTeam === prevPoss
          && m.controlled[m.primarySlot(t)] === prevPrimary[t]) drift++;
      }
      prev[s] = m.controlled[s];
    }
    prevPoss = m.possessionTeam;
    for (let t = 0; t < 2; t++) prevPrimary[t] = m.controlled[m.primarySlot(t)];
    prevPhase = m.phase;
  }

  check(ticks > 2000, `spent ${ticks} ticks in open play`);
  check(collide === 0, 'the two humans on a side are never on the same player');
  check(gkPartner === 0, 'the partner is never handed the keeper in a full XI');
  check(ghost === 0, 'no seat is ever left steering nobody, or a sent-off man');
  // this is a deliberately chaotic match — four humans steering in circles and
  // spraying passes — so it turns the ball over far more than real play does
  const secs = ticks / 60;
  const driftPerSide = drift / 2 / secs;
  check(driftPerSide < 1, `the scorer alone moves a side's partner ${driftPerSide.toFixed(2)}×/s — hysteresis holds (strobing would be ~60)`);
  check(handovers / 2 / secs < 1.5, `all causes together: ${(handovers / 2 / secs).toFixed(2)} partner changes/s a side`);
  const meanRank = defendRankSum / Math.max(1, defendSamples);
  check(meanRank < 3, `defending, the partner is near the ball: mean rank ${meanRank.toFixed(2)} of ~9`);
  const meanAdv = advantageSum / Math.max(1, attackSamples);
  check(meanAdv > 2, `attacking, the partner pushes up: ${meanAdv.toFixed(1)}m ahead of his side's average`);
}

// ------------------------------------------------- the off-ball man is a human
console.log('— the partner runs under stick control —');
{
  const seats = fourSeats();
  const m = make2v2(29, seats);
  toPlay(m);
  // hold the partner's stick hard one way and see whether his player goes
  // there — the whole point of the second seat is that he isn't AI
  const start = { ...m.controlled[2]!.pos };
  const who = m.controlled[2];
  let travelled = 0;
  for (let i = 0; i < 40; i++) {
    seats[2].stick = { x: 0, y: -1 };
    seats[2].sprint = true;
    m.update();
    if (m.phase !== 'play' || m.controlled[2] !== who) break;
    travelled = who!.pos.y - start.y;
  }
  check(travelled < -3, `the off-ball human's player ran ${(-travelled).toFixed(1)}m the way the stick pointed`);
  check(m.humanDriven(who!), 'and the AI leaves him alone while a human holds him');
  const outfield = m.teams[0].players.filter((p) => !p.isGK);
  const shape = outfield.filter((p) => !m.humanDriven(p));
  check(shape.length === outfield.length - 2,
    `the other ${shape.length} outfielders are still the AI's to run`);
}

// ----------------------------------------------------------------- hysteresis
console.log('— hysteresis —');
{
  // A rigged near-tie: two candidates the same distance off the ball, with the
  // ordering flipped every evaluation. Only the sticky bonus and the handover
  // cooldown stand between that and a partner who changes 60 times a second —
  // which is why this reaches for assignPartner directly.
  const seats = fourSeats();
  const m = make2v2(31, seats);
  toPlay(m);
  m.possessionTeam = 1; // home is defending: the plain distance-to-ball shape

  const pool = m.teams[0].players.filter((p) => !p.isGK && !p.sentOff);
  const primary = pool[0];
  const a = pool[1];
  const b = pool[2];
  m.controlled[0] = primary;
  m.controlled[2] = a;
  // park everyone else out of contention
  for (const p of pool.slice(3)) p.pos = { x: 0, y: 60 };
  primary.pos = { x: 0, y: -60 };
  m.ball.pos.x = 0; m.ball.pos.y = 0; m.ball.pos.z = 0;

  let flips = 0;
  let last = m.controlled[2];
  for (let i = 0; i < 120; i++) {
    // whoever is "closer" alternates by a hair, every single evaluation
    a.pos = { x: i % 2 === 0 ? 9.9 : 10.1, y: 0 };
    b.pos = { x: i % 2 === 0 ? -10.1 : -9.9, y: 0 };
    m.simTime += 1 / 60;
    inner(m).assignPartner(0);
    if (m.controlled[2] !== last) { flips++; last = m.controlled[2]; }
  }
  check(flips <= 1, `a 0.2m see-saw over 2 seconds moves the partner ${flips} time(s), not 120`);
  check(m.controlled[2] === a, 'and he keeps the man he started on');

  // …but once the play has genuinely moved on, the shirt does change hands:
  // his man is stranded 45m upfield and b is stood on the ball, goal-side
  a.pos = { x: 45, y: 0 };
  b.pos = { x: -1, y: 0 };
  m.simTime += 5;
  inner(m).assignPartner(0);
  check(m.controlled[2] === b, 'a decisively better-placed teammate still wins the handover');
}

// ------------------------------------------------------- manual switch collision
console.log('— manual switch onto the partner\'s man —');
{
  const seats = fourSeats();
  const m = make2v2(37, seats);
  toPlay(m);

  const pool = m.teams[0].players.filter((p) => !p.isGK && !p.sentOff);
  const primary = pool[0];
  const target = pool[1];
  m.controlled[0] = primary;
  m.controlled[2] = target;
  // the switch scorer takes the nearest man to the ball that isn't the
  // primary — so put the partner's man right on it and everyone else away
  m.ball.pos.x = 0; m.ball.pos.y = 0;
  primary.pos = { x: 25, y: 25 };
  target.pos = { x: 1, y: 0 };
  for (const p of pool.slice(2)) p.pos = { x: -40, y: 30 };

  inner(m).switchPlayer(0);
  check(m.controlled[0] === target, 'the switch lands on the shirt the partner was wearing');
  check(m.controlled[2] === primary, 'and the partner inherits the man the primary just left — a swap');
  check(m.controlled[0] !== m.controlled[2], 'nobody is doubled up after the swap');

  // the off-ball human's own switch button re-rolls HIS man, and never reaches
  // for the one his partner is driving
  const before = m.controlled[2];
  inner(m).switchPlayer(2);
  check(m.controlled[2] !== before, 'the partner\'s switch button moves the partner');
  check(m.controlled[0] === target, 'and leaves the on-ball human exactly where he was');
}

// ------------------------------------------------------------- keeper fallback
console.log('— keeper exclusion —');
{
  const seats = fourSeats();
  const m = make2v2(41, seats);
  toPlay(m);
  const team = m.teams[0];
  const outfield = team.players.filter((p) => !p.isGK);
  m.controlled[0] = outfield[0];

  inner(m).assignPartner(0, true);
  check(m.controlled[2] !== team.keeper, 'with a full XI the partner is an outfielder');

  // a red-card apocalypse: the on-ball human and the keeper are all that's left
  for (const p of outfield.slice(1)) p.sentOff = true;
  inner(m).assignPartner(0, true);
  check(m.controlled[2] === team.keeper, 'when nobody else is standing, the gloves are the only choice');
  check(m.controlled[2] !== m.controlled[0], 'even then the two humans hold different shirts');
}

// -------------------------------------------------- per-slot disconnect ladder
console.log('— setSeat, per slot, in a 2v2 —');
{
  const seats = fourSeats();
  const m = make2v2(53, seats);
  toPlay(m);
  const homePrimary = m.controlled[0];

  // P3 drops out: the side keeps its on-ball human and loses only the partner
  m.setSeat(2, null);
  check(m.seats[2] === null, 'the partner slot is empty');
  check(m.controlled[2] === null, 'nobody is left steered by a ghost');
  check(m.teams[0].isHuman, 'the side is still human');
  check(m.primarySlot(0) === 0 && m.partnerSlot(0) === -1, 'the on-ball human is untouched');
  check(m.controlled[0] === homePrimary, 'and keeps the exact player he had');
  for (let i = 0; i < 600; i++) m.update();
  check(m.phase !== 'fulltime' && m.controlled[2] === null, 'play continues with the partner on AI');

  // P3 comes back
  m.setSeat(2, asSeat(seats[2]));
  check(m.controlled[2] !== null, 'the returning partner is handed a player');
  check(m.controlled[2] !== m.controlled[0], 'and it is not the one his mate is driving');

  // now the ON-BALL human drops: the partner is promoted rather than the side
  // being left half-steered
  const survivor = m.controlled[2];
  m.setSeat(0, null);
  check(m.teams[0].isHuman, 'a side with one human left still reads as human');
  check(m.primarySlot(0) === 2, 'the surviving human is promoted to the on-ball driver');
  check(m.controlled[2] === survivor, 'he keeps his player through the promotion');
  check(m.controlled[0] === null, 'the empty slot steers nobody');
  for (let i = 0; i < 600; i++) m.update();
  check(m.phase !== 'fulltime', 'the match keeps running on one human a side');

  // …and the handback restores the pairing without a collision
  m.setSeat(0, asSeat(seats[0]));
  check(m.primarySlot(0) === 0 && m.partnerSlot(0) === 2, 'the pairing is back');
  check(m.controlled[0] !== null && m.controlled[2] !== null, 'both humans have a player');
  check(m.controlled[0] !== m.controlled[2], 'and they are not the same player');
  for (let i = 0; i < 600; i++) m.update();
  check(m.controlled[0] !== m.controlled[2], 'still separate after the handback settles');

  // idempotence: the ladder calls this every frame
  const a = m.controlled[0], b = m.controlled[2];
  m.setSeat(0, asSeat(seats[0]));
  m.setSeat(2, asSeat(seats[2]));
  check(m.controlled[0] === a && m.controlled[2] === b, 'a redundant setSeat is a no-op');
}

// ------------------------------------------------------------ 1v1 regression
console.log('— 1v1 regression —');
{
  const kb = new TestSeat();
  const pad = new TestSeat();
  const m = new Match({
    home: findTeam('bra'), away: findTeam('fra'),
    seats: [asSeat(kb), asSeat(pad)],
    halfLengthSec: 120, difficulty: 'pro', seed: 67,
  });
  check(m.primarySlot(0) === 0 && m.primarySlot(1) === 1, 'a 1v1 still sits in P1 and P2');
  check(m.partnerSlot(0) === -1 && m.partnerSlot(1) === -1, 'with no partners');
  check(m.primarySeat(0) === asSeat(kb) && m.primarySeat(1) === asSeat(pad), 'the seats are where they were');

  toPlay(m);
  let strays = 0;
  for (let i = 0; i < 2400; i++) {
    for (const s of [kb, pad]) s.stick = { x: Math.cos(i * 0.02), y: Math.sin(i * 0.013) };
    if (i % 71 === 0) kb.press('switch');
    if (i % 89 === 0) pad.press('switch');
    m.update();
    if (m.controlled[2] !== null || m.controlled[3] !== null) strays++;
  }
  check(strays === 0, 'the partner slots stay empty for the whole match');
  check(m.controlled[0] !== null && m.controlled[1] !== null, 'both humans still hold a player');

  // the CPU-vs-CPU path is untouched by any of this
  const cpu = new Match({
    home: findTeam('ger'), away: findTeam('jpn'),
    seats: [null, null], halfLengthSec: 120, difficulty: 'pro', seed: 71,
  });
  for (let i = 0; i < 1200; i++) cpu.update();
  check(cpu.controlled.every((c) => c === null), 'a CPU-vs-CPU match steers nobody by hand');
  check(!cpu.teams[0].isHuman && !cpu.teams[1].isHuman, 'and both sides read as CPU');
}

console.log(failures === 0 ? 'VERSUS TEST PASS' : `VERSUS TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
