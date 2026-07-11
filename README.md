# ⚽ SUPER STRIKER '26

**A browser-based, PS3-era football game built to embarrass the official one.**

Runs locally at 60fps. No cloud streaming, no phone-as-controller, no accounts,
no QR codes, and **0 microtransactions**. URL → kickoff in seconds.

## Play it

```bash
npm install
npm run dev        # → http://localhost:5173
```

Or build a static bundle (~200 KB gzipped, no server needed):

```bash
npm run build && npm run preview
```

## Host it for a friend (Cloudflare tunnel)

The build is fully static and self-contained (relative asset paths, zero CDN
or font requests), so any https origin works. To let someone play from your
laptop without deploying anything:

```bash
npm run build
npm run preview                 # serves dist/ on http://localhost:4173
# in a second terminal:
cloudflared tunnel --url http://localhost:4173
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL — send that
link. Notes:

- **Quick tunnels get a new random URL every run**, and tournament saves live
  in the browser's localStorage *per origin* — so a save made on one tunnel
  URL won't appear on tomorrow's URL. For a single game night this is fine;
  for anything longer, use a named tunnel (stable hostname) or just deploy
  `dist/` to any static host (Cloudflare Pages / GitHub Pages — it's one
  folder).
- Everything runs client-side: the tunnel only serves ~200 KB once, then the
  laptop can even go to sleep. No latency concerns — the game runs on the
  player's machine.
- 2-player Versus is couch co-op **on the same machine**: keyboard + a USB/BT
  gamepad, or two gamepads, plugged into whichever device opened the link.

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
| Pause / quit | **Esc** (pad: Start) |

Gamepads are auto-detected (standard mapping: LS move, A pass, B loft, X shoot,
Y through, RT sprint, LB switch). Menus: WASD + J confirm, K back.

## Modes

- **Kick-Off** — 1P vs CPU, any two of the 48 teams.
- **Versus** — 2P couch play (§3.4): keyboard vs gamepad, or two gamepads.
  The thing the official game marketed and fumbled.
- **Tournament** — the full 48-team format: 12 groups of 4, top two + 8 best
  third-placers into a 32-team knockout. Group tables and a broadcast-style
  bracket; every other match is simulated from team ratings. Knockout draws go
  to extra time, then penalties. Progress auto-saves to localStorage.
- **Penalty Shootout** — straight to the spot. Aim with the stick (the reticle
  fades at higher difficulty), hold shoot for power — full power risks blazing
  over. Human keeper picks a dive as they strike. Sudden death after 5.

## What's inside (M1–M4 of the spec)

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
  (line check at the pass), halves and a broadcast clock — plus fouls: slide
  tackles that go through the man give free kicks, from behind risk yellow /
  red cards (two yellows and you're off), and in the box it's a penalty.
- **The look:** PS3-confident rendering — per-pixel lighting, real shadows,
  bloom, vignette, filmic tone mapping; striped pitch with worn goalmouths;
  terraced crowds; floodlight pylons; LED ad boards (CLAWDE SPORTS ·
  ANTHROPIC AIR); day / sunset / night kickoffs; three venues — Municipal 18k,
  National 45k, and the Mega Bowl 80k (tournament finals play there at night).
- **The broadcast:** smooth-damped side-on camera with **no hard cuts in open
  play**, goal sequence (celebration cam → low corner replay with letterbox +
  REPLAY bug → wipe back), glossy score bug, always-correct ticker instead of
  fake commentary.
- **The sound:** fully synthesized Web Audio — layered crowd conductor driven
  directly by game state (murmur → anticipation → roar/groan), kick thumps,
  net swish, pea-whistle, the sacred post *DOINK*, the crowd holding its
  breath before every penalty, and a big-beat menu music loop. Zero audio
  assets.
- **The data:** all 48 teams live in `src/data/teams.json` — real 2026 World
  Cup squads with per-player ratings and one star player per team (gold ring,
  +10 ratings). Don't like the roster? Edit the JSON and put yourself up front.

## Match settings

4 / 6 / 10 minute matches, three difficulties (Amateur / Pro / Legend — the CPU
thinks better, the game never cheats physics), and three kickoff times.

## Dev

```bash
npx tsx scripts/simTest.ts   # headless sims: league, knockouts+shootouts, tournament
npx tsc --noEmit             # typecheck
```

Architecture: `src/sim` (fixed 60Hz deterministic simulation, tournament
engine, penalty controller), `src/render` (Three.js, interpolated),
`src/ui` (HTML/CSS overlay), `src/audio` (Web Audio synthesis), `src/input`
(seat-based, up to 2 local players), `src/data`.

Built from `SUPERSTRIKER_SPEC.md`. Milestones M1–M4 are in. M5 stretch goals
(Golden Goal, roster editor UI, replay theater) remain.
