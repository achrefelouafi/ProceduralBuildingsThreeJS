/**
 * Snow accumulation — ported from SnowSystemThreeJS's model "makeSnowy" shader and
 * restructured as a separate SNOW SHELL layer:
 *   - the building's own materials/geometry are never touched — a second instanced
 *     pass shares the same geometry + instanceMatrix buffers (no extra GPU memory)
 *     and only IT gets extruded along the normals;
 *   - fragments outside the accumulation mask are discarded, so the shell only shows
 *     as a snow cap on upward faces;
 *   - the building is drawn with InstancedMesh, so world normal/position fold in
 *     `instanceMatrix`, and accumulation keys off WORLD up (the building root is a
 *     Blender Z-up group rotated into world Y-up).
 *
 * `uTime` is shared with the falling snow so the sparkle twinkles in lockstep.
 */
import { Color, Vector2, DoubleSide, MeshStandardMaterial } from "three";

export interface SnowAccumUniforms {
  uTime: { value: number };
  uSnowSeed: { value: Vector2 };
  uSnowScale: { value: number };
  uSnowHeightVar: { value: number };
  uSnowCoverage: { value: number };
  uSnowEdge: { value: number };
  uSnowThickness: { value: number };
  uSnowFlatThreshold: { value: number };
  uSnowColor: { value: Color };
  uSnowRoughness: { value: number };
  uSnowSparkle: { value: number };
  uSnowSparkleScale: { value: number };
  uSnowBump: { value: number };
  uSnowBumpScale: { value: number };
}

export function createSnowAccumUniforms(uTime: { value: number }): SnowAccumUniforms {
  return {
    uTime,
    uSnowSeed: { value: new Vector2(3.0, 7.0) },
    uSnowScale: { value: 0.6 },        // coverage noise frequency (world units)
    uSnowHeightVar: { value: 0.35 },   // how much world-Y shears the mask (breaks per-floor repeat)
    uSnowCoverage: { value: 0.7 },     // 0 = bare, 1 = fully capped
    uSnowEdge: { value: 0.15 },        // coverage shoreline softness
    uSnowThickness: { value: 0.01 },   // displaced layer depth (world units)
    uSnowFlatThreshold: { value: 0.35 }, // how upward a face must be to collect
    uSnowColor: { value: new Color(0xeaf1ff) },
    uSnowRoughness: { value: 0.85 },
    uSnowSparkle: { value: 0.5 },
    uSnowSparkleScale: { value: 120.0 },
    uSnowBump: { value: 0.4 },
    uSnowBumpScale: { value: 3.0 },
  };
}

const SNOW_GLSL = /* glsl */ `
varying vec3 vSnowWorldN;
varying vec3 vSnowWorldP;
uniform float uTime;
uniform vec2  uSnowSeed;
uniform float uSnowScale;
uniform float uSnowHeightVar;
uniform float uSnowCoverage;
uniform float uSnowEdge;
uniform float uSnowThickness;
uniform float uSnowFlatThreshold;
uniform vec3  uSnowColor;
uniform float uSnowRoughness;
uniform float uSnowSparkle;
uniform float uSnowSparkleScale;
uniform float uSnowBump;
uniform float uSnowBumpScale;

vec3 snowPermute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snowNoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = snowPermute(snowPermute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
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
float snowFbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) { value += amp * snowNoise(p); p *= 2.0; amp *= 0.5; }
  return value;
}
float snowHash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float snowCoverageMask(vec3 worldP) {
  // Shear the XZ sample by world height so the mask varies floor-to-floor
  // instead of projecting the same pattern down the whole facade. The distinct
  // per-axis coefficients also decorrelate this from the wet mask.
  vec2 xz = worldP.xz + worldP.y * uSnowHeightVar * vec2(0.7, -1.3);
  float n = snowFbm(xz * uSnowScale + uSnowSeed) * 0.5 + 0.5;
  float threshold = 1.0 - uSnowCoverage;
  return smoothstep(threshold - uSnowEdge, threshold + uSnowEdge, n);
}
float snowAccumAt(vec3 worldNormal, vec3 worldP) {
  float up = clamp(worldNormal.y, 0.0, 1.0);
  float top = smoothstep(uSnowFlatThreshold, 1.0, up);
  return top * snowCoverageMask(worldP);
}
vec3 snowReliefNormal(vec2 worldXZ) {
  float e = 0.04;
  float h0 = snowFbm(worldXZ * uSnowBumpScale);
  float hx = snowFbm(worldXZ * uSnowBumpScale + vec2(e, 0.0));
  float hz = snowFbm(worldXZ * uSnowBumpScale + vec2(0.0, e));
  vec2 grad = vec2(hx - h0, hz - h0) / e;
  return normalize(vec3(-grad.x * uSnowBump, 1.0, -grad.y * uSnowBump));
}
`;

/**
 * The snow-shell material: applied to a duplicate instanced pass that shares the
 * building's geometry. Extrudes along the surface normal by thickness × accumulation
 * and discards every fragment outside the snow mask — the base building underneath
 * renders with its original, untouched geometry and materials.
 */
export function createSnowShellMaterial(u: SnowAccumUniforms): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    side: DoubleSide,
    // wins the depth tie against the base surface where thickness tapers to zero
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + SNOW_GLSL)
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          mat3 snowNMat = mat3(modelMatrix) * mat3(instanceMatrix);
        #else
          mat3 snowNMat = mat3(modelMatrix);
        #endif
        vSnowWorldN = normalize(snowNMat * objectNormal);`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec4 snowWP = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        #else
          vec4 snowWP = modelMatrix * vec4(transformed, 1.0);
        #endif
        vSnowWorldP = snowWP.xyz;
        vec3 snowWN = snowNMat * objectNormal;
        float snowMs = max(length(snowWN), 1e-4);
        float snowAccumV = snowAccumAt(snowWN / snowMs, vSnowWorldP);
        transformed += normalize(objectNormal) * (uSnowThickness * snowAccumV / snowMs);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + SNOW_GLSL)
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 snowWn = normalize(vSnowWorldN);
        float snowAmt = snowAccumAt(snowWn, vSnowWorldP);
        if (snowAmt < 0.12) discard; // shell only exists where snow settled
        float snowShade = 0.85 + 0.15 * (snowFbm(vSnowWorldP.xz * uSnowBumpScale * 2.0) * 0.5 + 0.5);
        float snowSp = snowHash21(floor(vSnowWorldP.xz * uSnowSparkleScale));
        float snowTwinkle = 0.5 + 0.5 * sin(uTime * 3.0 + snowSp * 30.0);
        float snowSparkle = step(0.985, snowSp) * snowTwinkle * uSnowSparkle;
        diffuseColor.rgb = uSnowColor * snowShade + snowSparkle;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = uSnowRoughness;
        roughnessFactor = mix(roughnessFactor, 0.08, snowSparkle);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        vec3 snowN = snowReliefNormal(vSnowWorldP.xz);
        vec3 snowView = normalize((viewMatrix * vec4(snowN, 0.0)).xyz);
        normal = normalize(mix(normal, snowView, clamp(snowAmt * 1.5, 0.0, 1.0)));`,
      );
  };
  mat.customProgramCacheKey = () => "snow-shell-v1";
  return mat;
}
