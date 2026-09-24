"""Ground truth for the NYC evaluator: evaluate NYC_Building in Blender for a
few parameter sets and dump every leaf instance Blender renders (mesh
signature + world matrix) and the object's own realized mesh.

  blender --background NYC_CornerBuilding.blend --python tools/nyc/dump_nyc_truth.py -- tools/nyc/truth.json

Signature = "<verts>/<faces>/<material names>". Read-only: modifier values are
restored after each set.
"""
import json
import sys

import bpy

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["OUT_PATH"]

SETS = [
    {},  # the file's own modifier values
    {"Detail Level": "LOW", "Facade Seed": 7, "Building Width": 30.0, "Building Depth": 22.0, "Floor Count": 5,
     "Building Height": 0.0, "Shop Count": 3, "Corner Angle": 1.9},
    {"Detail Level": "MEDIUM", "Window Seed": 5, "Module Seed": 3, "Balcony Style": "Industrial", "Lintel Style": "Decorative",
     "Fire Escape Side": "Both", "Sign Type": "Projecting", "Custom Sign Text": "DELI 24", "Clotheslines": 3, "Clothes Density": 0.7},
    {"Escalator Enabled": True, "Shop Seed": 11, "Shop Interior Detail": 2, "Interior Mode": "Dark Rooms", "Window Style": "Casement",
     "Sash Pattern": "Grid", "Cornice Detail": 1, "Roof Seed": 4, "Vents": 8, "HVAC Units": 6, "Band Every": 2},
]

ob = bpy.data.objects["NYC_Building"]
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


def sig(me):
    mats = ",".join(sorted({m.name if m else "-" for m in me.materials})) if len(me.materials) else "-"
    return f"{len(me.vertices)}/{len(me.polygons)}/{mats}"


def r4(x):
    return round(float(x), 4)


base = read_values()
sets = []
for over in SETS:
    for k, v in over.items():
        set_value(k, v)
    ob.update_tag()
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    leaves = []
    own = None
    for inst in dg.object_instances:
        if inst.is_instance:
            if inst.parent is None or inst.parent.original != ob:
                continue
        elif inst.object.original != ob:
            continue
        o = inst.object
        if o.type != "MESH":
            continue
        me = o.data
        if not len(me.vertices):
            continue
        m = inst.matrix_world
        entry = {"sig": sig(me), "m": [r4(m[r][c]) for c in range(4) for r in range(3)]}
        if inst.is_instance:
            leaves.append(entry)
        else:
            own = entry
    sets.append({"params": read_values(), "leaves": leaves, "own": own})
    for k in over:
        set_value(k, base[k])
    print("NYC_TRUTH_SET", len(leaves), own and own["sig"])
with open(OUT, "w") as f:
    json.dump({"sets": sets}, f, separators=(",", ":"))
print("NYC_TRUTH_OK")
