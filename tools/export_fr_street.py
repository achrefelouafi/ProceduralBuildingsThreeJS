"""Export FrenchBuilding.blend's street pieces for the three.js port: the
sidewalk and granite curb around the building (FR_Sidewalk, FR_Curb) and
their materials, for the graph renderer (src/nyc/render.ts) and shader-graph
compiler (src/nyc/shadergraph.ts).

  blender --background FrenchBuilding.blend --python tools/export_fr_street.py -- <project root>

Both objects carry the FR_SidewalkFollowBuilding modifier (driven by the
building's Bays X / Y), which the app re-applies (src/street.ts): the meshes
are exported UNDEFORMED (their mesh data, modelled for Modeled Width / Depth),
with the modifier's constant inputs.

Writes public/assets/fr/:
  street.json + street.bin   the two meshes in the NYC kit format (kit.ts)
                             + the Follow Building constants
  materials.json + tex/      FR_Pavement / FR_Curb node trees (NYC format)
Read-only on the .blend (texture resizing works on copies).
"""
import json
import os
import sys

import bpy
import numpy as np

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["PROJECT_ROOT"]
OUT = os.path.join(ROOT, "public", "assets", "fr")
TEX = os.path.join(OUT, "tex")
os.makedirs(TEX, exist_ok=True)

OBJECTS = ["FR_Sidewalk", "FR_Curb"]

# ---- meshes (NYC kit format) ------------------------------------------------------

blob = bytearray()


def put(arr, dtype):
    a = np.ascontiguousarray(arr, dtype=dtype)
    off = len(blob)
    blob.extend(a.tobytes())
    while len(blob) % 4:
        blob.append(0)
    return [off, int(a.size)]


objects = {}
follow = None
used_mats = []
for name in OBJECTS:
    ob = bpy.data.objects[name]
    me = ob.data  # undeformed: the app applies Follow Building
    nv, nf, nl = len(me.vertices), len(me.polygons), len(me.loops)
    pos = np.empty(nv * 3, np.float32); me.vertices.foreach_get("co", pos)
    start = np.empty(nf, np.int32); me.polygons.foreach_get("loop_start", start)
    corner = np.empty(nl, np.int32); me.loops.foreach_get("vertex_index", corner)
    mat = np.empty(nf, np.int32); me.polygons.foreach_get("material_index", mat)
    smooth = np.empty(nf, np.int8); me.polygons.foreach_get("use_smooth", smooth)
    cn = np.empty(nl * 3, np.float32); me.corner_normals.foreach_get("vector", cn)
    attrs = {}
    for a in me.attributes:
        if a.name.startswith(".") or a.is_internal or a.name == "position":
            continue
        if a.data_type == "FLOAT_VECTOR" and a.domain == "POINT":
            d = np.empty(len(a.data) * 3, np.float32); a.data.foreach_get("vector", d)
            attrs[a.name] = {"domain": "point", "size": 3, "data": put(d, "<f4")}
        elif a.data_type == "FLOAT" and a.domain == "POINT":
            d = np.empty(len(a.data), np.float32); a.data.foreach_get("value", d)
            attrs[a.name] = {"domain": "point", "size": 1, "data": put(d, "<f4")}
    objects[name] = {
        "pos": put(pos, "<f4"), "faceStart": put(np.concatenate([start, [nl]]), "<i4"), "corners": put(corner, "<i4"),
        "matIndex": put(mat, "<i4"), "smooth": put(smooth.astype(np.int32), "<i4"), "cornerNormals": put(cn, "<f4"),
        "materials": [s.material.name if s.material else None for s in ob.material_slots],
        "attrs": attrs,
    }
    used_mats += [s.material for s in ob.material_slots if s.material]
    mod = ob.modifiers["Follow Building"]
    iface = {it.name: it.identifier for it in mod.node_group.interface.items_tree
             if it.item_type == "SOCKET" and it.in_out == "INPUT"}
    f = {k: float(mod[iface[k]]) for k in ("Bay Width", "Corner Extra", "Modeled Width", "Modeled Depth")}
    assert follow in (None, f), "the sidewalk and curb must follow the building the same way"
    follow = f

with open(os.path.join(OUT, "street.bin"), "wb") as fh:
    fh.write(bytes(blob))
with open(os.path.join(OUT, "street.json"), "w") as fh:
    json.dump({"objects": objects, "collections": {}, "font": {"space": 0, "glyphs": {}}, "follow": follow},
              fh, separators=(",", ":"))

# ---- materials (NYC materials.json format) ------------------------------------------

PROPS = ("operation", "blend_type", "data_type", "attribute_name", "attribute_type", "interpolation", "projection",
         "projection_blend", "extension", "noise_dimensions", "feature", "distance", "normalize", "noise_type",
         "rotation_type", "invert", "use_clamp", "clamp", "clamp_factor", "clamp_result", "factor_mode", "mode",
         "from_instancer", "vector_type", "convert_from", "convert_to", "space", "component", "interpolation_type")


def val(v):
    if isinstance(v, (bool, int, str)) or v is None:
        return v
    if isinstance(v, float):
        return round(v, 6)
    try:
        return [round(float(x), 6) for x in v]
    except TypeError:
        return str(v)


images = {}


def tex_name(img):
    if img.name not in images:
        data = img.colorspace_settings.name != "sRGB"
        stem = os.path.splitext(img.name)[0].replace(" ", "_")
        images[img.name] = {"file": stem + (".png" if data else ".jpg"), "srgb": not data}
    return images[img.name]["file"]


mats = {}
for m in dict.fromkeys(used_mats):
    nt = m.node_tree
    nodes = []
    for n in nt.nodes:
        if n.bl_idname == "NodeFrame":
            continue
        d = {"name": n.name, "type": n.bl_idname, "props": {}}
        for p in PROPS:
            if hasattr(n, p):
                d["props"][p] = val(getattr(n, p))
        if n.bl_idname == "ShaderNodeTexImage" and n.image:
            d["image"] = tex_name(n.image)
        d["inputs"] = [{"name": s.name, "type": s.type, "enabled": s.enabled,
                        "value": val(s.default_value) if hasattr(s, "default_value") else None} for s in n.inputs]
        d["outputs"] = [{"name": s.name, "type": s.type, "enabled": s.enabled} for s in n.outputs]
        nodes.append(d)
    links = [{"from": l.from_node.name, "fi": list(l.from_node.outputs).index(l.from_socket),
              "to": l.to_node.name, "ti": list(l.to_node.inputs).index(l.to_socket)}
             for l in nt.links if l.is_valid and not l.is_muted]
    mats[m.name] = {"blend": getattr(m, "surface_render_method", "DITHERED"), "backface_culling": m.use_backface_culling,
                    "nodes": nodes, "links": links}


def save(img_name, meta):
    img = bpy.data.images[img_name].copy()
    try:
        w, h = img.size
        size = 1024 if meta["srgb"] else 512
        k = size / max(w, h)
        if k < 1:
            img.scale(max(1, round(w * k)), max(1, round(h * k)))
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        out = bpy.data.images.new("__fr_tex", w, h, alpha=False)
        out.colorspace_settings.name = "sRGB" if meta["srgb"] else "Non-Color"
        px = px.reshape(h, w, 4); px[..., 3] = 1.0
        out.pixels.foreach_set(px.ravel())
        out.filepath_raw = os.path.join(TEX, meta["file"])
        out.file_format = "PNG" if meta["file"].endswith(".png") else "JPEG"
        out.save(quality=88) if out.file_format == "JPEG" else out.save()
        bpy.data.images.remove(out)
        meta["size"] = [w, h]
    finally:
        bpy.data.images.remove(img)


for name, meta in images.items():
    save(name, meta)

with open(os.path.join(OUT, "materials.json"), "w") as fh:
    json.dump({"materials": mats, "images": images}, fh, separators=(",", ":"))
print("FR_STREET_OK", list(objects), len(blob), "bytes", list(mats), len(images), "images")
result = {"objects": list(objects), "bytes": len(blob), "materials": list(mats), "images": images, "follow": follow}
