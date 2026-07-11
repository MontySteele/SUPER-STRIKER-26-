// Menu music (§7.1): licensed-soundtrack-energy instrumental loop — big-beat /
// electro, fully synthesized. Plays on menus, stops at kickoff.

const BPM = 126;
const STEP = 60 / BPM / 2; // 8th notes

// A-minor-ish bass line over 2 bars (16 8th-steps), 0 = rest
const BASS: number[] = [55, 0, 55, 0, 65.4, 0, 55, 55, 82.4, 0, 73.4, 0, 65.4, 0, 61.7, 0];
const STAB_STEPS = new Set([4, 12]);
const STAB_CHORD = [220, 261.6, 329.6, 440];

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private nextStepTime = 0;
  private step = 0;

  start(ctx: AudioContext): void {
    if (this.timer !== null) return;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.16, ctx.currentTime, 0.5);
    this.nextStepTime = ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = window.setInterval(() => this.schedule(), 70);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25);
      const m = this.master;
      setTimeout(() => m.disconnect(), 1200);
      this.master = null;
    }
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    while (this.nextStepTime < ctx.currentTime + 0.25) {
      this.playStep(this.step, this.nextStepTime);
      this.step = (this.step + 1) % 16;
      this.nextStepTime += STEP;
    }
  }

  private playStep(step: number, t: number): void {
    const ctx = this.ctx!;
    const out = this.master!;

    // kick: four on the floor (every 2nd 8th)
    if (step % 2 === 0) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(130, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.16);
    }

    // offbeat hat: short bright noise
    if (step % 2 === 1) {
      const len = 0.05;
      const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6500;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      src.connect(hp).connect(g).connect(out);
      src.start(t);
    }

    // bass line: filtered square
    const note = BASS[step];
    if (note > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = note;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(280, t + STEP * 0.9);
      lp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.setValueAtTime(0.22, t + STEP * 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.95);
      osc.connect(lp).connect(g).connect(out);
      osc.start(t);
      osc.stop(t + STEP);
    }

    // chord stab on the 2s and 4s
    if (STAB_STEPS.has(step)) {
      for (const f of STAB_CHORD) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(2600, t);
        lp.frequency.exponentialRampToValueAtTime(500, t + 0.22);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
        osc.connect(lp).connect(g).connect(out);
        osc.start(t);
        osc.stop(t + 0.3);
      }
    }
  }
}
