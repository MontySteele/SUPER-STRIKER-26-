# ⚽ SUPER STRIKER '26

**A browser-based, PS3-era football game built to embarrass the official one.**

Runs locally at 60fps. No cloud streaming, no accounts, and
**0 microtransactions**. URL → kickoff in seconds. A friend on the other side
of the country can grab a controller with a four-letter room code — and even
*that* is peer-to-peer, with the whole simulation still running on one
machine.

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
- There is **no server component at all** any more, so `dist/` on a static
  host is the complete product, remote guests included.
- Versus comes in two flavours: couch co-op on the same machine (keyboard +
  gamepad, or two gamepads — four devices unlocks a **2v2** option), or
  **VERSUS — REMOTE** with friends on their own laptops (below). Remote and
  local players mix freely: any of the four seats takes either.

## Remote guest controllers

Pick **VERSUS — REMOTE** on the main menu, choose both teams, and you land on
an **INVITE PLAYERS** lobby: a four-letter room code in large type, the join
link, a QR code, and a live list of everyone who has connected. Your friend
opens `join.html?c=CODE`, types a name, and their laptop becomes a controller.
Give them a seat and kick off.

There are four seats: **P1/P2** are the two sides' on-ball players, **P3/P4**
their partners. Fill two and it's a 1v1; fill all four and it's a 2v2. Every
seat takes a local keyboard, a local pad, or a remote guest — the sim cannot
tell them apart.

In a 2v2 the two humans on a side never end up steering the same player. One
of them holds the man on the ball (auto-switching on turnovers, plus the
switch button as always); the other is handed the best-placed teammate for
what's happening — the covering defender when you're chasing the ball, an
advanced outlet about 14m off it when you're not — and keeps him until
somebody is clearly better placed. Switch onto your mate's man and the two of
you simply swap shirts.

The important part: **the simulation never leaves your machine.** Their page
draws no pitch, no ball, no scoreline — it is a controller and nothing else,
and everyone watches your screen (a shared video call is the usual
arrangement). That means no rollback, no prediction, no desync: there is only
ever one game state.

**How to run one:**

```bash
npm run build
npm run preview                 # serves dist/ on http://localhost:4173
# in a second terminal:
cloudflared tunnel --url http://localhost:4173
```

Send the `https://<random>.trycloudflare.com` link, open VERSUS — REMOTE, read
out the code. (Any static host works just as well — Cloudflare Pages, GitHub
Pages, a USB stick behind nginx. The game no longer needs a dev server for
anything.)

**How it works:** inputs ride a WebRTC DataChannel opened directly between the
two browsers, configured `ordered: false, maxRetransmits: 0` — a lost packet is
never retransmitted, because a 16ms-old input is worthless. The guest samples
at 60Hz and sends a **6-byte binary packet only when something actually
changes** (`seq: u16, buttons: u16, stickX: i8, stickY: i8`), plus a 10Hz
keepalive; no JSON is anywhere near the hot path. The host drops out-of-order
packets by sequence number, diffs the button field into press/release edges,
and feeds them into the same input hub a gamepad uses — past that point the
simulation genuinely cannot tell the difference. A tiny ping/pong on the same
channel gives the guest a real RTT read-out.

**Room codes** are four characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no
0/O/1/I/L to misread over a phone line). A new one is drawn every time the
lobby opens, and it dies the moment you leave.

**When someone drops out:** at 1.5s of silence their slot goes yellow on the
HUD; at 5s the match stops with a "P2 RECONNECTING…" toast; at 15s the AI
pulls the shirt on and play resumes. Reopening the join link puts them back in
the same slot (reserved by a token in their browser), and the AI hands the
shirt back at the next dead ball.

**The asterisk:** WebRTC needs a signaling handshake, and that goes through the
**free public PeerJS broker** — a third-party service with no uptime promise,
which sees a room id and nothing else. No game traffic ever touches it. If you
would rather not depend on it, run your own
[PeerServer](https://github.com/peers/peerjs-server) and add `?b=<origin>` to
the game URL (e.g. `?b=https://peer.example.com`); the join link carries the
setting across to your guest automatically. A self-hosted TURN relay for
players behind symmetric NATs is the documented next step if a direct
connection can't be made — the guest page says so plainly when it fails.

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
| Instant replay (last few seconds) | **R** (pad: Back) |
| Pause / quit | **Esc** (pad: Start) |

Gamepads are auto-detected (standard mapping: LS move, A pass, B loft, X shoot,
Y through, RT sprint, LB switch, Back replay, Start pause) — with **rumble**:
kicks, tackles, the post, and goals all speak through the pad. Menus: WASD + J
confirm, K back. On the full-time card, **L** replays the last goal.

**Defending:** when the other side wins the ball you're automatically handed
the best-placed defender (FIFA-style auto-switch — **Space** re-switches
manually). Run at the carrier and shoulder in to force the steal, **hold J**
to make your man chase the ball, or **L** for a slide tackle — through the
man is a foul, from behind is a card.

## Modes

- **Kick-Off** — 1P vs CPU, any two of the 48 teams.
- **Versus** — 2P couch play (§3.4): keyboard vs gamepad, or two gamepads.
  The thing the official game marketed and fumbled.
- **Versus — Remote** — the same 1v1 with your friend on their own laptop,
  joined by a four-letter room code over a direct peer-to-peer connection.
  Sim stays local; nobody needs an account.
- **Tournament** — the full 48-team format: 12 groups of 4, top two + 8 best
  third-placers into a 32-team knockout. Group tables and a broadcast-style
  bracket; every other match is simulated from team ratings. Knockout draws go
  to extra time, then penalties. A **Golden Boot** race tracks every scorer in
  the tournament — your goals count under their real scorers, simulated ones
  are attributed by position and star quality. Progress auto-saves to
  localStorage.
- **Golden Goal** — party mode: no clock, next goal wins, winner takes the
  bragging rights. 1P vs CPU by default; with a gamepad connected, flip the
  PLAYERS setting to 2P for keyboard-vs-pad couch play.
- **Penalty Shootout** — straight to the spot. Aim with the stick (the reticle
  fades at higher difficulty), hold shoot for power — full power risks blazing
  over. Human keeper picks a dive as they strike. Sudden death after 5.

## What's inside (M1–M5 of the spec)

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
- **The look:** PS3-confident rendering — an HDR post chain with exactly one
  filmic tone-map (bloom sees real radiance, so highlights bloom in colour
  instead of greying out), a procedural sky baked to a PMREM environment map
  for real reflected light, three-cascade shadows with self-shadowing players,
  and a single-owner lighting rig per time of day; striped pitch with worn
  goalmouths;
  terraced crowds; floodlight pylons; LED ad boards (CLAWDE SPORTS ·
  ANTHROPIC AIR); day / sunset / night kickoffs; three venues — Municipal 18k,
  National 45k, and the Mega Bowl 80k (tournament finals play there at night).
  Kit clashes are resolved like a real matchday: the away side switches to its
  change strip when colors collide, and both keepers pick loud kits that stand
  out from everyone on the pitch.
- **The broadcast:** smooth-damped side-on camera with **no hard cuts in open
  play**, a two-angle goal recap (celebration cam → behind-goal replay →
  pitch-level super-slow-mo, letterbox + REPLAY bug), on-demand instant replay
  (**R**) of the last six seconds with a comet trail on the ball, half-time /
  full-time cards with a match story timeline (goals and cards on a minute
  line), a **★ Man of the Match** award, possession, shots, corners and fouls,
  a pre-match TACTICS strip naming each side's style and
  star man, a glossy score bug, and an always-correct ticker. And from the
  moment it loads, an **attract mode**: a live CPU-vs-CPU match plays behind
  the menus, arcade-classic style.
- **The voice:** real speech-synthesis commentary (browser SpeechSynthesis —
  still zero assets) calling goals by name, saves, cards, penalties and the
  final whistle, with priority rules so the big calls interrupt the small
  ones. Voice quality varies by machine, so it lives behind a COMMENTARY
  toggle in match settings.
- **The sound:** fully synthesized Web Audio — layered crowd conductor driven
  directly by game state (murmur → anticipation → roar/groan), terrace
  clap-chants when the game heats up, a stadium air-horn on goals, kick
  thumps, net swish, pea-whistle, the sacred post *DOINK*, the crowd holding
  its breath before every penalty, and two synthesized music loops — a
  big-beat menu anthem and a leaner in-match groove that sits under the crowd
  (MUSIC setting: ON / MENUS ONLY / OFF). Zero audio assets.
- **The data:** all 48 teams live in `src/data/teams.json` — real 2026 World
  Cup squads with per-player ratings and one star player per team (gold ring,
  +10 ratings). Don't like the roster? **EDIT TEAMS** on the main menu opens a
  full roster editor — rename anyone, crank ratings, hand out extra stars.
  Edits save to your browser and every mode uses them; RESET TO FACTORY
  restores the real squad any time.

## Match settings

4 / 6 / 10 minute matches, three difficulties (Amateur / Pro / Legend — the CPU
thinks better, the game never cheats physics), and three kickoff times.

**GRAPHICS** picks the renderer: **HIGH** is the full stack (3 shadow cascades,
MSAA + SMAA, HDR bloom, colour grade, PMREM sky). **MEDIUM** keeps the lighting
model but halves the expensive bits (2 cascades, half-res bloom, FXAA, no
grade). **RETRO (v1.1)** is not a potato mode — it's the pre-uplift look kept
alive on purpose, one shadow map and all. Whatever you pick, a struggling
machine gives up *pixels* first: resolution steps down under sustained frame
pressure and climbs back when it can. Features are never switched off behind
your back.

## Dev

```bash
npx tsx scripts/simTest.ts   # headless sims: league, knockouts+shootouts, tournament
npx tsx scripts/netTest.ts   # remote-guest wire protocol, edge synthesis, seat swap
npx tsx scripts/versusTest.ts # 2v2 seat slots, paired-human switch arbitration
npx tsc --noEmit             # typecheck
```

### Capture harness (§7A.9)

The graphics quality gate: a fixed list of shots, each pinned to a seed, a
sim-frame timestamp and a camera pose, rendered headlessly. Same commit +
same shot name = the same pixels, so a graphics change is a PNG diff.

```bash
npm run capture                 # every shot → captures/ + captures/stats.json
npm run capture -- --list       # the shot list and what each one is for
npm run capture -- --shots midfield_wide --out /tmp/after
npm run shoot-player -- --team arg   # four studio angles of one player model
```

The shot contract lives in `src/tools/shots.json`; editing a seed, a frame
count or a pose invalidates every baseline taken before it. The game itself
enters capture mode via `index.html?capture=<shot>` (menus, attract mode and
audio are bypassed), and `viewer.html?team=bra&angle=side` is the standalone
character viewer — open it with no `angle` for a live turntable.

Architecture: `src/sim` (fixed 60Hz deterministic simulation, tournament
engine, penalty controller), `src/render` (Three.js, interpolated),
`src/ui` (HTML/CSS overlay + the invite lobby), `src/audio` (Web Audio
synthesis), `src/input` (seat-based, local and remote players are the same
thing by the time the sim sees them), `src/net` (WebRTC guest link and wire
protocol), `src/join` (the guest's controller page), `src/data`.

Built from `SUPERSTRIKER_SPEC.md`. Milestones M1–M4 are in. M5 stretch goals
(Golden Goal, roster editor UI, replay theater) remain.
