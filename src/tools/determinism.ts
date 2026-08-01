// Determinism shims for the capture tools (§7A.9).
//
// The sim is already deterministic from a seed (src/core/rng.ts) whenever both
// seats are CPU, but the RENDER layer is not: the crowd texture, the grass
// grain, the kick-off limb phase and the goal confetti all reach for
// Math.random, and the star-player ring pulse reads the wall clock. A capture
// only reproduces pixel-for-pixel if those two sources are pinned too, so the
// harness swaps in a seeded RNG and a virtual clock that only advances when
// the harness says so. Nothing outside the ?capture= / viewer.html entry
// points ever calls this.

import { RNG } from '../core/rng';

export interface DeterministicEnv {
  /** The real performance.now, kept for measuring wall-clock throughput. */
  realNow: () => number;
  /** Advance the virtual clock the render layer sees, in milliseconds. */
  advanceClock: (ms: number) => void;
}

/**
 * Replace Math.random and performance.now with seeded / virtual equivalents.
 * Deliberately never restored: the capture and viewer pages are one-shots that
 * do nothing else once the still is drawn, and leaving the shims in place
 * means a stray late callback can't reintroduce entropy.
 */
export function installDeterministicEnv(seed: number): DeterministicEnv {
  const realNow = performance.now.bind(performance);
  const rng = new RNG(seed);
  Math.random = (): number => rng.next();

  let virtualMs = 0;
  performance.now = (): number => virtualMs;

  return {
    realNow,
    advanceClock: (ms: number): void => { virtualMs += ms; },
  };
}
