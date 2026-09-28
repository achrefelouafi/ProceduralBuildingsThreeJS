"""Blender side of the 3-second hook: Blender's own UI while the geometry-nodes
inputs of the three buildings change, captured frame by frame at 60 fps.

blender blender/NYC_CornerBuilding.blend --factory-startup --window-geometry 0 -1080 1920 1080 \
    --python tools/video/blender_record.py -- <frames_dir> [--stills t,t,...]

The Paris and Chinese buildings are appended next to New York (Paris | New
York | 中国, as in the three.js split). The Layout workspace becomes: Material
Preview viewport on the three buildings, a Geometry Node editor below (the
active building's graph), the modifier panel on the right. A timer then sets
every input for frame f, re-evaluates, redraws the window a few times (EEVEE
accumulates samples) and saves a window screenshot as <frames_dir>/NNNN.png —
evaluation time never shows in the video. The active object (its modifier panel
and node graph on screen) moves from Paris to New York to 中国, one per second.
Blender quits when done; `layout.json` next to the frames records where the
edited fields are, for the compositor's cursor.
"""
import bpy, json, math, os, sys

args = sys.argv[sys.argv.index("--") + 1:]
OUT = args[0]
STILLS = [float(x) for x in args[args.index("--stills") + 1].split(",")] if "--stills" in args else None
FPS, DUR = 60, 3.0
N = round(FPS * DUR)
REDRAWS = 6
HERE = os.path.dirname(bpy.data.filepath)
os.makedirs(OUT, exist_ok=True)
bpy.context.preferences.use_preferences_save = False
rad = math.radians


def lin(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


# ------------------------------------------------------------------ scene

def append(file, names):
    with bpy.data.libraries.load(os.path.join(HERE, file), link=False) as (src, dst):
        dst.objects = [n for n in names if n in src.objects]
    coll = bpy.data.collections.new(file.replace(".blend", ""))
    bpy.context.scene.collection.children.link(coll)
    for o in dst.objects:
        coll.objects.link(o)
    return list(dst.objects)


FR_PARTS = append("FrenchBuilding.blend", ["FR_Building", "FR_Rooms", "FR_Curtains", "FR_Sidewalk", "FR_Curb"])
append("CN_ApartmentBuilding.blend", ["CN_CornerApartment"])
OBJ = {"FR": bpy.data.objects["FR_Building"], "NY": bpy.data.objects["NYC_Building"], "CN": bpy.data.objects["CN_CornerApartment"]}
for o in FR_PARTS:
    o.location.x = -62
OBJ["NY"].location.x = -14
OBJ["CN"].location.x = 30
for o in bpy.data.objects:
    if o.type in {"CAMERA", "LIGHT"}:
        o.hide_set(True)


def socket(obj, name):
    m = next(m for m in obj.modifiers if m.type == "NODES")
    for it in m.node_group.interface.items_tree:
        if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.name == name:
            return m, it.identifier
    raise KeyError(f"{obj.name}: {name}")


# ------------------------------------------------------------------ timeline
# (building, input, keys); key = (t, value, how), how: "cut" or an ease from the previous key

EASE = {"lin": lambda x: x, "io": lambda x: x * x * x * (x * (x * 6 - 15) + 10)}
TINTS = [lin("#f2c9c0"), lin("#cfe6d6"), lin("#f6e3a8"), lin("#f3d6cc")]
TRACKS = [
    # second 1: everything grows (the panel shows Paris)
    ("FR", "Floors", [(0, 2, "cut"), (0.04, 2, "cut"), (0.8, 9, "lin")]),
    ("NY", "Floor Count", [(0, 5, "cut"), (0.04, 5, "cut"), (0.8, 12, "lin")]),
    ("CN", "Floors", [(0, 4, "cut"), (0.04, 4, "cut"), (0.8, 11, "lin")]),
    # second 2: footprints (the panel shows New York)
    ("NY", "Corner Angle", [(0, rad(90), "cut"), (1.08, rad(90), "cut"), (1.85, rad(60), "io")]),
    ("FR", "Bays X", [(0, 5, "cut"), (1.08, 5, "cut"), (1.85, 9, "lin")]),
    ("CN", "Width", [(0, 18.0, "cut"), (1.08, 18.0, "cut"), (1.85, 26.0, "io")]),
    # second 3: the Chinese facade (the panel shows 中国)
    ("CN", "Depth", [(0, 13.0, "cut"), (2.08, 13.0, "cut"), (2.8, 20.0, "io")]),
    ("CN", "Wall Tint", [(0, [1.0, 1.0, 1.0, 1.0], "cut")] + [(2.1 + i * 0.22, c, "cut") for i, c in enumerate(TINTS)]),
    ("NY", "AC Probability", [(0, 0.15, "cut"), (2.08, 0.15, "cut"), (2.8, 1.0, "io")]),
    ("FR", "Detail Depth", [(0, 1.0, "cut"), (2.08, 1.0, "cut"), (2.8, 2.6, "io")]),
]
INTS = {"Floors", "Floor Count", "Bays X"}
FIXED = [("NY", "Building Height", 0.0), ("NY", "Building Width", 26.0), ("NY", "Building Depth", 18.0)]
ACTIVE = [(0.0, "FR"), (1.0, "NY"), (2.0, "CN")]
# the French sidewalk + curb follow Bays X / Y through their own inputs
FOLLOW = {("FR", "Bays X"): [(bpy.data.objects["FR_Sidewalk"], "Bays X"), (bpy.data.objects["FR_Curb"], "Bays X")]}
# the state that makes every material appear once, so its shaders compile before recording
WARM = [("CN", "Balcony Probability", 1.0), ("CN", "Lit Window Probability", 1.0), ("NY", "AC Probability", 1.0),
        ("NY", "Balcony Probability", 1.0), ("CN", "Wall Tint", TINTS[0])]


def value(keys, t):
    i = 0
    while i + 1 < len(keys) and keys[i + 1][0] <= t:
        i += 1
    if i + 1 < len(keys) and keys[i + 1][2] != "cut" and isinstance(keys[i][1], (int, float)):
        (ta, va, _), (tb, vb, how) = keys[i], keys[i + 1]
        x = min(max((t - ta) / (tb - ta), 0), 1)
        return va + (vb - va) * EASE[how](x)
    return keys[i][1]


applied = {}


def put(key, obj, name, v):
    if name in INTS:
        v = int(round(v))
    if applied.get((obj.name, name)) == v:
        return False
    m, ident = socket(obj, name)
    m[ident] = v
    obj.update_tag()
    applied[(obj.name, name)] = v
    for o2, n2 in FOLLOW.get(key, []):
        m2, i2 = socket(o2, n2)
        m2[i2] = v
        o2.update_tag()
    return True


def set_time(t):
    changed = False
    for b, name, keys in TRACKS:
        changed |= put((b, name), OBJ[b], name, value(keys, t))
    active = [b for (ta, b) in ACTIVE if ta <= t][-1]
    vl = bpy.context.view_layer
    if vl.objects.active != OBJ[active]:
        for o in vl.objects:
            o.select_set(False)
        OBJ[active].select_set(True)
        vl.objects.active = OBJ[active]
        st["frame_nodes"] = active
    if changed:
        vl.update()


# ------------------------------------------------------------------ layout

WIN = bpy.context.window_manager.windows[0]


def areas(kind):
    return [a for a in WIN.screen.areas if a.type == kind]


def region(area, kind="WINDOW"):
    return next(r for r in area.regions if r.type == kind)


# the node-editor framing per building: the whole Paris graph; a dense
# cluster of the big machine-laid New York / Chinese graphs (tall group
# nodes left out of the fit), in node-space (x0, x1, y_top, y_bottom)
NODE_VIEW = {"FR": None, "NY": (1200, 4200, 0, -1050), "CN": (0, 3000, 0, -1050)}


def frame_nodes(b):
    """frame the (new) active building's graph; the editor shows that graph only after a redraw"""
    for a in areas("NODE_EDITOR"):
        tree = a.spaces[0].edit_tree
        with bpy.context.temp_override(window=WIN, area=a, region=region(a)):
            box = NODE_VIEW[b]
            if tree is None:
                continue
            if box is None:
                bpy.ops.node.view_all()
                for n in tree.nodes:
                    n.select = False
                continue
            x0, x1, y0, y1 = box
            for n in tree.nodes:
                n.select = x0 <= n.location.x <= x1 and y1 <= n.location.y <= y0 and len(n.inputs) + len(n.outputs) < 40
            bpy.ops.node.view_selected()
            for n in tree.nodes:
                n.select = False


def drift():
    """the UI never sits still: the node editor pans slowly"""
    for a in areas("NODE_EDITOR"):
        with bpy.context.temp_override(window=WIN, area=a, region=region(a)):
            try:
                bpy.ops.view2d.pan(deltax=-1, deltay=0)
            except RuntimeError:
                pass


def layout():
    prefs = bpy.context.preferences
    prefs.view.ui_scale = 1.1
    prefs.view.show_splash = False
    # the real mouse may rest over the window: no tooltips popping up in the capture
    prefs.view.show_tooltips = False
    prefs.view.show_tooltips_python = False
    # the Geometry Nodes workspace without its spreadsheet and timeline: a
    # full-width viewport on top, the node editor below, properties on the right
    # (areas can't be resized from a script: area_move needs the mouse)
    for kind in ("SPREADSHEET", "DOPESHEET_EDITOR"):
        for a in areas(kind):
            with bpy.context.temp_override(window=WIN, screen=WIN.screen, area=a):
                bpy.ops.screen.area_close()
    view = areas("VIEW_3D")[0]
    for a in areas("PROPERTIES"):
        a.spaces[0].context = "MODIFIER"
    s = view.spaces[0]
    s.shading.type = "MATERIAL"
    s.shading.use_scene_world = False
    s.shading.studio_light = "city.exr"
    s.shading.studiolight_intensity = 1.2
    s.overlay.show_extras = False
    s.overlay.show_outline_selected = False
    s.shading.studiolight_background_alpha = 0.85
    s.shading.studiolight_background_blur = 0.6
    s.overlay.show_floor = False
    s.overlay.show_axis_x = s.overlay.show_axis_y = False
    s.lens = 38
    r3d = s.region_3d
    r3d.view_perspective = "PERSP"
    orbit(0.0)
    for a in WIN.screen.areas:
        print(f"AREA {a.type:16s} x={a.x} y={a.y} w={a.width} h={a.height}")


def orbit(t):
    """a slow drift of the viewport across the three buildings"""
    import mathutils
    x = t / DUR
    r3d = areas("VIEW_3D")[0].spaces[0].region_3d
    r3d.view_perspective = "PERSP"
    r3d.view_location = (-4.0 + 3.0 * x, 6.0, 15.5)
    r3d.view_rotation = mathutils.Euler((rad(81.5), 0, rad(-9 + 5 * x))).to_quaternion()
    r3d.view_distance = 112 - 8 * x


def redraw(n=REDRAWS):
    with bpy.context.temp_override(window=WIN):
        bpy.ops.wm.redraw_timer(type="DRAW_WIN_SWAP", iterations=n)


def compiling():
    return bpy.app.is_job_running("SHADER_COMPILATION")


def shot(path):
    with bpy.context.temp_override(window=WIN):
        bpy.ops.screen.screenshot(filepath=path)


# ------------------------------------------------------------------ run (a timer state machine)

st = {"phase": "fullscreen", "f": 0, "wait": 0}


def step():
    ph = st["phase"]
    if ph == "fullscreen":
        with bpy.context.temp_override(window=WIN):
            bpy.ops.wm.window_fullscreen_toggle()
            bpy.context.window.workspace = bpy.data.workspaces["Geometry Nodes"]
        st["phase"] = "layout"
        return 1.0
    if ph == "layout":
        print("WINDOW", WIN.width, WIN.height)
        layout()
        for b, name, v in FIXED:
            put((b, name), OBJ[b], name, v)
        for b, name, v in WARM:
            m, ident = socket(OBJ[b], name)
            orig = m[ident]
            st.setdefault("orig", []).append((b, name, orig.to_list() if hasattr(orig, "to_list") else orig))
            put((b, name), OBJ[b], name, v)
        bpy.context.view_layer.update()
        st["phase"] = "warm"
        return 0.5
    if ph == "warm":
        redraw(2)
        if compiling() or st["wait"] < 6:
            st["wait"] += 0 if compiling() else 1
            return 0.5
        applied.clear()
        for b, name, v in st["orig"] + FIXED:
            put((b, name), OBJ[b], name, v)
        st["phase"] = "record"
        return 0.1
    if ph == "record":
        frames = STILLS if STILLS else [f / FPS for f in range(N)]
        f = st["f"]
        if f >= len(frames):
            with open(os.path.join(OUT, "layout.json"), "w") as fh:
                json.dump({"window": [WIN.width, WIN.height], "areas": [
                    {"type": a.type, "x": a.x, "y": a.y, "w": a.width, "h": a.height} for a in WIN.screen.areas]}, fh)
            bpy.ops.wm.quit_blender()
            return None
        t = frames[f]
        set_time(t)
        b = st.pop("frame_nodes", None)
        if b:
            redraw(1)
            frame_nodes(b)
        elif not STILLS:
            drift()
        orbit(t)
        redraw()
        if compiling():
            return 0.2  # a new material appeared: let it compile, then redraw this frame
        name = f"still_{t:.2f}.png" if STILLS else f"{f:04d}.png"
        shot(os.path.join(OUT, name))
        st["f"] += 1
        if f % 30 == 0:
            print(f"frame {f}/{len(frames)}", flush=True)
        return 0.0
    return None


def safe_step():
    try:
        return step()
    except Exception:
        import traceback
        traceback.print_exc()
        bpy.ops.wm.quit_blender()
        return None


bpy.app.timers.register(safe_step, first_interval=1.0)
