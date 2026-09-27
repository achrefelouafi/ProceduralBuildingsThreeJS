/**
 * GLSL for the city, injected into three's standard materials (so everything
 * keeps its lighting, shadows, height fog and the weather shaders):
 *
 *  - COMMON: the city map (building heights, R8);
 *  - the key-light patch: past the reach of the key's shadow map, a short
 *    heightmap march towards the key (the only shadow-casting directional
 *    light, so always directional light 0) carries the city's shadows;
 *  - KIT: the white massing model and its sidewalk slabs;
 *  - ROAD: pale roads with light markings on the stage floor;
 *  - PAVEMENT: large-format pavers + a granite curb on the hero's site.
 */
import { ShaderChunk, type WebGLProgramParametersWithUniforms } from "three";
import { S } from "./layout";

export const MAX_ROADS = 28;

const f = (n: number) => n.toFixed(1);

const COMMON = /* glsl */ `
uniform sampler2D uCityMap;
uniform float uCityExtent;
uniform float uCityMaxH;
uniform float uCityOn;
uniform vec3 uSunDir;
uniform float uFocusR;
uniform float uCityKey;
uniform float uShadowReach;

float cityHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

/** building height (m) at a ground position */
float cityHeight(vec2 xz) {
  vec2 uv = xz / (2.0 * uCityExtent) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return textureLod(uCityMap, uv, 0.0).r * 255.0;
}
`;

/** fragment-only helpers: anti-aliased bands / stripes, the heightmap sun shadow */
const SHADOW = /* glsl */ `
float cityBand(float x, float a, float b) {
  float w = fwidth(x) * 0.8 + 1e-4;
  return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
}
float cityStripes(float x, float period, float duty) {
  float w = fwidth(x / period) * 0.8 + 1e-4;
  float p = fract(x / period);
  return smoothstep(0.0, w, p) - smoothstep(duty - w, duty + w, p);
}

/** soft heightmap shadow towards the key light (1 = lit) */
float cityShadow(vec3 p, vec3 n) {
  if (uCityOn < 0.5 || uSunDir.y < 0.015) return 1.0;
  // start clear of the surface's own column (a heightmap texel is ~0.8 m)
  vec3 o = p + n * mix(0.95, 0.35, abs(n.y)) + vec3(0.0, 0.03, 0.0);
  // near the building the shadow map holds the city's shadows: march only from
  // where the ray leaves its reach (usually straight past the tallest roof)
  float t = max(0.3, uShadowReach - length(o.xz));
  float sh = 1.0;
  for (int i = 0; i < 28; i++) {
    vec3 q = o + uSunDir * t;
    if (q.y > uCityMaxH) break;
    float k = 0.25 + t * 0.02; // penumbra widens with distance
    sh = min(sh, smoothstep(-k, k, q.y - cityHeight(q.xz)));
    if (sh < 0.01) break;
    t = t * 1.15 + 0.4;
  }
  return sh;
}

/** "hero spotlight": away from the building the key drops to uCityKey */
float cityKeyGain(vec3 p) {
  return mix(1.0, uCityKey, smoothstep(uFocusR * 1.3, uFocusR * 3.5, length(p.xz)) * uCityOn);
}
`;

/** the key light (directional light 0) takes the heightmap shadow */
const LIGHTS_BEGIN = ShaderChunk.lights_fragment_begin.replace(
  "getDirectionalLightInfo( directionalLight, directLight );",
  `getDirectionalLightInfo( directionalLight, directLight );
		#if ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= cityKeyShadow;
		#endif`,
);
if (LIGHTS_BEGIN === ShaderChunk.lights_fragment_begin) console.warn("city: key light patch anchor not found");

/** common vertex bits: world position (+ local frame for boxes) */
const VERT_PARS = /* glsl */ `
varying vec3 vCityWP;
varying vec3 vCityLocal;
varying vec3 vCitySize;
varying vec3 vCityN;
`;

const VERT_WORLD = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 cityM = modelMatrix * instanceMatrix;
#else
  mat4 cityM = modelMatrix;
#endif
  vec3 citySz = vec3(length(cityM[0].xyz), length(cityM[1].xyz), length(cityM[2].xyz));
  vCityLocal = position * citySz;
  vCitySize = citySz;
  vCityN = normalize(normal / citySz);
  vCityWP = (cityM * vec4(transformed, 1.0)).xyz;
`;

/**
 * the parts every city surface shares: uniforms, the key shadow; `pars` are
 * declarations that build on them (appended after)
 */
function injectLighting(
  shader: WebGLProgramParametersWithUniforms, uniforms: object,
  pars: { vertex?: string; fragment?: string } = {},
): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\n" + COMMON + VERT_PARS + (pars.vertex ?? ""))
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + VERT_WORLD);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\n" + COMMON + SHADOW + VERT_PARS + (pars.fragment ?? ""))
    .replace(
      "#include <lights_fragment_begin>",
      "float cityKeyShadow = cityShadow(vCityWP, normalize((vec4(normal, 0.0) * viewMatrix).xyz)) * cityKeyGain(vCityWP);\n" + LIGHTS_BEGIN,
    );
}

// --- the road (stage floor) ------------------------------------------------------

const ROAD_PARS = /* glsl */ `
uniform vec3 uRoadsX[${MAX_ROADS}];
uniform vec3 uRoadsZ[${MAX_ROADS}];
uniform int uNumRoadsX;
uniform int uNumRoadsZ;
uniform float uCenterDashed; // 1: one dashed centre line (Paris), 0: a double line
`;

const ROAD_MARKS = /* glsl */ `
if (uCityOn > 0.5) {
  diffuseColor.rgb = vec3(0.43, 0.43, 0.425); // pale, model-like asphalt
  float bx = 1e9, bz = 1e9;
  vec3 rx = vec3(0.0), rz = vec3(0.0);
  for (int i = 0; i < ${MAX_ROADS}; i++) {
    if (i >= uNumRoadsX) break;
    float d = abs(vCityWP.x - uRoadsX[i].x) - uRoadsX[i].y;
    if (d < bx) { bx = d; rx = uRoadsX[i]; }
  }
  for (int i = 0; i < ${MAX_ROADS}; i++) {
    if (i >= uNumRoadsZ) break;
    float d = abs(vCityWP.z - uRoadsZ[i].x) - uRoadsZ[i].y;
    if (d < bz) { bz = d; rz = uRoadsZ[i]; }
  }
  bool inX = bx < 0.0, inZ = bz < 0.0;
  if (inX != inZ) {
    float lat = inX ? vCityWP.x - rx.x : vCityWP.z - rz.x;
    float along = inX ? vCityWP.z : vCityWP.x;
    float hw = inX ? rx.y : rz.y, mh = inX ? rx.z : rz.z;
    float crossD = inX ? bz : bx; // distance past the crossing road's edge
    float al = abs(lat);
    float lw = (hw - mh - 0.5) * 0.5;
    float run = step(6.6, crossD); // lines stop short of the crosswalk
    float paint = cityBand(crossD, 1.6, 4.8) * step(al, hw - 0.6) * cityStripes(lat + 0.3, 1.2, 0.5);
    if (uCenterDashed > 0.5 && mh < 0.5) paint = max(paint, cityBand(al, 0.0, 0.07) * cityStripes(along + 3.0, 6.0, 0.5) * run);
    else paint = max(paint, (cityBand(al, mh + 0.06, mh + 0.16) + cityBand(al, mh + 0.3, mh + 0.4) * step(0.5, mh)) * run);
    paint = max(paint, cityBand(al, mh + lw - 0.06, mh + lw + 0.06) * cityStripes(along, 9.0, 0.36) * run);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.66, 0.66, 0.65), paint * 0.75);
    if (al > hw - 0.4) diffuseColor.rgb = vec3(0.52, 0.52, 0.51); // gutter along the curb
  }
}
`;

/** the stage floor: model-like roads + markings, the city's shadows */
export function patchRoad(shader: WebGLProgramParametersWithUniforms, uniforms: object): void {
  injectLighting(shader, uniforms, { fragment: ROAD_PARS });
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <map_fragment>", "#include <map_fragment>\n" + ROAD_MARKS)
    // matte when dry (the wet shader glosses it after this)
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nif (uCityOn > 0.5) roughnessFactor = mix(0.8, 0.95, roughnessFactor);");
}

// --- the hero's site paving (the studio plinth) ------------------------------------

const PAVEMENT_PARS = /* glsl */ `
uniform vec2 uSiteHalf;
`;

const PAVEMENT = /* glsl */ `
if (uCityOn > 0.5) {
  // the curb runs along the site's edge (the plinth may be a few strips)
  float cEdge = min(uSiteHalf.x - abs(vCityWP.x), uSiteHalf.y - abs(vCityWP.z));
  vec3 cStone = vec3(0.6, 0.595, 0.58);
  if (vCityN.y < 0.5 || cEdge < 0.3) {
    diffuseColor.rgb = cStone * 1.12; // granite curb
  } else {
    // large-format pavers, 1.2 × 0.6 m, running bond, each a touch different
    vec2 cq = vCityWP.xz / vec2(1.2, 0.6);
    cq.x += 0.5 * mod(floor(cq.y), 2.0);
    vec2 cg = abs(fract(cq) - 0.5) * vec2(1.2, 0.6);
    float cj = 1.0 - smoothstep(0.006, 0.014 + fwidth(vCityWP.x) * 0.5, min(0.6 - cg.x * 2.0, 0.3 - cg.y * 2.0) * 0.5);
    float cTile = cityHash(vec3(floor(cq), 5.0));
    float cTex = dot(diffuseColor.rgb, vec3(0.33));
    diffuseColor.rgb = cStone * (0.93 + 0.12 * cTile) * (0.9 + 0.25 * cTex) * (1.0 - 0.35 * cj);
  }
}
`;

/** the hero's plinth: pavers + granite curb, the city's shadows */
export function patchPavement(shader: WebGLProgramParametersWithUniforms, uniforms: object): void {
  injectLighting(shader, uniforms, { fragment: PAVEMENT_PARS });
  shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n" + PAVEMENT);
}

// --- the massing model ------------------------------------------------------------

const KIT_VERT_PARS = /* glsl */ `
attribute vec4 aCity; // linear colour, kind
varying vec4 vCity;
`;

const KIT_FRAG_PARS = /* glsl */ `
varying vec4 vCity;
`;

/** white volumes; sidewalk slabs with a faint paving grid and a lighter curb */
const KIT_COLOR = /* glsl */ `
vec3 cityAlbedo = vCity.rgb;
if (vCity.a > ${f(S.SLAB - 0.5)}) {
  float edge = min(vCitySize.x * 0.5 - abs(vCityLocal.x), vCitySize.z * 0.5 - abs(vCityLocal.z));
  if (vCityN.y < 0.5 || edge < 0.3) cityAlbedo *= 1.04;
  else {
    vec2 g = abs(fract(vCityWP.xz / 1.5 + 0.5) - 0.5) * 1.5;
    cityAlbedo *= 1.0 - 0.06 * (1.0 - smoothstep(0.01, 0.03 + fwidth(vCityWP.x) * 0.5, min(g.x, g.y)));
  }
} else if (vCityN.y > 0.7) cityAlbedo *= 0.97; // roofs a touch darker than the walls
diffuseColor.rgb = cityAlbedo;
`;

/** the city's pieces — the massing-model material */
export function patchKit(shader: WebGLProgramParametersWithUniforms, uniforms: object): void {
  injectLighting(shader, uniforms, { vertex: KIT_VERT_PARS, fragment: KIT_FRAG_PARS });
  shader.vertexShader = shader.vertexShader.replace(
    "vCityWP = (cityM * vec4(transformed, 1.0)).xyz;",
    "vCityWP = (cityM * vec4(transformed, 1.0)).xyz;\n  vCity = aCity;",
  );
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <map_fragment>", "#include <map_fragment>\n" + KIT_COLOR)
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = 0.92;");
}
