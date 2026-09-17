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
  tex_max (px), image_format (WEBP|AUTO), lods [ratio,...] (default [0.35, 0.12]), preview (bool)
"""
import bpy, importlib, json, math, os, sys


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

parts = [
    ("eyes", spec.get("eyes", "low-poly.mhclo"), "Eyes"),
    ("eyebrows", spec.get("eyebrows", "eyebrow001.mhclo"), "Eyebrows"),
    ("eyelashes", spec.get("eyelashes", "eyelashes01.mhclo"), "Eyelashes"),
    ("teeth", spec.get("teeth", "teeth_shape01.mhclo"), "Teeth"),
    ("tongue", spec.get("tongue", "tongue01.mhclo"), "Tongue"),
    ("hair", spec.get("hair", "short01.mhclo"), "Hair"),
    ("clothes", spec.get("shirt", "elvs_crude_t-shirt_male.mhclo"), "Clothes"),
    ("clothes", spec.get("shorts", "cortu_jeans_shorts.mhclo"), "Clothes"),
    ("clothes", spec.get("shoes", "shoes06.mhclo"), "Clothes"),
]
for subdir, fname, atype in parts:
    if not fname:
        continue
    p = asset(subdir, fname)
    if p:
        HumanService.add_mhclo_asset(p, basemesh, asset_type=atype, material_type="GAMEENGINE")

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

# --- texture budget: nothing above tex_max px (default 1024) ------------------
tex_max = int(spec.get("tex_max", 1024))
for img in bpy.data.images:
    if img.size[0] > tex_max or img.size[1] > tex_max:
        w, h = img.size
        f = tex_max / max(w, h)
        img.scale(max(1, int(w * f)), max(1, int(h * f)))
        print(f"[make_player] scaled {img.name} {w}x{h} -> {img.size[0]}x{img.size[1]}")

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
        scene.render.filepath = os.path.join(out_dir, f"{name}_{tag}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[make_player] preview {scene.render.filepath}")

# --- LODs: cumulative decimation of every mesh, exported as <name>_lod<n>.glb.
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
