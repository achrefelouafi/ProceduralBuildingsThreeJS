"""Copy a building .blend into the repo's blender/ folder together with its
textures, so the shared file opens anywhere: every image file it uses is copied
to blender/textures/<set>/<file> (its ambientCG / Poly Haven set folder; loose
files go to misc/, identical files are stored once) and the copy points at
them with relative paths. The original .blend is left untouched (the copy is
saved with copy=True).

  blender --background --factory-startup FrenchBuilding.blend --python tools/collect_blend.py -- <project root>

Run it again after editing the original to refresh the shared copy.
"""
import filecmp
import os
import shutil
import sys

import bpy

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["PROJECT_ROOT"]
OUT = os.path.join(os.path.abspath(ROOT), "blender")
TEX = os.path.join(OUT, "textures")
# folders that hold loose files rather than a texture set
LOOSE = {"desktop", "textures", "documents", "downloads", "pictures", os.path.basename(os.path.expanduser("~")).lower()}

copied = reused = 0
missing = []
for img in bpy.data.images:
    if img.source != "FILE" or img.packed_file or img.library:
        continue
    src = os.path.normpath(bpy.path.abspath(img.filepath))  # relative paths resolve next to the original
    if not os.path.exists(src):
        missing.append(src)
        continue
    parent = os.path.basename(os.path.dirname(src))
    folder = "misc" if parent.lower() in LOOSE else parent
    name = os.path.basename(src)
    stem, ext = os.path.splitext(name)
    dst, k = os.path.join(TEX, folder, name), 1
    while os.path.exists(dst) and not filecmp.cmp(src, dst, shallow=False):
        dst, k = os.path.join(TEX, folder, f"{stem}_{k}{ext}"), k + 1
    if os.path.exists(dst):
        reused += 1
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    img.filepath_raw = "//" + os.path.relpath(dst, OUT).replace(os.sep, "/")  # not reloaded: only the copy uses it

others = [f"library {l.filepath}" for l in bpy.data.libraries] + [f"font {f.filepath}" for f in bpy.data.fonts
                                                                  if f.filepath and f.filepath != "<builtin>"]
dest = os.path.join(OUT, os.path.basename(bpy.data.filepath))
bpy.ops.wm.save_as_mainfile(filepath=dest, copy=True, relative_remap=False, compress=True)
for backup in (dest + "1",):
    if os.path.exists(backup):
        os.remove(backup)
print("COLLECT_OK", os.path.basename(dest), "copied", copied, "reused", reused, "missing", missing, "other external", others)
