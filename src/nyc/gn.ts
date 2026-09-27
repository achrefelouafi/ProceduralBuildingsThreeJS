/**
 * A geometry-nodes evaluator for the NYC_CornerBuilding.blend and
 * CN_ApartmentBuilding.blend graphs.
 *
 * public/assets/<nyc|cn>/graph.json (tools/nyc/dump_nyc_graph.py,
 * tools/cn/dump_cn_graph.py) holds the real node trees; this file runs them.
 * Values are singles or fields; a field is a function of the geometry context
 * it is evaluated on (component + domain), exactly like Blender's lazy fields.
 * Nodes operate on Geo (geo.ts). Every node type the graphs use is
 * implemented; anything else throws, so a graph change in Blender cannot
 * silently render wrong.
 *
 * Blender behaviour reproduced on purpose:
 *  - float32 arithmetic, safe division / modulo / power, float→int truncation,
 *    int/float→bool as "> 0", vector→float as the component mean,
 *    color→float as rgb_to_grayscale; colors travel as [r, g, b, a];
 *  - Random Value = lookup3 hash of (seed, id), unlinked ID = "id" or index;
 *  - multi-input sockets evaluated top to bottom (descending sort id);
 *  - Set Material / Store Named Attribute (non-instance domains) / Delete /
 *    Extrude / Fill Curve / Curve to Mesh / curve setters recurse into
 *    instance references; Set Position / Transform / Store (Instance) don't;
 *  - attributes adapt between the point, face and corner domains by copying
 *    or averaging (attribute_interpolate);
 *  - instance transforms = from_loc_rot_scale with Blender's quaternion path;
 *  - Distribute Points on Faces = Blender's per-triangle RandomNumberGenerator
 *    (drand48) + Poisson elimination; Merge by Distance = greedy index-order
 *    welding with averaged attributes.
 */
import { ShapeUtils, Vector2 } from "three";
import { floatBits, hashInt2d, hashInt3d, randomFloat, uintTo01 } from "../rng";
import {
  cone, cube, Curves, Geo, grid, identity, Instances, locRotScale, Mesh, mul, Points, transformPositions, uvSphere,
  eulerToQuat, f32, xformPoint, type Attr, type AttrMap, type AttrSize, type Domain, type Mat4, type Quat, type Vec3,
} from "./geo";

// ------------------------------------------------------------------ graph json

export interface GSocket { i: number; name: string; id: string; type: string; linked?: boolean; avail: boolean; value?: unknown }
export interface GNode {
  name: string; type: string; mute: boolean; group: string | null;
  props: Record<string, unknown>; menu: string[] | null; inputs: GSocket[]; outputs: GSocket[];
}
export interface GLink { from: string; fi: number; to: string; ti: number; sort: number }
export interface GIface {
  item_type: "SOCKET" | "PANEL"; name: string; parent: string | null; identifier?: string;
  in_out?: "INPUT" | "OUTPUT"; socket_type?: string; default_value?: unknown; min_value?: number; max_value?: number;
  description?: string; subtype?: string;
}
export interface GTree { name: string; interface: GIface[]; nodes: GNode[]; links: GLink[] }
export interface GraphJson { root: string; modifier: Record<string, unknown>; trees: GTree[] }

// ------------------------------------------------------------------ values

type Kind = "f" | "v" | "q" | "c";
export class Field {
  /**
   * fn computes the field on a context; deps are the fields it evaluates on
   * that same context (so shared inputs are computed once per evaluation)
   */
  constructor(readonly kind: Kind, private readonly fn: (c: Ctx) => unknown[], readonly deps: Field[] = []) {}
  ev(c: Ctx): unknown[] { return evalArr(this, c); }
  compute(c: Ctx): unknown[] { return this.fn(c); }
}
/** RGBA color (Blender ColorGeometry4f) */
export type Rgba = [number, number, number, number];
type Single = number | Vec3 | Quat | Rgba | string | boolean | Geo | Mat4 | null | { id: string; name: string };
export type Value = Single | Field | Value[];

export interface Ctx {
  comp: Mesh | Points | Curves | Instances | null;
  domain: Domain;
  n: number;
}

const isField = (v: unknown): v is Field => v instanceof Field;
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && typeof v[0] === "number";
/** a 4-array reaching a float / vector / color socket is a color (rotations never convert implicitly) */
const isCol = (v: unknown): v is Rgba => Array.isArray(v) && v.length === 4 && typeof v[0] === "number";

/**
 * One top-level field evaluation on a context: the field DAG (Field.deps) is
 * walked once to count references, and a field used by several others keeps
 * its result until its last user has read it — like Blender's field
 * evaluator, shared inputs run once and memory stays bounded.
 */
interface Session { ctx: Ctx; uses: Map<Field, number>; cache: Map<Field, unknown[]> }
let session: Session | null = null;

function countUses(root: Field): Map<Field, number> {
  const uses = new Map<Field, number>();
  const seen = new Set<Field>();
  const stack = [root];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of f.deps) { uses.set(d, (uses.get(d) ?? 0) + 1); stack.push(d); }
  }
  return uses;
}

function evalArr(v: Value, c: Ctx): unknown[] {
  if (!isField(v)) return new Array(c.n).fill(v);
  const s = session;
  if (s && s.ctx.comp === c.comp && s.ctx.domain === c.domain && s.ctx.n === c.n) {
    const hit = s.cache.get(v);
    const left = (s.uses.get(v) ?? 1) - 1;
    if (hit) {
      if (left > 0) s.uses.set(v, left); else { s.uses.delete(v); s.cache.delete(v); }
      return hit;
    }
    const r = v.compute(c);
    if (left > 0) { s.uses.set(v, left); s.cache.set(v, r); }
    return r;
  }
  session = { ctx: c, uses: countUses(v), cache: new Map() };
  try {
    return v.compute(c);
  } finally {
    session = s;
  }
}

/** lift an n-ary function over singles / fields */
function lift(kind: Kind, fn: (...a: never[]) => unknown, ...args: Value[]): Value {
  if (!args.some(isField)) return fn(...(args as never[])) as Value;
  const f = fn as (...a: unknown[]) => unknown;
  return new Field(kind, c => {
    // float fields come out as Float64Array; single inputs are read as is (not expanded)
    const n = c.n, out = (kind === "f" ? new Float64Array(n) : new Array(n)) as unknown[];
    const arrs = args.map(x => (isField(x) ? evalArr(x, c) : null));
    const [a, b, d, e] = arrs;
    const [a0, b0, d0, e0] = args;
    switch (args.length) {
      case 1: for (let i = 0; i < n; i++) out[i] = f(a![i]); break;
      case 2: for (let i = 0; i < n; i++) out[i] = f(a ? a[i] : a0, b ? b[i] : b0); break;
      case 3: for (let i = 0; i < n; i++) out[i] = f(a ? a[i] : a0, b ? b[i] : b0, d ? d[i] : d0); break;
      case 4: for (let i = 0; i < n; i++) out[i] = f(a ? a[i] : a0, b ? b[i] : b0, d ? d[i] : d0, e ? e[i] : e0); break;
      default: for (let i = 0; i < n; i++) out[i] = f(...arrs.map((x, k) => (x ? x[i] : args[k])));
    }
    return out;
  }, args.filter(isField));
}

// ------------------------------------------------------------------ conversions

/** BLI rgb_to_grayscale (the implicit color → float conversion) */
const GRAY = [f32(0.2126), f32(0.7152), f32(0.0722)];
const gray = (r: number, g: number, b: number) => f32(f32(f32(GRAY[0] * r) + f32(GRAY[1] * g)) + f32(GRAY[2] * b));
const toF = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isVec(v)) return f32(f32(f32(v[0] + v[1]) + v[2]) / 3);
  if (isCol(v)) return gray(v[0], v[1], v[2]);
  return 0;
};
const toI = (v: unknown): number => Math.trunc(toF(v)) | 0;
const toB = (v: unknown): number => (toF(v) > 0 ? 1 : 0);
const toV = (v: unknown): Vec3 =>
  isVec(v) ? v : isCol(v) ? [v[0], v[1], v[2]] : ((x: number) => [x, x, x] as Vec3)(toF(v));
const toC = (v: unknown): Rgba =>
  isCol(v) ? v : isVec(v) ? [v[0], v[1], v[2], 1] : ((x: number) => [x, x, x, 1] as Rgba)(toF(v));
const toQ = (v: unknown): Quat => (Array.isArray(v) && v.length === 4 ? (v as Quat) : eulerToQuat(toV(v)));

/** field kind of a socket / data type */
function kindOf(type: string): Kind {
  return ["VECTOR", "FLOAT_VECTOR"].includes(type) ? "v" : ["RGBA", "FLOAT_COLOR"].includes(type) ? "c" : type === "ROTATION" ? "q" : "f";
}

function convert(v: Value, type: string): Value {
  // a field already of the socket's kind passes through (no extra per-element pass)
  if (isField(v) && ((type === "VALUE" && v.kind === "f") || (type === "VECTOR" && v.kind === "v") ||
    (type === "RGBA" && v.kind === "c") || (type === "ROTATION" && v.kind === "q"))) return v;
  switch (type) {
    case "VALUE": return lift("f", toF as never, v);
    case "INT": return lift("f", toI as never, v);
    case "BOOLEAN": return lift("f", toB as never, v);
    case "VECTOR": return lift("v", toV as never, v);
    case "RGBA": return lift("c", toC as never, v);
    case "ROTATION": return lift("q", toQ as never, v);
    default: return v;
  }
}

function defaultValue(s: GSocket): Value {
  const v = s.value;
  switch (s.type) {
    case "VALUE": case "INT": return typeof v === "number" ? v : 0;
    case "BOOLEAN": return v ? 1 : 0;
    case "VECTOR": return isVec(v) ? (v.map(f32) as Vec3) : [0, 0, 0];
    case "RGBA": return isCol(v) ? (v.map(f32) as Rgba) : [0, 0, 0, 1];
    case "ROTATION": return eulerToQuat(isVec(v) ? (v as Vec3) : [0, 0, 0]);
    case "STRING": case "MENU": return typeof v === "string" ? v : "";
    case "GEOMETRY": return Geo.empty();
    default: return (v ?? null) as Value;
  }
}

// ------------------------------------------------------------------ math

type MathFn = (a: number, b: number, c: number) => number;
const MATH: Record<string, MathFn> = {
  ADD: (a, b) => f32(a + b),
  SUBTRACT: (a, b) => f32(a - b),
  MULTIPLY: (a, b) => f32(a * b),
  DIVIDE: (a, b) => (b === 0 ? 0 : f32(a / b)),
  MULTIPLY_ADD: (a, b, c) => f32(f32(a * b) + c),
  COMPARE: (a, b, c) => (Math.abs(f32(a - b)) <= Math.max(c, 1.1920928955078125e-7) ? 1 : 0),
  LESS_THAN: (a, b) => (a < b ? 1 : 0),
  GREATER_THAN: (a, b) => (a > b ? 1 : 0),
  MAXIMUM: (a, b) => Math.max(a, b),
  MINIMUM: (a, b) => Math.min(a, b),
  COSINE: a => f32(Math.cos(a)),
  SINE: a => f32(Math.sin(a)),
  TANGENT: a => f32(Math.tan(a)),
  ARCTANGENT: a => f32(Math.atan(a)),
  ARCTAN2: (a, b) => f32(Math.atan2(a, b)),
  ROUND: a => Math.floor(f32(a + 0.5)),
  FLOOR: a => Math.floor(a),
  FRACT: a => f32(a - Math.floor(a)),
  ABSOLUTE: a => Math.abs(a),
  SIGN: a => (a > 0 ? 1 : a < 0 ? -1 : 0),
  FLOORED_MODULO: (a, b) => (b === 0 ? 0 : f32(a - f32(Math.floor(f32(a / b)) * b))),
  POWER: (a, b) => (a >= 0 || Math.floor(b) === b ? f32(Math.pow(a, b)) : 0),
};
function mathFn(op: string): MathFn {
  const fn = MATH[op];
  if (!fn) throw new Error(`gn: math op ${op}`);
  return fn;
}

type Nums = ArrayLike<number>;
/**
 * Whole-array loops for the frequent math ops on float fields: each loop stays
 * monomorphic (the generic lift calls a shared closure per element).
 * Same float32 results as MATH.
 */
const KERNELS: Record<string, (o: Float64Array, a: Nums, b: Nums, c: Nums) => void> = {
  ADD: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = f32(a[i] + b[i]); },
  SUBTRACT: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = f32(a[i] - b[i]); },
  MULTIPLY: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = f32(a[i] * b[i]); },
  MULTIPLY_ADD: (o, a, b, c) => { for (let i = 0; i < o.length; i++) o[i] = f32(f32(a[i] * b[i]) + c[i]); },
  DIVIDE: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = b[i] === 0 ? 0 : f32(a[i] / b[i]); },
  LESS_THAN: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = a[i] < b[i] ? 1 : 0; },
  GREATER_THAN: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = a[i] > b[i] ? 1 : 0; },
  MAXIMUM: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = Math.max(a[i], b[i]); },
  MINIMUM: (o, a, b) => { for (let i = 0; i < o.length; i++) o[i] = Math.min(a[i], b[i]); },
  ABSOLUTE: (o, a) => { for (let i = 0; i < o.length; i++) o[i] = Math.abs(a[i]); },
  FLOOR: (o, a) => { for (let i = 0; i < o.length; i++) o[i] = Math.floor(a[i]); },
  SIGN: (o, a) => { for (let i = 0; i < o.length; i++) o[i] = a[i] > 0 ? 1 : a[i] < 0 ? -1 : 0; },
};

/** Math node on fields: a kernel over numeric arrays (singles broadcast), else the generic lift */
function mathField(op: string, args: Value[]): Value {
  const fn = mathFn(op);
  const kernel = KERNELS[op];
  if (!kernel || !args.some(isField)) {
    return lift("f", ((a: number, b: number, c: number) => fn(toF(a), toF(b), toF(c))) as never, ...args);
  }
  return new Field("f", c => {
    const out = new Float64Array(c.n);
    const arrs = args.map(x => {
      if (!isField(x)) return new Float64Array(c.n).fill(toF(x));
      const v = evalArr(x, c);
      return v instanceof Float64Array || typeof v[0] === "number" || !v.length ? (v as Nums) : Float64Array.from(v, toF);
    });
    kernel(out, arrs[0], arrs[1], arrs[2]);
    return out as unknown as unknown[];
  }, args.filter(isField));
}

// ------------------------------------------------------------------ field inputs

function attrOf(comp: Ctx["comp"], domain: Domain): AttrMap | null {
  if (!comp) return null;
  if (comp instanceof Mesh) return domain === "face" ? comp.face : domain === "corner" ? comp.corner : comp.point;
  if (comp instanceof Points) return comp.point;
  if (comp instanceof Curves) return comp.point;
  return comp.inst;
}

/** value shapes fields carry: float (1), vector (3), color (4) */
type Want = 1 | 3 | 4;
const zero = (w: Want): unknown => (w === 1 ? 0 : w === 3 ? [0, 0, 0] : [0, 0, 0, 0]);

/** element i of an attribute read as float / vector / color, with Blender's implicit conversions */
function attrElem(a: Attr, i: number, want: Want): unknown {
  const d = a.data, o = i * a.size;
  switch (a.size) {
    case 1: return want === 1 ? d[o] : want === 3 ? [d[o], d[o], d[o]] : [d[o], d[o], d[o], 1];
    case 2: return want === 1 ? f32(f32(d[o] + d[o + 1]) / 2) : want === 3 ? [d[o], d[o + 1], 0] : [d[o], d[o + 1], 0, 1];
    case 3: return want === 1 ? f32(f32(f32(d[o] + d[o + 1]) + d[o + 2]) / 3) : want === 3 ? [d[o], d[o + 1], d[o + 2]] : [d[o], d[o + 1], d[o + 2], 1];
    default: return want === 1 ? gray(d[o], d[o + 1], d[o + 2]) : want === 3 ? [d[o], d[o + 1], d[o + 2]] : [d[o], d[o + 1], d[o + 2], d[o + 3]];
  }
}

function mean(n: number, at: (k: number) => unknown, want: Want): unknown {
  if (!n) return zero(want);
  if (want === 1) { let s = 0; for (let k = 0; k < n; k++) s += at(k) as number; return f32(s / n); }
  const s = new Array(want).fill(0);
  for (let k = 0; k < n; k++) { const v = at(k) as number[]; for (let j = 0; j < want; j++) s[j] += v[j]; }
  return s.map(x => f32(x / n));
}

const domainSize = (m: Mesh, d: Domain) => (d === "face" ? m.faces : d === "corner" ? m.cornerCount : m.points);
const wantOf = (v: unknown): Want => (isCol(v) ? 4 : isVec(v) ? 3 : 1);

/** move per-element values between a mesh's point / face / corner domains (copy or average) */
function adaptMesh(m: Mesh, from: Domain, to: Domain, vals: unknown[], want: Want): unknown[] {
  if (from === to) return vals;
  const nTo = domainSize(m, to);
  // floats stay in typed arrays (the math kernels read them monomorphically)
  const out = (want === 1 ? new Float64Array(nTo) : new Array(nTo)) as unknown[];
  if (from === "point" && to === "corner") { for (let c = 0; c < nTo; c++) out[c] = vals[m.corners[c]]; return out; }
  if (from === "face" && to === "corner") { const cf = m.cornerFaces(); for (let c = 0; c < nTo; c++) out[c] = vals[cf[c]]; return out; }
  if (to === "face") {
    // point / corner → face: mean over the face's corners
    for (let f = 0; f < nTo; f++) {
      const a = m.faceStart[f], n = m.faceStart[f + 1] - a;
      out[f] = mean(n, k => vals[from === "point" ? m.corners[a + k] : a + k], want);
    }
    return out;
  }
  // face / corner → point: mean over the corners using the point
  const acc: unknown[][] = Array.from({ length: m.points }, () => []);
  const cf = from === "face" ? m.cornerFaces() : null;
  for (let c = 0; c < m.cornerCount; c++) acc[m.corners[c]].push(vals[cf ? cf[c] : c]);
  for (let i = 0; i < m.points; i++) out[i] = mean(acc[i].length, k => acc[i][k], want);
  return out;
}

function readAttr(c: Ctx, name: string, want: Want): unknown[] {
  const comp = c.comp;
  const direct = attrOf(comp, c.domain)?.get(name);
  if (direct) return Array.from({ length: c.n }, (_, i) => attrElem(direct, i, want));
  if (comp instanceof Mesh) {
    for (const from of ["point", "face", "corner"] as const) {
      const a = from === c.domain ? undefined : attrOf(comp, from)?.get(name);
      if (!a) continue;
      const vals = Array.from({ length: domainSize(comp, from) }, (_, i) => attrElem(a, i, want));
      return adaptMesh(comp, from, c.domain, vals, want);
    }
  }
  return new Array(c.n).fill(zero(want));
}

/** a per-face mesh quantity as a field on any mesh domain (0 elsewhere) */
function faceField(kind: Kind, want: Want, fn: (m: Mesh, f: number) => unknown): Field {
  return new Field(kind, c => {
    const m = c.comp;
    if (!(m instanceof Mesh)) return new Array(c.n).fill(zero(want));
    const vals = (want === 1 ? new Float64Array(m.faces) : new Array(m.faces)) as unknown[];
    for (let f = 0; f < m.faces; f++) vals[f] = fn(m, f);
    return adaptMesh(m, "face", c.domain, vals, want);
  });
}

const positionField = new Field("v", c => {
  const comp = c.comp;
  const out: Vec3[] = new Array(c.n);
  if (!comp) return out.fill([0, 0, 0]);
  if (comp instanceof Instances) { for (let i = 0; i < c.n; i++) { const m = comp.mats[i]; out[i] = [m[12], m[13], m[14]]; } return out; }
  if (comp instanceof Mesh && c.domain === "face") { for (let i = 0; i < c.n; i++) out[i] = comp.faceCenter(i); return out; }
  const P = comp.pos;
  const at = comp instanceof Mesh && c.domain === "corner" ? (i: number) => comp.corners[i] : (i: number) => i;
  for (let i = 0; i < c.n; i++) { const v = at(i); out[i] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]; }
  return out;
});
const indexField = new Field("f", c => Array.from({ length: c.n }, (_, i) => i));
const normalField = new Field("v", c => {
  const comp = c.comp;
  if (comp instanceof Mesh) {
    // corners: the face normals (the "legacy corner normals" behaviour)
    if (c.domain === "face" || c.domain === "corner") {
      return adaptMesh(comp, "face", c.domain, Array.from({ length: comp.faces }, (_, i) => comp.faceNormal(i)), 3);
    }
    const vn = comp.vertexNormals();
    return Array.from({ length: c.n }, (_, i) => [vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]]);
  }
  return new Array(c.n).fill([0, 0, 1]);
});
const idField = new Field("f", c => {
  const a = attrOf(c.comp, c.domain)?.get("id");
  return Array.from({ length: c.n }, (_, i) => (a ? a.data[i] : i));
});
const namedAttr = (name: string, want: Want) => new Field(want === 1 ? "f" : want === 3 ? "v" : "c", c => readAttr(c, name, want));

// ------------------------------------------------------------------ geometry helpers

function componentsFor(g: Geo, domain: Domain): { comp: Mesh | Points | Curves | Instances; n: number }[] {
  const out: { comp: Mesh | Points | Curves | Instances; n: number }[] = [];
  if (domain === "instance") { if (g.instances) out.push({ comp: g.instances, n: g.instances.count }); return out; }
  if (domain === "face") { if (g.mesh) out.push({ comp: g.mesh, n: g.mesh.faces }); return out; }
  if (domain === "corner") { if (g.mesh) out.push({ comp: g.mesh, n: g.mesh.cornerCount }); return out; }
  if (g.mesh) out.push({ comp: g.mesh, n: g.mesh.points });
  if (g.points) out.push({ comp: g.points, n: g.points.points });
  if (g.curves) out.push({ comp: g.curves, n: g.curves.points });
  return out;
}

/** modify_geometry_sets: apply fn to g and every nested instance reference (copy-on-write) */
function modifyRecursive(g: Geo, fn: (g: Geo) => Geo): Geo {
  const out = fn(g.shallow());
  if (out.instances) {
    const inst = out.instances.clone();
    inst.refs = inst.refs.map(r => modifyRecursive(r, fn));
    out.instances = inst;
  }
  return out;
}

/** write a value into attribute storage of the given width (float / FLOAT2 / vector / color) */
function writeElem(d: Float32Array, i: number, size: AttrSize, v: unknown): void {
  if (size === 1) { d[i] = toF(v); return; }
  if (size === 4) { const c = toC(v); d.set(c, i * 4); return; }
  const w = toV(v);
  for (let k = 0; k < size; k++) d[i * size + k] = w[k];
}
/** element i of an attribute converted to another storage width */
function elemAs(a: Attr, i: number, size: AttrSize): unknown {
  return attrElem(a, i, size === 1 ? 1 : size === 4 ? 4 : 3);
}

function setAttr(map: AttrMap, name: string, size: AttrSize, n: number, vals: unknown[], sel: unknown[] | null): void {
  let a = map.get(name);
  if (!a || a.size !== size || a.data.length !== n * size) {
    const old = a;
    a = { size, data: new Float32Array(n * size) };
    if (old && old.data.length === n * old.size) for (let i = 0; i < n; i++) writeElem(a.data, i, size, elemAs(old, i, size));
    map.set(name, a);
  }
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    writeElem(a.data, i, size, vals[i]);
  }
}

function copyComp<T extends Mesh | Points | Curves | Instances>(c: T): T { return c.clone() as T; }

/** gather rows of an AttrMap (for duplicate / delete / propagation) */
function pickAttrs(src: AttrMap, rows: ArrayLike<number>): AttrMap {
  const out: AttrMap = new Map();
  for (const [k, a] of src) {
    const d = new Float32Array(rows.length * a.size);
    for (let i = 0; i < rows.length; i++) for (let s = 0; s < a.size; s++) d[i * a.size + s] = a.data[rows[i] * a.size + s];
    out.set(k, { size: a.size, data: d });
  }
  return out;
}

/** join attribute maps; a name missing from a part is zero there, mixed widths take the widest */
function concatAttrs(parts: { attrs: AttrMap; n: number }[]): AttrMap {
  const names = new Map<string, AttrSize>();
  for (const p of parts) for (const [k, a] of p.attrs) if (a.size > (names.get(k) ?? 0)) names.set(k, a.size);
  const total = parts.reduce((s, p) => s + p.n, 0);
  const out: AttrMap = new Map();
  for (const [k, size] of names) {
    const d = new Float32Array(total * size);
    let off = 0;
    for (const p of parts) {
      const a = p.attrs.get(k);
      if (a && a.size === size) d.set(a.data.subarray(0, p.n * size), off * size);
      else if (a) for (let i = 0; i < p.n; i++) writeElem(d, off + i, size, elemAs(a, i, size));
      off += p.n;
    }
    out.set(k, { size, data: d });
  }
  return out;
}

export function joinMeshes(ms: Mesh[]): Mesh {
  if (ms.length === 1) return ms[0];
  const mats: (string | null)[] = [];
  const pos: number[] = [];
  const faces: number[][] = [];
  const matIdx: number[] = [];
  const smooth: number[] = [];
  let voff = 0;
  for (const m of ms) {
    for (let i = 0; i < m.pos.length; i++) pos.push(m.pos[i]);
    const remap = m.materials.map(name => { let k = mats.indexOf(name); if (k < 0) { mats.push(name); k = mats.length - 1; } return k; });
    for (let f = 0; f < m.faces; f++) {
      faces.push(Array.from(m.face_(f), v => v + voff));
      matIdx.push(m.materials.length ? remap[Math.min(m.matIndex[f], remap.length - 1)] : -1);
      smooth.push(m.smooth[f]);
    }
    voff += m.points;
  }
  // meshes without materials join as "no material" (slot index -1 → null)
  let nullSlot = -1;
  const out = new Mesh(pos, faces, mats);
  for (let f = 0; f < faces.length; f++) {
    let k = matIdx[f];
    if (k < 0) { if (nullSlot < 0) { nullSlot = mats.indexOf(null); if (nullSlot < 0) { out.materials.push(null); nullSlot = out.materials.length - 1; } } k = nullSlot; }
    out.matIndex[f] = k;
    out.smooth[f] = smooth[f];
  }
  out.point = concatAttrs(ms.map(m => ({ attrs: m.point, n: m.points })));
  out.face = concatAttrs(ms.map(m => ({ attrs: m.face, n: m.faces })));
  out.corner = concatAttrs(ms.map(m => ({ attrs: m.corner, n: m.cornerCount })));
  return out;
}

function joinPoints(ps: Points[]): Points {
  if (ps.length === 1) return ps[0];
  const pos: number[] = [];
  for (const p of ps) for (const x of p.pos) pos.push(x);
  const out = new Points(pos);
  out.point = concatAttrs(ps.map(p => ({ attrs: p.point, n: p.points })));
  return out;
}

function joinCurves(cs: Curves[]): Curves {
  if (cs.length === 1) return cs[0];
  const pos: number[] = [];
  const starts: number[] = [0];
  const cyc: number[] = [];
  const nm: string[] = [];
  for (const c of cs) {
    const base = pos.length / 3;
    for (const x of c.pos) pos.push(x);
    for (let s = 0; s < c.splines; s++) { starts.push(base + c.splineStart[s + 1]); cyc.push(c.cyclic[s]); nm.push(c.normalMode[s]); }
  }
  const out = new Curves(pos, starts);
  out.cyclic = Uint8Array.from(cyc);
  out.normalMode = nm;
  out.point = concatAttrs(cs.map(c => ({ attrs: c.point, n: c.points })));
  return out;
}

function joinInstances(is: Instances[]): Instances {
  if (is.length === 1) return is[0];
  const out = new Instances();
  for (const i of is) {
    const base = out.refs.length;
    out.refs.push(...i.refs);
    out.handle.push(...i.handle.map(h => h + base));
    out.mats.push(...i.mats);
  }
  out.inst = concatAttrs(is.map(i => ({ attrs: i.inst, n: i.count })));
  return out;
}

export function join(gs: Geo[]): Geo {
  const out = new Geo();
  const m = gs.map(g => g.mesh).filter((x): x is Mesh => !!x && x.points > 0);
  const p = gs.map(g => g.points).filter((x): x is Points => !!x && x.points > 0);
  const c = gs.map(g => g.curves).filter((x): x is Curves => !!x && x.points > 0);
  const i = gs.map(g => g.instances).filter((x): x is Instances => !!x && x.count > 0);
  if (m.length) out.mesh = joinMeshes(m);
  if (p.length) out.points = joinPoints(p);
  if (c.length) out.curves = joinCurves(c);
  if (i.length) out.instances = joinInstances(i);
  return out;
}

/** Realize Instances: flatten every level; instance attributes land on the point domain */
export function realize(g: Geo): Geo {
  const meshes: Mesh[] = [], points: Points[] = [], curves: Curves[] = [];
  const walk = (geo: Geo, m: Mat4, inherited: { name: string; size: AttrSize; v: number[] }[]) => {
    const attach = (map: AttrMap, n: number) => {
      for (const a of inherited) {
        if (map.has(a.name)) continue;
        const d = new Float32Array(n * a.size);
        for (let i = 0; i < n; i++) for (let s = 0; s < a.size; s++) d[i * a.size + s] = a.v[s];
        map.set(a.name, { size: a.size, data: d });
      }
    };
    if (geo.mesh && geo.mesh.points) {
      const c = geo.mesh.clone(); transformPositions(c.pos, m); attach(c.point, c.points); meshes.push(c);
    }
    if (geo.points && geo.points.points) {
      const c = geo.points.clone(); transformPositions(c.pos, m); attach(c.point, c.points); points.push(c);
    }
    if (geo.curves && geo.curves.points) {
      const c = geo.curves.clone(); transformPositions(c.pos, m); attach(c.point, c.points); curves.push(c);
    }
    const inst = geo.instances;
    if (inst) {
      for (let i = 0; i < inst.count; i++) {
        const own: { name: string; size: AttrSize; v: number[] }[] = [];
        for (const [k, a] of inst.inst) own.push({ name: k, size: a.size, v: Array.from(a.data.subarray(i * a.size, i * a.size + a.size)) });
        // nearest instance level wins over outer levels
        const merged = [...own, ...inherited.filter(x => !own.some(o => o.name === x.name))];
        walk(inst.refs[inst.handle[i]], mul(m, inst.mats[i]), merged);
      }
    }
  };
  walk(g, identity(), []);
  const out = new Geo();
  if (meshes.length) out.mesh = joinMeshes(meshes);
  if (points.length) out.points = joinPoints(points);
  if (curves.length) out.curves = joinCurves(curves);
  return out;
}

function boundsOf(g: Geo): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const r = realize(g);
  for (const c of [r.mesh, r.points, r.curves]) {
    if (!c) continue;
    for (let i = 0; i < c.pos.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], c.pos[i + k]); max[k] = Math.max(max[k], c.pos[i + k]);
    }
  }
  if (min[0] === Infinity) return null;
  return { min, max };
}

// ------------------------------------------------------------------ curves

function polyTangents(c: Curves, s: number): Vec3[] {
  const a = c.splineStart[s], b = c.splineStart[s + 1], n = b - a, cyc = !!c.cyclic[s];
  const P = (i: number): Vec3 => [c.pos[(a + i) * 3], c.pos[(a + i) * 3 + 1], c.pos[(a + i) * 3 + 2]];
  const nrm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const d = (i: number, j: number): Vec3 => nrm([P(j)[0] - P(i)[0], P(j)[1] - P(i)[1], P(j)[2] - P(i)[2]]);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    if (!cyc && i === 0) out.push(d(0, Math.min(1, n - 1)));
    else if (!cyc && i === n - 1) out.push(d(n - 2, n - 1));
    else {
      const p = (i + n - 1) % n, q = (i + 1) % n;
      const u = d(p, i), v = d(i, q);
      out.push(nrm([u[0] + v[0], u[1] + v[1], u[2] + v[2]]));
    }
  }
  return out;
}

function curveToMesh(path: Curves, profile: Curves, fillCaps: boolean): Mesh {
  const pos: number[] = [];
  const faces: number[][] = [];
  const smooth: number[] = [];
  for (let s = 0; s < path.splines; s++) {
    const a = path.splineStart[s], n = path.splineStart[s + 1] - a, cyc = !!path.cyclic[s];
    const tans = polyTangents(path, s);
    for (let ps = 0; ps < profile.splines; ps++) {
      const pa = profile.splineStart[ps], pn = profile.splineStart[ps + 1] - pa, pcyc = !!profile.cyclic[ps];
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const t = tans[i];
        // "Z Up" normals: horizontal, perpendicular to the tangent
        let nx = t[1], ny = -t[0];
        const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
        const nrm: Vec3 = [nx, ny, 0];
        const bin: Vec3 = [t[1] * nrm[2] - t[2] * nrm[1], t[2] * nrm[0] - t[0] * nrm[2], t[0] * nrm[1] - t[1] * nrm[0]];
        const o: Vec3 = [path.pos[(a + i) * 3], path.pos[(a + i) * 3 + 1], path.pos[(a + i) * 3 + 2]];
        for (let j = 0; j < pn; j++) {
          const px = profile.pos[(pa + j) * 3], py = profile.pos[(pa + j) * 3 + 1], pz = profile.pos[(pa + j) * 3 + 2];
          pos.push(
            f32(o[0] + nrm[0] * px + bin[0] * py + t[0] * pz),
            f32(o[1] + nrm[1] * px + bin[1] * py + t[1] * pz),
            f32(o[2] + nrm[2] * px + bin[2] * py + t[2] * pz),
          );
        }
      }
      const segs = cyc ? n : n - 1, psegs = pcyc ? pn : pn - 1;
      for (let i = 0; i < segs; i++) for (let j = 0; j < psegs; j++) {
        const i2 = (i + 1) % n, j2 = (j + 1) % pn;
        faces.push([base + i * pn + j, base + i2 * pn + j, base + i2 * pn + j2, base + i * pn + j2]);
        smooth.push(1);
      }
      if (fillCaps && !cyc && pcyc && pn > 2) {
        faces.push(Array.from({ length: pn }, (_, j) => base + (pn - 1 - j)));
        faces.push(Array.from({ length: pn }, (_, j) => base + (n - 1) * pn + j));
        smooth.push(0, 0);
      }
    }
  }
  // sides shade smooth, caps flat (curve_to_mesh_convert's sharp_face)
  const m = new Mesh(pos, faces);
  m.smooth.set(smooth);
  return m;
}

/** Fill Curve (Triangles, Even-Odd): planar XY fill of the cyclic splines */
function fillCurves(c: Curves): Mesh {
  if (c.fill) {
    // a glyph straight from String to Curves: Blender's own triangulation
    const P = c.fill.pos, pos: number[] = [];
    if (P) for (let i = 0; i < P.length; i += 2) pos.push(P[i], P[i + 1], 0);
    const faces: number[][] = [];
    for (let i = 0; i < c.fill.tris.length; i += 3) faces.push([c.fill.tris[i], c.fill.tris[i + 1], c.fill.tris[i + 2]]);
    return new Mesh(P ? pos : c.pos, faces);
  }
  const loops: Vector2[][] = [];
  for (let s = 0; s < c.splines; s++) {
    const a = c.splineStart[s], b = c.splineStart[s + 1];
    if (b - a < 3) continue;
    const l: Vector2[] = [];
    for (let i = a; i < b; i++) l.push(new Vector2(c.pos[i * 3], c.pos[i * 3 + 1]));
    loops.push(l);
  }
  const inside = (p: Vector2, poly: Vector2[]) => {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
    }
    return r;
  };
  const depth = loops.map((l, i) => loops.reduce((d, o, j) => (j !== i && inside(l[0], o) ? d + 1 : d), 0));
  const pos: number[] = [];
  const faces: number[][] = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2) return; // holes are consumed by their outer loop
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && inside(h[0], outer));
    const contour = ShapeUtils.isClockWise(outer) ? outer.slice().reverse() : outer;
    const hs = holes.map(h => (ShapeUtils.isClockWise(h) ? h : h.slice().reverse()));
    const tris = ShapeUtils.triangulateShape(contour, hs);
    const base = pos.length / 3;
    for (const v of [contour, ...hs].flat()) pos.push(v.x, v.y, 0);
    for (const t of tris) faces.push([base + t[0], base + t[1], base + t[2]]);
  });
  return new Mesh(pos, faces);
}

// ------------------------------------------------------------------ font (String to Curves)

export interface GlyphData {
  advance: number;
  loops: number[][];
  /** Blender's Fill Curve triangles (indices into the loop points, or into fillPos) */
  fill?: ArrayLike<number>;
  fillPos?: ArrayLike<number>;
}
export interface FontData { glyphs: Record<string, GlyphData>; space: number }

// ------------------------------------------------------------------ evaluator

export interface KitSource {
  /** object name → local-space mesh (materials by name) */
  object(name: string): Mesh;
  /** collection name → child object names, Blender's (natural) name order */
  collection(name: string): string[];
  font: FontData | null;
}

class TreeRun {
  private memo = new Map<string, Value>();
  private anonKeys = new Map<string, string>();
  anon(node: string, make: () => string): string {
    let k = this.anonKeys.get(node);
    if (!k) { k = make(); this.anonKeys.set(node, k); }
    return k;
  }
  private nodes = new Map<string, GNode>();
  private incoming = new Map<string, GLink[]>();

  constructor(readonly ev: Evaluator, readonly tree: GTree, readonly args: Value[]) {
    for (const n of tree.nodes) this.nodes.set(n.name, n);
    tree.links.forEach((l, k) => {
      const key = `${l.to}|${l.ti}`;
      const list = this.incoming.get(key) ?? [];
      list.push({ ...l, sort: l.sort * 100000 - k });
      this.incoming.set(key, list);
    });
    for (const list of this.incoming.values()) list.sort((a, b) => b.sort - a.sort);
  }

  output(): Value[] {
    const out = this.tree.nodes.find(n => n.type === "NodeGroupOutput" && n.props.is_active_output !== false)
      ?? this.tree.nodes.find(n => n.type === "NodeGroupOutput")!;
    const outs = this.tree.interface.filter(i => i.item_type === "SOCKET" && i.in_out === "OUTPUT");
    return outs.map((_, i) => this.input(out, i));
  }

  input(n: GNode, i: number): Value {
    const s = n.inputs[i];
    const links = this.incoming.get(`${n.name}|${i}`);
    if (!links || !links.length) return this.implicit(n, s) ?? defaultValue(s);
    if (links.length > 1 || MULTI.has(`${n.type}|${i}`)) return links.map(l => this.out(l.from, l.fi));
    return convert(this.out(links[0].from, links[0].fi), s.type);
  }
  inputs(n: GNode, name: string): GSocket {
    const s = n.inputs.find(x => x.name === name && x.avail);
    if (!s) throw new Error(`gn: ${n.type} has no input ${name}`);
    return s;
  }
  in(n: GNode, name: string): Value { return this.input(n, this.inputs(n, name).i); }
  linked(n: GNode, name: string): boolean { return !!this.incoming.get(`${n.name}|${this.inputs(n, name).i}`)?.length; }

  /** implicit field inputs of unlinked sockets */
  private implicit(n: GNode, s: GSocket): Value | undefined {
    if (n.type === "FunctionNodeRandomValue" && s.name === "ID") return idField;
    if (n.type === "GeometryNodeExtrudeMesh" && s.name === "Offset") return normalField;
    if (n.type === "GeometryNodeProximity" && s.name === "Sample Position") return positionField;
    return undefined;
  }

  out(nodeName: string, idx: number): Value {
    const key = `${nodeName}|${idx}`;
    if (this.memo.has(key)) return this.memo.get(key)!;
    const n = this.nodes.get(nodeName)!;
    if (n.mute) throw new Error(`gn: muted node ${n.name} in ${this.tree.name}`);
    const res = this.ev.node(this, n, idx);
    this.memo.set(key, res);
    return res;
  }
}

const MULTI = new Set(["GeometryNodeJoinGeometry|0", "GeometryNodeGeometryToInstance|0"]);

const asGeo = (v: Value): Geo => (v instanceof Geo ? v : Geo.empty());
const single = (v: Value, what: string): number => {
  if (isField(v)) throw new Error(`gn: ${what} must be a single value`);
  return toF(v);
};

export class Evaluator {
  private trees = new Map<string, GTree>();
  private uid = 0;
  constructor(readonly graph: GraphJson, readonly kit: KitSource) {
    for (const t of graph.trees) this.trees.set(t.name, t);
  }

  tree(name: string): GTree {
    const t = this.trees.get(name);
    if (!t) throw new Error(`gn: missing tree ${name}`);
    return t;
  }

  /** evaluate a group with inputs by interface name (defaults for the rest) */
  run(name: string, inputs: Record<string, unknown>): Geo {
    const t = this.tree(name);
    const ins = t.interface.filter(i => i.item_type === "SOCKET" && i.in_out === "INPUT");
    const args: Value[] = ins.map(i => {
      const v = i.name in inputs ? inputs[i.name] : i.default_value;
      return convert(sockIface(i, v), SOCK[i.socket_type ?? ""] ?? "");
    });
    return asGeo(new TreeRun(this, t, args).output()[0]);
  }

  node(r: TreeRun, n: GNode, idx: number): Value {
    const I = (name: string) => r.in(n, name);
    const Ii = (i: number) => r.input(n, i);
    const P = n.props;
    switch (n.type) {
      case "NodeGroupInput": return r.args[idx];
      case "GeometryNodeGroup": {
        const sub = this.tree(n.group!);
        const ins = sub.interface.filter(i => i.item_type === "SOCKET" && i.in_out === "INPUT");
        const args = ins.map((_, i) => Ii(i));
        const outs = new TreeRun(this, sub, args).output();
        return outs[idx];
      }
      // ---------------- function nodes
      case "ShaderNodeMath": {
        return mathField(P.operation as string, [Ii(0), Ii(1), Ii(2)]);
      }
      case "ShaderNodeVectorMath": {
        const op = P.operation as string;
        if (op === "ADD") return lift("v", ((a: Vec3, b: Vec3) => [f32(a[0] + b[0]), f32(a[1] + b[1]), f32(a[2] + b[2])]) as never, Ii(0), Ii(1));
        if (op === "SCALE") return lift("v", ((a: Vec3, s: number) => [f32(a[0] * s), f32(a[1] * s), f32(a[2] * s)]) as never, Ii(0), Ii(3));
        throw new Error(`gn: vector math ${op}`);
      }
      case "ShaderNodeCombineXYZ": return lift("v", ((x: number, y: number, z: number) => [x, y, z]) as never, Ii(0), Ii(1), Ii(2));
      case "ShaderNodeSeparateXYZ": {
        const v = Ii(0);
        if (!isField(v)) return toV(v)[idx];
        return new Field("f", c => {
          const a = evalArr(v, c) as Vec3[], out = new Float64Array(c.n);
          for (let i = 0; i < c.n; i++) out[i] = a[i][idx];
          return out as unknown as unknown[];
        }, [v]);
      }
      case "FunctionNodeBooleanMath": {
        if (P.operation !== "NOT") throw new Error(`gn: boolean ${P.operation}`);
        return lift("f", ((a: number) => (a ? 0 : 1)) as never, Ii(0));
      }
      case "FunctionNodeEulerToRotation": return lift("q", ((e: Vec3) => eulerToQuat(e)) as never, Ii(0));
      case "FunctionNodeSeparateColor": {
        if (P.mode !== "RGB") throw new Error("gn: separate color mode");
        return lift("f", ((c: Rgba) => c[idx]) as never, Ii(0));
      }
      case "FunctionNodeCombineColor": {
        if (P.mode !== "RGB") throw new Error("gn: combine color mode");
        return lift("c", ((r: number, g: number, b: number, a: number) => [r, g, b, a]) as never, Ii(0), Ii(1), Ii(2), Ii(3));
      }
      case "ShaderNodeMix": {
        // ramp_blend(MIX) on rgb; alpha stays A's
        if (P.data_type !== "RGBA" || P.blend_type !== "MIX" || P.factor_mode !== "UNIFORM") throw new Error("gn: mix mode");
        const iA = n.inputs.findIndex(s => s.name === "A" && s.type === "RGBA"), iB = n.inputs.findIndex(s => s.name === "B" && s.type === "RGBA");
        const clampF = !!P.clamp_factor, clampR = !!P.clamp_result;
        return lift("c", ((t: number, a: Rgba, b: Rgba) => {
          const fac = clampF ? Math.min(1, Math.max(0, t)) : t, facm = f32(1 - fac);
          const mix = (k: number) => {
            const v = f32(f32(facm * a[k]) + f32(fac * b[k]));
            return clampR ? Math.min(1, Math.max(0, v)) : v;
          };
          return [mix(0), mix(1), mix(2), a[3]];
        }) as never, Ii(0), Ii(iA), Ii(iB));
      }
      case "FunctionNodeRandomValue": {
        if (P.data_type !== "FLOAT") throw new Error("gn: random type");
        return lift("f", ((lo: number, hi: number, id: number, seed: number) => randomFloat(lo, hi, toI(id), toI(seed))) as never,
          Ii(2), Ii(3), Ii(7), Ii(8));
      }
      case "GeometryNodeSwitch": {
        const c = Ii(0);
        if (P.input_type === "GEOMETRY") return single(c, "switch") ? Ii(2) : Ii(1);
        return lift(kindOf(String(P.input_type)), ((s: number, f: number, t: number) => (s ? t : f)) as never, c, Ii(1), Ii(2));
      }
      case "GeometryNodeMenuSwitch": {
        const items = n.menu ?? [];
        const m = Ii(0);
        let k = typeof m === "string" ? items.indexOf(m) : -1;
        if (k < 0) k = Math.max(0, items.indexOf(String(P.active_item)));
        if (idx === 0) return Ii(k + 1);
        return idx - 1 === k ? 1 : 0;
      }
      case "GeometryNodeIndexSwitch": {
        const items = n.inputs.filter(s => s.name !== "Index" && s.type !== "CUSTOM");
        const vals = items.map(s => r.input(n, s.i));
        const iv = Ii(0);
        if (!isField(iv)) { const k = toI(iv); return k >= 0 && k < vals.length ? vals[k] : 0; }
        return new Field(kindOf(String(P.data_type)), c => {
          const ia = evalArr(iv, c), va = vals.map(v => evalArr(v, c));
          const out = new Array(c.n);
          for (let e = 0; e < c.n; e++) { const k = toI(ia[e]); out[e] = k >= 0 && k < va.length ? va[k][e] : 0; }
          return out;
        }, [iv, ...vals.filter(isField)]);
      }
      // ---------------- field inputs
      case "GeometryNodeInputIndex": return indexField;
      case "GeometryNodeInputPosition": return positionField;
      case "GeometryNodeInputNormal": return normalField;
      case "GeometryNodeInputNamedAttribute": {
        const nm = String(I("Name"));
        if (idx === 1) return new Field("f", c => { const a = attrOf(c.comp, c.domain); return new Array(c.n).fill(a?.has(nm) ? 1 : 0); });
        const want: Want = P.data_type === "FLOAT_VECTOR" ? 3 : P.data_type === "FLOAT_COLOR" ? 4 : 1;
        if (want === 1 && !["FLOAT", "INT", "BOOLEAN"].includes(String(P.data_type))) throw new Error(`gn: named attribute ${P.data_type}`);
        const f = namedAttr(nm, want);
        if (P.data_type === "INT") return new Field("f", c => f.ev(c).map(toI), [f]);
        if (P.data_type === "BOOLEAN") return new Field("f", c => f.ev(c).map(toB), [f]);
        return f;
      }
      case "GeometryNodeInputMeshFaceArea": return faceField("f", 1, (m, f) => m.faceArea(f));
      case "GeometryNodeMaterialSelection": {
        const mat = (r.input(n, 0) as { name: string } | null)?.name ?? null;
        return faceField("f", 1, (m, f) => (m.materials[m.matIndex[f]] === mat ? 1 : 0));
      }
      case "GeometryNodeFieldOnDomain": {
        // evaluate on the node's domain of the context mesh, then adapt to the context domain
        const dom = String(P.domain).toLowerCase() as Domain;
        const v = Ii(0);
        if (!isField(v)) return v;
        return new Field(v.kind, c => {
          const m = c.comp;
          if (!(m instanceof Mesh) || dom === c.domain || !["point", "face", "corner"].includes(dom)) return v.ev(c);
          const vals = v.ev({ comp: m, domain: dom, n: domainSize(m, dom) });
          return adaptMesh(m, dom, c.domain, vals, vals.length ? wantOf(vals[0]) : 1);
        });
      }
      case "GeometryNodeSplineParameter": return splineParameter(idx);
      // ---------------- sources
      case "GeometryNodeObjectInfo": {
        if (idx !== 4) throw new Error("gn: object info output");
        const o = r.input(n, 0) as { name: string } | null;
        if (!o) return Geo.empty();
        return Geo.of(this.kit.object(o.name));
      }
      case "GeometryNodeCollectionInfo": {
        const c = r.input(n, 0) as { name: string } | null;
        if (!c) return Geo.empty();
        const inst = new Instances();
        for (const name of this.kit.collection(c.name)) {
          inst.handle.push(inst.addRef(Geo.of(this.kit.object(name))));
          inst.mats.push(identity());
        }
        return Geo.of(inst);
      }
      case "GeometryNodeMeshCube": return Geo.of(cube(toV(single2v(I("Size")))));
      case "GeometryNodeMeshCylinder": {
        const r0 = single(I("Radius"), "radius");
        return Geo.of(cone(toI(I("Vertices")), r0, r0, single(I("Depth"), "depth")));
      }
      case "GeometryNodeMeshCone":
        return Geo.of(cone(toI(I("Vertices")), single(I("Radius Top"), "r"), single(I("Radius Bottom"), "r"), single(I("Depth"), "d")));
      case "GeometryNodeMeshUVSphere":
        return Geo.of(uvSphere(toI(I("Segments")), toI(I("Rings")), single(I("Radius"), "r")));
      case "GeometryNodeMeshGrid": {
        if (idx !== 0) throw new Error("gn: grid UV output");
        return Geo.of(grid(single(I("Size X"), "size"), single(I("Size Y"), "size"), toI(single(I("Vertices X"), "n")), toI(single(I("Vertices Y"), "n"))));
      }
      case "GeometryNodeCurvePrimitiveCircle": {
        if (P.mode !== "RADIUS" || idx !== 0) throw new Error("gn: curve circle mode");
        const res = Math.max(3, toI(single(I("Resolution"), "resolution"))), rad = single(I("Radius"), "radius");
        const step = f32((2 * Math.PI) / res);
        const pos: number[] = [];
        for (let i = 0; i < res; i++) {
          const th = f32(step * i);
          pos.push(f32(rad * f32(Math.cos(th))), f32(rad * f32(Math.sin(th))), 0);
        }
        const c = new Curves(pos, [0, res]);
        c.cyclic[0] = 1;
        return Geo.of(c);
      }
      case "GeometryNodeCurvePrimitiveLine": {
        if (P.mode !== "POINTS") throw new Error("gn: curve line mode");
        const a = toV(single2v(I("Start"))), b = toV(single2v(I("End")));
        return Geo.of(new Curves([...a, ...b], [0, 2]));
      }
      case "GeometryNodePoints": {
        const count = Math.max(0, toI(single(I("Count"), "count")));
        const ctx: Ctx = { comp: null, domain: "point", n: count };
        const pv = evalArr(I("Position"), ctx) as Vec3[];
        const pts = new Points(pv.flatMap(v => [v[0], v[1], v[2]]));
        return Geo.of(pts);
      }
      case "GeometryNodeCurvePrimitiveQuadrilateral": {
        if (P.mode !== "RECTANGLE") throw new Error("gn: quadrilateral mode");
        const w = f32(single(I("Width"), "w") / 2), h = f32(single(I("Height"), "h") / 2);
        const c = new Curves([-w, h, 0, w, h, 0, w, -h, 0, -w, -h, 0], [0, 4]);
        c.cyclic[0] = 1;
        return Geo.of(c);
      }
      case "GeometryNodeStringToCurves": {
        if (idx !== 0) throw new Error("gn: string to curves output");
        return this.stringToCurves(String(I("String")), single(I("Size"), "size"));
      }
      // ---------------- geometry operations
      case "GeometryNodeJoinGeometry": {
        const list = (Ii(0) as Value[]).map(asGeo);
        return join(list);
      }
      case "GeometryNodeGeometryToInstance": {
        const list = (Ii(0) as Value[]).map(asGeo);
        const inst = new Instances();
        for (const g of list) { inst.handle.push(inst.addRef(g)); inst.mats.push(identity()); }
        return Geo.of(inst);
      }
      case "GeometryNodeRealizeInstances": return realize(asGeo(I("Geometry")));
      case "GeometryNodeTransform": {
        const g = asGeo(I("Geometry"));
        const m = locRotScale(toV(single2v(I("Translation"))), toQ(single2v(I("Rotation"))), toV(single2v(I("Scale"))));
        return transformGeo(g, m);
      }
      case "GeometryNodeSetPosition": return this.setPosition(r, n);
      case "GeometryNodeSetMaterial": {
        const mat = (r.input(n, 2) as { name: string } | null)?.name ?? null;
        const sel = I("Selection");
        return modifyRecursive(asGeo(I("Geometry")), g => {
          if (!g.mesh) return g;
          const m = g.mesh.clone();
          const s = evalArr(sel, { comp: m, domain: "face", n: m.faces });
          let slot = m.materials.indexOf(mat);
          if (s.every(x => x) || !m.materials.length) {
            // whole mesh → a single slot
            if (s.every(x => x)) { m.materials = [mat]; m.matIndex.fill(0); g.mesh = m; return g; }
          }
          if (slot < 0) { m.materials.push(mat); slot = m.materials.length - 1; }
          for (let f = 0; f < m.faces; f++) if (s[f]) m.matIndex[f] = slot;
          g.mesh = m;
          return g;
        });
      }
      case "GeometryNodeStoreNamedAttribute": {
        const name = String(I("Name"));
        const dom = String(P.domain).toLowerCase() as Domain;
        const sizes: Record<string, AttrSize> = { FLOAT: 1, INT: 1, BOOLEAN: 1, FLOAT2: 2, FLOAT_VECTOR: 3, FLOAT_COLOR: 4 };
        const size = sizes[String(P.data_type)];
        if (!size || !["point", "face", "corner", "instance"].includes(dom)) throw new Error(`gn: store ${P.data_type} on ${dom}`);
        const cast = P.data_type === "INT" ? toI : P.data_type === "BOOLEAN" ? toB : null;
        const val = I("Value"), sel = I("Selection");
        const store = (g: Geo): Geo => {
          const out = g.shallow();
          for (const { comp, n: count } of componentsFor(g, dom)) {
            const c = copyComp(comp);
            const ctx: Ctx = { comp: c, domain: dom, n: count };
            let v = evalArr(val, ctx);
            if (cast) v = v.map(cast);
            const s = evalArr(sel, ctx);
            const map = attrOf(c, dom)!;
            setAttr(map, name, size, count, v, s.every(x => x) ? null : s);
            if (c instanceof Mesh) out.mesh = c; else if (c instanceof Points) out.points = c;
            else if (c instanceof Curves) out.curves = c; else out.instances = c;
          }
          return out;
        };
        const g = asGeo(I("Geometry"));
        return dom === "instance" ? store(g) : modifyRecursive(g, store);
      }
      case "GeometryNodeInstanceOnPoints": return this.instanceOnPoints(r, n);
      case "GeometryNodeTranslateInstances": {
        const g = asGeo(I("Instances"));
        if (!g.instances) return g;
        const out = g.shallow();
        const inst = g.instances.clone();
        const ctx: Ctx = { comp: inst, domain: "instance", n: inst.count };
        const t = evalArr(I("Translation"), ctx) as Vec3[], s = evalArr(I("Selection"), ctx);
        const local = !!single(I("Local Space"), "local");
        for (let i = 0; i < inst.count; i++) {
          if (!s[i]) continue;
          const tv = toV(t[i]);
          const T = identity(); T[12] = tv[0]; T[13] = tv[1]; T[14] = tv[2];
          inst.mats[i] = local ? mul(inst.mats[i], T) : mul(T, inst.mats[i]);
        }
        out.instances = inst;
        return out;
      }
      case "GeometryNodeDuplicateElements": {
        if (P.domain !== "POINT") throw new Error("gn: duplicate domain");
        // "Duplicate Index" is an anonymous attribute on the output points,
        // unique per node evaluation (so group re-use can't mix them up)
        const key = r.anon(n.name, () => `__dup${this.uid++}`);
        if (idx === 1) return namedAttr(key, 1);
        return this.duplicatePoints(r, n, key);
      }
      case "GeometryNodeDeleteGeometry": {
        if (P.mode !== "ALL" || (P.domain !== "FACE" && P.domain !== "POINT")) throw new Error("gn: delete mode");
        const sel = I("Selection");
        if (P.domain === "FACE") {
          return modifyRecursive(asGeo(I("Geometry")), g => {
            if (!g.mesh) return g;
            g.mesh = deleteFaces(g.mesh, evalArr(sel, { comp: g.mesh, domain: "face", n: g.mesh.faces }));
            return g;
          });
        }
        return modifyRecursive(asGeo(I("Geometry")), g => {
          if (g.curves) throw new Error("gn: delete curve points");
          if (g.points) {
            const p = g.points;
            const s = evalArr(sel, { comp: p, domain: "point", n: p.points });
            const keep: number[] = [];
            for (let i = 0; i < p.points; i++) if (!s[i]) keep.push(i);
            const q = new Points(keep.flatMap(i => [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]]));
            q.point = pickAttrs(p.point, keep);
            g.points = q;
          }
          if (g.mesh) {
            // deleting a point deletes the faces using it (and it, once unused)
            const m = g.mesh;
            const s = evalArr(sel, { comp: m, domain: "point", n: m.points });
            const fsel = Array.from({ length: m.faces }, (_, f) => m.face_(f).some(v => !!s[v]));
            const kept = deleteFaces(m, fsel);
            g.mesh = kept;
          }
          return g;
        });
      }
      case "GeometryNodeExtrudeMesh": {
        if (P.mode !== "FACES" || idx !== 0) throw new Error("gn: extrude mode");
        const sel = I("Selection"), off = I("Offset"), sc = I("Offset Scale");
        const individual = !!single(I("Individual"), "individual");
        const singleOffset = !isField(off) && !isField(sc);
        return modifyRecursive(asGeo(I("Mesh")), g => {
          if (!g.mesh) return g;
          const m = g.mesh;
          const ctx: Ctx = { comp: m, domain: "face", n: m.faces };
          const s = evalArr(sel, ctx), o = evalArr(off, ctx) as Vec3[], k = evalArr(sc, ctx) as number[];
          g.mesh = individual ? extrudeFacesIndividual(m, s, o, k) : extrudeRegions(m, s, o, k, singleOffset);
          return g;
        });
      }
      case "GeometryNodeFlipFaces": {
        const sel = I("Selection");
        return modifyRecursive(asGeo(I("Mesh")), g => {
          if (!g.mesh) return g;
          g.mesh = flipFaces(g.mesh, evalArr(sel, { comp: g.mesh, domain: "face", n: g.mesh.faces }));
          return g;
        });
      }
      case "GeometryNodeMergeByDistance": {
        if (String(I("Mode")) !== "All") throw new Error("gn: merge by distance mode");
        const sel = I("Selection"), dist = single(I("Distance"), "distance");
        return modifyRecursive(asGeo(I("Geometry")), g => {
          if (g.points) throw new Error("gn: merge point clouds");
          if (!g.mesh) return g;
          const s = evalArr(sel, { comp: g.mesh, domain: "point", n: g.mesh.points });
          g.mesh = mergeByDistance(g.mesh, dist, s);
          return g;
        });
      }
      case "GeometryNodeDistributePointsOnFaces": {
        if (idx !== 0) throw new Error("gn: distribute points outputs");
        const poisson = P.distribute_method === "POISSON";
        const seed = Math.imul(toI(single(I("Seed"), "seed")), 5383843); // the node scrambles its seed input
        const sel = I("Selection");
        // Random: base density 1 × the Density field; Poisson: Density Max × the Density Factor field
        const density = poisson ? single(I("Density Max"), "density") : 1;
        const minDist = poisson ? single(I("Distance Min"), "distance") : 0;
        const factor = poisson ? I("Density Factor") : I("Density");
        const g = asGeo(I("Mesh"));
        if (g.instances) throw new Error("gn: distribute on instances");
        if (!g.mesh) return Geo.empty();
        const m = g.mesh;
        const ctx: Ctx = { comp: m, domain: "corner", n: m.cornerCount };
        const sc = evalArr(sel, ctx), fc = evalArr(factor as Value, ctx);
        return Geo.of(distributePoints(m, density, seed, minDist, poisson, Array.from({ length: m.cornerCount }, (_, c) => (sc[c] ? toF(fc[c]) : 0))));
      }
      case "GeometryNodeProximity": {
        if (P.target_element !== "POINTS") throw new Error("gn: proximity target");
        const target = asGeo(I("Geometry"));
        const tp: number[] = [];
        for (const c of [target.mesh, target.points]) if (c) for (const x of c.pos) tp.push(x);
        const src = I("Sample Position");
        return lift(idx === 0 ? "v" : "f", ((p: Vec3) => {
          const q = toV(p);
          if (!tp.length) return idx === 0 ? [0, 0, 0] : idx === 1 ? 0 : 0;
          let best = Infinity, bi = 0;
          for (let i = 0; i < tp.length; i += 3) {
            const dx = f32(tp[i] - q[0]), dy = f32(tp[i + 1] - q[1]), dz = f32(tp[i + 2] - q[2]);
            const d = f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz));
            if (d < best) { best = d; bi = i; }
          }
          if (idx === 0) return [tp[bi], tp[bi + 1], tp[bi + 2]];
          return idx === 1 ? f32(Math.sqrt(best)) : 1;
        }) as never, src);
      }
      case "GeometryNodeResampleCurve": {
        if (String(I("Mode")) !== "Count") throw new Error("gn: resample mode");
        const count = Math.max(1, toI(single(I("Count"), "count")));
        return modifyRecursive(asGeo(I("Curve")), g => {
          if (!g.curves) return g;
          g.curves = resampleCount(g.curves, count);
          return g;
        });
      }
      case "GeometryNodeRemoveAttribute": {
        const name = String(I("Name")), mode = String(I("Pattern Mode"));
        const hit = mode === "Wildcard" && name.includes("*")
          ? ((re: RegExp) => (k: string) => re.test(k))(new RegExp(`^${name.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`))
          : (k: string) => k === name;
        const strip = (a: AttrMap) => { for (const k of [...a.keys()]) if (hit(k)) a.delete(k); };
        return modifyRecursive(asGeo(I("Geometry")), g => {
          if (g.mesh) { const m = g.mesh.clone(); strip(m.point); strip(m.face); strip(m.corner); g.mesh = m; }
          if (g.points) { const p = g.points.clone(); strip(p.point); g.points = p; }
          if (g.curves) { const c = g.curves.clone(); strip(c.point); g.curves = c; }
          if (g.instances) { const i = g.instances.clone(); strip(i.inst); g.instances = i; }
          return g;
        });
      }
      case "GeometryNodeFillCurve":
        return modifyRecursive(asGeo(I("Curve")), g => {
          if (!g.curves) return g;
          const m = fillCurves(g.curves);
          g.curves = null;
          g.mesh = g.mesh ? joinMeshes([g.mesh, m]) : m;
          return g;
        });
      case "GeometryNodePointsToCurves": {
        const g = asGeo(I("Points"));
        if (!g.points) return Geo.empty();
        const p = g.points;
        const ctx: Ctx = { comp: p, domain: "point", n: p.points };
        const w = evalArr(I("Weight"), ctx) as number[];
        const grp = evalArr(I("Curve Group ID"), ctx).map(toI);
        const groups = [...new Set(grp)].sort((a, b) => a - b);
        const order: number[] = [];
        const starts = [0];
        for (const gid of groups) {
          const idxs = grp.map((x, i) => (x === gid ? i : -1)).filter(i => i >= 0);
          idxs.sort((a, b) => w[a] - w[b] || a - b);
          order.push(...idxs);
          starts.push(order.length);
        }
        const c = new Curves(order.flatMap(i => [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]]), starts);
        c.point = pickAttrs(p.point, order);
        return Geo.of(c);
      }
      case "GeometryNodeSetSplineCyclic": {
        const cy = single(I("Cyclic"), "cyclic");
        return modifyRecursive(asGeo(I("Curve")), g => {
          if (!g.curves) return g;
          const c = g.curves.clone(); c.cyclic.fill(cy ? 1 : 0); g.curves = c; return g;
        });
      }
      case "GeometryNodeSetCurveNormal":
        return modifyRecursive(asGeo(I("Curve")), g => {
          if (!g.curves) return g;
          const c = g.curves.clone(); c.normalMode.fill("z_up"); g.curves = c; return g;
        });
      case "GeometryNodeCurveToMesh": {
        const prof = asGeo(I("Profile Curve")).curves;
        const caps = !!single(I("Fill Caps"), "caps");
        return modifyRecursive(asGeo(I("Curve")), g => {
          if (!g.curves || !prof) return g;
          const m = curveToMesh(g.curves, prof, caps);
          g.curves = null;
          g.mesh = g.mesh ? joinMeshes([g.mesh, m]) : m;
          return g;
        });
      }
      case "GeometryNodeBoundBox": {
        const b = boundsOf(asGeo(I("Geometry")));
        if (idx === 1) return b ? b.min : [0, 0, 0];
        if (idx === 2) return b ? b.max : [0, 0, 0];
        throw new Error("gn: bound box geometry output");
      }
      case "GeometryNodeSampleIndex": {
        if (P.domain !== "POINT" || P.data_type !== "FLOAT") throw new Error("gn: sample index");
        const g = asGeo(I("Geometry"));
        const comps = componentsFor(g, "point");
        const comp = comps[0];
        const k = toI(single(I("Index"), "index"));
        if (!comp || k < 0 || k >= comp.n) return 0;
        const arr = evalArr(I("Value"), { comp: comp.comp, domain: "point", n: comp.n });
        return toF(arr[k]);
      }
      default:
        throw new Error(`gn: unsupported node ${n.type} (${n.name} in ${r.tree.name})`);
    }
  }

  private setPosition(r: TreeRun, n: GNode): Geo {
    const g = asGeo(r.in(n, "Geometry"));
    const out = g.shallow();
    const hasPos = r.linked(n, "Position");
    const pos = r.in(n, "Position"), off = r.in(n, "Offset"), sel = r.in(n, "Selection");
    const apply = (comp: Mesh | Points | Curves | Instances, count: number, domain: Domain) => {
      const c = copyComp(comp);
      const ctx: Ctx = { comp, domain, n: count };
      const cur = positionField.ev(ctx) as Vec3[];
      const p = hasPos ? (evalArr(pos, ctx) as Vec3[]).map(toV) : cur;
      const o = (evalArr(off, ctx) as Vec3[]).map(toV);
      const s = evalArr(sel, ctx);
      for (let i = 0; i < count; i++) {
        if (!s[i]) continue;
        const v: Vec3 = [f32(p[i][0] + o[i][0]), f32(p[i][1] + o[i][1]), f32(p[i][2] + o[i][2])];
        if (c instanceof Instances) { const m = c.mats[i].slice(); m[12] = v[0]; m[13] = v[1]; m[14] = v[2]; c.mats[i] = m; }
        else { c.pos[i * 3] = v[0]; c.pos[i * 3 + 1] = v[1]; c.pos[i * 3 + 2] = v[2]; }
      }
      return c;
    };
    if (g.mesh) out.mesh = apply(g.mesh, g.mesh.points, "point") as Mesh;
    if (g.points) out.points = apply(g.points, g.points.points, "point") as Points;
    if (g.curves) out.curves = apply(g.curves, g.curves.points, "point") as Curves;
    if (g.instances) out.instances = apply(g.instances, g.instances.count, "instance") as Instances;
    return out;
  }

  private instanceOnPoints(r: TreeRun, n: GNode): Geo {
    const g = asGeo(r.in(n, "Points"));
    const instGeo = asGeo(r.in(n, "Instance"));
    const pick = r.in(n, "Pick Instance");
    const sel = r.in(n, "Selection"), idxV = r.in(n, "Instance Index"), rot = r.in(n, "Rotation"), scl = r.in(n, "Scale");
    const out = new Instances();
    if (g.instances) {
      const base = g.instances.clone();
      out.refs = base.refs; out.handle = base.handle; out.mats = base.mats; out.inst = base.inst;
    }
    const pickAny = isField(pick) || !!toF(pick);
    let wholeRef = -1;
    const srcInst = instGeo.instances;
    const parts: { attrs: AttrMap; n: number }[] = [{ attrs: out.inst, n: out.count }];
    for (const { comp, n: count } of componentsFor(g, "point")) {
      const ctx: Ctx = { comp, domain: "point", n: count };
      const s = evalArr(sel, ctx), pk = evalArr(pick, ctx), ii = evalArr(idxV, ctx);
      const rq = (evalArr(rot, ctx) as unknown[]).map(toQ), sc = (evalArr(scl, ctx) as unknown[]).map(toV);
      const P = (comp as Mesh | Points | Curves).pos;
      const rows: number[] = [];
      for (let i = 0; i < count; i++) {
        if (!s[i]) continue;
        const m = locRotScale([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], rq[i], sc[i]);
        if (pickAny && pk[i] && srcInst && srcInst.count) {
          const k = ((toI(ii[i]) % srcInst.count) + srcInst.count) % srcInst.count;
          const ref = out.addRef(srcInst.refs[srcInst.handle[k]]);
          out.handle.push(ref);
          out.mats.push(mul(m, srcInst.mats[k]));
        } else if (pickAny && pk[i]) {
          out.handle.push(out.addRef(Geo.empty()));
          out.mats.push(m);
        } else {
          if (wholeRef < 0) wholeRef = out.addRef(instGeo);
          out.handle.push(wholeRef);
          out.mats.push(m);
        }
        rows.push(i);
      }
      const attrs = pickAttrs((comp as Mesh | Points | Curves).point, rows);
      attrs.delete("position"); attrs.delete("radius");
      parts.push({ attrs, n: rows.length });
    }
    out.inst = concatAttrs(parts);
    dedupeRefs(out);
    return Geo.of(out);
  }

  private duplicatePoints(r: TreeRun, n: GNode, key: string): Geo {
    const g = asGeo(r.in(n, "Geometry"));
    const amount = r.in(n, "Amount"), sel = r.in(n, "Selection");
    const out = new Geo();
    const src = g.points ?? null;
    if (g.mesh || g.curves) throw new Error("gn: duplicate points on mesh / curves");
    if (src) {
      const ctx: Ctx = { comp: src, domain: "point", n: src.points };
      const a = evalArr(amount, ctx).map(toI), s = evalArr(sel, ctx);
      const rows: number[] = [], dup: number[] = [];
      for (let i = 0; i < src.points; i++) {
        if (!s[i]) continue;
        for (let k = 0; k < Math.max(0, a[i]); k++) { rows.push(i); dup.push(k); }
      }
      const p = new Points(rows.flatMap(i => [src.pos[i * 3], src.pos[i * 3 + 1], src.pos[i * 3 + 2]]));
      p.point = pickAttrs(src.point, rows);
      p.point.set(key, { size: 1, data: Float32Array.from(dup) });
      out.points = p;
    }
    return out;
  }

  private stringToCurves(text: string, size: number): Geo {
    const font = this.kit.font;
    if (!font) throw new Error("gn: no font data for String to Curves");
    const inst = new Instances();
    const refs = new Map<string, number>();
    let x = 0;
    for (const ch of text) {
      const gl = font.glyphs[ch];
      if (!gl) { x += font.space; continue; }
      if (gl.loops.length) {
        let h = refs.get(ch);
        if (h === undefined) {
          const pos: number[] = [], starts = [0];
          for (const l of gl.loops) { for (let i = 0; i < l.length; i += 2) pos.push(f32(l[i] * size), f32(l[i + 1] * size), 0); starts.push(pos.length / 3); }
          const c = new Curves(pos, starts);
          c.cyclic.fill(1);
          if (gl.fill) c.fill = { tris: gl.fill, pos: gl.fillPos && Array.from(gl.fillPos, v => f32(v * size)) };
          h = inst.addRef(Geo.of(c));
          refs.set(ch, h);
        }
        const m = identity(); m[12] = f32(x * size);
        inst.handle.push(h); inst.mats.push(m);
      }
      x += gl.advance;
    }
    return Geo.of(inst);
  }
}

// ------------------------------------------------------------------ helpers

const SOCK: Record<string, string> = {
  NodeSocketFloat: "VALUE", NodeSocketInt: "INT", NodeSocketBool: "BOOLEAN", NodeSocketVector: "VECTOR",
  NodeSocketRotation: "ROTATION", NodeSocketString: "STRING", NodeSocketMenu: "MENU", NodeSocketGeometry: "GEOMETRY",
  NodeSocketColor: "RGBA",
};
function sockIface(i: GIface, v: unknown): Value {
  if (i.socket_type === "NodeSocketGeometry") return Geo.empty();
  if (i.socket_type === "NodeSocketBool") return v ? 1 : 0;
  if (i.socket_type === "NodeSocketVector") return isVec(v) ? (v as Vec3) : [0, 0, 0];
  if (i.socket_type === "NodeSocketColor") return isCol(v) ? (v.map(f32) as Rgba) : [0, 0, 0, 1];
  if (typeof v === "number") return f32(v);
  return (v ?? 0) as Value;
}
function single2v(v: Value): Value {
  if (isField(v)) throw new Error("gn: expected a single vector");
  return v;
}

function transformGeo(g: Geo, m: Mat4): Geo {
  const out = g.shallow();
  if (g.mesh) { const c = g.mesh.clone(); transformPositions(c.pos, m); out.mesh = c; }
  if (g.points) { const c = g.points.clone(); transformPositions(c.pos, m); out.points = c; }
  if (g.curves) { const c = g.curves.clone(); transformPositions(c.pos, m); out.curves = c; }
  if (g.instances) { const c = g.instances.clone(); c.mats = c.mats.map(x => mul(m, x)); out.instances = c; }
  return out;
}

function deleteFaces(m: Mesh, sel: unknown[]): Mesh {
  const keep: number[] = [];
  for (let f = 0; f < m.faces; f++) if (!sel[f]) keep.push(f);
  // the remaining vertices keep their order
  const remap = new Int32Array(m.points).fill(-1);
  for (const f of keep) for (const v of m.face_(f)) remap[v] = 0;
  const vrows: number[] = [];
  for (let v = 0; v < m.points; v++) if (remap[v] === 0) { remap[v] = vrows.length; vrows.push(v); }
  const faces = keep.map(f => Array.from(m.face_(f), v => remap[v]));
  const out = new Mesh(vrows.flatMap(v => [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]), faces, m.materials);
  keep.forEach((f, i) => { out.matIndex[i] = m.matIndex[f]; out.smooth[i] = m.smooth[f]; });
  out.point = pickAttrs(m.point, vrows);
  out.face = pickAttrs(m.face, keep);
  if (m.corner.size) {
    const crows: number[] = [];
    for (const f of keep) for (let c = m.faceStart[f]; c < m.faceStart[f + 1]; c++) crows.push(c);
    out.corner = pickAttrs(m.corner, crows);
  }
  return out;
}

function extrudeFacesIndividual(m: Mesh, sel: unknown[], off: Vec3[], sc: number[]): Mesh {
  const pos = Array.from(m.pos);
  const faces: number[][] = [];
  const matIdx: number[] = [], smooth: number[] = [];
  const top: number[][] = [];
  for (let f = 0; f < m.faces; f++) {
    const fv = Array.from(m.face_(f));
    if (!sel[f]) { faces.push(fv); matIdx.push(m.matIndex[f]); smooth.push(m.smooth[f]); continue; }
    const o = toV(off[f]), s = toF(sc[f]);
    const nv = fv.map(v => {
      pos.push(f32(m.pos[v * 3] + f32(o[0] * s)), f32(m.pos[v * 3 + 1] + f32(o[1] * s)), f32(m.pos[v * 3 + 2] + f32(o[2] * s)));
      return pos.length / 3 - 1;
    });
    top.push(nv);
    faces.push(nv); matIdx.push(m.matIndex[f]); smooth.push(m.smooth[f]);
    for (let k = 0; k < fv.length; k++) {
      const k2 = (k + 1) % fv.length;
      faces.push([fv[k], fv[k2], nv[k2], nv[k]]); matIdx.push(m.matIndex[f]); smooth.push(0);
    }
  }
  const out = new Mesh(pos, faces, m.materials);
  matIdx.forEach((k, i) => { out.matIndex[i] = k; out.smooth[i] = smooth[i]; });
  return out;
}

/**
 * Extrude Mesh (Faces, not individual): the selected regions move by the
 * face offsets mixed onto their vertices; vertices on region boundaries are
 * duplicated and every boundary edge gets a side quad [a', a, b, b'] (a → b
 * in the extruded face). The moved faces keep their indices, side faces and
 * new vertices are appended, like extrude_mesh_face_regions.
 */
function extrudeRegions(m: Mesh, sel: unknown[], off: Vec3[], sc: number[], singleOffset: boolean): Mesh {
  const nv = m.points, nf = m.faces;
  const fsel = Uint8Array.from({ length: nf }, (_, f) => (sel[f] ? 1 : 0));
  if (!fsel.includes(1)) return m;
  const faceOffset = (f: number): Vec3 => { const o = toV(off[f]), s = toF(sc[f]); return [f32(o[0] * s), f32(o[1] * s), f32(o[2] * s)]; };
  // vertex offsets: mean of the selected faces' offsets (a single offset is used as is)
  const vo = new Float32Array(nv * 3), vw = new Float32Array(nv);
  for (let f = 0; f < nf; f++) {
    if (!fsel[f]) continue;
    const o = faceOffset(f);
    for (const v of m.face_(f)) { for (let k = 0; k < 3; k++) vo[v * 3 + k] += o[k]; vw[v] += 1; }
  }
  const one = singleOffset ? faceOffset(fsel.indexOf(1)) : null;
  for (let v = 0; v < nv; v++) {
    if (!vw[v]) continue;
    const inv = f32(1 / vw[v]);
    for (let k = 0; k < 3; k++) vo[v * 3 + k] = one ? one[k] : f32(vo[v * 3 + k] * inv);
  }
  // edge use counts (all faces / selected faces)
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const all = new Map<number, number>(), selUse = new Map<number, number>();
  for (let f = 0; f < nf; f++) {
    const fv = m.face_(f);
    for (let k = 0; k < fv.length; k++) {
      const e = key(fv[k], fv[(k + 1) % fv.length]);
      all.set(e, (all.get(e) ?? 0) + 1);
      if (fsel[f]) selUse.set(e, (selUse.get(e) ?? 0) + 1);
    }
  }
  // duplicate the vertices of boundary edges (one selected face) and of edges
  // shared with unselected faces
  const dup = new Int32Array(nv).fill(-1);
  const newVerts: number[] = [];
  const sides: { a: number; b: number; f: number }[] = [];
  const split = (v: number) => { if (dup[v] < 0) { dup[v] = nv + newVerts.length; newVerts.push(v); } };
  for (let f = 0; f < nf; f++) {
    if (!fsel[f]) continue;
    const fv = m.face_(f);
    for (let k = 0; k < fv.length; k++) {
      const a = fv[k], b = fv[(k + 1) % fv.length], e = key(a, b);
      const s = selUse.get(e)!, t = all.get(e)!;
      if (s === 1) { split(a); split(b); sides.push({ a, b, f }); } else if (t > s) { split(a); split(b); }
    }
  }
  const pos = new Float32Array((nv + newVerts.length) * 3);
  pos.set(m.pos);
  for (let v = 0; v < nv; v++) {
    if (!vw[v]) continue;
    const at = dup[v] >= 0 ? dup[v] : v;
    for (let k = 0; k < 3; k++) pos[at * 3 + k] = f32(m.pos[v * 3 + k] + vo[v * 3 + k]);
  }
  const faces: number[][] = [];
  for (let f = 0; f < nf; f++) faces.push(Array.from(m.face_(f), v => (fsel[f] && dup[v] >= 0 ? dup[v] : v)));
  for (const s of sides) faces.push([dup[s.a], s.a, s.b, dup[s.b]]);
  const out = new Mesh(pos, faces, m.materials);
  const faceRows = [...Array.from({ length: nf }, (_, f) => f), ...sides.map(s => s.f)];
  faceRows.forEach((f, i) => { out.matIndex[i] = m.matIndex[f]; out.smooth[i] = m.smooth[f]; });
  out.point = concatAttrs([{ attrs: m.point, n: nv }, { attrs: pickAttrs(m.point, newVerts), n: newVerts.length }]);
  out.face = pickAttrs(m.face, faceRows);
  out.corner = concatAttrs([{ attrs: m.corner, n: m.cornerCount }, { attrs: new Map(), n: sides.length * 4 }]);
  return out;
}

/** Flip Faces: reverse each selected face's corners, keeping the first */
function flipFaces(m: Mesh, sel: unknown[]): Mesh {
  const out = m.clone();
  const swap = (d: Float32Array | Int32Array, size: number, i: number, j: number) => {
    for (let k = 0; k < size; k++) { const t = d[i * size + k]; d[i * size + k] = d[j * size + k]; d[j * size + k] = t; }
  };
  for (let f = 0; f < m.faces; f++) {
    if (!sel[f]) continue;
    const a = m.faceStart[f], n = m.faceStart[f + 1] - a;
    for (let j = 0; j < n >> 1; j++) {
      swap(out.corners, 1, a + 1 + j, a + n - 1 - j);
      for (const at of out.corner.values()) swap(at.data, at.size, a + 1 + j, a + n - 1 - j);
    }
  }
  return out;
}

/**
 * Merge by Distance (All): BLI_kdtree calc_duplicates_fast in index order —
 * each vertex not merged yet takes every free vertex within the distance —
 * then weld: merged vertices average their positions and attributes (weights
 * 1/n, index order), faces drop repeated corners, faces under 3 corners go.
 */
function mergeByDistance(m: Mesh, dist: number, sel: unknown[]): Mesh {
  const n = m.points, P = m.pos;
  const dest = new Int32Array(n).fill(-1);
  const r2 = f32(dist * dist), cell = dist > 0 ? dist : 1;
  const cellOf = (v: number) => [Math.floor(P[v * 3] / cell), Math.floor(P[v * 3 + 1] / cell), Math.floor(P[v * 3 + 2] / cell)];
  const buckets = new Map<string, number[]>();
  for (let v = 0; v < n; v++) {
    if (!sel[v]) continue;
    const k = cellOf(v).join(",");
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(v);
  }
  let merged = 0;
  for (let i = 0; i < n; i++) {
    if (!sel[i] || (dest[i] !== -1 && dest[i] !== i)) continue;
    const [cx, cy, cz] = cellOf(i);
    let hit = false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (j === i || dest[j] !== -1) continue;
        const ex = f32(P[j * 3] - P[i * 3]), ey = f32(P[j * 3 + 1] - P[i * 3 + 1]), ez = f32(P[j * 3 + 2] - P[i * 3 + 2]);
        if (f32(f32(f32(ex * ex) + f32(ey * ey)) + f32(ez * ez)) <= r2) { dest[j] = i; hit = true; merged++; }
      }
    }
    if (hit) dest[i] = i;
  }
  if (!merged) return m;
  const newIdx = new Int32Array(n);
  const keep: number[] = [];
  const groups = new Map<number, number[]>();
  for (let v = 0; v < n; v++) {
    if (dest[v] === -1 || dest[v] === v) { newIdx[v] = keep.length; keep.push(v); }
    if (dest[v] !== -1) (groups.get(dest[v]) ?? groups.set(dest[v], []).get(dest[v])!).push(v);
  }
  for (let v = 0; v < n; v++) if (dest[v] !== -1 && dest[v] !== v) newIdx[v] = newIdx[dest[v]];
  // CustomData_interp with default weights: Σ f32(src · 1/n) in index order
  const weld = (src: Float32Array, size: number): Float32Array => {
    const d = new Float32Array(keep.length * size);
    keep.forEach((v, i) => {
      const g = groups.get(v);
      if (!g) { for (let k = 0; k < size; k++) d[i * size + k] = src[v * size + k]; return; }
      const w = f32(1 / g.length);
      for (let k = 0; k < size; k++) {
        let s = 0;
        for (const u of g) s = f32(s + f32(src[u * size + k] * w));
        d[i * size + k] = s;
      }
    });
    return d;
  };
  const faces: number[][] = [], faceRows: number[] = [], cornerRows: number[] = [];
  for (let f = 0; f < m.faces; f++) {
    const a = m.faceStart[f], cnt = m.faceStart[f + 1] - a;
    const vs: number[] = [], cs: number[] = [];
    for (let k = 0; k < cnt; k++) {
      const v = newIdx[m.corners[a + k]];
      if (vs.length && vs[vs.length - 1] === v) continue;
      vs.push(v); cs.push(a + k);
    }
    while (vs.length > 1 && vs[0] === vs[vs.length - 1]) { vs.pop(); cs.pop(); }
    if (vs.length < 3) continue;
    faces.push(vs); faceRows.push(f); cornerRows.push(...cs);
  }
  const out = new Mesh(weld(P, 3), faces, m.materials);
  faceRows.forEach((f, i) => { out.matIndex[i] = m.matIndex[f]; out.smooth[i] = m.smooth[f]; });
  for (const [k, a] of m.point) out.point.set(k, { size: a.size, data: weld(a.data, a.size) });
  out.face = pickAttrs(m.face, faceRows);
  out.corner = pickAttrs(m.corner, cornerRows);
  return out;
}

/** BLI RandomNumberGenerator (drand48) */
class BlenderRng {
  private x: bigint;
  constructor(seed: number) { this.x = (BigInt(seed >>> 0) << 16n) | 0x330en; }
  private int32(): number {
    this.x = (0x5deece66dn * this.x + 0xbn) & 0xffffffffffffn;
    return Number(this.x >> 17n) | 0;
  }
  float(): number { return f32(this.int32() / 0x80000000); }
  barycentric(): Vec3 {
    let r1 = this.float(), r2 = this.float();
    if (f32(r1 + r2) > 1) { r1 = f32(1 - r1); r2 = f32(1 - r2); }
    return [r1, r2, f32(f32(1 - r1) - r2)];
  }
}

/** corner triangles: triangles as is, quads (0 1 2)(0 2 3), n-gons as fans (Blender uses polyfill) */
function cornerTris(m: Mesh): number[] {
  const out: number[] = [];
  for (let f = 0; f < m.faces; f++) {
    const a = m.faceStart[f], n = m.faceStart[f + 1] - a;
    for (let k = 1; k + 1 < n; k++) out.push(a, a + k, a + k + 1);
  }
  return out;
}

/**
 * Distribute Points on Faces: per corner triangle a RandomNumberGenerator
 * seeded with hash(tri, seed) decides the point count (area · density) and
 * the barycentric positions; Poisson Disk then drops, in index order, every
 * point closer than the minimum distance to a kept one, and points above the
 * interpolated density factor (hash of the barycentric coordinates).
 */
function distributePoints(m: Mesh, density: number, seed: number, minDist: number, poisson: boolean, cornerDensity: number[]): Points {
  const P = m.pos;
  const vp = (c: number): Vec3 => { const v = m.corners[c]; return [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]; };
  const tris = cornerTris(m);
  const pos: number[] = [], bary: Vec3[] = [], triOf: number[] = [];
  for (let t = 0; t < tris.length / 3; t++) {
    const c0 = tris[t * 3], c1 = tris[t * 3 + 1], c2 = tris[t * 3 + 2];
    const v0 = vp(c0), v1 = vp(c1), v2 = vp(c2);
    const factor = poisson ? 1
      : f32(f32(f32(Math.max(0, cornerDensity[c0]) + Math.max(0, cornerDensity[c1])) + Math.max(0, cornerDensity[c2])) / 3);
    const n1: Vec3 = [f32(v0[0] - v1[0]), f32(v0[1] - v1[1]), f32(v0[2] - v1[2])];
    const n2: Vec3 = [f32(v1[0] - v2[0]), f32(v1[1] - v2[1]), f32(v1[2] - v2[2])];
    const cr: Vec3 = [f32(f32(n1[1] * n2[2]) - f32(n1[2] * n2[1])), f32(f32(n1[2] * n2[0]) - f32(n1[0] * n2[2])), f32(f32(n1[0] * n2[1]) - f32(n1[1] * n2[0]))];
    const area = f32(f32(Math.sqrt(f32(f32(f32(cr[0] * cr[0]) + f32(cr[1] * cr[1])) + f32(cr[2] * cr[2])))) * 0.5);
    const rng = new BlenderRng(hashInt2d(t, seed));
    const amount = f32(f32(area * density) * factor);
    const add = f32(amount - Math.floor(amount)) > rng.float();
    const count = Math.trunc(amount) + (add ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const b = rng.barycentric();
      for (let k = 0; k < 3; k++) pos.push(f32(f32(f32(v0[k] * b[0]) + f32(v1[k] * b[1])) + f32(v2[k] * b[2])));
      bary.push(b); triOf.push(t);
    }
  }
  let keep = bary.map((_, i) => i);
  if (poisson) {
    const n = bary.length, gone = new Uint8Array(n);
    if (minDist > 0) {
      const r2 = f32(minDist * minDist);
      const cellOf = (i: number) => [Math.floor(pos[i * 3] / minDist), Math.floor(pos[i * 3 + 1] / minDist), Math.floor(pos[i * 3 + 2] / minDist)];
      const buckets = new Map<string, number[]>();
      for (let i = 0; i < n; i++) { const k = cellOf(i).join(","); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i); }
      for (let i = 0; i < n; i++) {
        if (gone[i]) continue;
        const [cx, cy, cz] = cellOf(i);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const j of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j === i) continue;
            const ex = f32(pos[j * 3] - pos[i * 3]), ey = f32(pos[j * 3 + 1] - pos[i * 3 + 1]), ez = f32(pos[j * 3 + 2] - pos[i * 3 + 2]);
            if (f32(f32(f32(ex * ex) + f32(ey * ey)) + f32(ez * ez)) <= r2) gone[j] = 1;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (gone[i]) continue;
      const t = triOf[i], b = bary[i];
      const d = (k: number) => Math.max(0, cornerDensity[tris[t * 3 + k]]);
      const p = f32(f32(f32(d(0) * b[0]) + f32(d(1) * b[1])) + f32(d(2) * b[2]));
      if (uintTo01(hashInt3d(floatBits(b[0]), floatBits(b[1]), floatBits(b[2]))) > p) gone[i] = 1;
    }
    // eliminate_points_based_on_mask: from the back, remove_and_reorder (the last point fills the gap)
    for (let i = n - 1; i >= 0; i--) {
      if (!gone[i]) continue;
      const last = keep.pop()!;
      if (i < keep.length) keep[i] = last;
    }
  }
  const out = new Points(keep.flatMap(i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]));
  const ids = keep.map(i => hashInt2d(hashInt3d(floatBits(bary[i][0]), floatBits(bary[i][1]), floatBits(bary[i][2])), triOf[i]) | 0);
  out.point.set("id", { size: 1, data: Float32Array.from(ids) });
  return out;
}

/** Resample Curve (Count): length_parameterize::sample_uniform + linear interpolation of every point attribute */
function resampleCount(c: Curves, count: number): Curves {
  const pos: number[] = [], starts = [0];
  const rows: [number, number, number][] = []; // (a, b, t) per output point
  for (let s = 0; s < c.splines; s++) {
    const a = c.splineStart[s], n = c.splineStart[s + 1] - a, cyc = !!c.cyclic[s];
    const segs = cyc ? n : n - 1;
    const acc: number[] = [];
    let L = 0;
    for (let i = 0; i < segs; i++) {
      const p = a + i, q = a + ((i + 1) % n);
      L = f32(L + f32(Math.hypot(c.pos[q * 3] - c.pos[p * 3], c.pos[q * 3 + 1] - c.pos[p * 3 + 1], c.pos[q * 3 + 2] - c.pos[p * 3 + 2])));
      acc.push(L);
    }
    const step = f32(L / (count - (cyc ? 0 : 1)));
    for (let i = 0; i < count; i++) {
      const len = Math.min(L, f32(i * step));
      let seg: number, t: number;
      if (!segs || len >= L) { seg = Math.max(0, segs - 1); t = segs ? 1 : 0; } else {
        seg = acc.findIndex(x => x > len);
        const start = seg === 0 ? 0 : acc[seg - 1];
        t = f32(f32(len - start) * (acc[seg] - start === 0 ? 0 : f32(1 / f32(acc[seg] - start))));
      }
      rows.push([a + seg, a + ((seg + 1) % n), t]);
    }
    starts.push(starts[starts.length - 1] + count);
  }
  const lerp = (x: number, y: number, t: number) => f32(f32(x * f32(1 - t)) + f32(y * t));
  for (const [p, q, t] of rows) for (let k = 0; k < 3; k++) pos.push(lerp(c.pos[p * 3 + k], c.pos[q * 3 + k], t));
  const out = new Curves(pos, starts);
  out.cyclic = c.cyclic.slice();
  out.normalMode = c.normalMode.slice();
  for (const [name, at] of c.point) {
    const d = new Float32Array(rows.length * at.size);
    rows.forEach(([p, q, t], i) => { for (let k = 0; k < at.size; k++) d[i * at.size + k] = lerp(at.data[p * at.size + k], at.data[q * at.size + k], t); });
    out.point.set(name, { size: at.size, data: d });
  }
  return out;
}

/** Spline Parameter: Factor (length / total), Length, Index per curve point */
function splineParameter(idx: number): Field {
  return new Field("f", c => {
    const cv = c.comp;
    const out = new Array(c.n).fill(0);
    if (!(cv instanceof Curves) || c.domain !== "point") return out;
    for (let s = 0; s < cv.splines; s++) {
      const a = cv.splineStart[s], n = cv.splineStart[s + 1] - a;
      const d = (i: number, j: number) => f32(Math.hypot(cv.pos[j * 3] - cv.pos[i * 3], cv.pos[j * 3 + 1] - cv.pos[i * 3 + 1], cv.pos[j * 3 + 2] - cv.pos[i * 3 + 2]));
      const L = [0];
      for (let i = 1; i < n; i++) L.push(f32(L[i - 1] + d(a + i - 1, a + i)));
      const total = cv.cyclic[s] && n > 1 ? f32(L[n - 1] + d(a + n - 1, a)) : L[n - 1];
      for (let i = 0; i < n; i++) {
        out[a + i] = idx === 1 ? L[i] : idx === 2 ? i : total > 0 ? f32(L[i] / total) : n > 1 ? f32(i / (n - 1)) : 0;
      }
    }
    return out;
  });
}

function dedupeRefs(inst: Instances): void {
  const seen = new Map<Geo, number>();
  const refs: Geo[] = [];
  const remap = inst.refs.map(g => {
    let k = seen.get(g);
    if (k === undefined) { k = refs.length; refs.push(g); seen.set(g, k); }
    return k;
  });
  inst.refs = refs;
  inst.handle = inst.handle.map(h => remap[h]);
}

export { xformPoint };
