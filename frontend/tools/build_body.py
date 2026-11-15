"""
ASTRA body model build (reproducible).

Builds public/models/astra_body.glb from BodyParts3D 4.0 "part_of" OBJ files.
Run headless, either with the bpy wheel or with Blender:

    python tools/build_body.py --src <dir with partof_BP3D_4.0_obj_99/ and partof_element_parts.txt> --out public/models/astra_body_raw.glb
    blender -b -P tools/build_body.py -- --src ... --out ...

Then compress with meshopt (see tools/build_body.sh).

Source: BodyParts3D, (c) The Database Center for Life Science (DBCLS).
The OBJ headers state CC BY-SA 2.1 JP; the current DBCLS README states CC BY 4.0.
See CREDITS.md. Model files keep that attribution.
"""
import argparse, os, sys
import bpy
import bmesh  # only importable after bpy

# System -> (FMA concept ids, triangle budget). Names are the contract with src/three/bodyModel.ts.
SYSTEMS = {
    "shell":         (["FMA7163"], 40000),                                   # skin
    "sys_cardio":    (["FMA7088", "FMA3734", "FMA4720", "FMA10951", "FMA8612",
                       "FMA3932", "FMA3941", "FMA4058", "FMA3953", "FMA4694",
                       "FMA14765", "FMA14766", "FMA70249", "FMA70250"], 32000),
    "sys_neuro":     (["FMA50801"], 24000),                                  # brain
    "sys_metabolic": (["FMA7197", "FMA7198"], 14000),                        # liver, pancreas
    "sys_msk":       (["FMA16580", "FMA13478", "FMA24474", "FMA24475",
                       "FMA24477", "FMA24478"], 32000),                      # pelvis, spine, femurs, tibiae
    "sys_ocular":    (["FMA12514", "FMA12515"], 6000),                       # eyeballs
    "sys_immune":    (["FMA9607"], 2000),                                    # thymus (no lymph nodes/spleen in BP3D part_of set)
}
TARGET_HEIGHT_M = 1.75
# Modesty: the BP3D skin includes external genitalia. Everything in this box (metres, after
# normalisation; Blender axes, front is -Y) is cut from the shell and the gap is closed with a
# smooth membrane, giving a featureless mannequin groin. Checked by renders from front, back,
# side and directly below.
GROIN_BOX = ((-0.048, -0.2, 0.762), (0.054, -0.005, 0.897))


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def element_files(src, concepts):
    want, files = set(concepts), []
    with open(os.path.join(src, "partof_element_parts.txt"), encoding="utf-8") as f:
        next(f)
        for line in f:
            c, _name, fj = line.rstrip("\n").split("\t")
            if c in want:
                files.append(fj)
    found = {l.split("\t")[0] for l in open(os.path.join(src, "partof_element_parts.txt"), encoding="utf-8")}
    missing = want - found
    if missing:
        raise SystemExit(f"Concept ids not in element list: {sorted(missing)}")
    return sorted(set(files))


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def build_system(src, name, concepts, budget):
    objdir = os.path.join(src, "partof_BP3D_4.0_obj_99")
    imported = []
    for fj in element_files(src, concepts):
        path = os.path.join(objdir, fj + ".obj")
        if not os.path.exists(path):
            raise SystemExit(f"Missing OBJ {path}")
        before = set(bpy.data.objects)
        # BP3D is Z-up in mm; keep raw axes here, convert once at export.
        bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
        imported += [o for o in bpy.data.objects if o not in before]
    bpy.ops.object.select_all(action="DESELECT")
    for o in imported:
        o.select_set(True)
    bpy.context.view_layer.objects.active = imported[0]
    if len(imported) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    # merge coincident verts between element files, then decimate to budget
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    tris = tri_count(obj)
    if tris > budget:
        m = obj.modifiers.new("dec", "DECIMATE")
        m.ratio = budget / tris
        bpy.ops.object.modifier_apply(modifier=m.name)
    obj.data.validate(clean_customdata=True)
    bpy.ops.object.shade_smooth()
    for slot in list(obj.material_slots):
        obj.data.materials.clear()
    print(f"[build_body] {name}: {tris} -> {tri_count(obj)} tris")
    return obj


def neutralise_groin(mesh, lo, hi, refine=4, iters=400):
    bm = bmesh.new(); bm.from_mesh(mesh)
    lay = bm.faces.layers.int.new("patch")
    inside = lambda p: all(lo[i] < p[i] < hi[i] for i in range(3))
    cut = [f for f in bm.faces if any(inside(v.co) for v in f.verts)]
    if not cut:
        raise SystemExit("GROIN_BOX matched no shell faces; model frame changed, re-check it")
    bmesh.ops.delete(bm, geom=cut, context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    rim_edges = [e for e in bm.edges if e.is_boundary]
    rim = {v for e in rim_edges for v in e.verts}
    for f in bmesh.ops.holes_fill(bm, edges=rim_edges, sides=0)["faces"]:
        f[lay] = 1
    patch = lambda: [f for f in bm.faces if f[lay] == 1]
    bmesh.ops.triangulate(bm, faces=patch(), quad_method="BEAUTY", ngon_method="BEAUTY")
    for _ in range(refine):  # give the membrane interior vertices to relax
        inner = list({e for f in patch() for e in f.edges if all(g[lay] == 1 for g in e.link_faces)})
        bmesh.ops.subdivide_edges(bm, edges=inner, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=patch())
    free = {v for f in patch() for v in f.verts} - rim
    for _ in range(iters):  # Laplacian relax with the rim fixed
        nxt = {v: sum((e.other_vert(v).co for e in v.link_edges), v.co * 0) / len(v.link_edges) for v in free}
        for v, co in nxt.items():
            v.co = co
    if any(e.is_boundary for e in bm.edges):
        raise SystemExit("shell not closed after groin fill")
    bm.faces.layers.int.remove(lay)
    bm.normal_update(); bm.to_mesh(mesh); mesh.update(); bm.free()
    print(f"[build_body] groin neutralised: {len(cut)} faces cut, {len(free)} membrane verts")


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = [build_system(a.src, n, c, b) for n, (c, b) in SYSTEMS.items()]

    # Normalise: feet at origin, centred on X/Y, height 1.75 m (shell defines the frame).
    shell = bpy.data.objects["shell"]
    zs = [ (shell.matrix_world @ v.co).z for v in shell.data.vertices ]
    xs = [ (shell.matrix_world @ v.co).x for v in shell.data.vertices ]
    ys = [ (shell.matrix_world @ v.co).y for v in shell.data.vertices ]
    zmin, zmax = min(zs), max(zs)
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    s = TARGET_HEIGHT_M / (zmax - zmin)
    for o in objs:
        for v in o.data.vertices:
            v.co.x = (v.co.x - cx) * s
            v.co.y = (v.co.y - cy) * s
            v.co.z = (v.co.z - zmin) * s
        o.data.update()
    neutralise_groin(shell.data, *GROIN_BOX)

    total = sum(tri_count(o) for o in objs)
    print(f"[build_body] total {total} tris, scale {s:.6f}")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=a.out, export_format="GLB", export_yup=True,
                              export_apply=True, export_normals=True, export_materials="NONE",
                              export_texcoords=False, export_extras=False)
    print(f"[build_body] wrote {a.out}")


main()
