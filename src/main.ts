// SUPER STRIKER '26 — boot, menu flow, tournament hub, and the fixed-timestep
// game loop (§8): sim at 60Hz, render interpolated, URL → kickoff in seconds.

import './ui/ui.css';
import { InputHub, type PlayerInput } from './input/input';
import { Match, type DifficultyName } from './sim/match';
import { Tournament, type Fixture } from './sim/tournament';
import { findTeam } from './data/loader';
import { GameRenderer } from './render/gameRenderer';
import type { TimeOfDay } from './render/scene';
import type { StadiumSize } from './render/stadium';
import { HUD } from './ui/hud';
import { Menu, type MenuResult } from './ui/menu';
import { TournamentUI } from './ui/tournamentUI';
import { AudioEngine } from './audio/audio';
import { MusicPlayer } from './audio/music';
import { SIM_DT } from './sim/constants';
import type { TeamData } from './data/types';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const hub = new InputHub();
const audio = new AudioEngine();
const music = new MusicPlayer();

let inMenus = true;
hub.onAnyButton = () => {
  audio.unlock();
  const ctx = audio.context();
  if (inMenus && ctx && !music.playing) music.start(ctx);
};

interface MatchConfig {
  home: TeamData;
  away: TeamData;
  seats: [PlayerInput | null, PlayerInput | null];
  halfLengthSec: number;
  difficulty: DifficultyName;
  timeOfDay: TimeOfDay;
  stadium: StadiumSize;
  knockout: boolean;
  mode: 'match' | 'shootout';
  /** what happens after full time on button press */
  onDone: ((m: Match) => void) | null; // null = default rematch/menu choice
}

let match: Match | null = null;
let renderer: GameRenderer | null = null;
let hudUI: HUD | null = null;
let currentConfig: MatchConfig | null = null;
let tournament: Tournament | null = null;
let accumulator = 0;
let lastTime = performance.now();
let rafId = 0;

function stopLoop(): void {
  cancelAnimationFrame(rafId);
  match = null;
  renderer = null;
  hudUI?.destroy();
  hudUI = null;
}

// ---------------------------------------------------------------- menus

function showMenu(): void {
  stopLoop();
  inMenus = true;
  const ctx = audio.context();
  if (ctx && !music.playing) music.start(ctx);
  new Menu(handleMenuResult, () => hub.connectedPads().length);
}

function handleMenuResult(r: MenuResult): void {
  switch (r.kind) {
    case 'kickoff':
    case 'versus':
    case 'shootout': {
      const seats = makeSeats(r.kind === 'versus');
      startMatch({
        home: r.home, away: r.away, seats,
        halfLengthSec: r.halfLengthSec, difficulty: r.difficulty,
        timeOfDay: r.timeOfDay, stadium: r.stadium,
        knockout: false,
        mode: r.kind === 'shootout' ? 'shootout' : 'match',
        onDone: null,
      });
      break;
    }
    case 'tournament-new':
      tournament = Tournament.create(
        r.teamId, r.difficulty, r.halfLengthSec, (Math.random() * 0xffffffff) >>> 0,
      );
      showTournamentHub();
      break;
    case 'tournament-continue':
      tournament = Tournament.load();
      if (tournament) showTournamentHub();
      else showMenu();
      break;
  }
}

function makeSeats(versus: boolean): [PlayerInput | null, PlayerInput | null] {
  if (!versus) return [hub.seat('merged'), null];
  const pads = hub.connectedPads();
  if (pads.length >= 2) return [hub.seat('pad', pads[0]), hub.seat('pad', pads[1])];
  return [hub.seat('keyboard'), hub.seat('pad', pads[0] ?? 0)];
}

// ---------------------------------------------------------------- tournament

function showTournamentHub(): void {
  stopLoop();
  inMenus = true;
  const ctx = audio.context();
  if (ctx && !music.playing) music.start(ctx);
  if (!tournament) { showMenu(); return; }
  const ui = new TournamentUI(
    tournament,
    (fixture) => playTournamentFixture(fixture),
    () => { tournament?.save(); showMenu(); },
  );
  ui.render();
}

/** Stage dressing: group games by day, knockout at dusk, showpiece at night. */
function stageDressing(stage: string): { tod: TimeOfDay; stadium: StadiumSize } {
  if (stage.startsWith('md')) return { tod: 'day', stadium: stage === 'md1' ? 'municipal' : 'national' };
  if (stage === 'r32' || stage === 'r16') return { tod: 'sunset', stadium: 'national' };
  if (stage === 'qf') return { tod: 'night', stadium: 'national' };
  return { tod: 'night', stadium: 'mega' };
}

function playTournamentFixture(fixture: Fixture): void {
  if (!tournament) return;
  const knockout = !fixture.stage.startsWith('md');
  const me = tournament.state.playerTeamId;
  const seats: [PlayerInput | null, PlayerInput | null] =
    fixture.homeId === me ? [hub.seat('merged'), null] : [null, hub.seat('merged')];
  const dress = stageDressing(fixture.stage);
  startMatch({
    home: findTeam(fixture.homeId),
    away: findTeam(fixture.awayId),
    seats,
    halfLengthSec: tournament.state.halfLengthSec,
    difficulty: tournament.state.difficulty,
    timeOfDay: dress.tod,
    stadium: dress.stadium,
    knockout,
    mode: 'match',
    onDone: (m) => {
      if (!tournament) { showMenu(); return; }
      const penWinnerId = m.shootoutWinner !== null
        ? m.teams[m.shootoutWinner].data.id
        : undefined;
      tournament.reportPlayerResult(m.teams[0].score, m.teams[1].score, penWinnerId);
      showTournamentHub();
    },
  });
}

// ---------------------------------------------------------------- match loop

function startMatch(config: MatchConfig): void {
  stopLoop();
  currentConfig = config;
  inMenus = false;
  music.stop();

  match = new Match({
    home: config.home,
    away: config.away,
    seats: config.seats,
    halfLengthSec: config.halfLengthSec,
    difficulty: config.difficulty,
    knockout: config.knockout,
    mode: config.mode,
    seed: (Math.random() * 0xffffffff) >>> 0,
  });

  renderer = new GameRenderer(canvas, match, config.timeOfDay, config.stadium);
  hudUI = new HUD(match);

  const m = match, r = renderer, h = hudUI;
  m.events.on((e) => {
    h.onEvent(e);
    audio.onEvent(e);
    r.onEvent(e);
  });
  m.ball.onBounce = (speed) => audio.onEvent({ type: 'bounce', speed });
  r.onReplayStateChange = (on) => h.setReplay(on);

  h.playWipe();
  accumulator = 0;
  lastTime = performance.now();
  rafId = requestAnimationFrame(loop);
  // debug hook for automated testing
  (window as unknown as Record<string, unknown>).__ss26 = { match: m, renderer: r, hub, tournament };
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  if (!match || !renderer || !hudUI) return;

  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  hub.pollGamepads();

  if (match.phase === 'break') {
    if (hub.anyPress(['pass'])) {
      hudUI.hideCard();
      hudUI.playWipe();
      match.continueFromBreak();
    }
  } else if (match.phase === 'fulltime') {
    if (currentConfig?.onDone) {
      if (hub.anyPress(['pass', 'loft'])) {
        const done = currentConfig.onDone;
        const m = match;
        hudUI.hideCard();
        done(m);
        return;
      }
    } else {
      if (hub.anyPress(['pass'])) {
        hudUI.hideCard();
        if (currentConfig) startMatch(currentConfig);
        return;
      }
      if (hub.anyPress(['loft'])) {
        showMenu();
        return;
      }
    }
  } else {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < 5) {
      match.update();
      renderer.snapshot();
      accumulator -= SIM_DT;
      steps++;
    }
    // slow machine: drop unpayable sim debt instead of spiraling
    if (accumulator > SIM_DT * 2) accumulator = SIM_DT * 2;
  }

  const alpha = Math.min(accumulator / SIM_DT, 1);
  renderer.update(frameDt, alpha);
  hudUI.update(frameDt, (x, y, z) => renderer!.screenPos(x, y, z));
  audio.update(frameDt);
}

showMenu();
