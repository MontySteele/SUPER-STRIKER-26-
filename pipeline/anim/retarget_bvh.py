"""Headless mocap -> MPFB "mixamo" rig retargeter (CMU/DAZ .bvh and Mixamo .fbx).

    blender -b --python pipeline/anim/retarget_bvh.py -- \
        --target <rigged.blend | spec.json> --out <dir> \
        --clips a.bvh b.fbx ... [--fps 30] [--preview] [--foot-lock] [--force]

Per clip:
  1. Imports the clip.  Two source profiles, picked by extension:
       .bvh  CMU "daz-friendly" conversion -- Y-up, figure facing +Z, +X to its
             left, 120 fps, T-pose-ish rest, DAZ joint names.  The importer's
             default axis conversion lands it upright facing -Y with +X still to
             its left, the orientation an MPFB character has.
       .fbx  Mixamo Y Bot -- already Z-up facing -Y with +X to its left after
             import, 30 fps, T-pose rest, bone names identical to the target
             (identity name map).  automatic_bone_orientation is left OFF to keep
             the source rest faithful (on these files it changes nothing).
     Either way the source armature is uniformly scaled so its median hip height
     matches the target's, so hip translation retargets at the right magnitude.
  2. Retargets by world-space deltas.  For each mapped pair we take the source
     bone's per-frame world rotation, strip its world *rest* rotation, and apply
     that delta to a *reference* world rotation of the target bone:

         R_target(f) = ( R_src(f) . R_src_rest^-1 ) . R_target_ref

     For the limbs R_target_ref is the target's rest rotation pre-rotated by the
     minimal arc that swings the target's rest bone direction onto the source's
     -- that is what bridges a T-pose source and the target's A-pose (without it,
     an arm hanging at the side ends up 45 deg further down, crossing the body).
     For torso / neck / head / clavicle the plain rest rotation is used: both rigs
     are neutral-upright there and their bone axes differ only by rig convention,
     so auto-aligning would bake in a permanent tilt (the DAZ head bone points
     45 deg forward at the eyes, for instance).  BVH clips additionally take the
     neck/head source reference rest from the clip's own median pose (see
     PROFILES); Mixamo data is clean and is left alone.
  3. Bakes one Action per clip at the requested fps (default 30), trims idle, and
     runs the GROUND LOCK pass (see ground_lock) so the stance foot's *sole* --
     measured from the character's own shoe mesh, not the bone plane -- sits on
     z=0 every frame, while airborne phases keep their ballistic arc.
     Optional --foot-lock additionally IK-holds the planted foot's world XY.
  4. Exports ANIMATION-ONLY GLBs: one per clip holding the armature and that one
     animation and nothing else (tens of KB), plus `all_clips.glb` with every
     animation and `rig_only.glb` with the bare skeleton.  The game loads the
     character GLB separately and binds clips by bone name.
  5. With --preview, renders an Eevee contact sheet per clip over a ground plane
     (3x2, or 4x2 for clips under 2.2 s so jumps show their apex), camera placed
     on a front three-quarter of the clip's own travel direction.

Action names: `cmu_<stem>` for .bvh, `mx_<stem>` for .fbx.
Ground statistics per clip are written to <out>/ground_stats.json.
"""
import bpy
import json
import math
import os
import subprocess
import sys
import tempfile

from mathutils import Matrix, Quaternion, Vector

M = "mixamorig:"

# (source bone, target bone, align, recenter)
#   align    - correct the T-pose/A-pose rest difference by swinging the target's
#              rest bone direction onto the source's (limbs only).
#   recenter - take the source's *reference rest* for this joint from the clip's
#              own median local pose instead of the skeleton's declared rest.
#              The cmuconvert DAZ rigs derive the head joint's rest from the eye
#              markers and bake a per-subject head-marker calibration into the
#              head/neck channels: 09_11 carries a constant head X of -42 deg,
#              16_35 -13, 35_17 -16, and most clips carry a constant head Z roll
#              of 10-21 deg.  Transferred faithfully that reads as a permanent
#              chin-to-the-sky.  Re-choosing the reference frame (which is what
#              the whole delta method rests on) removes the bias and keeps every
#              bit of real head motion.  Mixamo clips do NOT need this and must
#              not have it: a goalkeeper dive or a header holds a non-neutral
#              head for most of the clip on purpose.
DAZ_MAP = [
    ("hip",      M + "Hips",          False, False),
    ("abdomen",  M + "Spine",         False, False),
    ("chest",    M + "Spine1",        False, False),
    ("chest",    M + "Spine2",        False, False),   # DAZ chest == one rigid segment
    ("neck",     M + "Neck",          False, True),
    ("head",     M + "Head",          False, True),
    ("lCollar",  M + "LeftShoulder",  False, False),
    ("lShldr",   M + "LeftArm",       True,  False),
    ("lForeArm", M + "LeftForeArm",   True,  False),
    ("lHand",    M + "LeftHand",      True,  False),
    ("rCollar",  M + "RightShoulder", False, False),
    ("rShldr",   M + "RightArm",      True,  False),
    ("rForeArm", M + "RightForeArm",  True,  False),
    ("rHand",    M + "RightHand",     True,  False),
    ("lThigh",   M + "LeftUpLeg",     True,  False),
    ("lShin",    M + "LeftLeg",       True,  False),
    ("lFoot",    M + "LeftFoot",      True,  False),
    ("rThigh",   M + "RightUpLeg",    True,  False),
    ("rShin",    M + "RightLeg",      True,  False),
    ("rFoot",    M + "RightFoot",     True,  False),
]

# Mixamo -> our rig: identity names.  Same T-pose/A-pose split as above, plus the
# toes (the source has them and they are clean, and animated toes make the ground
# pass read toe-off correctly).
_MX = [("Hips", False), ("Spine", False), ("Spine1", False), ("Spine2", False),
       ("Neck", False), ("Head", False),
       ("LeftShoulder", False), ("LeftArm", True), ("LeftForeArm", True), ("LeftHand", True),
       ("RightShoulder", False), ("RightArm", True), ("RightForeArm", True), ("RightHand", True),
       ("LeftUpLeg", True), ("LeftLeg", True), ("LeftFoot", True), ("LeftToeBase", True),
       ("RightUpLeg", True), ("RightLeg", True), ("RightFoot", True), ("RightToeBase", True)]
MIXAMO_MAP = [(M + n, M + n, a, False) for n, a in _MX]

PROFILES = {
    ".bvh": {"map": DAZ_MAP, "root": "hip", "ankle": "lFoot", "prefix": "cmu_"},
    ".fbx": {"map": MIXAMO_MAP, "root": M + "Hips", "ankle": M + "LeftFoot", "prefix": "mx_"},
}
ROOT_TARGET = M + "Hips"
FOOT_BONES = {"L": [M + "LeftFoot", M + "LeftToeBase"],
              "R": [M + "RightFoot", M + "RightToeBase"]}

# stance detection (metres per output frame; scaled by fps below)
V_ON = 0.35         # m/s -- a foot slower than this may enter stance
V_OFF = 0.90        # m/s -- ... and leaves it only above this (hysteresis)


def log(*a):
    print("[retarget]", *a)
    sys.stdout.flush()


# --------------------------------------------------------------------------- #
def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    a = {"target": None, "out": None, "clips": [], "fps": 30.0, "preview": False,
         "trim": True, "recenter": True, "preview_dir": None, "foot_lock": False,
         "force": False}
    i = 0
    while i < len(argv):
        t = argv[i]
        if t in ("--target", "--out", "--preview-dir"):
            a[t[2:].replace("-", "_")] = argv[i + 1]; i += 2
        elif t == "--fps":
            a["fps"] = float(argv[i + 1]); i += 2
        elif t == "--preview":
            a["preview"] = True; i += 1
        elif t == "--foot-lock":
            a["foot_lock"] = True; i += 1
        elif t == "--force":
            a["force"] = True; i += 1
        elif t == "--no-trim":
            a["trim"] = False; i += 1
        elif t == "--no-recenter":
            a["recenter"] = False; i += 1
        elif t == "--clips":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                a["clips"].append(argv[i]); i += 1
        else:
            raise SystemExit(f"unknown argument {t}\n{__doc__}")
    if not a["target"] or not a["out"] or not a["clips"]:
        raise SystemExit(__doc__)
    if not a["preview_dir"]:
        a["preview_dir"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "previews")
    return a


def safe_name(stem):
    out = "".join(c if (c.isalnum() or c == "_") else "_" for c in stem)
    while "__" in out:
        out = out.replace("__", "_")
    return out.strip("_")


def clip_id(path):
    ext = os.path.splitext(path)[1].lower()
    stem = os.path.splitext(os.path.basename(path))[0]
    return PROFILES[ext]["prefix"] + safe_name(stem)


# --------------------------------------------------------------------------- #
def load_target(target_path):
    """Open a rigged .blend, or build one from a spec.json via make_player.py."""
    target_path = os.path.abspath(target_path)
    if target_path.endswith(".json"):
        here = os.path.dirname(os.path.abspath(__file__))
        make_player = os.path.normpath(os.path.join(here, "..", "characters", "make_player.py"))
        spec = json.load(open(target_path))
        spec["preview"] = False
        tmp = tempfile.mkdtemp(prefix="retarget_target_")
        spec_path = os.path.join(tmp, "spec.json")
        json.dump(spec, open(spec_path, "w"))
        blend = os.path.join(tmp, "target.blend")
        log(f"building target from spec {target_path}")
        subprocess.run([bpy.app.binary_path, "-b", "--python", make_player, "--",
                        spec_path, tmp, "--save-blend", blend], check=True)
        target_path = blend
    log(f"opening target {target_path}")
    bpy.ops.wm.open_mainfile(filepath=target_path)
    rigs = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not rigs:
        raise SystemExit(f"no armature in {target_path}")
    rig = rigs[0]
    nmesh = len([o for o in bpy.data.objects if o.type == "MESH" and o.parent == rig])
    log(f"target rig '{rig.name}': {len(rig.data.bones)} bones, {nmesh} skinned meshes")
    return rig


# --------------------------------------------------------------------------- #
# import
def bvh_header(path):
    n, dt = 0, 1.0 / 120.0
    with open(path, "r", errors="ignore") as fh:
        for line in fh:
            low = line.strip().lower()
            if low.startswith("frames:"):
                n = int(float(line.split(":")[1]))
            elif low.startswith("frame time"):
                dt = float(line.split(":")[1])
                break
    return n, dt


def import_clip(path):
    """Import a clip; returns (armature, first_frame, last_frame, source_fps)."""
    ext = os.path.splitext(path)[1].lower()
    before = set(bpy.data.objects)
    if ext == ".bvh":
        n, dt = bvh_header(path)
        bpy.ops.import_anim.bvh(
            filepath=path, axis_forward="-Z", axis_up="Y",
            rotate_mode="NATIVE", global_scale=1.0, frame_start=1,
            use_fps_scale=False, update_scene_fps=False, update_scene_duration=False)
        src = (set(bpy.data.objects) - before).pop()
        return src, 1, max(1, n), 1.0 / dt
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(
            filepath=path, use_anim=True, global_scale=1.0,
            automatic_bone_orientation=False, ignore_leaf_bones=False)
        new = [o for o in (set(bpy.data.objects) - before)]
        arms = [o for o in new if o.type == "ARMATURE"]
        if not arms:
            raise RuntimeError(f"no armature in {path}")
        src = arms[0]
        for o in new:                       # Mixamo FBX may carry a stub mesh
            if o is not src:
                bpy.data.objects.remove(o, do_unlink=True)
        act = src.animation_data.action if src.animation_data else None
        if act is None:
            raise RuntimeError(f"no animation in {path}")
        f0, f1 = (int(round(v)) for v in act.frame_range)
        return src, f0, f1, 30.0
    raise RuntimeError(f"unsupported clip type {path}")


# --------------------------------------------------------------------------- #
# retarget maths
def rest_world_rot(obj, bone):
    return (obj.matrix_world @ bone.matrix_local).to_quaternion()


def rest_world_dir(obj, bone):
    m = obj.matrix_world
    v = (m @ bone.tail_local) - (m @ bone.head_local)
    return v.normalized() if v.length > 1e-9 else Vector((0.0, 0.0, 1.0))


def hierarchy_order(arm):
    out, stack = [], [b for b in arm.data.bones if b.parent is None]
    while stack:
        b = stack.pop(0)
        out.append(b.name)
        stack = list(b.children) + stack
    return out


def rest_rel_rot(pb):
    if pb.parent:
        return (pb.parent.bone.matrix_local.inverted() @ pb.bone.matrix_local).to_quaternion()
    return pb.bone.matrix_local.to_quaternion()


def mean_quat(qs):
    ref = qs[0]
    w = x = y = z = 0.0
    for q in qs:
        s = -1.0 if q.dot(ref) < 0.0 else 1.0
        w += s * q.w; x += s * q.x; y += s * q.y; z += s * q.z
    m = Quaternion((w, x, y, z))
    m.normalize()
    return m


def source_local_bias(src, s_bone, frames):
    scene = bpy.context.scene
    pb = src.pose.bones[s_bone.name]
    parent = s_bone.parent
    rest = rest_world_rot(src, s_bone)
    c = (rest_world_rot(src, parent).inverted() @ rest) if parent else rest
    step = max(1, len(frames) // 48)
    ls = []
    for f in frames[::step]:
        scene.frame_set(f)
        r = (src.matrix_world @ pb.matrix).to_quaternion()
        if parent:
            rp = (src.matrix_world @ src.pose.bones[parent.name].matrix).to_quaternion()
            ls.append((rp @ c).inverted() @ r)
        else:
            ls.append(rest.inverted() @ r)
    return mean_quat(ls) if ls else Quaternion()


def build_transfer(src, tgt, bone_map, frames, use_recenter):
    tr = {}
    for s_name, t_name, align, recenter in bone_map:
        s_bone = src.data.bones.get(s_name)
        t_bone = tgt.data.bones.get(t_name)
        if s_bone is None or t_bone is None:
            continue
        ref = rest_world_rot(tgt, t_bone)
        if align:
            ref = rest_world_dir(tgt, t_bone).rotation_difference(rest_world_dir(src, s_bone)) @ ref
        s_rest = rest_world_rot(src, s_bone)
        if recenter and use_recenter:
            bias = source_local_bias(src, s_bone, frames)
            s_rest = s_rest @ bias
            a = math.degrees(bias.angle)
            log(f"  recentred source '{s_name}' by {min(a, 360.0 - a):.1f} deg (clip median pose)")
        tr[t_name] = (s_name, s_rest.inverted(), ref)
    return tr


def rest_hip_above_ankle(obj, hip, ankle):
    """Rest-pose height of the hip joint above the ankle joint.

    This has to be a property of the *skeleton*, not of the clip: measuring the
    clip's median hip height works for locomotion but collapses for anything that
    spends its time on the floor -- a diving save or a slide tackle would report a
    hip height of a few centimetres and the character would be scaled up several
    times over.  Hip-above-ankle is pose independent and, on a standing walk,
    agrees with the old clip-median measure to four decimal places.
    """
    hb, ab = obj.data.bones.get(hip), obj.data.bones.get(ankle)
    if hb is None or ab is None:
        return None
    return ((obj.matrix_world @ hb.head_local).z - (obj.matrix_world @ ab.head_local).z)


def motion_energy(src, bone_map, frames):
    scene = bpy.context.scene
    bones = [src.pose.bones[n] for n, _, _, _ in bone_map if n in src.pose.bones]
    prev, e = None, []
    for f in frames:
        scene.frame_set(f)
        pts = [(src.matrix_world @ pb.matrix).translation.copy() for pb in bones]
        e.append(0.0 if prev is None else sum((p - q).length for p, q in zip(pts, prev)))
        prev = pts
    if len(e) > 1:
        e[0] = e[1]
    return e


def calibration_frames(src, bone_map, frames, thresh_deg=30.0):
    """Leading frames still in the source's own rest (T) pose -- CMU takes open
    with one or two calibration frames that snap into the motion."""
    scene = bpy.context.scene
    bones = [src.data.bones[n] for n, _, _, _ in bone_map if n in src.data.bones]
    rest = [rest_world_rot(src, b).inverted() for b in bones]
    limit = max(1, len(frames) // 4)
    n = 0
    while n < limit:
        scene.frame_set(frames[n])
        dev = 0.0
        for b, ri in zip(bones, rest):
            q = (src.matrix_world @ src.pose.bones[b.name].matrix).to_quaternion() @ ri
            a = math.degrees(q.angle)
            dev = max(dev, min(a, 360.0 - a))
        if dev > thresh_deg:
            break
        n += 1
    return n


def trim_range(energy, lead):
    if len(energy) < 8:
        return 0, len(energy) - 1
    ref = sorted(energy)[int(len(energy) * 0.9)]
    if ref <= 1e-9:
        return 0, len(energy) - 1
    thr = ref * 0.08
    a, b = 0, len(energy) - 1
    while a < b and energy[a] < thr:
        a += 1
    while b > a and energy[b] < thr:
        b -= 1
    return max(0, a - lead), min(len(energy) - 1, b + lead)


# --------------------------------------------------------------------------- #
# sole geometry -- measured from the character, never hard-coded
def build_sole_samples(tgt, keep=48):
    """Lowest skinned points of each foot, as linear-blend-skin samples.

    Returns {"L": [...], "R": [...]} of influence lists and the bind-pose sole
    height per side.  The shoe's weights are spread over the whole leg chain (the
    foot bones only hold ~20% of a sole vertex), so every influence is kept and
    the sole is evaluated with real LBS; the *side* is decided by which foot's
    bones dominate.  Picking vertices this way measures the shoe when the
    character wears one and the bare foot when it does not -- nothing about the
    27 mm sole thickness is hard-coded.
    """
    side_of = {}
    for side, bones in FOOT_BONES.items():
        for b in bones:
            side_of[b] = side
    bones = {b.name for b in tgt.data.bones}
    out = {"L": [], "R": []}
    for o in bpy.data.objects:
        if o.type != "MESH" or o.parent != tgt:
            continue
        idx = {g.index: g.name for g in o.vertex_groups if g.name in bones}
        if not idx:
            continue
        for v in o.data.vertices:
            w = {}
            for ge in v.groups:
                nm = idx.get(ge.group)
                if nm and ge.weight > 1e-4:
                    w[nm] = w.get(nm, 0.0) + ge.weight
            tot = sum(w.values())
            if tot < 1e-6:
                continue
            share = {"L": 0.0, "R": 0.0}
            for nm, x in w.items():
                sd = side_of.get(nm)
                if sd:
                    share[sd] += x / tot
            side = "L" if share["L"] >= share["R"] else "R"
            if share[side] < 0.10:              # not really part of a foot
                continue
            p = o.matrix_world @ v.co
            infl = sorted(w.items(), key=lambda t: -t[1])[:4]
            n = sum(x for _, x in infl)
            out[side].append((p.z, p.copy(), [(nm, x / n) for nm, x in infl]))
    samples, bind = {}, {}
    inv_tgt = tgt.matrix_world.inverted()
    for side, lst in out.items():
        lst.sort(key=lambda t: t[0])
        lst = lst[:keep]
        bind[side] = lst[0][0] if lst else 0.0
        samples[side] = []
        for _, p, ws in lst:
            p_arm = inv_tgt @ p
            samples[side].append(
                [(nm, wt, tgt.data.bones[nm].matrix_local.inverted() @ p_arm) for nm, wt in ws])
    return samples, bind


def pose_matrices(tgt, order, rest_rel_mat, basis, p_a):
    """Armature-space matrix of every bone, computed the way Blender computes it:
    P(bone) = P(parent) @ rest_rel @ basis.  Doing this directly instead of poking
    the pose and calling view_layer.update() keeps the ground pass off the
    depsgraph, which otherwise re-skins ten meshes for every frame we measure."""
    out = {}
    root = tgt.pose.bones[ROOT_TARGET].bone.name
    for name in order:
        b = tgt.data.bones[name]
        q = basis.get(name)
        bm = q.to_matrix().to_4x4() if q is not None else Matrix()
        if b.parent is None:
            arm_rot = b.matrix_local.to_quaternion() @ (q if q is not None else Quaternion())
            out[name] = Matrix.Translation(p_a) @ arm_rot.to_matrix().to_4x4()
        else:
            out[name] = out[b.parent.name] @ rest_rel_mat[name] @ bm
    return out


def build_body_samples(tgt, want=180):
    """A coarse LBS sample of the whole character, for clips where something
    other than a foot touches the floor (dives, slide tackles, falls)."""
    bones = {b.name for b in tgt.data.bones}
    pts = []
    for o in bpy.data.objects:
        if o.type != "MESH" or o.parent != tgt:
            continue
        idx = {g.index: g.name for g in o.vertex_groups if g.name in bones}
        if not idx:
            continue
        stride = max(1, len(o.data.vertices) // max(1, want // 2))
        for vi in range(0, len(o.data.vertices), stride):
            v = o.data.vertices[vi]
            w = {}
            for ge in v.groups:
                nm = idx.get(ge.group)
                if nm and ge.weight > 1e-4:
                    w[nm] = w.get(nm, 0.0) + ge.weight
            if not w:
                continue
            infl = sorted(w.items(), key=lambda t: -t[1])[:4]
            tot = sum(x for _, x in infl)
            pts.append((o.matrix_world @ v.co, [(nm, x / tot) for nm, x in infl]))
    inv_tgt = tgt.matrix_world.inverted()
    out = []
    for p, ws in pts[:want * 3]:
        p_arm = inv_tgt @ p
        out.append([(nm, wt, tgt.data.bones[nm].matrix_local.inverted() @ p_arm)
                    for nm, wt in ws])
    return out


def body_low(tgt, body, mats):
    mw = tgt.matrix_world
    lo = 1e9
    for infl in body:
        p = Vector((0.0, 0.0, 0.0))
        for name, wt, local in infl:
            p += wt * (mats[name] @ local)
        lo = min(lo, (mw @ p).z)
    return lo


def sole_state(tgt, samples, mats):
    """Per side: (lowest sole z, sole centroid) in world space, this frame."""
    mw = tgt.matrix_world
    res = {}
    for side, pts in samples.items():
        lo, c, n = 1e9, Vector((0.0, 0.0, 0.0)), 0
        for infl in pts:
            p = Vector((0.0, 0.0, 0.0))
            for name, wt, local in infl:
                p += wt * (mats[name] @ local)
            p = mw @ p
            lo = min(lo, p.z)
            c += p; n += 1
        res[side] = (lo if n else 0.0, c / max(n, 1))
    return res


def smooth(vals, window):
    if window < 3 or len(vals) < 3:
        return list(vals)
    half = window // 2
    out = []
    for i in range(len(vals)):
        a, b = max(0, i - half), min(len(vals), i + half + 1)
        out.append(sum(vals[a:b]) / (b - a))
    return out


def detect_stance(heights, centroids, fps):
    """Per frame, which foot (if any) is planted.

    A foot enters stance when its 3-D sole speed drops below V_ON and leaves it
    only above V_OFF (hysteresis, so contact does not flicker at its edges).  The
    speed must be 3-D: a vertical jump barely moves the feet horizontally, and a
    planar test would call the whole airborne phase "stance" and glue the jump to
    the floor.  Two height gates then reject a foot that is momentarily still but
    high in the air -- it must be the lower of the two, and within reach of the
    clip's own provisional ground.
    """
    n = len(heights["L"])
    v_on, v_off = V_ON / fps, V_OFF / fps
    lowest = [min(heights["L"][i], heights["R"][i]) for i in range(n)]
    prov = sorted(lowest)[max(0, int(len(lowest) * 0.10))]
    stance = {}
    for side in ("L", "R"):
        c = centroids[side]
        st, on = [], False
        for i in range(n):
            a, b = max(0, i - 1), min(n - 1, i + 1)
            spd = (c[b] - c[a]).length / max(1, b - a)
            on = (spd < v_off) if on else (spd < v_on)
            near = (heights[side][i] <= lowest[i] + 0.04
                    and heights[side][i] <= prov + 0.05)
            st.append(on and near)
        stance[side] = st
    which = []
    for i in range(n):
        cands = [s for s in ("L", "R") if stance[s][i]]
        if not cands:
            which.append(None)
        elif len(cands) == 1:
            which.append(cands[0])
        else:
            which.append("L" if heights["L"][i] <= heights["R"][i] else "R")
    return which


def ground_lock(tgt, cache, fps, samples, body, mats_for):
    """Per-frame hip lift so the stance foot's sole rests on z=0.

    Airborne spans are not glued down: the correction is only *anchored* on
    stance frames and ramps linearly between them, so the raw hip trajectory
    (and with it the ballistic arc of a jump or a run's flight phase) is
    preserved and merely shifted by a slowly varying offset.  A short box
    filter removes contact-to-contact stepping.
    """
    heights = {"L": [], "R": []}
    centroids = {"L": [], "R": []}
    lows = []
    for basis, p_w in cache:
        mats = mats_for(basis, p_w)
        lows.append(body_low(tgt, body, mats))
        st = sole_state(tgt, samples, mats)
        for side in ("L", "R"):
            heights[side].append(st[side][0])
            centroids[side].append(st[side][1])

    which = detect_stance(heights, centroids, fps)
    n = len(which)
    anchors = [(i, -heights[w][i]) for i, w in enumerate(which) if w]
    if not anchors:
        # No foot ever plants -- a dive, a slide tackle, a fall.  Ground the clip
        # on whatever part of the body gets lowest instead of on the feet, which
        # is what actually touches the floor in those clips.
        lo = min(lows)
        off = [-lo] * n
        const = -lo
    else:
        off = [None] * n
        for i, v in anchors:
            off[i] = v
        first, last = anchors[0][0], anchors[-1][0]
        for i in range(first):
            off[i] = anchors[0][1]
        for i in range(last + 1, n):
            off[i] = anchors[-1][1]
        k = 0
        for i in range(first, last + 1):
            if off[i] is None:
                while anchors[k][0] < i:
                    k += 1
                a_i, a_v = anchors[k - 1]
                b_i, b_v = anchors[k]
                t = (i - a_i) / float(b_i - a_i)
                off[i] = a_v + (b_v - a_v) * t
        vals = sorted(v for _, v in anchors)
        const = vals[len(vals) // 2]
    off = smooth(off, max(3, int(round(fps * 0.13)) | 1))
    # penetration guard: never let any part of the body sink through the floor
    deficit = [max(0.0, -(lows[i] + off[i])) for i in range(n)]
    if max(deficit) > 1e-4:
        # dilate before smoothing, otherwise the box filter averages the peak of
        # the correction away and the body still clips through the floor
        w = max(1, int(round(fps * 0.06)))
        dil = [max(deficit[max(0, i - w):min(n, i + w + 1)]) for i in range(n)]
        dil = smooth(dil, max(3, int(round(fps * 0.10)) | 1))
        off = [off[i] + max(dil[i], deficit[i]) for i in range(n)]

    def stats(offsets):
        pen = flo = 0.0
        for i, w in enumerate(which):
            if not w:
                continue
            z = heights[w][i] + offsets[i]
            pen = max(pen, -z)
            flo = max(flo, z)
        deepest = min(min(heights["L"][i], heights["R"][i]) + offsets[i] for i in range(n))
        body = min(lows[i] + offsets[i] for i in range(n))
        return {"max_penetration_mm": round(max(0.0, pen) * 1000, 1),
                "max_float_mm": round(max(0.0, flo) * 1000, 1),
                "deepest_sole_mm": round(deepest * 1000, 1),
                "deepest_body_mm": round(body * 1000, 1)}

    before = stats([const] * n)
    after = stats(off)
    contact = sum(1 for w in which if w)
    info = {"stance_frames": contact, "frames": n,
            "stance_fraction": round(contact / float(n), 3),
            "before": before, "after": after}
    return off, which, heights, info


# --------------------------------------------------------------------------- #
# optional foot lock
def two_bone_ik(mats, tgt, up, lo, end, goal, world_rots):
    """Rotate UpLeg/Leg so the ankle reaches `goal`, keeping the current bend
    plane.  Returns updated world rotations for those two bones."""
    mw = tgt.matrix_world
    root = mw @ mats[up].translation
    knee = mw @ mats[lo].translation
    ankle = mw @ mats[end].translation
    l1, l2 = (knee - root).length, (ankle - knee).length
    to = goal - root
    d = to.length
    if d < 1e-5 or l1 < 1e-6 or l2 < 1e-6:
        return world_rots
    d = max(abs(l1 - l2) + 1e-4, min(l1 + l2 - 1e-4, d))
    dirv = to.normalized()
    pole = (knee - root) - dirv * ((knee - root).dot(dirv))
    if pole.length < 1e-5:
        return world_rots
    pole.normalize()
    cos_a = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
    ang = math.acos(cos_a)
    new_knee = root + (dirv * math.cos(ang) + pole * math.sin(ang)) * l1
    new_ankle = root + dirv * d
    out = dict(world_rots)
    for name, oa, ob, na, nb in ((up, root, knee, root, new_knee),
                                 (lo, knee, ankle, new_knee, new_ankle)):
        od, nd = (ob - oa), (nb - na)
        if od.length < 1e-6 or nd.length < 1e-6:
            continue
        out[name] = od.normalized().rotation_difference(nd.normalized()) @ out[name]
    return out


def foot_lock_pass(tgt, cache, which, offsets, fps, mats_for, tgt_q, rest_rel, order,
                   max_corr=0.06, blend=4):
    """While a foot is planted, hold its world XY at the frame it planted.

    Corrections are clamped to `max_corr` and eased in/out over `blend` frames, so
    a mis-detected contact can only ever nudge the leg.  Runs entirely on the
    analytic pose matrices -- no depsgraph.
    """
    n = len(cache)
    sides = {"L": (M + "LeftUpLeg", M + "LeftLeg", M + "LeftFoot"),
             "R": (M + "RightUpLeg", M + "RightLeg", M + "RightFoot")}
    spans = {"L": [], "R": []}
    for side in ("L", "R"):
        i = 0
        while i < n:
            if which[i] == side:
                j = i
                while j + 1 < n and which[j + 1] == side:
                    j += 1
                if j - i >= 2:
                    spans[side].append((i, j))
                i = j + 1
            else:
                i += 1
    goals = [dict() for _ in range(n)]
    slide_before = slide_after = 0.0
    for side, (up, lo, ft) in sides.items():
        for (a, b) in spans[side]:
            anchor = None
            for i in range(a, b + 1):
                basis, p_w = cache[i]
                p = p_w.copy(); p.z += offsets[i]
                pos = tgt.matrix_world @ mats_for(basis, p)[ft].translation
                if anchor is None:
                    anchor = pos.copy()
                    continue
                delta = Vector((anchor.x - pos.x, anchor.y - pos.y, 0.0))
                slide_before = max(slide_before, delta.length)
                if delta.length > max_corr:
                    delta = delta.normalized() * max_corr
                t = max(0.0, min(1.0, min((i - a) / float(blend), (b - i) / float(blend))))
                t = t * t * (3 - 2 * t)
                goals[i][side] = (up, lo, ft, pos + delta * t)
                slide_after = max(slide_after, (Vector((anchor.x - pos.x, anchor.y - pos.y, 0.0))
                                               - delta * t).length)
    tqi = tgt_q.inverted()
    for i, goal in enumerate(goals):
        if not goal:
            continue
        basis, p_w = cache[i]
        p = p_w.copy(); p.z += offsets[i]
        mats = mats_for(basis, p)
        world = {nm: (tgt.matrix_world @ mats[nm]).to_quaternion() for nm in order}
        for side, (up, lo, ft, target) in goal.items():
            world = two_bone_ik(mats, tgt, up, lo, ft, target, world)
        for name in order:
            b = tgt.data.bones[name]
            parent_w = world[b.parent.name] if b.parent else tgt_q
            basis[name] = (tqi @ parent_w @ rest_rel[name]).inverted() @ (tqi @ world[name])
    return slide_before, slide_after


# --------------------------------------------------------------------------- #
def retarget_clip(src, tgt, clip_name, out_fps, src_fps, f0, f1, profile,
                  do_trim, use_recenter, samples, body, foot_lock):
    scene = bpy.context.scene
    bone_map, root = profile["map"], profile["root"]
    step = max(1.0, src_fps / out_fps)

    src.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()
    tgt_h = rest_hip_above_ankle(tgt, ROOT_TARGET, M + "LeftFoot")
    src_h = rest_hip_above_ankle(src, root, profile["ankle"])
    if not src_h or abs(src_h) < 1e-6:
        raise RuntimeError(f"{clip_name}: cannot measure source hip height")
    s = tgt_h / src_h
    src.scale = (s, s, s)
    bpy.context.view_layer.update()
    log(f"  scale: hip-above-ankle source {src_h:.3f} -> target {tgt_h:.3f}m, x{s:.5f}")

    src_frames = [min(f1, int(round(f0 + k * step))) for k in range(int((f1 - f0) / step) + 1)]
    n_in = len(src_frames)
    if do_trim:
        cal = calibration_frames(src, bone_map, src_frames)
        rest_frames = src_frames[cal:]
        a, b = trim_range(motion_energy(src, bone_map, rest_frames),
                          lead=int(round(out_fps * 0.15)))
        if b - a + 1 >= 6:
            src_frames = rest_frames[a:b + 1]
        elif len(rest_frames) >= 6:
            src_frames = rest_frames
    if len(src_frames) != n_in:
        log(f"  trimmed: kept {len(src_frames)}/{n_in} output frames")

    transfer = build_transfer(src, tgt, bone_map, src_frames, use_recenter)
    if ROOT_TARGET not in transfer:
        raise RuntimeError(f"{clip_name}: root bone not mapped")
    tgt_q = tgt.matrix_world.to_quaternion()
    tgt_q_inv = tgt_q.inverted()
    order = hierarchy_order(tgt)
    rest_rel = {n: rest_rel_rot(tgt.pose.bones[n]) for n in order}
    root_pb = tgt.pose.bones[ROOT_TARGET]
    src_root = src.pose.bones[root]
    root_rest_local = root_pb.bone.matrix_local
    tgt_root_rest_w = tgt.matrix_world @ root_pb.bone.head_local

    for pb in tgt.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.matrix_basis = Matrix()

    def pose_frame(f):
        scene.frame_set(f)
        world, basis = {}, {}
        for name in order:
            pb = tgt.pose.bones[name]
            parent_w = world[pb.parent.name] if pb.parent else tgt_q
            if name in transfer:
                s_name, rs_inv, ref = transfer[name]
                w = ((src.matrix_world @ src.pose.bones[s_name].matrix).to_quaternion()
                     @ rs_inv @ ref)
            else:
                w = parent_w @ rest_rel[name]
            world[name] = w
            basis[name] = (tgt_q_inv @ parent_w @ rest_rel[name]).inverted() @ (tgt_q_inv @ w)
        return basis, (src.matrix_world @ src_root.matrix).translation.copy()

    def apply_basis(basis):
        for name, q in basis.items():
            tgt.pose.bones[name].rotation_quaternion = q

    def set_root(p_w):
        arm_rot = root_rest_local.to_quaternion() @ root_pb.rotation_quaternion
        p_a = tgt.matrix_world.inverted() @ p_w
        desired = Matrix.Translation(p_a) @ arm_rot.to_matrix().to_4x4()
        root_pb.location = (root_rest_local.inverted() @ desired).translation

    cache, hip0 = [], None
    for f in src_frames:
        basis, hip_w = pose_frame(f)
        if hip0 is None:
            hip0 = hip_w.copy()
        p_w = hip_w.copy()
        p_w.x = tgt_root_rest_w.x + (hip_w.x - hip0.x)
        p_w.y = tgt_root_rest_w.y + (hip_w.y - hip0.y)
        cache.append((basis, p_w))

    inv_tgt = tgt.matrix_world.inverted()
    rest_rel_mat = {}
    for name in order:
        b = tgt.data.bones[name]
        rest_rel_mat[name] = (b.parent.matrix_local.inverted() @ b.matrix_local
                              if b.parent else b.matrix_local)

    def mats_for(basis, p_w):
        return pose_matrices(tgt, order, rest_rel_mat, basis, inv_tgt @ p_w)

    offsets, which, heights, ginfo = ground_lock(tgt, cache, out_fps, samples, body, mats_for)
    log(f"  ground: stance {ginfo['stance_fraction']*100:.0f}% of frames, "
        f"pen {ginfo['before']['max_penetration_mm']:.0f}->{ginfo['after']['max_penetration_mm']:.0f}mm, "
        f"float {ginfo['before']['max_float_mm']:.0f}->{ginfo['after']['max_float_mm']:.0f}mm")

    if foot_lock:
        sb, sa = foot_lock_pass(tgt, cache, which, offsets, out_fps, mats_for,
                                tgt_q, rest_rel, order)
        ginfo["foot_slide_mm"] = {"before": round(sb * 1000, 1), "after": round(sa * 1000, 1)}
        log(f"  foot lock: max slide {sb*1000:.0f} -> {sa*1000:.0f} mm")

    # write the action
    if tgt.animation_data is None:
        tgt.animation_data_create()
    tgt.animation_data.action = None
    keyed = [n for n in order if n in transfer]
    act = None
    for k, (basis, p_w) in enumerate(cache):
        frame = k + 1
        apply_basis(basis)
        p = p_w.copy()
        p.z += offsets[k]
        set_root(p)
        for name in keyed:
            tgt.pose.bones[name].keyframe_insert("rotation_quaternion", frame=frame, group=name)
        root_pb.keyframe_insert("location", frame=frame, group=ROOT_TARGET)
        if act is None:
            act = tgt.animation_data.action
            act.name = clip_name
            act.use_fake_user = True
    for fc in _fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    dur = len(cache) / out_fps
    log(f"  action '{act.name}': {len(cache)} frames @ {out_fps:g}fps = {dur:.2f}s, "
        f"{len(keyed)} bones keyed")
    tgt.animation_data.action = None
    ginfo.update({"frames": len(cache), "duration_s": round(dur, 3)})
    return act, len(cache), dur, ginfo


def _fcurves(act):
    fcs = list(getattr(act, "fcurves", []))
    if fcs:
        return fcs
    for layer in getattr(act, "layers", []):
        for strip in layer.strips:
            for cb in getattr(strip, "channelbags", []):
                fcs.extend(cb.fcurves)
    return fcs


def assign_action(obj, act):
    if obj.animation_data is None:
        obj.animation_data_create()
    obj.animation_data.action = act
    slots = getattr(act, "slots", None)
    if slots and len(slots) and getattr(obj.animation_data, "action_slot", 1) is None:
        obj.animation_data.action_slot = slots[0]


def action_range(act):
    fr = act.frame_range
    return int(round(fr[0])), int(round(fr[1]))


# --------------------------------------------------------------------------- #
def render_contact_sheet(tgt, act, out_png, fps, w=440, h=620):
    import numpy as np
    scene = bpy.context.scene
    assign_action(tgt, act)
    f0, f1 = action_range(act)
    dur = (f1 - f0 + 1) / float(fps)
    n, cols = (8, 4) if dur < 2.2 else (6, 3)
    rows = 2
    frames = [int(round(f0 + (f1 - f0) * i / (n - 1))) for i in range(n)]

    scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = False
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("w")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.32, 0.38, 0.46, 1.0)
    bg.inputs[1].default_value = 0.75

    def ensure(name, data):
        o = bpy.data.objects.get(name)
        if o is None:
            o = bpy.data.objects.new(name, data)
            scene.collection.objects.link(o)
        return o

    sun = ensure("_rt_sun", bpy.data.lights.new("_rt_sun_d", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(55), 0, math.radians(35))
    fill = ensure("_rt_fill", bpy.data.lights.new("_rt_fill_d", "AREA"))
    fill.data.energy = 1200
    fill.data.size = 6
    cam = ensure("_rt_cam", bpy.data.cameras.new("_rt_cam_d"))
    cam.data.lens = 55
    scene.camera = cam
    if "_rt_ground" not in bpy.data.objects:
        me = bpy.data.meshes.new("_rt_ground")
        me.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
        mat = bpy.data.materials.new("_rt_ground_m")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.33, 0.16, 1)
        me.materials.append(mat)
        ensure("_rt_ground", me)

    hips = tgt.pose.bones[ROOT_TARGET]

    def hip_xy(f):
        scene.frame_set(f)
        bpy.context.view_layer.update()
        p = (tgt.matrix_world @ hips.matrix).translation
        return Vector((p.x, p.y))

    # Where the camera stands is decided by which way the BODY faces, averaged
    # over the clip -- not by which way it travels.  Travel is only a proxy for
    # facing, and it is the wrong one for exactly the clips that need a good view:
    # a strafe or a sidestep travels at 90 degrees to its facing, and using travel
    # puts the camera behind the character's back.
    def facing_at(f):
        scene.frame_set(f)
        bpy.context.view_layer.update()
        def head(nm):
            return (tgt.matrix_world @ tgt.pose.bones[nm].matrix).translation
        lr = head(M + "LeftUpLeg") - head(M + "RightUpLeg")
        fw = lr.cross(Vector((0.0, 0.0, 1.0)))
        return Vector((fw.x, fw.y))

    facing = Vector((0.0, 0.0))
    for i in range(5):
        v = facing_at(int(round(f0 + (f1 - f0) * i / 4.0)))
        if v.length > 1e-6:
            facing += v.normalized()
    if facing.length < 1e-6:
        net = hip_xy(f1) - hip_xy(f0)
        facing = net.normalized() if net.length > 1e-6 else Vector((0.0, -1.0))
    else:
        facing.normalize()
    # stand the camera in front of the subject, swung 35 deg round for a 3/4 view
    q = math.radians(35.0)
    ox = facing.x * math.cos(q) - facing.y * math.sin(q)
    oy = facing.x * math.sin(q) + facing.y * math.cos(q)
    az = math.atan2(ox, -oy)

    dist, height = 4.3, 1.1
    tmp = tempfile.mkdtemp(prefix="rt_sheet_")
    tiles = []
    for i, f in enumerate(frames):
        scene.frame_set(f)
        bpy.context.view_layer.update()
        c = (tgt.matrix_world @ hips.matrix).translation
        cam.location = (c.x + math.sin(az) * dist, c.y - math.cos(az) * dist, height)
        cam.rotation_euler = (math.radians(87.0), 0.0, az)
        sun.location = (c.x + 3, c.y - 3, 6)
        fill.location = (c.x - 3, c.y - 4, 2.2)
        scene.render.filepath = os.path.join(tmp, f"f{i:02d}.png")
        bpy.ops.render.render(write_still=True)
        tiles.append(scene.render.filepath)

    sheet = np.zeros((rows * h, cols * w, 4), dtype=np.float32)
    for i, p in enumerate(tiles):
        img = bpy.data.images.load(p)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)[::-1]
        r, c2 = divmod(i, cols)
        sheet[r * h:(r + 1) * h, c2 * w:(c2 + 1) * w] = px
        bpy.data.images.remove(img)
    sheet[::h, :, :3] = 0.0
    sheet[:, ::w, :3] = 0.0
    out = bpy.data.images.new("_rt_sheet", cols * w, rows * h, alpha=True)
    out.pixels = sheet[::-1].ravel().tolist()
    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    out.filepath_raw = os.path.abspath(out_png)
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    tgt.animation_data.action = None


def cleanup_preview_objects():
    for n in ("_rt_sun", "_rt_fill", "_rt_cam", "_rt_ground"):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)


# --------------------------------------------------------------------------- #
def strip_meshes(rig):
    for o in list(bpy.data.objects):
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def export_glb(rig, path, action_names, fps):
    scene = bpy.context.scene
    scene.render.fps = int(round(fps))
    scene.render.fps_base = 1.0
    keep = set(action_names)
    if rig.animation_data:
        rig.animation_data.action = None
    for act in list(bpy.data.actions):
        if act.name not in keep:
            act.use_fake_user = False
            bpy.data.actions.remove(act)
    if action_names:
        first = bpy.data.actions[action_names[0]]
        assign_action(rig, first)
        scene.frame_start, scene.frame_end = action_range(first)
    bpy.ops.object.select_all(action="DESELECT")
    objs = [rig] + [o for o in bpy.data.objects if o.type == "MESH" and o.parent == rig]
    for o in objs:
        o.hide_viewport = False
        o.hide_render = False
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(path), export_format="GLB", use_selection=True,
        export_apply=False, export_skins=True, export_yup=True,
        export_def_bones=False, export_armature_object_remove=False,
        export_hierarchy_flatten_bones=False, export_leaf_bone=False,
        export_animations=bool(action_names), export_animation_mode="ACTIONS",
        export_force_sampling=True, export_optimize_animation_size=True,
        export_anim_slide_to_zero=True, export_frame_range=False,
        export_bake_animation=False, export_image_format="AUTO")
    kb = os.path.getsize(path) / 1024.0
    log(f"wrote {os.path.basename(path)} ({kb:.0f} KB) animations={len(action_names) or '-'}")


# --------------------------------------------------------------------------- #
def main():
    a = parse_args()
    out_dir = os.path.abspath(a["out"])
    prev_dir = os.path.abspath(a["preview_dir"])
    os.makedirs(out_dir, exist_ok=True)
    rig = load_target(a["target"])
    rig_name = rig.name

    samples, bind = build_sole_samples(rig)
    body = build_body_samples(rig)
    log(f"sole samples: L={len(samples['L'])} R={len(samples['R'])} pts, body={len(body)}, "
        f"bind sole z L={bind['L']*1000:.1f}mm R={bind['R']*1000:.1f}mm "
        f"(foot joint plane {(rig.matrix_world @ rig.data.bones[M+'LeftToeBase'].tail_local).z*1000:.1f}mm)")

    stats_path = os.path.join(out_dir, "ground_stats.json")
    stats = {}
    if os.path.exists(stats_path) and not a["force"]:
        try:
            stats = json.load(open(stats_path))
        except Exception:
            stats = {}

    results = []
    for clip in a["clips"]:
        clip = os.path.abspath(clip)
        ext = os.path.splitext(clip)[1].lower()
        if ext not in PROFILES:
            log(f"skipping unsupported {clip}")
            continue
        name = clip_id(clip)
        glb = os.path.join(out_dir, f"{name}.glb")
        png = os.path.join(prev_dir, f"{name}.png")
        # freshness is judged per artifact, so a run interrupted half way through
        # resumes without redoing the previews it already rendered
        src_t = os.path.getmtime(clip)
        glb_fresh = (not a["force"] and os.path.exists(glb)
                     and os.path.getmtime(glb) > src_t)
        png_fresh = (not a["force"] and os.path.exists(png)
                     and os.path.getmtime(png) > src_t)
        fresh = glb_fresh and (png_fresh or not a["preview"])
        log(f"clip {name} <- {os.path.basename(clip)}" + ("  [up to date]" if fresh else ""))
        src, f0, f1, sfps = import_clip(clip)
        try:
            act, nf, dur, ginfo = retarget_clip(
                src, rig, name, a["fps"], sfps, f0, f1, PROFILES[ext],
                a["trim"], a["recenter"], samples, body, a["foot_lock"])
        finally:
            bpy.data.objects.remove(src, do_unlink=True)
        ginfo["source"] = os.path.basename(clip)
        stats[name] = ginfo
        results.append([name, nf, dur, os.path.basename(clip), glb_fresh, png_fresh])

    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    master = os.path.join(tempfile.mkdtemp(prefix="rt_master_"), "master.blend")
    bpy.ops.wm.save_as_mainfile(filepath=master)

    if a["preview"]:
        todo = [r for r in results if not r[5]]
        log(f"rendering {len(todo)} contact sheets ({len(results)-len(todo)} up to date)")
        for r in todo:
            render_contact_sheet(rig, bpy.data.actions[r[0]],
                                 os.path.join(prev_dir, f"{r[0]}.png"), a["fps"])
        cleanup_preview_objects()

    bpy.ops.wm.open_mainfile(filepath=master)
    strip_meshes(bpy.data.objects[rig_name])
    anim_master = os.path.join(os.path.dirname(master), "anim_master.blend")
    bpy.ops.wm.save_as_mainfile(filepath=anim_master)

    export_glb(bpy.data.objects[rig_name], os.path.join(out_dir, "rig_only.glb"), [], a["fps"])
    for r in results:
        if r[4]:
            continue
        bpy.ops.wm.open_mainfile(filepath=anim_master)
        export_glb(bpy.data.objects[rig_name], os.path.join(out_dir, f"{r[0]}.glb"),
                   [r[0]], a["fps"])
    bpy.ops.wm.open_mainfile(filepath=anim_master)
    export_glb(bpy.data.objects[rig_name], os.path.join(out_dir, "all_clips.glb"),
               [r[0] for r in results], a["fps"])

    json.dump(stats, open(stats_path, "w"), indent=1, sort_keys=True)
    log(f"wrote {stats_path} ({len(stats)} clips)")
    log("=" * 62)
    worst = sorted(results, key=lambda r: -max(stats[r[0]]["after"]["max_penetration_mm"],
                                               stats[r[0]]["after"]["max_float_mm"]))[:6]
    for name, nf, dur, clip, gf, pf in results:
        g = stats[name]["after"]
        log(f"{name:44s} {nf:4d}f {dur:6.2f}s  pen {g['max_penetration_mm']:5.1f} "
            f"float {g['max_float_mm']:5.1f} mm")
    log("worst ground residual: " + ", ".join(r[0] for r in worst))


if __name__ == "__main__":
    main()
