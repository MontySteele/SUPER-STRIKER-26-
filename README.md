# ⚽ SUPER STRIKER '26

**A browser-based, PS3-era football game built to embarrass the official one.**

Runs locally at 60fps. No cloud streaming, no phone-as-controller, no accounts,
no QR codes, and **0 microtransactions**. URL → kickoff in seconds.

## Play it

```bash
npm install
npm run dev        # → http://localhost:5173
```

Or build a static bundle (~190 KB gzipped, no server needed):

```bash
npm run build && npm run preview
```

## Controls (keyboard)

| Action | Key |
|---|---|
| Move | WASD / Arrows |
| Short pass / Pressure (defense) | **J** |
| Lofted pass / Cross | **K** |
| Shoot (hold for power) / Slide tackle | **L** |
| Through ball | **I** |
| Sprint | **Shift** (hold) |
| Switch player | **Space** |

Gamepads are auto-detected (standard mapping: LS move, A pass, B loft, X shoot,
Y through, RT sprint, LB switch). Menus: WASD + J confirm, K back.

## What's inside (M1–M3 of the spec)

- **The feel:** 150ms input buffering, cone-based pass assist, hold-to-power
  shots with an honest error model, sprint knock-ons. The ball is a real
  physics object (gravity, drag, Magnus curl, bounce) — never glued to feet,
  so tackles and loose balls are emergent.
- **The AI:** elastic-formation team shape driven by `formations.json`, CPU
  decision ticks with style bias and rating-scaled noise (Brazil plays sharp,
  minnows play honest), defenders that contain/press/hold a line, and a real
  goalkeeper state machine (`POSITION → SET → REACT → DIVE/CLAIM/PARRY`) whose
  reaction time scales with the Keeping stat. Parries create rebounds. Rebounds
  create drama.
- **The rules:** kickoffs, goals, throw-ins, corners, goal kicks, offside
  (line check at the pass), halves and a broadcast clock.
- **The look:** PS3-confident rendering — per-pixel lighting, real shadows,
  bloom, vignette, filmic tone mapping; striped pitch with worn goalmouths;
  three-tier stands with terraced crowds; floodlight pylons; LED ad boards
  (CLAWDE SPORTS · ANTHROPIC AIR); day / sunset / night kickoffs.
- **The broadcast:** smooth-damped side-on camera with **no hard cuts in open
  play**, goal sequence (celebration cam → low corner replay with letterbox +
  REPLAY bug → wipe back), glossy score bug, always-correct ticker instead of
  fake commentary.
- **The sound:** fully synthesized Web Audio — layered crowd conductor driven
  directly by game state (murmur → anticipation → roar/groan), kick thumps,
  net swish, pea-whistle, and the sacred post *DOINK*. Zero audio assets.
- **The data:** all 48 teams live in `src/data/teams.json` — real 2026 World
  Cup squads with per-player ratings and one star player per team (gold ring,
  +10 ratings). Don't like the roster? Edit the JSON and put yourself up front.

## Match settings

4 / 6 / 10 minute matches, three difficulties (Amateur / Pro / Legend — the CPU
thinks better, the game never cheats physics), and three kickoff times.

## Dev

```bash
npx tsx scripts/simTest.ts   # headless CPU-vs-CPU sim: balance + stability
npx tsc --noEmit             # typecheck
```

Architecture: `src/sim` (fixed 60Hz deterministic simulation),
`src/render` (Three.js, interpolated), `src/ui` (HTML/CSS overlay),
`src/audio` (Web Audio synthesis), `src/input`, `src/data`.

Built from `SUPERSTRIKER_SPEC.md`. Milestones M1–M3 are in; Tournament mode,
penalties, 2P couch play and cards/fouls (M4) are next.
