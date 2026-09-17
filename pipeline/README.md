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
