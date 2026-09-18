# Asset pipeline

Everything here runs headless. No GUI, no manual steps.

## Requirements

- Blender 5.2 (`brew install --cask blender`) at `/Applications/Blender.app`.
- MPFB extension enabled in Blender (`blender -b --command extension install blender_org.mpfb --enable`,
  after turning on online access once via `bpy.context.preferences.system.use_online_access = True`).
- MPFB asset packs (CC0/CC-BY, from files2.makehumancommunity.org/asset_packs/) unzipped into
  `~/Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data`:
  makehuman_system_assets, skins01-03, eyebrows01, eyelashes01, hair01-03, shirts01, pants01, shoes01.
- CMU motion capture, DAZ-friendly BVH conversion (free for any use), from
  outworldz.com/Secondlife/Posts/CMU/ (`cmuconvert-daz-*.zip`).

## Characters — `characters/make_player.py`

```
blender -b --python pipeline/characters/make_player.py -- spec.json out_dir [--save-blend rig.blend]
```

Builds one human from a JSON spec (macro sliders, race mix, skin, hair, brows, lashes, teeth,
shirt, shorts, shoes, hair colour), rigs it with MPFB's built-in **Mixamo** skeleton (52 bones,
`mixamorig:*` names), bakes shape keys and clothing delete-groups, drops helper geometry, and
exports `<name>.glb` (WEBP textures, ~2.1–2.4 MB, ~35–37k triangles) plus `_lod1`/`_lod2`
siblings and two preview renders. Specs for the roster live in `characters/specs/`.

Three things it does that are not obvious:

* **Texture budget per part, not per file.** `tex_max` (2048) is the *skin* — the one map a
  broadcast close-up resolves, and the only one the MPFB library ships above 1024 that is worth
  keeping there. `tex_parts` (1024) is hair, boots and garments; `tex_hidden` (256) is the teeth,
  tongue, brows and lashes, which `CULL_MESHES` in `characterAssets.ts` drops before anything is
  drawn; `tex_lod` (512) is everything, re-scaled after the full-detail GLB is written, so the two
  LOD siblings stop re-embedding a byte-identical copy of the same 2048 skin. The runtime hands
  level 0's materials to every level, so the LOD maps are a fallback, not what is drawn. Net effect
  of the 2048 rebake: the roster went **18.7 MB → 15.4 MB** while the skin got four times the texels.
* **Normal maps.** MPFB's GAMEENGINE material tree has a normal-map branch but only wires it when
  the `.mhmat` spells the key `normalmapTexture`; most community assets spell it `bumpTexture`,
  which the parser aliases to `bumpmapTexture` — a key that branch never reads. So the script finds
  the `.mhmat` beside each diffuse and wires the branch itself. Today that is the shorts (the
  swimming-trunks asset ships a 2048 NRM); anything else in the pack that grows one is picked up
  for free. It refuses a bump map that is the diffuse itself, which is how the brows declare theirs.
* **Surface response in the file.** The GAMEENGINE tree leaves every Principled at roughness 0.5,
  which under ACES reads as damp plastic on everything from a shin to a boot. `SURFACE` writes a
  sensible roughness/metallic per material (cornea 0.12, boot 0.38, skin 0.58, fabric 0.85), which
  `fixCharacterMaterial` then only ever *raises*.

`lods` defaults to `[0.55, 0.15]`. 0.35 was too brutal for lod1's real job: with the detail bands
at `[45, 90]` m, lod1 is where most of a broadcast frame's players live, and a 0.35 collapse eats
the hands and squares off the shoulders visibly at 50 m.

## Animation — `anim/retarget_bvh.py`

```
blender -b --python pipeline/anim/retarget_bvh.py -- --target rig.blend --out public/models/anim \
    --fps 30 --preview --clips a.bvh b.bvh ...
```

Retargets CMU BVH clips and Mixamo FBX clips (`anim/mixamo/*.fbx`, fetched with
`anim/mixamo_fetch.py`, which needs a one-time Mixamo access token in
`~/.config/mixamo/access_token`) onto the Mixamo rig by world-space rotation deltas (rest-pose aware),
bakes at 30 fps, grounds the feet, and exports one GLB per clip plus a contact-sheet preview
under `anim/previews/`. `cmu_shortlist.tsv` is the curated list of football-relevant CMU clips.

Current set: 47 `cmu_*` + 653 `mx_*` animation-only GLBs in `public/models/anim/` with a
per-frame ground-contact pass (`ground_stats.json` has before/after numbers per clip).

## In-game

`src/render/characterAssets.ts` loads the roster (three LOD levels per archetype) and the
clips named in its `CLIP_TABLE`; `src/render/skinnedPlayer.ts` is the animation state
machine. Skinned players are the default; `?players=capsule` brings back the old
procedural bodies. `npm run capture -- --players skinned|capsule` is the visual gate.

## Viewing results in the engine

`modellab.html` (dev server) or `npm run shoot-model` renders a character, a pose or a clip under
the game's lighting and writes stills to `captures/model/`.

## Audio — `audio/bake_commentary.py`, `audio/bake_crowd.py`

Everything the match *says* and most of what the crowd *does* is baked here.
Outputs land in `public/audio/` (5.7 MB total, committed — under the 10 MB
threshold) and are consumed by `src/audio/`.

```bash
python3.13 -m venv audio/.venv
audio/.venv/bin/pip install kokoro-onnx soundfile numpy   # ~1 min
brew install ffmpeg                                        # if you don't have it

audio/.venv/bin/python audio/bake_commentary.py            # ~16 min cold, seconds warm
audio/.venv/bin/python audio/bake_crowd.py                 # ~1 min
```

### Commentary

`bake_commentary.py` renders every line in `audio/lines.py` plus every team
name and every player surname in `src/data/teams.json`, then packs them into
Opus sprites with `public/audio/commentary.json` as the index.

* **TTS**: Kokoro-82M via `kokoro-onnx` (Apache-2.0 model, MIT wrapper), CPU,
  24 kHz. Two British voices — `bm_george` play-by-play, `bm_lewis` colour.
  `pip install kokoro` (the PyTorch build) is **not** usable on Python 3.13: it
  pulls `misaki[en]` → `spacy`, and spacy has no 3.13 wheel, so pip tries to
  build `4.0.0.dev3` from source and fails. `kokoro-onnx` phonemises through
  espeak-ng instead. `--backend say` falls back to macOS `say` (voice "Daniel"),
  which works but sounds like 2005.
* **Model weights** (~350 MB) download on first run into `audio/models/`.
* **Splicing**, not per-player lines: 1248 surnames × 30-odd goal variants is
  38,000 clips, so lines carry `{slot}` placeholders and the runtime glues
  `"What a finish from"` + `"Okafor!"` with a 45 ms gap. Name clips are baked
  with an exclamation so a goal call doesn't die on the surname.
* **Sprites, not files**: 1409 clips would be 1409 requests and 1409 decoded
  buffers. Instead there are 9 line sprites (one per category/voice) and 48
  name sprites (one per squad); a match loads the 9 plus its own 2, about
  1.2 MB. Offsets live in the manifest and `AudioBufferSourceNode.start(when,
  offset, duration)` does the slicing for free.
* **Idempotent**: every (voice, text) pair is cached as a WAV under
  `audio/.cache/`, keyed by a hash of the backend, voice, speed and text.
  Editing one line re-renders one line. `--force` ignores the cache,
  `--teams bra,mex` bakes a two-squad subset for fast iteration.

Adding a line: put it in `audio/lines.py` under an existing group (the runtime
picks a variant at random and never repeats the previous one), re-run the bake,
re-run the dry-run. Adding a *group* also needs a `case` in
`src/audio/commentaryScript.ts` — the manifest supplies the words, the director
decides when they are said.

### Crowd

`bake_crowd.py` turns two CC0 recordings (`audio/sources/`, see `CREDITS.md`)
into eight stadium layers — murmur, anticipation, roar, eruption, groan,
applause, clap burst, terrace chant — by decorrelated multi-layer stacking and
pitch drop, i.e. how film sound builds a crowd out of six people. 356 KB for
the set. If `public/audio/crowd.json` is missing the game falls back to the
fully synthesized bed in `src/audio/audio.ts` and nothing breaks.

### Checking it without ears

```bash
npx tsx pipeline/audio/dryrun.ts --minutes 6              # one match, full transcript
npx tsx pipeline/audio/dryrun.ts --sweep 12 --knockout    # pacing + coverage stats
pipeline/audio/.venv/bin/python pipeline/audio/preview.py --player Neymar
pipeline/audio/.venv/bin/python pipeline/audio/preview.py --list
```

`dryrun.ts` runs a seeded CPU-vs-CPU match through the real director, the real
queue and the real clip durations in node, and prints every line with its
timing; it exits non-zero on an overlap or an unbaked group. `preview.py`
splices real lines out of the shipped sprites into `audio/samples/*.ogg` so you
can actually listen to one.
