/**
 * Compiles a graph building's Blender material node trees
 * (public/assets/<nyc|cn>/materials.json, tools/nyc/export_nyc_materials.py,
 * tools/cn/export_cn_materials.py) to GLSL injected into three's
 * MeshPhysicalMaterial, so tints, ramps, triplanar scales and rotations come
 * straight from the .blend instead of being re-typed.
 *
 * Spaces: Geometry.Position / Normal are Blender world space of the building
 * object (uniform uNycFromWorld), Texture Coordinate.Object is the
 * instance-local mesh position. Attribute nodes read INSTANCER values from
 * instanced attributes (ai_<name>) and GEOMETRY values from vertex attributes
 * (ag_<name>); UV Map and Color Attribute nodes read the mesh's UVMap / Col
 * the same way, and Normal Map (tangent space) builds its tangent frame from
 * screen-space derivatives of the UVs.
 * Shader closures: Principled (with Alpha) / Emission / Transparent / Mix
 * Shader. A transparent side selected by Backfacing discards back faces;
 * transparency of a BLENDED material (or a Transparent BSDF) renders
 * alpha-blended (the glass); alpha of a DITHERED material is clipped at 0.5
 * (leaves, decals).
 */
import {
  Color, DoubleSide, FrontSide, Matrix3, Matrix4, MeshPhysicalMaterial, RepeatWrapping, ClampToEdgeWrapping,
  SRGBColorSpace, NoColorSpace, LinearMipmapLinearFilter, TextureLoader, Vector3, type Texture,
} from "three";

export interface MatSocket { name: string; type: string; enabled: boolean; value?: unknown }
export interface MatNode {
  name: string; type: string; props: Record<string, unknown>; inputs: MatSocket[]; outputs: MatSocket[];
  ramp?: { interp: string; stops: [number, number[]][] }; image?: string;
}
export interface MatGraph { blend: string; backface_culling: boolean; nodes: MatNode[]; links: { from: string; fi: number; to: string; ti: number }[] }
export interface MaterialsJson { materials: Record<string, MatGraph>; images: Record<string, { file: string; srgb: boolean }> }

/** where each attribute lives inside the packed vec4 vertex attributes */
export interface AttrPacking {
  packs: number; // number of vec4 attributes (<prefix>0 … <prefix>N-1)
  slots: Map<string, { pack: number; off: number; size: number }>;
}

export interface NycMaterial {
  material: MeshPhysicalMaterial;
  /** attribute names read with type INSTANCER / GEOMETRY (floats per element) */
  instAttrs: Map<string, number>;
  geoAttrs: Map<string, number>;
  /** WebGL has 16 vertex attributes: they travel packed as vec4 (aip* instanced, agp* per vertex) */
  instPack: AttrPacking;
  geoPack: AttrPacking;
  transparent: boolean;
  emissive: boolean;
}

function pack(attrs: Map<string, number>): AttrPacking {
  const slots: AttrPacking["slots"] = new Map();
  const fill: number[] = [];
  const sorted = [...attrs].sort((a, b) => b[1] - a[1]);
  for (const [name, size] of sorted) {
    let p = fill.findIndex(used => used + size <= 4);
    if (p < 0) { fill.push(0); p = fill.length - 1; }
    slots.set(name, { pack: p, off: fill[p], size });
    fill[p] += size;
  }
  return { packs: fill.length, slots };
}
const swz = (off: number, size: number) => "xyzw".slice(off, off + size);

type T = "f" | "v"; // float / vec3 (colors are vec3; alpha dropped)
interface E { c: string; t: T }
interface Closure { base: string; metal: string; rough: string; nrm: string; emit: string; tr: string; alpha: string }

const glf = (x: number) => { const s = String(Math.fround(x)); return /[.eE]/.test(s) ? s : s + ".0"; };
const v3 = (a: unknown): string => {
  const arr = Array.isArray(a) ? (a as number[]) : [Number(a) || 0, Number(a) || 0, Number(a) || 0];
  return `vec3(${glf(arr[0] ?? 0)}, ${glf(arr[1] ?? 0)}, ${glf(arr[2] ?? 0)})`;
};
const asF = (e: E, color = false): string =>
  e.t === "f" ? e.c : color ? `dot(${e.c}, vec3(0.2126, 0.7152, 0.0722))` : `((${e.c}).x + (${e.c}).y + (${e.c}).z) / 3.0`;
const asV = (e: E): string => (e.t === "v" ? e.c : `vec3(${e.c})`);
/** Blender's euler_to_mat3 as a GLSL literal (column-major, like nycEuler) */
const eulerMat3 = ([x, y, z]: number[]): string => {
  const [cx, cy, cz, sx, sy, sz] = [Math.cos(x), Math.cos(y), Math.cos(z), Math.sin(x), Math.sin(y), Math.sin(z)];
  const m = [cy * cz, cy * sz, -sy, sy * sx * cz - cx * sz, sy * sx * sz + cx * cz, cy * sx, sy * cx * cz + sx * sz, sy * cx * sz - sx * cz, cy * cx];
  return `mat3(${m.map(glf).join(", ")})`;
};

const GLSL_LIB = /* glsl */ `
float nycSafeDiv(float a, float b) { return b == 0.0 ? 0.0 : a / b; }
float nycMod(float a, float b) { return b == 0.0 ? 0.0 : a - floor(a / b) * b; }
float nycPow(float a, float b) { return (a >= 0.0 || b == floor(b)) ? pow(abs(a), b) * ((a < 0.0 && mod(b, 2.0) == 1.0) ? -1.0 : 1.0) : 0.0; }
float nycSmin(float a, float b, float c) {
  if (c != 0.0) { float h = max(c - abs(a - b), 0.0) / c; return min(a, b) - h * h * h * c * (1.0 / 6.0); }
  return min(a, b);
}
vec3 nycHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float nycPerlin(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  #define G(o) dot(nycHash3(i + o) * 2.0 - 1.0, f - o)
  return mix(mix(mix(G(vec3(0,0,0)), G(vec3(1,0,0)), u.x), mix(G(vec3(0,1,0)), G(vec3(1,1,0)), u.x), u.y),
             mix(mix(G(vec3(0,0,1)), G(vec3(1,0,1)), u.x), mix(G(vec3(0,1,1)), G(vec3(1,1,1)), u.x), u.y), u.z);
  #undef G
}
// Noise Texture (3D FBM, normalized): Blender's fractal_noise with fractional detail
float nycNoise(vec3 p, float detail, float rough, float lacun) {
  float sum = 0.0, amp = 1.0, maxAmp = 0.0, fq = 1.0;
  int n = int(clamp(detail, 0.0, 15.0));
  for (int i = 0; i <= 15; i++) {
    if (i > n) break;
    sum += nycPerlin(p * fq) * amp; maxAmp += amp; amp *= clamp(rough, 0.0, 1.0); fq *= lacun;
  }
  float rmd = detail - floor(detail);
  float r = 0.5 * sum / maxAmp * 1.6 + 0.5;
  if (rmd != 0.0) {
    float s2 = sum + nycPerlin(p * fq) * amp;
    float r2 = 0.5 * s2 / (maxAmp + amp) * 1.6 + 0.5;
    r = mix(r, r2, rmd);
  }
  return r;
}
vec3 nycNoiseColor(vec3 p, float d, float r, float l) {
  return vec3(nycNoise(p, d, r, l), nycNoise(p + vec3(97.1, 13.7, 51.3), d, r, l), nycNoise(p + vec3(31.9, 77.3, 5.1), d, r, l));
}
float nycVoronoiF1(vec3 p, float rnd) {
  vec3 c = floor(p), f = fract(p);
  float d = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(x, y, z);
    vec3 q = o + nycHash3(c + o) * rnd - f;
    d = min(d, length(q));
  }
  return d;
}
// Blender's rgb_to_hsv / hsv_to_rgb (gpu_shader_common_color_utils.glsl), with its branches:
// the usual branchless mix/step version miscompiles on ANGLE D3D11 (AMD iGPU), mirroring the
// hue of warm colours to magenta (the NYC brick rendered pink)
vec3 nycRgb2Hsv(vec3 c) {
  float cmax = max(c.r, max(c.g, c.b)), cd = cmax - min(c.r, min(c.g, c.b));
  float s = cmax != 0.0 ? cd / cmax : 0.0, h = 0.0;
  if (s != 0.0) {
    vec3 k = (vec3(cmax) - c) / cd;
    if (c.r >= cmax) h = k.b - k.g;
    else if (c.g >= cmax) h = 2.0 + k.r - k.b;
    else h = 4.0 + k.g - k.r;
    h /= 6.0;
    if (h < 0.0) h += 1.0;
  }
  return vec3(h, s, cmax);
}
vec3 nycHsv2Rgb(vec3 hsv) {
  float h = hsv.x, s = hsv.y, v = hsv.z;
  if (s == 0.0) return vec3(v);
  if (h == 1.0) h = 0.0;
  h *= 6.0;
  float i = floor(h), f = h - i;
  float p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
  if (i == 0.0) return vec3(v, t, p);
  if (i == 1.0) return vec3(q, v, p);
  if (i == 2.0) return vec3(p, v, t);
  if (i == 3.0) return vec3(p, q, v);
  if (i == 4.0) return vec3(t, p, v);
  return vec3(v, p, q);
}
vec3 nycHueSat(float h, float s, float v, float fac, vec3 col) {
  vec3 hsv = nycRgb2Hsv(col);
  hsv.x = fract(hsv.x + h + 0.5);
  hsv.y = clamp(hsv.y * s, 0.0, 1.0);
  hsv.z *= v;
  return mix(col, max(nycHsv2Rgb(hsv), vec3(0.0)), fac);
}
// Blender's euler_to_mat3 (Mapping's rotation, XYZ Euler)
mat3 nycEuler(vec3 e) {
  vec3 c = cos(e), s = sin(e);
  return mat3(c.y * c.z, c.y * s.z, -s.y,
              s.y * s.x * c.z - c.x * s.z, s.y * s.x * s.z + c.x * c.z, c.y * s.x,
              s.y * c.x * c.z + s.x * s.z, s.y * c.x * s.z - s.x * c.z, c.y * c.x);
}
vec3 nycRotZ(vec3 v, vec3 c, float a) {
  vec3 d = v - c;
  float s = sin(a), co = cos(a);
  return vec3(co * d.x - s * d.y, s * d.x + co * d.y, d.z) + c;
}
float nycFresnel(float cosi, float eta) {
  float c = abs(cosi);
  float g = eta * eta - 1.0 + c * c;
  if (g > 0.0) {
    g = sqrt(g);
    float A = (g - c) / (g + c);
    float B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
    return 0.5 * A * A * (1.0 + B * B);
  }
  return 1.0;
}
vec3 nycBump(float strength, float dist, float h, vec3 N, vec3 P) {
  vec3 dPdx = dFdx(P), dPdy = dFdy(P);
  vec3 Rx = cross(dPdy, N), Ry = cross(N, dPdx);
  float det = dot(dPdx, Rx);
  vec3 surfgrad = dFdx(h) * Rx + dFdy(h) * Ry;
  vec3 NN = normalize(abs(det) * N - dist * sign(det) * surfgrad);
  return normalize(mix(N, NN, max(strength, 0.0)));
}
// Normal Map (tangent space): the tangent frame from screen-space derivatives of P and the UVs
vec3 nycNormalMap(float strength, vec3 col, vec3 N, vec3 P, vec2 uv) {
  vec3 dp1 = dFdx(P), dp2 = dFdy(P);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float m = max(dot(T, T), dot(B, B));
  if (m < 1e-20) return N;
  float s = inversesqrt(m);
  vec3 n = normalize(mat3(T * s, B * s, N) * (col * 2.0 - 1.0));
  return normalize(mix(N, n, max(strength, 0.0)));
}
vec3 nycBox(sampler2D t, vec3 p, vec3 n, float blend) {
  vec3 w = abs(n);
  if (blend > 0.0) { w = max(w - (0.5 - blend * 0.5), 0.0); } else { w = step(max(max(w.x, w.y), w.z), w); }
  w /= max(w.x + w.y + w.z, 1e-5);
  return texture2D(t, p.yz).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z;
}
`;

class Compiler {
  private nodes = new Map<string, MatNode>();
  private incoming = new Map<string, { from: string; fi: number }>();
  private memo = new Map<string, E | Closure>();
  lines: string[] = [];
  private k = 0;
  instAttrs = new Map<string, number>();
  geoAttrs = new Map<string, number>();
  samplers = new Map<string, string>(); // uniform name → image file
  usesBackfacing = false;
  constructor(readonly g: MatGraph) {
    for (const n of g.nodes) this.nodes.set(n.name, n);
    for (const l of g.links) this.incoming.set(`${l.to}|${l.ti}`, { from: l.from, fi: l.fi });
    // an attribute read through its Vector / Color output travels as a vec3
    // (a float one broadcasts, and its Factor averages the three, like Blender)
    for (const n of g.nodes) {
      if (n.type !== "ShaderNodeAttribute") continue;
      const vec = g.links.some(l => l.from === n.name && ["Vector", "Color"].includes(n.outputs[l.fi].name));
      if (vec) (n.props.attribute_type === "INSTANCER" ? this.instAttrs : this.geoAttrs).set(String(n.props.attribute_name), 3);
    }
  }
  private tmp(t: T, expr: string): E {
    const name = `n${this.k++}`;
    this.lines.push(`${t === "f" ? "float" : "vec3"} ${name} = ${expr};`);
    return { c: name, t };
  }
  inp(n: MatNode, name: string, nth = 0): E {
    // Blender 5 renamed "Fac" sockets to "Factor"; accept either
    const names = name === "Fac" || name === "Factor" ? ["Fac", "Factor"] : [name];
    const idx = n.inputs.map((s, i) => [s, i] as const).filter(([s]) => names.includes(s.name) && s.enabled)[nth]?.[1];
    if (idx === undefined) throw new Error(`material ${n.type} has no input ${name}`);
    return this.inputAt(n, idx);
  }
  linked(n: MatNode, name: string): boolean {
    const idx = n.inputs.findIndex(s => s.name === name && s.enabled);
    return this.incoming.has(`${n.name}|${idx}`);
  }
  inputAt(n: MatNode, i: number): E {
    const l = this.incoming.get(`${n.name}|${i}`);
    const s = n.inputs[i];
    const want: T = ["RGBA", "VECTOR"].includes(s.type) ? "v" : "f";
    if (!l) {
      if (want === "v") return { c: v3(s.value ?? [0, 0, 0]), t: "v" };
      return { c: glf(Number(s.value ?? 0)), t: "f" };
    }
    const e = this.out(l.from, l.fi) as E;
    const from = this.nodes.get(l.from)!.outputs[l.fi];
    if (want === "v") return { c: asV(e), t: "v" };
    return { c: asF(e, from.type === "RGBA"), t: "f" };
  }
  closureIn(n: MatNode, i: number): Closure | null {
    const l = this.incoming.get(`${n.name}|${i}`);
    return l ? (this.out(l.from, l.fi) as Closure) : null;
  }
  out(nodeName: string, idx: number): E | Closure {
    const key = `${nodeName}|${idx}`;
    const m = this.memo.get(key);
    if (m) return m;
    const n = this.nodes.get(nodeName)!;
    const r = this.node(n, idx);
    this.memo.set(key, r);
    return r;
  }

  node(n: MatNode, idx: number): E | Closure {
    const P = n.props;
    const f = (name: string, nth = 0) => asF(this.inp(n, name, nth));
    const v = (name: string, nth = 0) => asV(this.inp(n, name, nth));
    switch (n.type) {
      case "ShaderNodeNewGeometry": {
        const o = n.outputs[idx].name;
        if (o === "Position") return { c: "vNycP", t: "v" };
        if (o === "Normal") return { c: "nycN", t: "v" };
        if (o === "Backfacing") { this.usesBackfacing = true; return { c: "(gl_FrontFacing ? 0.0 : 1.0)", t: "f" }; }
        throw new Error(`material: Geometry.${o}`);
      }
      case "ShaderNodeUVMap": {
        this.geoAttrs.set(String(P.uv_map || "UVMap"), 2);
        return { c: `vec3(vag_${String(P.uv_map || "UVMap")}, 0.0)`, t: "v" };
      }
      case "ShaderNodeVertexColor": {
        const name = String(P.layer_name || "Col");
        this.geoAttrs.set(name, 4);
        return n.outputs[idx].name === "Alpha" ? { c: `vag_${name}.a`, t: "f" } : { c: `vag_${name}.rgb`, t: "v" };
      }
      case "ShaderNodeNormalMap": {
        if (P.space !== "TANGENT") throw new Error("material: normal map space");
        const uv = String(P.uv_map || "UVMap");
        this.geoAttrs.set(uv, 2);
        return this.tmp("v", `nycNormalMap(${f("Strength")}, ${v("Color")}, nycN, vNycP, vag_${uv})`);
      }
      case "ShaderNodeTexCoord": {
        const o = n.outputs[idx].name;
        if (o === "Object") return { c: "vNycO", t: "v" };
        throw new Error(`material: Texture Coordinate.${o}`);
      }
      case "ShaderNodeAttribute": {
        const name = String(P.attribute_name);
        const vec = n.outputs[idx].name === "Color" || n.outputs[idx].name === "Vector";
        const map = P.attribute_type === "INSTANCER" ? this.instAttrs : this.geoAttrs;
        if (P.attribute_type !== "INSTANCER" && P.attribute_type !== "GEOMETRY") throw new Error("material: attribute type");
        const pre = P.attribute_type === "INSTANCER" ? "vai_" : "vag_";
        const size = map.get(name) ?? 1;
        map.set(name, size);
        const c = `${pre}${name}`;
        if (vec) return size === 3 ? { c, t: "v" } : { c: `vec3(${c})`, t: "v" };
        return size === 3 ? { c: `((${c}).x + (${c}).y + (${c}).z) / 3.0`, t: "f" } : { c, t: "f" };
      }
      case "ShaderNodeMath": {
        const a = asF(this.inputAt(n, 0)), b = asF(this.inputAt(n, 1)), c = asF(this.inputAt(n, 2));
        const op = String(P.operation);
        const ex: Record<string, string> = {
          ADD: `${a} + ${b}`, SUBTRACT: `${a} - ${b}`, MULTIPLY: `${a} * ${b}`, DIVIDE: `nycSafeDiv(${a}, ${b})`,
          MULTIPLY_ADD: `${a} * ${b} + ${c}`, POWER: `nycPow(${a}, ${b})`, MINIMUM: `min(${a}, ${b})`, MAXIMUM: `max(${a}, ${b})`,
          LESS_THAN: `(${a} < ${b} ? 1.0 : 0.0)`, GREATER_THAN: `(${a} > ${b} ? 1.0 : 0.0)`, ABSOLUTE: `abs(${a})`,
          FLOOR: `floor(${a})`, FRACT: `fract(${a})`, FLOORED_MODULO: `nycMod(${a}, ${b})`, SMOOTH_MIN: `nycSmin(${a}, ${b}, ${c})`,
          SINE: `sin(${a})`, COSINE: `cos(${a})`, SQRT: `sqrt(max(${a}, 0.0))`, ROUND: `floor(${a} + 0.5)`,
        };
        if (!(op in ex)) throw new Error(`material: math ${op}`);
        const r = ex[op];
        return this.tmp("f", P.use_clamp ? `clamp(${r}, 0.0, 1.0)` : r);
      }
      case "ShaderNodeVectorMath": {
        const op = String(P.operation);
        if (op === "ADD") return this.tmp("v", `${asV(this.inputAt(n, 0))} + ${asV(this.inputAt(n, 1))}`);
        if (op === "SCALE") return this.tmp("v", `${asV(this.inputAt(n, 0))} * ${asF(this.inputAt(n, 3))}`);
        if (op === "SUBTRACT") return this.tmp("v", `${asV(this.inputAt(n, 0))} - ${asV(this.inputAt(n, 1))}`);
        if (op === "ABSOLUTE") return this.tmp("v", `abs(${asV(this.inputAt(n, 0))})`);
        if (op === "FLOOR") return this.tmp("v", `floor(${asV(this.inputAt(n, 0))})`);
        if (op === "LENGTH") return idx === 1 ? this.tmp("f", `length(${asV(this.inputAt(n, 0))})`) : { c: "vec3(0.0)", t: "v" };
        throw new Error(`material: vector math ${op}`);
      }
      case "ShaderNodeSeparateXYZ": return { c: `(${v("Vector")}).${"xyz"[idx]}`, t: "f" };
      case "ShaderNodeCombineXYZ": return this.tmp("v", `vec3(${f("X")}, ${f("Y")}, ${f("Z")})`);
      case "ShaderNodeCombineColor": return this.tmp("v", `vec3(${f("Red")}, ${f("Green")}, ${f("Blue")})`);
      case "ShaderNodeSeparateColor": {
        if (P.mode !== "RGB") throw new Error(`material: separate color ${P.mode}`);
        return { c: `(${v("Color")}).${"xyz"[idx]}`, t: "f" };
      }
      case "ShaderNodeMapRange": {
        if (P.data_type !== "FLOAT") throw new Error("material: map range type");
        const [x, a, b, c, d] = ["Value", "From Min", "From Max", "To Min", "To Max"].map(s => f(s));
        const t = this.tmp("f", `nycSafeDiv(${x} - ${a}, ${b} - ${a})`).c;
        const it = String(P.interpolation_type ?? "LINEAR");
        if (it === "LINEAR") {
          const r = `${c} + ${t} * (${d} - ${c})`;
          return this.tmp("f", P.clamp ? `clamp(${r}, min(${c}, ${d}), max(${c}, ${d}))` : r);
        }
        const u = this.tmp("f", `clamp(${t}, 0.0, 1.0)`).c;
        const ease = it === "SMOOTHSTEP" ? `${u} * ${u} * (3.0 - 2.0 * ${u})`
          : it === "SMOOTHERSTEP" ? `${u} * ${u} * ${u} * (${u} * (${u} * 6.0 - 15.0) + 10.0)` : "";
        if (!ease) throw new Error(`material: map range ${it}`);
        return this.tmp("f", `${c} + (${ease}) * (${d} - ${c})`);
      }
      case "ShaderNodeMapping": {
        const loc = v("Location"), scl = v("Scale");
        const rot = n.inputs.find(s => s.name === "Rotation");
        const turned = this.linked(n, "Rotation") || (Array.isArray(rot?.value) && (rot.value as number[]).some(x => x !== 0));
        if (!turned) return this.tmp("v", `${v("Vector")} * ${scl} + ${loc}`);
        if (P.vector_type !== "POINT") throw new Error(`material: rotated mapping ${P.vector_type}`);
        // a constant rotation is a literal matrix (folding nycEuler's trig trips D3D precision warnings)
        const R = this.linked(n, "Rotation") ? `nycEuler(${v("Rotation")})` : eulerMat3(rot!.value as number[]);
        return this.tmp("v", `${R} * (${v("Vector")} * ${scl}) + ${loc}`);
      }
      case "ShaderNodeVectorRotate": {
        if (P.rotation_type !== "Z_AXIS" || P.invert) throw new Error("material: vector rotate mode");
        return this.tmp("v", `nycRotZ(${v("Vector")}, ${v("Center")}, ${f("Angle")})`);
      }
      case "ShaderNodeMix": {
        if (P.data_type !== "RGBA") throw new Error("material: mix type");
        let fac = asF(this.inp(n, "Factor"));
        if (P.clamp_factor) fac = `clamp(${fac}, 0.0, 1.0)`;
        // the RGBA A/B sockets are the 3rd of each same-named triple
        const a = asV(this.inputAt(n, n.inputs.findIndex(s => s.name === "A" && s.type === "RGBA")));
        const b = asV(this.inputAt(n, n.inputs.findIndex(s => s.name === "B" && s.type === "RGBA")));
        const bt = String(P.blend_type);
        const r = bt === "MIX" ? `mix(${a}, ${b}, ${fac})` : bt === "MULTIPLY" ? `mix(${a}, ${a} * ${b}, ${fac})` : "";
        if (!r) throw new Error(`material: mix ${bt}`);
        return this.tmp("v", P.clamp_result ? `clamp(${r}, 0.0, 1.0)` : r);
      }
      case "ShaderNodeHueSaturation":
        return this.tmp("v", `nycHueSat(${f("Hue")}, ${f("Saturation")}, ${f("Value")}, ${f("Fac")}, ${v("Color")})`);
      case "ShaderNodeValToRGB": {
        const r = n.ramp!;
        const t = asF(this.inp(n, "Fac"));
        const x = this.tmp("f", `clamp(${t}, 0.0, 1.0)`);
        const stops = r.stops;
        let expr = v3(stops[0][1]);
        for (let i = 1; i < stops.length; i++) {
          const [p1, c1] = stops[i], [p0, c0] = stops[i - 1];
          if (r.interp === "CONSTANT") expr = `(${x.c} >= ${glf(p1)} ? ${v3(c1)} : ${expr})`;
          else expr = `(${x.c} >= ${glf(p0)} ? mix(${v3(c0)}, ${v3(c1)}, clamp((${x.c} - ${glf(p0)}) / max(${glf(p1 - p0)}, 1e-6), 0.0, 1.0)) : ${expr})`;
        }
        if (idx !== 0) return { c: "1.0", t: "f" };
        return this.tmp("v", expr);
      }
      case "ShaderNodeTexImage": {
        const u = `uNycTex${this.samplers.size}`;
        let uname = [...this.samplers.entries()].find(([, file]) => file === n.image)?.[0];
        if (!uname) { uname = u; this.samplers.set(uname, n.image!); }
        const vec = this.linked(n, "Vector") ? v("Vector") : "vNycO";
        const clampUV = P.extension === "EXTEND";
        const col = P.projection === "BOX"
          ? this.tmp("v", `nycBox(${uname}, ${vec}, vNycON, ${glf(Number(P.projection_blend ?? 0))})`)
          : this.tmp("v", `texture2D(${uname}, ${clampUV ? `clamp((${vec}).xy, 0.0, 1.0)` : `(${vec}).xy`}).rgb`);
        return idx === 0 ? col : { c: "1.0", t: "f" };
      }
      case "ShaderNodeTexNoise": {
        const vec = this.linked(n, "Vector") ? v("Vector") : "vNycO";
        const p = this.tmp("v", `${vec} * ${f("Scale")}`);
        const args = `${p.c}, ${f("Detail")}, ${f("Roughness")}, ${f("Lacunarity")}`;
        return n.outputs[idx].name === "Color" ? this.tmp("v", `nycNoiseColor(${args})`) : this.tmp("f", `nycNoise(${args})`);
      }
      case "ShaderNodeTexWhiteNoise": {
        const dim = String(P.noise_dimensions ?? "3D");
        let vec = this.linked(n, "Vector") ? v("Vector") : "vNycO";
        if (dim === "1D") vec = `vec3(${f("W")}, 0.0, 0.0)`;
        else if (dim === "2D") vec = `vec3((${vec}).xy, 0.0)`;
        else if (dim === "4D") vec = `(${vec} + vec3(${f("W")}))`;
        const h = this.tmp("v", `nycHash3(floor(${vec} * 1000.0) + ${vec})`);
        return n.outputs[idx].name === "Color" ? h : { c: `${h.c}.x`, t: "f" };
      }
      case "ShaderNodeTexVoronoi": {
        const vec = this.linked(n, "Vector") ? v("Vector") : "vNycO";
        const d = this.tmp("f", `nycVoronoiF1(${vec} * ${f("Scale")}, ${f("Randomness")})`);
        if (n.outputs[idx].name === "Distance") return d;
        return this.tmp("v", `nycHash3(floor(${vec} * ${f("Scale")}))`);
      }
      case "ShaderNodeLayerWeight": {
        const blend = f("Blend");
        const N = this.linked(n, "Normal") ? v("Normal") : "nycN";
        const cosi = `dot(normalize(${N}), normalize(uNycCamB - vNycP))`;
        if (n.outputs[idx].name === "Fresnel")
          return this.tmp("f", `nycFresnel(${cosi}, 1.0 / max(1.0 - clamp(${blend}, 0.0, 0.99999), 1e-5))`);
        return this.tmp("f", `1.0 - pow(abs(${cosi}), ${blend} < 0.5 ? 2.0 * ${blend} : 0.5 / (1.0 - ${blend}))`);
      }
      // edge rounding: approximated by the shading normal
      case "ShaderNodeBevel": return this.linked(n, "Normal") ? { c: v("Normal"), t: "v" } : { c: "nycN", t: "v" };
      case "ShaderNodeBump": {
        const N = this.linked(n, "Normal") ? v("Normal") : "nycN";
        const dist = `${f("Distance")}${P.invert ? " * -1.0" : ""}`;
        return this.tmp("v", `nycBump(${f("Strength")}, ${dist}, ${f("Height")}, ${N}, vNycP)`);
      }
      // ---------- closures
      case "ShaderNodeBsdfPrincipled": {
        const nrm = this.linked(n, "Normal") ? v("Normal") : "nycN";
        const alpha = this.linked(n, "Alpha") ? f("Alpha") : glf(Number(n.inputs.find(s => s.name === "Alpha")?.value ?? 1));
        return {
          base: v("Base Color"), metal: f("Metallic"), rough: f("Roughness"), nrm,
          emit: `(${v("Emission Color")} * ${f("Emission Strength")})`, tr: "0.0", alpha,
        };
      }
      case "ShaderNodeEmission":
        return { base: "vec3(0.0)", metal: "0.0", rough: "1.0", nrm: "nycN", emit: `(${v("Color")} * ${f("Strength")})`, tr: "0.0", alpha: "1.0" };
      case "ShaderNodeBsdfTransparent":
        return { base: "vec3(0.0)", metal: "0.0", rough: "1.0", nrm: "nycN", emit: "vec3(0.0)", tr: "1.0", alpha: "1.0" };
      case "ShaderNodeMixShader": {
        const fac = this.tmp("f", `clamp(${f("Fac")}, 0.0, 1.0)`).c;
        const empty: Closure = { base: "vec3(0.0)", metal: "0.0", rough: "1.0", nrm: "nycN", emit: "vec3(0.0)", tr: "0.0", alpha: "1.0" };
        const a = this.closureIn(n, 1) ?? empty, b = this.closureIn(n, 2) ?? empty;
        return {
          base: this.tmp("v", `mix(${a.base}, ${b.base}, ${fac})`).c,
          metal: this.tmp("f", `mix(${a.metal}, ${b.metal}, ${fac})`).c,
          rough: this.tmp("f", `mix(${a.rough}, ${b.rough}, ${fac})`).c,
          nrm: this.tmp("v", `normalize(mix(${a.nrm}, ${b.nrm}, ${fac}))`).c,
          emit: this.tmp("v", `mix(${a.emit}, ${b.emit}, ${fac})`).c,
          tr: this.tmp("f", `mix(${a.tr}, ${b.tr}, ${fac})`).c,
          alpha: this.tmp("f", `mix(${a.alpha}, ${b.alpha}, ${fac})`).c,
        };
      }
      default:
        throw new Error(`material: unsupported node ${n.type}`);
    }
  }

  compile(): Closure {
    const out = this.g.nodes.find(n => n.type === "ShaderNodeOutputMaterial" && n.props.is_active_output !== false)
      ?? this.g.nodes.find(n => n.type === "ShaderNodeOutputMaterial");
    if (!out) throw new Error("material: no output");
    const c = this.closureIn(out, 0);
    if (!c) throw new Error("material: no surface");
    // pin every closure term to a local
    return {
      base: this.tmp("v", c.base).c, metal: this.tmp("f", c.metal).c, rough: this.tmp("f", c.rough).c,
      nrm: this.tmp("v", `normalize(${c.nrm})`).c, emit: this.tmp("v", c.emit).c, tr: this.tmp("f", c.tr).c,
      alpha: c.alpha === "1.0" ? "1.0" : this.tmp("f", c.alpha).c,
    };
  }
}

const loader = new TextureLoader();
const texCache = new Map<string, Promise<Texture>>();
function loadTex(url: string, srgb: boolean): Promise<Texture> {
  let p = texCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then(t => {
      t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
      t.wrapS = t.wrapT = RepeatWrapping;
      t.minFilter = LinearMipmapLinearFilter;
      t.anisotropy = 8;
      return t;
    });
    texCache.set(url, p);
  }
  return p;
}

/** shared by every NYC material: Blender space of the NYC_Building object */
export const nycSpace = {
  uNycFromWorld: { value: new Matrix4() },
  uNycNormalToWorld: { value: new Matrix3() },
  /** camera position in Blender space (Layer Weight's incoming vector) */
  uNycCamB: { value: new Vector3() },
  /** lighting-mood gain on window / sign / lamp emission (studio "room brightness") */
  uNycEmitGain: { value: 1 },
};

/** texBase: the folder of the building's textures (…/assets/<nyc|cn>/tex/) */
export async function compileMaterial(name: string, g: MatGraph, json: MaterialsJson, texBase: string): Promise<NycMaterial> {
  const c = new Compiler(g);
  const cl = c.compile();
  const transparentByBackface = c.usesBackfacing;
  // alpha: blended for Transparent BSDF mixes and BLENDED materials, clipped otherwise (Blender's dithered)
  const alphaBlend = g.blend === "BLENDED" && cl.alpha !== "1.0";
  const alphaClip = !alphaBlend && cl.alpha !== "1.0";
  const blended = alphaBlend || (!transparentByBackface && cl.tr !== "0.0" && g.nodes.some(n => n.type === "ShaderNodeBsdfTransparent"));
  const mat = new MeshPhysicalMaterial({
    name, color: new Color(1, 1, 1), roughness: 1, metalness: 0,
    side: transparentByBackface ? FrontSide : DoubleSide,
    transparent: blended, depthWrite: !blended, premultipliedAlpha: blended,
  });
  const samplers: Record<string, { value: Texture }> = {};
  await Promise.all([...c.samplers.entries()].map(async ([u, file]) => {
    const meta = Object.values(json.images).find(i => i.file === file)!;
    samplers[u] = { value: await loadTex(`${texBase}${file}`, meta.srgb) };
    if (g.nodes.some(n => n.image === file && n.props.extension === "EXTEND")) samplers[u].value.wrapS = samplers[u].value.wrapT = ClampToEdgeWrapping;
  }));

  const instPack = pack(c.instAttrs), geoPack = pack(c.geoAttrs);
  const packDecl = (pre: string, n: number, kw: string) => Array.from({ length: n }, (_, i) => `${kw} vec4 ${pre}${i};`).join("\n");
  // the graph reads vai_<name> / vag_<name>: map them onto the packed varyings
  const packDefs = (vpre: string, name: string, pk: AttrPacking) =>
    [...pk.slots].map(([k, sl]) => `#define ${name}${k} ${vpre}${sl.pack}.${swz(sl.off, sl.size)}`).join("\n");
  const vDecl = [
    "varying vec3 vNycP; varying vec3 vNycN0; varying vec3 vNycO; varying vec3 vNycON;",
    "uniform mat4 uNycFromWorld;",
    packDecl("aip", instPack.packs, "attribute"), packDecl("agp", geoPack.packs, "attribute"),
    packDecl("vaip", instPack.packs, "varying"), packDecl("vagp", geoPack.packs, "varying"),
  ].join("\n");
  const vCode = `
    {
      #ifdef USE_INSTANCING
        mat4 nycM = modelMatrix * instanceMatrix;
      #else
        mat4 nycM = modelMatrix;
      #endif
      vNycP = (uNycFromWorld * nycM * vec4(transformed, 1.0)).xyz;
      mat3 nycNM = transpose(inverse(mat3(uNycFromWorld * nycM)));
      vNycN0 = normalize(nycNM * objectNormal);
      vNycO = transformed;
      vNycON = normalize(objectNormal);
      ${Array.from({ length: instPack.packs }, (_, i) => `vaip${i} = aip${i};`).join(" ")}
      ${Array.from({ length: geoPack.packs }, (_, i) => `vagp${i} = agp${i};`).join(" ")}
    }`;
  const fDecl = [
    "varying vec3 vNycP; varying vec3 vNycN0; varying vec3 vNycO; varying vec3 vNycON;",
    "uniform mat3 uNycNormalToWorld; uniform vec3 uNycCamB; uniform float uNycEmitGain;",
    ...Object.keys(samplers).map(u => `uniform sampler2D ${u};`),
    packDecl("vaip", instPack.packs, "varying"), packDecl("vagp", geoPack.packs, "varying"),
    packDefs("vaip", "vai_", instPack), packDefs("vagp", "vag_", geoPack),
    GLSL_LIB,
  ].join("\n");
  const graph = c.lines.join("\n      ");
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, nycSpace, samplers);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + vDecl)
      .replace("#include <project_vertex>", "#include <project_vertex>\n" + vCode);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + fDecl)
      .replace("#include <map_fragment>", `#include <map_fragment>
      vec3 nycN = normalize(vNycN0) * (gl_FrontFacing ? 1.0 : -1.0);
      ${graph}
      ${transparentByBackface ? `if (${cl.tr} > 0.5) discard;` : ""}
      ${alphaClip ? `if (${cl.alpha} < 0.5) discard;` : ""}
      diffuseColor.rgb = ${cl.base};
      ${blended ? `diffuseColor.a = (1.0 - ${cl.tr}) * ${alphaBlend ? cl.alpha : "1.0"}; diffuseColor.rgb *= diffuseColor.a;` : ""}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
      roughnessFactor = clamp(${cl.rough}, 0.03, 1.0);`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
      metalnessFactor = clamp(${cl.metal}, 0.0, 1.0);`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
      normal = normalize((viewMatrix * vec4(uNycNormalToWorld * ${cl.nrm}, 0.0)).xyz);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      totalEmissiveRadiance = ${cl.emit} * uNycEmitGain;`);
  };
  mat.customProgramCacheKey = () => `nyc|${name}`;
  return {
    material: mat, instAttrs: c.instAttrs, geoAttrs: c.geoAttrs, instPack, geoPack, transparent: blended,
    emissive: cl.emit !== "vec3(0.0)",
  };
}
