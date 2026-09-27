/**
 * Geometry data for the geometry-nodes evaluator (gn.ts): meshes, point
 * clouds, poly curves and instances, with named attributes per domain, in
 * Blender Z-up space. Mirrors the parts of Blender's GeometrySet the
 * NYC_CornerBuilding.blend and CN_ApartmentBuilding.blend graphs use;
 * arithmetic is float32 (Math.fround) wherever Blender stores floats.
 */
export const f32 = Math.fround;

export type Vec3 = [number, number, number];
/** Blender quaternion (w, x, y, z) */
export type Quat = [number, number, number, number];
/** 4×4 column-major (three.js Matrix4.elements order) */
export type Mat4 = Float32Array;

export type Domain = "point" | "face" | "corner" | "instance" | "spline";

/**
 * attribute storage, floats per element: 1 (float / int / bool), 2 (FLOAT2,
 * e.g. UV maps), 3 (vector) or 4 (RGBA color)
 */
export type AttrSize = 1 | 2 | 3 | 4;
export interface Attr {
  size: AttrSize;
  data: Float32Array;
}
export type AttrMap = Map<string, Attr>;

let nextId = 1;

export class Mesh {
  /** stable identity for the renderer: meshes shared by reference render instanced */
  readonly uid = nextId++;
  /** kit object this mesh came from unmodified (Object / Collection Info), if any */
  source: string | null = null;
  pos: Float32Array;
  /** face → first corner; faceStart.length = faces + 1 */
  faceStart: Int32Array;
  corners: Int32Array;
  matIndex: Int32Array;
  materials: (string | null)[];
  point: AttrMap = new Map();
  face: AttrMap = new Map();
  corner: AttrMap = new Map();
  /** shading hint: flat faces (cubes, caps) vs smooth sides */
  smooth: Uint8Array;

  constructor(pos: ArrayLike<number>, faces: number[][], materials: (string | null)[] = [], smooth = false) {
    this.pos = Float32Array.from(pos);
    const fs = new Int32Array(faces.length + 1);
    let n = 0;
    for (let i = 0; i < faces.length; i++) { fs[i] = n; n += faces[i].length; }
    fs[faces.length] = n;
    this.faceStart = fs;
    this.corners = new Int32Array(n);
    let k = 0;
    for (const f of faces) for (const v of f) this.corners[k++] = v;
    this.matIndex = new Int32Array(faces.length);
    this.materials = materials.slice();
    this.smooth = new Uint8Array(faces.length).fill(smooth ? 1 : 0);
  }
  get points(): number { return this.pos.length / 3; }
  get faces(): number { return this.faceStart.length - 1; }
  get cornerCount(): number { return this.corners.length; }
  face_(i: number): Int32Array { return this.corners.subarray(this.faceStart[i], this.faceStart[i + 1]); }
  private cornerFaceCache?: Int32Array;
  /** corner → face index (cached: topology doesn't change once a mesh is in use) */
  cornerFaces(): Int32Array {
    if (this.cornerFaceCache?.length === this.corners.length) return this.cornerFaceCache;
    const out = new Int32Array(this.corners.length);
    for (let f = 0; f < this.faces; f++) out.fill(f, this.faceStart[f], this.faceStart[f + 1]);
    return (this.cornerFaceCache = out);
  }

  clone(): Mesh {
    const m = Object.create(Mesh.prototype) as Mesh;
    (m as { uid: number }).uid = nextId++;
    m.source = null;
    m.pos = this.pos.slice();
    m.faceStart = this.faceStart.slice();
    m.corners = this.corners.slice();
    m.matIndex = this.matIndex.slice();
    m.materials = this.materials.slice();
    m.point = cloneAttrs(this.point);
    m.face = cloneAttrs(this.face);
    m.corner = cloneAttrs(this.corner);
    m.smooth = this.smooth.slice();
    return m;
  }

  /** BKE face_area_calc: area_tri_v3 for triangles, Newell's normal (area_poly_v3) otherwise */
  faceArea(i: number): number {
    const f = this.face_(i), P = this.pos;
    const v = (k: number): Vec3 => [P[f[k] * 3], P[f[k] * 3 + 1], P[f[k] * 3 + 2]];
    const len = (n: Vec3) => f32(Math.sqrt(f32(f32(f32(n[0] * n[0]) + f32(n[1] * n[1])) + f32(n[2] * n[2]))));
    if (f.length === 3) {
      const a = v(0), b = v(1), c = v(2);
      const n1: Vec3 = [f32(a[0] - b[0]), f32(a[1] - b[1]), f32(a[2] - b[2])];
      const n2: Vec3 = [f32(b[0] - c[0]), f32(b[1] - c[1]), f32(b[2] - c[2])];
      return f32(len([f32(f32(n1[1] * n2[2]) - f32(n1[2] * n2[1])), f32(f32(n1[2] * n2[0]) - f32(n1[0] * n2[2])),
        f32(f32(n1[0] * n2[1]) - f32(n1[1] * n2[0]))]) * 0.5);
    }
    const n: Vec3 = [0, 0, 0];
    for (let k = 0; k < f.length; k++) {
      const a = v((k + f.length - 1) % f.length), b = v(k);
      n[0] = f32(n[0] + f32(f32(a[1] - b[1]) * f32(a[2] + b[2])));
      n[1] = f32(n[1] + f32(f32(a[2] - b[2]) * f32(a[0] + b[0])));
      n[2] = f32(n[2] + f32(f32(a[0] - b[0]) * f32(a[1] + b[1])));
    }
    return f32(len(n) * 0.5);
  }

  /**
   * BKE normals_calc_faces (the face normal cache fields read), float for
   * float: Newell's method for every face, then normalize_v3 (v · 1/length).
   * The last bits decide ties such as 45° faces in box projections.
   */
  faceNormal(i: number): Vec3 {
    const f = this.face_(i), P = this.pos;
    const n: Vec3 = [0, 0, 0];
    for (let k = 0; k < f.length; k++) {
      const a = f[(k + f.length - 1) % f.length] * 3, b = f[k] * 3;
      n[0] = f32(n[0] + f32(f32(P[a + 1] - P[b + 1]) * f32(P[a + 2] + P[b + 2])));
      n[1] = f32(n[1] + f32(f32(P[a + 2] - P[b + 2]) * f32(P[a] + P[b])));
      n[2] = f32(n[2] + f32(f32(P[a] - P[b]) * f32(P[a + 1] + P[b + 1])));
    }
    const d = f32(f32(f32(n[0] * n[0]) + f32(n[1] * n[1])) + f32(n[2] * n[2]));
    if (!(d > 1e-35)) return [0, 0, 1];
    const inv = f32(1 / f32(Math.sqrt(d)));
    return [f32(n[0] * inv), f32(n[1] * inv), f32(n[2] * inv)];
  }
  faceCenter(i: number): Vec3 {
    const f = this.face_(i);
    let x = 0, y = 0, z = 0;
    for (const v of f) { x += this.pos[v * 3]; y += this.pos[v * 3 + 1]; z += this.pos[v * 3 + 2]; }
    return [f32(x / f.length), f32(y / f.length), f32(z / f.length)];
  }
  /**
   * angle-weighted vertex normals (BKE mesh_normals); smoothOnly leaves flat
   * faces out, like the corner normals of smooth faces next to sharp ones
   */
  vertexNormals(smoothOnly = false): Float32Array {
    const out = new Float32Array(this.pos.length);
    const P = this.pos;
    for (let i = 0; i < this.faces; i++) {
      if (smoothOnly && !this.smooth[i]) continue;
      const f = this.face_(i);
      const n = this.faceNormal(i);
      for (let k = 0; k < f.length; k++) {
        const a = f[(k + f.length - 1) % f.length] * 3, b = f[k] * 3, c = f[(k + 1) % f.length] * 3;
        const e1 = [P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]];
        const e2 = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]];
        const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1, l2 = Math.hypot(e2[0], e2[1], e2[2]) || 1;
        const d = Math.max(-1, Math.min(1, (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (l1 * l2)));
        const w = Math.acos(d);
        out[b] += n[0] * w; out[b + 1] += n[1] * w; out[b + 2] += n[2] * w;
      }
    }
    for (let i = 0; i < out.length; i += 3) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
    }
    return out;
  }
}

export class Points {
  pos: Float32Array;
  point: AttrMap = new Map();
  constructor(pos: ArrayLike<number>) { this.pos = Float32Array.from(pos); }
  get points(): number { return this.pos.length / 3; }
  clone(): Points {
    const p = new Points(this.pos);
    p.point = cloneAttrs(this.point);
    return p;
  }
}

/** poly curves only (all the NYC graphs build) */
export class Curves {
  pos: Float32Array;
  /** spline → first point; splineStart.length = splines + 1 */
  splineStart: Int32Array;
  cyclic: Uint8Array;
  /** "minimum_twist" | "z_up" */
  normalMode: string[];
  point: AttrMap = new Map();
  /**
   * Blender's Fill Curve triangulation of these exact curves (String to Curves
   * glyphs): triangles as point indices, or into pos when the fill added
   * vertices. Not copied by clone(), so any edit falls back to our own fill.
   */
  fill: { tris: ArrayLike<number>; pos?: ArrayLike<number> } | null = null;
  constructor(pos: ArrayLike<number>, splineStart: ArrayLike<number>) {
    this.pos = Float32Array.from(pos);
    this.splineStart = Int32Array.from(splineStart);
    const n = this.splineStart.length - 1;
    this.cyclic = new Uint8Array(n);
    this.normalMode = new Array(n).fill("minimum_twist");
  }
  get points(): number { return this.pos.length / 3; }
  get splines(): number { return this.splineStart.length - 1; }
  clone(): Curves {
    const c = new Curves(this.pos, this.splineStart);
    c.cyclic = this.cyclic.slice();
    c.normalMode = this.normalMode.slice();
    c.point = cloneAttrs(this.point);
    return c;
  }
}

export class Instances {
  refs: Geo[] = [];
  handle: number[] = [];
  mats: Mat4[] = [];
  inst: AttrMap = new Map();
  get count(): number { return this.handle.length; }
  addRef(g: Geo): number { this.refs.push(g); return this.refs.length - 1; }
  clone(): Instances {
    const c = new Instances();
    c.refs = this.refs.slice();
    c.handle = this.handle.slice();
    c.mats = this.mats.map(m => m.slice());
    c.inst = cloneAttrs(this.inst);
    return c;
  }
}

/** Blender's GeometrySet: at most one component of each type */
export class Geo {
  mesh: Mesh | null = null;
  points: Points | null = null;
  curves: Curves | null = null;
  instances: Instances | null = null;
  static empty(): Geo { return new Geo(); }
  static of(c: Mesh | Points | Curves | Instances): Geo {
    const g = new Geo();
    if (c instanceof Mesh) g.mesh = c;
    else if (c instanceof Points) g.points = c;
    else if (c instanceof Curves) g.curves = c;
    else g.instances = c;
    return g;
  }
  shallow(): Geo {
    const g = new Geo();
    g.mesh = this.mesh; g.points = this.points; g.curves = this.curves; g.instances = this.instances;
    return g;
  }
  isEmpty(): boolean {
    return !(this.mesh && this.mesh.points) && !(this.points && this.points.points) &&
      !(this.curves && this.curves.points) && !(this.instances && this.instances.count);
  }
}

export function cloneAttrs(a: AttrMap): AttrMap {
  const m: AttrMap = new Map();
  for (const [k, v] of a) m.set(k, { size: v.size, data: v.data.slice() });
  return m;
}

// ---------------------------------------------------------------- matrices

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** eul_to_quat (float) */
export function eulerToQuat(e: Vec3): Quat {
  const ti = f32(e[0] * 0.5), tj = f32(e[1] * 0.5), th = f32(e[2] * 0.5);
  const ci = f32(Math.cos(ti)), cj = f32(Math.cos(tj)), ch = f32(Math.cos(th));
  const si = f32(Math.sin(ti)), sj = f32(Math.sin(tj)), sh = f32(Math.sin(th));
  const cc = f32(ci * ch), cs = f32(ci * sh), sc = f32(si * ch), ss = f32(si * sh);
  return [
    f32(f32(cj * cc) + f32(sj * ss)),
    f32(f32(cj * sc) - f32(sj * cs)),
    f32(f32(cj * ss) + f32(sj * cc)),
    f32(f32(cj * cs) - f32(sj * sc)),
  ];
}

/** float4x4::from_loc_rot_scale: quat_to_mat3 in double, scaled columns, float result */
export function locRotScale(t: Vec3, q: Quat, s: Vec3): Mat4 {
  const q0 = Math.SQRT2 * q[0], q1 = Math.SQRT2 * q[1], q2 = Math.SQRT2 * q[2], q3 = Math.SQRT2 * q[3];
  const qda = q0 * q1, qdb = q0 * q2, qdc = q0 * q3;
  const qaa = q1 * q1, qab = q1 * q2, qac = q1 * q3;
  const qbb = q2 * q2, qbc = q2 * q3, qcc = q3 * q3;
  const m = new Float32Array(16);
  m[0] = f32(1 - qbb - qcc) * s[0]; m[1] = f32(qdc + qab) * s[0]; m[2] = f32(-qdb + qac) * s[0];
  m[4] = f32(-qdc + qab) * s[1]; m[5] = f32(1 - qaa - qcc) * s[1]; m[6] = f32(qda + qbc) * s[1];
  m[8] = f32(qdb + qac) * s[2]; m[9] = f32(-qda + qbc) * s[2]; m[10] = f32(1 - qaa - qbb) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

/** a · b (column-major), float accumulation in Blender's order */
export function mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = f32(a[row] * b[c * 4]);
      s = f32(s + f32(a[4 + row] * b[c * 4 + 1]));
      s = f32(s + f32(a[8 + row] * b[c * 4 + 2]));
      s = f32(s + f32(a[12 + row] * b[c * 4 + 3]));
      r[c * 4 + row] = s;
    }
  }
  return r;
}

export function xformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    f32(f32(f32(f32(m[0] * x) + f32(m[4] * y)) + f32(m[8] * z)) + m[12]),
    f32(f32(f32(f32(m[1] * x) + f32(m[5] * y)) + f32(m[9] * z)) + m[13]),
    f32(f32(f32(f32(m[2] * x) + f32(m[6] * y)) + f32(m[10] * z)) + m[14]),
  ];
}

export function transformPositions(pos: Float32Array, m: Mat4): void {
  for (let i = 0; i < pos.length; i += 3) {
    const p = xformPoint(m, pos[i], pos[i + 1], pos[i + 2]);
    pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
  }
}

// ---------------------------------------------------------------- primitives

/** Mesh Cube with 2×2×2 vertices (all the NYC graphs use), Blender's vertex / face order */
export function cube(size: Vec3): Mesh {
  const [sx, sy, sz] = [f32(size[0] / 2), f32(size[1] / 2), f32(size[2] / 2)];
  const pos: number[] = [];
  // BKE create_cuboid_mesh for 2×2×2: x-major, then y, then z (−, +)
  for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) pos.push(x, y, z);
  const v = (ix: number, iy: number, iz: number) => ix * 4 + iy * 2 + iz;
  const faces = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)], // bottom (−Z)
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], // top (+Z)
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], // front (−Y)
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)], // right (+X)
    [v(1, 1, 0), v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)], // back (+Y)
    [v(0, 1, 0), v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)], // left (−X)
  ];
  return new Mesh(pos, faces);
}

/** Mesh Cylinder / Cone (1 side segment, 1 fill segment, N-gon caps), centered on the origin */
export function cone(verts: number, rTop: number, rBottom: number, depth: number): Mesh {
  const pos: number[] = [];
  const h = f32(depth / 2);
  const topPt = rTop <= 0, botPt = rBottom <= 0;
  const ring = (r: number, z: number) => {
    for (let i = 0; i < verts; i++) {
      const a = (2 * Math.PI * i) / verts;
      pos.push(f32(r * Math.cos(a)), f32(r * Math.sin(a)), z);
    }
  };
  const faces: number[][] = [];
  let top = 0, bot = 0;
  if (topPt) { top = 0; pos.push(0, 0, h); } else { top = 0; ring(rTop, h); }
  bot = pos.length / 3;
  if (botPt) pos.push(0, 0, -h); else ring(rBottom, -h);
  const t = (i: number) => (topPt ? top : top + (i % verts));
  const b = (i: number) => (botPt ? bot : bot + (i % verts));
  const smoothFlags: boolean[] = [];
  if (!topPt) { faces.push(Array.from({ length: verts }, (_, i) => t(i))); smoothFlags.push(false); }
  for (let i = 0; i < verts; i++) {
    const f = [t(i), b(i), b(i + 1), t(i + 1)].filter((x, k, arr) => arr.indexOf(x) === k);
    faces.push(f); smoothFlags.push(true);
  }
  if (!botPt) { faces.push(Array.from({ length: verts }, (_, i) => b(verts - 1 - i))); smoothFlags.push(false); }
  const m = new Mesh(pos, faces);
  smoothFlags.forEach((s, i) => (m.smooth[i] = s ? 1 : 0));
  return m;
}

export function uvSphere(segments: number, rings: number, r: number): Mesh {
  const pos: number[] = [0, 0, r];
  for (let j = 1; j < rings; j++) {
    const phi = (Math.PI * j) / rings;
    for (let i = 0; i < segments; i++) {
      const th = (2 * Math.PI * i) / segments;
      pos.push(f32(r * Math.sin(phi) * Math.cos(th)), f32(r * Math.sin(phi) * Math.sin(th)), f32(r * Math.cos(phi)));
    }
  }
  pos.push(0, 0, -r);
  const bottom = pos.length / 3 - 1;
  const ringV = (j: number, i: number) => 1 + (j - 1) * segments + (i % segments);
  const faces: number[][] = [];
  for (let i = 0; i < segments; i++) faces.push([0, ringV(1, i), ringV(1, i + 1)]);
  for (let j = 1; j < rings - 1; j++)
    for (let i = 0; i < segments; i++) faces.push([ringV(j, i), ringV(j + 1, i), ringV(j + 1, i + 1), ringV(j, i + 1)]);
  for (let i = 0; i < segments; i++) faces.push([bottom, ringV(rings - 1, i + 1), ringV(rings - 1, i)]);
  return new Mesh(pos, faces, [], true);
}

/** Mesh Grid (BKE create_grid_mesh): x-major vertices, quads [v, v + vy, v + vy + 1, v + 1] */
export function grid(sizeX: number, sizeY: number, vertsX: number, vertsY: number): Mesh {
  const ex = vertsX - 1, ey = vertsY - 1;
  const dx = ex === 0 ? 0 : f32(sizeX / ex), dy = ey === 0 ? 0 : f32(sizeY / ey);
  const sx = f32(ex / 2), sy = f32(ey / 2);
  const pos: number[] = [];
  for (let x = 0; x < vertsX; x++) for (let y = 0; y < vertsY; y++) pos.push(f32(f32(x - sx) * dx), f32(f32(y - sy) * dy), 0);
  const faces: number[][] = [];
  for (let x = 0; x < ex; x++) for (let y = 0; y < ey; y++) {
    const v = x * vertsY + y;
    faces.push([v, v + vertsY, v + vertsY + 1, v + 1]);
  }
  return new Mesh(pos, faces);
}
