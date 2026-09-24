"""Dump Blender's evaluated FR_* geometry (ground truth for tools/verify.ts).

For each parameter set, builds throwaway objects carrying the FR_Procedural_Building,
FR_Interior_Rooms and FR_Interior_Curtains modifiers, evaluates them and records:
  - every building instance: referenced module name + 4x4 transform
  - the realized roof-cap mesh vertices
  - the room mesh (positions + room_local / room_p1..p3 attributes)
  - the curtain mesh vertex positions
The temporary objects are removed afterwards; the scene is left as it was.

  blender --background FrenchBuilding.blend --python tools/dump_truth.py -- <out.json>
(or exec() it in a live session with OUT_PATH set)
"""
import json
import sys

import bpy
import numpy as np

if "--" in sys.argv:
    OUT = sys.argv[sys.argv.index("--") + 1]
else:
    OUT = globals()["OUT_PATH"]

# menu socket identifiers as stored on the modifier (see id_properties_ui items)
PATTERN = {"off": 2, "same": 3, "alternate": 4, "random": 5}
STYLE = {"refends": 2, "pilasters": 3, "ornamented": 4}
BALCONY = {"existing": 0, "exterior": 1}

CONFIGS = [
    dict(baysX=6, baysY=3, floors=3, dormers=True, balcony="exterior", pattern="alternate",
         style="pilasters", detailSeed=0, detailDepth=1.0, roomSeed=0, curtainSeed=0),
    dict(baysX=5, baysY=4, floors=5, dormers=False, balcony="existing", pattern="random",
         style="ornamented", detailSeed=7, detailDepth=1.5, roomSeed=5, curtainSeed=9),
    dict(baysX=2, baysY=1, floors=2, dormers=True, balcony="existing", pattern="same",
         style="refends", detailSeed=3, detailDepth=0.5, roomSeed=2, curtainSeed=1),
    dict(baysX=9, baysY=6, floors=4, dormers=True, balcony="exterior", pattern="random",
         style="refends", detailSeed=42, detailDepth=1.0, roomSeed=11, curtainSeed=4),
]


def attr_array(mesh, name, width):
    a = mesh.attributes[name]
    buf = np.empty(len(a.data) * width, dtype=np.float32)
    a.data.foreach_get("vector" if width == 3 else "value", buf)
    return buf.reshape(-1, width).tolist()


def add_nodes_object(name, group):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new("GN", "NODES")
    mod.node_group = bpy.data.node_groups[group]
    return ob, mod


def run(cfg):
    made = []
    try:
        b, bm = add_nodes_object("__truth_building", "FR_Procedural_Building")
        made.append(b)
        bm["Socket_0"] = cfg["baysX"]
        bm["Socket_1"] = cfg["baysY"]
        bm["Socket_2"] = cfg["floors"]
        bm["Socket_3"] = cfg["dormers"]
        bm["Socket_9"] = BALCONY[cfg["balcony"]]
        bm["Socket_5"] = PATTERN[cfg["pattern"]]
        bm["Socket_6"] = STYLE[cfg["style"]]
        bm["Socket_7"] = cfg["detailSeed"]
        bm["Socket_8"] = cfg["detailDepth"]
        r, rm = add_nodes_object("__truth_rooms", "FR_Interior_Rooms")
        made.append(r)
        rm["Socket_1"] = b
        rm["Socket_2"] = cfg["roomSeed"]
        rm["Socket_3"] = 4.6
        c, cm = add_nodes_object("__truth_curtains", "FR_Interior_Curtains")
        made.append(c)
        cm["Socket_1"] = b
        cm["Socket_2"] = cfg["curtainSeed"]
        cm["Socket_3"] = 0.3
        cm["Socket_4"] = 0.32
        for o in made:
            o.update_tag()
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()

        gs = b.evaluated_get(dg).evaluated_geometry()
        pc = gs.instances_pointcloud()
        refs = gs.instance_references()
        n = len(pc.points)
        ref_idx = np.empty(n, dtype=np.int32)
        pc.attributes[".reference_index"].data.foreach_get("value", ref_idx)
        mats = np.empty(n * 16, dtype=np.float32)
        pc.attributes["instance_transform"].data.foreach_get("value", mats)
        mats = mats.reshape(n, 16)  # column-major, like three.js Matrix4.elements
        instances = [{"name": refs[ref_idx[i]].name, "m": mats[i].tolist()} for i in range(n)]
        cap = [list(v.co) for v in gs.mesh.vertices] if gs.mesh else []

        rgs = r.evaluated_get(dg).evaluated_geometry()  # keep the GeometrySet alive while reading
        rmesh = rgs.mesh
        rooms = None
        if rmesh:
            rooms = {
                "position": [list(v.co) for v in rmesh.vertices],
                "room_local": attr_array(rmesh, "room_local", 3),
                "room_p1": attr_array(rmesh, "room_p1", 3),
                "room_p2": attr_array(rmesh, "room_p2", 3),
                "room_p3": attr_array(rmesh, "room_p3", 3),
            }
        cgs = c.evaluated_get(dg).evaluated_geometry()
        cmesh = cgs.mesh
        curtains = [list(v.co) for v in cmesh.vertices] if cmesh else []
        return {"config": cfg, "instances": instances, "cap": cap, "rooms": rooms, "curtains": curtains}
    finally:
        meshes = [o.data.name for o in made]
        for o in made:
            bpy.data.objects.remove(o)
        for name in meshes:  # may already be gone with its last user
            if name in bpy.data.meshes:
                bpy.data.meshes.remove(bpy.data.meshes[name])


out = [run(cfg) for cfg in CONFIGS]
with open(OUT, "w") as f:
    json.dump(out, f)
result = [{"instances": len(o["instances"]), "cap": len(o["cap"]),
           "roomVerts": len(o["rooms"]["position"]) if o["rooms"] else 0,
           "curtainVerts": len(o["curtains"])} for o in out]
print("TRUTH_OK", result)
