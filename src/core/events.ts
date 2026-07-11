/** Tiny typed event bus wiring sim → UI/audio/render without circular imports. */

import type { MatchEvent } from '../sim/matchEvents';

type Handler = (e: MatchEvent) => void;

export class EventBus {
  private handlers: Handler[] = [];

  on(h: Handler): void {
    this.handlers.push(h);
  }

  emit(e: MatchEvent): void {
    for (const h of this.handlers) h(e);
  }
}
