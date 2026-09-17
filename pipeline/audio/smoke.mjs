// Runtime audio smoke test: does the browser actually eat what we baked?
//
// dryrun.ts proves the PACING is right in node. This proves the ASSETS are
// right in Chromium — the two failure modes node can't see are (a) the Opus
// sprites don't decode, and (b) the manifest paths don't resolve under the
// game's `base: './'`. Both are silent failures at runtime (the game just goes
// quiet), so they need a gate.
//
//   node pipeline/audio/smoke.mjs
//   node pipeline/audio/smoke.mjs --url http://localhost:5173   # existing server
//
// Exits non-zero if a manifest is missing, a sprite fails to decode, a clip
// slice lands outside its sprite, or the audio graph throws.

import { launchBrowser, parseArgs, startDevServer } from '../../tools/harness.mjs';

const args = parseArgs(process.argv.slice(2));
let server = null;
let browser = null;
let bad = 0;

try {
  let url = typeof args.url === 'string' ? args.url : null;
  if (!url) {
    server = await startDevServer({ port: 5284 });
    url = server.url;
  }
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/commentary:|audio:/.test(t)) console.log(`  [page] ${t}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  // give the attract match a chance to boot (that is what publishes __ss26)
  await page.waitForTimeout(4000);

  const result = await page.evaluate(async () => {
    const out = { errors: [], notes: [] };
    // the engine unlocks on a pointerdown; headless has no user to supply one
    window.dispatchEvent(new PointerEvent('pointerdown'));
    const ctx = new AudioContext();
    const base = './';
    const grab = async (p) => {
      const r = await fetch(base + p);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${p}`);
      return r;
    };

    // --- commentary manifest + a representative sprite from each family
    let man;
    try {
      man = await (await grab('audio/commentary.json')).json();
      out.notes.push(`commentary: ${Object.keys(man.clips).length} clips, `
        + `${Object.keys(man.sprites).length} sprites, engine ${man.engine}`);
    } catch (e) { out.errors.push(`commentary.json: ${e}`); return out; }

    const probe = ['pbp.goal', 'pbp.verdict', 'colour.colour', 'name.bra', 'name.mex']
      .filter((k) => man.sprites[k]);
    for (const key of probe) {
      try {
        const buf = await ctx.decodeAudioData(
          await (await grab(man.base + man.sprites[key].file)).arrayBuffer());
        const declared = man.sprites[key].dur;
        if (Math.abs(buf.duration - declared) > 0.25) {
          out.errors.push(`${key}: decoded ${buf.duration.toFixed(2)}s vs manifest ${declared}s`);
        }
        // every clip in this sprite must lie inside the decoded buffer
        const over = Object.entries(man.clips)
          .filter(([, c]) => c[0] === key)
          .filter(([, c]) => (c[1] + c[2]) / 1000 > buf.duration + 0.05);
        if (over.length) out.errors.push(`${key}: ${over.length} clips past the end`);
        out.notes.push(`decoded ${key}: ${buf.duration.toFixed(2)}s @ ${buf.sampleRate}Hz`);
      } catch (e) { out.errors.push(`${key}: ${e}`); }
    }

    // --- crowd pack
    try {
      const crowd = await (await grab('audio/crowd.json')).json();
      for (const [name, def] of Object.entries(crowd.layers)) {
        const buf = await ctx.decodeAudioData(
          await (await grab(crowd.base + def.file)).arrayBuffer());
        if (Math.abs(buf.duration - def.dur) > 0.25) {
          out.errors.push(`crowd ${name}: decoded ${buf.duration.toFixed(2)}s vs ${def.dur}s`);
        }
      }
      out.notes.push(`crowd: ${Object.keys(crowd.layers).length} layers decoded`);
    } catch (e) { out.errors.push(`crowd: ${e}`); }

    // --- the real engine: unlock, fire every stinger, make sure nothing throws
    try {
      const audio = window.__ss26audio?.audio ?? window.__ss26?.audio;
      if (!audio) { out.errors.push('no audio engine on window (__ss26audio missing)'); }
      else {
        audio.unlock();
        for (const s of ['whoosh', 'goalSting', 'goal', 'sting', 'replayIn', 'replayOut',
          'cardSting', 'select', 'back', 'applause', 'walkout', 'halftime', 'fulltime',
          'nonsense']) audio.stinger(s);
        audio.duckCrowd(true); audio.duckCrowd(false);
        audio.setCrowd(true);
        audio.onEvent({ type: 'goal', teamIdx: 0, scorerName: 'Test Player', minute: 12 });
        audio.onEvent({ type: 'card', color: 'red', teamIdx: 1, playerName: 'X', minute: 13 });
        audio.onEvent({ type: 'kick', power: 0.9 });
        audio.update(0.016);
        out.notes.push('stingers + match events fired clean');
      }
    } catch (e) { out.errors.push(`engine: ${e}`); }

    // --- the commentary engine, end to end: a duck-typed match (all the
    //     director reads is teams/clock/mode/score) driven through kickoff,
    //     a goal and full time. Proves prefetch -> resolve -> splice -> play.
    try {
      const commentary = window.__ss26audio?.commentary;
      if (!commentary) throw new Error('no commentary engine on window');
      const team = (id, name, score) => ({ data: { id, name }, score });
      const match = {
        teams: [team('bra', 'Brazil', 0), team('mex', 'Mexico', 0)],
        clock: 0, mode: 'match',
      };
      commentary.refresh(match);
      // wait for the sprites this match needs
      for (let i = 0; i < 60 && !commentary.hasVoice; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 1200));
      const fire = async (e, secs) => {
        commentary.onEvent(e, match);
        for (let i = 0; i < secs * 60; i++) { commentary.update(1 / 60); }
        await new Promise((r) => setTimeout(r, 60));
      };
      await fire({ type: 'kickoff', half: 1 }, 6);
      match.teams[0].score = 1;
      await fire({ type: 'goal', teamIdx: 0, scorerName: 'Vinicius Junior', minute: 23 }, 8);
      await fire({ type: 'card', color: 'yellow', teamIdx: 1, playerName: 'Cesar Montes', minute: 40 }, 6);
      await fire({ type: 'fulltime' }, 12);
      const said = commentary.log.map((l) => `${l.t}s [${l.voice}] ${l.text}`);
      if (!said.length) out.errors.push('commentary spoke nothing');
      out.notes.push(`commentary spoke ${said.length} line(s):`);
      for (const l of said) out.notes.push(`    ${l}`);
    } catch (e) { out.errors.push(`commentary: ${e}`); }

    await ctx.close();
    return out;
  });

  for (const n of result.notes) console.log(`  ${n}`);
  for (const e of result.errors) { console.error(`  FAIL ${e}`); bad++; }
} catch (err) {
  console.error(err);
  bad++;
} finally {
  await browser?.close();
  await server?.stop?.();
}

console.log(bad ? `\naudio smoke: ${bad} failure(s)` : '\naudio smoke: OK');
process.exit(bad ? 1 : 0);
