// `npm run test:input` (tsx) — the pad-identity and stick maths that a real
// controller would otherwise be the only way to check. Pure functions only:
// nothing here touches window, navigator or the DOM, which is exactly why they
// were split out of InputHub.

import {
  PAD_BINDINGS, STICK_DEADZONE, STICK_SATURATION,
  applyDeadzone, detectPadModel, detectPadStyle, padGlyph, padVendorProduct,
  RUMBLE_CUES,
} from './input';

/**
 * A three-line assert, so this file needs no @types/node and stays inside the
 * project's own `tsc --noEmit` pass over src/ like every other module.
 */
const assert = {
  ok(v: unknown, msg = 'expected truthy'): void {
    if (!v) throw new Error(msg);
  },
  equal(a: unknown, b: unknown, msg?: string): void {
    if (a !== b) throw new Error(msg ?? `expected ${String(b)}, got ${String(a)}`);
  },
  deepEqual(a: unknown, b: unknown, msg?: string): void {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(msg ?? `expected ${sb}, got ${sa}`);
  },
};

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

console.log('pad identity');

// The exact strings Chromium hands out on macOS, USB and Bluetooth. The BT id
// for a DualSense is the same shape; only the leading product name differs
// between firmware revisions, which is why detection keys off vendor/product.
const IDS: [string, 'ps' | 'xbox' | 'generic', string][] = [
  ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'ps', 'DualSense'],
  ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'ps', 'DualSense'],
  ['DualSense Edge Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0df2)', 'ps', 'DualSense Edge'],
  ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)', 'ps', 'DualShock 4'],
  ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'ps', 'DualShock 4 (v2)'],
  ['054c-0ce6-DualSense Wireless Controller', 'ps', 'DualSense'],
  // macOS Game Controller framework path: no vendor/product hex at all
  ['DualSense Wireless Controller (STANDARD GAMEPAD)', 'ps', 'DualSense'],
  ['DualSense Edge Wireless Controller (STANDARD GAMEPAD)', 'ps', 'DualSense Edge'],
  ['Wireless Controller (STANDARD GAMEPAD)', 'ps', 'Wireless Controller'],
  ['Xbox Wireless Controller (STANDARD GAMEPAD)', 'xbox', 'Xbox Controller'],
  ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox', 'Xbox Controller'],
  ['8BitDo SN30 Pro (STANDARD GAMEPAD Vendor: 2dc8 Product: 6001)', 'generic', '8BitDo SN30 Pro'],
  ['Some Unlabelled Pad', 'generic', 'Some Unlabelled Pad'],
];

for (const [id, style, model] of IDS) {
  check(`${style.padEnd(7)} ${id.slice(0, 44)}`, () => {
    assert.equal(detectPadStyle(id), style);
    assert.equal(detectPadModel(id), model);
  });
}

check('vendor/product parses both Chromium and Firefox id shapes', () => {
  assert.deepEqual(
    padVendorProduct('Wireless Controller (STANDARD GAMEPAD Vendor: 054C Product: 0CE6)'),
    { vendor: '054c', product: '0ce6' },
  );
  assert.deepEqual(padVendorProduct('054c-0ce6-Wireless Controller'), { vendor: '054c', product: '0ce6' });
  assert.equal(padVendorProduct('Nothing Useful Here'), null);
});

console.log('\nbutton map');

check('every action has exactly one primary binding and a glyph per style', () => {
  for (const action of ['pass', 'loft', 'shoot', 'through', 'switch', 'tactics', 'sprint', 'pause'] as const) {
    const b = PAD_BINDINGS.find((x) => x.action === action);
    assert.ok(b, `no binding for ${action}`);
    assert.ok(typeof b?.button === 'number', `${action} has no button index`);
    for (const style of ['ps', 'xbox', 'generic'] as const) {
      assert.ok(padGlyph(action, style).length > 0, `${action}/${style} has no glyph`);
    }
  }
});

check('indices match Chromium standard mapping', () => {
  const byAction = (a: string): number | null => PAD_BINDINGS.find((b) => b.action === a)?.button ?? null;
  assert.equal(byAction('pass'), 0);      // ✕ / A
  assert.equal(byAction('loft'), 1);      // ○ / B
  assert.equal(byAction('shoot'), 2);     // □ / X
  assert.equal(byAction('through'), 3);   // △ / Y
  assert.equal(byAction('switch'), 4);    // L1 / LB
  assert.equal(byAction('tactics'), 6);   // L2 / LT
  assert.equal(byAction('sprint'), 7);    // R2 / RT
  assert.equal(byAction('replay'), 8);    // Create / Back
  assert.equal(byAction('pause'), 9);     // Options / Start
  // 16 (PS/Guide) is deliberately unbound: macOS reserves it
  assert.ok(!PAD_BINDINGS.some((b) => b.button === 16));
});

check('PS glyphs are the Sony faces, not the Xbox letters', () => {
  assert.equal(padGlyph('pass', 'ps'), '✕');
  assert.equal(padGlyph('shoot', 'ps'), '□');
  assert.equal(padGlyph('shoot', 'xbox'), 'X'); // same letter, different button
  assert.equal(padGlyph('loft', 'ps'), '○');
  assert.equal(padGlyph('through', 'ps'), '△');
});

console.log('\nstick deadzone');

check('rest position and drift are killed dead', () => {
  for (const [x, y] of [[0, 0], [0.05, 0.02], [-0.08, 0.06], [0.1, 0]]) {
    const s = applyDeadzone(x, y);
    assert.equal(s.x, 0);
    assert.equal(s.y, 0);
  }
});

check('output is continuous: it leaves the deadzone at zero, not at a step', () => {
  const just = applyDeadzone(STICK_DEADZONE + 1e-4, 0);
  assert.ok(Math.hypot(just.x, just.y) < 0.01, 'a step at the deadzone edge');
});

check('full tilt saturates at exactly 1', () => {
  for (const [x, y] of [[1, 0], [0, -1], [0.99, 0], [-1, 0]]) {
    const s = applyDeadzone(x, y);
    assert.ok(Math.hypot(s.x, s.y) > 0.999, `${x},${y} did not reach full tilt`);
    assert.ok(Math.hypot(s.x, s.y) <= 1.0001, `${x},${y} overshot 1`);
  }
});

check('direction is preserved (radial, not per-axis)', () => {
  // a per-axis deadzone mangles diagonals; a radial one must not
  const s = applyDeadzone(0.6, 0.6);
  assert.ok(Math.abs(s.x - s.y) < 1e-9, 'diagonal skewed');
  const angleIn = Math.atan2(0.3, 0.8);
  const t = applyDeadzone(0.8, 0.3);
  assert.ok(Math.abs(Math.atan2(t.y, t.x) - angleIn) < 1e-9, 'angle rotated');
});

check('a full-tilt diagonal is reachable (square gate clamp, magnitude 1)', () => {
  // DualSense sticks travel in a circle, so the true corner is ~0.71,0.71
  const s = applyDeadzone(0.707, 0.707);
  assert.ok(Math.hypot(s.x, s.y) > 0.999);
});

check('magnitude is monotonic across the range', () => {
  let prev = -1;
  for (let r = 0; r <= 1.0001; r += 0.01) {
    const m = Math.hypot(...Object.values(applyDeadzone(r, 0)) as [number, number]);
    assert.ok(m >= prev - 1e-12, `not monotonic at ${r}`);
    prev = m;
  }
  assert.ok(prev > 0.999);
});

check('the walk threshold lands near the old flat 0.22 gate', () => {
  // sim/match.ts moves the player once |stick| > 0.15; this is the raw
  // deflection at which that happens, and it must not have drifted far
  let raw = 0;
  for (let r = 0; r <= 1; r += 0.001) {
    const s = applyDeadzone(r, 0);
    if (Math.hypot(s.x, s.y) > 0.15) { raw = r; break; }
  }
  assert.ok(raw > 0.15 && raw < 0.30, `walk threshold at raw ${raw.toFixed(3)}`);
});

check('constants are sane', () => {
  assert.ok(STICK_DEADZONE > 0 && STICK_DEADZONE < STICK_SATURATION);
  assert.ok(STICK_SATURATION <= 1);
});

console.log('\nrumble vocabulary');

check('every cue is in range and ordered by priority sensibly', () => {
  for (const [name, c] of Object.entries(RUMBLE_CUES)) {
    assert.ok(c.strong >= 0 && c.strong <= 1, `${name} strong out of range`);
    assert.ok(c.weak >= 0 && c.weak <= 1, `${name} weak out of range`);
    assert.ok(c.ms > 0 && c.ms <= 1000, `${name} duration out of range`);
  }
  assert.ok(RUMBLE_CUES.goal.priority > RUMBLE_CUES.kickHeavy.priority);
  assert.ok(RUMBLE_CUES.kickHeavy.priority > RUMBLE_CUES.kickLight.priority);
  assert.ok(RUMBLE_CUES.post.priority > RUMBLE_CUES.tackle.priority);
  assert.equal(RUMBLE_CUES.goal.strong, 1);
});

console.log(`\n${checks} checks passed`);
