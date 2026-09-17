// Headless commentary pacing harness.
//
// Commentary is the one part of the game you cannot review by looking at it,
// and CI has no ears. So: run a seeded CPU-vs-CPU match in node, push its
// events through the REAL director and the REAL queue, time each line with the
// REAL clip durations from public/audio/commentary.json, and print exactly what
// would be said and when. Only the ~20 lines of Web Audio plumbing in
// commentary.ts are not exercised.
//
//   npx tsx pipeline/audio/dryrun.ts
//   npx tsx pipeline/audio/dryrun.ts --seed 7 --home bra --away mex --minutes 8
//   npx tsx pipeline/audio/dryrun.ts --sweep 12        # 12 matches, stats only
//
// What to look for: no two lines overlapping, goals never talked over, a line
// density around 2-5 per minute, and long quiet stretches broken by colour.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { planUtterance, type CommentaryManifest } from '../../src/audio/commentaryBank';
import { CommentaryDirector, CommentaryQueue } from '../../src/audio/commentaryScript';
import { findTeam } from '../../src/data/loader';
import { SIM_DT } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface Args {
  seed: number; home: string; away: string; minutes: number; sweep: number;
  quiet: boolean; knockout: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string): string => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    seed: Number(get('seed', '20260917')),
    home: get('home', 'bra'),
    away: get('away', 'mex'),
    minutes: Number(get('minutes', '6')),
    sweep: Number(get('sweep', '0')),
    quiet: argv.includes('--quiet'),
    // --knockout forces the draw paths: extra time, the shootout, the verdicts
    knockout: argv.includes('--knockout'),
  };
}

interface Spoken {
  t: number; group: string; pri: number; voice: string;
  dur: number; text: string; interrupt: boolean;
}

interface RunResult {
  spoken: Spoken[];
  missing: string[];
  events: number;
  duration: number;
  goals: number;
}

function runMatch(man: CommentaryManifest, a: Args, seed: number): RunResult {
  const home = findTeam(a.home);
  const away = findTeam(a.away);
  const match = new Match({
    home, away, seats: [null, null],
    halfLengthSec: a.minutes * 60, difficulty: 'pro', knockout: a.knockout,
    mode: 'match', seed,
  });
  const teamIds = [home.id, away.id];
  const teamNames = [home.name, away.name];

  const director = new CommentaryDirector(seed ^ 0x5f3759df);
  const queue = new CommentaryQueue();
  // deterministic variant choice, so a seed reproduces the exact broadcast
  let s = (seed * 2654435761) >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const recent = new Map<string, number>();
  const spoken: Spoken[] = [];
  const missing = new Set<string>();
  let clock = 0;
  let events = 0;
  let goals = 0;

  const pump = (): void => {
    const follow = queue.settle(clock);   // retires a finished line first
    if (follow) queue.push(follow, clock);
    const next = queue.take(clock);
    if (!next) return;
    const plan = planUtterance(man, next.cue, teamIds, rand, () => true, teamNames, recent);
    if (!plan) { queue.abandoned(); missing.add(next.cue.group); return; }
    queue.began(next.cue, plan.duration, clock);
    director.noteSpoken(next.cue.priority);
    spoken.push({
      t: clock, group: next.cue.group, pri: next.cue.priority, voice: plan.voice,
      dur: plan.duration, text: plan.text, interrupt: next.interrupt,
    });
  };

  match.events.on((e) => {
    events++;
    if (e.type === 'goal') goals++;
    const cue = director.onEvent(e, match);
    if (cue) queue.push(cue, clock);
  });

  const maxTicks = Math.ceil((a.minutes * 60 * 2 + 240) / SIM_DT);
  for (let i = 0; i < maxTicks; i++) {
    match.update();
    clock += SIM_DT;
    const idle = director.tick(SIM_DT);
    if (idle) queue.push(idle, clock);
    pump();
    if (match.phase === 'break') match.continueFromBreak();
    if (match.phase === 'fulltime') {
      // let the verdict and the scoreline actually play out
      for (let j = 0; j < Math.ceil(12 / SIM_DT); j++) { clock += SIM_DT; pump(); }
      break;
    }
  }
  return { spoken, missing: [...missing], events, duration: clock, goals };
}

function mmss(t: number): string {
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}

function report(r: RunResult): { overlaps: number; maxGap: number; perMin: number } {
  let overlaps = 0;
  let maxGap = 0;
  let prevEnd = 0;
  for (const s of r.spoken) {
    if (s.t < prevEnd - 1e-6 && !s.interrupt) overlaps++;
    maxGap = Math.max(maxGap, s.t - prevEnd);
    prevEnd = Math.max(prevEnd, s.t + s.dur);
  }
  return {
    overlaps, maxGap,
    perMin: r.spoken.length / (r.duration / 60),
  };
}

function main(): number {
  const a = parseArgs(process.argv.slice(2));
  let man: CommentaryManifest;
  try {
    man = JSON.parse(
      readFileSync(resolve(ROOT, 'public', 'audio', 'commentary.json'), 'utf-8'),
    ) as CommentaryManifest;
  } catch {
    console.error('no public/audio/commentary.json — run pipeline/audio/bake_commentary.py first');
    return 1;
  }
  console.log(`voice pack: ${man.engine}  (${Object.keys(man.clips).length} clips, `
    + `${Object.keys(man.groups).length} line groups, ${Object.keys(man.names).length} squads)`);

  if (a.sweep > 0) {
    let lines = 0; let overlaps = 0; let worstGap = 0; let goals = 0;
    const seen = new Set<string>();
    const missing = new Set<string>();
    for (let i = 0; i < a.sweep; i++) {
      const r = runMatch(man, a, a.seed + i * 977);
      const stats = report(r);
      lines += r.spoken.length;
      goals += r.goals;
      overlaps += stats.overlaps;
      worstGap = Math.max(worstGap, stats.maxGap);
      for (const s of r.spoken) seen.add(s.group);
      for (const g of r.missing) missing.add(g);
      console.log(`  seed ${a.seed + i * 977}: ${String(r.spoken.length).padStart(3)} lines, `
        + `${r.goals} goals, ${stats.perMin.toFixed(1)}/min, longest silence ${stats.maxGap.toFixed(0)}s`);
    }
    console.log(`\n${a.sweep} matches: ${lines} lines, ${goals} goals, `
      + `${overlaps} overlaps, longest silence ${worstGap.toFixed(0)}s`);
    // `.plain` groups are the no-name fallbacks: they only fire when a surname
    // isn't in the pack, so NOT firing them is the healthy result
    const all = Object.keys(man.groups);
    const live = all.filter((g) => !g.includes('.plain'));
    const unused = live.filter((g) => !seen.has(g));
    console.log(`groups exercised: ${seen.size}/${live.length} `
      + `(+${all.length - live.length} no-name fallbacks, idle by design)`);
    if (unused.length) console.log(`  never fired: ${unused.join(', ')}`);
    if (missing.size) console.log(`  UNBAKED (director asked, manifest lacked): ${[...missing].join(', ')}`);
    return overlaps > 0 || missing.size > 0 ? 1 : 0;
  }

  const r = runMatch(man, a, a.seed);
  if (!a.quiet) {
    console.log(`\n${a.home.toUpperCase()} v ${a.away.toUpperCase()}  seed ${a.seed}  `
      + `${a.minutes}-min halves  (${r.events} sim events, ${r.goals} goals)\n`);
    console.log('  time    pri voice   dur   line');
    for (const s of r.spoken) {
      console.log(`  ${mmss(s.t)}  ${s.pri}  ${s.voice.padEnd(6)} ${s.dur.toFixed(2)}s `
        + `${s.interrupt ? '[CUT IN] ' : ''}${s.text}`);
    }
  }
  const stats = report(r);
  console.log(`\n${r.spoken.length} lines over ${(r.duration / 60).toFixed(1)} min `
    + `= ${stats.perMin.toFixed(1)}/min; longest silence ${stats.maxGap.toFixed(0)}s; `
    + `${stats.overlaps} overlaps`);
  if (r.missing.length) console.log(`UNBAKED groups: ${r.missing.join(', ')}`);
  return stats.overlaps > 0 || r.missing.length > 0 ? 1 : 0;
}

process.exit(main());
