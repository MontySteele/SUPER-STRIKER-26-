"""Headless crowd impostor atlas baker (§7A.5, crowd v2).

    blender -b --python pipeline/crowd/bake_crowd.py -- [--out public/crowd] \
        [--bodies 0,3] [--poses 0,1] [--samples 48] [--work /tmp/crowdbake] [--pack-only]

Builds a small cast of MPFB humans dressed for a football ground (jackets,
jeans, jumpers, a club scarf on most of them), poses each one in every crowd
pose by transferring a frame of one of the retargeted Mixamo clips already in
public/models/anim, and renders a front ORTHOGRAPHIC card per (body, pose) with
Cycles. The cards are packed into two atlases that crowd.ts draws as
camera-facing, Y-locked impostors:

  crowd_albedo.webp   RGB = albedo x sky visibility (Cycles under a uniform
                      white sky, i.e. albedo with its own ambient occlusion
                      baked in), sRGB. A = coverage. Wherever the TOP GARMENT is,
                      RGB is replaced by a neutral grey whose mean over the
                      garment is 0.5 — the shader multiplies it by the fan's own
                      coat colour x2, so folds, seams and prints survive the
                      recolour and every body can wear any club's colours.
  crowd_data.webp     R,G = card-space normal x/y (0.5 = 0), B = top-garment
                      mask, A = club-accent mask (the scarf). Linear.

Transparent texels are dilated from their neighbours before writing, so the
mip chain never bleeds black into a silhouette (the "dark halo" that makes
alpha-tested foliage look cut out of paper).

Layout: one ROW per body, one COLUMN per pose, CELL_W x CELL_H texels each,
covering CARD_W x CARD_H metres. `crowd_atlas.json` carries the grid, the
metres, the foot line and the pose names so the runtime never hard-codes them.

Camera: orthographic, looking along +Y at the figure's front, tilted DOWN by
TILT degrees — the broadcast cameras sit above the stands' lower rows, and a
card that shows a sliver of shoulder-top reads as a body from there where a
dead-level elevation reads as a cut-out.
"""
import bpy, importlib, json, math, os, subprocess, sys
import numpy as np
from mathutils import Matrix, Vector, Quaternion

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ANIM = os.path.join(REPO, "public", "models", "anim")


def dynamic_import(absolute_package_str, key):
    for amod in list(sys.modules):
        if amod.endswith(absolute_package_str):
            mod = importlib.import_module(amod)
            return getattr(mod, key)
    raise ValueError(f"no module ending in {absolute_package_str}")


HumanService = dynamic_import("mpfb.services.humanservice", "HumanService")
AssetService = dynamic_import("mpfb.services.assetservice", "AssetService")
TargetService = dynamic_import("mpfb.services.targetservice", "TargetService")

# ------------------------------------------------------------------ args
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if name in argv:
        return argv[argv.index(name) + 1]
    return default


OUT = os.path.abspath(arg("--out", os.path.join(REPO, "public", "crowd")))
WORK = os.path.abspath(arg("--work", "/tmp/ss26_crowdbake"))
SAMPLES = int(arg("--samples", "48"))
os.makedirs(OUT, exist_ok=True)
os.makedirs(WORK, exist_ok=True)

# ------------------------------------------------------------------ layout
CELL_W, CELL_H = 160, 320
CARD_H = 2.30              # metres the cell covers vertically
CARD_W = CARD_H * CELL_W / CELL_H
FOOT = 0.05                # metres from the bottom edge to the ground point
TILT = 7.0                 # degrees the camera looks down

# ------------------------------------------------------------------ poses
# (name, clip, frame, extra). Frames were picked from the clips' own hand and
# hip heights (see the probe in the commit that added this file): the apex of
# a fist pump, the open and shut of a clap, the first seated frame of
# "jumping out of seat". `scarf` stretches a scarf between the two hands.
POSES = [
    ("idle",        "mx_Standing_Idle", 0, {}),
    ("idle_b",      "mx_Weight_Shift_Idle", 165, {}),
    ("clap_open",   "mx_Clap_While_Standing", 18, {}),
    ("clap_shut",   "mx_Clap_While_Standing", 22, {}),
    ("arms_up",     "mx_Male_Cheering_With_Two_Fists_Pump", 30, {}),
    ("arms_v",      "mx_Celebrating_After_A_Win", 36, {}),
    ("fist",        "mx_Vexed_Shaking_Of_The_Fist", 20, {}),
    ("scarf_up",    "mx_Male_Cheering_With_Two_Fists_Pump", 40, {"scarf": True}),
    ("dismay",      "mx_Disappointed_Awe_Shucks", 36, {}),
    ("seated",      "mx_Surprised_Jumping_Out_Of_Seat", 0, {}),
    ("seated_b",    "mx_High_Enthusiasm_Fist_Pump", 0, {}),
    ("seated_fist", "mx_High_Enthusiasm_Fist_Pump", 9, {}),
]

# ------------------------------------------------------------------ bodies
# Clothes are MPFB library assets. The TOP garment is found per vertex from its
# skin weights (see top_attribute), so a one-piece "casualsuit" still splits
# into a recolourable shirt and a pair of jeans that keep their denim.
BODIES = [
    dict(name="m_jacket", gender=1.0, age=0.5, weight=0.55, muscle=0.5, height=0.55,
         race=dict(caucasian=0.9, african=0.05, asian=0.05),
         skin="middleage_caucasian_male.mhmat", hair="short02.mhclo", hair_color=(0.10, 0.07, 0.05),
         clothes=["male_casualsuit05.mhclo", "shoes06.mhclo"], legs=(0.040, 0.050, 0.085, 1.0), scarf=True),
    dict(name="m_denim", gender=1.0, age=0.5, weight=0.5, muscle=0.6, height=0.6,
         race=dict(caucasian=0.05, african=0.9, asian=0.05),
         skin="young_african_male.mhmat", hair="short04.mhclo", hair_color=(0.03, 0.025, 0.02),
         clothes=["male_casualsuit01.mhclo", "shoes02.mhclo"], legs=(0.075, 0.095, 0.150, 1.0), scarf=True),
    dict(name="m_tee", gender=1.0, age=0.55, weight=0.45, muscle=0.5, height=0.5,
         race=dict(caucasian=0.1, african=0.05, asian=0.85),
         skin="young_asian_male.mhmat", hair="short01.mhclo", hair_color=(0.03, 0.03, 0.03),
         clothes=["male_casualsuit02.mhclo", "shoes01.mhclo"], legs=(0.022, 0.022, 0.024, 1.0), scarf=False),
    dict(name="m_old_jumper", gender=1.0, age=0.85, weight=0.7, muscle=0.4, height=0.45,
         race=dict(caucasian=0.95, african=0.0, asian=0.05),
         skin="old_caucasian_male.mhmat", hair="short03.mhclo", hair_color=(0.55, 0.53, 0.50),
         clothes=["toigo_fisherman_sweater.mhclo", "toigo_wool_pants.mhclo", "shoes03.mhclo"], legs=(0.110, 0.095, 0.070, 1.0), scarf=True),
    dict(name="m_check", gender=1.0, age=0.45, weight=0.5, muscle=0.55, height=0.62,
         race=dict(caucasian=0.5, african=0.4, asian=0.1),
         skin="toigo_light_skin_male_bronze.mhmat", hair="cortu_short_messy_hair.mhclo", hair_color=(0.12, 0.07, 0.04),
         clothes=["male_casualsuit03.mhclo", "shoes06.mhclo"], legs=(0.028, 0.034, 0.070, 1.0), scarf=False),
    dict(name="m_replica", gender=1.0, age=0.5, weight=0.4, muscle=0.6, height=0.58,
         race=dict(caucasian=0.85, african=0.05, asian=0.1),
         skin="young_caucasian_male.mhmat", hair="short04.mhclo", hair_color=(0.35, 0.24, 0.12),
         clothes=["male_casualsuit06.mhclo", "shoes01.mhclo"], legs=(0.110, 0.130, 0.190, 1.0), scarf=True),
    dict(name="f_tee", gender=0.0, age=0.5, weight=0.45, muscle=0.4, height=0.6,
         race=dict(caucasian=0.9, african=0.05, asian=0.05),
         skin="young_caucasian_female.mhmat", hair="ponytail01.mhclo", hair_color=(0.30, 0.18, 0.08),
         clothes=["female_casualsuit01.mhclo", "shoes05.mhclo"], legs=(0.030, 0.030, 0.034, 1.0), scarf=True),
    dict(name="f_jumper", gender=0.0, age=0.55, weight=0.55, muscle=0.4, height=0.55,
         race=dict(caucasian=0.05, african=0.9, asian=0.05),
         skin="middleage_african_female.mhmat", hair="afro01.mhclo", hair_color=(0.03, 0.025, 0.02),
         clothes=["toigo_fisherman_sweater.mhclo", "cortu_cargo_pants.mhclo", "shoes02.mhclo"], legs=(0.160, 0.135, 0.085, 1.0), scarf=False),
    dict(name="m_heavy", gender=1.0, age=0.55, weight=0.95, muscle=0.35, height=0.55,
         race=dict(caucasian=0.8, african=0.1, asian=0.1),
         skin="middleage_caucasian_male.mhmat", hair="short02.mhclo", hair_color=(0.20, 0.15, 0.10),
         clothes=["male_casualsuit04.mhclo", "shoes03.mhclo"], legs=(0.045, 0.047, 0.052, 1.0), scarf=True),
    dict(name="f_bob", gender=0.0, age=0.52, weight=0.4, muscle=0.45, height=0.5,
         race=dict(caucasian=0.1, african=0.05, asian=0.85),
         skin="young_asian_female.mhmat", hair="bob01.mhclo", hair_color=(0.02, 0.02, 0.02),
         clothes=["female_casualsuit01.mhclo", "shoes01.mhclo"], legs=(0.060, 0.075, 0.125, 1.0), scarf=True),
]

TOP_BONES = ("Spine", "Neck", "Shoulder", "Arm", "ForeArm", "Hand")  # substring tests below
LEG_BONES = ("Hips", "UpLeg", "Leg", "Foot", "Toe")

sel_bodies = [int(x) for x in arg("--bodies", "").split(",") if x != ""] or list(range(len(BODIES)))
sel_poses = [int(x) for x in arg("--poses", "").split(",") if x != ""] or list(range(len(POSES)))
if "--pack-only" in argv:      # re-pack the cached cells without rendering
    sel_bodies = []


def asset(subdir, fname):
    p = AssetService.find_asset_absolute_path(fname, asset_subdir=subdir)
    if p is None:
        print(f"[crowd] MISSING {subdir}/{fname}")
    return p


def bone_class(name):
    n = name.replace("mixamorig:", "")
    if any(n.startswith(k) or n.startswith("Left" + k) or n.startswith("Right" + k) for k in LEG_BONES):
        return "leg"
    if any(k in n for k in TOP_BONES) or n.startswith("Head"):
        return "top"
    return None


def top_attribute(obj, hip_z):
    """1 = upper-body garment, 0 = legwear, decided per LOOSE PART.

    A one-piece MPFB "casualsuit" is a jacket and a pair of jeans in one mesh,
    but they are separate islands, and an island is what a person would call
    one garment. Classifying per vertex from the skin weights split the jacket
    at the belt line (its hem is weighted to the hips, like the waistband), so
    the island votes instead: the sum of its upper-body weight against its leg
    weight, the hips counting for neither.
    """
    n = len(obj.data.vertices)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in obj.data.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    groups = {g.index: bone_class(g.name) for g in obj.vertex_groups}
    vote = {}
    for v in obj.data.vertices:
        t = l = 0.0
        for g in v.groups:
            c = groups.get(g.group)
            if c == "top":
                t += g.weight
            elif c == "leg" and not obj.vertex_groups[g.group].name.endswith("Hips"):
                l += g.weight
        r = find(v.index)
        vt, vl = vote.get(r, (0.0, 0.0))
        vote[r] = (vt + t, vl + l)
    # Some suits are ONE island (a shirt sewn onto its jeans). An island that
    # holds a real share of both falls back to a per-vertex vote, where a
    # vertex weighted only to the hips goes by height: above the hip joint is
    # the shirt tail, below it is the waistband.
    per_vertex = {}
    counts = {}
    for v in obj.data.vertices:
        t = l = 0.0
        for g in v.groups:
            c = groups.get(g.group)
            if c == "top":
                t += g.weight
            elif c == "leg" and not obj.vertex_groups[g.group].name.endswith("Hips"):
                l += g.weight
        if t == 0.0 and l == 0.0:
            top = v.co.z > hip_z
        else:
            top = t > l
        per_vertex[v.index] = top
        r = find(v.index)
        ct, cn = counts.get(r, (0, 0))
        counts[r] = (ct + (1 if top else 0), cn + 1)
    attr = obj.data.attributes.new("crowd_top", "FLOAT", "POINT")
    for i in range(n):
        r = find(i)
        ct, cn = counts[r]
        share = ct / max(1, cn)
        if 0.15 < share < 0.85:
            val = per_vertex[i]
        else:
            vt, vl = vote[r]
            val = vt > vl
        attr.data[i].value = 1.0 if val else 0.0


# ------------------------------------------------------------ materials
def prep_material(mat, top_attr, accent, flat=None):
    """Flatten the response to pure diffuse and hang the mask AOV on it."""
    mat.use_nodes = True
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED":
            for sock, val in (("Specular IOR Level", 0.0), ("Roughness", 1.0),
                              ("Subsurface Weight", 0.0), ("Coat Weight", 0.0),
                              ("Sheen Weight", 0.0), ("Metallic", 0.0)):
                if sock in n.inputs and not n.inputs[sock].is_linked:
                    n.inputs[sock].default_value = val
            if flat is not None:
                bc = n.inputs["Base Color"]
                for l in list(bc.links):
                    nt.links.remove(l)
                bc.default_value = (*flat, 1.0)
    aov = nt.nodes.new("ShaderNodeOutputAOV")
    aov.aov_name = "mask"
    comb = nt.nodes.new("ShaderNodeCombineColor")
    if top_attr:
        at = nt.nodes.new("ShaderNodeAttribute")
        at.attribute_name = "crowd_top"
        nt.links.new(at.outputs["Fac"], comb.inputs[0])
    comb.inputs[1].default_value = 1.0 if accent else 0.0
    comb.inputs[2].default_value = 1.0 if top_attr else 0.0   # "is a garment"
    nt.links.new(comb.outputs[0], aov.inputs["Color"])
    # The mask is rendered as a SECOND pass through these nodes rather than
    # read from the AOV: an AOV is written by the first surface a ray hits even
    # when that surface is alpha-cut, so the invisible top of a pair of jeans
    # stamped "jeans" over the T-shirt hem that shows through it. Emission mixed
    # with transparency by the material's own alpha composites exactly like
    # the colour pass does.
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if out is None:
        return
    surf = out.inputs["Surface"]
    orig = surf.links[0].from_socket if surf.links else None
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(comb.outputs[0], em.inputs["Color"])
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    alpha = bsdf.inputs["Alpha"] if bsdf is not None and "Alpha" in bsdf.inputs else None
    if alpha is not None and alpha.is_linked:
        nt.links.new(alpha.links[0].from_socket, mix.inputs[0])
    else:
        mix.inputs[0].default_value = alpha.default_value if alpha is not None else 1.0
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    MASK_SWAPS.append((nt, surf, orig, mix.outputs[0]))


MASK_SWAPS = []


def set_mask_mode(on):
    for nt, surf, orig, mask_out in MASK_SWAPS:
        for l in list(surf.links):
            nt.links.remove(l)
        src = mask_out if on else orig
        if src is not None:
            nt.links.new(src, surf)
    scn = bpy.context.scene
    scn.cycles.use_denoising = not on
    scn.cycles.samples = 24 if on else SAMPLES


def plain_material(name, rgb, accent):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    prep_material(m, False, accent)
    return m


def striped_scarf_material(name):
    """Two-tone bands along the scarf's length: the shader tints it with ONE
    club colour, and the luminance bands turn that into the classic bar scarf."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = 7.0
    nt.links.new(sep.outputs[0], mul.inputs[0])
    fr = nt.nodes.new("ShaderNodeMath"); fr.operation = "FRACT"
    nt.links.new(mul.outputs[0], fr.inputs[0])
    gt = nt.nodes.new("ShaderNodeMath"); gt.operation = "GREATER_THAN"; gt.inputs[1].default_value = 0.5
    nt.links.new(fr.outputs[0], gt.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value = 0.30
    mr.inputs["To Max"].default_value = 0.85
    nt.links.new(gt.outputs[0], mr.inputs["Value"])
    nt.links.new(mr.outputs[0], bsdf.inputs["Base Color"])
    prep_material(m, False, True)
    return m


# ------------------------------------------------------------ building
def build_body(b):
    bpy.ops.wm.read_homefile(use_empty=True)
    MASK_SWAPS.clear()
    macro = TargetService.get_default_macro_info_dict()
    macro.update({k: b[k] for k in ("gender", "age", "muscle", "weight", "height")})
    # MPFB age 0.5 is 25 years; under that the macro walks back into
    # adolescence (0.3 is a 1.40 m teenager), so the cast stays at or above it
    macro["proportions"] = 0.5
    macro["race"] = b["race"]
    basemesh = HumanService.create_human(macro_detail_dict=macro)
    skin = asset("skins", b["skin"])
    if skin:
        HumanService.set_character_skin(skin, basemesh, skin_type="GAMEENGINE")
    HumanService.add_builtin_rig(basemesh, "mixamo")
    rig = basemesh.parent
    parts = [("eyes", "low-poly.mhclo", "Eyes"), ("eyebrows", "eyebrow001.mhclo", "Eyebrows"),
             ("hair", b["hair"], "Hair")] + [("clothes", c, "Clothes") for c in b["clothes"]]
    clothes = []
    hair = []
    for subdir, fname, atype in parts:
        p = asset(subdir, fname)
        if not p:
            continue
        before = set(bpy.data.objects)
        HumanService.add_mhclo_asset(p, basemesh, asset_type=atype, material_type="GAMEENGINE")
        new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
        if atype == "Clothes":
            clothes += new
        if atype == "Hair":
            hair += new
    # bake the macro shape keys so the armature deforms the final body
    bpy.context.view_layer.objects.active = basemesh
    if basemesh.data.shape_keys:
        bpy.ops.object.select_all(action="DESELECT")
        basemesh.select_set(True)
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    for m in list(basemesh.modifiers):
        if m.type == "SUBSURF":
            basemesh.modifiers.remove(m)

    # materials: flat diffuse + mask AOV
    done = set()
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        is_cloth = o in clothes and not any(k in o.name.lower() for k in ("shoe", "boot"))
        if is_cloth:
            top_attribute(o, rig.data.bones["mixamorig:Hips"].head_local.z)
        for slot in o.material_slots:
            m = slot.material
            if m is None or (m.name, is_cloth) in done:
                continue
            if is_cloth:
                # clothes may share nothing with the body; copy so the AOV is per-use
                pass
            prep_material(m, is_cloth, False)
            done.add((m.name, is_cloth))
        if o in hair:
            for slot in o.material_slots:
                tint_hair(slot.material, b["hair_color"])
    scarf = add_neck_scarf(rig) if b.get("scarf") else None
    return rig, basemesh


def tint_hair(mat, rgb):
    if mat is None:
        return
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return
    link = next((l for l in nt.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    mix.inputs[7].default_value = (*[c * 2.2 for c in rgb], 1.0)
    if link:
        nt.links.new(link.from_socket, mix.inputs[6])
    else:
        mix.inputs[6].default_value = (0.5, 0.5, 0.5, 1)
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])


def add_neck_scarf(rig):
    """A knitted club scarf wound round the collar. Bone-parented to the neck
    so it follows every pose."""
    neck = rig.data.bones["mixamorig:Neck"]
    base = rig.matrix_world @ neck.head_local
    mat = striped_scarf_material("scarf_worn")
    bpy.ops.mesh.primitive_torus_add(major_radius=0.085, minor_radius=0.034,
                                     major_segments=20, minor_segments=8,
                                     location=(base.x, base.y - 0.012, base.z - 0.015))
    ring = bpy.context.active_object
    ring.scale = (1.25, 1.12, 0.85)
    ring.rotation_euler = (math.radians(-12), 0, 0)
    objs = [ring]
    # No tails. Two club-coloured strips down the chest read as a shirt
    # NUMBER ("11") on every scarf-wearer at crowd distance; the ring alone
    # reads as a scarf.
    bpy.context.view_layer.update()
    for o in objs:
        o.data.materials.append(mat)
        mw = o.matrix_world.copy()
        o.parent = rig
        o.parent_type = "BONE"
        o.parent_bone = "mixamorig:Neck"
        o.matrix_world = mw
    return objs


# ------------------------------------------------------------ posing
def load_clip(clip):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ANIM, clip + ".glb"))
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == "ARMATURE")
    return src, new


def transfer_pose(src, tgt, frame):
    """World-space rotation deltas, parent first (both rigs are MPFB 'mixamo'
    rigs, but the glTF round trip re-axes the source's bones, so local
    rotations do not transfer and world deltas do)."""
    scn = bpy.context.scene
    scn.frame_set(frame)
    bpy.context.view_layer.update()
    sw = src.matrix_world
    tw = tgt.matrix_world
    for pb in tgt.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    # source hip height ratio, for the root translation
    s_hip_rest = (sw @ src.data.bones["mixamorig:Hips"].matrix_local).to_translation()
    t_hip_rest = (tw @ tgt.data.bones["mixamorig:Hips"].matrix_local).to_translation()
    ratio = t_hip_rest.z / max(1e-3, s_hip_rest.z)
    posed = {}

    def walk(bone):
        name = bone.name
        spb = src.pose.bones.get(name)
        t_rest_w = tw @ bone.matrix_local
        if spb is not None:
            s_rest_w = sw @ src.data.bones[name].matrix_local
            s_pose_w = sw @ spb.matrix
            rot = (s_pose_w.to_quaternion() @ s_rest_w.to_quaternion().inverted()) @ t_rest_w.to_quaternion()
        else:
            rot = t_rest_w.to_quaternion()
        if bone.parent is None:
            s_head = (sw @ spb.matrix).to_translation() if spb else t_rest_w.to_translation()
            head = Vector((s_head.x * ratio, s_head.y * ratio, s_head.z * ratio))
        else:
            pw = posed[bone.parent.name]
            rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
            head = (pw @ rel).to_translation()
        w = Matrix.Translation(head) @ rot.to_matrix().to_4x4()
        posed[name] = w
        tgt.pose.bones[name].matrix = tw.inverted() @ w
        bpy.context.view_layer.update()
        for c in bone.children:
            walk(c)

    for b in tgt.data.bones:
        if b.parent is None:
            walk(b)


def evaluated_bounds(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != "MESH" or o.hide_render:
            continue
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        mw = e.matrix_world
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        if len(co):
            m = np.array(mw)
            w = co @ m[:3, :3].T + m[:3, 3]
            lo = Vector(np.minimum(np.array(lo), w.min(0)))
            hi = Vector(np.maximum(np.array(hi), w.max(0)))
        e.to_mesh_clear()
    return lo, hi


def add_held_scarf(rig):
    L = rig.matrix_world @ rig.pose.bones["mixamorig:LeftHand"].tail
    R = rig.matrix_world @ rig.pose.bones["mixamorig:RightHand"].tail
    mid = (L + R) / 2
    d = L - R
    span = d.length + 0.34
    ang = math.atan2(d.z, d.x)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(mid.x, mid.y - 0.05, mid.z + 0.02))
    o = bpy.context.active_object
    o.scale = (span, 0.012, 0.17)
    o.rotation_euler = (0, -ang, 0)
    o.data.materials.append(striped_scarf_material("scarf_held"))
    return o


# ------------------------------------------------------------ render
def setup_render():
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scn.cycles.device = "GPU"
    except Exception as e:  # CPU is fine, just slower
        print("[crowd] GPU unavailable:", e)
    scn.cycles.samples = SAMPLES
    scn.cycles.use_denoising = True
    scn.cycles.max_bounces = 3
    scn.render.film_transparent = True
    scn.render.resolution_x = CELL_W
    scn.render.resolution_y = CELL_H
    scn.render.resolution_percentage = 100
    scn.render.pixel_aspect_x = scn.render.pixel_aspect_y = 1
    scn.view_settings.view_transform = "Standard"
    ims = scn.render.image_settings
    if hasattr(ims, "media_type"):          # Blender 5: multilayer is a media type
        ims.media_type = "MULTI_LAYER_IMAGE"
        ims.file_format = "OPEN_EXR_MULTILAYER"
    else:
        ims.file_format = "OPEN_EXR_MULTILAYER"
    scn.render.image_settings.color_depth = "32"
    vl = scn.view_layers[0]
    vl.use_pass_normal = True
    if "mask" not in [a.name for a in vl.aovs]:
        a = vl.aovs.add()
        a.name = "mask"
        a.type = "COLOR"
    # a uniform white sky: every diffuse texel comes out as albedo x its own
    # sky visibility, which is exactly the AO the runtime would otherwise fake
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (1, 1, 1, 1)
    bg.inputs["Strength"].default_value = 1.0
    scn.world = world
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = CARD_H
    cam = bpy.data.objects.new("cam", cam_data)
    scn.collection.objects.link(cam)
    t = math.radians(TILT)
    f = Vector((0, math.cos(t), -math.sin(t)))
    u = Vector((0, math.sin(t), math.cos(t)))
    a = CARD_H / 2 - FOOT
    cam.location = u * a - f * 12.0
    cam.rotation_euler = (math.pi / 2 - t, 0, 0)
    scn.camera = cam
    return f, u


def render_cell(path):
    scn = bpy.context.scene
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)


def read_parts(path):
    import OpenImageIO as oiio
    chans = {}
    inp = oiio.ImageInput.open(path)
    si = 0
    while inp.seek_subimage(si, 0):
        spec = inp.spec()
        px = inp.read_image(si, 0, 0, spec.nchannels, oiio.FLOAT)
        for i, n in enumerate(spec.channelnames):
            chans[n] = px[:, :, i]
        si += 1
    inp.close()
    return chans


def read_cell(path, f, u):
    import OpenImageIO as oiio
    # Blender 5 writes one EXR PART per pass; read every subimage
    chans = {}
    inp = oiio.ImageInput.open(path)
    si = 0
    while inp.seek_subimage(si, 0):
        spec = inp.spec()
        px = inp.read_image(si, 0, 0, spec.nchannels, oiio.FLOAT)  # H x W x C
        for i, n in enumerate(spec.channelnames):
            chans[n] = px[:, :, i]
        si += 1
    inp.close()

    def ch(suffix):
        for n, v in chans.items():
            if n.endswith(suffix):
                return v
        raise KeyError(f"{suffix} not in {list(chans)}")

    rgba = np.stack([ch("Combined.R"), ch("Combined.G"), ch("Combined.B"), ch("Combined.A")], -1)
    nrm = np.stack([ch("Normal.X"), ch("Normal.Y"), ch("Normal.Z")], -1)
    mchans = read_parts(path.replace(".exr", "_mask.exr"))
    ma = [v for k, v in mchans.items() if k.endswith("Combined.A")][0]
    mask = np.stack([[v for k, v in mchans.items() if k.endswith("Combined." + c)][0]
                     for c in "RGB"], -1) / np.maximum(ma, 1e-4)[..., None]
    a = rgba[..., 3:4]
    safe = np.maximum(a, 1e-4)
    col = np.where(a > 1e-3, rgba[..., :3] / safe, 0.0)
    # Cycles' normal/AOV passes are already coverage-normalised per pixel, so
    # they are NOT divided by alpha; only the combined colour is premultiplied.
    right = np.array([1.0, 0.0, 0.0])
    nx = nrm @ right
    ny = nrm @ np.array(u)
    nz = nrm @ -np.array(f)
    n = np.stack([nx, ny, nz], -1)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-4)
    return col, a[..., 0], n, np.clip(mask, 0, 1)


# ------------------------------------------------------------ packing
def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def dilate(img, alpha, passes=24):
    """Push colour outward into transparent texels so no mip ever averages in
    black. Each pass fills a one-texel ring from its covered neighbours."""
    have = alpha > 0.02
    out = img.copy()
    out[~have] = 0
    for _ in range(passes):
        acc = np.zeros_like(out)
        cnt = np.zeros(have.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
            sh = np.roll(np.roll(out, dy, 0), dx, 1)
            hv = np.roll(np.roll(have, dy, 0), dx, 1)
            acc += sh * hv[..., None]
            cnt += hv
        fill = (~have) & (cnt > 0)
        out[fill] = acc[fill] / cnt[fill][:, None]
        have = have | fill
        if have.all():
            break
    if not have.all():
        mean = out[have].mean(0) if have.any() else np.zeros(out.shape[-1])
        out[~have] = mean
    return out


def main():
    f, u = None, None
    cols, rows = len(POSES), len(BODIES)
    albedo = np.zeros((rows * CELL_H, cols * CELL_W, 4), np.float32)
    data = np.zeros((rows * CELL_H, cols * CELL_W, 4), np.float32)
    data[..., 0] = data[..., 1] = 0.5
    cache = os.path.join(WORK, "cells")
    os.makedirs(cache, exist_ok=True)
    for bi in sel_bodies:
        b = BODIES[bi]
        rig, basemesh = build_body(b)
        f, u = setup_render()
        body_objs = [o for o in bpy.data.objects if o.type == "MESH"]
        for pi in sel_poses:
            pname, clip, frame, extra = POSES[pi]
            rig.location = (0, 0, 0)
            bpy.context.view_layer.update()
            src, imported = load_clip(clip)
            for o in imported:
                o.hide_render = True
            transfer_pose(src, rig, frame)
            held = add_held_scarf(rig) if extra.get("scarf") else None
            # ground the lowest vertex and centre the hips
            lo, hi = evaluated_bounds(body_objs)
            hip = rig.matrix_world @ rig.pose.bones["mixamorig:Hips"].head
            rig.location = (-hip.x, -hip.y, -lo.z)
            if held:
                held.location += Vector((-hip.x, -hip.y, -lo.z))
            bpy.context.view_layer.update()
            path = os.path.join(cache, f"b{bi:02d}_p{pi:02d}.exr")
            render_cell(path)
            set_mask_mode(True)
            render_cell(path.replace(".exr", "_mask.exr"))
            set_mask_mode(False)
            print(f"[crowd] body {b['name']} pose {pname}: height {hi.z - lo.z:.2f} m, width {hi.x - lo.x:.2f} m")
            for o in imported:
                bpy.data.objects.remove(o, do_unlink=True)
            if held:
                bpy.data.objects.remove(held, do_unlink=True)
    # pack every cell that exists on disk (so partial re-bakes still pack)
    if f is None:
        bpy.ops.wm.read_homefile(use_empty=True)
        f, u = setup_render()
    for bi in range(rows):
        for pi in range(cols):
            path = os.path.join(cache, f"b{bi:02d}_p{pi:02d}.exr")
            if not os.path.exists(path):
                continue
            col, a, n, mask = read_cell(path, f, u)
            top = mask[..., 0]
            acc = mask[..., 1]
            # Legwear: the library dresses nearly everyone in the same bright
            # stonewash, and a stand of it is a wall of blue legs. Each body
            # gets its own trousers instead — dark denim, black, navy, charcoal,
            # khaki — as a luminance-preserving recolour of the garment.
            legs = np.clip(mask[..., 2] - top, 0, 1)
            lr, lg, lb, lk = BODIES[bi].get("legs", (0.05, 0.06, 0.10, 1.0))  # linear albedo
            lum0 = col @ np.array([0.2126, 0.7152, 0.0722])
            wl = a * legs
            ml = (lum0 * wl).sum() / max(1e-3, wl.sum())
            # clamp the relative luminance: several suits paint the tucked-in
            # shirt hem onto the jeans' waistband, and x5 of a white hem on a
            # dark trouser colour came out as a white belt on every fan
            rel = np.clip(lum0 / max(1e-3, ml), 0.0, 1.6)
            recol = rel[..., None] * np.array([lr, lg, lb]) * lk
            col = col * (1 - legs[..., None]) + np.clip(recol, 0, 1) * legs[..., None]
            # neutralise the top garment: grey whose mean over the garment is 0.5
            lum = col @ np.array([0.2126, 0.7152, 0.0722])
            wgt = a * top
            mean = (lum * wgt).sum() / max(1e-3, wgt.sum())
            grey = np.clip(lum / max(1e-3, mean) * 0.5, 0, 1)
            col = col * (1 - top[..., None]) + grey[..., None] * top[..., None]
            # the scarf keeps its own two-tone luminance, normalised the same way
            wa = a * acc
            if wa.sum() > 1:
                mean_a = (lum * wa).sum() / wa.sum()
                ga = np.clip(lum / max(1e-3, mean_a) * 0.5, 0, 1)
                col = col * (1 - acc[..., None]) + ga[..., None] * acc[..., None]
            y0, x0 = bi * CELL_H, pi * CELL_W
            cell_col = dilate(np.concatenate([col, n[..., :2], mask[..., :2]], -1), a)
            albedo[y0:y0 + CELL_H, x0:x0 + CELL_W, :3] = cell_col[..., :3]
            albedo[y0:y0 + CELL_H, x0:x0 + CELL_W, 3] = a
            data[y0:y0 + CELL_H, x0:x0 + CELL_W, 0] = cell_col[..., 3] * 0.5 + 0.5
            data[y0:y0 + CELL_H, x0:x0 + CELL_W, 1] = cell_col[..., 4] * 0.5 + 0.5
            data[y0:y0 + CELL_H, x0:x0 + CELL_W, 2] = cell_col[..., 5]
            data[y0:y0 + CELL_H, x0:x0 + CELL_W, 3] = cell_col[..., 6]
    albedo[..., :3] = srgb(albedo[..., :3])
    write_png(os.path.join(WORK, "crowd_albedo.png"), albedo)
    write_png(os.path.join(WORK, "crowd_data.png"), data)
    for nm in ("crowd_albedo", "crowd_data"):
        subprocess.run(["cwebp", "-quiet", "-lossless", "-exact", "-z", "9",
                        os.path.join(WORK, nm + ".png"), "-o", os.path.join(OUT, nm + ".webp")], check=True)
    meta = dict(cols=cols, rows=rows, cellW=CELL_W, cellH=CELL_H, cardW=CARD_W, cardH=CARD_H,
                foot=FOOT, tilt=TILT, poses=[p[0] for p in POSES],
                bodies=[dict(name=b["name"], scarf=bool(b.get("scarf"))) for b in BODIES])
    json.dump(meta, open(os.path.join(OUT, "crowd_atlas.json"), "w"), indent=1)
    print("[crowd] wrote", OUT)


def write_png(path, arr):
    import OpenImageIO as oiio
    h, w, c = arr.shape
    spec = oiio.ImageSpec(w, h, c, oiio.UINT8)
    buf = oiio.ImageBuf(spec)
    buf.set_pixels(oiio.ROI(0, w, 0, h, 0, 1, 0, c), np.clip(arr, 0, 1).astype(np.float32))
    # OIIO would unpremultiply/associate alpha on some writers; say it is not
    buf.specmod().attribute("oiio:UnassociatedAlpha", 1)
    buf.write(path)


main()
