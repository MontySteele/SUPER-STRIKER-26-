// Music (§7.1): licensed-soundtrack-energy instrumental loops — big-beat /
// electro, fully synthesized. 'menu' is the loud front-end anthem; 'match'
// is a leaner groove that sits under the crowd during play.

export const MUSIC_KEY = 'ss26.music';
export type MusicSetting = 'all' | 'menus' | 'off';

export function musicSetting(): MusicSetting {
  try {
    const v = localStorage.getItem(MUSIC_KEY);
    if (v === 'menus' || v === 'off') return v;
  } catch { /* private browsing */ }
  return 'all';
}

export type MusicTrack = 'menu' | 'match';

interface TrackDef {
  bpm: number;
  volume: number;
  bass: number[];              // 16 8th-steps, 0 = rest
  stabSteps: number[];
  stabChord: number[];
  hatGain: number;
}

const TRACKS: Record<MusicTrack, TrackDef> = {
  // A-minor-ish big beat: the front-end anthem
  menu: {
    bpm: 126, volume: 0.16,
    bass: [55, 0, 55, 0, 65.4, 0, 55, 55, 82.4, 0, 73.4, 0, 65.4, 0, 61.7, 0],
    stabSteps: [4, 12],
    stabChord: [220, 261.6, 329.6, 440],
    hatGain: 0.25,
  },
  // D-minor driving groove: quieter, busier bass, sparser stabs — leaves
  // room for the crowd and the commentary
  match: {
    bpm: 122, volume: 0.085,
    bass: [73.4, 0, 73.4, 73.4, 0, 87.3, 0, 73.4, 65.4, 0, 65.4, 58.3, 0, 87.3, 98, 0],
    stabSteps: [12],
    stabChord: [293.7, 349.2, 440],
    hatGain: 0.18,
  },
};

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private track: MusicTrack = 'menu';

  start(ctx: AudioContext, track: MusicTrack = 'menu'): void {
    if (this.timer !== null) {
      if (this.track === track) return;
      this.stop(); // crossfade-ish: old master ramps down while the new starts
    }
    this.ctx = ctx;
    this.track = track;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(TRACKS[track].volume, ctx.currentTime, 0.5);
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

  get currentTrack(): MusicTrack | null {
    return this.timer !== null ? this.track : null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const stepDur = 60 / TRACKS[this.track].bpm / 2; // 8th notes
    while (this.nextStepTime < ctx.currentTime + 0.25) {
      this.playStep(this.step, this.nextStepTime, stepDur);
      this.step = (this.step + 1) % 16;
      this.nextStepTime += stepDur;
    }
  }

  private playStep(step: number, t: number, stepDur: number): void {
    const ctx = this.ctx!;
    const out = this.master!;
    const def = TRACKS[this.track];

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
      g.gain.value = def.hatGain;
      src.connect(hp).connect(g).connect(out);
      src.start(t);
    }

    // bass line: filtered square
    const note = def.bass[step];
    if (note > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = note;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(280, t + stepDur * 0.9);
      lp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.setValueAtTime(0.22, t + stepDur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 0.95);
      osc.connect(lp).connect(g).connect(out);
      osc.start(t);
      osc.stop(t + stepDur);
    }

    // chord stab
    if (def.stabSteps.includes(step)) {
      for (const f of def.stabChord) {
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
