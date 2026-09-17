// Front-end shooter (§7A.9, menus edition). Drives the real app headlessly at
// 1920x1080 and walks title → main menu → game settings → team select → match
// settings → invite lobby (→ PAUSED, with --match), writing a PNG per screen
// into captures/menu/ plus a stats.json that proves none of them came out
// blank.
//
//   npm run shoot-menu
//   npm run shoot-menu -- --url http://localhost:5173   # reuse a dev server
//   npm run shoot-menu -- --match                       # also shoot PAUSED
//   npm run shoot-menu -- --wait 60000                  # longer glTF wait
//   npm run shoot-menu -- --live                        # keep CSS animations
//
// The walk is keyboard-driven on purpose: it exercises exactly the bindings a
// player uses (WASD/arrows, J confirm, K back), and MenuNav routes the pad
// through the same handlers.
//
// Every step waits on STATE, never on a sleep. Under SwiftShader one menu
// render can take half a second, and a script built out of fixed delays walks
// off the end of the flow and screenshots the wrong screen. `__ss26Menu.screen()`
// (the same debug-hook idiom as __ss26 / __ss26Attract) is what it waits on.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, parseArgs, pixelStats, startDevServer } from './harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const WIDTH = 1920;
const HEIGHT = 1080;
const STEP_TIMEOUT = 30_000;

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(ROOT, typeof args.out === 'string' ? args.out : 'captures/menu');
const backdropWaitMs = Number(args.wait ?? 45_000) || 45_000;
const shootMatch = args.match === true || args.match === 'true';
const freeze = !(args.live === true || args.live === 'true');

mkdirSync(outDir, { recursive: true });

/** CSS animations make a screenshot a coin toss; park them at frame zero. */
const FREEZE_CSS = `*, *::before, *::after {
  animation: none !important;
  transition-duration: 0s !important;
}`;

let server = null;
let browser = null;
let failures = 0;
const shots = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let base = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : null;
  if (!base) {
    server = await startDevServer({ port: 5277 });
    base = server.url;
    console.log(`dev server: ${base}`);
  }

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(String(e)));

  const key = async (code, times = 1, gap = 160) => {
    for (let i = 0; i < times; i++) {
      await page.keyboard.press(code);
      await sleep(gap);
    }
  };

  const TILES = ['KICK OFF', 'VERSUS', 'TOURNAMENT', 'TEAMS', 'SETTINGS'];

  /**
   * Move the tile cursor onto `label` and CHECK it landed.
   *
   * Under SwiftShader a single menu render can outlast the gap between two
   * synthetic key presses, and the headless input pipeline occasionally drops
   * one; a blind `ArrowRight ×2` then screenshots the wrong tile. Reading the
   * focus back is the only honest way to drive this.
   */
  const focusTile = async (label) => {
    const read = () => page.evaluate(
      () => document.querySelector('.fe-tile.focus .fe-tile-name')?.textContent ?? '');
    for (let i = 0; i < 12; i++) {
      const cur = await read();
      if (cur === label) return;
      const want = TILES.indexOf(label);
      const at = TILES.indexOf(cur);
      await key(at < 0 || at < want ? 'ArrowRight' : 'ArrowLeft', 1, 200);
    }
    throw new Error(`could not put the tile cursor on ${label}`);
  };

  /** Same, for the sub-list under the focused tile. */
  const focusSub = async (label) => {
    const read = () => page.evaluate(
      () => document.querySelector('.fe-subrow.focus .fe-subrow-label')?.textContent ?? '');
    for (let i = 0; i < 8; i++) {
      if ((await read()) === label) return;
      await key('ArrowDown', 1, 200);
    }
    throw new Error(`could not put the cursor on ${label}`);
  };

  /** Wait until the front end says it is on `name`. */
  const onScreen = (name, timeout = STEP_TIMEOUT) => page.waitForFunction(
    (n) => window.__ss26Menu?.screen?.() === n, name, { timeout });

  /**
   * Press `code` until the front end is on `screen`. Same reason as focusTile:
   * the headless input pipeline drops the odd synthetic keypress when a render
   * runs long, and a one-shot press then leaves the whole walk a screen behind.
   * The menus are idempotent here — a second K on a screen you already left is
   * simply that screen's own back.
   */
  const step = async (code, screen, tries = 6) => {
    for (let i = 0; i < tries; i++) {
      await key(code, 1, 220);
      const ok = await onScreen(screen, 5000).then(() => true).catch(() => false);
      if (ok) return;
    }
    throw new Error(`pressing ${code} never reached ${screen}`);
  };

  const sel = (s) => page.waitForSelector(s, { timeout: STEP_TIMEOUT });

  /** Two clean frames — the compositor has actually painted what we asked for. */
  const painted = () => page.evaluate(() => new Promise((r) => {
    requestAnimationFrame(() => requestAnimationFrame(() => r(true)));
  })).catch(() => {});

  /** Park the 3D backdrop: software GL + a 60Hz canvas can starve the capture. */
  const still = (on) => page.evaluate((v) => {
    window.__ss26Menu?.backdrop?.freeze(v);
  }, on).catch(() => {});

  const shoot = async (name) => {
    const file = join(outDir, `${name}.png`);
    let px = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await still(true);
      await painted();
      try {
        await page.screenshot({
          path: file, timeout: 45_000, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        });
      } catch (err) {
        // SwiftShader's compositor occasionally never hands a frame back; that
        // is an environment stall, not a broken screen, so try again
        await still(false);
        await sleep(1200);
        px = { blank: true, minLum: -1, maxLum: -1, meanLum: -1, colors: 0, error: String(err.message ?? err) };
        continue;
      }
      await still(false);
      px = pixelStats(file);
      if (!px.blank) break;
      // a compositor that handed back a background-only frame: give it a beat
      await sleep(900);
    }
    shots[name] = px;
    if (px.blank) {
      failures++;
      console.error(`${name.padEnd(22)} BLANK (lum ${px.minLum}..${px.maxLum})`);
    } else {
      console.log(`${name.padEnd(22)} [lum ${px.minLum}..${px.maxLum}, mean ${px.meanLum}, ${px.colors} colours]`);
    }
  };

  await page.goto(`${base}/`, { waitUntil: 'load' });
  await sel('.fe-start');
  if (freeze) await page.addStyleTag({ content: FREEZE_CSS });

  // The 3D backdrop swaps in when the characters finish downloading — the
  // canvas fades to opacity 1. Not fatal if it never does: the styled fallback
  // is a deliberate part of the design, and the shot says which one we got.
  const gotBackdrop = await page
    .waitForFunction(() => {
      const c = document.querySelector('canvas.fe-backdrop');
      return !!c && c.style.opacity === '1';
    }, null, { timeout: backdropWaitMs })
    .then(() => true)
    .catch(() => false);
  console.log(gotBackdrop ? 'backdrop: skinned players live' : 'backdrop: styled fallback (glTF not ready)');
  await sleep(gotBackdrop ? 900 : 200); // a beat of camera drift

  // ------------------------------------------------------------------ title
  await shoot('01-title');

  // -------------------------------------------------------------- main menu
  await step('KeyJ', 'main');
  await sel('.fe-tilerow');
  await shoot('02-main-kickoff');

  await focusTile('TOURNAMENT');
  await shoot('03-main-tournament');
  await focusTile('SETTINGS');
  await shoot('04-main-settings');

  // ----------------------------------------------------------- game settings
  await step('KeyJ', 'prefs');
  await shoot('05-game-settings');
  await step('KeyK', 'main');

  // ------------------------------------------------------------ roster editor
  await focusTile('TEAMS');
  await focusSub('EDIT TEAMS');
  await key('KeyJ');
  const gotEditor = await sel('.fe-skin .team-grid').then(() => true).catch(() => false);
  if (gotEditor) {
    await shoot('06-teams-editor');
    await key('Escape');                // the editor owns its own keyboard
    await step('KeyJ', 'main');
  } else {
    failures++;
    console.error('06-teams-editor      FAILED: the editor never rendered');
  }

  // ------------------------------------------------------------- team select
  await focusTile('KICK OFF');
  await focusSub('QUICK MATCH');
  await step('KeyJ', 'pickHome');
  await key('ArrowRight', 5, 120);
  await key('ArrowDown', 1, 120);
  await shoot('07-team-home');

  await step('KeyJ', 'pickAway');
  await key('ArrowRight', 3, 120);
  await shoot('08-team-away');

  // the match-dressing strip beneath the grid
  await key('ArrowDown', 8, 110);
  await sel('.fe-stripitem.focus');
  await shoot('09-team-strip');
  await key('ArrowRight', 2, 120);
  await key('KeyJ');                    // cycle the focused selector
  await shoot('10-strip-changed');
  await key('ArrowUp');
  await sel('.fe-cell.focus');

  // ---------------------------------------------------------- match settings
  await step('KeyJ', 'settings');
  await shoot('11-match-settings');

  // ----------------------------------------------------------- back out, lobby
  await step('KeyK', 'pickAway');
  await step('KeyK', 'pickHome');
  await step('KeyK', 'main');

  await focusTile('VERSUS');
  await focusSub('INVITE PLAYERS');
  await key('KeyJ');
  // 'online' still walks the normal team-select → settings path; the lobby is
  // what the GO row opens, exactly as it always was
  await onScreen('pickHome');
  await step('KeyJ', 'pickAway');
  await key('ArrowRight', 2, 120);
  await step('KeyJ', 'settings');
  await key('KeyJ');                    // GO → INVITE PLAYERS
  const gotLobby = await sel('.fe-seats').then(() => true).catch(() => false);
  if (gotLobby) {
    await sleep(900); // the room code arrives from the signaling server
    await shoot('12-lobby');
    await key('ArrowUp');
    await key('ArrowRight');
    await shoot('13-lobby-seat');
  } else {
    failures++;
    const where = await page.evaluate(() => ({
      screen: window.__ss26Menu?.screen?.() ?? null,
      crumb: document.querySelector('.fe-crumb')?.textContent ?? null,
      go: document.querySelector('.fe-go')?.textContent?.trim() ?? null,
      inMatch: !!window.__ss26?.match,
      root: document.getElementById('ui-root')?.innerHTML.slice(0, 400) ?? null,
    })).catch(() => null);
    console.error(`11-lobby             FAILED: the lobby never rendered — ${JSON.stringify(where)}`);
    for (const l of logs.slice(-6)) console.error(`  page: ${l.slice(0, 300)}`);
  }

  // ------------------------------------------------------------ pause screen
  if (shootMatch) {
    // PAUSED, over a real match. Software GL makes this the slow one.
    // cancelling the lobby drops all the way back to a fresh front end
    await step('KeyK', 'title');
    await step('KeyJ', 'main');
    await focusTile('KICK OFF');
    await focusSub('QUICK MATCH');
    await step('KeyJ', 'pickHome');
    await step('KeyJ', 'pickAway');
    await key('ArrowRight', 2, 120);
    await step('KeyJ', 'settings');
    await key('KeyJ'); // KICK OFF!
    const live = await page.waitForFunction(() => !!window.__ss26?.match, null, { timeout: 180_000 })
      .then(() => true).catch(() => false);
    if (live) {
      await sleep(5000);
      // a match frame under software GL can take seconds, and the pause press
      // only buffers for five — so keep asking until the loop notices
      let paused = false;
      for (let i = 0; i < 8 && !paused; i++) {
        await page.keyboard.press('Escape');
        paused = await page.waitForSelector('.fe-pause', { timeout: 6000 })
          .then(() => true).catch(() => false);
      }
      if (freeze) await page.addStyleTag({ content: FREEZE_CSS });
      if (paused) await shoot('14-pause');
      else { failures++; console.error('14-pause             FAILED: no overlay'); }
    } else {
      failures++;
      console.error('14-pause             FAILED: the match never started');
    }
  }

  for (const l of logs.slice(0, 10)) console.error(`  page: ${l}`);

  writeFileSync(join(outDir, 'stats.json'), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    viewport: { width: WIDTH, height: HEIGHT },
    backdrop: gotBackdrop ? 'skinned' : 'fallback',
    pageErrors: logs.slice(0, 20),
    shots,
  }, null, 2)}\n`);
  console.log(`\n${Object.keys(shots).length} screen(s) → ${outDir}`);
  await page.close();
} finally {
  await browser?.close();
  await server?.stop();
}

process.exit(failures ? 1 : 0);
