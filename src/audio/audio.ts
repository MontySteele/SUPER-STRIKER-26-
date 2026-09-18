// Audio (§7.3): the crowd IS the commentator.
//
// Two stacked systems, and either can carry the game alone:
//
//   1. A sampled stadium bed baked from CC0 recordings
//      (pipeline/audio/bake_crowd.py -> public/audio/crowd.json). Murmur,
//      anticipation, roar, eruption, groan, applause and a terrace chant, all
//      mono 24 kHz Opus, ~340 KB for the lot.
//   2. The original fully synthesized crowd and SFX, which is what you hear
//      until the samples finish decoding — and forever, if the bake was never
//      run or the assets were gitignored out of the clone.
//
// Every SFX (whistles, kicks, the sacred DOINK, net swish, tackles, stingers)
// is still synthesized: they need to be tight, varied and sample-accurate, and
// synthesis gives all three for nothing.
//
// Mix topology (§7.3 volume faders in brackets):
//     crowd layers -> crowdBus -> crowdDuck -> duck ---\
//     sfx / stingers ------------------------> sfxBus [CROWD & SFX] --\
//     commentary voice ---------------------> voice  [COMMENTARY] ----+-> master [MASTER] -> limiter -> out
//     music (src/audio/music.ts) -----------> music  [MUSIC] --------/
//
// crowdDuck is pulled down while the commentator speaks (src/audio/commentary.ts
// drives it through duckCrowd). duck is the whole-mix hold-your-breath used at
// penalties. Speech is deliberately outside both.
//
// The four fader nodes are the ONLY place a user setting touches the mix, they
// all move with a 50 ms setTargetAtTime ramp (a stepped gain clicks), and their
// base gains are picked so the DEFAULT fader positions reproduce the balance
// the game shipped with before the faders existed.

import type { MatchEvent } from '../sim/matchEvents';
import { VOLUME_BUSES, VOLUME_DEFAULT, volumeGain, volumeSetting, type VolumeBus } from './volume';

/** Stingers other systems (HUD wipes, banners, replays) can fire. */
export type StingerName =
  | 'whoosh'        // broadcast wipe / transition
  | 'whooshDown'    // wipe out, falling
  | 'goalSting'     // the GOAL banner
  | 'sting'         // short generic TV sting (lower thirds, stat cards)
  | 'replayIn'      // entering a replay
  | 'replayOut'     // leaving a replay
  | 'cardSting'     // disciplinary card slam
  | 'select'        // menu confirm
  | 'back'          // menu cancel
  | 'applause'      // crowd clap (sampled when available)
  // names the presentation/HUD layers already call (src/present/director.ts,
  // src/ui/broadcast.ts) — kept as first-class so nobody has to rename anything
  | 'goal'          // alias of goalSting: the GOAL banner
  | 'walkout'       // teams emerge: swell + applause
  | 'halftime'      // half-time card
  | 'fulltime';     // full-time card

export const STINGERS: StingerName[] = [
  'whoosh', 'whooshDown', 'goalSting', 'sting', 'replayIn', 'replayOut',
  'cardSting', 'select', 'back', 'applause',
  'goal', 'walkout', 'halftime', 'fulltime',
];

interface CrowdLayerDef {
  file: string; dur: number; loop: boolean; gain: number; bytes: number; note: string;
}
interface CrowdManifest {
  version: number; base: string; sampleRate: number;
  layers: Record<string, CrowdLayerDef>;
}

/** Layers the sampled bed plays as continuous loops. */
const LOOPS = ['murmur', 'anticipation'] as const;

function assetBase(): string {
  return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
}

/** Fader ramp: long enough never to click, short enough to feel instant. */
const VOL_RAMP = 0.05;

/**
 * Per-bus gain at the top of its fader, chosen so `base * volumeGain(default)`
 * equals the level that bus ran at before there were faders:
 *   master 1/g(80)  — master sat at unity, so 80 must come out at 1.0
 *   sfx    0.7      — the old master node's 0.7 headroom, now on this bus
 *   voice  0.7      — voice was 1.0 into that same 0.7
 *   music  1/g(60)  — music went straight to the destination at track volume
 */
const VOL_BASE: Record<VolumeBus, number> = {
  master: 1 / volumeGain(VOLUME_DEFAULT.master),
  sfx: 0.7 / volumeGain(VOLUME_DEFAULT.sfx),
  voice: 0.7 / volumeGain(VOLUME_DEFAULT.voice),
  music: 1 / volumeGain(VOLUME_DEFAULT.music),
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  /** MASTER fader — the last node before the limiter. */
  private master!: GainNode;
  /** CROWD & SFX fader: the crowd chain and every synthesized effect. */
  private sfxBus!: GainNode;
  /** MUSIC fader (src/audio/music.ts plays into it). */
  private music!: GainNode;
  private duck!: GainNode;
  private crowdBus!: GainNode;
  private crowdDuck!: GainNode;
  /** COMMENTARY fader — also the speech destination, outside both ducks. */
  private voice!: GainNode;

  // synthesized bed (always built; faded out once samples arrive)
  private synthMurmur!: GainNode;
  private synthAnticipation!: GainNode;
  private synthBed!: GainNode;

  // sampled bed
  private sampleBed!: GainNode;
  private loopGain: Partial<Record<(typeof LOOPS)[number], GainNode>> = {};
  private crowd: CrowdManifest | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private sampled = false;
  private loading = false;

  private excitement = 0;      // 0..1 target from buildup events
  private eruption = 0;        // spikes on goals/shots, decays
  private crowdOn = true;
  private chantCooldown = 14;  // first chant a little into the match
  /** Home side owns the stadium: their goal erupts, the other one groans. */
  private homeIdx = 0;

  constructor() {
    // Autoplay policy: only a real user gesture can start audio, and gamepad
    // polling is NOT a gesture — so listen for genuine ones ourselves and
    // keep resuming until the context actually runs.
    const gesture = (): void => this.unlock();
    window.addEventListener('keydown', gesture);
    window.addEventListener('pointerdown', gesture);
  }

  /** Shared context for the music player (null until unlocked). */
  context(): AudioContext | null {
    return this.ctx;
  }

  /** Destination for baked commentary — outside both duck stages. */
  voiceBus(): GainNode | null {
    return this.ctx ? this.voice : null;
  }

  /** Destination for the music player (null until unlocked). */
  musicBus(): GainNode | null {
    return this.ctx ? this.music : null;
  }

  // ---------------------------------------------------------------- volume

  private busNode(bus: VolumeBus): GainNode | null {
    if (!this.ctx) return null;
    switch (bus) {
      case 'master': return this.master;
      case 'sfx': return this.sfxBus;
      case 'voice': return this.voice;
      case 'music': return this.music;
    }
  }

  /**
   * Set one fader, 0..1 (the UI stores 0..100, so it passes pct/100). The
   * perceptual square-law taper and the bus's base gain are applied here, and
   * the move is a 50 ms ramp — never a step, which would click.
   */
  setVolume(bus: VolumeBus, v: number, ramp = VOL_RAMP): void {
    const node = this.busNode(bus);
    if (!node || !this.ctx) return;
    const g = VOL_BASE[bus] * volumeGain(Math.max(0, Math.min(1, v)) * 100);
    if (ramp <= 0) {
      // .value, not setValueAtTime: this is the boot path, and the readback
      // (volumeGainOf, which tools/volume-smoke.mjs asserts on) has to be exact
      node.gain.value = g;
      return;
    }
    // cancel first: a held d-pad fires every ~110ms and stacked targets crawl
    node.gain.cancelScheduledValues(this.ctx.currentTime);
    node.gain.setTargetAtTime(g, this.ctx.currentTime, ramp);
  }

  /** Push every persisted `ss26.vol.*` value into the graph. */
  applyVolumes(ramp = VOL_RAMP): void {
    if (!this.ctx) return;
    for (const bus of VOLUME_BUSES) this.setVolume(bus, volumeSetting(bus) / 100, ramp);
  }

  /** The gain actually on a fader node — the smoke check reads this. */
  volumeGainOf(bus: VolumeBus): number | null {
    return this.busNode(bus)?.gain.value ?? null;
  }

  /**
   * A short confirm tick played INTO the fader being moved, so dragging the
   * music slider is audible at the music level and not the SFX one.
   */
  volumeTick(bus: VolumeBus): void {
    const ctx = this.ctx;
    const dest = this.busNode(bus);
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    for (const [f, at, amp] of [[880, 0, 0.09], [1320, 0.055, 0.07]] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(amp, t + at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.05);
      osc.connect(g).connect(dest);
      osc.start(t + at);
      osc.stop(t + at + 0.06);
    }
  }

  /**
   * Safe to call from anywhere, any number of times: builds the graph once,
   * and resumes a context the browser created in the suspended state.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    // brick-wall-ish limiter so stacked roars/whistles don't crackle
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    // MASTER sits before the limiter: turning the game down turns the limiter's
    // input down with it, so a quiet mix stays a clean one.
    this.master = ctx.createGain();
    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.voice = ctx.createGain();
    this.voice.connect(this.master);

    this.duck = ctx.createGain();
    this.duck.connect(this.sfxBus);
    this.applyVolumes(0);
    this.crowdDuck = ctx.createGain();
    this.crowdDuck.connect(this.duck);
    this.crowdBus = ctx.createGain();
    this.crowdBus.connect(this.crowdDuck);

    this.synthBed = ctx.createGain();
    this.synthBed.connect(this.crowdBus);
    this.sampleBed = ctx.createGain();
    this.sampleBed.gain.value = 0;
    this.sampleBed.connect(this.crowdBus);

    // --- murmur bed: brown noise through a low bandpass
    this.synthMurmur = this.makeCrowdLayer(320, 0.7, 0.22);
    // --- anticipation layer: brighter, voice-band noise
    this.synthAnticipation = this.makeCrowdLayer(850, 1.4, 0.0);
    this.crowdBus.gain.value = this.crowdOn ? 1 : 0;

    void this.loadCrowd();
  }

  /** Which team the stands belong to (defaults to the home side, index 0). */
  setHomeTeam(idx: number): void {
    this.homeIdx = idx;
  }

  /** Crowd bed on during matches, off under the menu music. */
  setCrowd(on: boolean): void {
    this.crowdOn = on;
    if (!this.ctx) return;
    this.crowdBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.25);
    if (!on) { this.excitement = 0; this.eruption = 0; }
  }

  // ------------------------------------------------------------ sampled bed

  private async loadCrowd(): Promise<void> {
    if (this.loading || !this.ctx) return;
    this.loading = true;
    const ctx = this.ctx;
    const base = assetBase();
    try {
      const res = await fetch(`${base}audio/crowd.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const man = (await res.json()) as CrowdManifest;
      if (!man?.layers) throw new Error('malformed crowd manifest');
      const entries = Object.entries(man.layers);
      await Promise.all(entries.map(async ([name, def]) => {
        const r = await fetch(`${base}${man.base}${def.file}`);
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${def.file}`);
        this.buffers.set(name, await ctx.decodeAudioData(await r.arrayBuffer()));
      }));
      this.crowd = man;
      this.startSampledLoops();
    } catch (err) {
      // no bake, no network, no problem — the synthesized bed carries it
      console.info('audio: no crowd pack, using synthesis —', String(err));
    }
  }

  private startSampledLoops(): void {
    const ctx = this.ctx!;
    for (const name of LOOPS) {
      const buf = this.buffers.get(name);
      const def = this.crowd?.layers[name];
      if (!buf || !def) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // a hair off unity so two sessions never phase-lock into a texture
      src.playbackRate.value = 0.97 + Math.random() * 0.06;
      const g = ctx.createGain();
      g.gain.value = name === 'murmur' ? def.gain : 0;
      src.connect(g).connect(this.sampleBed);
      src.start(ctx.currentTime + Math.random() * 0.5);
      this.loopGain[name] = g;
    }
    // hand over: real crowd in, synth crowd out
    const t = ctx.currentTime;
    this.sampleBed.gain.setTargetAtTime(1, t, 0.8);
    this.synthBed.gain.setTargetAtTime(0, t, 0.8);
    this.sampled = true;
  }

  /** Fire a baked one-shot. Returns false when that layer isn't loaded. */
  private oneShot(name: string, gain: number, rate = 1, dest?: AudioNode): boolean {
    const buf = this.buffers.get(name);
    const def = this.crowd?.layers[name];
    if (!buf || !def || !this.ctx) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
    const g = ctx.createGain();
    g.gain.value = def.gain * gain;
    src.connect(g).connect(dest ?? this.crowdBus);
    src.start(ctx.currentTime);
    return true;
  }

  // ------------------------------------------------------------- synth bed

  private noiseBuffer(seconds: number, brown: boolean): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        data[i] = white;
      }
    }
    return buf;
  }

  private makeCrowdLayer(freq: number, q: number, gain: number): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(4, true);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    // slow amplitude wobble so the crowd breathes
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13 + Math.random() * 0.1;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = gain * 0.25;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start();
    src.connect(bp).connect(g).connect(this.synthBed);
    src.start();
    return g;
  }

  // ---------------------------------------------------------------- update

  /** Per-frame: ease the crowd toward the game state. */
  update(dt: number): void {
    if (!this.ctx) return;
    this.eruption = Math.max(0, this.eruption - dt * 0.45);
    const target = Math.min(1, this.excitement * 0.7 + this.eruption);
    const t = this.ctx.currentTime;

    this.synthAnticipation.gain.setTargetAtTime(target * 0.5, t, 0.4);
    this.synthMurmur.gain.setTargetAtTime(0.17 + target * 0.18, t, 0.6);
    const ant = this.loopGain.anticipation;
    const mur = this.loopGain.murmur;
    if (ant && mur) {
      const antDef = this.crowd!.layers.anticipation.gain;
      const murDef = this.crowd!.layers.murmur.gain;
      // the bed doesn't just get louder, it gets BRIGHTER: the anticipation
      // layer is what makes a stadium sound like it is leaning forward
      ant.gain.setTargetAtTime(antDef * Math.min(1, target * 1.25), t, 0.35);
      mur.gain.setTargetAtTime(murDef * (0.8 + target * 0.35), t, 0.6);
    }

    // terrace claps: when the game is up, a section starts a rhythm
    // (dt 0 = the game is frozen under a card — no clapping over silence)
    if (this.crowdOn && dt > 0) {
      this.chantCooldown -= dt;
      if (this.chantCooldown <= 0 && target > 0.3) {
        this.chant();
        this.chantCooldown = 22 + Math.random() * 16;
      }
    }
  }

  /** Clap-clap, clap-clap-clap: a few hundred hands, slightly out of time. */
  private chant(): void {
    if (this.sampled && this.oneShot('chant', 0.9, 0.98 + Math.random() * 0.05)) return;
    const ctx = this.ctx!;
    const beat = 0.34;
    const pattern = [0, 1, 2, 2.5, 3]; // the universal stadium clap
    for (let bar = 0; bar < 2; bar++) {
      for (const step of pattern) {
        const base = ctx.currentTime + 0.05 + (bar * 4 + step) * beat;
        for (let h = 0; h < 3; h++) { // layered hands, jittered
          const t = base + Math.random() * 0.045;
          const src = ctx.createBufferSource();
          src.buffer = this.noiseBuffer(0.05, false);
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 1500 + Math.random() * 800;
          bp.Q.value = 1.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.1 + Math.random() * 0.05, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
          src.connect(bp).connect(g).connect(this.crowdBus);
          src.start(t);
          src.stop(t + 0.1);
        }
      }
    }
  }

  // ---------------------------------------------------------------- events

  onEvent(e: MatchEvent): void {
    if (!this.ctx) return;
    switch (e.type) {
      case 'attackBuildup':
        this.excitement = e.level;
        break;
      case 'shot':
        this.swell(0.5);
        break;
      case 'goal': {
        // the stands belong to one side: their goal is an eruption, the other
        // side's is 60,000 people sitting down at once
        const forHome = e.teamIdx === this.homeIdx;
        this.eruption = forHome ? 1.6 : 0.8;
        this.netSwish();
        if (forHome) {
          if (!this.oneShot('eruption', 1.0)) this.roar(2.6, 1.0);
          this.goalHorn();
        } else {
          if (!this.oneShot('groan', 1.0)) this.groan();
          // the away end is in there somewhere, just outnumbered
          this.oneShot('roar', 0.35, 1.06) || this.roar(1.2, 0.35);
        }
        this.whistleBlast(1, 0);
        break;
      }
      case 'save':
        if (!this.oneShot('roar', 0.55)) this.roar(0.8, 0.5);
        break;
      case 'miss':
        if (!this.oneShot('groan', 0.7)) this.groan();
        break;
      case 'post':
        this.doink();
        if (!this.oneShot('groan', 0.85, 1.05)) this.groan();
        break;
      case 'kick':
        this.kickSfx(e.power);
        break;
      case 'bounce':
        this.kickSfx(Math.min(e.speed / 20, 0.5) * 0.4);
        break;
      case 'tackle':
        this.thump();
        break;
      case 'kickoff':
        this.setDucked(false);
        this.whistleBlast(1, 0);
        break;
      case 'break':
      case 'fulltime':
        this.setDucked(false);
        this.whistleBlast(3, 0.18);
        if (!this.oneShot('applause', 0.9)) this.roar(1.2, 0.5);
        break;
      case 'corner':
      case 'throwIn':
      case 'goalKick':
        this.whistleBlast(1, 0);
        break;
      case 'offside':
        this.whistleBlast(2, 0.12);
        if (!this.oneShot('groan', 0.5, 1.1)) this.groan();
        break;
      case 'foul':
        this.whistleBlast(1, 0);
        break;
      case 'card':
        this.whistleBlast(2, 0.1);
        if (!this.oneShot('roar', e.color === 'red' ? 0.7 : 0.4, 1.03)) {
          this.roar(0.7, e.color === 'red' ? 0.55 : 0.3);
        }
        break;
      case 'penaltyAwarded':
        this.whistleBlast(1, 0.3);
        if (!this.oneShot('roar', 0.8)) this.roar(1.4, 0.6);
        break;
      case 'penTension':
        // the crowd holds its breath (§6.5)
        this.setDucked(true);
        break;
      case 'penKick':
        this.setDucked(false);
        if (e.result === 'goal') {
          this.eruption = 1.4;
          this.netSwish();
          if (!this.oneShot('eruption', 0.85)) this.roar(2.0, 0.9);
        } else if (e.result === 'saved') {
          if (!this.oneShot('roar', 0.9)) this.roar(1.4, 0.8);
        } else if (!this.oneShot('groan', 1.0)) {
          this.groan();
        }
        break;
      case 'shootoutEnd':
        this.eruption = 1.6;
        if (!this.oneShot('eruption', 1.0)) this.roar(3, 1.0);
        this.whistleBlast(3, 0.18);
        break;
      case 'switch':
        this.switchBlip();
        break;
      case 'possessionChange':
      default:
        break;
    }
  }

  // --------------------------------------------------------------- stingers

  /**
   * Broadcast furniture, for the HUD / cutscene / menu layers to call:
   *
   *     audio.stinger('whoosh');      // wipe in
   *     audio.stinger('goalSting');   // GOAL banner
   *
   * Safe before the audio context exists (no-op) and safe to spam.
   * Names are in STINGERS / StingerName.
   */
  stinger(name: StingerName | string, gain = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    switch (name) {
      case 'walkout':
        // the tunnel moment: a rising swell under real applause
        this.noiseSweep(t, 0.9, 300, 3200, 0.16 * gain);
        if (!this.oneShot('applause', 0.9 * gain)) this.chant();
        break;
      case 'halftime':
        this.stinger('sting', gain);
        this.oneShot('clap_burst', 0.5 * gain);
        break;
      case 'fulltime':
        this.stinger('goalSting', 0.85 * gain);
        this.oneShot('applause', 1.0 * gain);
        break;
      case 'whoosh':
        this.noiseSweep(t, 0.38, 420, 5200, 0.30 * gain);
        break;
      case 'whooshDown':
        this.noiseSweep(t, 0.42, 5200, 380, 0.28 * gain);
        break;
      case 'replayIn':
        this.noiseSweep(t, 0.30, 700, 4200, 0.22 * gain);
        this.blip(t + 0.26, 1180, 0.09 * gain, 0.09, 'sine');
        break;
      case 'replayOut':
        this.noiseSweep(t, 0.30, 4200, 700, 0.22 * gain);
        this.blip(t + 0.02, 780, 0.09 * gain, 0.11, 'sine');
        break;
      case 'goal':          // the HUD's name for it
      case 'goalSting': {
        // a short brass-ish stab: three detuned saws, fast attack, filter drop
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(5200, t);
        lp.frequency.exponentialRampToValueAtTime(900, t + 0.55);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.28 * gain, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
        lp.connect(g).connect(this.sfxBus);
        for (const f of [174.6, 233.1, 349.2, 466.2]) {  // F–A#, a fanfare fifth
          for (const d of [-3, 3]) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = f + d * 0.01 * f;
            osc.connect(lp);
            osc.start(t);
            osc.stop(t + 0.65);
          }
        }
        this.noiseSweep(t, 0.25, 900, 7000, 0.16 * gain);
        break;
      }
      case 'sting': {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16 * gain, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
        g.connect(this.sfxBus);
        for (const [f, at] of [[523.3, 0], [784, 0.055], [1046.5, 0.11]] as [number, number][]) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = f;
          osc.connect(g);
          osc.start(t + at);
          osc.stop(t + at + 0.25);
        }
        break;
      }
      case 'cardSting': {
        // low impact + a metallic tail: the card lands like a stamp
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(48, t + 0.18);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.42 * gain, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.connect(g).connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + 0.3);
        this.noiseSweep(t, 0.2, 3000, 800, 0.14 * gain);
        break;
      }
      case 'select':
        this.blip(t, 880, 0.09 * gain, 0.05, 'square');
        this.blip(t + 0.055, 1320, 0.07 * gain, 0.05, 'square');
        break;
      case 'back':
        this.blip(t, 520, 0.09 * gain, 0.06, 'square');
        this.blip(t + 0.055, 330, 0.07 * gain, 0.07, 'square');
        break;
      case 'applause':
        if (!this.oneShot('clap_burst', gain)) this.chant();
        break;
      default:
        break;
    }
  }

  private noiseSweep(t: number, dur: number, from: number, to: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(dur + 0.1, false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.1);
  }

  private blip(t: number, freq: number, vol: number, dur: number,
               type: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  /** Tiny UI blip so a controlled-player switch registers without looking. */
  private switchBlip(): void {
    this.blip(this.ctx!.currentTime, 880, 0.08, 0.04, 'square');
  }

  // -------------------------------------------------------------- crowd sfx

  /** Quick anticipation swell (shot struck — crowd inhales). */
  private swell(amount: number): void {
    this.eruption = Math.min(this.eruption + amount, 1.2);
  }

  /** Big eruption: burst of bright noise on top of the layers. */
  private roar(dur: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(dur + 0.5, true);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1000;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(g).connect(this.crowdBus);
    src.start();
    src.stop(t + dur + 0.1);
  }

  /** Disappointed "ohhhh": noise swell with a downward filter sweep. */
  private groan(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(1.2, true);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.8;
    const t = ctx.currentTime;
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(280, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    src.connect(bp).connect(g).connect(this.crowdBus);
    src.start();
    src.stop(t + 1.2);
  }

  // ---------------------------------------------------------------- ball sfx

  /**
   * Three kick weights, chosen by power: a side-foot pass, a driven ball, and
   * a full-blooded strike. Each is a body thump plus a leather snap, but the
   * balance, pitch and snap brightness move a long way between them.
   */
  private kickSfx(power: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const weight = power < 0.33 ? 0 : power < 0.7 ? 1 : 2;
    const [thumpF, thumpV, snapF, snapV, decay] = [
      [150, 0.30, 1400, 0.14, 0.07],
      [128, 0.48, 1000, 0.24, 0.10],
      [104, 0.72, 760, 0.38, 0.14],
    ][weight];

    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(thumpF * (0.95 + Math.random() * 0.1), t);
    osc.frequency.exponentialRampToValueAtTime(42, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(thumpV, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay + 0.02);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + decay + 0.05);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.08, false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = snapF;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(snapV, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.05 + weight * 0.015);
    src.connect(hp).connect(g2).connect(this.sfxBus);
    src.start(t);
  }

  /** The ball hitting the net: a soft high hiss with no attack transient. */
  private netSwish(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.5, false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.6;
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.45);
  }

  /** Studs, shoulder, turf. Slightly different every time. */
  private thump(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(92 + Math.random() * 30, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.36, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.16);
    // turf scuff
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.25, false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200 + Math.random() * 900;
    bp.Q.value = 0.8;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.14, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(bp).connect(g2).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.22);
  }

  /** Stadium air horn: detuned saw stack, the hockey-barn goal blast. */
  private goalHorn(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.15; // let the roar hit first
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 1.0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
    g.gain.setValueAtTime(0.2, t + 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
    lp.connect(g).connect(this.sfxBus);
    for (const f of [233, 236.5, 116.5, 351]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 1.2);
    }
  }

  /** The sacred post DOINK (§7.3). */
  private doink(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // an aluminium post is inharmonic — the partials are what sell it
    for (const [f, v, d] of [
      [520, 0.5, 0.7], [1040, 0.25, 0.5], [1563, 0.12, 0.35], [2430, 0.06, 0.22],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f * (0.99 + Math.random() * 0.02);
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);
      osc.connect(g).connect(this.sfxBus);
      osc.start(t);
      osc.stop(t + d + 0.05);
    }
  }

  /**
   * The referee's whistle. `count` 1 = a foul or a restart, 2 = an offside or
   * a card, 3 = half or full time — and the third blast is held long, the way
   * a referee holds it when the match is over.
   */
  private whistleBlast(count: number, gap: number): void {
    const ctx = this.ctx!;
    for (let i = 0; i < count; i++) {
      const t = ctx.currentTime + i * (0.22 + gap);
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(2350 + (Math.random() - 0.5) * 60, t);
      // pea-whistle warble
      const warble = ctx.createOscillator();
      warble.frequency.value = 38;
      const warbleGain = ctx.createGain();
      warbleGain.gain.value = 120;
      warble.connect(warbleGain).connect(osc.frequency);
      const g = ctx.createGain();
      const dur = count > 1 && i === count - 1 ? 0.9 : 0.28;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + dur - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.sfxBus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      warble.start(t);
      warble.stop(t + dur + 0.05);
    }
  }

  // ---------------------------------------------------------------- ducking

  /** Duck the whole mix (penalties hold their breath — §6.5). */
  setDucked(d: boolean): void {
    if (!this.ctx) return;
    this.duck.gain.setTargetAtTime(d ? 0.25 : 1, this.ctx.currentTime, 0.3);
  }

  /** Duck only the crowd, so the commentator is heard over a full stadium. */
  duckCrowd(d: boolean): void {
    if (!this.ctx) return;
    // fast in, slow out: he cuts through instantly, the crowd swells back
    this.crowdDuck.gain.setTargetAtTime(d ? 0.42 : 1, this.ctx.currentTime, d ? 0.08 : 0.45);
  }
}
