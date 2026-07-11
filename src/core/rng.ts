/** Seedable RNG (mulberry32) so the sim step is deterministic per spec §8. */
export class RNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Roughly normal-distributed noise in [-1, 1] (sum of 3 uniforms). */
  noise(): number {
    return (this.next() + this.next() + this.next()) / 1.5 - 1;
  }

  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
