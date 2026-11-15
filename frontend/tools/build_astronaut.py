"""
ASTRA crew member + ISS exercise devices, animated, for the workout screen.

Builds public/models/astronaut_workouts.glb headless with Blender (bpy 5.x):

    pip install bpy==5.3.0          # Python 3.13
    python tools/build_astronaut.py --out /tmp/astronaut.glb [--preview /tmp/astro]
    npx gltf-transform meshopt /tmp/astronaut.glb public/models/astronaut_workouts.glb --level medium

Everything is made here from primitives, so the asset is original (no third-party models).
Body: a Skin-modifier skeleton smoothed by Subdivision, rigged with automatic weights.
Animations are driven by IK targets and baked to plain bone keys, one glTF animation per exercise:
  squat   (ARED: Advanced Resistive Exercise Device, bar on the shoulders)
  run     (T2 treadmill, harness bungees pull the runner onto the deck)
  cycle   (CEVIS cycle ergometer; there is no seat in microgravity, feet clipped to the pedals)
  balance (pre-landing balance drill: one leg, head turns, hand near a rail)
Devices are named ared*, t2*, cevis*, rail* so the app shows only the one in use.
Coordinates: metres, Z up, the crew member faces -Y. Height 1.75 m.
"""
import argparse, math, os, sys
import bpy
import bmesh
from mathutils import Matrix, Vector, Quaternion

FPS = 30
H = 1.75

# ---------- joints (metres) ----------
J = {
    "pelvis": (0, 0.00, 0.96), "spine": (0, 0.005, 1.12), "chest": (0, 0.01, 1.30), "neck": (0, 0.01, 1.46), "neck_top": (0, 0.0, 1.53),
    "clav.L": (0.09, 0.01, 1.43), "shoulder.L": (0.19, 0.01, 1.42), "elbow.L": (0.215, 0.03, 1.15), "wrist.L": (0.225, 0.0, 0.90), "hand.L": (0.23, -0.005, 0.80),
    "hip.L": (0.09, 0.0, 0.92), "knee.L": (0.095, -0.01, 0.50), "ankle.L": (0.095, 0.02, 0.085), "toe.L": (0.10, -0.13, 0.03),
}
for k in list(J):
    if k.endswith(".L"):
        x, y, z = J[k]
        J[k[:-2] + ".R"] = (-x, y, z)

# (radius across X, radius across Y) for the Skin modifier
R = {
    "pelvis": (0.155, 0.105), "spine": (0.135, 0.095), "chest": (0.165, 0.105), "neck": (0.055, 0.055), "neck_top": (0.05, 0.05),
    "clav": (0.07, 0.06), "shoulder": (0.058, 0.058), "elbow": (0.042, 0.042), "wrist": (0.031, 0.026), "hand": (0.034, 0.016),
    "hip": (0.088, 0.088), "knee": (0.056, 0.058), "ankle": (0.038, 0.04), "toe": (0.038, 0.03),
}
EDGES = [("pelvis", "spine"), ("spine", "chest"), ("chest", "neck"), ("neck", "neck_top"),
         ("chest", "clav.L"), ("clav.L", "shoulder.L"), ("shoulder.L", "elbow.L"), ("elbow.L", "wrist.L"), ("wrist.L", "hand.L"),
         ("chest", "clav.R"), ("clav.R", "shoulder.R"), ("shoulder.R", "elbow.R"), ("elbow.R", "wrist.R"), ("wrist.R", "hand.R"),
         ("pelvis", "hip.L"), ("hip.L", "knee.L"), ("knee.L", "ankle.L"), ("ankle.L", "toe.L"),
         ("pelvis", "hip.R"), ("hip.R", "knee.R"), ("knee.R", "ankle.R"), ("ankle.R", "toe.R")]

HEAD_C = (0, -0.005, 1.635)
HEAD_R = 0.102

# colours (linear-ish sRGB values, glTF will carry them as base colour)
COL = {
    "skin": (0.62, 0.42, 0.32, 1), "hair": (0.05, 0.04, 0.035, 1), "shirt": (0.06, 0.09, 0.20, 1), "shorts": (0.18, 0.17, 0.15, 1),
    "sock": (0.85, 0.85, 0.85, 1), "shoe": (0.75, 0.76, 0.78, 1), "sole": (0.08, 0.08, 0.09, 1), "eye": (0.02, 0.02, 0.025, 1),
    "patch": (0.65, 0.52, 1.0, 1), "harness": (0.30, 0.30, 0.32, 1),
    "metal": (0.70, 0.71, 0.74, 1), "panel": (0.86, 0.87, 0.88, 1), "dark": (0.10, 0.10, 0.11, 1), "accent": (0.65, 0.52, 1.0, 1),
}


def mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = COL[name]
    bsdf.inputs["Roughness"].default_value = 0.35 if name in ("metal",) else 0.7
    if name == "metal":
        bsdf.inputs["Metallic"].default_value = 0.6
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def set_active(obj):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# ---------- body ----------
def build_body():
    names = list(J.keys())
    me = bpy.data.meshes.new("crew_body")
    me.from_pydata([J[n] for n in names], [(names.index(a), names.index(b)) for a, b in EDGES], [])
    body = link(bpy.data.objects.new("crew_body", me))
    sk = body.modifiers.new("skin", "SKIN")
    sk.use_smooth_shade = True
    for i, n in enumerate(names):
        key = n.split(".")[0]
        body.data.skin_vertices[0].data[i].radius = R[key]
        body.data.skin_vertices[0].data[i].use_root = n == "pelvis"
    sub = body.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    set_active(body)
    bpy.ops.object.modifier_apply(modifier="skin")
    bpy.ops.object.modifier_apply(modifier="sub")
    # clothing by region
    for n in ("skin", "shirt", "shorts", "sock", "shoe"):
        body.data.materials.append(mat(n))
    idx = {m.name: i for i, m in enumerate(body.data.materials)}
    for p in body.data.polygons:
        c = p.center
        r = "skin"
        if 1.02 < c.z < 1.50 and (abs(c.x) < 0.20 or c.z > 1.24):
            r = "shirt"  # torso and short sleeves to just above the elbow
        if c.z > 1.47:
            r = "skin"
        if 0.60 < c.z <= 1.02:
            r = "shorts"
        if abs(c.x) > 0.17 and c.z < 1.24:
            r = "skin"  # forearms and hands
        if c.z < 0.25:
            r = "sock"
        if c.z < 0.11:
            r = "shoe"
        p.material_index = idx[r]
    bpy.ops.object.shade_smooth()
    return body


def build_head():
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=HEAD_R)
    bmesh.ops.scale(bm, vec=(0.92, 1.0, 1.08), verts=bm.verts)
    me = bpy.data.meshes.new("crew_head")
    bm.to_mesh(me)
    bm.free()
    head = link(bpy.data.objects.new("crew_head", me))
    head.location = HEAD_C
    head.data.materials.append(mat("skin"))
    head.data.materials.append(mat("hair"))
    for p in head.data.polygons:
        c = p.center
        # short hair: top and back of the head
        if c.z > 0.035 or (c.y > 0.02 and c.z > -0.03):
            p.material_index = 1
    for p in head.data.polygons:
        p.use_smooth = True
    parts = [head]
    for sx in (-1, 1):  # eyes
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.011)
        me = bpy.data.meshes.new("crew_eye")
        bm.to_mesh(me)
        bm.free()
        e = link(bpy.data.objects.new("crew_eye", me))
        e.location = (HEAD_C[0] + sx * 0.035, HEAD_C[1] - 0.088, HEAD_C[2] + 0.012)
        e.data.materials.append(mat("eye"))
        parts.append(e)
    # nose
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.016, radius2=0.004, depth=0.035)
    me = bpy.data.meshes.new("crew_nose")
    bm.to_mesh(me)
    bm.free()
    nose = link(bpy.data.objects.new("crew_nose", me))
    nose.location = (HEAD_C[0], HEAD_C[1] - 0.10, HEAD_C[2] - 0.02)
    nose.rotation_euler = (math.radians(90), 0, 0)
    nose.data.materials.append(mat("skin"))
    parts.append(nose)
    # ears
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=8, radius=0.022)
        bmesh.ops.scale(bm, vec=(0.4, 0.8, 1.2), verts=bm.verts)
        me = bpy.data.meshes.new("crew_ear")
        bm.to_mesh(me)
        bm.free()
        ear = link(bpy.data.objects.new("crew_ear", me))
        ear.location = (HEAD_C[0] + sx * 0.094, HEAD_C[1] + 0.005, HEAD_C[2] - 0.005)
        ear.data.materials.append(mat("skin"))
        parts.append(ear)
    return parts


def build_patch():
    """Plain round mission patch on the left sleeve (no real agency logo)."""
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=24, radius=0.026)
    me = bpy.data.meshes.new("crew_patch")
    bm.to_mesh(me)
    bm.free()
    p = link(bpy.data.objects.new("crew_patch", me))
    p.location = (0.268, 0.0, 1.33)
    p.rotation_euler = (0, math.radians(90), 0)
    p.data.materials.append(mat("patch"))
    return p


# ---------- armature ----------
BONES = [
    ("hips", "pelvis", (0, 0.005, 1.12), None),
    ("spine", (0, 0.005, 1.12), (0, 0.01, 1.30), "hips"),
    ("chest", (0, 0.01, 1.30), (0, 0.01, 1.46), "spine"),
    ("neck", (0, 0.01, 1.46), (0, 0.0, 1.54), "chest"),
    ("head", (0, 0.0, 1.54), (0, 0.0, 1.74), "neck"),
]
for s in ("L", "R"):
    BONES += [
        (f"clav.{s}", (0, 0.01, 1.42), f"shoulder.{s}", "chest"),
        (f"upper_arm.{s}", f"shoulder.{s}", f"elbow.{s}", f"clav.{s}"),
        (f"forearm.{s}", f"elbow.{s}", f"wrist.{s}", f"upper_arm.{s}"),
        (f"hand.{s}", f"wrist.{s}", f"hand.{s}", f"forearm.{s}"),
        (f"thigh.{s}", f"hip.{s}", f"knee.{s}", "hips"),
        (f"shin.{s}", f"knee.{s}", f"ankle.{s}", f"thigh.{s}"),
        (f"foot.{s}", f"ankle.{s}", f"toe.{s}", f"shin.{s}"),
    ]


def pt(v):
    return Vector(J[v]) if isinstance(v, str) else Vector(v)


def build_armature(body, extras):
    arm_data = bpy.data.armatures.new("crew_rig")
    rig = link(bpy.data.objects.new("crew_rig", arm_data))
    set_active(rig)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, a, b, parent in BONES:
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail = pt(a), pt(b)
        eb.roll = 0
        if parent:
            eb.parent = arm_data.edit_bones[parent]
            eb.use_connect = (eb.head - eb.parent.tail).length < 1e-4
    bpy.ops.object.mode_set(mode="OBJECT")
    # automatic weights
    for o in bpy.context.scene.objects:
        o.select_set(False)
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    # rigid parts follow single bones
    for o, bone in extras:
        bpy.context.view_layer.update()
        mw = o.matrix_world.copy()
        o.parent = rig
        o.parent_type = "BONE"
        o.parent_bone = bone
        bpy.context.view_layer.update()
        o.matrix_world = mw
    return rig


# ---------- devices ----------
def box(name, size, loc, material, bevel=0.01):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.location = loc
    o.data.materials.append(mat(material))
    if bevel:
        bv = o.modifiers.new("bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 3
    return o


def cyl(name, r, depth, loc, rot, material, segs=24):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=depth)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.location = loc
    o.rotation_euler = rot
    o.data.materials.append(mat(material))
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def rod(name, a, b, r, material):
    a, b = Vector(a), Vector(b)
    d = b - a
    o = cyl(name, r, d.length, (a + b) / 2, (0, 0, 0), material, 12)
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    return o


def build_devices(rig):
    dev = {}
    # ARED: platform, two guide columns, bar across the shoulders (rides on the chest bone)
    dev["ared"] = [box("ared_platform", (1.1, 0.75, 0.07), (0, 0, 0.035), "panel"),
                   box("ared_base", (1.3, 0.9, 0.04), (0, 0.05, -0.02), "metal"),
                   box("ared_column.L", (0.06, 0.06, 1.5), (0.58, 0.18, 0.75), "metal"),
                   box("ared_column.R", (0.06, 0.06, 1.5), (-0.58, 0.18, 0.75), "metal"),
                   box("ared_cylinders", (1.2, 0.18, 0.22), (0, 0.32, 0.18), "panel")]
    bar = cyl("ared_bar", 0.024, 1.24, (0, 0.04, 1.47), (0, math.radians(90), 0), "dark")
    pads = [cyl(f"ared_pad.{s}", 0.045, 0.16, (sx * 0.14, 0.04, 1.47), (0, math.radians(90), 0), "dark") for s, sx in (("L", 1), ("R", -1))]
    for o in [bar] + pads:
        bpy.context.view_layer.update()
        mw = o.matrix_world.copy()
        o.parent, o.parent_type, o.parent_bone = rig, "BONE", "chest"
        bpy.context.view_layer.update()
        o.matrix_world = mw
    dev["ared"] += [bar] + pads

    # T2 treadmill: deck, belt, side rails, harness bungees from the deck to the waist
    deck_h = 0.2
    dev["t2"] = [box("t2_deck", (0.75, 1.7, deck_h - 0.03), (0, 0.05, (deck_h - 0.03) / 2), "panel"),
                 box("t2_belt", (0.55, 1.6, 0.02), (0, 0.05, deck_h - 0.02), "dark", 0.004),
                 box("t2_rail.L", (0.05, 1.7, 0.05), (0.36, 0.05, deck_h + 0.01), "metal"),
                 box("t2_rail.R", (0.05, 1.7, 0.05), (-0.36, 0.05, deck_h + 0.01), "metal")]
    for s, sx in (("L", 1), ("R", -1)):
        dev["t2"].append(rod(f"t2_bungee_front.{s}", (sx * 0.34, -0.55, deck_h), (sx * 0.17, -0.03, 1.0 + deck_h), 0.008, "accent"))
        dev["t2"].append(rod(f"t2_bungee_back.{s}", (sx * 0.34, 0.65, deck_h), (sx * 0.17, 0.05, 1.0 + deck_h), 0.008, "accent"))

    # CEVIS: frame, flywheel housing, crank and pedals (animated), handlebar. No seat.
    cx, cy, cz, cr = 0.0, -0.33, 0.42, 0.17
    dev["cevis"] = [box("cevis_frame", (0.22, 0.75, 0.06), (0, -0.33, 0.03), "metal"),
                    box("cevis_housing", (0.10, 0.55, 0.48), (0, -0.42, 0.30), "panel", 0.03),
                    rod("cevis_post", (0, -0.55, 0.5), (0, -0.62, 1.02), 0.025, "metal"),
                    rod("cevis_bar", (0.28, -0.60, 1.04), (-0.28, -0.60, 1.04), 0.02, "dark")]
    crank = bpy.data.objects.new("cevis_crank", None)
    link(crank)
    crank.location = (cx, cy, cz)
    dev["cevis"].append(crank)
    for s, sx, ang in (("L", 1, 0.0), ("R", -1, math.pi)):
        px, pz = math.sin(ang) * cr, -math.cos(ang) * cr
        arm = rod(f"cevis_crankarm.{s}", (sx * 0.08, 0, 0), (sx * 0.08, px, pz), 0.016, "metal")
        ped = box(f"cevis_pedal.{s}", (0.10, 0.12, 0.03), (sx * 0.13, px, pz), "accent", 0.004)
        for o in (arm, ped):
            o.parent = crank
            o.location = o.location  # already in crank space (crank at origin of its own frame)
        dev["cevis"] += [arm, ped]

    # Balance drill: a handrail at the side
    dev["rail"] = [rod("rail_bar", (0.42, 0.45, 1.0), (0.42, -0.45, 1.0), 0.02, "metal"),
                   rod("rail_post.F", (0.42, -0.45, 0.0), (0.42, -0.45, 1.0), 0.018, "metal"),
                   rod("rail_post.B", (0.42, 0.45, 0.0), (0.42, 0.45, 1.0), 0.018, "metal")]
    return dev, (cx, cy, cz, cr)


# ---------- animation ----------
def empty(name, loc):
    e = bpy.data.objects.new(name, None)
    link(e)
    e.location = loc
    return e


def add_ik(rig, bone, target, pole, chain=2, pole_angle=-90):
    c = rig.pose.bones[bone].constraints.new("IK")
    c.target = target
    c.pole_target = pole
    c.pole_angle = math.radians(pole_angle)
    c.chain_count = chain
    return c


def key_loc(obj, frame, loc):
    obj.location = loc
    obj.keyframe_insert("location", frame=frame)


def bake_action(rig, name, frames):
    set_active(rig)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.nla.bake(frame_start=1, frame_end=frames, only_selected=False, visual_keying=True, clear_constraints=False,
                     use_current_action=False, bake_types={"POSE"})
    bpy.ops.object.mode_set(mode="OBJECT")
    act = rig.animation_data.action
    act.name = name
    return act


def push_nla(obj, act, name):
    if obj.animation_data is None:
        obj.animation_data_create()
    tr = obj.animation_data.nla_tracks.new()
    tr.name = name
    st = tr.strips.new(name, int(act.frame_range[0]), act)
    st.name = name
    obj.animation_data.action = None


def clear_pose(rig, targets):
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
    if rig.animation_data:
        rig.animation_data.action = None
    for t in targets:
        if t.animation_data:
            t.animation_data.action = None


def animate(rig, cevis):
    tg = {}
    for s, sx in (("L", 1), ("R", -1)):
        tg[f"foot.{s}"] = empty(f"ik_foot.{s}", J[f"ankle.{s}"])
        tg[f"knee.{s}"] = empty(f"pole_knee.{s}", (sx * 0.1, -0.6, 0.5))
        tg[f"hand.{s}"] = empty(f"ik_hand.{s}", J[f"wrist.{s}"])
        tg[f"elbow.{s}"] = empty(f"pole_elbow.{s}", (sx * 0.45, 0.4, 1.15))
        add_ik(rig, f"shin.{s}", tg[f"foot.{s}"], tg[f"knee.{s}"])
        add_ik(rig, f"forearm.{s}", tg[f"hand.{s}"], tg[f"elbow.{s}"])
    hips = rig.pose.bones["hips"]
    chest = rig.pose.bones["chest"]
    spine = rig.pose.bones["spine"]
    head = rig.pose.bones["head"]
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    sc = bpy.context.scene
    targets = list(tg.values())
    acts = {}

    def to_local(pb, v):
        """World/armature-space vector -> the bone's rest-local space (pose location and rotation axes live there)."""
        return pb.bone.matrix_local.to_3x3().inverted() @ Vector(v)

    def move(pb, frame, world_delta):
        pb.location = to_local(pb, world_delta)
        pb.keyframe_insert("location", frame=frame)

    def turn(pb, frame, world_axis, deg):
        pb.rotation_quaternion = Quaternion(to_local(pb, world_axis).normalized(), math.radians(deg))
        pb.keyframe_insert("rotation_quaternion", frame=frame)

    def lean_key(frame, deg):
        # positive = chest forward (toward -Y), a rotation about world +X
        turn(spine, frame, (1, 0, 0), deg * 0.5)
        turn(chest, frame, (1, 0, 0), deg * 0.5)

    # ----- squat on ARED (platform 0.07 m) -----
    # hands ride on the bar (the bar rides on the chest bone), so they stay on it through the whole squat
    bar = bpy.data.objects["ared_bar"]
    for s, sx in (("L", 1), ("R", -1)):
        h = tg[f"hand.{s}"]
        h.parent = bar
        h.matrix_parent_inverse = Matrix.Identity(4)
        h.location = bar.matrix_world.inverted() @ Vector((sx * 0.30, 0.04, 1.47))
    bpy.context.view_layer.update()
    N = 72
    sc.frame_start, sc.frame_end = 1, N
    base = 0.07
    for f in range(1, N + 1):
        t = (f - 1) / N
        depth = 0.5 - 0.5 * math.cos(2 * math.pi * t)  # 0 stand -> 1 bottom -> 0
        drop = 0.30 * depth
        back = 0.12 * depth
        move(hips, f, (0, back, base - drop))
        lean_key(f, 35 * depth)
        for s, sx in (("L", 1), ("R", -1)):
            key_loc(tg[f"foot.{s}"], f, (sx * 0.12, 0.02, base + 0.085))
            key_loc(tg[f"knee.{s}"], f, (sx * 0.16, -0.8, 0.5))
            key_loc(tg[f"elbow.{s}"], f, (sx * 0.5, 0.5, 1.2 + base - drop))
    acts["squat"] = bake_action(rig, "squat", N)
    for s in ("L", "R"):
        h = tg[f"hand.{s}"]
        mw = h.matrix_world.copy()
        h.parent = None
        h.matrix_world = mw
    clear_pose(rig, targets)

    # ----- run on T2 (deck 0.2 m), 2 strides per second -----
    N = 30
    sc.frame_end = N
    deck = 0.2
    for f in range(1, N + 1):
        ph = 2 * math.pi * (f - 1) / N
        move(hips, f, (0, 0, deck - 0.02 + 0.03 * abs(math.sin(ph))))
        lean_key(f, 8)
        for s, sx, off in (("L", 1, 0), ("R", -1, math.pi)):
            p = ph + off
            fy = -0.28 * math.sin(p)          # foot swings forward (-Y) and back
            fz = deck + 0.085 + max(0, 0.16 * math.cos(p))  # lifted on the recovery swing
            key_loc(tg[f"foot.{s}"], f, (sx * 0.1, fy, fz))
            key_loc(tg[f"knee.{s}"], f, (sx * 0.12, -0.9, 0.6))
            hy = 0.18 * math.sin(p)           # arms swing opposite to the leg on the same side
            key_loc(tg[f"hand.{s}"], f, (sx * 0.2, hy - 0.05, 1.05 + deck))
            key_loc(tg[f"elbow.{s}"], f, (sx * 0.3, 0.6, 1.2 + deck))
    acts["run"] = bake_action(rig, "run", N)
    clear_pose(rig, targets)

    # ----- cycle on CEVIS: feet follow the pedals, hands on the bar, slight lean -----
    cx, cy, cz, cr = cevis
    N = 30
    sc.frame_end = N
    for f in range(1, N + 1):
        a = 2 * math.pi * (f - 1) / N
        move(hips, f, (0, 0.12, 0.0))
        lean_key(f, 18)
        for s, sx, off in (("L", 1, 0.0), ("R", -1, math.pi)):
            p = a + off
            key_loc(tg[f"foot.{s}"], f, (sx * 0.13, cy + math.sin(p) * cr, cz - math.cos(p) * cr + 0.05))
            key_loc(tg[f"knee.{s}"], f, (sx * 0.14, -1.0, 0.8))
            key_loc(tg[f"hand.{s}"], f, (sx * 0.22, -0.60 - 0.12, 1.04))
            key_loc(tg[f"elbow.{s}"], f, (sx * 0.45, 0.2, 1.1))
        cevis_crank.rotation_euler = (a, 0, 0)
        cevis_crank.keyframe_insert("rotation_euler", frame=f)
    acts["cycle"] = bake_action(rig, "cycle", N)
    push_nla(cevis_crank, cevis_crank.animation_data.action, "cycle")
    clear_pose(rig, targets)

    # ----- balance: stand on the right leg, left knee up, hand near the rail, slow head turns -----
    N = 120
    sc.frame_end = N
    for f in range(1, N + 1):
        t = (f - 1) / N
        sway = 0.012 * math.sin(2 * math.pi * t * 2)
        move(hips, f, (sway - 0.03, 0, 0))
        lean_key(f, 0)
        turn(head, f, (0, 0, 1), 40 * math.sin(2 * math.pi * t))
        key_loc(tg["foot.R"], f, (-0.1, 0.02, 0.085))
        key_loc(tg["knee.R"], f, (-0.12, -0.8, 0.5))
        key_loc(tg["foot.L"], f, (0.11, 0.30, 0.52))   # foot lifted behind, knee bent
        key_loc(tg["knee.L"], f, (0.14, -1.0, 0.4))
        key_loc(tg["hand.L"], f, (0.40, 0.0, 1.03))  # hovering over the rail
        key_loc(tg["elbow.L"], f, (0.5, 0.4, 1.2))
        key_loc(tg["hand.R"], f, (-0.55, 0.0, 1.25))  # arm out to the side
        key_loc(tg["elbow.R"], f, (-0.5, 0.4, 1.3))
    acts["balance"] = bake_action(rig, "balance", N)
    clear_pose(rig, targets)

    # remove IK so the exported clips are plain bone keys
    for pb in rig.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    for t in targets:
        bpy.data.objects.remove(t)
    for name in ("squat", "run", "cycle", "balance"):
        push_nla(rig, acts[name], name)


cevis_crank = None


def main():
    global cevis_crank
    ap = argparse.ArgumentParser()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview")
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    body = build_body()
    head_parts = build_head()
    patch = build_patch()
    rig = build_armature(body, [(o, "head") for o in head_parts] + [(patch, "upper_arm.L")])
    devices, cev = build_devices(rig)
    cevis_crank = bpy.data.objects["cevis_crank"]
    animate(rig, cev)
    if a.preview:
        preview(a.preview, rig)
    bpy.ops.export_scene.gltf(filepath=a.out, export_format="GLB", export_animations=True, export_animation_mode="NLA_TRACKS",
                              export_apply=True, export_yup=True, export_skins=True, export_def_bones=False)
    print("[astronaut] wrote", a.out)


def preview(folder, rig):
    os.makedirs(folder, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 520, 520
    cam_data = bpy.data.cameras.new("cam")
    cam = link(bpy.data.objects.new("cam", cam_data))
    cam.location = (2.0, -2.5, 1.45)
    cam.rotation_euler = (math.radians(80), 0, math.radians(39))
    sc.camera = cam
    sun = link(bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")))
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    sun.data.energy = 3.5
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.05, 0.07, 1)
    sc.world = world
    for track in rig.animation_data.nla_tracks:
        for tr in rig.animation_data.nla_tracks:
            tr.mute = tr != track
        crank = bpy.data.objects.get("cevis_crank")
        if crank and crank.animation_data:
            for tr in crank.animation_data.nla_tracks:
                tr.mute = tr.name != track.name
        for o in sc.objects:
            prefix = o.name.split("_")[0]
            if prefix in ("ared", "t2", "cevis", "rail"):
                o.hide_render = {"squat": "ared", "run": "t2", "cycle": "cevis", "balance": "rail"}[track.name] != prefix
        strip = track.strips[0]
        mid = int((strip.frame_start + strip.frame_end) / 2)
        for f in (int(strip.frame_start), mid):
            sc.frame_set(f)
            sc.render.filepath = os.path.join(folder, f"{track.name}_{f:03d}.png")
            bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
