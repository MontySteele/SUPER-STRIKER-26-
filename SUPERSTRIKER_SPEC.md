# SUPER STRIKER '26 — Design Specification
### A browser-based, PS3-era football game built to embarrass the official one

**Version:** 1.0 (Design phase — pre-implementation)
**Target platform:** Desktop web browser (Chrome/Firefox/Safari), keyboard + gamepad
**Tech:** Three.js (WebGL), vanilla TypeScript, Web Audio API. No server. No login. No phone-as-controller. It just runs.

---

## 1. Vision Statement

The official FIFA World Cup: Launch Edition failed because it aimed at realism and missed. It has stiff animations, brain-dead AI, laggy cloud streaming, a touchpad "controller" with zero tactile feedback, two game modes, commentary out of sync with play, and hard cuts between every sequence.

**Super Striker '26 wins by inverting every one of those failures:**

| Their failure | Our counter |
|---|---|
| Cloud-streamed, input lag | Runs locally at 60fps, zero latency |
| Phone touchpad controller | Keyboard + any gamepad, instant response, 2P couch play on one machine |
| Failed photorealism | Confident PS3-era rendering (FIFA 09–12 vibe) with a stylized anchor. It looks *intentional* |
| Through-ball exploit, useless keepers | Tuned AI with actual defensive positioning and a keeper state machine |
| Jarring hard cuts everywhere | Continuous camera, replays, kit-cam celebrations, smooth transitions |
| Two modes | Kick-off, 48-team Tournament, Penalty Shootout, 2P Versus, Golden Goal party mode |
| Commentary desynced and wrong | No fake commentary. Reactive crowd audio + a broadcast-style ticker that is always correct |
| Licensed but soulless | Unlicensed but full of soul: 48 fictional-but-obvious nations, editable rosters, unlockable mascots |

**Design north star:** *"One more match."* Every decision is judged by whether it makes a 5-minute match feel snappy, readable, and dramatic.

---

## 2. Design Pillars

1. **Feel first.** Input-to-action latency under 50ms. Passing must feel like flicking a marble, not filing a request.
2. **Readable at a glance.** Big heads-lite proportions, high-contrast kits, thick ball, obvious player-switch indicator. Your dad can follow the action from the couch.
3. **PS3 confidence.** ~4k–8k triangles per player, per-pixel lighting, normal maps, real shadows, bloom. We're quoting FIFA 09–12 and PES 2011 — the era when football games looked *good* — while keeping stylized proportions so we never drift into the uncanny middle where the official game died.
4. **Drama engineering.** Late goals, comebacks, penalties — the systems should manufacture stories, not just simulate football.
5. **Zero friction.** URL → kickoff in under 15 seconds. No accounts, no downloads, no QR codes. This is the anti-Netflix-game.

---

## 3. Game Modes

### 3.1 Kick-Off (MVP)
Pick two teams, pick a stadium, play a match. Match length: 4 / 6 / 10 real minutes (default 6, split into halves). Human vs CPU or Human vs Human.

### 3.2 Tournament (MVP+1)
The full 48-team format: 12 groups of 4, top two + best third-placers advance to a 32-team knockout. Simulated results for all non-player matches (lightweight sim using team ratings + randomness). Bracket screen in glorious 2002-broadcast style. Knockout draws go to extra time → penalties.

### 3.3 Penalty Shootout (MVP)
Standalone mode. Also invoked by tournament draws. See §6.5.

### 3.4 Versus (MVP)
Local 2-player: keyboard vs gamepad, or two gamepads. Same-machine couch play is a headline feature — it's the one thing the Netflix game marketed and fumbled.

### 3.5 Golden Goal (stretch)
Party mode: next goal wins, both teams' stats boosted, keepers slightly nerfed. 2-minute chaos rounds.

---

## 4. Teams & Data (the licensing dodge)

No FIFA license, and we don't want one. 48 fictional nations that are *legally distinct but emotionally identical*:

- Names are real countries (nothing protectable about "Brazil" or "Japan" as national teams in a fan game with fictional players) — but **players are procedurally generated fictional names** plausible for each nation (name-syllable banks per region).
- Each team: 23-player squad, per-player ratings (Pace, Shooting, Passing, Defending, Keeping, Stamina — 1–99), one designated **Star Player** with a visual flair (glow trail on sprint) and +10 ratings.
- Team-level identity: kit colors (primary/away), formation default, style bias (possession / counter / long-ball) that tunes the AI.
- **All data lives in one editable JSON file.** Power move for the demo: "Don't like the roster? Open teams.json and put yourself up front for Brazil." An in-game roster editor is a stretch goal; the JSON is the MVP editor.

Squad structure per team (MVP simplification): 1 GK, 4 DF, 4 MF, 2 FW on pitch; formations from a fixed set (4-4-2, 4-3-3, 3-5-2, 5-3-2, 4-2-3-1).

---

## 5. Controls

Two players max locally. All bindings shown on a pause-screen controls card.

### Keyboard (P1 default)
| Action | Key |
|---|---|
| Move | WASD / Arrows |
| Short pass / Pressure (def.) | J |
| Lofted pass / Cross / Header | K |
| Shoot (hold to power) / Slide tackle | L |
| Through ball | I |
| Sprint | Shift (hold) |
| Switch player (defense) | Space |
| Tactics quick-menu | Tab (hold) |

### Gamepad (auto-detected, Gamepad API)
Standard mapping: LS move, A pass, X shoot, B lofted, Y through, RT sprint, LB switch. Rumble on goals/tackles where supported.

### Control feel rules (non-negotiable)
- **Pass assist:** passes snap to the best teammate within a 30° cone of the stick direction, weighted by distance and lane openness. Manual-feeling, never random.
- **Shot model:** hold-to-power (max 0.8s), direction from stick at release, accuracy penalty at full power and when off-balance. Finesse = tap.
- **Buffering:** inputs buffer 150ms so a pass queued during a receive animation fires the instant the touch completes. This single rule is 50% of "game feel."
- **Player switch:** on defense, Space/LB switches to best-positioned defender (not merely nearest). Auto-switch on interception. Switch indicator: chunky gold triangle + player name plate.

---

## 6. Match Simulation & AI

This is where the official game died. Ours must be *legibly smart*, not deep.

### 6.1 The ball
A real physics object (sphere, gravity, drag, Magnus-lite curl on driven shots, bounce restitution ~0.65, ground friction). The ball is never glued to feet: dribbling = repeated small touches ahead of the runner. This one choice makes tackles, interceptions, and loose balls emergent instead of scripted.

### 6.2 Outfield player AI — two layers
**Layer 1: Team shape.** Each formation defines home coordinates as fractions of pitch space. Every off-ball player continuously blends toward: `home position + (ball position × role-specific pull) + phase offset (attacking/defending)`. This is the classic "elastic formation" model — cheap, and it looks like organized football.

**Layer 2: Role behaviors (state machines).**
- **On-ball CPU:** evaluate ~5 options each decision tick (0.3s): safe pass, forward pass, through ball, dribble, shoot. Scored by openness, danger, distance to goal, and team style bias. Deliberately imperfect: decision noise scales inversely with team rating, so Brazil plays sharp and minnows play honest.
- **Defenders:** contain (stay goal-side, mirror), press (closest man + one cover), intercept lanes. **Through-ball counter:** center-backs track runners and hold a defensive line with an offside-trap check — this directly patches the exploit that broke the official game.
- **Attackers:** make runs (near-post, far-post, channel) triggered when the ball-carrier crosses trigger zones. Curved runs, staying onside via a line-check.

### 6.3 Goalkeeper (deserves its own section, because Netflix's keepers were a meme)
Dedicated state machine: `POSITION → SET → REACT → DIVE/CLAIM/PARRY → RECOVER`.
- Positioning: bisect the ball-to-goal angle, depth by ball distance.
- Reaction: when a shot is struck, keeper gets a reaction delay inversely proportional to Keeping stat (180–320ms), then dives to intercept the predicted ball path. Saves can parry into danger — rebounds create drama.
- Claims crosses inside the 6-yard box if unchallenged; punches under pressure.
- 1v1s: closes down to narrow the angle. Chip shots exist specifically to punish over-eager keepers — risk/reward both ways.

### 6.4 Rules (MVP scope)
Kickoff, goals, throw-ins, goal kicks, corners, fouls with free kicks, penalties (in-box fouls), offside (line check at pass moment), yellow/red cards (slide tackles from behind risk cards). **No** advantage rule, VAR, or injuries in MVP. Set pieces use a simple aim-and-power interface with the same shot controls — no separate minigame.

### 6.5 Penalties
Shooter: aim with stick (visible-ish reticle that fades at higher difficulty), hold for power; full power risks blazing over. Keeper (human): pick a dive direction just before contact. Keeper (CPU): reads shooter tendencies with slight bias randomness. Sudden death after 5. Crowd audio holds its breath (duck the mix) before each kick.

### 6.6 Difficulty
Amateur / Pro / Legend. Scales: CPU decision noise, keeper reaction delay, pass-assist strength for the human, and CPU sprint stamina. Never scales: ball physics or rules — the game is never allowed to cheat physically, only think better.

---

## 7. Presentation & Art Direction

### 7.1 The PS3 look (a style guide, not an excuse)
**Reference set:** FIFA 09–12, PES 2011, the 720p broadcast era. The rule that keeps us safe from the uncanny middle: **realistic *rendering*, stylized *content*.** Materials, lighting, and post-processing go full PS3; proportions, faces, and animation stay confidently game-y.

- **Players:** 4k–8k tris, skinned with ~35-bone skeletons (adds fingers-as-mitts, head/neck detail). 512×512 kit textures with normal + specular maps (fabric weave, shirt sponsor-free front, printed name/number on back from the roster data). Faces: shared stylized head base with per-player skin tone, hair mesh (10 variants), and facial-hair decal — deliberately NOT attempting likenesses; that's the uncanny trap. Proportions ~5% stylized (slightly broader silhouettes) for readability.
- **Lighting:** directional sun/floodlight key + hemisphere ambient, per-pixel Blinn-Phong (Three.js standard/phong materials), one cascaded shadow map covering the active play area — real dynamic player shadows are the single biggest "PS3 not PS2" tell.
- **Post-processing:** bloom (floodlight glow, white-kit shimmer), subtle vignette, filmic tone-mapping with a slightly punchy color grade, FXAA. Optional per-object motion blur on the ball only. This stack is what sells the broadcast look.
- **Pitch:** tiled grass texture with normal map, mowed stripes, worn goalmouth blend decals, screen-space-cheap specular sheen that catches the floodlights. Ball gets a real contact shadow.
- **Stadiums:** 3 tiers (Mega Bowl 80k / National 45k / Municipal 18k), now with modeled lower-bowl geometry near the pitch and billboard crowd in upper tiers (lit to match time of day). Animated LED ad boards around the pitch (fake sponsors: "CLAWDE SPORTS", "ANTHROPIC AIR"). Skyboxes: day, sunset, night-floodlights with volumetric-ish light shafts (billboard cheat).
- **UI:** late-2000s broadcast package. Glossy dark score bug with team color accents, clean sans-serif (Helvetica-adjacent), lens-flare wipe transitions, letterboxed replay frames with a "REPLAY" corner bug. Menu: dark UI with depth-of-field 3D player render backdrop, licensed-soundtrack-energy instrumental loop (big-beat/electro).

### 7.2 Camera & flow (fixing the "jarring cuts" complaint)
- Match camera: classic elevated broadcast side-on, smooth-damped follow, slight zoom-out when play stretches.
- **No hard cuts during open play, ever.** Dead balls (throw-ins, corners) get a 0.6s broadcast wipe. Goals trigger: slow-mo of ball crossing line → celebration cam (3 canned celebrations) → auto-replay from a second angle → wipe back to kickoff. Skippable with any button.
- Half-time: stats card (possession, shots, on-target) over a stadium beauty shot.

### 7.3 Audio (Web Audio API)
- **Crowd is the commentator.** Layered loops: ambient murmur → rising anticipation (attack enters final third) → roar (shot) → eruption or groan. Ducking and swells driven directly by game state, so it is *always in sync* — the thing commentary in the official game failed at.
- Chants: 2 generic loops per team pitched/tempo-varied; home team louder.
- SFX: 3 kick weights, net swish, whistle set, post *DOINK* (sacred), tackle thumps.
- Ticker instead of commentary: broadcast-style lower-third text events ("34' — CLOSE! Okafor rattles the bar!"). Correct, cheap, charming. Synthesized speech is a stretch goal, explicitly not MVP.

---

## 8. Technical Architecture

- **Stack:** TypeScript + Three.js + Vite. No game engine — we want full control of the loop and tiny bundle size (<15MB total, target <5s load on average broadband).
- **Loop:** fixed-timestep simulation at 60Hz, render interpolated. Deterministic sim step (seedable RNG) → makes replays free: record inputs/states in a ring buffer, re-render from a different camera.
- **Structure (suggested modules for Claude Code):**
  - `sim/` — ball physics, player entities, AI (team shape, roles, keeper), rules/referee, match state machine
  - `render/` — scene setup, player mesh/animation system, stadium, camera director, VFX (flares, confetti)
  - `ui/` — menus, HUD score bug, ticker, transitions (HTML/CSS overlay, not in-canvas — faster to build, crisper text)
  - `audio/` — crowd conductor, SFX bank, music
  - `data/` — teams.json, formations.json, name banks
  - `input/` — keyboard + Gamepad API abstraction, 2-player assignment
- **Animation:** hand-authored clip set (idle, walk, run, sprint, pass, lofted pass, shoot, slide, header, GK dive L/R/collect, 3 celebrations, jog-back) with crossfade blending plus two PS3-era upgrades: a run/sprint blend tree driven by speed, and an additive upper-body layer so players can look at the ball while running. Land the *timing* (ball leaves foot on the contact frame) above all — smoothness never beats responsiveness; if a blend adds input latency, cut the blend.
- **Performance budget:** 22 skinned players + ball + stadium ≤ 600k tris, one shadow cascade, half-res bloom, one draw call per crowd block. Target 60fps on a mid-range discrete GPU / Apple Silicon; ship a graphics toggle (High = full post stack, Medium = no bloom/FXAA, Low = PS2 mode: blob shadows + vertex-lit — our original art direction lives on as the potato setting). Resolution scale slider (0.5–1.0) as the universal escape hatch.

---

## 9. Build Milestones (Claude Code roadmap)

**M1 — The Feel Prototype (build this first, judge everything here):**
Flat green plane, capsule players, physics ball, one human team vs static dummies. Move, pass with assist, sprint, shoot at an empty net. *Gate: does passing feel great? Iterate until yes.*

**M2 — A Real Match:** Full 11v11, team-shape AI, keeper v1, rules v1 (goals, out of bounds, kickoff), HUD score/clock, broadcast camera. Playable Kick-Off vs CPU.

**M3 — It Looks Like a Game:** Player models + animation set (build at PS2 fidelity first, then upsell: normal maps, shadow cascade, post stack — the render pipeline upgrade is a discrete sub-task, not a rewrite), one stadium, crowd sprites + crowd audio conductor, goal sequence with replay, menus with team select. *Gate: side-by-side screenshot next to the Netflix game must win on vibes.*

**M4 — It's a Product:** All 48 teams data, Tournament mode + bracket UI, penalties, cards/fouls/offside, 2-player local, difficulty levels, 2 more stadiums, polish pass (transitions, ticker, music).

**M5 — Stretch:** Golden Goal mode, roster editor UI, speech-synth commentary experiment, replay theater, unlockable retro ball skins.

---

## 10. What We Deliberately Don't Build

Online multiplayer (netcode would eat the whole project), player likenesses/licenses, career mode, weather, VAR, microtransactions of any kind (put "0 microtransactions" on the box — it's a feature vs. the official game's upgrade-coin system), and mobile touch controls in v1. Focus is the weapon.

---

## 11. Definition of "One-Upped"

The friend test, in order:
1. He picks up a controller and scores within 3 minutes without reading anything.
2. He shouts at a keeper save (ours actually save).
3. He asks for a rematch. ← This is the win condition.
