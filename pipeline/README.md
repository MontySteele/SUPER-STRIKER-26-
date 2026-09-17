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
`mixamorig:*` names), bakes shape keys and clothing delete-groups, drops helper geometry, scales
textures to 1024, and exports `<name>.glb` (WEBP textures, ~2 MB, ~38k triangles) plus two preview
renders. Specs for the roster live in `characters/specs/`.

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
