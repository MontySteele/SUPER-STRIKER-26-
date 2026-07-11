// Roster editor: rename players, crank ratings, hand out the star. Edits
// apply to the live in-memory teams and persist to localStorage (this
// browser only) — teams.json on disk is never touched, and every team has a
// RESET back to factory.

import { TEAMS, overall, teamRating } from '../data/loader';
import { factoryPlayers, resetTeamRoster, sanitizePlayer, saveTeamRoster, teamEdited } from '../data/roster';
import type { PlayerData, TeamData } from '../data/types';

const STAT_COLS: [keyof PlayerData, string][] = [
  ['pace', 'PAC'], ['shooting', 'SHO'], ['passing', 'PAS'],
  ['defending', 'DEF'], ['keeping', 'KEE'], ['stamina', 'STA'],
];

export class RosterEditor {
  private root: HTMLElement;
  private team: TeamData | null = null;
  private draft: PlayerData[] = [];
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(private onExit: () => void) {
    this.root = document.getElementById('ui-root')!;
    this.keyHandler = (e) => {
      if (e.code !== 'Escape' && e.code !== 'KeyK') return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) {
        if (e.code === 'Escape') el.blur();
        return; // typing a K into a name field is not "back"
      }
      this.back();
    };
    window.addEventListener('keydown', this.keyHandler);
    this.renderPick();
  }

  private destroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.root.innerHTML = '';
  }

  private back(): void {
    if (this.team) {
      this.team = null;
      this.renderPick();
    } else {
      this.destroy();
      this.onExit();
    }
  }

  // ------------------------------------------------------------- team picker

  private renderPick(): void {
    const teams = [...TEAMS].sort((a, b) => a.name.localeCompare(b.name));
    const cells = teams.map((t, i) => `
      <div class="team-cell" data-idx="${i}">
        <div class="swatch" style="background:${t.kit.home}"></div>
        <span>${t.name}</span>
        <span class="tier">${teamEdited(t.id) ? 'EDITED' : '★'.repeat(Math.max(1, Math.min(5, t.tier)))}</span>
      </div>`).join('');
    this.root.innerHTML = `
      <div class="menu-screen tour-screen">
        <div class="menu-h2">EDIT TEAMS</div>
        <div class="tour-note" style="margin-bottom:12px">Pick a squad — changes save to this browser only. K / ESC to go back.</div>
        <div class="team-grid">${cells}</div>
      </div>`;
    this.root.querySelectorAll('.team-cell').forEach((el) => {
      el.addEventListener('click', () => {
        this.team = teams[Number((el as HTMLElement).dataset.idx)];
        this.draft = this.team.players.map((p) => ({ ...p }));
        this.renderTeam();
      });
    });
  }

  // ------------------------------------------------------------- roster table

  private renderTeam(note = ''): void {
    const t = this.team!;
    const rows = this.draft.map((p, i) => {
      const stats = STAT_COLS.map(([key]) => `
        <td><input class="ros-in num" type="number" min="1" max="99"
          data-row="${i}" data-field="${String(key)}" value="${p[key] as number}"></td>`).join('');
      return `<tr>
        <td><input class="ros-in num" type="number" min="1" max="99" data-row="${i}" data-field="num" value="${p.num}"></td>
        <td class="tname"><input class="ros-in name" type="text" maxlength="24" data-row="${i}" data-field="name" value="${p.name.replace(/"/g, '&quot;')}"></td>
        <td>${p.pos}</td>
        ${stats}
        <td><button class="ros-star${p.star ? ' on' : ''}" data-row="${i}" title="star player: +10 to everything">★</button></td>
        <td class="ros-ovr">${Math.round(overall(p))}</td>
      </tr>`;
    }).join('');
    this.root.innerHTML = `
      <div class="menu-screen tour-screen">
        <div class="menu-h2">EDIT — ${t.name.toUpperCase()} <small class="ros-rating">(${Math.round(teamRating(t))})</small></div>
        <div class="tour-note" style="margin-bottom:8px">Type to edit · ★ = star player (+10 all stats, gold ring) · position is fixed by formation</div>
        <div class="roster-wrap">
          <table class="tour-table big roster">
            <tr class="hdr"><th>#</th><th>NAME</th><th>POS</th>${STAT_COLS.map(([, l]) => `<th>${l}</th>`).join('')}<th>★</th><th>OVR</th></tr>
            ${rows}
          </table>
        </div>
        <div class="tour-actions">
          <button class="tour-btn primary" data-act="save">SAVE TEAM</button>
          <button class="tour-btn" data-act="reset">RESET TO FACTORY</button>
          <button class="tour-btn" data-act="back">BACK <small>(ESC)</small></button>
        </div>
        ${note ? `<div class="tour-note boot">${note}</div>` : ''}
      </div>`;

    this.root.querySelectorAll<HTMLInputElement>('.ros-in').forEach((input) => {
      input.addEventListener('change', () => {
        const row = Number(input.dataset.row);
        const field = input.dataset.field as keyof PlayerData;
        const draft = this.draft[row] as unknown as Record<string, unknown>;
        draft[field] = field === 'name' ? input.value : Number(input.value);
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('.ros-star').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = Number(btn.dataset.row);
        this.draft[row].star = !this.draft[row].star;
        btn.classList.toggle('on', this.draft[row].star);
      });
    });
    this.root.querySelector('[data-act="save"]')?.addEventListener('click', () => this.saveDraft());
    this.root.querySelector('[data-act="reset"]')?.addEventListener('click', () => {
      resetTeamRoster(t);
      this.draft = t.players.map((p) => ({ ...p }));
      this.renderTeam('Factory roster restored.');
    });
    this.root.querySelector('[data-act="back"]')?.addEventListener('click', () => this.back());
  }

  private saveDraft(): void {
    const t = this.team!;
    const factory = factoryPlayers(t.id);
    t.players = this.draft.map((p, i) => sanitizePlayer(p, factory[i] ?? p as PlayerData));
    saveTeamRoster(t);
    this.draft = t.players.map((p) => ({ ...p }));
    this.renderTeam(`Saved. ${t.name} now rate ${Math.round(teamRating(t))}.`);
  }
}
