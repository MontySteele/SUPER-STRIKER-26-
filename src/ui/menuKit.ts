// Kit art for the front end: a shirt silhouette drawn from the team's kit
// colours, crest blocks for the grid, and the rating furniture (stars + bar).
//
// Everything is inline SVG/CSS built from teams.json, so a team needs no art
// asset to look like it has a kit — which is the whole licensing dodge (§4).

import { teamRating } from '../data/loader';
import type { TeamData } from '../data/types';
import { esc } from './escape';

/** Black or white, whichever survives on the given kit colour. */
export function readableOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return '#ffffff';
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#0a0d12' : '#ffffff';
}

function lum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return 0.5;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** A kit colour is rarely safe as its own trim — pick the readable partner. */
function trimOf(shirt: string, away: string): string {
  // the away colour makes the best trim when it actually contrasts
  const d = Math.abs(lum(shirt) - lum(away));
  if (d > 0.22) return away;
  return lum(shirt) > 0.55 ? '#141820' : '#f2f5fa';
}

/**
 * The shirt. One path for the garment, one for the sleeve shading, a collar
 * arc, a sash in the away colour and the squad number on the chest — 2KB of
 * SVG that reads as a football kit at a glance from the sofa.
 */
export function shirtSvg(team: TeamData, opts?: { num?: number; className?: string }): string {
  const shirt = team.kit.home;
  const away = team.kit.away;
  const trim = trimOf(shirt, away);
  const ink = readableOn(shirt);
  const num = opts?.num ?? 10;
  const id = `k${team.id.replace(/[^a-z0-9]/gi, '')}`;
  const body = 'M36 8 L50 2 Q60 13 70 2 L84 8 L116 30 L101 54 L92 47 L94 122 '
    + 'Q60 130 26 122 L28 47 L19 54 L4 30 Z';
  return `<svg class="${opts?.className ?? 'fe-shirt'}" viewBox="0 0 120 130" aria-hidden="true">
    <defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.26"/>
        <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.02"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.34"/>
      </linearGradient>
      <clipPath id="${id}c"><path d="${body}"/></clipPath>
    </defs>
    <path d="${body}" fill="${esc(shirt)}" stroke="rgba(0,0,0,0.55)" stroke-width="2"/>
    <g clip-path="url(#${id}c)">
      <path d="M-10 118 L130 44 L130 74 L-10 148 Z" fill="${esc(away)}" opacity="0.55"/>
      <rect x="0" y="0" width="120" height="130" fill="url(#${id}g)"/>
    </g>
    <path d="M50 2 Q60 13 70 2" fill="none" stroke="${esc(trim)}" stroke-width="7" stroke-linecap="round"/>
    <path d="M4 30 L19 54" fill="none" stroke="${esc(trim)}" stroke-width="5"/>
    <path d="M116 30 L101 54" fill="none" stroke="${esc(trim)}" stroke-width="5"/>
    <text x="60" y="92" text-anchor="middle" fill="${ink}" opacity="0.92"
      font-family="'Helvetica Neue',Helvetica,Arial,sans-serif" font-weight="700"
      font-size="40" letter-spacing="-2">${num}</text>
  </svg>`;
}

/** The little two-tone block that stands in for a crest in dense lists. */
export function crest(team: TeamData): string {
  return `<span class="fe-crest" style="background:linear-gradient(118deg,${esc(team.kit.home)} 0 58%,${esc(team.kit.away)} 58% 100%)"></span>`;
}

/** Five stars, filled to the team's tier. */
export function stars(tier: number): string {
  const n = Math.max(1, Math.min(5, Math.round(tier)));
  return `<span class="fe-stars">${'<i>★</i>'.repeat(n)}${'★'.repeat(5 - n)}</span>`;
}

/** 0-100 strength bar from the squad's actual overall rating. */
export function ratingBar(team: TeamData): string {
  const r = teamRating(team);
  // the squads sit in a 55-90 band; stretch it so the bar is not all-full
  const pct = Math.max(6, Math.min(100, Math.round((r - 48) * (100 / 42))));
  return `<div class="fe-bar"><i style="width:${pct}%"></i></div>`;
}

export function rating(team: TeamData): number {
  return Math.round(teamRating(team));
}
