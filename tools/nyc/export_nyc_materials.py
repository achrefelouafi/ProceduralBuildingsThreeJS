"""Export the NYC_* material node trees + their textures for the three.js
shader-graph compiler (src/nyc/shadergraph.ts).

  blender --background NYC_CornerBuilding.blend --python tools/nyc/export_nyc_materials.py -- <project root>

Writes public/assets/nyc/materials.json (nodes with properties, typed sockets,
unlinked input values, color ramps, links by socket index) and
public/assets/nyc/tex/<image>.jpg|png (colour maps 1024 px sRGB JPEG,
data maps 512 px PNG). Read-only on the .blend (resizing works on copies).
"""
import json
import os
import sys

import bpy
import numpy as np

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["PROJECT_ROOT"]
OUT = os.path.join(ROOT, "public", "assets", "nyc")
TEX = os.path.join(OUT, "tex")
os.makedirs(TEX, exist_ok=True)

PROPS = ("operation", "blend_type", "data_type", "attribute_name", "attribute_type", "interpolation", "projection",
         "extension", "noise_dimensions", "feature", "distance", "normalize", "noise_type", "rotation_type", "invert",
         "use_clamp", "clamp_factor", "clamp_result", "factor_mode", "mode", "from_instancer", "vector_type",
         "convert_from", "convert_to", "space", "use_auto_update", "invert", "component")


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
        fname = stem + (".png" if data else ".jpg")
        images[img.name] = {"file": fname, "srgb": not data}
    return images[img.name]["file"]


mats = {}
for m in bpy.data.materials:
    if not m.name.startswith("NYC_") or "_BACKUP_" in m.name or not m.use_nodes:
        continue
    nt = m.node_tree
    nodes = []
    for n in nt.nodes:
        if n.bl_idname in ("NodeFrame",):
            continue
        d = {"name": n.name, "type": n.bl_idname, "props": {}}
        for p in PROPS:
            if hasattr(n, p):
                d["props"][p] = val(getattr(n, p))
        if n.bl_idname == "ShaderNodeValToRGB":
            cr = n.color_ramp
            d["ramp"] = {"interp": cr.interpolation, "stops": [[round(e.position, 6), val(e.color)] for e in cr.elements]}
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
    src = bpy.data.images[img_name]
    img = src.copy()
    try:
        w, h = img.size
        size = 1024 if meta["srgb"] else 512
        k = size / max(w, h)
        if k < 1:
            img.scale(max(1, round(w * k)), max(1, round(h * k)))
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        out = bpy.data.images.new("__nyc_tex", w, h, alpha=False)
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

with open(os.path.join(OUT, "materials.json"), "w") as f:
    json.dump({"materials": mats, "images": images}, f, separators=(",", ":"))
print("NYC_MATS_OK", len(mats), "materials", len(images), "images")
