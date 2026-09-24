"""Export the FrenchBuilding.blend module kit + textures for the Three.js port.

The FR_Facade_Side graph instances the module objects via Collection Info /
Object Info with transform_space=ORIGINAL and "Reset Children", i.e. their
local-space mesh with the object transform ignored. Every module is therefore
exported at an identity transform, in Blender Z-up coordinates (the app applies
Blender-space matrices and converts to Y-up with a rotated root group).

Non-destructive: only the selection is touched (and restored), and texture
resizing works on image copies — so it is safe to run inside a live session
(e.g. through the Blender MCP) as well as headless:

  blender --background FrenchBuilding.blend --python tools/export_kit.py -- <project root>

Outputs (relative to the project root):
  public/assets/kit.glb                      module meshes, material slots by name
  public/assets/tex/<set>_color.jpg          triplanar base color (sRGB), 1024px
  public/assets/tex/<set>_rd.png             R = roughness, G = displacement, 512px
  public/assets/tex/interiors.jpg            room atlas for FR_Interior
"""
import os
import sys

import bpy
import numpy as np

if "--" in sys.argv:
    ROOT = sys.argv[sys.argv.index("--") + 1]
else:  # live session: pass the root through a global before exec()
    ROOT = globals().get("PROJECT_ROOT") or os.getcwd()

ASSETS = os.path.join(ROOT, "public", "assets")
TEX = os.path.join(ASSETS, "tex")
os.makedirs(TEX, exist_ok=True)

MODULE_COLLECTIONS = ["FR_Ground", "FR_Upper", "FR_Corner", "FR_Roof", "FR_Trim", "FR_WallDetail"]

# material -> (texture set name, image-name prefix) for the triplanar PBR materials
TEXTURE_SETS = {
    "stone": "Concrete034_2K-JPG",
    "trim": "Plaster003_2K-JPG",
    "zinc": "Metal028_2K-JPG",
    "iron": "Metal027_2K-JPG",
    "frame": "PaintedWood006C_2K-JPG",
    "door": "PaintedWood007A_2K-JPG",
}
TEX_SIZE = 1024
RD_SIZE = 512  # roughness/displacement are low-frequency enough at half res


def export_modules() -> list[str]:
    """Export the module objects as they are. Their scene placement (the kit is
    laid out in a row at y=-16) ends up in the glTF node transforms, which the
    app discards — only the local mesh matters, exactly like ORIGINAL space."""
    prev_sel = [o for o in bpy.context.view_layer.objects if o.select_get()]
    prev_active = bpy.context.view_layer.objects.active
    mods = [o for c in MODULE_COLLECTIONS for o in bpy.data.collections[c].objects if o.type == "MESH"]
    try:
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in mods:
            o.select_set(True)
        bpy.context.view_layer.objects.active = mods[0]
        bpy.ops.export_scene.gltf(
            filepath=os.path.join(ASSETS, "kit.glb"),
            export_format="GLB",
            use_selection=True,
            export_apply=False,
            export_yup=False,           # keep Blender Z-up
            export_materials="EXPORT",  # only the material names are used; shading is rebuilt in three.js
            export_image_format="NONE",  # textures ship separately (see export_textures)
            export_attributes=False,
            export_texcoords=False,
            export_normals=True,
        )
    finally:
        for o in bpy.context.view_layer.objects:
            o.select_set(o in prev_sel)
        bpy.context.view_layer.objects.active = prev_active
    return [o.name for o in mods]


def load_pixels(img_name: str, size: tuple[int, int]) -> np.ndarray:
    """Scaled RGBA float pixels of a .blend image (works on a copy)."""
    src = bpy.data.images[img_name]
    img = src.copy()
    try:
        img.scale(*size)
        px = np.empty(size[0] * size[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        return px.reshape(size[1], size[0], 4)
    finally:
        bpy.data.images.remove(img)


def save_pixels(px: np.ndarray, path: str, fmt: str, colorspace: str) -> None:
    h, w = px.shape[:2]
    out = bpy.data.images.new("__fr_tex_out", w, h, alpha=False, float_buffer=False)
    try:
        out.colorspace_settings.name = colorspace
        out.pixels.foreach_set(px.astype(np.float32).ravel())
        out.filepath_raw = path
        out.file_format = fmt
        out.save(quality=90) if fmt == "JPEG" else out.save()
    finally:
        bpy.data.images.remove(out)


def export_textures() -> list[str]:
    written = []
    for key, prefix in TEXTURE_SETS.items():
        color = bpy.data.images[f"{prefix}_Color.jpg"]
        aspect = color.size[1] / color.size[0]
        size = (TEX_SIZE, max(1, round(TEX_SIZE * aspect)))
        c = load_pixels(f"{prefix}_Color.jpg", size)
        c[..., 3] = 1.0
        save_pixels(c, os.path.join(TEX, f"{key}_color.jpg"), "JPEG", "sRGB")
        # roughness + displacement are Non-Color in the .blend — pack into one PNG
        rd_size = (size[0] * RD_SIZE // TEX_SIZE, size[1] * RD_SIZE // TEX_SIZE)
        r = load_pixels(f"{prefix}_Roughness.jpg", rd_size)
        d = load_pixels(f"{prefix}_Displacement.jpg", rd_size)
        rd = np.zeros_like(r)
        rd[..., 0] = r[..., 0]
        rd[..., 1] = d[..., 0]
        rd[..., 3] = 1.0
        save_pixels(rd, os.path.join(TEX, f"{key}_rd.png"), "PNG", "Non-Color")
        written += [f"{key}_color.jpg", f"{key}_rd.png"]
    atlas = bpy.data.images["apartmentinterios.png"]
    a = load_pixels("apartmentinterios.png", tuple(atlas.size))
    a[..., 3] = 1.0
    save_pixels(a, os.path.join(TEX, "interiors.jpg"), "JPEG", "sRGB")
    written.append("interiors.jpg")
    return written


modules = export_modules()
textures = export_textures()
print("KIT_OK", modules, textures)
result = {"modules": modules, "textures": textures}
