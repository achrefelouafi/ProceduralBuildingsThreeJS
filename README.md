# ProdceduralBuildingsThreeJS

A web configurator for a procedural Haussmann-style Parisian apartment building,
ported from the geometry-nodes setup in `FrenchBuilding.blend`:

- **FR_Procedural_Building** (modifier "French Building" on `FR_Building`) and its
  **FR_Facade_Side** subgroup assemble the facade modules;
- **FR_Interior_Rooms** / **FR_Interior_Curtains** (on `FR_Rooms` / `FR_Curtains`)
  read the building's instances and add lit rooms behind the windows and voile
  curtains.

The module meshes are exported to an instanced kit (`public/assets/kit.glb`), and
all four graphs are ported to TypeScript. The port is **verified against
Blender's evaluated geometry**: instance positions match to the float32 bit, and
the roof cap, room meshes with their shader attributes, and curtains match
within 2e-4 m (`npm run verify`).

## Run

```sh
npm install
npm run dev
```

GUI folders:

- **building**: the modifier inputs, with the same names and ranges as the .blend:
  bays X / Y, floors, dormers, balcony type (Existing / Exterior), detail pattern
  (Off / Same / Alternate / Random per floor), detail style (Refends / Pilasters /
  Ornamented Panels), detail seed, detail depth.
- **interiors**: room / curtain visibility, room seed, max room depth,
  curtain seed, no-curtain and closed-curtain chances, room brightness.
- **🎬 lighting set**, **🎥 camera**, **✨ post**, **snow**, **rain**: see below.

## How the port works

| .blend | TypeScript |
| --- | --- |
| FR_Facade_Side + FR_Procedural_Building | [src/generator.ts](src/generator.ts) |
| FR_Interior_Rooms, FR_Interior_Curtains | [src/interiors.ts](src/interiors.ts) |
| Hash Value / Random Value nodes | [src/rng.ts](src/rng.ts) |
| FR_Stone, FR_StoneTrim, FR_Zinc, FR_Iron, FR_WindowFrame, FR_DoorWood, FR_Glass, FR_Interior, FR_Voile | [src/materials.ts](src/materials.ts) |

- Each side is a row of 3 m bays: a 4.2 m ground floor (door on the middle bay of
  the front), 3.2 m upper floors (continuous balcony on the 2nd floor and the top
  floor, and optionally a projecting balcony on every other window), a wall-detail
  overlay per floor, a corner pier, a cornice, and a zinc mansard with or without
  dormers. The four sides wrap a (3·bays X + 2) × (3·bays Y + 2) m footprint under
  a zinc roof cap.
- The interior graphs hash each window's **instance position** to pick its room
  photo, curtain state and so on. [src/generator.ts](src/generator.ts) therefore
  rebuilds instance matrices the way Blender does: Euler → float32 quaternion →
  matrix, and the SSE `mul_m4_m4m4` summation order, all in `Math.fround`. Without
  that, a side facade lands at y = 2.5 instead of Blender's 2.4999998 and every
  hash changes.
- The modules have no UVs: every .blend material is a world-space triplanar
  projection of an ambientCG texture set, with tint, roughness range, bump, and
  FBM grime streaks. That is re-injected into MeshStandard/MeshPhysical materials
  via `onBeforeCompile`. Blender-only shader terms (Ambient Occlusion, Bevel) are
  left out.
- FR_Interior is an emission shader: a flat-perspective lookup into a 2×5 atlas
  of apartment photos (`tex/interiors.jpg`), per-room offset, mirroring, and warm
  "lamps on" tint.

## Cinematic lighting set

The building stands on an endless studio stage: a dark asphalt floor with a
light pool around the subject, a stone sidewalk plinth, and a cyclorama backdrop
that melts into the haze ([src/studio.ts](src/studio.ts)).

- **Moods**: *Studio*, *Golden Hour*, *Blue Hour*, *Midnight Noir*,
  *Overcast*, *Storm*. Each is a complete "Look": key / fill / rim lights (color,
  intensity, azimuth, elevation, shadow softness), hemisphere bounce, IBL, facade
  uplights, room brightness, backdrop gradient + glow, height haze, bloom and
  grade. Switching moods crossfades every value, and every value is editable live
  under **🎬 lighting set**.
- **Light rig**: key (directional, 4k soft PCF shadows fitted to the building,
  long enough for a low sun), fill, a rim spot with an optional **volumetric
  beam**, hemisphere bounce, four grazing **facade uplights**, and **lightning**
  strikes while it rains.
- **Height fog**: three's fog chunks are patched with an analytic exponential
  height fog. It pools on the ground and thins towards the roof, and every
  material gets it.
- **Post** ([src/postfx.ts](src/postfx.ts)): GTAO ambient occlusion (glass,
  curtains, particles and the beam are excluded), depth of field with autofocus
  on the orbit target, bloom, ACES, and a film grade (white balance, split
  toning, contrast, saturation, chromatic aberration, vignette, grain, animated
  letterbox 1.85 / 2.39 / 2.76 : 1).
- **Camera** ([src/shots.ts](src/shots.ts)): *Hero ¾*, *Street level*,
  *Worm's-eye*, *Aerial*, *Facade detail* and *Profile* are framed from the live
  building size (and the letterbox) and flown to with an eased dolly. Also: field
  of view and auto-orbit. Grabbing the camera cancels a move.
- **Weather**: snow (flakes + accumulation shells on the building, floor and
  sidewalk) and rain (streaks + wet, puddled, rippling surfaces on the building
  and the stage) — [src/snow.ts](src/snow.ts), [src/snowAccum.ts](src/snowAccum.ts),
  [src/rain.ts](src/rain.ts), [src/wet.ts](src/wet.ts).

## Blender tooling (Blender 5.1)

Run from the project root. Every script is non-destructive, so it can also be
`exec()`'d inside a live session, e.g. through the Blender MCP; set the global
named in its docstring first.

```powershell
$blender = "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
$blend = "$HOME\Desktop\FrenchBuilding.blend"   # wherever the .blend lives

# re-export the module kit + textures after editing modules / materials in the .blend
& $blender --background $blend --python tools\export_kit.py -- .

# dump Blender's evaluated geometry for 4 parameter sets (ground truth for npm run verify)
& $blender --background $blend --python tools\dump_truth.py -- tools\truth.json

# dump the node graphs to JSON (for reviewing graph changes)
& $blender --background $blend --python tools\dump_graph.py -- graph.json
```

`export_kit.py` writes `public/assets/kit.glb` (module meshes with their material
slots) and `public/assets/tex/` (1024 px color maps, 512 px roughness +
displacement packs, and the interior atlas).

## Verifying the port against Blender

```sh
npm run verify
```

This compares the generator with `tools/truth.json` (from `dump_truth.py`) and
prints `ALL CHECKS MATCH BLENDER` when every building instance, the roof cap,
every room vertex (position + `room_local` / `room_p1..3`) and every curtain
vertex agree.
