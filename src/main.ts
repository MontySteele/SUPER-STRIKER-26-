// SUPER STRIKER '26 — boot, menu flow, tournament hub, and the fixed-timestep
// game loop (§8): sim at 60Hz, render interpolated, URL → kickoff in seconds.

import './ui/ui.css';
import { InputHub, type PlayerInput, type RumbleCue } from './input/input';
import { GuestHost } from './net/hostLink';
import { seatHealth } from './net/health';
import { Lobby, readableOn, type SlotAssignment, type SlotDevice } from './ui/lobby';
import { resolvedShirts } from './render/playerMesh';
import { Match, SEAT_SLOTS, type DifficultyName } from './sim/match';
import { Tournament, type Fixture } from './sim/tournament';
import { TEAMS, findTeam } from './data/loader';
import type { MatchEvent } from './sim/matchEvents';
import { GameRenderer, skinnedPlayersWanted } from './render/gameRenderer';
import { Presentation, walkoutWanted } from './present/director';
import { preloadCharacters } from './render/characterAssets';
import type { TimeOfDay } from './render/scene';
import type { StadiumSize } from './render/stadium';
import { HUD } from './ui/hud';
import type { CameraCutSource } from './ui/broadcast';
import { Menu, type MenuResult } from './ui/menu';
import { hidePauseOverlay, showPauseOverlay } from './ui/menuPause';
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
// the audio engine is the commentary engine's host: it owns the context, the
// voice bus and the crowd duck
const commentary = new Commentary(audio);
// always-on audio hook: pipeline/audio/smoke.mjs checks the voice pack and the
// stingers from the menu, long before any match publishes `__ss26`
(window as unknown as Record<string, unknown>).__ss26audio = { audio, commentary };

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

// §7A.7: the graphics level is baked into the renderer at construction, so the
// attract match behind the menu has to be rebuilt to show the new one. Only
// while in the menus — nobody changes this mid-match.
window.addEventListener('ss26-quality-change', () => {
  if (inMenus && attractMatch) startAttract();
});

// The front end runs its own small three.js scene behind the menus (§7.1's
// depth-of-field player backdrop), so the CPU-vs-CPU attract match sleeps while
// that is on screen and comes back for everything else (tournament hub, lobby,
// roster editor). Menu.destroy() fires the resume asynchronously, which is why
// a menu that is tearing down INTO a match never rebuilds one just to drop it.
let attractSuspended = false;
window.addEventListener('ss26-attract-suspend', () => {
  attractSuspended = true;
  if (attractMatch) stopAttract();
});
window.addEventListener('ss26-attract-resume', () => {
  attractSuspended = false;
  if (inMenus && !attractMatch) startAttract();
});

hub.onAnyButton = () => {
  audio.unlock();
  applyMusic();
};

// §5.4 hot-plug. In the menus a new pad just shows up (Menu and Lobby both
// listen for gamepadconnected and re-render, so it can take a seat straight
// away). Mid-match a yanked pad is a dropout: its shirt would stand still, so
// hold the game on the pause card exactly as Esc would — the same treatment
// the §5.4.5 ladder gives a guest who vanishes.
hub.onPadDisconnected = (index) => {
  hub.stopRumble();
  if (inMenus || !match || !hudUI || paused || netHold) return;
  const seated = baseSeats.some((s) => s?.kind === 'pad' && s.padIndex === index);
  if (!seated) return;
  paused = true;
  hudUI.showPauseCard();
  paintPause('GAMEPAD DISCONNECTED');
  hub.clearAll();
};

/** The MenuResult variants that carry a full match configuration. */
type MatchMenuResult = Extract<MenuResult, { home: TeamData }>;

interface MatchConfig {
  home: TeamData;
  away: TeamData;
  /** by seat slot: [team0, team1, team0 partner, team1 partner] (§5.4.6) */
  seats: (PlayerInput | null)[];
  halfLengthSec: number;
  difficulty: DifficultyName;
  timeOfDay: TimeOfDay;
  stadium: StadiumSize;
  knockout: boolean;
  mode: 'match' | 'shootout' | 'golden';
  /** what happens after full time on button press */
  onDone: ((m: Match) => void) | null; // null = default rematch/menu choice
  /** seat slot → remote guest id, for the §5.4.5 disconnect ladder */
  guestSlots?: Map<number, number>;
}

let match: Match | null = null;
let renderer: GameRenderer | null = null;
let hudUI: HUD | null = null;
/** §7 scripted scenes: walkout, goal celebration, the walk off at the whistle. */
let presentation: Presentation | null = null;
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
let baseSeats: (PlayerInput | null)[] = [null, null, null, null];
/** Seat slots currently driven by the AI because their guest went away. */
const seatOnAI = [false, false, false, false];
/** Human is back but the ball is live — hand over at the next dead ball. */
const seatHandback = [false, false, false, false];
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
    paintPause('GRAPHICS CONTEXT LOST');
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

/** The front-end pause screen (src/ui/menuPause.ts) over the HUD's own card. */
function paintPause(reason?: string): void {
  showPauseOverlay({
    home: currentConfig?.home.name,
    away: currentConfig?.away.name,
    homeColor: currentConfig?.home.kit.home,
    awayColor: currentConfig?.away.kit.home,
    quitTo: currentConfig?.onDone && tournament ? 'TOURNAMENT HUB' : 'MAIN MENU',
    reason,
  });
}

function stopLoop(): void {
  cancelAnimationFrame(rafId);
  hidePauseOverlay();
  match = null;
  presentation?.dispose();   // unhook before the renderer it points at dies
  presentation = null;
  renderer?.dispose();
  renderer = null;
  hudUI?.destroy();
  hudUI = null;
  paused = false;
  replayWatch = false;
  // §5.4: no seats, no haptics — a motor must never be left running into the menus
  hub.stopRumble();
  hub.clearSeatPads();
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
      const players = r.kind === 'versus' && r.versus2v2 === true ? 4
        : r.kind === 'versus' || (r.kind === 'golden' && r.golden2p === true) ? 2 : 1;
      const seats = makeSeats(players);
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

/** Seat `players` humans on the couch, slot order: P1, P2, P3, P4. */
function makeSeats(players: 1 | 2 | 4): (PlayerInput | null)[] {
  const out: (PlayerInput | null)[] = new Array<PlayerInput | null>(SEAT_SLOTS).fill(null);
  // 1P: merged seat already unions keyboard + pads + remote guests
  if (players === 1) { out[0] = hub.seat('merged'); return out; }
  // pads first, then guests; the keyboard only takes a seat when there aren't
  // enough sticks to go round (two pads means pad-vs-pad, as it always did)
  const devs: PlayerInput[] = [
    ...hub.connectedPads().map((i) => hub.seat('pad', i)),
    ...hub.connectedRemotes().map((i) => hub.seat('remote', i)),
  ];
  if (devs.length < players) devs.unshift(hub.seat('keyboard'));
  for (let i = 0; i < players; i++) out[i] = devs[i] ?? hub.seat('pad', i);
  return out;
}

// ------------------------------------------------------- remote 1v1 / 2v2

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
  try {
    host.open();
  } catch (err) {
    // PeerJS can throw synchronously (no network, blocked WebRTC); the local
    // lobby must still come up so pads can be seated
    console.warn('[lobby] guest host failed to open', err);
  }

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
  baseSeats = [null, null, null, null];
  (window as unknown as Record<string, unknown>).__ss26Net = null;
}

function seatForDevice(d: SlotDevice): PlayerInput {
  if (d.kind === 'pad') return hub.seat('pad', d.index);
  if (d.kind === 'guest') return hub.seat('remote', d.id);
  return hub.seat('keyboard');
}

function startRemoteMatch(r: MatchMenuResult, slots: SlotAssignment): void {
  lobby = null; // the lobby destroyed itself before handing us the seating
  const seats: (PlayerInput | null)[] = new Array<PlayerInput | null>(SEAT_SLOTS).fill(null);
  const map = new Map<number, number>();
  for (let i = 0; i < SEAT_SLOTS; i++) {
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
      // slots alternate sides: P1/P3 are home, P2/P4 away (§5.4.6)
      const side = slot & 1;
      const team = side === 0 ? r.home : r.away;
      return {
        teamName: team.name, teamCode: team.code,
        shirt: shirts[side], text: readableOn(shirts[side]),
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
      // any missing human holds the match, partner slots included: in a 2v2 a
      // side playing 2v1 for five seconds is exactly as unfair as one playing
      // with no human at all, and everyone is watching one screen anyway
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
  const seats: (PlayerInput | null)[] =
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
  if (attractSuspended) return; // the front end's own 3D backdrop has the screen
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
    // §7.2 pre-match: open behind the menu on the stadium beauty crane and
    // only then hand the rig to the live package
    r.openOnBeauty(8);
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

/**
 * A cue felt only by the pads holding one side's shirts (§5.4.6). In 1P the
 * seats are 'merged', so every pad is on every seat and this is the same as
 * cueing the room — which is right: there is only one player.
 */
function cueSide(teamIdx: number, name: RumbleCue, scale = 1): void {
  for (let slot = teamIdx; slot < SEAT_SLOTS; slot += 2) hub.cueSeat(slot, name, scale);
}

/** Haptics: the pad speaks the language of the match (§5 feel). */
function rumbleFor(e: MatchEvent): void {
  switch (e.type) {
    // the ball leaving a boot is felt by whoever is holding it; the sim does
    // not say whose, so this one stays a room-wide thump
    case 'kick':
      hub.cue(e.power > 0.66 ? 'kickHeavy' : e.power > 0.33 ? 'kickMedium' : 'kickLight');
      break;
    case 'shot': cueSide(e.teamIdx, 'kickHeavy'); break;
    case 'tackle': hub.cue('tackle'); break;
    case 'switch': hub.cueSeat(e.slot, 'switch'); break;
    case 'post': hub.cue('post'); break;
    case 'goal': hub.cue('goal'); break;
    case 'save': cueSide(e.teamIdx, 'save'); break;
    case 'card': cueSide(e.teamIdx, 'card', e.color === 'red' ? 1.3 : 1); break;
    case 'foul': hub.cue('whistle', undefined, 0.6); break;
    case 'penaltyAwarded': hub.cue('whistle'); break;
    case 'penKick': hub.cue(e.result === 'goal' ? 'goal' : 'save'); break;
    case 'shootoutEnd': hub.cue('goal'); break;
    case 'fulltime': hub.cue('whistle'); break;
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
  baseSeats = [];
  for (let s = 0; s < SEAT_SLOTS; s++) {
    baseSeats.push(config.seats[s] ?? null);
    seatOnAI[s] = false;
    seatHandback[s] = false;
  }
  // §5.4: tell the hub which pad sits in which seat, so a card shown to the
  // away side buzzes the away pad and nobody else's
  hub.registerSeatPads(baseSeats);
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
  // §7 presentation. A shootout has no walkout (there is no match to walk out
  // for), and `?walkout=0` turns it off for anyone who has seen it enough.
  presentation = new Presentation(renderer, match, {
    walkout: walkoutWanted(config.mode !== 'shootout'),
    // audio's stinger hook is optional and may not exist in this build yet
    stinger: (name) => (audio as unknown as {
      stinger?: (n: string) => void }).stinger?.(name),
  });
  audio.setCrowd(true);
  // the stands belong to the home side, and the match tells the commentary
  // engine which two squads' name clips to pull
  audio.setHomeTeam(0);
  commentary.refresh(match);
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
  // Camera director → broadcast wipes: every hard cut the director makes gets
  // a 0.6s wipe laid over it, and the package stops firing its own event-driven
  // wipes the moment this callback speaks, so a dead ball never wipes twice.
  (r as CameraCutSource).onCut = (kind) => h.onCameraCut(kind);
  // and the package's own audio cues ('whoosh' under a wipe, 'goal' under the
  // banner, 'cardSting', 'replayIn'/'replayOut') — guarded inside the package
  h.bc.stinger = (name) => audio.stinger(name);
  // the line-up graphic belongs over the walkout; with no walkout the package
  // falls back to showing it for 5s on the first kickoff event
  if (walkoutWanted()) h.showLineups(0);

  h.playWipe();
  accumulator = 0;
  lastTime = performance.now();
  rafId = requestAnimationFrame(loop);
  // debug hook for automated testing
  (window as unknown as Record<string, unknown>).__ss26 = {
    match: m, renderer: r, hub, tournament, music, isPaused: () => paused,
    // audio + commentary for pipeline/audio/smoke.mjs (stingers, ducking, and
    // `commentary.log`, the last 64 lines actually spoken)
    audio, commentary,
  };
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  if (!match || !renderer || !hudUI) return;

  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  hub.pollGamepads();
  updateGuestHealth();

  // §7 presentation, polled every frame so it sees every phase change whatever
  // branch below we end up in. Only the pre-match walkout asks the sim to wait
  // for it — the celebration and the walk-offs run under phases the sim
  // already spends standing still.
  const holdForScene = presentation?.frame() ?? false;

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
      hidePauseOverlay();
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
      paintPause();
      hub.clearAll();
    } else if (holdForScene) {
      // the pre-match walkout owns the pitch and the sim waits at kickoff for
      // it; any gameplay button cuts it short, under the usual wipe
      if (hub.anyPress(['pass', 'loft', 'shoot', 'through', 'replay'])) {
        presentation?.skip();
        hudUI.playWipe();
        hub.clearAll();
      }
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
  commentary.update(frozen ? 0 : frameDt); // ...and no commentary over it either
}

// ------------------------------------------------------------ capture mode
// §7A.9: `?capture=<shot>` boots straight into a deterministic still and stops.
// It deliberately bypasses everything above — no menus, no attract match, no
// audio, and no roster overrides (localStorage is not reproducible). The module
// is loaded on demand so normal players never download the harness.
// `?broadcast=<shot>` is the same idea for the TV package (§7.1): one graphic
// of the broadcast kit driven into its settled state over a seeded match and
// frozen for a screenshot. Separate module, separate shot list — a UI tweak
// must never invalidate a lighting baseline.
const captureShot = new URLSearchParams(location.search).get('capture');
const tvShot = new URLSearchParams(location.search).get('broadcast');
if (tvShot) {
  inMenus = false;
  void import('./ui/broadcastShots').then((m) => m.runBroadcastShot(canvas, tvShot));
} else if (captureShot) {
  inMenus = false;
  void import('./tools/capture').then((m) => m.runCapture(canvas, captureShot));
} else {
  // §7A.2 skinned players: ~10MB of glTF, so it is fetched in the background
  // while the menu is already up rather than held in front of the boot. The
  // renderer falls back to the capsule path for anything built before this
  // lands, which is why the attract match gets restarted when it does.
  if (skinnedPlayersWanted()) {
    void preloadCharacters().then(() => {
      if (inMenus) startAttract();
    }).catch(() => { /* preloadCharacters already logged it */ });
  }
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
