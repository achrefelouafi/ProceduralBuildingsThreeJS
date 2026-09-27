"""Ground truth for the CN evaluator: evaluate CN_Building in Blender for a few
parameter sets and dump statistics of the realized mesh it outputs.

  blender --background CN_ApartmentBuilding.blend --python tools/cn/dump_cn_truth.py -- tools/cn/truth.json

Per material: faces, corners, smooth faces, area, bounding box, and the area-
weighted moments of face centers, UVMap and Col (Σ area · mean over the face).
These don't depend on how n-gons are triangulated (Fill Curve), so the port
can differ from Blender's CDT and still match. Read-only: modifier values are
restored after each set.
"""
import json
import sys

import bpy
import numpy as np

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["OUT_PATH"]

SETS = [
    {},  # the file's own modifier values
    {"Width": 24.0, "Depth": 16.0, "Floors": 8, "Seed": 11, "Shop Seed": 9, "Facade Finish": "Ceramic Tile",
     "Detail Level": "LOD1", "Wall Tint": [0.8, 0.9, 1.0, 1.0], "Sign Text": "Happy 123", "Stone Ground Floor": False,
     "Floor Bands": False, "Parapet Height": 1.6, "Weathering": 0.9},
    {"Floors": 3, "Width": 10.0, "Depth": 9.0, "Bay Width": 2.6, "Corner Margin": 2.0, "Balcony Probability": 0.9,
     "Enclosed Balcony Probability": 0.2, "Security Grille Probability": 0.9, "AC Unit Probability": 0.9,
     "Laundry Probability": 0.9, "Plant Probability": 0.9, "Drainpipe Probability": 1.0, "Sidewalk Width": 2.5,
     "Corner Radius": 5.0, "Solar Heaters": 0, "Antennas": 0, "Roof Vents": 0, "Roof Props": 20, "Sign Text": "公寓"},
    {"Detail Level": "LOD2", "Rooftop Sign": False, "Shop Props": False, "Street Trees": False, "Tactile Paving": False,
     "Seed": 42, "Floors": 12, "Window Width": 2.0, "Window Height": 1.2, "Sill Height": 1.1, "Lit Window Probability": 0.8,
     "Curtain Probability": 0.2, "Shutter Probability": 0.8, "Stall Probability": 0.6, "Awning Probability": 0.9,
     "Lantern Probability": 0.9, "Blade Sign Probability": 0.9, "Ground Floor Height": 5.0, "Floor Height": 3.5,
     "Wall Thickness": 0.5, "Balcony Min Floor": 3},
    {"Detail Level": "Collision", "Sidewalk": False},
]

ob = bpy.data.objects["CN_CornerApartment"]
mod = [m for m in ob.modifiers if m.type == "NODES"][0]
iface = {it.name: it for it in mod.node_group.interface.items_tree if it.item_type == "SOCKET" and it.in_out == "INPUT"}


def set_value(name, v):
    it = iface[name]
    key = it.identifier
    if it.socket_type == "NodeSocketMenu":
        items = mod.id_properties_ui(key).as_dict()["items"]
        v = [x[4] for x in items if x[0] == v][0]
    mod[key] = v


def read_values():
    vals = {}
    for name, it in iface.items():
        if it.identifier not in mod.keys():
            continue
        v = mod[it.identifier]
        if it.socket_type == "NodeSocketMenu":
            items = mod.id_properties_ui(it.identifier).as_dict()["items"]
            v = [x[0] for x in items if x[4] == v][0]
        elif hasattr(v, "__len__") and not isinstance(v, str):
            v = list(v)
        vals[name] = v
    return vals


def stats(me):
    nf, nl, nv = len(me.polygons), len(me.loops), len(me.vertices)
    area = np.empty(nf, np.float64); me.polygons.foreach_get("area", area)
    center = np.empty(nf * 3, np.float32); me.polygons.foreach_get("center", center); center = center.reshape(-1, 3)
    mat = np.empty(nf, np.int32); me.polygons.foreach_get("material_index", mat)
    smooth = np.empty(nf, bool); me.polygons.foreach_get("use_smooth", smooth)
    start = np.empty(nf, np.int32); me.polygons.foreach_get("loop_start", start)
    total = np.empty(nf, np.int32); me.polygons.foreach_get("loop_total", total)
    cv = np.empty(nl, np.int32); me.loops.foreach_get("vertex_index", cv)
    co = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    uv = np.zeros((nl, 2))
    if "UVMap" in me.attributes:
        d = np.empty(nl * 2, np.float32); me.attributes["UVMap"].data.foreach_get("vector", d); uv = d.reshape(-1, 2)
    col = np.zeros((nv, 4))
    if "Col" in me.attributes:
        d = np.empty(nv * 4, np.float32); me.attributes["Col"].data.foreach_get("color", d); col = d.reshape(-1, 4)
    face_uv = np.add.reduceat(uv.astype(np.float64), start, axis=0) / total[:, None] if nf else np.zeros((0, 2))
    face_col = np.add.reduceat(col[cv].astype(np.float64), start, axis=0) / total[:, None] if nf else np.zeros((0, 4))
    names = [m.name if m else "-" for m in me.materials] or ["-"]
    per = {}
    for k in np.unique(mat):
        sel = mat == k
        loops = np.concatenate([np.arange(s, s + t) for s, t in zip(start[sel], total[sel])])
        pts = co[np.unique(cv[loops])]
        a = area[sel]
        per.setdefault(names[k] if k < len(names) else "-", []).append({
            "faces": int(sel.sum()), "corners": int(total[sel].sum()), "smooth": int(smooth[sel].sum()),
            "area": float(a.sum()),
            "moment": (a[:, None] * center[sel]).sum(0).tolist(),
            "uv": (a[:, None] * face_uv[sel]).sum(0).tolist(),
            "col": (a[:, None] * face_col[sel]).sum(0).tolist(),
            "min": pts.min(0).tolist(), "max": pts.max(0).tolist(),
        })
    # the same material can sit in several slots: merge
    out = {}
    for name, parts in per.items():
        s = {"faces": 0, "corners": 0, "smooth": 0, "area": 0.0, "moment": [0.0] * 3, "uv": [0.0] * 2, "col": [0.0] * 4,
             "min": [1e30] * 3, "max": [-1e30] * 3}
        for p in parts:
            for k in ("faces", "corners", "smooth", "area"):
                s[k] += p[k]
            for k in ("moment", "uv", "col"):
                s[k] = [x + y for x, y in zip(s[k], p[k])]
            s["min"] = [min(x, y) for x, y in zip(s["min"], p["min"])]
            s["max"] = [max(x, y) for x, y in zip(s["max"], p["max"])]
        out[name] = s
    return {"verts": nv, "faces": nf, "corners": nl, "materials": out,
            "attributes": sorted(a.name for a in me.attributes if not a.name.startswith("."))}


base = read_values()
sets = []
for over in SETS:
    for k, v in over.items():
        set_value(k, v)
    ob.update_tag()
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = ob.evaluated_get(dg).data
    sets.append({"params": read_values(), "mesh": stats(me)})
    for k in over:
        set_value(k, base[k])
    print("CN_TRUTH_SET", len(me.vertices), len(me.polygons))
ob.update_tag()
with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"sets": sets}, f, separators=(",", ":"), ensure_ascii=False)
print("CN_TRUTH_OK")
result = {"sets": [(s["mesh"]["verts"], s["mesh"]["faces"]) for s in sets]}
