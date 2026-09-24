import {
  ACESFilmicToneMapping, BufferAttribute, BufferGeometry, Clock, Group, Material, Mesh,
  PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import GUI from "lil-gui";
import { buildingSize, defaultParams, type BuildingParams } from "./params";
import { generateBuilding } from "./generator";
import { generateCurtains, generateRooms } from "./interiors";
import { createMaterials, type BuildingMaterials } from "./materials";
import { Kit } from "./kit";
import { Environment, type PresetName } from "./environment";
import { PostFX } from "./postfx";
import { createSnow } from "./snow";
import { createSnowAccumUniforms, createSnowShellMaterial } from "./snowAccum";
import { createRain } from "./rain";
import { createWetUniforms, applyWet } from "./wet";

const app = document.getElementById("app")!;
const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new Scene();

const camera = new PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 900);
camera.position.set(12, 7, 14);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.55; // just below the pedestal rim
controls.minDistance = 2;
controls.maxDistance = 220;

// stylized diorama environment: sky dome, clouds, pedestal, trees, lamps, presets
const env = new Environment(scene, renderer);

// Blender is Z-up: the generator works in Blender space inside a rotated root.
// The plaza slab top sits at y = 0.11 — the building stands on it.
const PLAZA_TOP = 0.11;
const root = new Group();
root.rotation.x = -Math.PI / 2;
root.position.y = PLAZA_TOP;
scene.add(root);

const params: BuildingParams = defaultParams();
const view = { interiors: true, curtains: true };
let mats: BuildingMaterials;
let kit: Kit;
let building: Group | null = null;

// ---- snow: falling flakes (world space) + accumulation shell on the building ----
const snowShared = { uTime: { value: 0 }, uWind: { value: new Vector3(2, 0, 1) } };
const accumU = createSnowAccumUniforms(snowShared.uTime);
const snowShellMaterial = createSnowShellMaterial(accumU);
env.setSnowShellMaterial(snowShellMaterial); // plaza/curb get snow caps too
const snow = createSnow({ camera, shared: snowShared });
snow.mesh.visible = false;
snow.material.depthTest = false; // draw flakes over the building instead of being occluded
snow.mesh.renderOrder = 10;
scene.add(snow.mesh);

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
  if (env.snowShell) env.snowShell.visible = v;
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

// ---- rain: falling streaks (world space) + in-place wet accumulation on the ----
// building materials (no shell geometry — the wet shader is injected straight into
// the materials via onBeforeCompile, keyed off WORLD up)
const rainShared = { uTime: { value: 0 }, uWind: { value: new Vector3(3, 0, 1) }, uLightning: { value: 0 } };
const wetU = createWetUniforms(rainShared.uTime, rainShared.uWind);
const rain = createRain({ camera, shared: rainShared });
rain.mesh.visible = false;
rain.material.depthTest = false;
rain.mesh.renderOrder = 10;
scene.add(rain.mesh);

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
  wetU.uWet.value = v ? 1 : 0; // master gate: building dries out when rain is off
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

// cinematic post-processing: bloom -> tone map -> film grade
const post = new PostFX(renderer, scene, camera);

function frameCamera(moveCamera: boolean): void {
  const home = env.cameraHome(buildingSize(params), camera);
  controls.target.copy(home.target);
  if (moveCamera) camera.position.copy(home.pos);
  controls.update();
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

function regenerate(): void {
  if (building) {
    root.remove(building);
    building.traverse(o => {
      const im = o as { isInstancedMesh?: boolean; dispose?: () => void };
      if (im.isInstancedMesh) im.dispose?.();
      else if ((o as Mesh).isMesh && o.parent?.name !== "snowShell") (o as Mesh).geometry.dispose();
    });
  }

  const b = generateBuilding(params);
  building = kit.buildGroup(b.instances);
  // the .blend building spans x ∈ [0, W], y ∈ [0, L] — center it on the plaza
  building.position.set(-b.width / 2, -b.length / 2, 0);

  // zinc roof cap + its snow shell (shares geometry, extruded by the snow shader)
  const cap = roofCap(b.cap);
  building.add(cap);
  building.getObjectByName("snowShell")?.add(new Mesh(cap.geometry, snowShellMaterial));

  // interiors: emissive room boxes behind the glass + voile curtains
  const r = generateRooms(b.instances, params);
  const rooms = meshFrom(
    { position: r.position, room_local: r.roomLocal, room_p1: r.p1, room_p2: r.p2, room_p3: r.p3 },
    r.index, mats.interior,
  );
  rooms.name = "rooms";
  rooms.visible = view.interiors;
  building.add(rooms);
  const c = generateCurtains(b.instances, params);
  const curtains = meshFrom({ position: c.position }, c.index, mats.voile);
  curtains.name = "curtains";
  curtains.visible = view.curtains;
  curtains.renderOrder = 1; // behind the glass (renderOrder 2)
  building.add(curtains);

  root.add(building);
  applySnowEnabled(snowState.enabled); // new snowShell group starts hidden
  env.fit(buildingSize(params)); // resize the diorama + shadow frustum
  frameCamera(false);
}

// ---- GUI ----
const gui = new GUI({ title: "building configurator" });

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
const roomLight = { gain: 2.2 }; // FR_Interior's emission "EXPOSURE" multiplier
fInt.add(roomLight, "gain", 0, 6, 0.05).name("room brightness")
  .onChange((v: number) => { if (mats) mats.interior.userData.gain.value = v; });
fInt.close();

// ---- environment / look ----
const envState = { preset: "golden hour" as PresetName, autoOrbit: true, orbitSpeed: 0.5, clouds: true };
const fEnv = gui.addFolder("environment");
fEnv.add(envState, "preset", ["golden hour", "day", "night"]).name("time of day")
  .onChange((v: PresetName) => env.applyPreset(v, post));
fEnv.add(envState, "autoOrbit").name("auto orbit").onChange((v: boolean) => (controls.autoRotate = v));
fEnv.add(envState, "orbitSpeed", -3, 3, 0.05).name("orbit speed")
  .onChange((v: number) => (controls.autoRotateSpeed = v));
fEnv.add(envState, "clouds").name("clouds").onChange((v: boolean) => env.setCloudsVisible(v));
const fCine = fEnv.addFolder("cinematic");
fCine.add(post.bloom, "strength", 0, 1.5, 0.01).name("bloom");
fCine.add(post.gradeUniforms["uVignette"], "value", 0, 1, 0.01).name("vignette");
fCine.add(post.gradeUniforms["uGrain"], "value", 0, 0.2, 0.005).name("film grain");
fCine.add(post.gradeUniforms["uChroma"], "value", 0, 0.01, 0.0001).name("chromatic aberration");
fCine.add(post.gradeUniforms["uSaturation"], "value", 0, 2, 0.01).name("saturation");
fCine.add(post.gradeUniforms["uContrast"], "value", 0.7, 1.6, 0.01).name("contrast");
fCine.close();
controls.autoRotate = envState.autoOrbit;
controls.autoRotateSpeed = envState.orbitSpeed;

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

// ---- rain GUI (master toggle + rainfall + wetness) ----
const fRain = gui.addFolder("rain");
fRain.add(rainState, "enabled").name("enabled").onChange(applyRainEnabled);
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

// dev hooks for headless screenshots (tools/screenshot.mjs)
const devWindow = window as unknown as {
  __setParams?: (p: Partial<BuildingParams>) => void;
  __setCamera?: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void;
  __snow?: (on: boolean) => void;
  __rain?: (on: boolean) => void;
  __preset?: (name: PresetName) => void;
  __orbit?: (on: boolean) => void;
  __ready?: boolean;
};
devWindow.__setParams = p => {
  Object.assign(params, p);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  regenerate();
};
devWindow.__setCamera = (px, py, pz, tx, ty, tz) => {
  controls.autoRotate = false;
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  controls.update();
};
devWindow.__snow = on => { snowState.enabled = on; applySnowEnabled(on); };
devWindow.__rain = on => { rainState.enabled = on; applyRainEnabled(on); };
devWindow.__preset = name => {
  envState.preset = name;
  env.applyPreset(name, post);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
};
devWindow.__orbit = on => { envState.autoOrbit = on; controls.autoRotate = on; };

async function init(): Promise<void> {
  mats = await createMaterials("assets/");
  kit = new Kit(mats.byName);
  kit.snowShellMaterial = snowShellMaterial; // set before building so buildGroup adds shells
  await kit.load("assets/kit.glb");
  document.getElementById("loading")?.remove();
  env.setGlassMaterials([mats.glass]);
  // inject the wet-surface shader into every building + ground material once
  // (inert while uWet = 0; the rain toggle raises it to 1)
  for (const m of mats.surfaces) applyWet(m, wetU);
  for (const m of env.wetTargets) applyWet(m, wetU);
  regenerate();
  env.applyPreset(envState.preset, post);
  frameCamera(true);
  devWindow.__ready = true;
}

init().catch(err => {
  const el = document.getElementById("loading");
  if (el) el.textContent = `FAILED TO LOAD KIT: ${err}`;
  console.error(err);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

const clock = new Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  if (camera.position.y < 0.4) camera.position.y = 0.4; // stay above the pedestal rim
  env.tick(dt);
  if (snowState.enabled) {
    snowShared.uTime.value += dt; // drives flake fall + sparkle twinkle
    snow.update();
  }
  if (rainState.enabled) {
    rainShared.uTime.value += dt; // drives streak fall + puddle ripples
    rain.update();
  }
  post.render(dt);
});
