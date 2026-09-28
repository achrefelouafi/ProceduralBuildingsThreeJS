/**
 * Cinematic lighting set. The building stands in a procedural city (src/city/)
 * or, in the "Stage" environment, on a dark endless studio stage; either way
 * the whole mood is one tweenable "Look":
 *
 *  - sky dome: horizon → zenith gradient with a soft glow where the light
 *    source sits (key for daylight moods, rim for night moods), a sun / moon
 *    disk, stars and a drifting cloud deck, dithered;
 *  - stage: dark wet-able asphalt floor (the city's roads) + a stone sidewalk
 *    plinth under the building (both triplanar, like the building materials),
 *    only where the building brings no sidewalk of its own;
 *  - city: a white massing model around the building (roads, blocks, volumes);
 *    in the city the reflections (IBL) are captured from the city itself;
 *  - light rig: key (directional, soft PCF shadows), fill, rim spot with an
 *    optional volumetric beam, hemisphere bounce, four facade uplights, and a
 *    lightning flash light for storms;
 *  - atmosphere: analytic exponential HEIGHT fog (thick at street level, thin
 *    at the cornice) patched into three's fog chunks, so every material gets it;
 *  - post: the film grade values (PostFX) are part of the Look too.
 *
 * Moods crossfade: every number and colour in the Look is interpolated.
 * Lights are placed from azimuth/elevation around the live building bounds.
 */
import {
  ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, type ToneMapping,
  AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, Color, ConeGeometry, DirectionalLight,
  DoubleSide, Fog, Group, HemisphereLight, InstancedMesh, Material, Matrix4, Mesh, PCFShadowMap, type Object3D,
  PMREMGenerator, RingGeometry, Scene, ShaderChunk, ShaderMaterial, SphereGeometry, SpotLight, type Texture,
  Vector3, WebGLRenderer, type WebGLRenderTarget,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type GUI from "lil-gui";
import type { PostFX } from "./postfx";
import { triplanar } from "./materials";
import { City, type Flavor } from "./city/city";
import { SITE } from "./city/layout";

// --- height fog -------------------------------------------------------------
// three.js' linear Fog uniforms are repurposed: fogNear = density (1/m at y = 0),
// fogFar = height falloff (1/m). The fragment integrates exp(-falloff·y) along
// the view ray analytically, so fog pools on the ground and thins with height.
ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPosition;
#endif`;
ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPosition = transpose( mat3( viewMatrix ) ) * mvPosition.xyz + cameraPosition;
#endif`;
ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPosition;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    vec3 fogRay = vFogWorldPosition - cameraPosition;
    float fogB = max( fogFar, 1e-4 );
    float fogDy = fogB * fogRay.y;
    float fogPath = abs( fogDy ) > 1e-4 ? ( 1.0 - exp( - fogDy ) ) / fogDy : 1.0;
    float fogAmount = fogNear * exp( - fogB * max( cameraPosition.y, 0.0 ) ) * length( fogRay ) * fogPath;
    float fogFactor = 1.0 - exp( - fogAmount );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

/** Fog whose near/far carry the height-fog density and falloff */
class HeightFog extends Fog {
  get density(): number { return this.near; }
  set density(v: number) { this.near = v; }
  get falloff(): number { return this.far; }
  set falloff(v: number) { this.far = v; }
}

// --- the Look ------------------------------------------------------------------

/** every tweenable value of a mood; colours are sRGB hex strings */
export interface Look {
  exposure: number;
  envIntensity: number;
  keyColor: string; keyIntensity: number; keyAzimuth: number; keyElevation: number; keySoftness: number;
  fillColor: string; fillIntensity: number; fillAzimuth: number; fillElevation: number;
  rimColor: string; rimIntensity: number; rimAzimuth: number; rimElevation: number; beam: number;
  skyColor: string; groundColor: string; hemiIntensity: number;
  horizon: string; zenith: string; glowColor: string; glow: number; glowOnRim: number;
  fogColor: string; fogDensity: number; fogFalloff: number;
  uplightColor: string; uplights: number;
  interior: number;
  contrast: number; saturation: number; vignette: number; grain: number;
  temperature: number; shadowTint: string; highlightTint: string; splitTone: number;
  // sky: sun / moon disk (on the key), stars, cloud deck
  sun: number; stars: number; clouds: number; cloudColor: string;
  /** tone mapping: 0 ACES filmic (cinematic), 1 AgX, 2 Khronos PBR Neutral (true whites, architectural) */
  tone: number;
  /** key light on the city relative to the building (a soft "hero spotlight" below 1) */
  cityLight: number;
}

export type Mood = "Architectural" | "Studio" | "Golden Hour" | "Blue Hour" | "Midnight Noir" | "Overcast" | "Storm" | "Clear Day" | "Neon Night";
export type Environment = "City" | "Stage";

export const MOODS: Record<Mood, Look> = {
  // bright, soft daylight on a white massing model: the architectural render
  Architectural: {
    exposure: 0.92, envIntensity: 0.42,
    keyColor: "#fff8f0", keyIntensity: 5, keyAzimuth: -42, keyElevation: 40, keySoftness: 2,
    fillColor: "#eef1f6", fillIntensity: 0.22, fillAzimuth: 140, fillElevation: 35,
    rimColor: "#ffffff", rimIntensity: 0.3, rimAzimuth: 200, rimElevation: 30, beam: 0,
    skyColor: "#eceef0", groundColor: "#cdc8bf", hemiIntensity: 0.7,
    horizon: "#eff1f3", zenith: "#d3dde8", glowColor: "#fff8ee", glow: 0.25, glowOnRim: 0,
    fogColor: "#edf0f3", fogDensity: 0.0012, fogFalloff: 0.03,
    uplightColor: "#ffd9a8", uplights: 0,
    interior: 0.8,
    contrast: 1.08, saturation: 1.02, vignette: 0.1, grain: 0.005,
    temperature: 0, shadowTint: "#9aa0a8", highlightTint: "#ffffff", splitTone: 0.03,
    sun: 0, stars: 0, clouds: 0.16, cloudColor: "#ffffff",
    cityLight: 1, tone: 2,
  },
  Studio: {
    exposure: 0.95, envIntensity: 0.35,
    keyColor: "#fff1dd", keyIntensity: 3.2, keyAzimuth: 38, keyElevation: 40, keySoftness: 3,
    fillColor: "#4a6cff", fillIntensity: 0.55, fillAzimuth: -115, fillElevation: 22,
    rimColor: "#ffd9a0", rimIntensity: 3.5, rimAzimuth: 205, rimElevation: 32, beam: 0.18,
    skyColor: "#223044", groundColor: "#0b0c10", hemiIntensity: 0.7,
    horizon: "#1b2130", zenith: "#040509", glowColor: "#ffcf9a", glow: 0.35, glowOnRim: 1,
    fogColor: "#161b26", fogDensity: 0.012, fogFalloff: 0.08,
    uplightColor: "#ffd9a8", uplights: 0,
    interior: 1.5,
    contrast: 1.08, saturation: 1.0, vignette: 0.38, grain: 0.03,
    temperature: 0, shadowTint: "#1b2a3a", highlightTint: "#ffe2c0", splitTone: 0.25,
    sun: 0, stars: 0.25, clouds: 0.12, cloudColor: "#2b3446",
    cityLight: 0.45, tone: 0,
  },
  "Golden Hour": {
    exposure: 1.0, envIntensity: 0.45,
    keyColor: "#ffb877", keyIntensity: 4.6, keyAzimuth: 62, keyElevation: 12, keySoftness: 2,
    fillColor: "#5d7fc8", fillIntensity: 0.5, fillAzimuth: -100, fillElevation: 25,
    rimColor: "#ffcf8a", rimIntensity: 2.2, rimAzimuth: 200, rimElevation: 16, beam: 0,
    skyColor: "#55668f", groundColor: "#2a1f19", hemiIntensity: 0.45,
    horizon: "#c9774b", zenith: "#18203a", glowColor: "#ffae66", glow: 0.9, glowOnRim: 0,
    fogColor: "#4a3530", fogDensity: 0.006, fogFalloff: 0.06,
    uplightColor: "#ffd9a8", uplights: 0,
    interior: 0.9,
    contrast: 1.08, saturation: 1.05, vignette: 0.34, grain: 0.03,
    temperature: 0.06, shadowTint: "#2a3b5c", highlightTint: "#ffd6a0", splitTone: 0.3,
    sun: 1, stars: 0, clouds: 0.42, cloudColor: "#ffb784",
    cityLight: 0.95, tone: 0,
  },
  "Blue Hour": {
    exposure: 1.05, envIntensity: 0.3,
    keyColor: "#9fb4ff", keyIntensity: 0.9, keyAzimuth: -30, keyElevation: 34, keySoftness: 5,
    fillColor: "#ff9e6b", fillIntensity: 0.2, fillAzimuth: 150, fillElevation: 6,
    rimColor: "#ffb070", rimIntensity: 2.8, rimAzimuth: 172, rimElevation: 10, beam: 0,
    skyColor: "#2c3f73", groundColor: "#120f18", hemiIntensity: 0.95,
    horizon: "#3d5089", zenith: "#0a1130", glowColor: "#ff9a62", glow: 0.7, glowOnRim: 1,
    fogColor: "#27345a", fogDensity: 0.014, fogFalloff: 0.06,
    uplightColor: "#ffcf94", uplights: 1.3,
    interior: 2.6,
    contrast: 1.05, saturation: 1.1, vignette: 0.36, grain: 0.035,
    temperature: -0.08, shadowTint: "#10204a", highlightTint: "#ffc890", splitTone: 0.35,
    sun: 0, stars: 0.12, clouds: 0.28, cloudColor: "#8a7aa8",
    cityLight: 0.8, tone: 0,
  },
  "Midnight Noir": {
    exposure: 1.0, envIntensity: 0.08,
    keyColor: "#b8c8ff", keyIntensity: 1.7, keyAzimuth: -52, keyElevation: 58, keySoftness: 1,
    fillColor: "#1d2a55", fillIntensity: 0.15, fillAzimuth: 120, fillElevation: 15,
    rimColor: "#cfe0ff", rimIntensity: 7, rimAzimuth: 186, rimElevation: 36, beam: 0.6,
    skyColor: "#0a1022", groundColor: "#000000", hemiIntensity: 0.45,
    horizon: "#0c1222", zenith: "#010204", glowColor: "#8fb0ff", glow: 0.55, glowOnRim: 1,
    fogColor: "#0b101d", fogDensity: 0.022, fogFalloff: 0.1,
    uplightColor: "#ffd28a", uplights: 0.9,
    interior: 3.2,
    contrast: 1.18, saturation: 0.55, vignette: 0.55, grain: 0.06,
    temperature: -0.05, shadowTint: "#0a1830", highlightTint: "#fff0d8", splitTone: 0.2,
    sun: 0.35, stars: 0.9, clouds: 0.1, cloudColor: "#1e2638",
    cityLight: 0.45, tone: 0,
  },
  Overcast: {
    exposure: 0.85, envIntensity: 0.75,
    keyColor: "#f2f4f8", keyIntensity: 0.9, keyAzimuth: 20, keyElevation: 62, keySoftness: 8,
    fillColor: "#c8d4e6", fillIntensity: 0.3, fillAzimuth: -120, fillElevation: 30,
    rimColor: "#ffffff", rimIntensity: 0.6, rimAzimuth: 190, rimElevation: 30, beam: 0,
    skyColor: "#c9d3e0", groundColor: "#3a3a38", hemiIntensity: 1.1,
    horizon: "#8f98a2", zenith: "#4d5661", glowColor: "#ffffff", glow: 0.1, glowOnRim: 0,
    fogColor: "#7c848e", fogDensity: 0.005, fogFalloff: 0.04,
    uplightColor: "#ffd9a8", uplights: 0,
    interior: 0.8,
    contrast: 1.06, saturation: 0.95, vignette: 0.25, grain: 0.02,
    temperature: 0, shadowTint: "#56657a", highlightTint: "#fff4e6", splitTone: 0.1,
    sun: 0, stars: 0, clouds: 1, cloudColor: "#a5adb6",
    cityLight: 1, tone: 0,
  },
  Storm: {
    exposure: 1.0, envIntensity: 0.18,
    keyColor: "#8a9bb8", keyIntensity: 0.7, keyAzimuth: 30, keyElevation: 50, keySoftness: 6,
    fillColor: "#2b3a52", fillIntensity: 0.3, fillAzimuth: -120, fillElevation: 20,
    rimColor: "#9fb3d9", rimIntensity: 2.2, rimAzimuth: 195, rimElevation: 30, beam: 0.25,
    skyColor: "#2a3445", groundColor: "#0a0c10", hemiIntensity: 0.9,
    horizon: "#2b3444", zenith: "#0b0e14", glowColor: "#9fb3d9", glow: 0.25, glowOnRim: 1,
    fogColor: "#1e2532", fogDensity: 0.026, fogFalloff: 0.06,
    uplightColor: "#ffd28a", uplights: 0.6,
    interior: 2.2,
    contrast: 1.12, saturation: 0.7, vignette: 0.45, grain: 0.05,
    temperature: -0.1, shadowTint: "#142033", highlightTint: "#e8eefc", splitTone: 0.25,
    sun: 0, stars: 0, clouds: 1, cloudColor: "#343c48",
    cityLight: 0.85, tone: 0,
  },
  "Clear Day": {
    exposure: 1, envIntensity: 0.7,
    keyColor: "#fff1dc", keyIntensity: 5.4, keyAzimuth: 48, keyElevation: 38, keySoftness: 1.2,
    fillColor: "#8fb4ff", fillIntensity: 0.55, fillAzimuth: -120, fillElevation: 30,
    rimColor: "#ffffff", rimIntensity: 0.8, rimAzimuth: 200, rimElevation: 30, beam: 0,
    skyColor: "#7fa9e6", groundColor: "#4d443a", hemiIntensity: 0.75,
    horizon: "#a9cbee", zenith: "#2f67bd", glowColor: "#fff1d0", glow: 0.45, glowOnRim: 0,
    fogColor: "#a8c2e0", fogDensity: 0.0028, fogFalloff: 0.03,
    uplightColor: "#ffd9a8", uplights: 0,
    interior: 0.7,
    contrast: 1.12, saturation: 1.16, vignette: 0.24, grain: 0.015,
    temperature: 0.03, shadowTint: "#3d5a86", highlightTint: "#fff2dc", splitTone: 0.18,
    sun: 1.2, stars: 0, clouds: 0.36, cloudColor: "#ffffff",
    cityLight: 1, tone: 0,
  },
  "Neon Night": {
    exposure: 1.05, envIntensity: 0.25,
    keyColor: "#8c7dff", keyIntensity: 1.1, keyAzimuth: -40, keyElevation: 55, keySoftness: 2,
    fillColor: "#ff3fa4", fillIntensity: 0.45, fillAzimuth: 130, fillElevation: 12,
    rimColor: "#29e4ff", rimIntensity: 5.5, rimAzimuth: 190, rimElevation: 24, beam: 0.35,
    skyColor: "#27124a", groundColor: "#0a0510", hemiIntensity: 0.8,
    horizon: "#3b1650", zenith: "#07030f", glowColor: "#ff4fb0", glow: 0.8, glowOnRim: 1,
    fogColor: "#23103a", fogDensity: 0.02, fogFalloff: 0.07,
    uplightColor: "#ff4fd8", uplights: 1.4,
    interior: 3,
    contrast: 1.12, saturation: 1.25, vignette: 0.5, grain: 0.045,
    temperature: -0.06, shadowTint: "#1a0a3a", highlightTint: "#ffd0f4", splitTone: 0.35,
    sun: 0, stars: 0.3, clouds: 0.18, cloudColor: "#4a2060",
    cityLight: 0.5, tone: 0,
  },
};

const COLOR_KEYS = Object.keys(MOODS.Studio).filter(k => typeof MOODS.Studio[k as keyof Look] === "string") as (keyof Look)[];
const ANGLE_KEYS = new Set<keyof Look>(["keyAzimuth", "fillAzimuth", "rimAzimuth"]);

const cA = new Color(), cB = new Color();
function lerpLook(a: Look, b: Look, t: number, out: Look): void {
  for (const k of Object.keys(b) as (keyof Look)[]) {
    if (COLOR_KEYS.includes(k)) {
      cA.set(a[k] as string);
      cB.set(b[k] as string);
      (out[k] as string) = "#" + cA.lerp(cB, t).getHexString();
    } else {
      let from = a[k] as number;
      const to = b[k] as number;
      if (ANGLE_KEYS.has(k)) from = to + ((((from - to) % 360) + 540) % 360) - 180; // shortest way round
      (out[k] as number) = from + (to - from) * t;
    }
  }
}

/** unit direction from azimuth (0° = +Z, the building front) and elevation, degrees */
function dirFrom(az: number, el: number, out = new Vector3()): Vector3 {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

/** sides of the footprint on the stage (front = +Z) */
export interface StageSides { front: boolean; back: boolean; left: boolean; right: boolean }

export interface StageBounds {
  width: number;
  length: number;
  height: number;
  /** sidewalk reach around the footprint (where the city's roads start) */
  margin?: number;
  /** the sides the building's own sidewalk + curb run along (reaching `margin`): the plinth paves only the others */
  ownSidewalk?: StageSides;
  /** the city's architecture, matched to the building */
  flavor?: Flavor;
}

const TONE: ToneMapping[] = [ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping];
const tmpM = new Matrix4();

export const SIDEWALK = 0.15; // plinth height the building stands on
export const SIDEWALK_MARGIN = 2.6;

export class Studio {
  readonly key = new DirectionalLight(0xffffff, 3);
  readonly fill = new DirectionalLight(0xffffff, 0.5);
  readonly rim = new SpotLight(0xffffff, 1, 0, Math.PI / 6, 0.55, 2);
  readonly hemi = new HemisphereLight(0x223044, 0x0b0c10, 0.6);
  readonly flash = new DirectionalLight(0xcfdcff, 0);
  readonly uplights: SpotLight[] = [];

  /** the live, editable look (GUI-bound) */
  readonly look: Look = { ...MOODS.Architectural };
  mood: Mood = "Architectural";
  lightning = true;
  /** floor + sidewalk materials — rain soaks them too */
  readonly wetTargets: Material[] = [];
  /** snow shells for the floor / sidewalk (toggled with snow) */
  readonly snowShell = new Group();
  /** called with the interior (room) brightness */
  onInterior: (gain: number) => void = () => {};
  /** the procedural city around the building */
  readonly city: City;
  environment: Environment = "City";
  /** hidden while the city reflections are captured (the building, particles) */
  envHide: Object3D[] = [];

  private pmrem: PMREMGenerator;
  private roomEnv: Texture;
  /** captured city reflections, per city, until the look changes */
  private envCache = new Map<string, WebGLRenderTarget>();
  private envInUse: WebGLRenderTarget | null = null;
  /** seconds until the city reflections are re-captured (< 0: up to date) */
  private envDue = 0;
  private dome: Mesh;
  private domeMat: ShaderMaterial;
  private beam: Mesh;
  private beamMat: ShaderMaterial;
  private fog = new HeightFog(0x000000, 0.01, 0.08);
  private stage = new Group();
  /** the plinth: the whole site, or the strips the building's own sidewalk leaves bare */
  private sidewalk: InstancedMesh | null = null;
  private sidewalkShell: InstancedMesh | null = null;
  private floor: Mesh | null = null;
  private bounds: StageBounds = { width: 20, length: 11, height: 18 };
  private tween: { from: Look; to: Look; t: number; duration: number } | null = null;
  private flashLevel = 0;
  private nextFlash = 3;
  private flashQueue: number[] = [];
  private tmp = new Vector3();

  constructor(private scene: Scene, private renderer: WebGLRenderer, private post: PostFX) {
    this.city = new City(renderer);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap; // r185: PCF honours shadow.radius (soft)

    this.pmrem = new PMREMGenerator(renderer);
    this.roomEnv = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = this.roomEnv;
    scene.fog = this.fog;
    scene.background = null;

    // --- sky dome ---
    this.domeMat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uHorizon: { value: new Color() },
        uZenith: { value: new Color() },
        uGlowColor: { value: new Color() },
        uGlowDir: { value: new Vector3(0, 0.3, -1) },
        uGlow: { value: 0.3 },
        uFlash: { value: 0 },
        uFog: { value: new Color() },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color() },
        uSun: { value: 0 },
        uStars: { value: 0 },
        uClouds: { value: 0 },
        uCloudColor: { value: new Color() },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // pinned to the far plane
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizon, uZenith, uGlowColor, uGlowDir, uFog, uSunDir, uSunColor, uCloudColor;
        uniform float uGlow, uFlash, uSun, uStars, uClouds, uTime;
        varying vec3 vDir;
        float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
          return s;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
          float g = max(dot(d, normalize(uGlowDir)), 0.0);
          col += uGlowColor * uGlow * (pow(g, 6.0) * 0.55 + pow(g, 40.0) * 0.8) * smoothstep(-0.2, 0.05, h);
          // stars (twinkling), then the sun / moon disk on the key light
          if (uStars > 0.0 && h > 0.0) {
            vec3 sp = d * 260.0;
            vec3 id = floor(sp);
            float r = hash13(id);
            if (r > 0.9965) {
              vec3 o = fract(sp) - 0.5 - (vec3(hash13(id + 1.3), hash13(id + 7.1), hash13(id + 3.7)) - 0.5) * 0.5;
              float tw = 0.65 + 0.35 * sin(uTime * (1.5 + r * 3.0) + r * 90.0);
              col += vec3(0.85, 0.9, 1.0) * smoothstep(0.16, 0.0, length(o)) * uStars * tw * (0.4 + 2.0 * (r - 0.9965) / 0.0035) * smoothstep(0.0, 0.25, h);
            }
          }
          float sd = dot(d, normalize(uSunDir));
          col += uSunColor * uSun * (smoothstep(0.99955, 0.9998, sd) * 22.0 + pow(max(sd, 0.0), 180.0) * 1.5);
          // a drifting cloud deck (a plane seen from below), lit on the sun side
          if (uClouds > 0.0 && h > -0.05) {
            vec2 uv = d.xz / (max(h, 0.0) + 0.09) * 0.55 + vec2(uTime * 0.006, uTime * 0.002);
            float n = fbm(uv);
            float cover = smoothstep(1.0 - uClouds * 0.85 - 0.05, 1.12 - uClouds * 0.85, n);
            float lit = pow(max(dot(normalize(d.xz + 1e-4), normalize(uSunDir.xz + 1e-4)), 0.0), 3.0);
            vec3 cc = uCloudColor * mix(0.55, 1.05, smoothstep(0.35, 0.9, n));
            cc += uGlowColor * uGlow * lit * 0.35 * (1.0 - cover * 0.5);
            col = mix(col, cc, cover * smoothstep(-0.02, 0.1, h) * 0.96);
          }
          // the floor dissolves into the haze: melt the horizon band into the fog colour
          col = mix(col, uFog, exp(-max(h, 0.0) * 5.0) * 0.9);
          col = mix(uFog, col, smoothstep(-0.02, 0.0, h));
          col += vec3(0.75, 0.82, 1.0) * uFlash * (0.35 + 0.65 * smoothstep(-0.1, 0.6, h));
          col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0; // dither the gradient
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new Mesh(new SphereGeometry(450, 48, 24), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.userData.noAO = true;
    scene.add(this.dome);

    // --- volumetric beam for the rim spot (additive, soft-edged cone) ---
    this.beamMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: { uColor: { value: new Color() }, uStrength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vAlong; varying vec3 vN; varying vec3 vView;
        void main() {
          vAlong = 0.5 - position.y; // 0 at the apex (light) → 1 at the base
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uStrength;
        varying float vAlong; varying vec3 vN; varying vec3 vView;
        void main() {
          float edge = pow(clamp(abs(dot(normalize(vN), normalize(vView))), 0.0, 1.0), 1.6); // soft silhouette
          float along = clamp(vAlong, 0.0, 1.0);
          float fall = pow(1.0 - along, 1.4) * smoothstep(0.0, 0.3, along);
          gl_FragColor = vec4(uColor * uStrength * edge * fall * 0.35, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    // unit-height open cone, apex at +0.5 (rotated onto the rim → target axis in frame())
    this.beam = new Mesh(new ConeGeometry(1, 1, 48, 1, true), this.beamMat);
    this.beam.userData.noAO = true;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    // --- light rig ---
    const s = this.key.shadow;
    this.key.castShadow = true;
    s.mapSize.set(4096, 4096);
    s.bias = -0.00025;
    s.normalBias = 0.03;
    this.rim.penumbra = 0.6;
    for (let i = 0; i < 4; i++) {
      const u = new SpotLight(0xffffff, 0, 0, Math.PI / 5, 0.85, 2);
      this.uplights.push(u);
      scene.add(u, u.target);
    }
    scene.add(this.key, this.key.target, this.fill, this.rim, this.rim.target, this.hemi, this.flash);
    scene.add(this.stage);
    this.snowShell.name = "stageSnowShell";
    this.snowShell.visible = false;
    scene.add(this.snowShell);
    this.stage.add(this.city.group);
    this.snowShell.add(this.city.snowShell);
    this.apply();
  }

  /** floor + sidewalk plinth; call once the texture base is known */
  async buildStage(base: string, snowShellMaterial: Material): Promise<void> {
    const floorMat = await triplanar("studio floor", {
      tex: "stone", scale: 0.22, tint: [0.2, 0.2, 0.215], tintMix: 1, rough: [0.4, 0.85], bump: 0.45,
      grime: { ramp: [0.7, 0.7, 0.72], mix: 0.8 },
    }, base);
    const pavement = await triplanar("studio sidewalk", {
      tex: "trim", scale: 0.5, tint: [0.46, 0.44, 0.41], tintMix: 1, rough: [0.6, 0.9], bump: 0.35,
      grime: { ramp: [0.75, 0.72, 0.68], mix: 0.7 },
    }, base);
    this.wetTargets.push(floorMat, pavement);
    // the floor carries a vertex-colour light pool: full albedo around the
    // building, falling off into darkness (re-fitted to the footprint in frame())
    floorMat.vertexColors = true;
    // the pool must dim the whole shading — at grazing angles the floor is mostly
    // IBL specular, which vertex colours (albedo only) would leave untouched
    const floorCompile = floorMat.onBeforeCompile.bind(floorMat);
    const floorKey = floorMat.customProgramCacheKey.bind(floorMat);
    floorMat.onBeforeCompile = (shader, r) => {
      this.city.patchRoad(shader); // before the triplanar hook: markings land after its albedo
      floorCompile(shader, r);
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        "outgoingLight *= vColor.rgb;\n#include <opaque_fragment>",
      );
    };
    floorMat.customProgramCacheKey = () => floorKey() + "|light-pool|city-road";
    // the sidewalk: flagstones + granite curbs, city shadows and lamp light
    const paveCompile = pavement.onBeforeCompile.bind(pavement);
    const paveKey = pavement.customProgramCacheKey.bind(pavement);
    pavement.onBeforeCompile = (shader, r) => {
      this.city.patchPavement(shader);
      paveCompile(shader, r);
    };
    pavement.customProgramCacheKey = () => paveKey() + "|city-pavement";
    this.city.setSnowShell(snowShellMaterial);
    this.wetTargets.push(...this.city.wetTargets);
    const floor = new Mesh(new RingGeometry(0, 420, 128, 96), floorMat);
    floor.geometry.setAttribute("color", new BufferAttribute(new Float32Array(floor.geometry.attributes.position.count * 3), 3));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.floor = floor;
    this.stage.add(floor);
    const floorShell = new Mesh(floor.geometry, snowShellMaterial);
    floorShell.rotation.x = -Math.PI / 2;
    this.snowShell.add(floorShell);

    this.sidewalk = new InstancedMesh(new BoxGeometry(1, SIDEWALK, 1).translate(0, SIDEWALK / 2, 0), pavement, 4);
    this.sidewalk.castShadow = this.sidewalk.receiveShadow = true;
    this.stage.add(this.sidewalk);
    this.sidewalkShell = new InstancedMesh(this.sidewalk.geometry, snowShellMaterial, 4);
    this.sidewalkShell.instanceMatrix = this.sidewalk.instanceMatrix; // same boxes
    this.snowShell.add(this.sidewalkShell);
    this.frame(this.bounds);
  }

  // --- moods ---

  setMood(mood: Mood, seconds = 1.6): void {
    this.mood = mood;
    const to = MOODS[mood];
    if (seconds <= 0) {
      Object.assign(this.look, to);
      this.tween = null;
      this.apply();
      return;
    }
    this.tween = { from: { ...this.look }, to: { ...to }, t: 0, duration: seconds };
  }

  /** a GUI edit cancels any running crossfade so it doesn't overwrite the edit */
  touch(): void {
    this.tween = null;
    this.apply();
  }

  /** place lights, shadow frustum, beam and uplights around the building */
  frame(b: StageBounds): void {
    this.bounds = b;
    const city = this.environment === "City";
    const margin = b.margin ?? SIDEWALK_MARGIN;
    if (this.floor) {
      // stage light pool: 1 inside ~1.3× the footprint radius, down to 6% far
      // out (the city's streets are lit everywhere)
      const pos = this.floor.geometry.attributes.position;
      const col = this.floor.geometry.attributes.color;
      const R = Math.hypot(b.width, b.length) / 2 + margin;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i), pos.getY(i));
        const t = Math.min(Math.max((d - R * 1.3) / (R * 5), 0), 1);
        const v = city ? 1 : 1 - (1 - 0.06) * t * t * (3 - 2 * t);
        col.setXYZ(i, v, v, v);
      }
      col.needsUpdate = true;
    }
    this.city.group.visible = city;
    this.city.snowShell.visible = city;
    this.city.uniforms.uCityOn.value = city ? 1 : 0;
    const own = b.ownSidewalk;
    // in the city a building's own sidewalk meets the street at its curb; the
    // plinth (without one) is the whole site: sidewalk + a paved forecourt
    const site = city && !own ? SITE : 0;
    if (city && this.city.update({ width: b.width, length: b.length, height: b.height, margin, site, flavor: b.flavor ?? "paris" })) this.envDue = 0;
    const walk = this.sidewalk, walkShell = this.sidewalkShell;
    if (walk && walkShell) {
      const hw = b.width / 2, hl = b.length / 2;
      const X = hw + margin + site, Z = hl + margin + site;
      this.city.uniforms.uSiteHalf.value.set(X, Z);
      // [x0, x1, z0, z1]: never under the building's own sidewalk (no second
      // curb, nothing to fight with its paving). Its sidewalk turns the corner
      // between two of its sides; a bare side's strip takes the others.
      const boxes: number[][] = [];
      if (!own) boxes.push([-X, X, -Z, Z]);
      else if (city) {
        if (!own.back) boxes.push([-X, X, -Z, -hl]);
        if (!own.front) boxes.push([-X, X, hl, Z]);
        const z0 = own.back ? -Z : -hl, z1 = own.front ? Z : hl;
        if (!own.right) boxes.push([hw, X, z0, z1]);
        if (!own.left) boxes.push([-X, -hw, z0, z1]);
      }
      boxes.forEach(([x0, x1, z0, z1], i) => {
        walk.setMatrixAt(i, tmpM.makeScale(x1 - x0, 1, z1 - z0).setPosition((x0 + x1) / 2, 0, (z0 + z1) / 2));
      });
      walk.count = walkShell.count = boxes.length;
      walk.instanceMatrix.needsUpdate = true;
      walk.computeBoundingBox();
      walk.computeBoundingSphere();
      walkShell.boundingBox = walk.boundingBox;
      walkShell.boundingSphere = walk.boundingSphere;
      walk.visible = walkShell.visible = boxes.length > 0;
    }
    this.apply(false);
  }

  private center(): Vector3 {
    return new Vector3(0, this.bounds.height * 0.45, 0);
  }

  private radius(): number {
    const b = this.bounds;
    return 0.5 * Math.hypot(b.width, b.length, b.height);
  }

  /** push the live look into lights, fog, dome, post */
  apply(lookChanged = true): void {
    const L = this.look;
    const c = this.center();
    const r = this.radius();
    const dist = Math.max(r * 2.6, 30);

    this.renderer.toneMappingExposure = L.exposure;
    this.renderer.toneMapping = TONE[Math.round(Math.min(Math.max(L.tone, 0), 2))];
    this.scene.environmentIntensity = L.envIntensity;

    // key: directional + soft shadow frustum long enough for low sun
    const kd = dirFrom(L.keyAzimuth, L.keyElevation);
    this.key.color.set(L.keyColor);
    this.key.intensity = L.keyIntensity;
    this.key.position.copy(c).addScaledVector(kd, dist);
    this.key.target.position.copy(c);
    this.key.target.updateMatrixWorld();
    this.key.shadow.radius = L.keySoftness;
    const cam = this.key.shadow.camera;
    let reach = r * 1.25 + (this.bounds.height / Math.max(Math.tan((L.keyElevation * Math.PI) / 180), 0.2)) * 0.6;
    // in the city the neighbours across the streets cast (and take) real shadows too;
    // the city's heightmap shadows carry on beyond
    if (this.environment === "City") reach = Math.max(reach, r * 1.25 + 42);
    // … and inside this radius the city's heightmap shadows can skip ahead (its ground
    // coverage is centred where the shadow camera's axis meets the ground)
    const axisOffset = c.y / Math.max(Math.tan((L.keyElevation * Math.PI) / 180), 0.2);
    this.city.uniforms.uShadowReach.value = this.environment === "City" ? Math.max(Math.min(reach * 0.85, reach - axisOffset), 0) : 0;
    cam.left = -reach; cam.right = reach; cam.top = reach; cam.bottom = -reach;
    cam.near = Math.max(dist - reach * 2, 0.5);
    cam.far = dist + reach * 2;
    cam.updateProjectionMatrix();

    this.fill.color.set(L.fillColor);
    this.fill.intensity = L.fillIntensity;
    this.fill.position.copy(c).addScaledVector(dirFrom(L.fillAzimuth, L.fillElevation), dist);

    // rim: intensity given as illuminance at the building → candela for the distance
    const rd = dirFrom(L.rimAzimuth, L.rimElevation);
    const rimDist = dist * 1.1;
    this.rim.color.set(L.rimColor);
    this.rim.intensity = L.rimIntensity * rimDist * rimDist;
    this.rim.position.copy(c).addScaledVector(rd, rimDist);
    this.rim.target.position.copy(c);
    this.rim.target.updateMatrixWorld();
    this.rim.angle = Math.min(Math.atan2(r * 1.6, rimDist), Math.PI / 3);

    // beam: cone from the rim light through the building
    const beamLen = rimDist * 1.6;
    const beamRad = Math.tan(this.rim.angle) * beamLen * 0.9;
    this.beam.visible = L.beam > 0.001;
    this.beam.scale.set(beamRad, beamLen, beamRad);
    this.beam.position.copy(this.rim.position).addScaledVector(rd, -beamLen / 2);
    this.beam.quaternion.setFromUnitVectors(this.tmp.set(0, 1, 0), rd); // apex (+Y) towards the light
    this.beamMat.uniforms.uColor.value.set(L.rimColor);
    this.beamMat.uniforms.uStrength.value = L.beam;

    this.hemi.color.set(L.skyColor);
    this.hemi.groundColor.set(L.groundColor);
    this.hemi.intensity = L.hemiIntensity;

    // uplights: one per facade, grazing it from the sidewalk edge
    const b = this.bounds;
    const hw = b.width / 2, hl = b.length / 2;
    const spots: [number, number, number, number][] = [
      [0, hl + 1.6, 0, hl], [0, -hl - 1.6, 0, -hl], [hw + 1.6, 0, hw, 0], [-hw - 1.6, 0, -hw, 0],
    ];
    this.uplights.forEach((u, i) => {
      const [px, pz, tx, tz] = spots[i];
      u.position.set(px, SIDEWALK + 0.1, pz);
      u.target.position.set(tx, b.height * 0.7, tz);
      u.target.updateMatrixWorld();
      u.color.set(L.uplightColor);
      const reachUp = b.height * 0.5;
      u.intensity = L.uplights * reachUp * reachUp;
      u.angle = Math.min(Math.atan2(Math.max(b.width, b.length) * 0.55, reachUp), 1.3);
      u.visible = L.uplights > 0.001;
    });

    this.fog.color.set(L.fogColor);
    this.fog.density = L.fogDensity;
    this.fog.falloff = L.fogFalloff;

    const du = this.domeMat.uniforms;
    du.uHorizon.value.set(L.horizon);
    du.uZenith.value.set(L.zenith);
    du.uGlowColor.value.set(L.glowColor);
    du.uFog.value.set(L.fogColor);
    du.uGlow.value = L.glow;
    du.uGlowDir.value.copy(kd).lerp(rd, L.glowOnRim).normalize();
    du.uSunDir.value.copy(kd);
    du.uSunColor.value.set(L.keyColor);
    du.uSun.value = L.sun;
    du.uStars.value = L.stars;
    du.uClouds.value = L.clouds;
    du.uCloudColor.value.set(L.cloudColor);

    // the city: sun direction for its heightmap shadows, key light on the city
    const cu = this.city.uniforms;
    cu.uSunDir.value.copy(kd);
    cu.uCityKey.value = L.cityLight;
    if (lookChanged) this.staleEnvironment();

    this.onInterior(L.interior);

    const p = this.post;
    const g = p.gradeUniforms;
    g.uContrast.value = L.contrast;
    g.uSaturation.value = L.saturation;
    g.uVignette.value = L.vignette;
    g.uGrain.value = L.grain;
    g.uTemperature.value = L.temperature;
    (g.uShadowTint.value as unknown as Color).set(L.shadowTint);
    (g.uHighlightTint.value as unknown as Color).set(L.highlightTint);
    g.uSplitTone.value = L.splitTone;
  }

  /**
   * per frame: mood crossfade + lightning. Returns the flash level (0..1) so
   * the rain streaks can light up with it.
   */
  tick(dt: number, storming: boolean): number {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(tw.t + dt / tw.duration, 1);
      const e = tw.t * tw.t * (3 - 2 * tw.t);
      lerpLook(tw.from, tw.to, e, this.look);
      this.apply();
      if (tw.t >= 1) this.tween = null;
    }

    // lightning: random double/triple strikes while it rains
    if (storming && this.lightning) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flashQueue = [0, 0.09 + Math.random() * 0.08, 0.25 + Math.random() * 0.2].slice(0, 2 + Math.round(Math.random()));
        this.nextFlash = 4 + Math.random() * 9;
      }
    }
    for (let i = this.flashQueue.length - 1; i >= 0; i--) {
      this.flashQueue[i] -= dt;
      if (this.flashQueue[i] <= 0) {
        this.flashLevel = Math.max(this.flashLevel, 0.7 + Math.random() * 0.3);
        this.flashQueue.splice(i, 1);
      }
    }
    this.flashLevel = Math.max(0, this.flashLevel - dt * 5.5);
    this.flash.intensity = this.flashLevel * 9;
    this.flash.position.copy(this.center()).addScaledVector(dirFrom(this.look.rimAzimuth + 30, 65), 100);
    this.domeMat.uniforms.uFlash.value = this.flashLevel * 0.6;
    this.domeMat.uniforms.uTime.value += dt;

    // re-capture the city reflections once a crossfade has settled
    if (this.envDue >= 0 && !this.tween && (this.envDue -= dt) < 0) this.captureEnvironment();
    return this.flashLevel;
  }

  // --- environment ---

  /** the city (default) or the dark studio stage */
  setEnvironment(env: Environment): void {
    this.environment = env;
    this.frame(this.bounds);
    this.captureEnvironment();
  }

  /**
   * Reflections: in the city, capture sky + city from above the building (the
   * building and the particles hidden) into the scene's environment map, so
   * glass reflects the skyline and the night's lights; on the stage, the
   * neutral RoomEnvironment.
   */
  captureEnvironment(): void {
    this.envDue = -1;
    if (this.environment !== "City") {
      this.useEnvironment(null);
      return;
    }
    const key = this.city.key;
    let rt = this.envCache.get(key);
    if (!rt) {
      const hidden = [...this.envHide, this.beam].filter(o => o.visible);
      for (const o of hidden) o.visible = false;
      rt = this.pmrem.fromScene(this.scene, 0.015, 1, 900, {
        size: 256,
        position: new Vector3(0, Math.max(this.bounds.height * 0.6, 10), 0),
      });
      for (const o of hidden) o.visible = true;
      this.envCache.set(key, rt);
      // one per cached city at most
      for (const [k, old] of this.envCache) {
        if (this.envCache.size <= 4) break;
        if (old !== rt && old !== this.envInUse) {
          old.dispose();
          this.envCache.delete(k);
        }
      }
    }
    this.useEnvironment(rt);
  }

  private useEnvironment(rt: WebGLRenderTarget | null): void {
    const prev = this.envInUse;
    this.envInUse = rt;
    this.scene.environment = rt?.texture ?? this.roomEnv;
    if (prev && prev !== rt && ![...this.envCache.values()].includes(prev)) prev.dispose();
  }

  /** the look changed: every captured reflection is stale (the one on screen stays until replaced) */
  private staleEnvironment(): void {
    for (const rt of this.envCache.values()) if (rt !== this.envInUse) rt.dispose();
    this.envCache.clear();
    if (this.envDue < 0) this.envDue = 0.35;
  }

  // --- GUI ---

  addGui(gui: GUI): GUI {
    const f = gui.addFolder("🎬 lighting set");
    const L = this.look;
    const ch = () => this.touch();
    const moods = Object.keys(MOODS) as Mood[];
    f.add(this, "mood", moods).name("mood").onChange((m: Mood) => this.setMood(m)).listen();
    f.add(L, "exposure", 0.2, 3, 0.01).name("exposure").onChange(ch).listen();

    const light = (name: string, prefix: "key" | "fill" | "rim", max: number) => {
      const lf = f.addFolder(name);
      lf.addColor(L, `${prefix}Color`).name("color").onChange(ch).listen();
      lf.add(L, `${prefix}Intensity`, 0, max, 0.01).name("intensity").onChange(ch).listen();
      lf.add(L, `${prefix}Azimuth`, -180, 360, 1).name("azimuth °").onChange(ch).listen();
      lf.add(L, `${prefix}Elevation`, 2, 89, 1).name("elevation °").onChange(ch).listen();
      lf.close();
      return lf;
    };
    light("key light", "key", 10).add(L, "keySoftness", 0, 12, 0.1).name("shadow softness").onChange(ch).listen();
    light("fill light", "fill", 4);
    light("rim light", "rim", 15).add(L, "beam", 0, 1.5, 0.01).name("volumetric beam").onChange(ch).listen();

    const amb = f.addFolder("ambient & practicals");
    amb.addColor(L, "skyColor").name("sky bounce").onChange(ch).listen();
    amb.addColor(L, "groundColor").name("ground bounce").onChange(ch).listen();
    amb.add(L, "hemiIntensity", 0, 3, 0.01).name("bounce").onChange(ch).listen();
    amb.add(L, "envIntensity", 0, 2, 0.01).name("reflections (IBL)").onChange(ch).listen();
    amb.addColor(L, "uplightColor").name("uplight color").onChange(ch).listen();
    amb.add(L, "uplights", 0, 4, 0.01).name("facade uplights").onChange(ch).listen();
    amb.add(L, "interior", 0, 6, 0.05).name("room lights").onChange(ch).listen();
    amb.close();

    const atm = f.addFolder("atmosphere & backdrop");
    atm.addColor(L, "fogColor").name("haze color").onChange(ch).listen();
    atm.add(L, "fogDensity", 0, 0.08, 0.0005).name("haze density").onChange(ch).listen();
    atm.add(L, "fogFalloff", 0.005, 0.4, 0.001).name("haze height falloff").onChange(ch).listen();
    atm.addColor(L, "horizon").name("backdrop horizon").onChange(ch).listen();
    atm.addColor(L, "zenith").name("backdrop top").onChange(ch).listen();
    atm.addColor(L, "glowColor").name("glow color").onChange(ch).listen();
    atm.add(L, "glow", 0, 3, 0.01).name("glow").onChange(ch).listen();
    atm.add(L, "glowOnRim", 0, 1, 0.01).name("glow key ↔ rim").onChange(ch).listen();
    atm.add(L, "sun", 0, 2, 0.01).name("sun / moon disk").onChange(ch).listen();
    atm.add(L, "stars", 0, 2, 0.01).name("stars").onChange(ch).listen();
    atm.add(L, "clouds", 0, 1, 0.01).name("clouds").onChange(ch).listen();
    atm.addColor(L, "cloudColor").name("cloud color").onChange(ch).listen();
    atm.close();

    const cf = f.addFolder("🏙 city");
    cf.add(this, "environment", ["City", "Stage"]).name("environment").onChange((e: Environment) => this.setEnvironment(e));
    cf.add(L, "cityLight", 0, 1, 0.01).name("key on the city").onChange(ch).listen();
    cf.add(this.city, "fadeOn").name("clear the view");
    cf.add({ reseed: () => { this.city.reseed(Math.floor(Math.random() * 1e6)); this.envDue = 0; } }, "reseed").name("🎲 new city");
    return f;
  }

  /** grade controls live with the other post settings (main.ts) */
  addGradeGui(f: GUI): void {
    const L = this.look;
    const ch = () => this.touch();
    f.add(L, "contrast", 0.7, 1.6, 0.01).name("contrast").onChange(ch).listen();
    f.add(L, "saturation", 0, 2, 0.01).name("saturation").onChange(ch).listen();
    f.add(L, "temperature", -0.5, 0.5, 0.01).name("white balance").onChange(ch).listen();
    f.addColor(L, "shadowTint").name("shadow tint").onChange(ch).listen();
    f.addColor(L, "highlightTint").name("highlight tint").onChange(ch).listen();
    f.add(L, "splitTone", 0, 1, 0.01).name("split toning").onChange(ch).listen();
    f.add(L, "vignette", 0, 1.5, 0.01).name("vignette").onChange(ch).listen();
    f.add(L, "grain", 0, 0.2, 0.005).name("film grain").onChange(ch).listen();
  }
}
