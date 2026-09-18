"""Headless MPFB player generator.

    blender -b --python pipeline/characters/make_player.py -- spec.json out_dir [--save-blend path.blend]

Builds one rigged, dressed, textured human from a JSON spec, exports a GLB with
the Mixamo-named skeleton, and renders preview stills (full body + face) so the
result can be judged without opening Blender.

Spec keys (all optional, defaults are a young average male):
  name, seed, gender, age, muscle, weight, height, proportions,
  race: {african, asian, caucasian}, skin (mhmat file), eyes (mhclo), eyebrows,
  eyelashes, teeth, tongue, hair, shirt, shorts, shoes,
  hair_color [r,g,b], targets {"arms/measure-upperarm-length-incr": 0.7, ...},
  image_format (WEBP|AUTO), lods [ratio,...] (default [0.35, 0.12]), preview (bool)

Texture budget (all in px, all optional). The cap is per PART, not global,
because the parts are not worth the same number of texels:
  tex_max        the skin — the one map a broadcast close-up actually resolves,
                 and the only one the MPFB library ships at 2048 that is worth
                 keeping there. Default 2048.
  tex_parts      hair, boots, garments. The shirt and shorts maps are REPAINTED
                 at runtime (characterAssets.ts) so their authored resolution
                 only has to survive being read once; hair and boots are drawn
                 as authored. Default 1024.
  tex_hidden     teeth, tongue, eyelashes, eyebrows — meshes CULL_MESHES drops
                 before anything is ever drawn. They stay in the file so the
                 model lab and the retarget rig still have a full head; they do
                 not need texels. Default 256.
  tex_lod        every map, re-scaled once the full-detail GLB is written, so
                 the two LOD siblings do not each carry another megabyte of the
                 same skin. The runtime shares level 0's materials across every
                 level (prepareArchetype), so these are a fallback, not what is
                 drawn. Default 512.
"""
import bpy, importlib, json, math, os, random, re, struct, sys
from mathutils import Vector, kdtree


def dynamic_import(absolute_package_str, key):
    for amod in list(sys.modules):
        if amod.endswith(absolute_package_str):
            mod = importlib.import_module(amod)
            if not hasattr(mod, key):
                raise AttributeError(f"{amod} has no {key}")
            return getattr(mod, key)
    raise ValueError(f"no module ending in {absolute_package_str}")


HumanService = dynamic_import("mpfb.services.humanservice", "HumanService")
AssetService = dynamic_import("mpfb.services.assetservice", "AssetService")
ExportService = dynamic_import("mpfb.services.exportservice", "ExportService")
ObjectService = dynamic_import("mpfb.services.objectservice", "ObjectService")
TargetService = dynamic_import("mpfb.services.targetservice", "TargetService")

argv = sys.argv[sys.argv.index("--") + 1:]
save_blend = None
if "--save-blend" in argv:
    i = argv.index("--save-blend")
    save_blend = argv[i + 1]
    argv = argv[:i] + argv[i + 2:]
spec = json.load(open(argv[0]))
out_dir = argv[1]
os.makedirs(out_dir, exist_ok=True)
name = spec.get("name", "player")

bpy.ops.wm.read_homefile(use_empty=True)

macro = TargetService.get_default_macro_info_dict()
macro.update({
    "gender": spec.get("gender", 0.95),
    "age": spec.get("age", 0.45),
    "muscle": spec.get("muscle", 0.65),
    "weight": spec.get("weight", 0.45),
    "height": spec.get("height", 0.6),
    "proportions": spec.get("proportions", 0.6),
})
macro["race"] = spec.get("race", {"african": 0.33, "asian": 0.33, "caucasian": 0.34})
basemesh = HumanService.create_human(macro_detail_dict=macro)
basemesh.name = name

# Extra modelling targets: {"arms/upperarm-length-incr": 0.5, ...} (paths relative
# to MPFB's targets dir, without the .target.gz suffix; negative weights allowed
# only where a -decr target exists, so use the decr name instead).
LocationService = dynamic_import("mpfb.services.locationservice", "LocationService")
targets_root = LocationService.get_mpfb_data("targets")
for tname, weight in spec.get("targets", {}).items():
    tpath = os.path.join(targets_root, tname + ".target.gz")
    if not os.path.exists(tpath):
        print(f"[make_player] MISSING target {tname}")
        continue
    TargetService.load_target(basemesh, tpath, weight=float(weight))
    print(f"[make_player] target {tname} = {weight}")


def asset(subdir, fname):
    p = AssetService.find_asset_absolute_path(fname, asset_subdir=subdir)
    if p is None:
        print(f"[make_player] MISSING {subdir}/{fname}")
    return p


skin = asset("skins", spec.get("skin", "young_caucasian_male.mhmat"))
if skin:
    HumanService.set_character_skin(skin, basemesh, skin_type="GAMEENGINE")

# Rig BEFORE assets so every mhclo gets an armature modifier + interpolated weights.
HumanService.add_builtin_rig(basemesh, spec.get("rig", "mixamo"))
rig = basemesh.parent

# The hair POOL. One archetype carries several short cuts as separate meshes in
# the same GLB; the runtime keeps the one a player's seed picked and drops the
# rest at clone time (characterAssets.ts, pickHair). That is why hair variety
# costs one extra mesh in one file instead of a per-player download, and why the
# LOD siblings below are exported with only the first cut — nobody resolves a
# haircut at forty-five metres.
#
# NO DELETE GROUP is applied for hair. The mhclo delete group carves the scalp
# out of the basemesh, which is correct for exactly one cut and leaves a hole
# under every other one; with four cuts sharing a skull the scalp has to stay.
# Short cuts sit ON the head, so nothing shows through — verified in the face
# plate, and the reason `hair_pool` is short cuts only.
hair_pool = spec.get("hair_pool") or [spec.get("hair", "short01.mhclo")]
hair_objects = []

parts = [
    ("eyes", spec.get("eyes", "low-poly.mhclo"), "Eyes"),
    ("eyebrows", spec.get("eyebrows", "eyebrow001.mhclo"), "Eyebrows"),
    ("eyelashes", spec.get("eyelashes", "eyelashes01.mhclo"), "Eyelashes"),
    ("teeth", spec.get("teeth", "teeth_shape01.mhclo"), "Teeth"),
    ("tongue", spec.get("tongue", "tongue01.mhclo"), "Tongue"),
] + [("hair", h, "Hair") for h in hair_pool] + [
    ("clothes", spec.get("shirt", "elvs_crude_t-shirt_male.mhclo"), "Clothes"),
    ("clothes", spec.get("shorts", "cortu_jeans_shorts.mhclo"), "Clothes"),
    ("clothes", spec.get("shoes", "shoes06.mhclo"), "Clothes"),
]
for subdir, fname, atype in parts:
    if not fname:
        continue
    p = asset(subdir, fname)
    if not p:
        continue
    before_objs = set(bpy.data.objects)
    before_mods = {m.name for m in basemesh.modifiers}
    HumanService.add_mhclo_asset(p, basemesh, asset_type=atype, material_type="GAMEENGINE")
    new_objs = [o for o in bpy.data.objects if o not in before_objs and o.type == "MESH"]
    if atype == "Hair":
        hair_objects.extend(new_objs)
        for m in list(basemesh.modifiers):
            if m.type == "MASK" and m.name not in before_mods:
                print(f"[make_player] dropping hair delete-group mask {m.name}")
                basemesh.modifiers.remove(m)
print(f"[make_player] hair pool: {[o.name for o in hair_objects]}")

# A hair budget, because the library does not have one. `elvs_braided_rows`
# models every cornrow as real tube geometry and arrives at FORTY THOUSAND
# triangles — more than the rest of the character put together, for a haircut
# that is 60 px tall in the closest shot this game takes. Anything over the cap
# is collapsed down to it; anything under is left exactly as authored.
# The same applies to garments: the polo shirt is worth its collar and its
# sleeve hems but not four thousand triangles of them, and a library that does
# not know what it is being used for will hand you whatever it was modelled at.
HAIR_TRIS = int(spec.get("hair_tris", 6000))
GARMENT_TRIS = int(spec.get("garment_tris", 3200))
budgets = [(o, HAIR_TRIS) for o in hair_objects]
hair_set = set(hair_objects)
for o in bpy.data.objects:
    if o.type != "MESH" or o in hair_set or o is basemesh:
        continue
    if re.search(r"polo|shirt|short|trunk|trouser|jean", o.name or "", re.I):
        budgets.append((o, GARMENT_TRIS))
for o, cap in budgets:
    o.data.calc_loop_triangles()
    n = len(o.data.loop_triangles)
    if n <= cap:
        continue
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    m = o.modifiers.new("tribudget", "DECIMATE")
    m.ratio = cap / n
    m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier="tribudget")
    o.data.calc_loop_triangles()
    print(f"[make_player] tri budget {o.name}: {n} -> {len(o.data.loop_triangles)} tris")

def dump(tag):
    print(f"[make_player] --- {tag}")
    for o in bpy.data.objects:
        v = len(o.data.vertices) if o.type == "MESH" else "-"
        print(f"[make_player]   {o.name:34s} {o.type:8s} parent={o.parent.name if o.parent else None} mods={[m.type for m in o.modifiers]} verts={v}")
dump("after build")

# --- proportion report (helps match mocap performers) --------------------------
def blen(bn):
    b = rig.data.bones.get(bn); return (b.tail_local - b.head_local).length if b else 0
def bhead(bn):
    b = rig.data.bones.get(bn); return b.head_local if b else None
arm = blen("mixamorig:LeftArm") + blen("mixamorig:LeftForeArm")
leg = blen("mixamorig:LeftUpLeg") + blen("mixamorig:LeftLeg")
sh, hd, hp = bhead("mixamorig:LeftArm"), bhead("mixamorig:Head"), bhead("mixamorig:Hips")
if sh and hd and hp:
    print(f"[make_player] proportions: arm={arm:.3f} leg={leg:.3f} hip->shoulder={(sh-hp).length:.3f} shoulder->head={(hd-sh).length:.3f} arm/leg={arm/leg:.3f} hipY={hp.z:.3f}")

# --- the face pool -------------------------------------------------------------
#
# WHY A DELTA POOL AND NOT TWENTY-TWO CHARACTERS.
#
# Twenty-two men with twenty-two faces is, on the face of it, twenty-two GLBs;
# at 2.4 MB each that is 53 MB of download to put eleven-a-side on a pitch, and
# 53 MB of decoded skin in a 16 GB machine. But two players of the same
# archetype differ ONLY in the head: same skeleton, same body, same kit, same
# 2048 skin atlas. What is actually unique is a few thousand vertex positions.
#
# So the pipeline ships those, and nothing else: for each archetype, ONE array
# of head-region base positions and N arrays of int16 offsets from it. The
# runtime clones the archetype's LOD0 geometry per player (which it must do
# anyway to put a number on a shirt) and adds one variant's offsets. No extra
# mesh, no extra draw call, no neck seam to hide, no second skeleton to bind —
# and a whole pool costs about what ONE extra character would have.
#
# The offsets are masked by the Head bone's skin weight, ramped to zero through
# the jaw/neck transition, so the deltas are a smooth field that dies out before
# the collar. A face target can therefore never crack the neck open.
FACE_COUNT = int(spec.get("face_count", 0))
FACE_SEED = int(spec.get("face_seed", 20260218))

# Each knob is (target when negative, target when positive, sigma). "{s}" is
# expanded to the l-/r- pair and driven with the same weight, so a face comes
# out symmetric; ASYM below adds back the small amount of asymmetry that stops
# a head reading as a mannequin.
FACE_KNOBS = [
    ("head/head-scale-depth-decr", "head/head-scale-depth-incr", 0.50),
    ("head/head-scale-horiz-decr", "head/head-scale-horiz-incr", 0.40),
    ("head/head-scale-vert-decr", "head/head-scale-vert-incr", 0.40),
    ("head/head-fat-decr", "head/head-fat-incr", 0.55),
    ("head/head-age-decr", "head/head-age-incr", 0.50),
    ("head/head-back-scale-depth-decr", "head/head-back-scale-depth-incr", 0.40),
    ("head/head-angle-in", "head/head-angle-out", 0.35),
    ("forehead/forehead-nubian-decr", "forehead/forehead-nubian-incr", 0.45),
    ("forehead/forehead-scale-vert-decr", "forehead/forehead-scale-vert-incr", 0.45),
    ("forehead/forehead-temple-decr", "forehead/forehead-temple-incr", 0.40),
    ("forehead/forehead-trans-backward", "forehead/forehead-trans-forward", 0.35),
    ("nose/nose-scale-depth-decr", "nose/nose-scale-depth-incr", 0.50),
    ("nose/nose-scale-horiz-decr", "nose/nose-scale-horiz-incr", 0.50),
    ("nose/nose-scale-vert-decr", "nose/nose-scale-vert-incr", 0.45),
    ("nose/nose-hump-decr", "nose/nose-hump-incr", 0.55),
    ("nose/nose-curve-concave", "nose/nose-curve-convex", 0.45),
    ("nose/nose-nostrils-width-decr", "nose/nose-nostrils-width-incr", 0.50),
    ("nose/nose-point-down", "nose/nose-point-up", 0.45),
    ("nose/nose-width1-decr", "nose/nose-width1-incr", 0.40),
    ("nose/nose-width2-decr", "nose/nose-width2-incr", 0.40),
    ("nose/nose-base-down", "nose/nose-base-up", 0.35),
    ("nose/nose-greek-decr", "nose/nose-greek-incr", 0.35),
    ("chin/chin-bones-decr", "chin/chin-bones-incr", 0.55),
    ("chin/chin-height-decr", "chin/chin-height-incr", 0.45),
    ("chin/chin-prognathism-decr", "chin/chin-prognathism-incr", 0.45),
    ("chin/chin-prominent-decr", "chin/chin-prominent-incr", 0.50),
    ("chin/chin-width-decr", "chin/chin-width-incr", 0.50),
    ("chin/chin-cleft-decr", "chin/chin-cleft-incr", 0.35),
    ("mouth/mouth-scale-horiz-decr", "mouth/mouth-scale-horiz-incr", 0.50),
    ("mouth/mouth-scale-vert-decr", "mouth/mouth-scale-vert-incr", 0.45),
    ("mouth/mouth-scale-depth-decr", "mouth/mouth-scale-depth-incr", 0.40),
    ("mouth/mouth-upperlip-volume-decr", "mouth/mouth-upperlip-volume-incr", 0.50),
    ("mouth/mouth-lowerlip-volume-decr", "mouth/mouth-lowerlip-volume-incr", 0.50),
    ("mouth/mouth-angles-down", "mouth/mouth-angles-up", 0.40),
    ("mouth/mouth-trans-backward", "mouth/mouth-trans-forward", 0.30),
    ("mouth/mouth-philtrum-volume-decr", "mouth/mouth-philtrum-volume-incr", 0.35),
    ("eyes/{s}-eye-scale-decr", "eyes/{s}-eye-scale-incr", 0.45),
    ("eyes/{s}-eye-height1-decr", "eyes/{s}-eye-height1-incr", 0.40),
    ("eyes/{s}-eye-height2-decr", "eyes/{s}-eye-height2-incr", 0.40),
    ("eyes/{s}-eye-push1-in", "eyes/{s}-eye-push1-out", 0.40),
    ("eyes/{s}-eye-trans-in", "eyes/{s}-eye-trans-out", 0.30),
    ("eyes/{s}-eye-corner1-down", "eyes/{s}-eye-corner1-up", 0.35),
    ("eyes/{s}-eye-corner2-down", "eyes/{s}-eye-corner2-up", 0.35),
    ("eyes/{s}-eye-bag-decr", "eyes/{s}-eye-bag-incr", 0.40),
    ("eyes/{s}-eye-eyefold-down", "eyes/{s}-eye-eyefold-up", 0.40),
    ("cheek/{s}-cheek-bones-decr", "cheek/{s}-cheek-bones-incr", 0.55),
    ("cheek/{s}-cheek-inner-decr", "cheek/{s}-cheek-inner-incr", 0.45),
    ("cheek/{s}-cheek-volume-decr", "cheek/{s}-cheek-volume-incr", 0.50),
    ("cheek/{s}-cheek-trans-down", "cheek/{s}-cheek-trans-up", 0.35),
    ("ears/{s}-ear-scale-decr", "ears/{s}-ear-scale-incr", 0.45),
    ("ears/{s}-ear-rot-backward", "ears/{s}-ear-rot-forward", 0.40),
    ("ears/{s}-ear-lobe-decr", "ears/{s}-ear-lobe-incr", 0.35),
    ("ears/{s}-ear-flap-decr", "ears/{s}-ear-flap-incr", 0.35),
    ("neck/neck-scale-horiz-decr", "neck/neck-scale-horiz-incr", 0.30),
]
# exactly one skull shape per head, at a modest weight
FACE_SHAPES = ["head/head-oval", "head/head-round", "head/head-square",
               "head/head-rectangular", "head/head-triangular",
               "head/head-invertedtriangular", "head/head-diamond"]
# a little real asymmetry, small enough to read as a person and not a defect
FACE_ASYM = ["asym/asym-nose-1", "asym/asym-nose-2", "asym/asym-nose-3",
             "asym/asym-eye-1", "asym/asym-eye-2", "asym/asym-eye-3",
             "asym/asym-cheek-1", "asym/asym-cheek-2",
             "asym/asym-mouth-1", "asym/asym-mouth-2"]

face_pool = None
if FACE_COUNT > 0:
    def expand(t):
        return [t.replace("{s}", "l"), t.replace("{s}", "r")] if "{s}" in t else [t]

    wanted = set()
    for neg, pos, _ in FACE_KNOBS:
        wanted.update(expand(neg)); wanted.update(expand(pos))
    wanted.update(FACE_SHAPES)
    for a in FACE_ASYM:
        wanted.add(a + "-l"); wanted.add(a + "-r")

    # Load every candidate ONCE as a zero-weight shape key; the per-head weights
    # are then arithmetic on the key data, which costs nothing and — crucially —
    # never touches the mesh, so the export below is unaffected by how many
    # faces the pool holds.
    loaded = {}
    for tname in sorted(wanted):
        tpath = os.path.join(targets_root, tname + ".target.gz")
        if not os.path.exists(tpath):
            continue
        key = "fp_" + tname.replace("/", "_")
        TargetService.load_target(basemesh, tpath, weight=0.0, name=key)
        loaded[tname] = key
    kb = basemesh.data.shape_keys.key_blocks
    basis = kb[basemesh.data.shape_keys.reference_key.name]
    nv = len(basemesh.data.vertices)
    print(f"[make_player] face pool: {len(loaded)}/{len(wanted)} targets loaded over {nv} verts")

    # Per-target sparse offset lists, so a head is a few thousand adds and not
    # fifty passes over twenty thousand vertices.
    offsets = {}
    for tname, key in loaded.items():
        data = kb[key].data
        bdata = basis.data
        sparse = []
        for i in range(nv):
            d = data[i].co - bdata[i].co
            if d.length_squared > 1e-12:
                sparse.append((i, d))
        offsets[tname] = sparse

    # The mask: 1 on the skull, ramped to 0 through the jaw/neck transition.
    head_group = basemesh.vertex_groups.get("mixamorig:Head")
    face_mask = [0.0] * nv
    if head_group:
        gi = head_group.index
        for v in basemesh.data.vertices:
            w = 0.0
            for g in v.groups:
                if g.group == gi:
                    w = g.weight
            t = min(1.0, max(0.0, (w - 0.30) / 0.45))
            face_mask[v.index] = t * t * (3 - 2 * t)
    else:
        print("[make_player] WARNING no mixamorig:Head vertex group — face pool unmasked")

    face_variants = []
    face_recipes = []
    for vi in range(FACE_COUNT):
        rng = random.Random(FACE_SEED * 1000003 + vi * 7919 + hash(name) % 100003)
        picks = {}
        for neg, pos, sigma in FACE_KNOBS:
            w = max(-1.0, min(1.0, rng.gauss(0.0, sigma)))
            if abs(w) < 0.04:
                continue
            for t in expand(pos if w > 0 else neg):
                picks[t] = abs(w)
        shape = rng.choice(FACE_SHAPES)
        picks[shape] = 0.30 + rng.random() * 0.55
        for a in FACE_ASYM:
            if rng.random() < 0.45:
                picks[a + rng.choice(["-l", "-r"])] = rng.random() * 0.45
        delta = [None] * nv
        for tname, w in picks.items():
            sparse = offsets.get(tname)
            if not sparse:
                continue
            for i, d in sparse:
                m = face_mask[i]
                if m <= 0.0:
                    continue
                cur = delta[i]
                if cur is None:
                    delta[i] = d * (w * m)
                else:
                    cur += d * (w * m)
        face_variants.append(delta)
        face_recipes.append({"shape": shape, "knobs": len(picks)})
    print(f"[make_player] face pool: {FACE_COUNT} variants built")
    face_pool = {"variants": face_variants, "recipes": face_recipes}

    # zero every pool key so the bake below is the archetype's own face
    for key in loaded.values():
        kb[key].value = 0.0

# Carry the MakeHuman vertex index through the mask modifiers, so the face pool
# can be re-indexed onto the geometry that actually ships. Blender keeps generic
# point attributes across a Mask apply; the glTF exporter ignores any custom
# attribute whose name does not start with an underscore, and this one is
# deleted before the export regardless.
if face_pool is not None:
    idx_attr = basemesh.data.attributes.new("mh_idx", "INT", "POINT")
    for i in range(len(basemesh.data.vertices)):
        idx_attr.data[i].value = i

# --- export prep (in place, no copy) ------------------------------------------
# Basemesh: bake the macro/target shape keys into the mesh, then apply the mask
# modifiers (helper geometry + clothes delete-groups) as plain geometry edits.
def activate(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o

activate(basemesh)
if basemesh.data.shape_keys:
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for m in list(basemesh.modifiers):
    if m.type == "MASK":
        bpy.ops.object.modifier_apply(modifier=m.name)
    elif m.type == "SUBSURF":
        basemesh.modifiers.remove(m)
for g in list(basemesh.vertex_groups):
    if g.name.startswith(("helper-", "joint-")) or g.name in ("HelperGeometry", "JointCubes", "Left", "Mid", "Right", "body"):
        basemesh.vertex_groups.remove(g)

# Assets: drop subdivision (game asset stays low-poly), reparent to the rig.
assets = [o for o in bpy.data.objects if o.type == "MESH" and o is not basemesh and o.parent in (basemesh, rig)]
for o in assets:
    activate(o)
    for m in list(o.modifiers):
        if m.type == "SUBSURF":
            o.modifiers.remove(m)
    if not any(m.type == "ARMATURE" for m in o.modifiers):
        print(f"[make_player] WARNING {o.name} has no armature modifier")
    mw = o.matrix_world.copy()
    o.parent = rig
    o.matrix_world = mw

dump("after export prep")
export_root = rig
export_basemesh = basemesh
children = [basemesh] + assets
bpy.ops.object.select_all(action="DESELECT")
export_root.select_set(True)
for c in children:
    c.select_set(True)
bpy.context.view_layer.objects.active = export_root

tris = 0
for o in [export_root] + list(children):
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
        print(f"[make_player] mesh {o.name}: {len(o.data.loop_triangles)} tris, mats={[m.name for m in o.data.materials]}")
    elif o.type == "ARMATURE":
        print(f"[make_player] armature {o.name}: {len(o.data.bones)} bones")
print(f"[make_player] TOTAL tris {tris}")

# --- hair colour: multiply the hair texture by a constant. The glTF exporter
# folds an Image -> Mix(MULTIPLY, colour) -> Principled chain into baseColorFactor.
hair_rgb = spec.get("hair_color")
if hair_rgb:
    for o in assets:
        if "Hair" != ObjectService.get_object_type(o):
            continue
        for mat in o.data.materials:
            nt = mat.node_tree
            bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if not bsdf:
                continue
            link = next((l for l in nt.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
            if not link:
                continue
            mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            mix.inputs[7].default_value = (*hair_rgb, 1.0)  # input B (RGBA)
            nt.links.new(link.from_socket, mix.inputs[6])   # input A (RGBA)
            nt.links.remove(link)
            nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
            print(f"[make_player] hair colour {hair_rgb} on {mat.name}")

# --- normal maps ---------------------------------------------------------------
#
# MPFB's GAMEENGINE material tree HAS a normal-map branch (Image -> Normal Map ->
# Principled.Normal) but only wires it when the .mhmat carries the key spelled
# `normalmapTexture`. Most of the community assets spell it `bumpTexture`, which
# mhmatkeys aliases to `bumpmapTexture` — a key the GAMEENGINE wrapper never
# looks at. The result is that every one of these characters exported with no
# normal map at all while the source pack had one sitting next to the diffuse.
#
# So: find the .mhmat that produced each material (it lives in the same folder as
# the diffuse image the tree already loaded), read whichever of the three normal
# keys it actually uses, and wire the branch by hand. Costs one texture on the
# shorts today; costs nothing on assets that never had one.
NORMAL_KEYS = ("normalmapTexture", "bumpmapTexture", "bumpTexture")


def mhmat_normal_map(diffuse_path):
    """Path of the normal/bump map declared beside `diffuse_path`, or None."""
    folder = os.path.dirname(bpy.path.abspath(diffuse_path))
    if not os.path.isdir(folder):
        return None
    for fname in sorted(os.listdir(folder)):
        if not fname.endswith(".mhmat"):
            continue
        for line in open(os.path.join(folder, fname), encoding="utf-8", errors="replace"):
            bits = line.strip().split(None, 1)
            if len(bits) != 2 or bits[0] not in NORMAL_KEYS:
                continue
            cand = os.path.join(folder, bits[1].strip())
            if not os.path.exists(cand):
                continue
            # eyebrows/eyelashes declare their own DIFFUSE as the bump map; a
            # colour image read as a tangent-space normal is a lit-wrong mess.
            if os.path.samefile(cand, bpy.path.abspath(diffuse_path)):
                continue
            return cand
    return None


def wire_normal_map(mat):
    nt = mat.node_tree
    if not nt:
        return False
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf or bsdf.inputs["Normal"].is_linked:
        return False
    link = next((l for l in nt.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
    diffuse = None
    node = link.from_node if link else None
    while node is not None and diffuse is None:
        if node.type == "TEX_IMAGE" and node.image:
            diffuse = node.image
        else:
            up = next((l for l in nt.links if l.to_node == node), None)
            node = up.from_node if up else None
    if not diffuse or not diffuse.filepath:
        return False
    path = mhmat_normal_map(diffuse.filepath)
    if not path:
        return False
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "Non-Color"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.location = (-560, -240)
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.location = (-260, -240)
    nt.links.new(tex.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    print(f"[make_player] normal map {os.path.basename(path)} -> {mat.name}")
    return True


# --- surface response ----------------------------------------------------------
# The GAMEENGINE tree leaves every Principled at the Blender default (roughness
# 0.5, metallic 0), which the exporter writes straight into the glTF and which
# under ACES reads as damp plastic on everything from a shin to a boot. These are
# the values the renderer wants anyway (fixCharacterMaterial only ever raises
# roughness, so a sane number here survives); setting them in the FILE means the
# model lab, any third-party viewer and the game agree.
SURFACE = [
    # brows and lashes FIRST: "eyebrow003" contains "eye", and hair read as a
    # cornea is a pair of glossy black slugs over the eyes
    ("eyebrow|eyelash", 0.72, 0.0),
    ("low-poly|cornea|eyeball", 0.12, 0.0),  # wet, and the only real highlight on a face
    ("shoes|boot", 0.38, 0.0),               # moulded synthetic: glossy, not chrome
    ("hair|afro|short0|braid|cornrow|micky|messy", 0.68, 0.0),
    ("teeth|tongue", 0.35, 0.0),
    ("shirt|shorts|trunks|jeans|t-shirt|trouser|polo", 0.85, 0.0),   # fabric
    ("", 0.58, 0.0),                         # skin
]
for mat in bpy.data.materials:
    if not mat.node_tree:
        continue
    wire_normal_map(mat)
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        continue
    for pattern, rough, metal in SURFACE:
        if not pattern or re.search(pattern, mat.name, re.I):
            bsdf.inputs["Roughness"].default_value = rough
            bsdf.inputs["Metallic"].default_value = metal
            print(f"[make_player] surface {mat.name}: roughness {rough} metallic {metal}")
            break

# --- texture budget: a cap PER PART, not one number for the file ---------------
# The skin is the map a close-up resolves and the MPFB library ships it at 2048;
# hair/boots/garments are drawn smaller or repainted at runtime; the mouth and
# the brows are dropped by the loader before they are ever drawn. See the module
# docstring.
TEX_MAX = int(spec.get("tex_max", 2048))
TEX_PARTS = int(spec.get("tex_parts", 1024))
TEX_HIDDEN = int(spec.get("tex_hidden", 256))
TEX_LOD = int(spec.get("tex_lod", 512))
HIDDEN_RE = re.compile(r"teeth|tongue", re.I)
# Brows and lashes are no longer culled by the loader at LOD0 — a face without
# them reads as a shop dummy the moment a replay camera gets inside three
# metres — so they need real texels again. 512 is what the source ships.
FINE_RE = re.compile(r"eyelash|eyebrow", re.I)
# A hair POOL means four cuts per archetype instead of one. At 1024 apiece that
# is four megabytes of scalp per character; 512 is the resolution an alpha-
# tested hair card actually resolves at the closest shot the game ever takes.
HAIR_RE = re.compile(r"hair|afro|short0|braid|cornrow|micky|messy", re.I)
TEX_FINE = int(spec.get("tex_fine", 512))
TEX_HAIR = int(spec.get("tex_hair", 512))


def images_of(obj):
    out = []
    for mat in getattr(obj.data, "materials", []) or []:
        if not mat or not mat.node_tree:
            continue
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image:
                out.append(n.image)
    return out


def scale_images(caps, tag):
    for img, cap in caps.items():
        w, h = img.size
        if w <= cap and h <= cap:
            continue
        f = cap / max(w, h)
        img.scale(max(1, int(w * f)), max(1, int(h * f)))
        print(f"[make_player] {tag} {img.name} {w}x{h} -> {img.size[0]}x{img.size[1]}")


caps = {}
for obj in [basemesh] + assets:
    tag = f"{obj.name} {ObjectService.get_object_type(obj) or ''}"
    if obj is basemesh:
        cap = TEX_MAX
    elif HIDDEN_RE.search(tag):
        cap = TEX_HIDDEN
    elif FINE_RE.search(tag):
        cap = TEX_FINE
    elif HAIR_RE.search(tag):
        cap = TEX_HAIR
    else:
        cap = TEX_PARTS
    for img in images_of(obj):
        caps[img] = min(caps.get(img, cap), cap)
for img in bpy.data.images:
    caps.setdefault(img, TEX_PARTS)
scale_images(caps, "scaled")

# --- write the face pool -------------------------------------------------------
# Positions go out in the SAME space and the SAME axis convention the glTF
# exporter uses (y-up: blender x,y,z -> x,z,-y) and in mesh-LOCAL coordinates,
# because that is what the runtime reads off the loaded BufferGeometry. The
# runtime matches pool vertex to buffer vertex by position, once per archetype,
# which is immune to the exporter splitting a vertex in two at a UV seam: both
# copies share the position and therefore both get the same offset.
def yup(v):
    return (v.x, v.z, -v.y)


if face_pool is not None:
    attr = basemesh.data.attributes.get("mh_idx")
    orig = [attr.data[i].value for i in range(len(basemesh.data.vertices))] if attr else []
    basemesh.data.attributes.remove(attr) if attr else None

    body_ix = [j for j, o in enumerate(orig) if face_mask[o] > 0.001]
    print(f"[make_player] face pool: {len(body_ix)} of {len(orig)} body verts in the head field")

    bw = basemesh.matrix_world
    tree = kdtree.KDTree(len(body_ix))
    for k, j in enumerate(body_ix):
        tree.insert(bw @ basemesh.data.vertices[j].co, k)
    tree.balance()

    # Everything parented to the face follows it: the eyeballs, the brows, the
    # lashes and every cut in the hair pool. Each of those vertices takes the
    # offset of the nearest skull vertex, which is the same rule MPFB's own
    # fitting uses and is exact enough at this scale — a brow hair is never more
    # than a couple of millimetres off the skin it grows out of.
    FOLLOW_RE = re.compile(r"eyebrow|eyelash|low-poly|eye", re.I)
    followers = [o for o in assets
                 if o in hair_objects or FOLLOW_RE.search(o.name or "")]
    followers = [o for o in followers if not re.search(r"teeth|tongue", o.name or "", re.I)]

    SCALE = 2.0e-5
    sections, base_buf, delta_buf = [], bytearray(), bytearray()
    nvar = FACE_COUNT

    def emit(obj, pairs):
        """pairs: [(local_co, [delta_world per variant])] in vertex order."""
        if not pairs:
            return
        off_base = len(base_buf)
        for co, _ in pairs:
            base_buf.extend(struct.pack("<3f", *yup(co)))
        off_delta = len(delta_buf)
        inv = obj.matrix_world.inverted().to_3x3()
        for v in range(nvar):
            for _, ds in pairs:
                d = inv @ ds[v] if ds[v] is not None else Vector((0, 0, 0))
                x, y, z = yup(d)
                delta_buf.extend(struct.pack("<3h",
                    max(-32767, min(32767, int(round(x / SCALE)))),
                    max(-32767, min(32767, int(round(y / SCALE)))),
                    max(-32767, min(32767, int(round(z / SCALE))))))
        sections.append({"mesh": obj.name, "count": len(pairs),
                         "base": off_base, "delta": off_delta})

    body_pairs = []
    for j in body_ix:
        o = orig[j]
        body_pairs.append((basemesh.data.vertices[j].co.copy(),
                           [fv[o] for fv in face_pool["variants"]]))
    emit(basemesh, body_pairs)
    base_bytes_body = len(base_buf)

    for obj in followers:
        mw = obj.matrix_world
        pairs = []
        for v in obj.data.vertices:
            co, k, dist = tree.find(mw @ v.co)
            if dist > 0.09:
                pairs.append((v.co.copy(), [None] * nvar))
                continue
            o = orig[body_ix[k]]
            pairs.append((v.co.copy(), [fv[o] for fv in face_pool["variants"]]))
        emit(obj, pairs)

    bin_path = os.path.join(out_dir, f"{name}_faces.bin")
    with open(bin_path, "wb") as fh:
        fh.write(base_buf)
        fh.write(delta_buf)
    manifest = {
        "name": name, "variants": nvar, "scale": SCALE,
        "baseBytes": len(base_buf),
        "hair": [o.name for o in hair_objects],
        "sections": sections,
        "recipes": face_pool["recipes"],
    }
    with open(os.path.join(out_dir, f"{name}_faces.json"), "w") as fh:
        json.dump(manifest, fh, separators=(",", ":"))
    print(f"[make_player] wrote {bin_path} ({len(base_buf) + len(delta_buf) // 1} bytes,"
          f" {len(sections)} meshes, {nvar} variants,"
          f" {(len(base_buf)+len(delta_buf))//1024} KB)")

glb = os.path.join(out_dir, f"{name}.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True,
                          export_apply=False, export_animations=False, export_skins=True,
                          export_image_format=spec.get("image_format", "WEBP"), export_image_quality=int(spec.get("image_quality", 85)), export_yup=True)
print(f"[make_player] wrote {glb} ({os.path.getsize(glb)//1024} KB)")

# --- preview renders ----------------------------------------------------------
if spec.get("preview", True):
    # hide the working (non-export) character so only the export copy renders
    for o in bpy.data.objects:
        if o not in [export_root] + list(children):
            o.hide_render = True
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w"); scene.world = world; world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.35, 0.38, 0.42, 1); bg.inputs[1].default_value = 0.6
    sun = bpy.data.lights.new("sun", "SUN"); sun.energy = 3.5
    so = bpy.data.objects.new("sun", sun); so.rotation_euler = (math.radians(55), 0, math.radians(35))
    scene.collection.objects.link(so)
    fill = bpy.data.lights.new("fill", "AREA"); fill.energy = 600; fill.size = 4
    fo = bpy.data.objects.new("fill", fill); fo.location = (-2.5, -3, 1.6); scene.collection.objects.link(fo)
    rim = bpy.data.lights.new("rim", "AREA"); rim.energy = 400; rim.size = 2
    ro = bpy.data.objects.new("rim", rim); ro.location = (2, 2.5, 2.2); scene.collection.objects.link(ro)
    cam = bpy.data.cameras.new("cam"); co = bpy.data.objects.new("cam", cam)
    scene.collection.objects.link(co); scene.camera = co
    mesh = export_basemesh
    zmax = max((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
    shots = [("body", 50, (0.9, -4.6, zmax * 0.55), (90, 0, 11)),
             ("face", 85, (0.35, -1.25, zmax * 0.94), (90, 0, 15))]
    for tag, lens, loc, rot in shots:
        cam.lens = lens; co.location = loc; co.rotation_euler = tuple(math.radians(a) for a in rot)
        scene.render.resolution_x, scene.render.resolution_y = (720, 1200) if tag == "body" else (900, 900)
        # review renders live beside the pipeline, not in public/ (the game
        # never loads them, and they were shipping 6.6 MB for nothing)
        prev_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "previews")
        os.makedirs(prev_dir, exist_ok=True)
        scene.render.filepath = os.path.join(prev_dir, f"{name}_{tag}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[make_player] preview {scene.render.filepath}")

# --- LODs ----------------------------------------------------------------------
# The hair pool does not survive into the LOD siblings. lod1 starts at 45 m and
# lod2 at 90 m; nobody has ever resolved a haircut at forty-five metres, and
# carrying four cuts down two decimation passes would cost three extra meshes,
# three extra textures and three extra draws per distant player for nothing.
# Everyone past the first detail band wears cut zero.
for extra in hair_objects[1:]:
    print(f"[make_player] LOD: dropping hair variant {extra.name}")
    if extra in children:
        children.remove(extra)
    bpy.data.objects.remove(extra, do_unlink=True)

# Textures first: the two LOD siblings used to re-embed a byte-identical copy of
# every map in the full-detail file, which is where two thirds of the character
# download went. The runtime hands level 0's materials to every level, so what
# is in these files is a fallback for a name that failed to match — and a
# fallback does not need 2048 of skin.
scale_images({img: TEX_LOD for img in bpy.data.images}, "lod texture")

# Cumulative decimation of every mesh, exported as <name>_lod<n>.glb.
# Decimate (collapse) keeps vertex groups, so skinning survives; UVs are
# preserved well enough for kit texturing at the distances these are shown.
for li, ratio in enumerate(spec.get("lods", [0.35, 0.12]), start=1):
    total = 0
    for o in children:
        if o.type != "MESH" or len(o.data.polygons) < 200:
            continue
        activate(o)
        m = o.modifiers.new("lod", "DECIMATE")
        m.ratio = ratio; m.use_collapse_triangulate = True
        # keep the armature modifier last so the exporter still sees a skin
        bpy.ops.object.modifier_move_to_index(modifier="lod", index=0)
        bpy.ops.object.modifier_apply(modifier="lod")
        o.data.calc_loop_triangles(); total += len(o.data.loop_triangles)
    bpy.ops.object.select_all(action="DESELECT")
    export_root.select_set(True)
    for c in children:
        c.select_set(True)
    bpy.context.view_layer.objects.active = export_root
    lod_glb = os.path.join(out_dir, f"{name}_lod{li}.glb")
    bpy.ops.export_scene.gltf(filepath=lod_glb, export_format="GLB", use_selection=True,
                              export_apply=False, export_animations=False, export_skins=True,
                              export_image_format=spec.get("image_format", "WEBP"),
                              export_image_quality=int(spec.get("image_quality", 85)), export_yup=True)
    print(f"[make_player] wrote {lod_glb} ratio={ratio} tris={total} ({os.path.getsize(lod_glb)//1024} KB)")

# Optional .blend of the rigged, dressed character (used as a retarget target).
if save_blend:
    for o in bpy.data.objects:
        if o not in [export_root] + list(children):
            bpy.data.objects.remove(o, do_unlink=True)
    os.makedirs(os.path.dirname(os.path.abspath(save_blend)) or ".", exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(save_blend), copy=True)
    print(f"[make_player] wrote {save_blend}")
