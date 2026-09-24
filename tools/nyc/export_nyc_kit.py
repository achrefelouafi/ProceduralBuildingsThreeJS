"""Export the NYC_CornerBuilding.blend module kit for the three.js port.

  blender --background NYC_CornerBuilding.blend --python tools/nyc/export_nyc_kit.py -- <project root>

Writes public/assets/nyc/:
  kit.json   objects (local-space evaluated meshes: faces, material slots,
             smooth flags, corner normals, float attributes) as offsets into
             kit.bin; collections with Collection Info's child order;
             font glyphs for String to Curves (Bfont Regular, evaluated
             outlines + advances).
  kit.bin    little-endian Float32 / Int32 arrays.
Read-only on the .blend (a temporary glyph object is created and removed).
"""
import json
import os
import re
import sys

import bpy
import numpy as np

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["PROJECT_ROOT"]
OUT = os.path.join(ROOT, "public", "assets", "nyc")
os.makedirs(OUT, exist_ok=True)

blob = bytearray()


def put(arr, dtype):
    a = np.ascontiguousarray(arr, dtype=dtype)
    off = len(blob)
    blob.extend(a.tobytes())
    while len(blob) % 4:
        blob.append(0)
    return [off, int(a.size)]


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


dg = bpy.context.evaluated_depsgraph_get()
objects = {}
module_root = bpy.data.collections["NYC_Modules"]
names = sorted({o.name for o in module_root.all_objects if o.type == "MESH"})
for name in names:
    ob = bpy.data.objects[name]
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    nv, nf, nl = len(me.vertices), len(me.polygons), len(me.loops)
    pos = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", pos)
    start = np.empty(nf, np.int32); me.polygons.foreach_get("loop_start", start)
    total = np.empty(nf, np.int32); me.polygons.foreach_get("loop_total", total)
    corner = np.empty(nl, np.int32); me.loops.foreach_get("vertex_index", corner)
    mat = np.empty(nf, np.int32); me.polygons.foreach_get("material_index", mat)
    smooth = np.empty(nf, np.int8); me.polygons.foreach_get("use_smooth", smooth)
    cn = np.empty(nl * 3, np.float32)
    try:
        me.corner_normals.foreach_get("vector", cn)
    except Exception:
        me.calc_normals_split(); me.loops.foreach_get("normal", cn)
    faces_start = np.concatenate([start, [nl]]).astype(np.int32)
    attrs = {}
    for a in me.attributes:
        if a.name.startswith(".") or a.name in ("position", "sharp_face", "material_index", "sharp_edge") or a.is_internal:
            continue
        if a.data_type == "FLOAT" and a.domain in ("POINT", "FACE"):
            d = np.empty(len(a.data), np.float32); a.data.foreach_get("value", d)
            attrs[a.name] = {"domain": a.domain.lower(), "size": 1, "data": put(d, "<f4")}
        elif a.data_type == "FLOAT_VECTOR" and a.domain in ("POINT", "FACE"):
            d = np.empty(len(a.data) * 3, np.float32); a.data.foreach_get("vector", d)
            attrs[a.name] = {"domain": a.domain.lower(), "size": 3, "data": put(d, "<f4")}
    objects[name] = {
        "pos": put(pos, "<f4"), "faceStart": put(faces_start, "<i4"), "corners": put(corner, "<i4"),
        "matIndex": put(mat, "<i4"), "smooth": put(smooth.astype(np.int32), "<i4"), "cornerNormals": put(cn, "<f4"),
        "materials": [s.material.name if s.material else None for s in ob.material_slots],
        "attrs": attrs,
    }
    ev.to_mesh_clear()

collections = {}
for c in module_root.children_recursive:
    collections[c.name] = sorted([o.name for o in c.objects if o.type == "MESH"], key=natural_key)


# ---- glyphs: String to Curves (Bfont Regular, size 1) evaluated to poly loops
def glyph_outline(text):
    ng = bpy.data.node_groups.new("__nyc_glyph", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    out = ng.nodes.new("NodeGroupOutput")
    s2c = ng.nodes.new("GeometryNodeStringToCurves")
    s2c.inputs["String"].default_value = text
    s2c.inputs["Size"].default_value = 1.0
    idx = ng.nodes.new("GeometryNodeInputIndex")
    st = ng.nodes.new("GeometryNodeStoreNamedAttribute"); st.data_type = "FLOAT"; st.domain = "INSTANCE"
    st.inputs["Name"].default_value = "ci"
    ng.links.new(s2c.outputs["Curve Instances"], st.inputs["Geometry"])
    ng.links.new(idx.outputs[0], st.inputs["Value"])
    rl = ng.nodes.new("GeometryNodeRealizeInstances")
    ng.links.new(st.outputs[0], rl.inputs[0])
    c2m = ng.nodes.new("GeometryNodeCurveToMesh")
    ng.links.new(rl.outputs[0], c2m.inputs["Curve"])
    ng.links.new(c2m.outputs[0], out.inputs[0])
    me = bpy.data.meshes.new("__nyc_glyph"); ob = bpy.data.objects.new("__nyc_glyph", me)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new("g", "NODES"); mod.node_group = ng
    dg2 = bpy.context.evaluated_depsgraph_get()
    em = ob.evaluated_get(dg2).to_mesh()
    co = [tuple(v.co) for v in em.vertices]
    ci = [0.0] * len(co)
    if "ci" in em.attributes:
        ci = [d.value for d in em.attributes["ci"].data]
    edges = [tuple(e.vertices) for e in em.edges]
    ob.evaluated_get(dg2).to_mesh_clear()
    bpy.data.objects.remove(ob); bpy.data.meshes.remove(me); bpy.data.node_groups.remove(ng)
    # edges → loops (Curve to Mesh without profile: one edge chain per cyclic spline)
    adj = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    seen, loops = set(), []
    for v0 in range(len(co)):
        if v0 in seen or v0 not in adj:
            continue
        loop, prev, cur = [], None, v0
        while cur not in seen:
            seen.add(cur); loop.append(cur)
            nxt = [x for x in adj[cur] if x != prev]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
        loops.append(loop)
    return co, ci, loops


glyphs = {}
bar_co, _, _ = glyph_outline("|")
bar_min = min(c[0] for c in bar_co)
for code in range(33, 127):
    ch = chr(code)
    co, ci, loops = glyph_outline(ch + "|")
    first = [l for l in loops if all(ci[i] == 0 for i in l)]
    bar = [i for i in range(len(co)) if ci[i] == 1]
    advance = (min(co[i][0] for i in bar) - bar_min) if bar else 0.0
    glyphs[ch] = {"advance": round(advance, 6),
                  "loops": [[round(v, 6) for i in l for v in co[i][:2]] for l in first]}
co_a, ci_a, _ = glyph_outline("| |")
co_b, ci_b, _ = glyph_outline("||")
x_a = min(co_a[i][0] for i in range(len(co_a)) if ci_a[i] == max(ci_a))  # the space is an empty instance
x_b = min(co_b[i][0] for i in range(len(co_b)) if ci_b[i] == max(ci_b))
space = x_a - x_b

with open(os.path.join(OUT, "kit.bin"), "wb") as f:
    f.write(bytes(blob))
with open(os.path.join(OUT, "kit.json"), "w") as f:
    json.dump({"objects": objects, "collections": collections,
               "font": {"space": round(space, 6), "glyphs": glyphs}}, f, separators=(",", ":"))
print("NYC_KIT_OK", len(objects), "objects", len(blob), "bytes", "space", space)
result = {"objects": len(objects), "bytes": len(blob)}
