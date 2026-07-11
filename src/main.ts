// SUPER STRIKER '26 — boot, menu flow, tournament hub, and the fixed-timestep
// game loop (§8): sim at 60Hz, render interpolated, URL → kickoff in seconds.

import './ui/ui.css';
import { InputHub, type PlayerInput } from './input/input';
import { Match, type DifficultyName } from './sim/match';
import { Tournament, type Fixture } from './sim/tournament';
import { TEAMS, findTeam } from './data/loader';
import type { MatchEvent } from './sim/matchEvents';
import { GameRenderer } from './render/gameRenderer';
import type { TimeOfDay } from './render/scene';
import type { StadiumSize } from './render/stadium';
import { HUD } from './ui/hud';
import { Menu, type MenuResult } from './ui/menu';
import { TournamentUI } from './ui/tournamentUI';
import { AudioEngine } from './audio/audio';
import { MusicPlayer } from './audio/music';
import { Commentary } from './audio/commentary';
import { SIM_DT } from './sim/constants';
import type { TeamData } from './data/types';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const hub = new InputHub();
const audio = new AudioEngine();
const music = new MusicPlayer();
const commentary = new Commentary();

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
  mode: 'match' | 'shootout' | 'golden';
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

let paused = false;
let replayWatch = false; // user-triggered replay: sim frozen while it plays
let lastPhase = '';
let cardGraceUntil = 0;

function stopLoop(): void {
  cancelAnimationFrame(rafId);
  match = null;
  renderer?.dispose();
  renderer = null;
  hudUI?.destroy();
  hudUI = null;
  paused = false;
  replayWatch = false;
}

// ---------------------------------------------------------------- menus

function showMenu(): void {
  stopLoop();
  inMenus = true;
  commentary.stop();
  audio.setCrowd(false);
  const ctx = audio.context();
  if (ctx && !music.playing) music.start(ctx);
  startAttract();
  new Menu(handleMenuResult, () => hub.connectedPads().length);
}

function handleMenuResult(r: MenuResult): void {
  switch (r.kind) {
    case 'kickoff':
    case 'versus':
    case 'shootout':
    case 'golden': {
      // golden goal is a party mode: 2P when a pad is plugged in, else vs CPU
      const twoP = r.kind === 'versus' || (r.kind === 'golden' && hub.connectedPads().length > 0);
      const seats = makeSeats(twoP);
      startMatch({
        home: r.home, away: r.away, seats,
        halfLengthSec: r.halfLengthSec, difficulty: r.difficulty,
        timeOfDay: r.timeOfDay, stadium: r.stadium,
        knockout: false,
        mode: r.kind === 'shootout' ? 'shootout' : r.kind === 'golden' ? 'golden' : 'match',
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
  commentary.stop();
  audio.setCrowd(false);
  const ctx = audio.context();
  if (ctx && !music.playing) music.start(ctx);
  if (!attractMatch) startAttract();
  if (!tournament) { showMenu(); return; }
  const ui = new TournamentUI(
    tournament,
    (fixture) => playTournamentFixture(fixture),
    () => {
      // a finished run should not haunt the menu as CONTINUE TOURNAMENT
      if (tournament?.state.stage === 'done') Tournament.clear();
      else tournament?.save();
      showMenu();
    },
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
      tournament.reportPlayerResult(m.teams[0].score, m.teams[1].score, penWinnerId, m.goalLog);
      showTournamentHub();
    },
  });
}

// ---------------------------------------------------------------- attract mode

// A CPU-vs-CPU match plays behind the (now translucent) menus — the game is
// already on when you arrive, like the arcade classics.
let attractMatch: Match | null = null;
let attractRenderer: GameRenderer | null = null;
let attractRaf = 0;
let attractLast = 0;
let attractAcc = 0;

function startAttract(): void {
  stopAttract();
  const pool = TEAMS.filter((t) => t.tier >= 3);
  const home = pool[Math.floor(Math.random() * pool.length)];
  let away = home;
  while (away.id === home.id) away = pool[Math.floor(Math.random() * pool.length)];
  attractMatch = new Match({
    home, away, seats: [null, null],
    halfLengthSec: 90, difficulty: 'pro', knockout: false, mode: 'match',
    seed: (Math.random() * 0xffffffff) >>> 0,
  });
  attractRenderer = new GameRenderer(canvas, attractMatch,
    Math.random() < 0.5 ? 'night' : 'sunset', Math.random() < 0.5 ? 'national' : 'mega');
  attractLast = performance.now();
  attractAcc = 0;
  attractRaf = requestAnimationFrame(attractLoop);
  (window as unknown as Record<string, unknown>).__ss26Attract = { match: attractMatch };
}

function stopAttract(): void {
  cancelAnimationFrame(attractRaf);
  attractRenderer?.dispose();
  attractRenderer = null;
  attractMatch = null;
  (window as unknown as Record<string, unknown>).__ss26Attract = null;
}

function attractLoop(now: number): void {
  attractRaf = requestAnimationFrame(attractLoop);
  if (!attractMatch || !attractRenderer) return;
  const dt = Math.min((now - attractLast) / 1000, 0.25);
  attractLast = now;
  attractAcc += dt;
  let steps = 0;
  while (attractAcc >= SIM_DT && steps < 5) {
    attractMatch.update();
    if (attractMatch.phase === 'break') attractMatch.continueFromBreak();
    attractRenderer.snapshot();
    attractAcc -= SIM_DT;
    steps++;
  }
  if (attractAcc > SIM_DT * 2) attractAcc = SIM_DT * 2;
  if (attractMatch.phase === 'fulltime') {
    startAttract(); // new billing, new venue
    return;
  }
  attractRenderer.update(dt, Math.min(attractAcc / SIM_DT, 1));
}

// ---------------------------------------------------------------- rumble

/** Haptics: the pad speaks the language of the match (§5 feel). */
function rumbleFor(e: MatchEvent): void {
  switch (e.type) {
    case 'kick': hub.rumble(0, Math.min(0.1 + e.power * 0.35, 0.5), 60); break;
    case 'shot': hub.rumble(0.45, 0.3, 140); break;
    case 'tackle': hub.rumble(0.5, 0.2, 110); break;
    case 'post': hub.rumble(0.8, 0.4, 220); break;
    case 'goal': hub.rumble(1, 1, 550); break;
    case 'save': hub.rumble(0.4, 0.3, 130); break;
    case 'card': hub.rumble(0.3, 0.5, e.color === 'red' ? 350 : 180); break;
    case 'penaltyAwarded': hub.rumble(0.5, 0.5, 250); break;
    case 'penKick':
      hub.rumble(e.result === 'goal' ? 0.9 : 0.5, 0.5, e.result === 'goal' ? 450 : 200);
      break;
    case 'shootoutEnd': hub.rumble(1, 1, 700); break;
    case 'fulltime': hub.rumble(0.4, 0.6, 300); break;
    default: break;
  }
}

// ---------------------------------------------------------------- match loop

function startMatch(config: MatchConfig): void {
  stopLoop();
  stopAttract();
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
  hudUI.fulltimeHint = config.onDone ? 'PRESS J TO CONTINUE' : null;
  audio.setCrowd(true);
  commentary.refresh();
  hub.clearAll();
  paused = false;
  replayWatch = false;
  lastPhase = '';

  const m = match, r = renderer, h = hudUI;
  h.canReplayGoal = () => r.hasGoalClip();
  m.events.on((e) => {
    h.onEvent(e);
    audio.onEvent(e);
    r.onEvent(e);
    commentary.onEvent(e, m);
    rumbleFor(e);
  });
  m.ball.onBounce = (speed) => audio.onEvent({ type: 'bounce', speed });
  r.onReplayStateChange = (on, label) => h.setReplay(on, label);

  h.playWipe();
  accumulator = 0;
  lastTime = performance.now();
  rafId = requestAnimationFrame(loop);
  // debug hook for automated testing
  (window as unknown as Record<string, unknown>).__ss26 = {
    match: m, renderer: r, hub, tournament, isPaused: () => paused,
  };
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  if (!match || !renderer || !hudUI) return;

  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  hub.pollGamepads();

  // a whistle can land while a gameplay button edge is still buffered — clear
  // it on phase entry and give the card a beat on screen, or the half-time /
  // full-time card gets skipped by a press meant for the pitch
  if (match.phase !== lastPhase) {
    if (match.phase === 'break' || match.phase === 'fulltime') {
      hub.clearAll();
      cardGraceUntil = now + 700;
    }
    lastPhase = match.phase;
  }

  if (replayWatch) {
    // user replay: sim stays frozen; any button cuts it short
    if (hub.anyPress(['pass', 'loft', 'shoot', 'pause', 'replay'])) {
      renderer.stopManualReplay();
    }
    if (!renderer.isReplaying()) {
      replayWatch = false;
      hub.clearAll();
      hudUI.playWipe();
      if (match.phase === 'fulltime') {
        hudUI.showFulltimeCard();
        cardGraceUntil = now + 700;
      }
    }
  } else if (match.phase === 'break') {
    if (now >= cardGraceUntil && hub.anyPress(['pass'])) {
      hudUI.hideCard();
      hudUI.playWipe();
      match.continueFromBreak();
    }
  } else if (match.phase === 'fulltime') {
    if (now >= cardGraceUntil) {
      if (hub.anyPress(['shoot']) && renderer.hasGoalClip()) {
        // watch the goal again from the full-time card
        hudUI.hideCard();
        if (renderer.startManualReplay('goal')) {
          replayWatch = true;
          hudUI.playWipe();
          hub.clearAll();
        } else {
          hudUI.showFulltimeCard();
        }
        return;
      }
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
    }
  } else if (paused) {
    if (hub.anyPress(['pass', 'pause'])) {
      paused = false;
      hudUI.hideCard();
      hub.clearAll();
    } else if (hub.anyPress(['loft'])) {
      if (currentConfig?.onDone && tournament) showTournamentHub();
      else showMenu();
      return;
    }
  } else {
    // UI-length window: the press must survive to the next frame even on a
    // machine that hitches (gameplay never consumes the pause action)
    if (hub.anyPress(['pause'])) {
      paused = true;
      hudUI.showPauseCard();
      hub.clearAll();
    } else if ((match.phase === 'play' || match.phase === 'restart')
      && hub.anyPress(['replay'], 2000)
      && renderer.startManualReplay('live')) {
      // on-demand instant replay of the last few seconds (short press window:
      // a stale buffered press must not yank us out of live play)
      replayWatch = true;
      hudUI.playWipe();
      hub.clearAll();
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
  }

  const alpha = Math.min(accumulator / SIM_DT, 1);
  renderer.update(frameDt, alpha);
  hudUI.update(frameDt, (x, y, z) => renderer!.screenPos(x, y, z));
  audio.update(frameDt);
}

showMenu();
