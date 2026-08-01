# Credits & Attribution

SUPER STRIKER '26 ships **no third-party art assets**. Every texture, mesh and
sound in the game is generated at load from code in this repository. What we do
owe are ideas, and the ones below are owed by name.

---

## Techniques & patterns

### pallet-town-3d — PauliusOS (MIT)

<https://github.com/PauliusOS/pallet-town-3d>

Three of this project's graphics modules follow patterns established there. No
code was copied; the debt is architectural, and the spec requires it be stated
plainly.

| Ours | Theirs | What we took |
| --- | --- | --- |
| `src/render/TextureLab.ts` | `core/TextureLab.ts` | The idea of a single seeded texture *bakery* rather than scattered canvas painting: one noise field feeding every map, normals derived from the same height field as the albedo, seamless tiling by evaluating noise on a torus, and a per-map bake-time budget reported to the console. |
| `src/render/Atmosphere.ts` | their lighting rig | One module owning every light in the scene, with named time-of-day presets, so day / sunset / night are tuned as complete looks instead of three colour swaps on the same rig. |
| `tools/capture.mjs`, `tools/harness.mjs`, `src/tools/capture.ts` | their capture harness | A headless shot contract: fixed seed + fixed camera pose + fixed frame index per named shot, screenshotted and diffed to measure a graphics change instead of arguing about it. |

MIT licence text: <https://github.com/PauliusOS/pallet-town-3d/blob/main/LICENSE>

### three.js — mrdoob and contributors (MIT)

<https://threejs.org> — renderer, `EffectComposer` post chain, `CSM`, `SMAA` /
`FXAA` passes, `PMREMGenerator`, `BufferGeometryUtils`.

---

## Assets

**All procedurally generated.** In detail:

| Asset | Source |
| --- | --- |
| Pitch grass albedo, detail normal, macro variation, goalmouth wear | `TextureLab.pitchMaps()` — two-octave torus noise, Sobel-derived normals |
| Mowing stripes | Shader patch in `render/pitch.ts`, not a texture |
| Line markings | Vector-painted from the real pitch dimensions in `sim/constants.ts` |
| Player meshes | `render/playerBody.ts` — lofted elliptical profiles, vertex-baked AO |
| Kit textures (shirt / sleeve / collar / shorts / socks, names, numbers) | `TextureLab.kitAtlas()` / `.backNumber()` from the two hex colours in `data/teams.json` |
| Crowd cards, team flags, LED ad boards, lens flares, impostor cards | `TextureLab` |
| Sky, PMREM environment | `render/sky.ts` — procedural gradient + sun disc |
| All audio | `audio/*.ts` — Web Audio synthesis, no samples |

### On the rigged-character question

Spec §7A.2 asks for a sourced CC0 rigged humanoid plus Mixamo locomotion clips.
Mixamo requires an interactive Adobe login, so that half was never reachable
from this environment. The sourcing half was attempted and abandoned on the
merits:

- Quaternius' CC0 character packs are behind a gated download on
  `quaternius.com`; no direct archive URL and no GitHub mirror resolved.
- The only rigged humanoids reachable were `CesiumMan` and `RiggedFigure` from
  `KhronosGroup/glTF-Sample-Assets` — CC-BY 4.0 rather than CC0, and neither is
  a footballer or anything that could be dressed as one.
- Even a suitable mesh would have been the wrong trade here: 22 skinned players
  at 4–8k triangles is 90–180k triangles against a 150k **scene** ceiling, and
  the animation layer is code-driven poses on five Groups rather than skeletal
  clips.

So the mesh is procedural and the *pipeline* is the deliverable — one shared
body, per-team appearance as a texture swap, baked AO, three LOD tiers. The
glTF drop-in point is documented at the top of `src/render/playerBody.ts`: a
skinned mesh replaces `buildParts()` and nothing above it changes.

---

## Names & data

Player names, squad numbers and positions in `src/data/teams.json` are the real
2026 World Cup squads (source: Wikipedia, CC BY-SA 4.0). Ratings are invented.
Teams are identified by country, never by any licensed club, competition or
federation branding — see spec §4. Sponsor names on the ad boards ("CLAWDE
SPORTS", "ANTHROPIC AIR") are jokes, not brands.
