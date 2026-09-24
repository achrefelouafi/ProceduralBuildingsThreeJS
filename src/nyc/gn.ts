/**
 * A geometry-nodes evaluator for the NYC_CornerBuilding.blend graphs.
 *
 * public/assets/nyc/graph.json (tools/nyc/dump_nyc_graph.py) holds the real
 * node trees; this file runs them. Values are singles or fields; a field is a
 * function of the geometry context it is evaluated on (component + domain),
 * exactly like Blender's lazy fields. Nodes operate on Geo (geo.ts). Every
 * NYC_* node type the graphs use is implemented; anything else throws, so a
 * graph change in Blender cannot silently render wrong.
 *
 * Blender behaviour reproduced on purpose:
 *  - float32 arithmetic, safe division / modulo / power, float→int truncation,
 *    int/float→bool as "> 0", vector→float as the component mean;
 *  - Random Value = lookup3 hash of (seed, id), unlinked ID = "id" or index;
 *  - multi-input sockets evaluated top to bottom (descending sort id);
 *  - Set Material / Store Named Attribute (non-instance domains) / Delete /
 *    Extrude / Fill Curve / Curve to Mesh / curve setters recurse into
 *    instance references; Set Position / Transform / Store (Instance) don't;
 *  - instance transforms = from_loc_rot_scale with Blender's quaternion path.
 */
import { ShapeUtils, Vector2 } from "three";
import { randomFloat } from "../rng";
import {
  cone, cube, Curves, Geo, identity, Instances, locRotScale, Mesh, mul, Points, transformPositions, uvSphere,
  eulerToQuat, f32, xformPoint, type Attr, type AttrMap, type Domain, type Mat4, type Quat, type Vec3,
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

type Kind = "f" | "v" | "q";
export class Field {
  constructor(readonly kind: Kind, readonly ev: (c: Ctx) => unknown[]) {}
}
type Single = number | Vec3 | Quat | string | boolean | Geo | Mat4 | null | { id: string; name: string };
export type Value = Single | Field | Value[];

export interface Ctx {
  comp: Mesh | Points | Curves | Instances | null;
  domain: Domain;
  n: number;
}

const isField = (v: unknown): v is Field => v instanceof Field;
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && typeof v[0] === "number";

function evalArr(v: Value, c: Ctx): unknown[] {
  if (isField(v)) return v.ev(c);
  return new Array(c.n).fill(v);
}

/** lift an n-ary function over singles / fields */
function lift(kind: Kind, fn: (...a: never[]) => unknown, ...args: Value[]): Value {
  if (!args.some(isField)) return fn(...(args as never[])) as Value;
  return new Field(kind, c => {
    const arrs = args.map(a => evalArr(a, c));
    const out = new Array(c.n);
    for (let i = 0; i < c.n; i++) out[i] = fn(...(arrs.map(a => a[i]) as never[]));
    return out;
  });
}

// ------------------------------------------------------------------ conversions

const toF = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isVec(v)) return f32(f32(f32(v[0] + v[1]) + v[2]) / 3);
  return 0;
};
const toI = (v: unknown): number => Math.trunc(toF(v)) | 0;
const toB = (v: unknown): number => (toF(v) > 0 ? 1 : 0);
const toV = (v: unknown): Vec3 => (isVec(v) ? v : ((x: number) => [x, x, x] as Vec3)(toF(v)));
const toQ = (v: unknown): Quat => (Array.isArray(v) && v.length === 4 ? (v as Quat) : eulerToQuat(toV(v)));

function convert(v: Value, type: string): Value {
  switch (type) {
    case "VALUE": return lift("f", toF as never, v);
    case "INT": return lift("f", toI as never, v);
    case "BOOLEAN": return lift("f", toB as never, v);
    case "VECTOR": return lift("v", toV as never, v);
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
    case "ROTATION": return eulerToQuat(isVec(v) ? (v as Vec3) : [0, 0, 0]);
    case "STRING": case "MENU": return typeof v === "string" ? v : "";
    case "GEOMETRY": return Geo.empty();
    default: return (v ?? null) as Value;
  }
}

// ------------------------------------------------------------------ math

function math(op: string, a: number, b: number, c: number): number {
  switch (op) {
    case "ADD": return f32(a + b);
    case "SUBTRACT": return f32(a - b);
    case "MULTIPLY": return f32(a * b);
    case "DIVIDE": return b === 0 ? 0 : f32(a / b);
    case "MULTIPLY_ADD": return f32(f32(a * b) + c);
    case "COMPARE": return Math.abs(f32(a - b)) <= Math.max(c, 1.1920928955078125e-7) ? 1 : 0;
    case "LESS_THAN": return a < b ? 1 : 0;
    case "GREATER_THAN": return a > b ? 1 : 0;
    case "MAXIMUM": return Math.max(a, b);
    case "MINIMUM": return Math.min(a, b);
    case "COSINE": return f32(Math.cos(a));
    case "SINE": return f32(Math.sin(a));
    case "TANGENT": return f32(Math.tan(a));
    case "ARCTANGENT": return f32(Math.atan(a));
    case "ARCTAN2": return f32(Math.atan2(a, b));
    case "ROUND": return Math.floor(f32(a + 0.5));
    case "FLOOR": return Math.floor(a);
    case "FRACT": return f32(a - Math.floor(a));
    case "ABSOLUTE": return Math.abs(a);
    case "SIGN": return a > 0 ? 1 : a < 0 ? -1 : 0;
    case "FLOORED_MODULO": return b === 0 ? 0 : f32(a - f32(Math.floor(f32(a / b)) * b));
    case "POWER": {
      if (a >= 0) return f32(Math.pow(a, b));
      const fb = Math.floor(b);
      return fb === b ? f32(Math.pow(a, b)) : 0;
    }
    default: throw new Error(`gn: math op ${op}`);
  }
}

// ------------------------------------------------------------------ field inputs

function attrOf(comp: Ctx["comp"], domain: Domain): AttrMap | null {
  if (!comp) return null;
  if (comp instanceof Mesh) return domain === "face" ? comp.face : comp.point;
  if (comp instanceof Points) return comp.point;
  if (comp instanceof Curves) return comp.point;
  return comp.inst;
}

function readAttr(c: Ctx, name: string, size: 1 | 3): unknown[] {
  const out = new Array(c.n);
  const comp = c.comp;
  const direct = attrOf(comp, c.domain)?.get(name);
  const get = (a: Attr, i: number) =>
    a.size === size ? (size === 1 ? a.data[i] : [a.data[i * 3], a.data[i * 3 + 1], a.data[i * 3 + 2]])
      : size === 1 ? f32(f32(f32(a.data[i * 3] + a.data[i * 3 + 1]) + a.data[i * 3 + 2]) / 3) : [a.data[i], a.data[i], a.data[i]];
  if (direct) { for (let i = 0; i < c.n; i++) out[i] = get(direct, i); return out; }
  if (comp instanceof Mesh) {
    // adapt between the point and face domains (mean, like attribute_interpolate)
    const other = c.domain === "face" ? comp.point.get(name) : comp.face.get(name);
    if (other) {
      if (c.domain === "face") {
        for (let f = 0; f < comp.faces; f++) {
          const vs = comp.face_(f);
          out[f] = mean(vs.length, k => get(other, vs[k]), size);
        }
      } else {
        const acc: unknown[][] = Array.from({ length: comp.points }, () => []);
        for (let f = 0; f < comp.faces; f++) for (const v of comp.face_(f)) acc[v].push(get(other, f));
        for (let i = 0; i < c.n; i++) out[i] = mean(acc[i].length, k => acc[i][k], size);
      }
      return out;
    }
  }
  return out.fill(size === 1 ? 0 : [0, 0, 0]);
}
function mean(n: number, at: (k: number) => unknown, size: 1 | 3): unknown {
  if (!n) return size === 1 ? 0 : [0, 0, 0];
  if (size === 1) { let s = 0; for (let k = 0; k < n; k++) s += at(k) as number; return f32(s / n); }
  const s = [0, 0, 0];
  for (let k = 0; k < n; k++) { const v = at(k) as Vec3; s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
  return [f32(s[0] / n), f32(s[1] / n), f32(s[2] / n)];
}

const positionField = new Field("v", c => {
  const comp = c.comp;
  const out: Vec3[] = new Array(c.n);
  if (!comp) return out.fill([0, 0, 0]);
  if (comp instanceof Instances) { for (let i = 0; i < c.n; i++) { const m = comp.mats[i]; out[i] = [m[12], m[13], m[14]]; } return out; }
  if (comp instanceof Mesh && c.domain === "face") { for (let i = 0; i < c.n; i++) out[i] = comp.faceCenter(i); return out; }
  const P = comp.pos;
  for (let i = 0; i < c.n; i++) out[i] = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  return out;
});
const indexField = new Field("f", c => Array.from({ length: c.n }, (_, i) => i));
const normalField = new Field("v", c => {
  const comp = c.comp;
  if (comp instanceof Mesh) {
    if (c.domain === "face") return Array.from({ length: c.n }, (_, i) => comp.faceNormal(i));
    const vn = comp.vertexNormals();
    return Array.from({ length: c.n }, (_, i) => [vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]]);
  }
  return new Array(c.n).fill([0, 0, 1]);
});
const idField = new Field("f", c => {
  const a = attrOf(c.comp, c.domain)?.get("id");
  return Array.from({ length: c.n }, (_, i) => (a ? a.data[i] : i));
});
const namedAttr = (name: string, size: 1 | 3) => new Field(size === 1 ? "f" : "v", c => readAttr(c, name, size));

// ------------------------------------------------------------------ geometry helpers

function componentsFor(g: Geo, domain: Domain): { comp: Mesh | Points | Curves | Instances; n: number }[] {
  const out: { comp: Mesh | Points | Curves | Instances; n: number }[] = [];
  if (domain === "instance") { if (g.instances) out.push({ comp: g.instances, n: g.instances.count }); return out; }
  if (domain === "face") { if (g.mesh) out.push({ comp: g.mesh, n: g.mesh.faces }); return out; }
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

function setAttr(map: AttrMap, name: string, size: 1 | 3, n: number, vals: unknown[], sel: unknown[] | null): void {
  let a = map.get(name);
  if (!a || a.size !== size || a.data.length !== n * size) {
    const old = a;
    a = { size, data: new Float32Array(n * size) };
    if (old && old.data.length === n * old.size) {
      for (let i = 0; i < n; i++) {
        if (size === 1) a.data[i] = old.size === 1 ? old.data[i] : f32(f32(f32(old.data[i * 3] + old.data[i * 3 + 1]) + old.data[i * 3 + 2]) / 3);
        else for (let k = 0; k < 3; k++) a.data[i * 3 + k] = old.size === 3 ? old.data[i * 3 + k] : old.data[i];
      }
    }
    map.set(name, a);
  }
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    if (size === 1) a.data[i] = toF(vals[i]);
    else { const v = toV(vals[i]); a.data[i * 3] = v[0]; a.data[i * 3 + 1] = v[1]; a.data[i * 3 + 2] = v[2]; }
  }
}

function copyComp<T extends Mesh | Points | Curves | Instances>(c: T): T { return c.clone() as T; }

/** gather rows of an AttrMap (for duplicate / delete / propagation) */
function pickAttrs(src: AttrMap, rows: number[]): AttrMap {
  const out: AttrMap = new Map();
  for (const [k, a] of src) {
    const d = new Float32Array(rows.length * a.size);
    for (let i = 0; i < rows.length; i++) for (let s = 0; s < a.size; s++) d[i * a.size + s] = a.data[rows[i] * a.size + s];
    out.set(k, { size: a.size, data: d });
  }
  return out;
}

function concatAttrs(parts: { attrs: AttrMap; n: number }[]): AttrMap {
  const names = new Map<string, 1 | 3>();
  for (const p of parts) for (const [k, a] of p.attrs) if (!names.has(k) || a.size === 3) names.set(k, a.size);
  const total = parts.reduce((s, p) => s + p.n, 0);
  const out: AttrMap = new Map();
  for (const [k, size] of names) {
    const d = new Float32Array(total * size);
    let off = 0;
    for (const p of parts) {
      const a = p.attrs.get(k);
      if (a) for (let i = 0; i < p.n; i++) for (let s = 0; s < size; s++) d[(off + i) * size + s] = a.size === size ? a.data[i * size + s] : a.data[i * a.size];
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
  const walk = (geo: Geo, m: Mat4, inherited: { name: string; size: 1 | 3; v: number[] }[]) => {
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
        const own: { name: string; size: 1 | 3; v: number[] }[] = [];
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
      }
      if (fillCaps && !cyc && pcyc && pn > 2) {
        faces.push(Array.from({ length: pn }, (_, j) => base + (pn - 1 - j)));
        faces.push(Array.from({ length: pn }, (_, j) => base + (n - 1) * pn + j));
      }
    }
  }
  return new Mesh(pos, faces);
}

/** Fill Curve (Triangles, Even-Odd): planar XY fill of the cyclic splines */
function fillCurves(c: Curves): Mesh {
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

export interface GlyphData { advance: number; loops: number[][] }
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
        const op = P.operation as string;
        return lift("f", ((a: number, b: number, c: number) => math(op, toF(a), toF(b), toF(c))) as never, Ii(0), Ii(1), Ii(2));
      }
      case "ShaderNodeVectorMath": {
        const op = P.operation as string;
        if (op === "ADD") return lift("v", ((a: Vec3, b: Vec3) => [f32(a[0] + b[0]), f32(a[1] + b[1]), f32(a[2] + b[2])]) as never, Ii(0), Ii(1));
        if (op === "SCALE") return lift("v", ((a: Vec3, s: number) => [f32(a[0] * s), f32(a[1] * s), f32(a[2] * s)]) as never, Ii(0), Ii(3));
        throw new Error(`gn: vector math ${op}`);
      }
      case "ShaderNodeCombineXYZ": return lift("v", ((x: number, y: number, z: number) => [x, y, z]) as never, Ii(0), Ii(1), Ii(2));
      case "ShaderNodeSeparateXYZ": return lift("f", ((v: Vec3) => v[idx]) as never, Ii(0));
      case "FunctionNodeBooleanMath": {
        if (P.operation !== "NOT") throw new Error(`gn: boolean ${P.operation}`);
        return lift("f", ((a: number) => (a ? 0 : 1)) as never, Ii(0));
      }
      case "FunctionNodeEulerToRotation": return lift("q", ((e: Vec3) => eulerToQuat(e)) as never, Ii(0));
      case "FunctionNodeRandomValue": {
        if (P.data_type !== "FLOAT") throw new Error("gn: random type");
        return lift("f", ((lo: number, hi: number, id: number, seed: number) => randomFloat(lo, hi, toI(id), toI(seed))) as never,
          Ii(2), Ii(3), Ii(7), Ii(8));
      }
      case "GeometryNodeSwitch": {
        const c = Ii(0);
        if (P.input_type === "GEOMETRY") return single(c, "switch") ? Ii(2) : Ii(1);
        return lift("f", ((s: number, f: number, t: number) => (s ? t : f)) as never, c, Ii(1), Ii(2));
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
        return new Field("f", c => {
          const ia = evalArr(iv, c), va = vals.map(v => evalArr(v, c));
          return ia.map((x, e) => { const k = toI(x); return k >= 0 && k < va.length ? va[k][e] : 0; });
        });
      }
      // ---------------- field inputs
      case "GeometryNodeInputIndex": return indexField;
      case "GeometryNodeInputPosition": return positionField;
      case "GeometryNodeInputNormal": return normalField;
      case "GeometryNodeInputNamedAttribute": {
        const nm = String(I("Name"));
        if (idx === 1) return new Field("f", c => { const a = attrOf(c.comp, c.domain); return new Array(c.n).fill(a?.has(nm) ? 1 : 0); });
        return namedAttr(nm, P.data_type === "FLOAT_VECTOR" ? 3 : 1);
      }
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
        const size: 1 | 3 = P.data_type === "FLOAT_VECTOR" ? 3 : 1;
        if (P.data_type !== "FLOAT" && P.data_type !== "FLOAT_VECTOR") throw new Error("gn: store type");
        const val = I("Value"), sel = I("Selection");
        const store = (g: Geo): Geo => {
          const out = g.shallow();
          for (const { comp, n: count } of componentsFor(g, dom)) {
            const c = copyComp(comp);
            const ctx: Ctx = { comp: c, domain: dom, n: count };
            const v = evalArr(val, ctx), s = evalArr(sel, ctx);
            const map = c instanceof Mesh ? (dom === "face" ? c.face : c.point) : c instanceof Instances ? c.inst : c.point;
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
        if (P.domain !== "FACE" || P.mode !== "ALL") throw new Error("gn: delete mode");
        const sel = I("Selection");
        return modifyRecursive(asGeo(I("Geometry")), g => {
          if (!g.mesh) return g;
          g.mesh = deleteFaces(g.mesh, evalArr(sel, { comp: g.mesh, domain: "face", n: g.mesh.faces }));
          return g;
        });
      }
      case "GeometryNodeExtrudeMesh": {
        if (P.mode !== "FACES" || idx !== 0) throw new Error("gn: extrude mode");
        const sel = I("Selection"), off = I("Offset"), sc = I("Offset Scale");
        return modifyRecursive(asGeo(I("Mesh")), g => {
          if (!g.mesh) return g;
          const m = g.mesh;
          const ctx: Ctx = { comp: m, domain: "face", n: m.faces };
          g.mesh = extrudeFacesIndividual(m, evalArr(sel, ctx), evalArr(off, ctx) as Vec3[], evalArr(sc, ctx) as number[]);
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
};
function sockIface(i: GIface, v: unknown): Value {
  if (i.socket_type === "NodeSocketGeometry") return Geo.empty();
  if (i.socket_type === "NodeSocketBool") return v ? 1 : 0;
  if (i.socket_type === "NodeSocketVector") return isVec(v) ? (v as Vec3) : [0, 0, 0];
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
  const used = new Map<number, number>();
  const faces: number[][] = [];
  const vrows: number[] = [];
  for (const f of keep) faces.push(Array.from(m.face_(f), v => {
    if (!used.has(v)) { used.set(v, vrows.length); vrows.push(v); }
    return used.get(v)!;
  }));
  const out = new Mesh(vrows.flatMap(v => [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]), faces, m.materials);
  keep.forEach((f, i) => { out.matIndex[i] = m.matIndex[f]; out.smooth[i] = m.smooth[f]; });
  out.point = pickAttrs(m.point, vrows);
  out.face = pickAttrs(m.face, keep);
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
