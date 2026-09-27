"""Export the CN_ApartmentBuilding.blend module kit for the three.js port.

  blender --background CN_ApartmentBuilding.blend --python tools/cn/export_cn_kit.py -- <project root>

Writes public/assets/cn/:
  kit.json   objects under CN_Kit (local-space evaluated meshes: faces,
             material slots, smooth flags and every point / face / corner
             attribute: UVMap, Col, _cid ...) as offsets into kit.bin;
             collections with Collection Info's child order; font glyphs
             for String to Curves: ASCII plus tools/cn/glyphs.txt (Bfont
             Regular, which falls back to Noto Sans CJK for CJK text),
             outlines as offsets into kit.bin.
  kit.bin    little-endian Float32 / Int32 arrays.
Read-only on the .blend (temporary glyph objects are created and removed).
"""
import json
import os
import re
import sys

import bpy
import numpy as np

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["PROJECT_ROOT"]
OUT = os.path.join(ROOT, "public", "assets", "cn")
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


# attribute data type → (floats per element, foreach_get property)
TYPES = {
    "FLOAT": (1, "value"), "INT": (1, "value"), "BOOLEAN": (1, "value"), "FLOAT2": (2, "vector"),
    "FLOAT_VECTOR": (3, "vector"), "FLOAT_COLOR": (4, "color"), "BYTE_COLOR": (4, "color"),
}
SKIP_ATTRS = {"position", "sharp_face", "material_index", "sharp_edge"}

dg = bpy.context.evaluated_depsgraph_get()
objects = {}
kit_root = bpy.data.collections["CN_Kit"]
names = sorted({o.name for o in kit_root.all_objects if o.type == "MESH"})
for name in names:
    ob = bpy.data.objects[name]
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    nv, nf, nl = len(me.vertices), len(me.polygons), len(me.loops)
    pos = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", pos)
    start = np.empty(nf, np.int32); me.polygons.foreach_get("loop_start", start)
    corner = np.empty(nl, np.int32); me.loops.foreach_get("vertex_index", corner)
    mat = np.empty(nf, np.int32); me.polygons.foreach_get("material_index", mat)
    smooth = np.empty(nf, np.int8); me.polygons.foreach_get("use_smooth", smooth)
    faces_start = np.concatenate([start, [nl]]).astype(np.int32)
    attrs = {}
    for a in me.attributes:
        if a.name.startswith(".") or a.name in SKIP_ATTRS or a.is_internal:
            continue
        if a.domain not in ("POINT", "FACE", "CORNER") or a.data_type not in TYPES:
            continue
        size, prop = TYPES[a.data_type]
        n = len(a.data)
        raw = np.empty(n * size, np.int32 if a.data_type == "INT" else bool if a.data_type == "BOOLEAN" else np.float32)
        a.data.foreach_get(prop, raw)
        attrs[a.name] = {"domain": a.domain.lower(), "size": size, "type": a.data_type,
                         "data": put(raw.astype(np.float32), "<f4")}
    objects[name] = {
        "pos": put(pos, "<f4"), "faceStart": put(faces_start, "<i4"), "corners": put(corner, "<i4"),
        "matIndex": put(mat, "<i4"), "smooth": put(smooth.astype(np.int32), "<i4"),
        "materials": [s.material.name if s.material else None for s in ob.material_slots],
        "attrs": attrs,
    }
    ev.to_mesh_clear()

collections = {}
for c in kit_root.children_recursive:
    collections[c.name] = sorted([o.name for o in c.objects if o.type == "MESH"], key=natural_key)


# ---- glyphs: String to Curves (Bfont Regular, size 1), evaluated to poly loops.
# A batch "c1|c2|…|" is evaluated at once; each instance stores its index and
# pen position, the bar after a character gives its advance.
def evaluate_text(text, fill=False):
    """outline points (Curve to Mesh without profile) or, with fill, Fill Curve's triangles of each glyph"""
    ng = bpy.data.node_groups.new("__cn_glyph", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    out = ng.nodes.new("NodeGroupOutput")
    s2c = ng.nodes.new("GeometryNodeStringToCurves")
    s2c.inputs["String"].default_value = text
    s2c.inputs["Size"].default_value = 1.0
    prev = s2c.outputs["Curve Instances"]
    for attr, dtype, src in (("ci", "FLOAT", "GeometryNodeInputIndex"), ("pp", "FLOAT_VECTOR", "GeometryNodeInputPosition")):
        st = ng.nodes.new("GeometryNodeStoreNamedAttribute"); st.data_type = dtype; st.domain = "INSTANCE"
        st.inputs["Name"].default_value = attr
        ng.links.new(prev, st.inputs["Geometry"])
        ng.links.new(ng.nodes.new(src).outputs[0], st.inputs["Value"])
        prev = st.outputs[0]
    if fill:
        fc = ng.nodes.new("GeometryNodeFillCurve")  # Triangles, Even-Odd: what the CN graph uses
        ng.links.new(prev, fc.inputs[0])
        prev = fc.outputs[0]
    rl = ng.nodes.new("GeometryNodeRealizeInstances")
    ng.links.new(prev, rl.inputs[0])
    if fill:
        ng.links.new(rl.outputs[0], out.inputs[0])
    else:
        c2m = ng.nodes.new("GeometryNodeCurveToMesh")
        ng.links.new(rl.outputs[0], c2m.inputs["Curve"])
        ng.links.new(c2m.outputs[0], out.inputs[0])
    me = bpy.data.meshes.new("__cn_glyph"); ob = bpy.data.objects.new("__cn_glyph", me)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new("g", "NODES"); mod.node_group = ng
    dg2 = bpy.context.evaluated_depsgraph_get()
    em = ob.evaluated_get(dg2).to_mesh()
    nv = len(em.vertices)
    co = np.empty(nv * 3, np.float32); em.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    ci = np.zeros(nv, np.float32)
    pp = np.zeros(nv * 3, np.float32)
    if nv:
        em.attributes["ci"].data.foreach_get("value", ci)
        em.attributes["pp"].data.foreach_get("vector", pp)
    pp = pp.reshape(-1, 3)
    ev_ = np.empty(len(em.edges) * 2, np.int32); em.edges.foreach_get("vertices", ev_)
    tris = [tuple(p.vertices) for p in em.polygons]
    ob.evaluated_get(dg2).to_mesh_clear()
    bpy.data.objects.remove(ob); bpy.data.meshes.remove(me); bpy.data.node_groups.remove(ng)
    # edges → loops (Curve to Mesh without profile: one edge chain per cyclic spline)
    adj = {}
    for a, b in ev_.reshape(-1, 2):
        adj.setdefault(int(a), []).append(int(b)); adj.setdefault(int(b), []).append(int(a))
    seen, loops = set(), []
    for v0 in range(nv):
        if v0 in seen or v0 not in adj:
            continue
        loop, prev_v, cur = [], None, v0
        while cur not in seen:
            seen.add(cur); loop.append(cur)
            nxt = [x for x in adj[cur] if x != prev_v]
            if not nxt:
                break
            prev_v, cur = cur, nxt[0]
        loops.append(loop)
    if fill:
        return co, ci.astype(np.int64), pp, tris
    return co, ci.astype(np.int64), pp, loops


def glyph_fills(chars):
    """Fill Curve per glyph: {char: (vertex positions relative to the pen, triangles)}, None if misaligned"""
    co, ci, pp, tris = evaluate_text("".join(c + "|" for c in chars), fill=True)
    if not len(ci) or int(ci.max()) + 1 != 2 * len(chars):
        return None
    out = {}
    for k, ch in enumerate(chars):
        vs = np.nonzero(ci == 2 * k)[0]
        local = {int(v): i for i, v in enumerate(vs)}
        px, py = (float(pp[vs[0]][0]), float(pp[vs[0]][1])) if len(vs) else (0.0, 0.0)
        out[ch] = ([(float(co[v][0]) - px, float(co[v][1]) - py) for v in vs],
                   [[local[v] for v in t] for t in tris if int(t[0]) in local])
    return out


def glyph_batch(chars):
    """{char: glyph} for chars evaluated as "c1|c2|…|", or None if the instances don't line up"""
    co, ci, pp, loops = evaluate_text("".join(c + "|" for c in chars))
    if not len(ci) or int(ci.max()) + 1 != 2 * len(chars):
        return None
    pen = {}
    for i in range(len(ci)):
        pen.setdefault(int(ci[i]), (float(pp[i][0]), float(pp[i][1])))
    fills = glyph_fills(chars)
    if fills is None:
        return None
    out = {}
    for k, ch in enumerate(chars):
        px, py = pen[2 * k]
        glyph_loops = [l for l in loops if int(ci[l[0]]) == 2 * k]
        # loops as x, y float32 spans in kit.bin (glyph space, pen at the origin)
        outline = [(float(co[i][0] - px), float(co[i][1] - py)) for l in glyph_loops for i in l]
        fverts, ftris = fills[ch]
        g = {"advance": round(pen[2 * k + 1][0] - px, 6),
             "spans": [put([v for i in l for v in (co[i][0] - px, co[i][1] - py)], "<f4") for l in glyph_loops]}
        if ftris:
            # Blender's own fill triangulation (its CDT welds touching contours): as indices into the
            # outline points when every fill vertex is one of them, else with its own vertices
            d = np.abs(np.array(fverts)[:, None, :] - np.array(outline)[None, :, :]).max(axis=2)
            nearest = d.argmin(axis=1)
            remap = [int(j) if d[i, j] < 1e-5 else None for i, j in enumerate(nearest)]
            if None in remap:
                g["fill"] = put([i for t in ftris for i in t], "<u2")
                g["fillPos"] = put([v for p in fverts for v in p], "<f4")
            else:
                g["fill"] = put([remap[i] for t in ftris for i in t], "<u2")
        out[ch] = g
    return out


with open(os.path.join(ROOT, "tools", "cn", "glyphs.txt"), encoding="utf-8") as f:
    extra = [c for c in f.read() if not c.isspace()]
chars = []
for c in [chr(code) for code in range(33, 127)] + extra:
    if c not in chars:
        chars.append(c)
glyphs = {}
BATCH = 64
for i in range(0, len(chars), BATCH):
    part = chars[i:i + BATCH]
    got = glyph_batch(part)
    if got is None:  # a character without an instance: evaluate one by one, skip the missing ones
        got = {}
        for ch in part:
            one = glyph_batch([ch])
            if one:
                got.update(one)
    glyphs.update(got)

_, ci_a, pp_a, _ = evaluate_text("| |")
_, ci_b, pp_b, _ = evaluate_text("||")
space = float(pp_a[ci_a == ci_a.max()][0][0] - pp_b[ci_b == ci_b.max()][0][0])

with open(os.path.join(OUT, "kit.bin"), "wb") as f:
    f.write(bytes(blob))
with open(os.path.join(OUT, "kit.json"), "w", encoding="utf-8") as f:
    json.dump({"objects": objects, "collections": collections,
               "font": {"space": round(space, 6), "glyphs": glyphs}}, f, separators=(",", ":"), ensure_ascii=False)
print("CN_KIT_OK", len(objects), "objects", len(blob), "bytes", len(glyphs), "glyphs", "space", space)
result = {"objects": len(objects), "bytes": len(blob), "glyphs": len(glyphs), "missing": [c for c in chars if c not in glyphs]}
