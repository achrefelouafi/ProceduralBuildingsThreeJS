"""Export the M_CN_* material node trees + their textures for the three.js
shader-graph compiler (src/nyc/shadergraph.ts).

  blender --background CN_ApartmentBuilding.blend --python tools/cn/export_cn_materials.py -- <project root>

Writes public/assets/cn/materials.json (same format as
tools/nyc/export_nyc_materials.py) and public/assets/cn/tex/<image>.jpg:
colour and normal maps at 1024 px, other data maps (roughness, AO, opacity,
metalness) at 512 px, all JPEG. Read-only on the .blend (resizing works on
copies).
"""
import json
import os
import sys

import bpy
import numpy as np

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["PROJECT_ROOT"]
OUT = os.path.join(ROOT, "public", "assets", "cn")
TEX = os.path.join(OUT, "tex")
os.makedirs(TEX, exist_ok=True)

PROPS = ("operation", "blend_type", "data_type", "attribute_name", "attribute_type", "interpolation", "projection",
         "extension", "noise_dimensions", "feature", "distance", "normalize", "noise_type", "rotation_type", "invert",
         "use_clamp", "clamp_factor", "clamp_result", "factor_mode", "mode", "from_instancer", "vector_type",
         "convert_from", "convert_to", "space", "use_auto_update", "component", "uv_map", "layer_name")


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


def tex_name(img, normal):
    if img.name not in images:
        srgb = img.colorspace_settings.name == "sRGB"
        stem = os.path.splitext(img.name)[0].replace(" ", "_")
        images[img.name] = {"file": stem + ".jpg", "srgb": srgb, "px": 1024 if srgb or normal else 512}
    return images[img.name]["file"]


mats = {}
for m in bpy.data.materials:
    if not m.name.startswith("M_CN_") or not m.use_nodes:
        continue
    nt = m.node_tree
    normal_images = {l.from_node.name for l in nt.links
                     if l.to_node.bl_idname == "ShaderNodeNormalMap" and l.from_node.bl_idname == "ShaderNodeTexImage"}
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
            d["image"] = tex_name(n.image, n.name in normal_images)
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
        k = meta["px"] / max(w, h)
        if k < 1:
            img.scale(max(1, round(w * k)), max(1, round(h * k)))
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        out = bpy.data.images.new("__cn_tex", w, h, alpha=False)
        out.colorspace_settings.name = "sRGB" if meta["srgb"] else "Non-Color"
        px = px.reshape(h, w, 4); px[..., 3] = 1.0
        out.pixels.foreach_set(px.ravel())
        out.filepath_raw = os.path.join(TEX, meta["file"])
        out.file_format = "JPEG"
        out.save(quality=88)
        bpy.data.images.remove(out)
        meta["size"] = [w, h]
    finally:
        bpy.data.images.remove(img)


for name, meta in images.items():
    save(name, meta)
    del meta["px"]

with open(os.path.join(OUT, "materials.json"), "w") as f:
    json.dump({"materials": mats, "images": images}, f, separators=(",", ":"))
print("CN_MATS_OK", len(mats), "materials", len(images), "images")
result = {"materials": len(mats), "images": len(images)}
