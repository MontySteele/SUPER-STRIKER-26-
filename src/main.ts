// SUPER STRIKER '26 — boot, menu flow, and the fixed-timestep game loop (§8):
// sim at 60Hz, render interpolated, URL → kickoff in seconds.

import './ui/ui.css';
import { InputSystem } from './input/input';
import { Match } from './sim/match';
import { GameRenderer } from './render/gameRenderer';
import { HUD } from './ui/hud';
import { Menu, type MatchSetup } from './ui/menu';
import { AudioEngine } from './audio/audio';
import { SIM_DT } from './sim/constants';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const input = new InputSystem();
const audio = new AudioEngine();
input.onAnyButton = () => audio.unlock();

let match: Match | null = null;
let renderer: GameRenderer | null = null;
let hud: HUD | null = null;
let lastSetup: MatchSetup | null = null;
let accumulator = 0;
let lastTime = performance.now();
let rafId = 0;

function showMenu(): void {
  cancelAnimationFrame(rafId);
  match = null;
  renderer = null;
  hud?.destroy();
  hud = null;
  new Menu((setup) => startMatch(setup));
}

function startMatch(setup: MatchSetup): void {
  lastSetup = setup;
  match = new Match({
    home: setup.home,
    away: setup.away,
    humanTeamIdx: 0,
    halfLengthSec: setup.halfLengthSec,
    difficulty: setup.difficulty,
    seed: (Math.random() * 0xffffffff) >>> 0,
  }, input);

  renderer = new GameRenderer(canvas, match, setup.timeOfDay);
  hud = new HUD(match, input);

  const m = match, r = renderer, h = hud;
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
  (window as unknown as Record<string, unknown>).__ss26 = { match: m, renderer: r };
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  if (!match || !renderer || !hud) return;

  const frameDt = Math.min((now - lastTime) / 1000, 0.25); // clamp tab-switch spikes
  lastTime = now;

  input.pollGamepad();

  // halftime / fulltime cards pause the sim and wait for input
  if (match.phase === 'halftime') {
    if (input.consumePress('pass', 5000)) {
      hud.hideCard();
      hud.playWipe();
      match.startSecondHalf();
    }
  } else if (match.phase === 'fulltime') {
    if (input.consumePress('pass', 5000)) {
      // rematch, same setup
      hud.hideCard();
      if (lastSetup) startMatch(lastSetup);
      return;
    }
    if (input.consumePress('loft', 5000)) {
      showMenu();
      return;
    }
  } else {
    accumulator += frameDt;
    // fixed 60Hz sim, render interpolated between the last two states
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
  hud.update(frameDt, (x, y, z) => renderer!.screenPos(x, y, z));
  audio.update(frameDt);
}

showMenu();
