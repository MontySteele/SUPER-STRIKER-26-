// Audio (§7.3): the crowd IS the commentator. Layered synthesized noise loops
// driven directly by game state — always in sync by construction. All SFX are
// synthesized too: zero assets, tiny bundle.

import type { MatchEvent } from '../sim/matchEvents';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private murmurGain!: GainNode;
  private anticipationGain!: GainNode;
  private duck!: GainNode;
  private crowdBus!: GainNode;
  private excitement = 0;      // 0..1 target from buildup events
  private eruption = 0;        // spikes on goals/shots, decays
  private crowdOn = true;
  private chantCooldown = 14;  // first chant a little into the match

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
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    // brick-wall-ish limiter so stacked roars/whistles don't crackle
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.duck = ctx.createGain();
    this.duck.connect(this.master);
    this.master.connect(limiter);
    limiter.connect(ctx.destination);
    this.crowdBus = ctx.createGain();
    this.crowdBus.connect(this.duck);

    // --- murmur bed: brown noise through a low bandpass
    this.murmurGain = this.makeCrowdLayer(320, 0.7, 0.28);
    // --- anticipation layer: brighter, voice-band noise
    this.anticipationGain = this.makeCrowdLayer(850, 1.4, 0.0);
    this.crowdBus.gain.value = this.crowdOn ? 1 : 0;
  }

  /** Crowd bed on during matches, off under the menu music. */
  setCrowd(on: boolean): void {
    this.crowdOn = on;
    if (!this.ctx) return;
    this.crowdBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.25);
    if (!on) { this.excitement = 0; this.eruption = 0; }
  }

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
    src.connect(bp).connect(g).connect(this.crowdBus);
    src.start();
    return g;
  }

  /** Per-frame: ease the crowd toward the game state. */
  update(dt: number): void {
    if (!this.ctx) return;
    this.eruption = Math.max(0, this.eruption - dt * 0.45);
    const target = Math.min(1, this.excitement * 0.7 + this.eruption);
    const t = this.ctx.currentTime;
    this.anticipationGain.gain.setTargetAtTime(target * 0.5, t, 0.4);
    this.murmurGain.gain.setTargetAtTime(0.22 + target * 0.2, t, 0.6);

    // terrace claps: when the game is up, a section starts a rhythm
    if (this.crowdOn) {
      this.chantCooldown -= dt;
      if (this.chantCooldown <= 0 && target > 0.35) {
        this.chant();
        this.chantCooldown = 22 + Math.random() * 16;
      }
    }
  }

  /** Clap-clap, clap-clap-clap: a few hundred hands, slightly out of time. */
  private chant(): void {
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

  onEvent(e: MatchEvent): void {
    if (!this.ctx) return;
    switch (e.type) {
      case 'attackBuildup':
        this.excitement = e.level;
        break;
      case 'shot':
        this.swell(0.5, 0.15);
        break;
      case 'goal':
        this.eruption = 1.6;
        this.roar(2.6, 1.0);
        this.goalHorn();
        this.whistleBlast(1, 0.0);
        break;
      case 'save':
        this.roar(0.8, 0.5);
        break;
      case 'miss':
        this.groan();
        break;
      case 'post':
        this.doink();
        this.groan();
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
        this.roar(1.2, 0.5);
        break;
      case 'corner':
      case 'throwIn':
      case 'goalKick':
        this.whistleBlast(1, 0);
        break;
      case 'offside':
        this.whistleBlast(2, 0.12);
        this.groan();
        break;
      case 'foul':
        this.whistleBlast(1, 0);
        break;
      case 'card':
        this.whistleBlast(2, 0.1);
        this.roar(0.7, e.color === 'red' ? 0.55 : 0.3);
        break;
      case 'penaltyAwarded':
        this.whistleBlast(1, 0.3);
        this.roar(1.4, 0.6);
        break;
      case 'penTension':
        // the crowd holds its breath (§6.5)
        this.setDucked(true);
        break;
      case 'penKick':
        this.setDucked(false);
        if (e.result === 'goal') { this.eruption = 1.4; this.roar(2.0, 0.9); }
        else if (e.result === 'saved') { this.roar(1.4, 0.8); }
        else this.groan();
        break;
      case 'shootoutEnd':
        this.eruption = 1.6;
        this.roar(3, 1.0);
        this.whistleBlast(3, 0.18);
        break;
      case 'possessionChange':
      default:
        break;
    }
  }

  /** Quick anticipation swell (shot struck — crowd inhales). */
  private swell(amount: number, dur: number): void {
    this.eruption = Math.min(this.eruption + amount, 1.2);
    void dur;
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
    src.connect(bp).connect(g).connect(this.master);
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
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    src.stop(t + 1.2);
  }

  private kickSfx(power: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // low thump
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(120 + power * 60, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4 + power * 0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
    // leather snap
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.06, false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.18 + power * 0.2, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(hp).connect(g2).connect(this.master);
    src.start(t);
  }

  private thump(): void {
    this.kickSfx(0.25);
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
    lp.connect(g).connect(this.master);
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
    for (const [f, v] of [[520, 0.5], [1040, 0.25], [1560, 0.12]] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.75);
    }
  }

  private whistleBlast(count: number, gap: number): void {
    const ctx = this.ctx!;
    for (let i = 0; i < count; i++) {
      const t = ctx.currentTime + i * (0.22 + gap);
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(2350, t);
      // pea-whistle warble
      const warble = ctx.createOscillator();
      warble.frequency.value = 38;
      const warbleGain = ctx.createGain();
      warbleGain.gain.value = 120;
      warble.connect(warbleGain).connect(osc.frequency);
      const g = ctx.createGain();
      const dur = count > 1 && i === count - 1 ? 0.5 : 0.28;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      warble.start(t);
      warble.stop(t + dur + 0.05);
    }
  }

  /** Duck the whole mix (penalties hold their breath — future use). */
  setDucked(d: boolean): void {
    if (!this.ctx) return;
    this.duck.gain.setTargetAtTime(d ? 0.25 : 1, this.ctx.currentTime, 0.3);
  }
}
