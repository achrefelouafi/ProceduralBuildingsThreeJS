import {
  ACESFilmicToneMapping, BufferAttribute, BufferGeometry, Color, Group, Material, Mesh, type Object3D,
  PerspectiveCamera, Scene, SRGBColorSpace, Timer, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import GUI from "lil-gui";
import { buildingSize, defaultParams, type BuildingParams } from "./params";
import { generateBuilding } from "./generator";
import { generateCurtains, generateRooms } from "./interiors";
import { createMaterials, type BuildingMaterials } from "./materials";
import { Kit } from "./kit";
import { SIDEWALK, SIDEWALK_MARGIN, Studio, type Mood, type StageBounds, type StageSides } from "./studio";
import type { Flavor } from "./city/city";
import { LETTERBOX, PostFX, type Letterbox } from "./postfx";
import { frameShot, SHOTS, ShotDirector, type Shot } from "./shots";
import { createSnow } from "./snow";
import { createSnowAccumUniforms, createSnowShellMaterial } from "./snowAccum";
import { createRain } from "./rain";
import { createWetUniforms, applyWet } from "./wet";
import { NycBuilding, type GraphBuilding } from "./nyc/building";
import { CnBuilding } from "./cn/building";
import { disposeNycGroup } from "./nyc/render";
import { nycSpace } from "./nyc/shadergraph";
import { BusyPill, nextFrame, Preloader, trackNetwork } from "./preloader";
import { FrenchStreet } from "./street";
import { ContactCard } from "./contact";

// the loading screen is up from the first frame (index.html); the app fills it in
const preloader = new Preloader();
const busy = new BusyPill();
const contact = new ContactCard();

const app = document.getElementById("app")!;
const renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" }); // MSAA lives in the composer
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new Scene();

const camera = new PerspectiveCamera(32, innerWidth / innerHeight, 0.2, 1000);
camera.position.set(30, 10, 45);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.51; // stay above the stage floor
controls.minDistance = 2;
controls.maxDistance = 300;

// cinematic post: GTAO → DoF → tone map → film grade
const post = new PostFX(renderer, scene, camera);
// the lighting set: backdrop, stage, light rig, height fog, moods
const studio = new Studio(scene, renderer, post);
const director = new ShotDirector(camera, controls);
controls.addEventListener("start", () => director.stop()); // grabbing the camera cancels a move

// Blender is Z-up: the generator works in Blender space inside a rotated root,
// standing on the sidewalk plinth
const root = new Group();
root.rotation.x = -Math.PI / 2;
root.position.y = SIDEWALK;
scene.add(root);

const params: BuildingParams = defaultParams();
// which building is on the stage: the French (Haussmann) port, or a building
// evaluated live from its Blender graph — the New York corner building
// (NYC_CornerBuilding.blend, src/nyc/) or the Chinese apartment building
// (CN_ApartmentBuilding.blend, src/cn/)
type BuildingKind = "French" | "New York" | "Chinese";
type GraphKind = Exclude<BuildingKind, "French">;
const which = { building: "French" as BuildingKind };
const graphLoaders: Record<GraphKind, (base: string) => Promise<GraphBuilding>> = {
  "New York": base => NycBuilding.load(base),
  Chinese: base => CnBuilding.load(base),
};
const graphs: Partial<Record<GraphKind, GraphBuilding>> = {};
const graphLoading: Partial<Record<GraphKind, Promise<GraphBuilding>>> = {};
/** the graph building on the stage, if the selection is one and it is loaded */
const currentGraph = (): GraphBuilding | null => (which.building === "French" ? null : graphs[which.building] ?? null);
/** the city's architecture follows the building */
const FLAVOR: Record<BuildingKind, Flavor> = { French: "paris", "New York": "nyc", Chinese: "asia" };
/** each city's accent (the videos' own, tools/video/stories.mjs): the contact card takes it */
const ACCENT: Record<BuildingKind, string> = { French: "#e2c08d", "New York": "#ff7a45", Chinese: "#ff4d4d" };
/** stage / shot bounds of the building currently shown (+ where its sidewalk ends) */
function currentSize(): StageBounds {
  const g = currentGraph();
  // the building's own sidewalk (+ curb): the stage paves only the sides it leaves bare
  const own = which.building === "French" ? frenchSidewalk() : g?.sidewalk();
  return {
    ...(g?.size() ?? buildingSize(params)),
    margin: own?.width ?? SIDEWALK_MARGIN, ownSidewalk: own?.sides, flavor: FLAVOR[which.building],
  };
}
const view = { interiors: true, curtains: true };
let mats: BuildingMaterials;
let kit: Kit;
/** the French building's sidewalk + curb (FR_Sidewalk / FR_Curb); null: not loaded, the stage plinth stands in */
let street: FrenchStreet | null = null;
const ALL_SIDES: StageSides = { front: true, back: true, left: true, right: true };
const frenchSidewalk = () => (street ? { width: street.reach, sides: ALL_SIDES } : null);
let building: Group | null = null;

// ---- snow: falling flakes (world space) + accumulation shell on the building ----
const snowShared = { uTime: { value: 0 }, uWind: { value: new Vector3(2, 0, 1) } };
const accumU = createSnowAccumUniforms(snowShared.uTime);
const snowShellMaterial = createSnowShellMaterial(accumU);
const snow = createSnow({ camera, shared: snowShared });
snow.mesh.visible = false;
snow.material.depthTest = false; // draw flakes over the building instead of being occluded
snow.mesh.renderOrder = 10;
snow.mesh.userData.noAO = true;
scene.add(snow.mesh);
studio.envHide.push(root, snow.mesh);

const snowState = { enabled: false, density: 0.5 };
const wind = { strength: 2, direction: 20 };
function applyWind(): void {
  const a = (wind.direction * Math.PI) / 180;
  snowShared.uWind.value.set(Math.cos(a) * wind.strength, 0, Math.sin(a) * wind.strength);
}
applyWind();
function applySnowEnabled(v: boolean): void {
  // snow and rain are mutually exclusive — turning one on turns the other off
  if (v && rainState.enabled) {
    rainState.enabled = false;
    applyRainEnabled(false);
  }
  snow.mesh.visible = v;
  const shell = building?.getObjectByName("snowShell");
  if (shell) shell.visible = v;
  studio.snowShell.visible = v; // floor + sidewalk caps
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

// ---- rain: falling streaks (world space) + in-place wet accumulation on the ----
// building + stage materials (the wet shader is injected into the materials)
const rainShared = { uTime: { value: 0 }, uWind: { value: new Vector3(3, 0, 1) }, uLightning: { value: 0 } };
const wetU = createWetUniforms(rainShared.uTime, rainShared.uWind);
const rain = createRain({ camera, shared: rainShared });
rain.mesh.visible = false;
rain.material.depthTest = false;
rain.mesh.renderOrder = 10;
rain.mesh.userData.noAO = true;
scene.add(rain.mesh);
studio.envHide.push(rain.mesh);

const rainState = { enabled: false, density: 0.4 };
const rainWind = { strength: 3, direction: 20 };
function applyRainWind(): void {
  const a = (rainWind.direction * Math.PI) / 180;
  rainShared.uWind.value.set(Math.cos(a) * rainWind.strength, 0, Math.sin(a) * rainWind.strength);
}
applyRainWind();
function applyRainEnabled(v: boolean): void {
  if (v && snowState.enabled) {
    snowState.enabled = false;
    applySnowEnabled(false);
  }
  rain.mesh.visible = v;
  wetU.uWet.value = v ? 1 : 0; // master gate: everything dries out when rain is off
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

function meshFrom(attrs: Record<string, number[]>, index: number[], material: Material): Mesh {
  const g = new BufferGeometry();
  for (const [name, data] of Object.entries(attrs)) g.setAttribute(name, new BufferAttribute(new Float32Array(data), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return new Mesh(g, material);
}

/** zinc roof cap (the Cone frustum): 4 sloped sides + top, flat shaded */
function roofCap(cap: number[][]): Mesh {
  const [t0, t1, t2, t3, b0, b1, b2, b3] = cap;
  const quads = [[b0, b1, t1, t0], [b1, b2, t2, t1], [b2, b3, t3, t2], [b3, b0, t0, t3], [t0, t1, t2, t3]];
  const pos: number[] = [];
  for (const [a, b, c, d] of quads) pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  const mesh = new Mesh(g, mats.byName.get("FR_Zinc")!);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function disposeBuilding(g: Group): void {
  if (g.name === "nycBuilding") disposeNycGroup(g);
  const walk = g.getObjectByName("frStreet");
  if (walk) disposeNycGroup(walk as Group);
  g.traverse(o => {
    const im = o as { isInstancedMesh?: boolean; dispose?: () => void };
    if (im.isInstancedMesh) im.dispose?.();
    else if ((o as Mesh).isMesh && o.parent?.name !== "snowShell") (o as Mesh).geometry.dispose();
  });
}

/** the French building for the GUI values (Blender space, centred on the stage) */
function buildFrench(): Group {
  const b = generateBuilding(params);
  const g = kit.buildGroup(b.instances);
  // the .blend building spans x ∈ [0, W], y ∈ [0, L] — center it on the stage
  g.position.set(-b.width / 2, -b.length / 2, 0);

  // zinc roof cap + its snow shell (shares geometry, extruded by the snow shader)
  const cap = roofCap(b.cap);
  g.add(cap);
  const shell = g.getObjectByName("snowShell");
  shell?.add(new Mesh(cap.geometry, snowShellMaterial));

  // its own sidewalk + granite curb (same Blender space); their snow caps join the building's
  if (street) {
    const walk = street.build(params.baysX, params.baysY, snowShellMaterial);
    const walkShell = walk.getObjectByName("snowShell");
    if (walkShell && shell) {
      walk.remove(walkShell);
      shell.add(...walkShell.children);
    }
    g.add(walk);
  }

  // interiors: emissive room boxes behind the glass + voile curtains
  const r = generateRooms(b.instances, params);
  const rooms = meshFrom(
    { position: r.position, room_local: r.roomLocal, room_p1: r.p1, room_p2: r.p2, room_p3: r.p3 },
    r.index, mats.interior,
  );
  rooms.name = "rooms";
  g.add(rooms);
  const c = generateCurtains(b.instances, params);
  const curtains = meshFrom({ position: c.position }, c.index, mats.voile);
  curtains.name = "curtains";
  curtains.renderOrder = 1; // behind the glass (renderOrder 2)
  curtains.receiveShadow = true; // opaque cloth: takes shadows + AO like the facade
  g.add(curtains);
  return g;
}

/** evaluate a graph building (New York / Chinese) with its GUI values; null if the graph fails */
function buildGraph(kind: GraphKind, n: GraphBuilding): Group | null {
  const t0 = performance.now();
  let g: Group;
  try {
    g = n.build(snowShellMaterial);
  } catch (err) {
    console.error(`${kind} building evaluation failed:`, err);
    return null;
  }
  // the corner sits at the Blender origin — centre the footprint on the stage
  const c = n.center();
  g.position.set(-c.x, -c.y, 0);
  console.info(`${kind} building: ${(performance.now() - t0).toFixed(0)} ms`);
  return g;
}

/**
 * Built buildings, one per kind, kept for as long as their values don't change:
 * switching building types swaps groups on the stage instead of re-evaluating
 * (a graph building takes 0.4–2 s to evaluate).
 */
const built = new Map<BuildingKind, { key: string; group: Group }>();
const paramsKey = (kind: BuildingKind) => JSON.stringify(kind === "French" ? params : graphs[kind]?.params ?? null);
/** the building of this kind is built for its current values (switching to it is instant) */
const isBuilt = (kind: BuildingKind) => built.get(kind)?.key === paramsKey(kind);

/** the building of this kind for its current values: cached, or built now */
function builtFor(kind: BuildingKind): Group | null {
  const hit = built.get(kind);
  const key = paramsKey(kind);
  if (hit?.key === key) return hit.group;
  const graph = kind === "French" ? null : graphs[kind];
  if (kind !== "French" && !graph) return null; // not loaded yet
  const g = graph ? buildGraph(kind as GraphKind, graph) : buildFrench();
  if (!g) return null;
  if (hit) {
    if (hit.group === building) {
      root.remove(hit.group);
      building = null;
    }
    disposeBuilding(hit.group);
  }
  built.set(kind, { key, group: g });
  return g;
}

/** put the selected building on the stage (rebuilding it only if its values changed) */
function regenerate(): void {
  const g = builtFor(which.building);
  if (building && building !== g) root.remove(building);
  building = g;
  if (!g) return;
  if (g.parent !== root) root.add(g);
  // Blender space of the building on the stage (the graph materials: New York, Chinese, the French street)
  g.updateMatrixWorld(true);
  nycSpace.uNycFromWorld.value.copy(g.matrixWorld).invert();
  nycSpace.uNycNormalToWorld.value.setFromMatrix4(g.matrixWorld);
  if (!currentGraph()) {
    setVisible("rooms", view.interiors);
    setVisible("curtains", view.curtains);
  }
  applySnowEnabled(snowState.enabled); // a new snowShell group starts hidden
  studio.frame(currentSize()); // plinth, light rig + shadow frustum, the city around it
}

let viewW = 0, viewH = 0; // last applied viewport size (see fitViewport)

// ---- camera / lens ----
const cam = {
  shot: "Hero ¾" as Shot,
  autoOrbit: true,
  orbitSpeed: 0.35,
  fov: 32,
  letterbox: "off" as Letterbox,
  dof: false,
  autofocus: true,
  aperture: 0.0008,
  maxBlur: 0.008,
  chroma: 0,
};
controls.autoRotate = cam.autoOrbit;
controls.autoRotateSpeed = cam.orbitSpeed;
post.letterbox = LETTERBOX[cam.letterbox];
post.gradeUniforms["uChroma"].value = cam.chroma;

function goShot(shot: Shot, seconds = 2.4): void {
  cam.shot = shot;
  const lb = LETTERBOX[cam.letterbox];
  const aspect = viewW && viewH ? viewW / viewH : 16 / 9; // hidden viewport: assume 16:9
  const visible = lb > 0 ? Math.min(1, aspect / lb) : 1;
  const f = frameShot(shot, currentSize(), visible);
  cam.fov = f.fov;
  director.go(f, seconds);
}

// ---- GUI ----
const gui = new GUI({ title: "procedural buildings · lighting set" });
gui.add(which, "building", ["French", "New York", "Chinese"]).name("🏙 building").onChange(() => void switchBuilding());

// the FR_Procedural_Building modifier inputs (same names / ranges as the .blend)
const fBuild = gui.addFolder("building");
fBuild.add(params, "baysX", 1, 20, 1).name("bays X");
fBuild.add(params, "baysY", 1, 20, 1).name("bays Y");
fBuild.add(params, "floors", 2, 12, 1).name("floors");
fBuild.add(params, "dormers").name("dormers");
fBuild.add(params, "balcony", { Existing: "existing", Exterior: "exterior" }).name("balcony type");
fBuild.add(params, "detailPattern", {
  Off: "off", "Same on All Floors": "same", "Alternate per Floor": "alternate", "Random per Floor": "random",
}).name("detail pattern");
fBuild.add(params, "detailStyle", {
  "Refends (Banded Ashlar)": "refends", Pilasters: "pilasters", "Ornamented Panels": "ornamented",
}).name("detail style");
fBuild.add(params, "detailSeed", 0, 100, 1).name("detail seed");
fBuild.add(params, "detailDepth", 0, 3, 0.01).name("detail depth");
fBuild.onChange(() => regenerate());

// the FR_Interior_Rooms / FR_Interior_Curtains modifier inputs
const setVisible = (name: string, v: boolean) => {
  const o = building?.getObjectByName(name);
  if (o) o.visible = v;
};
const fInt = gui.addFolder("interiors");
fInt.add(view, "interiors").name("rooms").onChange((v: boolean) => setVisible("rooms", v));
fInt.add(view, "curtains").name("curtains").onChange((v: boolean) => setVisible("curtains", v));
fInt.add(params, "roomSeed", 0, 100, 1).name("room seed").onChange(() => regenerate());
fInt.add(params, "maxDepth", 1, 12, 0.1).name("max depth").onChange(() => regenerate());
fInt.add(params, "curtainSeed", 0, 100, 1).name("curtain seed").onChange(() => regenerate());
fInt.add(params, "noCurtainChance", 0, 1, 0.01).name("no curtain chance").onChange(() => regenerate());
fInt.add(params, "closedChance", 0, 1, 0.01).name("closed chance").onChange(() => regenerate());
fInt.close();

// the graph buildings' modifier inputs — filled from each graph's interface once loaded
const graphFolders: Record<GraphKind, GUI> = {
  "New York": gui.addFolder("building · New York"),
  Chinese: gui.addFolder("building · Chinese"),
};
for (const f of Object.values(graphFolders)) f.hide();

/** a graph building re-evaluates on the main thread: show the pill while it does */
const reevaluate = (kind: GraphKind) => busy.run(`${kind} · evaluating the graph…`, regenerate);

function buildGraphGui(kind: GraphKind, n: GraphBuilding, folder: GUI): void {
  const folders = new Map<string, GUI>();
  let timer = 0;
  const regen = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void reevaluate(kind), 30);
  };
  const DEG = 180 / Math.PI;
  for (const i of n.inputs) {
    let f = folders.get(i.panel);
    if (!f) {
      f = folder.addFolder(i.panel || "general");
      if (folders.size) f.close();
      folders.set(i.panel, f);
    }
    const bounded = i.min !== undefined && i.max !== undefined && Math.abs(i.min) < 1e6 && Math.abs(i.max) < 1e6;
    let c;
    if (i.type === "menu") c = f.add(n.params, i.name, i.options ?? []);
    else if (i.type === "bool" || i.type === "string") c = f.add(n.params, i.name);
    else if (i.type === "color") {
      // Blender colors are linear; the picker shows sRGB (three's Color converts)
      const col = new Color();
      const rgba = () => n.params[i.name] as number[];
      const proxy = {
        get hex() { return "#" + col.setRGB(rgba()[0], rgba()[1], rgba()[2]).getHexString(); },
        set hex(h: string) { col.set(h); n.params[i.name] = [col.r, col.g, col.b, rgba()[3] ?? 1]; },
      };
      c = f.addColor(proxy, "hex").name(i.name).listen();
    } else if (i.subtype === "ANGLE" && bounded) {
      const proxy = { v: Number(n.params[i.name]) * DEG };
      c = f.add(proxy, "v", i.min! * DEG, i.max! * DEG, 0.5).name(`${i.name} °`)
        .onChange((v: number) => (n.params[i.name] = v / DEG));
      c.listen();
    } else if (bounded) {
      const range = i.max! - i.min!;
      const step = i.type === "int" ? 1 : range <= 0.1 ? 0.001 : range <= 5 ? 0.01 : 0.05;
      c = f.add(n.params, i.name, i.min, i.max, step);
    } else {
      c = f.add(n.params, i.name).step(i.type === "int" ? 1 : 0.01); // seeds: free number fields
    }
    c.onFinishChange(regen);
    const note = i.type === "string" ? "characters without an exported glyph are left out" : "";
    if (i.description || note) c.domElement.title = [i.description, note].filter(Boolean).join(" · ");
  }
  folder.add({
    reset: () => {
      Object.assign(n.params, n.defaults());
      folder.controllersRecursive().forEach(c => c.updateDisplay());
      void reevaluate(kind);
    },
  }, "reset").name("↺ reset to .blend values");
}

/** load a graph building's data once: compile + wet its materials, fill its GUI */
async function prepareGraph(kind: GraphKind): Promise<GraphBuilding> {
  const b = await (graphLoading[kind] ??= graphLoaders[kind]("assets/"));
  if (!graphs[kind]) {
    // rain soaks its surfaces too (glass stays as is)
    for (const m of b.materials.values()) if (!m.transparent) applyWet(m.material, wetU);
    buildGraphGui(kind, b, graphFolders[kind]);
    graphs[kind] = b;
  }
  return b;
}

/**
 * swap the building on the stage. Everything is preloaded and prebuilt at
 * startup, so this is a swap; a graph building that failed to preload, or
 * whose values changed, loads / evaluates here.
 */
async function switchBuilding(): Promise<void> {
  const kind = which.building;
  contact.setAccent(ACCENT[kind]);
  fBuild.show(kind === "French");
  fInt.show(kind === "French");
  for (const [k, f] of Object.entries(graphFolders)) f.show(k === kind);
  if (kind !== "French" && !graphs[kind]) {
    busy.show(`loading the ${kind} building…`);
    try {
      await prepareGraph(kind);
    } catch (err) {
      console.error(err);
      busy.show(`failed to load the ${kind} building: ${err}`);
      return;
    }
    busy.hide();
    if (which.building !== kind) return; // switched away while loading
  }
  if (!warmDone.has(kind)) {
    // its shaders are still compiling in the background: wait for them (not a frozen frame)
    busy.show(`${kind} · preparing shaders…`);
    await nextFrame();
    await warm(kind);
    busy.hide();
    if (which.building !== kind) return;
  }
  if (kind === "French" || isBuilt(kind)) regenerate();
  else await reevaluate(kind);
  goShot(cam.shot);
}

// lighting set: mood + key / fill / rim / practicals / atmosphere
studio.addGui(gui);

const fCam = gui.addFolder("🎥 camera");
fCam.add(cam, "shot", SHOTS).name("shot").onChange((s: Shot) => goShot(s)).listen();
fCam.add({ replay: () => goShot(cam.shot) }, "replay").name("▶ fly to shot");
fCam.add(cam, "autoOrbit").name("auto orbit").onChange((v: boolean) => (controls.autoRotate = v));
fCam.add(cam, "orbitSpeed", -2, 2, 0.01).name("orbit speed").onChange((v: number) => (controls.autoRotateSpeed = v));
fCam.add(cam, "fov", 12, 75, 0.5).name("field of view °").onChange((v: number) => {
  director.stop();
  camera.fov = v;
  camera.updateProjectionMatrix();
}).listen();
fCam.add(cam, "letterbox", Object.keys(LETTERBOX)).name("letterbox")
  .onChange((v: Letterbox) => (post.letterbox = LETTERBOX[v]));
const fDof = fCam.addFolder("depth of field");
fDof.add(cam, "dof").name("enabled").onChange((v: boolean) => (post.bokeh.enabled = v));
fDof.add(cam, "autofocus").name("focus on target");
fDof.add(post.bokehUniforms["focus"], "value", 1, 200, 0.1).name("focus distance").listen();
fDof.add(cam, "aperture", 0, 0.004, 0.00005).name("aperture").onChange((v: number) => (post.bokehUniforms["aperture"].value = v));
fDof.add(cam, "maxBlur", 0, 0.02, 0.0005).name("max blur").onChange((v: number) => (post.bokehUniforms["maxblur"].value = v));
fDof.close();

const fPost = gui.addFolder("✨ post");
const aoState = { enabled: true };
fPost.add(aoState, "enabled").name("ambient occlusion").onChange((v: boolean) => (post.ao.enabled = v));
fPost.add(post.ao, "blendIntensity", 0, 1.5, 0.01).name("AO strength");
studio.addGradeGui(fPost);
fPost.add(cam, "chroma", 0, 0.01, 0.0001).name("chromatic aberration")
  .onChange((v: number) => (post.gradeUniforms["uChroma"].value = v));
fPost.close();

// ---- snow GUI (master toggle + snowfall + accumulation) ----
const fSnow = gui.addFolder("snow");
fSnow.add(snowState, "enabled").name("enabled").onChange(applySnowEnabled);
const fFall = fSnow.addFolder("snowfall");
fFall.add(snowState, "density", 0, 1, 0.01).name("density").onChange((v: number) => snow.setDensity(v));
fFall.add(snow.uniforms.uSpeed, "value", 0.5, 12, 0.1).name("fall speed");
fFall.add(snow.uniforms.uSize, "value", 0.01, 0.25, 0.001).name("flake size");
fFall.add(snow.uniforms.uSway, "value", 0, 3, 0.01).name("sway");
fFall.add(snow.uniforms.uOpacity, "value", 0, 1, 0.01).name("opacity");
fFall.addColor({ c: "#ffffff" }, "c").name("color").onChange((v: string) => snow.uniforms.uColor.value.set(v));
fFall.add(snow.uniforms.uVolume.value, "y", 10, 80, 1).name("fall height");
fFall.add(wind, "strength", 0, 25, 0.1).name("wind").onChange(applyWind);
fFall.add(wind, "direction", 0, 360, 1).name("wind dir").onChange(applyWind);
fFall.close();
const fAccum = fSnow.addFolder("accumulation");
fAccum.add(accumU.uSnowCoverage, "value", 0, 1, 0.01).name("coverage");
fAccum.add(accumU.uSnowScale, "value", 0.1, 4, 0.01).name("patch scale");
fAccum.add(accumU.uSnowEdge, "value", 0.01, 0.4, 0.005).name("patch softness");
fAccum.add(accumU.uSnowHeightVar, "value", 0, 2, 0.01).name("height variation");
fAccum.add(accumU.uSnowSeed.value, "x", -50, 50, 0.1).name("seed x").listen();
fAccum.add(accumU.uSnowSeed.value, "y", -50, 50, 0.1).name("seed y").listen();
fAccum.add({ randomize: () => accumU.uSnowSeed.value.set((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100) },
  "randomize").name("🎲 randomize seed");
fAccum.add(accumU.uSnowFlatThreshold, "value", 0, 1, 0.01).name("flatness");
fAccum.addColor({ c: "#eaf1ff" }, "c").name("color").onChange((v: string) => accumU.uSnowColor.value.set(v));
fAccum.add(accumU.uSnowRoughness, "value", 0.3, 1, 0.01).name("roughness");
fAccum.add(accumU.uSnowBump, "value", 0, 1.5, 0.01).name("relief strength");
fAccum.add(accumU.uSnowBumpScale, "value", 0.5, 8, 0.05).name("relief scale");
fAccum.add(accumU.uSnowSparkle, "value", 0, 1, 0.01).name("sparkle");
fAccum.add(accumU.uSnowSparkleScale, "value", 30, 300, 1).name("sparkle density");
fAccum.close();
fSnow.close();

// ---- rain GUI (master toggle + rainfall + wetness + lightning) ----
const fRain = gui.addFolder("rain");
fRain.add(rainState, "enabled").name("enabled").onChange(applyRainEnabled);
fRain.add(studio, "lightning").name("⚡ lightning");
const fRainfall = fRain.addFolder("rainfall");
fRainfall.add(rainState, "density", 0, 1, 0.01).name("density").onChange((v: number) => rain.setDensity(v));
fRainfall.add(rain.uniforms.uSpeed, "value", 2, 60, 0.5).name("fall speed");
fRainfall.add(rain.uniforms.uLength, "value", 0.2, 4, 0.01).name("streak length");
fRainfall.add(rain.uniforms.uWidth, "value", 0.002, 0.05, 0.001).name("streak width");
fRainfall.add(rain.uniforms.uOpacity, "value", 0, 1, 0.01).name("opacity");
fRainfall.addColor({ c: "#b4b8bf" }, "c").name("color").onChange((v: string) => rain.uniforms.uColor.value.set(v));
fRainfall.add(rain.uniforms.uVolume.value, "y", 10, 80, 1).name("fall height");
fRainfall.add(rainWind, "strength", 0, 25, 0.1).name("wind").onChange(applyRainWind);
fRainfall.add(rainWind, "direction", 0, 360, 1).name("wind dir").onChange(applyRainWind);
fRainfall.close();
const fWet = fRain.addFolder("wetness");
fWet.add(wetU.uPuddleCoverage, "value", 0, 1, 0.01).name("coverage");
fWet.add(wetU.uPuddleScale, "value", 0.02, 2, 0.01).name("mask scale");
fWet.add(wetU.uPuddleEdge, "value", 0.001, 0.4, 0.001).name("mask softness");
fWet.add(wetU.uPuddleHeightVar, "value", 0, 2, 0.01).name("height variation");
fWet.add(wetU.uPuddleSeed.value, "x", -50, 50, 0.1).name("seed x").listen();
fWet.add(wetU.uPuddleSeed.value, "y", -50, 50, 0.1).name("seed y").listen();
fWet.add({ randomize: () => wetU.uPuddleSeed.value.set((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100) },
  "randomize").name("🎲 randomize seed");
fWet.add(wetU.uWetness, "value", 0, 1, 0.01).name("surface wetness");
fWet.add(wetU.uWaterDarkness, "value", 0, 1, 0.01).name("wet darkness");
fWet.add(wetU.uPuddleRoughness, "value", 0, 0.5, 0.001).name("reflection roughness");
fWet.add(wetU.uDropletAmount, "value", 0, 1, 0.01).name("droplet beading");
fWet.add(wetU.uDropletScale, "value", 2, 40, 0.5).name("droplet density");
fWet.add(wetU.uTopPuddle, "value", 0, 1, 0.01).name("top puddles");
fWet.add(wetU.uFlatThreshold, "value", 0.2, 0.99, 0.01).name("flatness");
fWet.add(wetU.uRainRipple, "value", 0, 0.3, 0.001).name("ripple strength");
fWet.add(wetU.uRippleScale, "value", 1, 20, 0.1).name("ripple scale");
fWet.add(wetU.uRippleSpeed, "value", 0, 4, 0.01).name("ripple speed");
fWet.add(wetU.uRippleDensity, "value", 0, 1, 0.01).name("ripple density");
fWet.close();
fRain.close();

// ---- fps readout (debug) ----
const fps = { enabled: false };
const fpsEl = document.createElement("div");
fpsEl.style.cssText =
  "position:fixed;top:8px;left:8px;z-index:10;padding:3px 7px;border-radius:4px;background:rgba(0,0,0,.6);" +
  "color:#9fe870;font:12px/1.3 ui-monospace,monospace;pointer-events:none;display:none";
document.body.appendChild(fpsEl);
let fpsT = performance.now(), fpsN = 0;
gui.add(fps, "enabled").name("fps").onChange((v: boolean) => (fpsEl.style.display = v ? "block" : "none"));

// dev hooks for headless screenshots (tools/screenshot.mjs)
const devWindow = window as unknown as {
  __setParams?: (p: Partial<BuildingParams>) => void;
  __setCamera?: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void;
  __snow?: (on: boolean) => void;
  __rain?: (on: boolean) => void;
  __mood?: (name: Mood, seconds?: number) => void;
  __shot?: (name: Shot, seconds?: number) => void;
  __orbit?: (on: boolean) => void;
  __building?: (kind: BuildingKind) => Promise<void>;
  /** set parameters of the graph building on the stage (New York / Chinese) */
  __setNyc?: (p: Record<string, number | boolean | string | number[]>) => void;
  __ready?: boolean;
  /** scene internals, for debugging from the console */
  __three?: { scene: Scene; studio: Studio; camera: PerspectiveCamera; controls: OrbitControls; renderer: WebGLRenderer; post: PostFX };
};
devWindow.__three = { scene, studio, camera, controls, renderer, post };
devWindow.__setParams = p => {
  Object.assign(params, p);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  regenerate();
};
devWindow.__setCamera = (px, py, pz, tx, ty, tz) => {
  director.stop();
  controls.autoRotate = false;
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  controls.update();
};
devWindow.__snow = on => { snowState.enabled = on; applySnowEnabled(on); };
devWindow.__rain = on => { rainState.enabled = on; applyRainEnabled(on); };
devWindow.__mood = (name, seconds = 0) => studio.setMood(name, seconds);
devWindow.__shot = (name, seconds = 0) => goShot(name, seconds);
devWindow.__building = kind => {
  which.building = kind;
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  return switchBuilding();
};
devWindow.__setNyc = p => {
  const graph = currentGraph();
  if (!graph) return;
  Object.assign(graph.params, p);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  regenerate();
};
devWindow.__orbit = on => { cam.autoOrbit = on; controls.autoRotate = on; gui.controllersRecursive().forEach(c => c.updateDisplay()); };

/** the mood the app opens in */
const START_MOOD: Mood = "Architectural";
/** the render loop idles behind the preloader (shaders compile in parallel instead) */
let loading = true;

/**
 * Shaders. A first compile of a building's materials stalls a frame for up to
 * seconds (ANGLE / D3D11 on the big node-graph shaders) — that was the lag
 * when switching building types. Every building is compiled and rendered once
 * behind the preloader instead (KHR_parallel_shader_compile spreads the work
 * over the driver's threads), so switching later is a swap. Compiling in the
 * background after the reveal isn't an option: three polls the compile status
 * with synchronous GL queries, which wait behind the queued compiles.
 */
const warmed = new Map<BuildingKind, Promise<void>>();
const warmDone = new Set<BuildingKind>(["French"]);

/** compile an object's shaders against the scene's lights / fog / environment, for the composer's target */
function compileShaders(obj: Object3D): Promise<unknown> {
  renderer.setRenderTarget(post.composer.readBuffer); // so the programs match the real frames
  const p = renderer.compileAsync(obj, camera, scene); // hidden children (snow caps) included
  renderer.setRenderTarget(null);
  return p;
}

/** a graph building's shaders, compiled without putting it on the stage */
function warm(kind: BuildingKind): Promise<void> {
  let p = warmed.get(kind);
  if (!p) {
    const g = builtFor(kind);
    p = g ? compileShaders(g).then(() => void warmDone.add(kind)) : Promise.resolve();
    warmed.set(kind, p);
  }
  return p;
}

/**
 * each building on the stage in turn: its shaders compiled (the stage, the
 * city and the weather layers — hidden ones too — with the first), one frame
 * rendered for the shadow / AO / DoF pass variants and the geometry uploads,
 * and its city's reflections captured
 */
async function warmUp(progress: (f: number, label: string) => void): Promise<void> {
  const kinds = (["French", "New York", "Chinese"] as BuildingKind[]).filter(k => k === "French" || graphs[k]);
  const names: Record<BuildingKind, string> = { French: "Paris", "New York": "New York", Chinese: "中国" };
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    progress(i / kinds.length, `compiling shaders · ${names[kind]}`);
    await nextFrame();
    which.building = kind;
    regenerate(); // cached: a swap
    await compileShaders(scene);
    goShot("Hero ¾", 0); // in view: every pass renders it
    post.render(0);
    studio.captureEnvironment(); // the building is hidden from it: only the (compiled) city
    warmDone.add(kind);
    warmed.set(kind, Promise.resolve());
  }
  progress(1, "compiling shaders");
}

async function init(): Promise<void> {
  const pre = preloader;
  // 1 · stream everything at once: the French kit + stage, and both graph buildings
  const NET = 0.55;
  const untrack = trackNetwork((done, total) => pre.set((NET * done) / Math.max(total, 1)));
  pre.set(0, "streaming assets");
  const graphKinds: GraphKind[] = ["New York", "Chinese"];
  const graphsReady = graphKinds.map(k =>
    prepareGraph(k).catch(err => {
      console.error(`${k} building failed to preload (it loads again when selected):`, err);
      graphLoading[k] = undefined;
    }),
  );
  mats = await createMaterials("assets/");
  studio.onInterior = gain => {
    mats.interior.userData.gain.value = gain;
    // NYC emission strengths are Blender's own; follow the mood relative to the
    // French room shader's 2.2 baseline (its Emission "EXPOSURE")
    nycSpace.uNycEmitGain.value = gain / 2.2;
  };
  kit = new Kit(mats.byName);
  kit.snowShellMaterial = snowShellMaterial; // set before building so buildGroup adds shells
  await Promise.all([
    kit.load("assets/kit.glb"),
    studio.buildStage("assets/", snowShellMaterial),
    FrenchStreet.load("assets/").then(s => {
      street = s;
      for (const m of s.materials.values()) if (!m.transparent) applyWet(m.material, wetU);
    }).catch(err => console.error("French sidewalk failed to load (the stage plinth stands in):", err)),
  ]);
  // inject the wet-surface shader into every building + stage material once
  // (inert while uWet = 0; the rain toggle raises it to 1)
  for (const m of [...mats.surfaces, ...studio.wetTargets]) applyWet(m, wetU);
  await Promise.all(graphsReady);
  untrack();
  studio.setMood(START_MOOD, 0);

  // 2 · build each building (and the city around it) once — the graphs
  //     evaluate on the main thread, the preloader keeps animating meanwhile
  const steps: [BuildingKind, string, number][] = [
    ["French", "Paris · assembling the Haussmann facades", 0.05],
    ["New York", "New York · evaluating the geometry nodes", 0.12],
    ["Chinese", "中国 · evaluating the geometry nodes", 0.16],
  ];
  let at = NET;
  for (const [kind, label, span] of steps) {
    if (kind !== "French" && !graphs[kind]) continue;
    await pre.step(label, at, at + span, () => {
      which.building = kind;
      regenerate();
    });
    at += span;
  }
  // 3 · compile every building's shaders
  await pre.step("compiling shaders", at, 0.99, sub => warmUp((f, label) => {
    sub(f);
    pre.set(0, label);
  }));

  which.building = "French";
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  await switchBuilding();
  // the reveal: from high above the city, down into the hero shot as the loader fades
  const opening = cam.shot;
  goShot("Aerial", 0);
  camera.position.multiplyScalar(1.9).setY(camera.position.y * 1.6);
  loading = false;
  const reveal = pre.done();
  await new Promise(r => setTimeout(r, 400));
  goShot(opening, 4.5);
  await reveal;
  contact.reveal();
  devWindow.__ready = true;
}

init().catch(err => {
  console.error(err);
  preloader.fail(`failed to load: ${err}`);
});

// size is checked every frame: robust to hidden/zero-size viewports and to
// layout changes that don't fire a window resize
function fitViewport(): void {
  const w = innerWidth, h = innerHeight;
  if (!w || !h || (w === viewW && h === viewH)) return;
  viewW = w;
  viewH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  post.setSize(w, h);
}

const timer = new Timer();
renderer.setAnimationLoop(time => {
  fitViewport();
  timer.update(time);
  if (loading) return;
  const dt = Math.min(timer.getDelta(), 0.1);
  director.tick(dt);
  controls.autoRotate = cam.autoOrbit && !director.moving;
  controls.update(dt);
  if (camera.position.y < 0.35) camera.position.y = 0.35; // stay above the stage floor

  rainShared.uLightning.value = studio.tick(dt, rainState.enabled);
  const b = currentSize();
  studio.city.tick(dt, camera, controls.target, 0.5 * Math.hypot(b.width, b.length, b.height));
  if (snowState.enabled) {
    snowShared.uTime.value += dt; // drives flake fall + sparkle twinkle
    snow.update();
  }
  if (rainState.enabled) {
    rainShared.uTime.value += dt; // drives streak fall + puddle ripples
    rain.update();
  }
  nycSpace.uNycCamB.value.copy(camera.position).applyMatrix4(nycSpace.uNycFromWorld.value);
  if (cam.autofocus) post.bokehUniforms["focus"].value = camera.position.distanceTo(controls.target);

  if (fps.enabled) {
    fpsN++;
    const now = performance.now();
    if (now - fpsT >= 500) {
      fpsEl.textContent = `${Math.round((fpsN * 1000) / (now - fpsT))} fps`;
      fpsT = now;
      fpsN = 0;
    }
  }
  post.render(dt);
});
