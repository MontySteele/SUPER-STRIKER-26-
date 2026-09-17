// The baked-commentary asset bank: loads public/audio/commentary.json, pulls
// the Opus sprites it needs, and turns a Cue from the director into a concrete
// list of audio slices to play back to back.
//
// Every clip lives inside a sprite (one Opus stream per category, plus one per
// team for that squad's surnames), so a match downloads ~10 small files rather
// than 1700. Slicing is free: AudioBufferSourceNode.start(when, offset, dur).
//
// Everything here is best-effort. If the manifest is absent (the bake output
// may be gitignored on a fresh clone) the bank simply reports `ready === false`
// and the commentary engine goes quiet — the game must never fail to start
// because a voice pack is missing.

import type { Cue } from './commentaryScript';

type Part = { c: string } | { s: string };

interface Variant { parts: Part[]; text: string }

export interface CommentaryManifest {
  version: number;
  engine: string;
  voices: Record<string, string>;
  sampleRate: number;
  base: string;
  gap: number;
  sprites: Record<string, { file: string; dur: number; bytes: number }>;
  /** clip id -> [sprite key, offset ms, duration ms] */
  clips: Record<string, [string, number, number]>;
  groups: Record<string, { voice: string; pri: number; variants: Variant[] }>;
  numbers: Record<string, string>;
  names: Record<string, { team: string; players: Record<string, string> }>;
  /** group -> slot-free stand-in, taken when no variant can be voiced */
  fallback?: Record<string, string>;
}

/** One resolved slice of a sprite, ready to schedule. */
export interface Segment {
  buffer: AudioBuffer;
  offset: number;
  duration: number;
}

export interface Utterance {
  segments: Segment[];
  /** total wall time including the splice gaps */
  duration: number;
  /** what it says, for the dry-run log and debugging */
  text: string;
  voice: string;
}

/** Gap inserted between two spliced fragments — a breath, not a pause. */
const SPLICE_GAP = 0.045;

function manifestUrl(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}audio/commentary.json`;
}

export class CommentaryBank {
  manifest: CommentaryManifest | null = null;
  /** true once the manifest is in hand; false means "stay silent". */
  ready = false;
  failed = false;
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private loading: Promise<void> | null = null;
  /** last variant played per group — variety insurance across a whole match */
  private recent = new Map<string, number>();

  /** Fetch the manifest once. Never throws. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await fetch(manifestUrl());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const m = (await res.json()) as CommentaryManifest;
        if (!m?.clips || !m?.groups) throw new Error('malformed manifest');
        this.manifest = m;
        this.ready = true;
      } catch (err) {
        this.failed = true;
        console.info('commentary: no voice pack, staying quiet —', String(err));
      }
    })();
    return this.loading;
  }

  /** Sprite keys a match needs: every line sprite plus the two squads' names. */
  spriteKeysFor(teamIds: string[]): string[] {
    const m = this.manifest;
    if (!m) return [];
    const keys = Object.keys(m.sprites).filter((k) => !k.startsWith('name.'));
    for (const id of teamIds) {
      const k = `name.${id}`;
      if (m.sprites[k]) keys.push(k);
    }
    return keys;
  }

  /** Warm the sprites for a match. Resolves when the audio is decodable. */
  async prefetch(ctx: BaseAudioContext, teamIds: string[]): Promise<void> {
    await this.load();
    if (!this.ready) return;
    await Promise.all(this.spriteKeysFor(teamIds).map((k) => this.sprite(ctx, k)));
  }

  private sprite(ctx: BaseAudioContext, key: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(key);
    if (have) return Promise.resolve(have);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const m = this.manifest;
    const entry = m?.sprites[key];
    if (!m || !entry) return Promise.resolve(null);
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const p = (async () => {
      try {
        const res = await fetch(`${base}${m.base}${entry.file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(key, buf);
        return buf;
      } catch (err) {
        console.warn(`commentary: sprite ${key} failed —`, String(err));
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  /** Sprite already decoded? Resolution is synchronous, so this gates it. */
  private clip(id: string): Segment | null {
    const m = this.manifest;
    const c = m?.clips[id];
    if (!m || !c) return null;
    const buf = this.buffers.get(c[0]);
    if (!buf) return null;
    return { buffer: buf, offset: c[1] / 1000, duration: c[2] / 1000 };
  }


  /**
   * Pick a variant of the cue's group that this bank can actually voice and
   * splice it together. Variants whose slots are unresolvable (an edited
   * roster name that was never baked) are skipped, so a renamed striker costs
   * you a line flavour, not the goal call.
   */
  resolve(cue: Cue, teamIds: string[], rand: () => number,
          teamNames?: string[]): Utterance | null {
    const m = this.manifest;
    if (!m) return null;
    const plan = planUtterance(m, cue, teamIds, rand,
      (sprite) => this.buffers.has(sprite), teamNames, this.recent);
    if (!plan) return null;
    const segments = plan.clipIds.map((id) => this.clip(id)).filter((s): s is Segment => !!s);
    if (segments.length !== plan.clipIds.length) return null;
    return { segments, duration: plan.duration, text: plan.text, voice: plan.voice };
  }

  /** Schedule an utterance on `dest` starting at `when`. Returns its end time. */
  play(ctx: AudioContext, dest: AudioNode, u: Utterance, when: number,
       onEnd: () => void): () => void {
    let t = when;
    const sources: AudioBufferSourceNode[] = [];
    for (const seg of u.segments) {
      const src = ctx.createBufferSource();
      src.buffer = seg.buffer;
      src.connect(dest);
      src.start(t, seg.offset, seg.duration);
      sources.push(src);
      t += seg.duration + SPLICE_GAP;
    }
    const lastSrc = sources[sources.length - 1];
    let done = false;
    lastSrc.onended = () => { if (!done) { done = true; onEnd(); } };
    return () => {
      if (done) return;
      done = true;
      for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } }
    };
  }

  /** Splice gap, exposed so the dry-run log can quote real timings. */
  static get spliceGap(): number { return SPLICE_GAP; }
}

/** A line chosen and timed from the manifest alone — no decoded audio needed. */
export interface UtterancePlan {
  clipIds: string[];
  duration: number;
  text: string;
  voice: string;
}

/**
 * The variant chooser, split out so the headless pacing harness
 * (pipeline/audio/dryrun.ts) exercises exactly the same selection and timing
 * rules the game does, in node, with no Web Audio anywhere.
 *
 * `available` reports whether a sprite is playable right now; the runtime
 * passes "is it decoded", the harness passes "always".
 */
export function planUtterance(
  m: CommentaryManifest, cue: Cue, teamIds: string[], rand: () => number,
  available: (sprite: string) => boolean = () => true,
  displayNames?: string[],
  /** group -> last variant index used, so he never says it twice running */
  recent?: Map<string, number>,
): UtterancePlan | null {
  const plan = planGroup(m, cue.group, cue, teamIds, rand, available, displayNames, recent);
  if (plan) return plan;
  // A name the bake never saw (a roster edit, an accent stripped) must not cost
  // the goal call itself: take one hop to the group's slot-free stand-in.
  const alt = m.fallback?.[cue.group];
  if (!alt || alt === cue.group) return null;
  return planGroup(m, alt, cue, teamIds, rand, available, displayNames, recent);
}

function planGroup(
  m: CommentaryManifest, groupName: string, cue: Cue, teamIds: string[],
  rand: () => number, available: (sprite: string) => boolean,
  displayNames: string[] | undefined, recent: Map<string, number> | undefined,
): UtterancePlan | null {
  const group = m.groups[groupName];
  if (!group || !group.variants.length) return null;
  const slotClip = (key: string): string | null => {
    const slot = cue.slots[key];
    if (!slot) return null;
    if (slot.kind === 'num') {
      return m.numbers[String(Math.max(0, Math.min(10, slot.value)))] ?? null;
    }
    const squad = m.names[teamIds[slot.teamIdx]];
    if (!squad) return null;
    return slot.kind === 'team' ? squad.team : squad.players[slot.name] ?? null;
  };
  const lastUsed = recent?.get(groupName);
  const order = shuffled(group.variants.length, rand);
  // push the line he just used to the back of the queue rather than banning it
  if (group.variants.length > 1 && lastUsed !== undefined) {
    const at = order.indexOf(lastUsed);
    if (at >= 0) order.push(...order.splice(at, 1));
  }
  for (const vi of order) {
    const v = group.variants[vi];
    const clipIds: string[] = [];
    let ok = true;
    for (const part of v.parts) {
      const id = 'c' in part ? part.c : slotClip(part.s);
      const entry = id ? m.clips[id] : undefined;
      if (!id || !entry || !available(entry[0])) { ok = false; break; }
      clipIds.push(id);
    }
    if (!ok || !clipIds.length) continue;
    const duration = clipIds.reduce((a, id) => a + m.clips[id][2] / 1000, 0)
      + SPLICE_GAP * (clipIds.length - 1);
    recent?.set(groupName, vi);
    return { clipIds, duration, text: fillText(v.text, cue, displayNames ?? teamIds), voice: group.voice };
  }
  return null;
}

/** The template with its slots filled in — for logs, not for playback. */
export function fillText(tpl: string, cue: Cue, names?: string[]): string {
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const s = cue.slots[key];
    if (!s) return whole;
    if (s.kind === 'num') return String(s.value);
    if (s.kind === 'team') return names?.[s.teamIdx] ?? `team${s.teamIdx}`;
    return s.name;
  });
}

function shuffled(n: number, rand: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
