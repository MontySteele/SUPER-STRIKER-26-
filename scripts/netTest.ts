// Headless checks for the remote-guest input path (§5.4): packet round-trip,
// u16 sequence wraparound, press/release edge synthesis into a DeviceState,
// the disconnect ladder, and mid-match seat swapping to the AI and back.
// Everything here is transport-free — the WebRTC plumbing is the only part
// that needs two real browsers. Run: npx tsx scripts/netTest.ts

import { ACTIONS, DeviceState, InputHub, type Action } from '../src/input/input';
import {
  CODE_ALPHABET, CODE_LENGTH, SPRINT_BIT, TAG_PING, TAG_PONG,
  applyInput, decodeInput, decodeProbe, encodeInput, encodeProbe,
  hostPeerId, isRoomCode, newRoomCode, seqAhead,
} from '../src/net/protocol';
import { AI_MS, DEGRADE_MS, HOLD_MS, seatHealth } from '../src/net/health';
import { Match } from '../src/sim/match';
import { findTeam } from '../src/data/loader';

// InputHub binds window/document listeners on construction; the seat plumbing
// it exposes is pure, so a two-method shim is all headless needs.
const noop = (): void => { /* no DOM here */ };
(globalThis as Record<string, unknown>).window = { addEventListener: noop };
(globalThis as Record<string, unknown>).document = { addEventListener: noop, hidden: false };
(globalThis as Record<string, unknown>).navigator ??= {};

let failures = 0;
const check = (ok: boolean, what: string): void => {
  if (ok) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  !!   ${what}`); }
};

const bit = (name: string): number => (ACTIONS as string[]).indexOf(name);

/** DeviceState holds raw edges; PlayerInput is what normally consumes them. */
const takePress = (dev: DeviceState, a: Action): boolean => {
  const s = dev.actions[a];
  if (s.pressedAt < 0) return false;
  s.pressedAt = -1;
  return true;
};
const takeRelease = (dev: DeviceState, a: Action): boolean => {
  const s = dev.actions[a];
  if (s.releasedAt < 0) return false;
  s.releasedAt = -1;
  return true;
};

// ------------------------------------------------------------ packet codec
console.log('— input packet —');
{
  const buttons = (1 << bit('pass')) | (1 << bit('shoot')) | (1 << SPRINT_BIT);
  const bytes = encodeInput(4242, buttons, -0.5, 1);
  check(bytes.byteLength === 6, 'packet is exactly 6 bytes');
  const back = decodeInput(bytes)!;
  check(!!back, 'decodes');
  check(back.seq === 4242, 'seq survives');
  check(back.buttons === buttons, 'button field survives');
  check(Math.abs(back.stickX + 0.5) < 0.01, 'stickX quantises within 1%');
  check(Math.abs(back.stickY - 1) < 0.01, 'stickY saturates at 1');

  // a barely-nudged stick is noise from the i8 quantisation, not intent
  check(decodeInput(encodeInput(1, 0, 0.05, 0.02))!.stickX === 0, 'sub-deadzone stick reads centred');
  // the stick clamps to the unit circle, so an over-driven axis can't fly
  check(Math.abs(decodeInput(encodeInput(1, 0, 5, 0))!.stickX - 1) < 0.01, 'out-of-range axis clamps');

  check(decodeInput(new Uint8Array(4)) === null, 'wrong-length buffer is rejected');
  check(decodeInput(encodeProbe(TAG_PING, 1)) === null, 'a probe is not an input packet');
}

// -------------------------------------------------------------- ping / pong
console.log('— latency probe —');
{
  const ping = encodeProbe(TAG_PING, 1234567);
  const p = decodeProbe(ping)!;
  check(p.tag === TAG_PING && p.stamp === 1234567, 'ping round-trips');
  const pong = decodeProbe(encodeProbe(TAG_PONG, 89))!;
  check(pong.tag === TAG_PONG && pong.stamp === 89, 'pong round-trips');
  check(decodeProbe(encodeInput(1, 0, 0, 0)) === null, 'an input packet is not a probe');
  check(decodeProbe(encodeProbe(0x7f, 1)) === null, 'unknown tag is rejected');
}

// ------------------------------------------------------------- seq ordering
console.log('— sequence ordering (u16 wrap) —');
{
  check(seqAhead(5, 4) === 1, 'next seq is ahead by 1');
  check(seqAhead(4, 5) === -1, 'previous seq is behind');
  check(seqAhead(7, 7) === 0, 'a duplicate is not ahead');
  check(seqAhead(0, 65535) === 1, 'wrap 65535 → 0 reads as ahead');
  check(seqAhead(3, 65530) === 9, 'wrap across the boundary measures correctly');
  check(seqAhead(65530, 3) === -9, 'the same gap backwards reads as stale');
  check(seqAhead(40000, 5) < 0, 'a half-range-away packet reads as old, not future');

  // the accept/drop rule the host actually runs, driven across the wrap
  let last: number | null = null;
  const accept = (seq: number): boolean => {
    if (last !== null && seqAhead(seq, last) <= 0) return false;
    last = seq;
    return true;
  };
  const feed = [65533, 65534, 65533, 65535, 0, 65534, 1, 1, 2];
  const taken = feed.filter(accept);
  check(
    taken.join(',') === '65533,65534,65535,0,1,2',
    'reordered + duplicated stream across the wrap is filtered to strictly newer',
  );
}

// ------------------------------------------------------------ edge synthesis
console.log('— edge synthesis —');
{
  const dev = new DeviceState();
  let prev = 0;
  let presses = 0;
  const feed = (buttons: number, x = 0, y = 0): void => {
    prev = applyInput(dev, decodeInput(encodeInput(1, buttons, x, y))!, prev, () => { presses++; });
  };

  feed(1 << bit('shoot'));
  check(dev.actions.shoot.held, 'level 1 → held');
  check(takePress(dev, 'shoot'), 'a press edge was buffered');
  check(presses === 1, 'the any-button hook fired once');

  feed(1 << bit('shoot')); // unchanged: a keepalive must not re-fire the edge
  check(!takePress(dev, 'shoot'), 'an identical keepalive makes no new edge');

  feed(0);
  check(!dev.actions.shoot.held, 'level 0 → released');
  check(takeRelease(dev, 'shoot'), 'a release edge was buffered (shots fire on release)');

  // two buttons flipping in one packet must both produce edges
  feed((1 << bit('pass')) | (1 << bit('through')));
  check(takePress(dev, 'pass') && takePress(dev, 'through'), 'simultaneous presses both land');

  feed(1 << SPRINT_BIT, 0.8, -0.6);
  check(dev.sprintHeld, 'sprint bit sets sprintHeld');
  check(!dev.actions.pass.held && !dev.actions.through.held, 'dropped bits release');
  check(Math.abs(dev.stick.x - 0.8) < 0.02 && Math.abs(dev.stick.y + 0.6) < 0.02, 'stick lands on the device');

  // a dropped packet is the normal case on an unreliable channel: the next
  // one still resolves the level, because levels are what we send
  const dev2 = new DeviceState();
  let prev2 = applyInput(dev2, decodeInput(encodeInput(1, 1 << bit('pass')))!, 0);
  prev2 = applyInput(dev2, decodeInput(encodeInput(9, 1 << bit('loft')))!, prev2); // seqs 2..8 lost
  check(!dev2.actions.pass.held && dev2.actions.loft.held, 'a gap in the stream still converges on the true level');
}

// ------------------------------------------------------------- seat plumbing
console.log('— hub seat plumbing —');
{
  const hub = new InputHub();
  const seat = hub.seat('remote', 3);
  let prev = 0;
  prev = applyInput(hub.remote(3), decodeInput(encodeInput(1, 1 << bit('shoot'), 0.5, 0))!, prev);
  check(seat.isHeld('shoot'), 'the sim-side seat sees the guest hold');
  check(Math.abs(seat.getStick().x - 0.5) < 0.02, 'the sim-side seat sees the guest stick');
  check(hub.connectedRemotes().includes(3), 'the guest shows up as a connected remote');

  // the AI-takeover path: neutralise, don't delete. A deleted remote is
  // re-created by the next seat read, which would resurrect it in
  // connectedRemotes() — and a frozen held button would fire on the handback.
  hub.remote(3).neutralize();
  check(!seat.isHeld('shoot'), 'neutralise drops the frozen hold');
  check(seat.getStick().x === 0, 'neutralise centres the frozen stick');
  check(hub.connectedRemotes().includes(3), 'the device survives for the rejoin');
}

// --------------------------------------------------------- disconnect ladder
console.log('— disconnect ladder —');
{
  check(seatHealth(0) === 'ok', '0ms → ok');
  check(seatHealth(DEGRADE_MS - 1) === 'ok', 'just under 1.5s → ok');
  check(seatHealth(DEGRADE_MS) === 'degraded', '1.5s → degraded');
  check(seatHealth(HOLD_MS - 1) === 'degraded', 'just under 5s → still degraded');
  check(seatHealth(HOLD_MS) === 'lost', '5s → lost (match holds)');
  check(seatHealth(AI_MS - 1) === 'lost', 'just under 15s → still lost');
  check(seatHealth(AI_MS) === 'gone', '15s → gone (AI takes the seat)');
  check(seatHealth(Infinity) === 'gone', 'a guest that never arrived is gone');
}

// ----------------------------------------------------- mid-match seat swap
console.log('— mid-match seat swap —');
{
  const hub = new InputHub();
  const seat = hub.seat('remote', 0);
  const match = new Match({
    home: findTeam('bra'), away: findTeam('fra'),
    seats: [hub.seat('keyboard'), seat],
    halfLengthSec: 60, difficulty: 'pro', seed: 7,
  });
  check(match.teams[1].isHuman, 'the away side starts human');

  // run into open play so a swap has to survive a live ball
  for (let i = 0; i < 600 && match.phase !== 'play'; i++) match.update();
  check(match.phase === 'play', 'reached open play');

  match.setSeat(1, null);
  check(match.seats[1] === null, 'the seat is empty after the AI takes over');
  check(!match.teams[1].isHuman, 'the team reads as CPU');
  check(match.controlled[1] === null, 'no player is left steered by a ghost');
  for (let i = 0; i < 600; i++) match.update();
  check(match.phase !== 'fulltime', 'the match keeps running on AI');

  match.setSeat(1, seat);
  check(match.seats[1] === seat, 'the human seat is handed back');
  check(match.teams[1].isHuman, 'the team reads as human again');
  check(match.controlled[1] !== null, 'a player is handed to the returning guest');
  for (let i = 0; i < 300; i++) match.update();
  check(match.phase !== 'fulltime', 'the match survives the handback');

  // idempotence: the ladder can call this every frame
  const before = match.controlled[1];
  match.setSeat(1, seat);
  check(match.controlled[1] === before, 'a redundant setSeat is a no-op');
}

// ------------------------------------------------------------- room identity
console.log('— room codes —');
{
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const code = newRoomCode();
    if (code.length !== CODE_LENGTH || [...code].some((c) => !CODE_ALPHABET.includes(c))) {
      failures++;
      console.error(`  !!   bad code ${code}`);
      break;
    }
    seen.add(code);
  }
  check(seen.size > 300, '500 codes are drawn from a wide space');
  check(!CODE_ALPHABET.includes('O') && !CODE_ALPHABET.includes('0'), 'no O/0 lookalikes');
  check(!CODE_ALPHABET.includes('I') && !CODE_ALPHABET.includes('1') && !CODE_ALPHABET.includes('L'),
    'no I/1/L lookalikes');
  check(isRoomCode('MK7Q') && !isRoomCode('MK7') && !isRoomCode('MK7O'), 'code validation');

  const a = hostPeerId('MK7Q');
  check(a === hostPeerId('MK7Q'), 'peer id is stable for a code (both ends derive it)');
  check(a !== hostPeerId('MK7R'), 'a different code is a different room');
  check(a.startsWith('ss26-v1-MK7Q-'), 'peer id is namespaced and carries the code');
  check(/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(a), 'peer id is a legal broker id');
}

console.log(failures === 0 ? 'NET TEST PASS' : `NET TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
