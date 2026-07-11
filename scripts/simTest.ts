// Headless full-speed match sim: CPU vs CPU, validates AI balance, rules and
// numeric stability without a browser. Run: npx tsx scripts/simTest.ts [n]

import { Match } from '../src/sim/match';
import { findTeam } from '../src/data/loader';
import type { InputSystem } from '../src/input/input';

const fakeInput = {
  pollGamepad: () => {},
  getStick: () => ({ x: 0, y: 0 }),
  isSprinting: () => false,
  isHeld: () => false,
  heldDuration: () => 0,
  consumePress: () => false,
  consumeRelease: () => null,
  clearBuffers: () => {},
} as unknown as InputSystem;

const matchups: [string, string][] = [
  ['bra', 'aus'], ['esp', 'fra'], ['hai', 'cuw'], ['arg', 'nzl'], ['ger', 'jpn'],
];

let failures = 0;

for (const [homeId, awayId] of matchups) {
  const match = new Match({
    home: findTeam(homeId),
    away: findTeam(awayId),
    humanTeamIdx: null,
    halfLengthSec: 180,
    difficulty: 'pro',
    seed: 12345,
  }, fakeInput);

  const counts: Record<string, number> = {};
  match.events.on((e) => { counts[e.type] = (counts[e.type] ?? 0) + 1; });

  let ticks = 0;
  const MAX_TICKS = 60 * 60 * 10; // 10 real minutes of sim, hard stop
  while (match.phase !== 'fulltime' && ticks < MAX_TICKS) {
    match.update();
    if (match.phase === 'halftime') match.startSecondHalf();
    ticks++;
    // numeric sanity every second
    if (ticks % 60 === 0) {
      const b = match.ball.pos;
      if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.z)) {
        console.error(`  !! ball NaN at tick ${ticks}`);
        failures++;
        break;
      }
      if (Math.abs(b.x) > 80 || Math.abs(b.y) > 60 || b.z > 60) {
        console.error(`  !! ball escaped at tick ${ticks}: ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
        failures++;
        break;
      }
      for (const p of match.allPlayers) {
        if (!isFinite(p.pos.x) || !isFinite(p.pos.y)) {
          console.error(`  !! player NaN: ${p.data.name}`);
          failures++;
          break;
        }
      }
    }
  }

  const [h, a] = match.teams;
  const total = Math.max(h.possessionTicks + a.possessionTicks, 1);
  console.log(
    `${h.data.code} ${h.score}-${a.score} ${a.data.code}  ` +
    `(shots ${h.shots}/${a.shots}, on-target ${h.shotsOnTarget}/${a.shotsOnTarget}, ` +
    `poss ${Math.round(h.possessionTicks / total * 100)}%, ` +
    `saves ${counts.save ?? 0}, corners ${counts.corner ?? 0}, throwIns ${counts.throwIn ?? 0}, ` +
    `offsides ${counts.offside ?? 0}, posts ${counts.post ?? 0}, ` +
    `ticks ${ticks}${match.phase !== 'fulltime' ? ' [DID NOT FINISH: ' + match.phase + ']' : ''})`,
  );
  if (match.phase !== 'fulltime') failures++;
}

console.log(failures === 0 ? 'SIM TEST PASS' : `SIM TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
