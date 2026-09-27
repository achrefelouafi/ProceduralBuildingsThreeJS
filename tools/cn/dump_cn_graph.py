"""Dump the CN_ApartmentBuilding.blend geometry-node graphs for the three.js
graph evaluator (src/nyc/gn.ts). Read-only.

  blender --background CN_ApartmentBuilding.blend --python tools/cn/dump_cn_graph.py -- public/assets/cn/graph.json

Same format as tools/nyc/dump_nyc_graph.py: every CN_* GeometryNodeTree with
its interface, nodes and links (by socket index), plus the CN_Building
modifier's current values on CN_CornerApartment as "modifier".
"""
import json
import sys

import bpy

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else globals()["OUT_PATH"]

SKIP = {
    "rna_type", "location", "location_absolute", "width", "width_hidden", "height", "dimensions",
    "name", "label", "inputs", "outputs", "internal_links", "parent", "select", "show_options",
    "show_preview", "hide", "mute", "show_texture", "use_custom_color", "color", "color_tag",
    "bl_idname", "bl_label", "bl_description", "bl_icon", "bl_static_type", "bl_width_default",
    "bl_width_min", "bl_width_max", "bl_height_default", "bl_height_min", "bl_height_max",
    "type", "warning_propagation", "node_tree", "interface",
}


def val(v):
    if isinstance(v, (bool, int, float, str)) or v is None:
        return v
    if isinstance(v, bpy.types.ID):
        return {"id": type(v).__name__, "name": v.name}
    if hasattr(v, "name") and not hasattr(v, "__len__"):
        return str(v.name)
    try:
        return [val(x) for x in v]
    except TypeError:
        return str(v)


def avail(s):
    return bool(getattr(s, "enabled", True)) and not bool(getattr(s, "is_unavailable", False))


def menu_items(n):
    for attr in ("enum_definition", None):
        src = getattr(n, attr) if attr else n
        items = getattr(src, "enum_items", None)
        if items is not None:
            return [it.name for it in items]
    return None


def dump_tree(nt):
    d = {"name": nt.name, "interface": [], "nodes": [], "links": []}
    for it in nt.interface.items_tree:
        e = {"item_type": it.item_type, "name": it.name,
             "parent": it.parent.name if getattr(it, "parent", None) and it.parent.name else None}
        if it.item_type == "SOCKET":
            e.update(identifier=it.identifier, in_out=it.in_out, socket_type=it.socket_type,
                     description=it.description)
            for a in ("default_value", "min_value", "max_value", "subtype"):
                if hasattr(it, a):
                    e[a] = val(getattr(it, a))
        d["interface"].append(e)
    for n in nt.nodes:
        if n.bl_idname == "NodeFrame":
            continue
        props = {}
        for p in n.bl_rna.properties:
            if p.identifier in SKIP:
                continue
            try:
                props[p.identifier] = val(getattr(n, p.identifier))
            except Exception:
                pass
        mi = menu_items(n) if n.bl_idname == "GeometryNodeMenuSwitch" else None
        inputs = []
        for i, s in enumerate(n.inputs):
            e = {"i": i, "name": s.name, "id": s.identifier, "type": s.type, "linked": s.is_linked, "avail": avail(s)}
            if hasattr(s, "default_value"):
                try:
                    e["value"] = val(s.default_value)
                except Exception:
                    pass
            inputs.append(e)
        d["nodes"].append({
            "name": n.name, "type": n.bl_idname, "mute": n.mute,
            "group": n.node_tree.name if getattr(n, "node_tree", None) else None,
            "props": props, "menu": mi, "inputs": inputs,
            "outputs": [{"i": i, "name": s.name, "id": s.identifier, "type": s.type, "avail": avail(s)}
                        for i, s in enumerate(n.outputs)],
        })
    for l in nt.links:
        if l.is_muted or not l.is_valid:
            continue
        d["links"].append({
            "from": l.from_node.name, "fi": list(l.from_node.outputs).index(l.from_socket),
            "to": l.to_node.name, "ti": list(l.to_node.inputs).index(l.to_socket),
            "sort": getattr(l, "multi_input_sort_id", 0),
        })
    return d


trees = [dump_tree(nt) for nt in bpy.data.node_groups
         if nt.bl_idname == "GeometryNodeTree" and nt.name.startswith("CN_") and "_BACKUP_" not in nt.name]
ob = bpy.data.objects["CN_CornerApartment"]
mod = [m for m in ob.modifiers if m.type == "NODES"][0]
modifier = {}
for it in mod.node_group.interface.items_tree:
    if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.identifier in mod.keys():
        v = mod[it.identifier]
        if it.socket_type == "NodeSocketMenu":
            try:
                v = mod.id_properties_ui(it.identifier).as_dict()["items"]
                v = [x[0] for x in v if x[4] == mod[it.identifier]][0]
            except Exception:
                pass
        modifier[it.name] = val(v)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"source": bpy.data.filepath, "blender": bpy.app.version_string, "root": mod.node_group.name,
               "modifier": modifier, "trees": trees}, f, separators=(",", ":"), ensure_ascii=False)
result = [(t["name"], len(t["nodes"])) for t in trees]
print("CN_GRAPH_OK", result)
