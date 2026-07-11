import type { TeamData, PlayerData, Pos } from '../data/types';
import { FORMATIONS, pickStartingXI } from '../data/loader';
import { PlayerEntity } from './player';
import { HALF_L, HALF_W } from './constants';
import type { V2 } from '../core/math';

/**
 * Convert a formation fraction [fx, fy] (own goal → opponent, 0..1) into sim
 * coords for a team attacking in `attackDir` (+1 → +x).
 */
export function fracToPitch(frac: [number, number], attackDir: number): V2 {
  const x = (frac[0] * 2 - 1) * HALF_L * attackDir;
  const y = (frac[1] * 2 - 1) * HALF_W;
  return { x, y };
}

export class Team {
  players: PlayerEntity[] = [];
  /** +1 attacks toward +x, -1 toward -x. Swaps at half time. */
  attackDir: number;
  score = 0;
  /** aggregate for HUD possession stat */
  possessionTicks = 0;
  shots = 0;
  shotsOnTarget = 0;

  constructor(
    public data: TeamData,
    public idx: number,
    attackDir: number,
    public isHuman: boolean,
  ) {
    this.attackDir = attackDir;
    const xi = pickStartingXI(data);
    const def = FORMATIONS.formations[data.formation] ?? FORMATIONS.formations['4-4-2'];
    const slots: { pos: Pos; frac: [number, number] }[] = [];
    for (const pos of ['GK', 'DF', 'MF', 'FW'] as Pos[]) {
      for (const frac of def[pos]) slots.push({ pos, frac });
    }
    xi.forEach((pd: PlayerData, i: number) => {
      const slot = slots[i];
      const p = fracToPitch(slot.frac, attackDir);
      this.players.push(new PlayerEntity(pd, idx, slot.pos, slot.frac, p.x, p.y));
    });
  }

  get keeper(): PlayerEntity {
    return this.players[0];
  }

  star(): PlayerEntity | undefined {
    return this.players.find((p) => p.data.star);
  }

  /** Reset everyone to formation, optionally shifted back for kickoff receive. */
  lineUp(kickingOff: boolean): void {
    for (const p of this.players) {
      if (p.sentOff) {
        p.pos = { x: 0, y: HALF_W + 6 };
        p.vel = { x: 0, y: 0 };
        continue;
      }
      const home = fracToPitch(p.homeFrac, this.attackDir);
      // compress into own half
      let x = home.x * 0.92;
      if (this.attackDir > 0) x = Math.min(x, -1.2); else x = Math.max(x, 1.2);
      p.pos = { x, y: home.y };
      p.vel = { x: 0, y: 0 };
      p.facing = this.attackDir > 0 ? 0 : Math.PI;
      p.diving = false;
      p.actionAnim = 'none';
    }
    if (kickingOff) {
      // two most advanced players step to the centre spot
      const fwds = [...this.players].sort(
        (a, b) => (b.pos.x - a.pos.x) * this.attackDir,
      ).slice(0, 2);
      fwds[0].pos = { x: -0.5 * this.attackDir, y: 0.3 };
      fwds[1].pos = { x: -1.5 * this.attackDir, y: -6 };
    }
  }
}
