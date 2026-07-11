// Offside (§6.4): line check at the moment of the pass; flag raised when the
// receiver touches the ball. Keeps the through-ball honest.

import type { PlayerEntity } from './player';
import type { Match } from './match';

export class OffsideTracker {
  private pendingReceiver: PlayerEntity | null = null;

  /** Called at the moment a forward pass is struck. */
  registerPass(passer: PlayerEntity, receiver: PlayerEntity): void {
    const match = this.match;
    if (!match) return;
    const team = match.teams[passer.teamIdx];
    const lineX = match.secondLastDefenderX(1 - passer.teamIdx);
    const recvAdv = receiver.pos.x * team.attackDir;
    const ballAdv = match.ball.pos.x * team.attackDir;
    const inOppHalf = recvAdv > 0;
    const beyondLine = recvAdv > lineX * team.attackDir + 0.2;
    const beyondBall = recvAdv > ballAdv;
    this.pendingReceiver = inOppHalf && beyondLine && beyondBall ? receiver : null;
  }

  match: Match | null = null;

  clear(): void {
    this.pendingReceiver = null;
  }

  /** Called when a player gains control; true → offside, play stops. */
  checkTouch(toucher: PlayerEntity): boolean {
    if (this.pendingReceiver && toucher === this.pendingReceiver) {
      this.pendingReceiver = null;
      return true;
    }
    // any other touch (defender interception, different teammate) resets it —
    // a new phase of play has started, the old flag no longer applies
    this.pendingReceiver = null;
    return false;
  }
}
