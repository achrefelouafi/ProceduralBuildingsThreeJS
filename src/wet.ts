/**
 * Wet-surface accumulation — ported from RainSystemThreeJS's model "makeWet" shader.
 *
 * Unlike the snow (which is a separate extruded shell), rain wetness is injected
 * IN PLACE into the building's existing materials via onBeforeCompile — no extra
 * geometry. Every upward-facing fragment darkens and glosses; flat tops collect
 * rippling puddles; all wet faces get triplanar droplet beading. Because the
 * building draws as InstancedMesh inside a Blender Z-up group rotated into world
 * Y-up, the world normal/position fold in `instanceMatrix` (same pattern as
 * snowAccum.ts) and everything keys off WORLD up.
 *
 * `uTime` / `uWind` are shared by reference with the falling rain so ripples and
 * wind drift stay in lockstep. `uWet` is the master 0..1 gate (dry when rain off).
 */
import { Vector2, Vector3 } from "three";
import type { Material, WebGLProgramParametersWithUniforms } from "three";

export interface WetUniforms {
  uTime: { value: number };
  uWind: { value: Vector3 };
  uWet: { value: number };
  uWetness: { value: number };
  uTopPuddle: { value: number };
  uFlatThreshold: { value: number };
  uDropletAmount: { value: number };
  uDropletScale: { value: number };
  uWaterDarkness: { value: number };
  uPuddleRoughness: { value: number };
  uRainRipple: { value: number };
  uRippleScale: { value: number };
  uRippleSpeed: { value: number };
  uRippleDensity: { value: number };
  // procedural wetness mask (world-XZ FBM, like the asphalt puddles / snow patches)
  uPuddleScale: { value: number };
  uPuddleHeightVar: { value: number };
  uPuddleSeed: { value: Vector2 };
  uPuddleCoverage: { value: number };
  uPuddleEdge: { value: number };
}

export function createWetUniforms(uTime: { value: number }, uWind: { value: Vector3 }): WetUniforms {
  return {
    uTime,
    uWind,
    uWet: { value: 0 },            // master gate — 0 = bone dry (rain off)
    uWetness: { value: 0.85 },     // overall surface wetness
    uTopPuddle: { value: 0.7 },    // how strongly flat tops puddle
    uFlatThreshold: { value: 0.65 }, // world normal.y above this = "flat top"
    uDropletAmount: { value: 0.6 }, // droplet beading strength
    uDropletScale: { value: 14.0 }, // droplet density
    uWaterDarkness: { value: 0.45 }, // wet-darkening of the albedo
    uPuddleRoughness: { value: 0.05 }, // gloss of standing water
    uRainRipple: { value: 0.05 },  // ripple strength on top puddles
    uRippleScale: { value: 12.0 },
    uRippleSpeed: { value: 1.3 },
    uRippleDensity: { value: 0.2 },
    // where the surface is wet vs dry — a blotchy FBM field in world XZ
    uPuddleScale: { value: 0.35 },  // mask noise frequency (smaller = bigger patches)
    uPuddleHeightVar: { value: 0.6 }, // how much world-Y shears the mask (breaks per-floor repeat)
    uPuddleSeed: { value: new Vector2(13.7, 4.2) }, // pan the noise field
    uPuddleCoverage: { value: 0.6 }, // 0 = bone dry, 1 = fully wet
    uPuddleEdge: { value: 0.1 },    // wet/dry shoreline softness
  };
}

const WET_HEADER = /* glsl */ `
varying vec3 vWetWorldN;
varying vec3 vWetWorldP;
uniform float uTime;
uniform vec3  uWind;
uniform float uWet;
uniform float uWetness;
uniform float uTopPuddle;
uniform float uFlatThreshold;
uniform float uDropletAmount;
uniform float uDropletScale;
uniform float uWaterDarkness;
uniform float uPuddleRoughness;
uniform float uRainRipple;
uniform float uRippleScale;
uniform float uRippleSpeed;
uniform float uRippleDensity;
uniform float uPuddleScale;
uniform float uPuddleHeightVar;
uniform vec2  uPuddleSeed;
uniform float uPuddleCoverage;
uniform float uPuddleEdge;

// --- Ashima 2D simplex noise -> FBM (same field the asphalt/snow masks use) ---
vec3 wetPermute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float wetSnoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = wetPermute(wetPermute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float wetFbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) { value += amp * wetSnoise(p); p *= 2.0; amp *= 0.5; }
  return value;
}
// 0 (dry) .. 1 (wet) blotches in world XZ — scale/coverage/seed/edge driven.
float wetPuddleMaskAt(vec3 worldP) {
  // Shear the XZ sample by world height so wetness varies floor-to-floor rather
  // than projecting one pattern down the facade. Coefficients differ from the
  // snow mask's so the two effects never coincide when overlaid.
  vec2 xz = worldP.xz + worldP.y * uPuddleHeightVar * vec2(-1.1, 0.9);
  float n = wetFbm(xz * uPuddleScale + uPuddleSeed) * 0.5 + 0.5;
  float threshold = 1.0 - uPuddleCoverage;
  return smoothstep(threshold - uPuddleEdge, threshold + uPuddleEdge, n);
}

float wetHash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// Rain rings (per-grid-cell concentric ripples with their own phase & lifetime).
float wetRippleField(vec2 uv) {
  vec2 g = floor(uv);
  vec2 f = fract(uv);
  float h = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 id = g + o;
      float r = wetHash21(id);
      float life = uTime * uRippleSpeed + r;
      float cycle = floor(life);
      float t = fract(life);
      float spawn = step(1.0 - uRippleDensity, wetHash21(id + cycle * 1.7 + 0.31));
      vec2 c = o + vec2(wetHash21(id + cycle * 2.3 + 0.11), wetHash21(id + cycle * 3.7 + 0.83));
      float d = length(f - c);
      float radius = t * 0.7;
      float band = exp(-pow((d - radius) * 10.0, 2.0));
      float env = sin(t * 3.14159);
      h += sin((d - radius) * 50.0) * band * env * spawn;
    }
  }
  return h;
}

vec3 wetPuddleRippleNormal(vec2 worldXZ) {
  vec2 drift = uWind.xz * uTime * 0.05;
  vec2 uv = worldXZ * uRippleScale + drift;
  float e = 0.05;
  float h0 = wetRippleField(uv);
  float hx = wetRippleField(uv + vec2(e, 0.0));
  float hz = wetRippleField(uv + vec2(0.0, e));
  vec2 grad = vec2(hx - h0, hz - h0) / e;
  return normalize(vec3(-grad.x * uRainRipple, 1.0, -grad.y * uRainRipple));
}

// Rounded water beads in one plane (0 = dry, 1 = on a droplet).
float wetDropField(vec2 uv) {
  uv *= uDropletScale;
  vec2 g = floor(uv);
  vec2 f = fract(uv);
  float v = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 id = g + o;
      vec2 c = o + vec2(wetHash21(id + 0.1), wetHash21(id + 0.2));
      float rad = 0.16 + 0.22 * wetHash21(id + 0.3);
      float d = length(f - c);
      v = max(v, smoothstep(rad, rad * 0.4, d));
    }
  }
  return v;
}

// Triplanar beads so droplets sit correctly on any surface orientation.
float wetDropletMask(vec3 p) {
  vec3 n = abs(vWetWorldN);
  n /= max(n.x + n.y + n.z, 1e-4);
  float dx = wetDropField(p.zy);
  float dy = wetDropField(p.xz);
  float dz = wetDropField(p.xy);
  return dx * n.x + dy * n.y + dz * n.z;
}
`;

/**
 * Inject the wet-surface treatment into a material in place. Safe to call once per
 * material; it recompiles with the puddle/ripple/bead shader and shares `u` by
 * reference so the GUI and the falling rain drive it live.
 */
export function applyWet(material: Material, u: WetUniforms): void {
  // Chain onto the material's own hook (the triplanar building materials).
  // The wet code is injected FIRST: the material's hook then inserts its blocks
  // directly after the same anchor includes, i.e. before the wet adjustments —
  // so wetness darkens/glosses the material's final albedo, roughness and normal.
  const prevCompile = material.onBeforeCompile.bind(material);
  const prevKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    injectWet(shader, u);
    prevCompile(shader, renderer);
  };
  material.customProgramCacheKey = () => prevKey() + "|wet-building-v2";
  material.needsUpdate = true;
}

function injectWet(shader: WebGLProgramParametersWithUniforms, u: WetUniforms): void {
  Object.assign(shader.uniforms, u);

  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nvarying vec3 vWetWorldN;\nvarying vec3 vWetWorldP;",
    )
    .replace(
      "#include <beginnormal_vertex>",
      `#include <beginnormal_vertex>
      #ifdef USE_INSTANCING
        mat3 wetNMat = mat3(modelMatrix) * mat3(instanceMatrix);
      #else
        mat3 wetNMat = mat3(modelMatrix);
      #endif
      vWetWorldN = normalize(wetNMat * objectNormal);`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec4 wetWP = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      #else
        vec4 wetWP = modelMatrix * vec4(transformed, 1.0);
      #endif
      vWetWorldP = wetWP.xyz;`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\n" + WET_HEADER)
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      float upN = vWetWorldN.y;
      float pmask = wetPuddleMaskAt(vWetWorldP); // patchy wet/dry coverage
      float wetBase = uWet * uWetness * smoothstep(-0.3, 0.6, upN) * pmask;
      float topMask = uWet * uTopPuddle * smoothstep(uFlatThreshold, min(uFlatThreshold + 0.15, 1.0), upN) * pmask;
      float beads = wetDropletMask(vWetWorldP) * uDropletAmount * wetBase;
      float wetAll = clamp(max(wetBase, topMask), 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (1.0 - uWaterDarkness), wetAll);`,
    )
    .replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
      float gloss = clamp(max(wetBase * 0.7, topMask) + beads, 0.0, 1.0);
      roughnessFactor = mix(roughnessFactor, uPuddleRoughness, gloss);`,
    )
    .replace(
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>
      vec3 rN = mix(vec3(0.0, 1.0, 0.0), wetPuddleRippleNormal(vWetWorldP.xz), topMask);
      vec3 rView = normalize((viewMatrix * vec4(rN, 0.0)).xyz);
      normal = normalize(mix(normal, rView, topMask));`,
    );
}
