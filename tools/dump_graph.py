"""Dump every geometry-nodes group in the .blend to JSON (nodes, properties,
unlinked input values, links, interface) — for reviewing graph changes before
updating src/generator.ts / src/interiors.ts. Read-only.

  blender --background FrenchBuilding.blend --python tools/dump_graph.py -- <out.json>
(or exec() it in a live session with OUT_PATH set)
"""
import json
import sys

import bpy

if "--" in sys.argv:
    OUT = sys.argv[sys.argv.index("--") + 1]
else:
    OUT = globals()["OUT_PATH"]

SKIP = {
    "rna_type", "location", "location_absolute", "width", "width_hidden", "height", "dimensions",
    "name", "label", "inputs", "outputs", "internal_links", "parent", "select", "show_options",
    "show_preview", "hide", "mute", "show_texture", "use_custom_color", "color", "color_tag",
    "bl_idname", "bl_label", "bl_description", "bl_icon", "bl_static_type", "bl_width_default",
    "bl_width_min", "bl_width_max", "bl_height_default", "bl_height_min", "bl_height_max",
    "type", "warning_propagation",
}


def val(v):
    if isinstance(v, (int, float, str, bool)) or v is None:
        return v
    if hasattr(v, "name"):
        return f"<{type(v).__name__}:{v.name}>"
    try:
        return [val(x) for x in v]
    except TypeError:
        return str(v)


def dump_tree(nt):
    d = {"name": nt.name, "interface": [], "nodes": [], "links": []}
    for it in nt.interface.items_tree:
        e = {"item_type": it.item_type, "name": it.name}
        if it.item_type == "SOCKET":
            e.update(identifier=it.identifier, in_out=it.in_out, socket_type=it.socket_type)
            for a in ("default_value", "min_value", "max_value"):
                if hasattr(it, a):
                    e[a] = val(getattr(it, a))
        d["interface"].append(e)
    for n in nt.nodes:
        props = {}
        for p in n.bl_rna.properties:
            if p.identifier not in SKIP:
                try:
                    props[p.identifier] = val(getattr(n, p.identifier))
                except Exception:
                    pass
        inputs = []
        for i, s in enumerate(n.inputs):
            e = {"i": i, "name": s.name, "id": s.identifier, "type": s.type, "linked": s.is_linked}
            if not s.enabled:
                e["disabled"] = True
            if hasattr(s, "default_value") and not s.is_linked:
                e["value"] = val(s.default_value)
            inputs.append(e)
        d["nodes"].append({
            "name": n.name, "type": n.bl_idname, "label": n.label,
            "parent": n.parent.name if n.parent else None,
            "group": n.node_tree.name if getattr(n, "node_tree", None) else None,
            "props": props, "inputs": inputs,
            "outputs": [{"i": i, "name": s.name, "id": s.identifier} for i, s in enumerate(n.outputs) if s.enabled],
        })
    for link in nt.links:
        d["links"].append({
            "from": link.from_node.name, "fsn": link.from_socket.name,
            "to": link.to_node.name, "ts": link.to_socket.identifier, "tsn": link.to_socket.name,
            "muted": link.is_muted,
        })
    return d


trees = [dump_tree(nt) for nt in bpy.data.node_groups if nt.bl_idname == "GeometryNodeTree"]
with open(OUT, "w") as f:
    json.dump({"trees": trees}, f, indent=1)
result = [(t["name"], len(t["nodes"])) for t in trees]
print("GRAPH_OK", result)
