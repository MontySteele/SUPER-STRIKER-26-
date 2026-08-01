// SUPER STRIKER '26 — boot, menu flow, tournament hub, and the fixed-timestep
// game loop (§8): sim at 60Hz, render interpolated, URL → kickoff in seconds.

import './ui/ui.css';
import { InputHub, type PlayerInput } from './input/input';
import { GuestHost } from './net/hostLink';
import { seatHealth } from './net/health';
import { Lobby, readableOn, type SlotAssignment, type SlotDevice } from './ui/lobby';
import { resolvedShirts } from './render/playerMesh';
import { Match, type DifficultyName } from './sim/match';
import { Tournament, type Fixture } from './sim/tournament';
import { TEAMS, findTeam } from './data/loader';
import type { MatchEvent } from './sim/matchEvents';
import { GameRenderer } from './render/gameRenderer';
import type { TimeOfDay } from './render/scene';
import type { StadiumSize } from './render/stadium';
import { HUD } from './ui/hud';
import { Menu, type MenuResult } from './ui/menu';
import { RosterEditor } from './ui/rosterEditor';
import { applyRosterOverrides } from './data/roster';
import { TournamentUI } from './ui/tournamentUI';
import { AudioEngine } from './audio/audio';
import { MusicPlayer, musicSetting } from './audio/music';
import { Commentary } from './audio/commentary';
import { SIM_DT } from './sim/constants';
import type { TeamData } from './data/types';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const hub = new InputHub();
const audio = new AudioEngine();
const music = new MusicPlayer();
const commentary = new Commentary();

let inMenus = true;

/** Idempotent: start/stop/switch the right track for where we are. */
function applyMusic(): void {
  const ctx = audio.context();
  const s = musicSetting();
  const want = s === 'off' ? null : inMenus ? 'menu' : s === 'all' ? 'match' : null;
  if (!want || !ctx) { music.stop(); return; }
  music.start(ctx, want);
}
// the menu settings row toggles the persisted value, then pokes us
window.addEventListener('ss26-music-change', applyMusic);

hub.onAnyButton = () => {
  audio.unlock();
  applyMusic();
};

/** The MenuResult variants that carry a full match configuration. */
type MatchMenuResult = Extract<MenuResult, { home: TeamData }>;

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
  /** seat index → remote guest id, for the §5.4.5 disconnect ladder */
  guestSlots?: Map<number, number>;
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

// --------------------------------------------------------- remote guests (§5.4)
// The lobby's peer stays alive for the whole remote session: a guest who drops
// out mid-match rejoins on the same room code, into the same seat.
let guestHost: GuestHost | null = null;
let lobby: Lobby | null = null;
/** Seats the guests are sitting in, and the seat objects to hand back to. */
let guestSlots = new Map<number, number>();
let baseSeats: [PlayerInput | null, PlayerInput | null] = [null, null];
/** Seat currently driven by the AI because its guest went away. */
const seatOnAI = [false, false];
/** Human is back but the ball is live — hand over at the next dead ball. */
const seatHandback = [false, false];
let netHold: string | null = null;

// ------------------------------------------------------------ WebGL safety
// GPU resets are real (driver hiccups, sleep/wake, iGPU pressure). Without
// these guards a lost context was either an invisible zombie match or an
// uncaught TypeError and a permanently black page.
let glLost = false;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); // let the browser attempt a restore
  glLost = true;
  // only force-pause live phases — break/fulltime cards already hold the sim,
  // and overwriting their card with PAUSED wedged the loop's branch order
  const live = match && (match.phase === 'play' || match.phase === 'restart'
    || match.phase === 'kickoff' || match.phase === 'goalseq'
    || match.phase === 'penalty' || match.phase === 'shootout');
  if (live && !paused) {
    paused = true;
    hudUI?.showPauseCard();
    hub.clearAll(); // a stale buffered press must not instantly resume
  }
});
canvas.addEventListener('webglcontextrestored', () => {
  glLost = false;
  // bring the show back: a loss that killed the attract match otherwise
  // leaves the menus floating over a black canvas
  if (inMenus && !attractMatch) startAttract();
});

/** Last-resort plain-DOM message when the renderer can't exist at all. */
function showFatal(html: string): void {
  const root = document.getElementById('ui-root');
  if (!root) return;
  root.innerHTML = `
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:#06090d;color:#e8ecf4;font-family:inherit;text-align:center;pointer-events:auto">
      <div style="max-width:520px;padding:32px">
        <div style="font-size:30px;font-weight:900;font-style:italic;letter-spacing:0.08em;margin-bottom:14px">
          SUPER STRIKER '26</div>
        <div style="font-size:15px;line-height:1.6;color:#9aa3b5">${html}</div>
      </div>
    </div>`;
}

function stopLoop(): void {
  cancelAnimationFrame(rafId);
  match = null;
  renderer?.dispose();
  renderer = null;
  hudUI?.destroy();
  hudUI = null;
  paused = false;
  replayWatch = false;
  // don't pin the disposed renderer/scene in memory while idling in menus
  (window as unknown as Record<string, unknown>).__ss26 = null;
}

// ---------------------------------------------------------------- menus

function showMenu(): void {
  stopLoop();
  closeLobby(); // back at the menu = the room code is dead (§5.4.2)
  inMenus = true;
  commentary.stop();
  audio.setCrowd(false);
  applyMusic();
  // menu first: it must exist even when the attract renderer can't
  new Menu(handleMenuResult, () => hub.connectedPads().length + hub.connectedRemotes().length);
  if (!attractMatch) startAttract(); // editor exit: don't restart the show
}

function handleMenuResult(r: MenuResult): void {
  switch (r.kind) {
    case 'online':
      showLobby(r);
      break;
    case 'kickoff':
    case 'versus':
    case 'shootout':
    case 'golden': {
      // golden goal 2P is opt-in via its PLAYERS setting — auto-seating any
      // plugged-in pad/guest left the away team frozen when nobody was holding it
      const twoP = r.kind === 'versus' || (r.kind === 'golden' && r.golden2p === true);
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
    case 'editor':
      new RosterEditor(() => showMenu());
      break;
  }
}

function makeSeats(versus: boolean): [PlayerInput | null, PlayerInput | null] {
  // 1P: merged seat already unions keyboard + pads + remote guests
  if (!versus) return [hub.seat('merged'), null];
  // 2P: pads first, then guests, keyboard fills the last empty seat
  const devs: PlayerInput[] = [
    ...hub.connectedPads().map((i) => hub.seat('pad', i)),
    ...hub.connectedRemotes().map((i) => hub.seat('remote', i)),
  ];
  if (devs.length >= 2) return [devs[0], devs[1]];
  if (devs.length === 1) return [hub.seat('keyboard'), devs[0]];
  return [hub.seat('keyboard'), hub.seat('pad', 0)];
}

// ---------------------------------------------------------------- remote 1v1

/** INVITE PLAYERS: open a room, seat the guests, kick off (§5.4.2). */
function showLobby(r: MatchMenuResult): void {
  stopLoop();
  inMenus = true;
  commentary.stop();
  audio.setCrowd(false);
  applyMusic();
  if (!attractMatch) startAttract();

  // a fresh code every time the lobby opens, and it dies when we leave
  closeLobby();
  const host = new GuestHost(hub);
  guestHost = host;
  host.open();

  const shirts = resolvedShirts(r.home.kit, r.away.kit);
  lobby = new Lobby(
    host, [r.home, r.away],
    (slots) => startRemoteMatch(r, slots),
    () => showMenu(),
  );
  lobby.shirts = shirts;
  lobby.refresh();
  // debug hook for automated testing, same shape as __ss26 / __ss26Attract
  (window as unknown as Record<string, unknown>).__ss26Net = { guestHost: host, hub };
}

function closeLobby(): void {
  lobby?.destroy();
  lobby = null;
  guestHost?.close();
  guestHost = null;
  guestSlots = new Map();
  baseSeats = [null, null];
  (window as unknown as Record<string, unknown>).__ss26Net = null;
}

function seatForDevice(d: SlotDevice): PlayerInput {
  if (d.kind === 'pad') return hub.seat('pad', d.index);
  if (d.kind === 'guest') return hub.seat('remote', d.id);
  return hub.seat('keyboard');
}

function startRemoteMatch(r: MatchMenuResult, slots: SlotAssignment): void {
  lobby = null; // the lobby destroyed itself before handing us the seating
  const seats: [PlayerInput | null, PlayerInput | null] = [null, null];
  const map = new Map<number, number>();
  for (let i = 0; i < 2; i++) {
    const d = slots[i];
    if (!d) continue;
    seats[i] = seatForDevice(d);
    if (d.kind === 'guest') map.set(i, d.id);
  }
  const shirts = resolvedShirts(r.home.kit, r.away.kit);
  if (guestHost) {
    guestHost.phase = 'match';
    guestHost.note = null;
    guestHost.describeSlot = (slot) => {
      const team = slot === 0 ? r.home : r.away;
      return {
        teamName: team.name, teamCode: team.code,
        shirt: shirts[slot], text: readableOn(shirts[slot]),
      };
    };
    guestHost.broadcast();
  }
  startMatch({
    home: r.home, away: r.away, seats,
    halfLengthSec: r.halfLengthSec, difficulty: r.difficulty,
    timeOfDay: r.timeOfDay, stadium: r.stadium,
    knockout: false, mode: 'match', onDone: null,
    guestSlots: map,
  });
}

// --------------------------------------------------- guest health ladder (§5.4.5)

function updateGuestHealth(): void {
  if (!match || !hudUI || !guestHost || guestSlots.size === 0) return;
  const now = performance.now();
  let hold: string | null = null;

  for (const [slot, id] of guestSlots) {
    const state = seatHealth(guestHost.packetAge(id, now));
    const who = `P${slot + 1}`;

    if (state === 'gone' && !seatOnAI[slot]) {
      // the friend isn't coming back this minute — play on, CPU takes the side
      seatOnAI[slot] = true;
      seatHandback[slot] = false;
      match.setSeat(slot, null);
      // a held button frozen at the moment of the dropout must not fire the
      // instant the guest is seated again — same treatment as a yanked pad
      hub.remote(id).neutralize();
      hudUI.netFlash(`${who} DISCONNECTED — AI TAKES OVER`, 4);
    } else if (state === 'lost' && !seatOnAI[slot]) {
      hold = `${who} RECONNECTING… · K TO ABANDON`;
    }

    if (seatOnAI[slot] && state === 'ok') {
      // human's back: hand the shirt over at the next dead ball, so nobody
      // inherits a half-finished run at the near post
      seatHandback[slot] = true;
    }
    if (seatHandback[slot] && match.phase !== 'play') {
      seatOnAI[slot] = false;
      seatHandback[slot] = false;
      match.setSeat(slot, baseSeats[slot]);
      hudUI.netFlash(`${who} IS BACK`, 3);
    }

    hudUI.setSeatNet(slot,
      seatOnAI[slot] ? 'ai' : state === 'ok' ? 'ok' : state === 'degraded' ? 'degraded' : 'lost');
  }

  if (hold !== netHold) {
    // entering the hold: drop buffered presses so the restart isn't a shot
    if (hold && !netHold) hub.clearAll();
    netHold = hold;
    hudUI.setNetHold(hold);
    if (guestHost) {
      guestHost.note = hold;
      guestHost.broadcast();
    }
  }
}

// ---------------------------------------------------------------- tournament

function showTournamentHub(): void {
  stopLoop();
  inMenus = true;
  commentary.stop();
  audio.setCrowd(false);
  applyMusic();
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
  if (glLost) return; // no renderer while the context is down
  try {
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
    // the renderer needs the events or attract goals are 12s of statues —
    // wired, they get the full celebration + two-angle replay show
    const m = attractMatch, r = attractRenderer;
    m.events.on((e) => r.onEvent(e));
    attractLast = performance.now();
    attractAcc = 0;
    attractRaf = requestAnimationFrame(attractLoop);
    (window as unknown as Record<string, unknown>).__ss26Attract = {
      match: attractMatch, renderer: attractRenderer,
    };
  } catch (err) {
    // menus work fine without the show — never let the attract match take
    // the whole game down with it
    console.error('attract mode unavailable:', err);
    stopAttract();
  }
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
    case 'switch': hub.rumble(0, 0.2, 40); break;
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
  applyMusic(); // 'match' groove under the crowd, or silence if set to MENUS/OFF

  // a rematch re-seats the same guests from scratch: nobody starts on the AI
  guestSlots = config.guestSlots ?? new Map();
  baseSeats = [config.seats[0], config.seats[1]];
  seatOnAI[0] = seatOnAI[1] = false;
  seatHandback[0] = seatHandback[1] = false;
  netHold = null;

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

  // never construct three.js on a lost context: the constructor throws AFTER
  // registering canvas listeners, and each orphaned pair throws uncaught on
  // the eventual restore
  if (glLost) {
    match = null;
    showFatal(`The graphics context was lost (or WebGL2 is unavailable).<br>
      Enable hardware acceleration and reload the page (F5).`);
    return;
  }
  try {
    renderer = new GameRenderer(canvas, match, config.timeOfDay, config.stadium);
  } catch (err) {
    console.error('renderer construction failed:', err);
    match = null;
    showFatal(`The graphics context was lost (or WebGL2 is unavailable).<br>
      Enable hardware acceleration and reload the page (F5).`);
    return;
  }
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
    match: m, renderer: r, hub, tournament, music, isPaused: () => paused,
  };
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  if (!match || !renderer || !hudUI) return;

  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  hub.pollGamepads();
  updateGuestHealth();

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
      // drop anything else buffered during the card — a stale Esc press
      // otherwise pauses the game the moment the next period kicks off
      hub.clearAll();
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
  } else if (netHold) {
    // §5.4.5: the match waits for a missing guest. Not the pause card — this
    // isn't the local player's doing and they can't press their way out of it;
    // the only choice offered is to abandon.
    if (hub.anyPress(['loft'])) {
      showMenu();
      return;
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
  // dt 0 while paused: the goal-sequence replay and letterbox must not play
  // out underneath the PAUSED card (or a reconnect hold)
  const frozen = paused || netHold !== null;
  renderer.update(frozen ? 0 : frameDt, alpha);
  hudUI.update(frameDt, (x, y, z) => renderer!.screenPos(x, y, z));
  audio.update(frozen ? 0 : frameDt); // no terrace claps over the PAUSED card
}

// ------------------------------------------------------------ capture mode
// §7A.9: `?capture=<shot>` boots straight into a deterministic still and stops.
// It deliberately bypasses everything above — no menus, no attract match, no
// audio, and no roster overrides (localStorage is not reproducible). The module
// is loaded on demand so normal players never download the harness.
const captureShot = new URLSearchParams(location.search).get('capture');
if (captureShot) {
  inMenus = false;
  void import('./tools/capture').then((m) => m.runCapture(canvas, captureShot));
} else {
  try {
    applyRosterOverrides();
    showMenu();
  } catch (err) {
    // no WebGL2 (hardware acceleration off, blocklisted GPU, remote desktop):
    // without this catch the page is a silent black rectangle
    console.error('boot failed:', err);
    showFatal(`This game needs <b>WebGL2</b>.<br>
      Enable hardware acceleration in your browser settings (or try another
      browser), then reload the page.`);
  }
}
