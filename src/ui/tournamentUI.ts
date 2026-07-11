// Tournament hub (§3.2): group tables and a knockout bracket in glorious
// 2002-broadcast style. The player's matches run in-engine; everything else
// is simulated the moment you move on.

import { findTeam } from '../data/loader';
import { esc } from './escape';
import type { Fixture, Stage, Tournament } from '../sim/tournament';

const STAGE_LABEL: Record<string, string> = {
  md1: 'GROUP STAGE · MATCHDAY 1',
  md2: 'GROUP STAGE · MATCHDAY 2',
  md3: 'GROUP STAGE · MATCHDAY 3',
  r32: 'ROUND OF 32',
  r16: 'ROUND OF 16',
  qf: 'QUARTER-FINALS',
  sf: 'SEMI-FINALS',
  final: 'THE FINAL',
  done: 'CHAMPIONS',
};

export class TournamentUI {
  private root: HTMLElement;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(
    private tournament: Tournament,
    private onPlay: (fixture: Fixture) => void,
    private onExit: () => void,
  ) {
    this.root = document.getElementById('ui-root')!;
    this.keyHandler = (e) => {
      if (e.code === 'KeyJ' || e.code === 'Enter') this.primary();
      if (e.code === 'KeyK' || e.code === 'Escape') { this.destroy(); this.onExit(); }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.root.innerHTML = '';
  }

  private primary(): void {
    const t = this.tournament;
    if (t.state.stage === 'done') { this.destroy(); this.onExit(); return; }
    const f = t.playerFixture();
    if (f) { this.destroy(); this.onPlay(f); return; }
    t.simulateRestOfStage();
    this.render();
  }

  render(): void {
    const t = this.tournament;
    const stage = t.state.stage;
    if (stage === 'done') { this.renderChampion(); return; }
    if (stage.startsWith('md')) this.renderGroups();
    else this.renderBracket();
  }

  private header(title: string, action: string): string {
    return `
      <div class="tour-head">
        <div class="tour-title">SUPER STRIKER '26 · WORLD TOURNAMENT</div>
        <div class="menu-h2" style="margin:0">${title}</div>
      </div>
      <div class="tour-actions">
        <button class="tour-btn primary" data-act="primary">${action} <small>(J)</small></button>
        <button class="tour-btn" data-act="exit">SAVE & EXIT <small>(K)</small></button>
      </div>`;
  }

  private wire(): void {
    this.root.querySelector('[data-act="primary"]')?.addEventListener('click', () => this.primary());
    this.root.querySelector('[data-act="exit"]')?.addEventListener('click', () => {
      this.destroy(); this.onExit();
    });
  }

  private code(id: string): string { return findTeam(id).code; }
  private kit(id: string): string { return findTeam(id).kit.home; }

  /** One-line Golden Boot strip (top scorers so far). */
  private goldenBootHtml(n = 4): string {
    const top = this.tournament.topScorers(n);
    if (!top.length) return '';
    const items = top.map((s) =>
      `${esc(s.name.split(' ').pop()?.toUpperCase() ?? '')} <small>(${this.code(s.teamId)})</small> ${s.goals}`,
    ).join(' · ');
    return `<div class="tour-note boot">👟 GOLDEN BOOT — ${items}</div>`;
  }

  private renderGroups(): void {
    const t = this.tournament;
    const me = t.state.playerTeamId;
    const myGroup = findTeam(me).group;
    const f = t.playerFixture();
    const action = f ? 'PLAY MATCH' : 'CONTINUE';

    const bigTable = this.groupTableHtml(myGroup, true);
    const fixtureStrip = f ? `
      <div class="vs-strip" style="margin:10px 0 4px">
        <div class="slot"><div class="swatch" style="background:${this.kit(f.homeId)};width:14px;height:14px;border-radius:3px"></div>${findTeam(f.homeId).name}</div>
        <div class="vs">VS</div>
        <div class="slot"><div class="swatch" style="background:${this.kit(f.awayId)};width:14px;height:14px;border-radius:3px"></div>${findTeam(f.awayId).name}</div>
      </div>` : '<div class="tour-note">Your matchday is done — continue to sim the rest.</div>';

    const others = 'ABCDEFGHIJKL'.split('').filter((g) => g !== myGroup)
      .map((g) => this.groupTableHtml(g, false)).join('');

    this.root.innerHTML = `
      <div class="menu-screen tour-screen">
        ${this.header(STAGE_LABEL[t.state.stage], action)}
        ${this.goldenBootHtml()}
        <div class="tour-main">
          <div class="tour-left">
            <div class="tour-sub">GROUP ${myGroup} — YOUR GROUP</div>
            ${bigTable}
            ${fixtureStrip}
          </div>
          <div class="tour-groups">${others}</div>
        </div>
      </div>`;
    this.wire();
  }

  private groupTableHtml(g: string, big: boolean): string {
    const t = this.tournament;
    const me = t.state.playerTeamId;
    const rows = t.groupTable(g).map((s, i) => {
      const team = findTeam(s.teamId);
      const mine = s.teamId === me ? ' mine' : '';
      const qual = i < 2 ? ' qual' : '';
      return `<tr class="${mine}${qual}">
        <td class="pos">${i + 1}</td>
        <td class="tname"><span class="dot" style="background:${team.kit.home}"></span>${big ? team.name : team.code}</td>
        <td>${s.played}</td><td>${s.gf - s.ga >= 0 ? '+' : ''}${s.gf - s.ga}</td><td class="pts">${s.pts}</td>
      </tr>`;
    }).join('');
    return `<table class="tour-table${big ? ' big' : ''}">
      <tr class="hdr">${big ? '<th></th><th>TEAM</th><th>P</th><th>GD</th><th>PTS</th>' : `<th colspan="2">GRP ${g}</th><th>P</th><th>GD</th><th>PTS</th>`}</tr>
      ${rows}
    </table>`;
  }

  private renderBracket(): void {
    const t = this.tournament;
    const me = t.state.playerTeamId;
    const f = t.playerFixture();
    const action = f ? 'PLAY MATCH' : (t.playerAlive() ? 'CONTINUE' : 'SIM ROUND');
    const rounds: Stage[] = ['r32', 'r16', 'qf', 'sf', 'final'];

    const SLOTS: Record<string, number> = { r32: 16, r16: 8, qf: 4, sf: 2, final: 1 };
    const cols = rounds.map((stage) => {
      const fixtures = t.fixtures(stage);
      if (!fixtures.length) {
        // placeholder slots keep the bracket silhouette before the round exists
        const empties = Array.from({ length: SLOTS[stage] }, () =>
          '<div class="br-box empty"><div class="br-line"><span class="br-code">···</span></div><div class="br-line"><span class="br-code">···</span></div></div>',
        ).join('');
        return `<div class="br-col"><div class="br-round">${STAGE_LABEL[stage]}</div>${empties}</div>`;
      }
      const boxes = fixtures.map((fx) => {
        const r = t.results(stage).find((x) => x.homeId === fx.homeId && x.awayId === fx.awayId);
        const mine = fx.homeId === me || fx.awayId === me;
        const line = (id: string, goals: number | null, won: boolean): string => `
          <div class="br-line${won ? ' won' : ''}">
            <span class="dot" style="background:${this.kit(id)}"></span>
            <span class="br-code">${this.code(id)}</span>
            <span class="br-goals">${goals === null ? '' : goals}</span>
          </div>`;
        let inner: string;
        if (r) {
          const w = t.winnerOf(r);
          inner = line(r.homeId, r.homeGoals, w === r.homeId) + line(r.awayId, r.awayGoals, w === r.awayId)
            + (r.penWinnerId ? `<div class="br-pens">pens: ${this.code(r.penWinnerId)}</div>` : '');
        } else {
          inner = line(fx.homeId, null, false) + line(fx.awayId, null, false);
        }
        return `<div class="br-box${mine ? ' mine' : ''}${r ? ' played' : ''}">${inner}</div>`;
      }).join('');
      return `<div class="br-col"><div class="br-round">${STAGE_LABEL[stage]}</div>${boxes}</div>`;
    }).join('');

    this.root.innerHTML = `
      <div class="menu-screen tour-screen">
        ${this.header(STAGE_LABEL[t.state.stage], action)}
        ${t.playerAlive() ? '' : '<div class="tour-note out">YOU ARE OUT — but the show goes on. Sim to the final.</div>'}
        ${this.goldenBootHtml()}
        <div class="bracket">${cols}</div>
      </div>`;
    this.wire();
  }

  private renderChampion(): void {
    const t = this.tournament;
    const champ = t.state.champion ? findTeam(t.state.champion) : null;
    const mine = champ && champ.id === t.state.playerTeamId;
    const boot = t.topScorers(1)[0];
    const bootLine = boot
      ? `<div class="champ-boot">👟 GOLDEN BOOT: ${esc(boot.name.toUpperCase())} (${this.code(boot.teamId)}) — ${boot.goals} GOALS</div>`
      : '';
    this.root.innerHTML = `
      <div class="menu-screen">
        <div class="menu-h2">WORLD CHAMPIONS</div>
        <div class="champ-card">
          <div class="champ-trophy">🏆</div>
          <div class="champ-name" style="color:${champ?.kit.home ?? '#ffce4a'}">${champ?.name.toUpperCase() ?? '—'}</div>
          ${bootLine}
          ${mine ? '<div class="champ-you">THAT\'S YOU. TELL YOUR FRIEND.</div>' : ''}
        </div>
        <div class="tour-actions">
          <button class="tour-btn primary" data-act="primary">BACK TO MENU <small>(J)</small></button>
        </div>
      </div>`;
    this.root.querySelector('[data-act="primary"]')?.addEventListener('click', () => {
      this.destroy(); this.onExit();
    });
  }
}
