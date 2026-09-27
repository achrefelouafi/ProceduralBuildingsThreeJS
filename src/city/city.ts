/**
 * The procedural city around the hero building: a white massing model — roads
 * (on the stage floor), sidewalk slabs and plain white volumes (see layout.ts
 * for the plan and glsl.ts for the shading). The whole city is ONE
 * InstancedMesh of unit boxes (~2–3k instances, 12 triangles each) with one
 * material.
 *
 * Near the building the city casts into the key light's shadow map and takes
 * GTAO; further out a 1024² heightmap carries its shadows (a short march
 * towards the key).
 *
 * Buildings between the camera and the hero sink into the ground, eased, on
 * the CPU (the instance matrices), so the shadow map, GTAO and the snow caps
 * all follow; the heightmap under them is redrawn the same frame.
 */
import {
  Box2, BoxGeometry, ClampToEdgeWrapping, Color, DataTexture, Group, InstancedBufferAttribute, InstancedMesh,
  LinearFilter, Matrix4, MeshStandardMaterial, RedFormat, UnsignedByteType, Vector2, Vector3,
  type Camera, type Material, type WebGLProgramParametersWithUniforms, type WebGLRenderer,
} from "three";
import { CITY_R, layoutCity, S, type CityLayout, type FadeBox, type Flavor, type Piece } from "./layout";
import { MAX_ROADS, patchKit, patchPavement, patchRoad } from "./glsl";

export type { Flavor } from "./layout";

const MAP_N = 1024;
const MAP_EXTENT = 420;

export interface CityInput {
  width: number;
  length: number;
  /** the building's height: its neighbours stay around it, the skyline grows beyond */
  height: number;
  margin: number;
  /** paved forecourt past the sidewalk (0: the streets start at the curb) */
  site: number;
  flavor: Flavor;
}

const tmpM = new Matrix4();
const tmpC = new Color();
const tmpRect = new Box2();
const tmpAt = new Vector2();

/** the buildings of a city build, for the view-clearing sink */
interface Sink {
  /** per building: x, z, hx, hz, top */
  boxes: Float32Array;
  /** per building: metres sunk (eased) */
  shown: Float32Array;
  changed: Uint8Array;
  /** per instance: its building (−1: never sinks) and its base height */
  group: Int32Array;
  baseY: Float32Array;
  /** per building: its footprint in heightmap texels (i0, i1, j0, j1) */
  rects: Int32Array;
}

/** one laid-out city: its mesh, snow caps and heightmap (kept for instant swaps) */
interface CityBuild {
  key: string;
  layout: CityLayout;
  pieces: Piece[];
  mapData: Uint8Array;
  flavor: Flavor;
  mesh: InstancedMesh;
  shell: InstancedMesh | null;
  map: DataTexture;
  /**
   * the same texels as a never-rendered texture: the source for sub-rect
   * uploads into `map` (three copies a DataTexture it hasn't seen from the CPU)
   */
  mapSrc: DataTexture;
  maxH: number;
  roadsX: Vector3[];
  roadsZ: Vector3[];
  sink: Sink;
}

/** builds kept around: the three flavours + one more footprint */
const CACHE_SIZE = 4;

const smooth = (t: number) => t * t * (3 - 2 * t);

export class City {
  /** everything the city draws (hidden in the studio-stage environment) */
  readonly group = new Group();
  /** snow caps on the city (parented under the studio's snow group) */
  readonly snowShell = new Group();
  /** surfaces rain soaks */
  readonly wetTargets: Material[] = [];
  readonly material: MeshStandardMaterial;
  seed = 11;
  /** whatever stands between the camera and the hero gets out of the way */
  fadeOn = true;
  private input: CityInput | null = null;
  private current: CityBuild | null = null;
  /** least recently used first */
  private cache: CityBuild[] = [];
  private camPos = new Vector3();
  /** heightmap texels waiting to be redrawn (i0, i1, j0, j1) */
  private pending = [MAP_N, -1, MAP_N, -1];
  private focus = new Vector3();

  readonly uniforms = {
    uCityMap: { value: null as DataTexture | null },
    uCityExtent: { value: MAP_EXTENT },
    uCityMaxH: { value: 80 },
    uCityOn: { value: 1 },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uFocusR: { value: 12 },
    uCityKey: { value: 1 },
    /** radius around the building inside which the key's shadow map holds the city's shadows */
    uShadowReach: { value: 0 },
    uRoadsX: { value: Array.from({ length: MAX_ROADS }, () => new Vector3()) },
    uRoadsZ: { value: Array.from({ length: MAX_ROADS }, () => new Vector3()) },
    uNumRoadsX: { value: 0 },
    uNumRoadsZ: { value: 0 },
    uCenterDashed: { value: 1 },
    /** half extents of the hero's site (the plinth's curb runs along its edge) */
    uSiteHalf: { value: new Vector2() },
  };

  private box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private shellMaterial: Material | null = null;

  constructor(private renderer: WebGLRenderer) {
    this.group.name = "city";
    this.snowShell.name = "citySnowShell";
    this.material = new MeshStandardMaterial({ name: "city massing", color: 0xffffff, roughness: 0.92 });
    this.material.onBeforeCompile = shader => patchKit(shader, this.uniforms);
    this.material.customProgramCacheKey = () => "city-massing-v1";
    this.wetTargets.push(this.material);
  }

  /** identifies the city on the stage (layout inputs + seed) */
  get key(): string {
    return this.current?.key ?? "";
  }

  /** the current layout (roads, blocks, pieces) */
  get layout(): CityLayout | null {
    return this.current?.layout ?? null;
  }

  /** snow caps: a second pass on the city's boxes with the shared snow-shell material */
  setSnowShell(snowShellMaterial: Material): void {
    this.shellMaterial = snowShellMaterial;
    this.flush();
  }

  /** the stage floor's shader hook (roads) */
  patchRoad(shader: WebGLProgramParametersWithUniforms): void {
    patchRoad(shader, this.uniforms);
  }

  /** the hero plinth's shader hook (site paving) */
  patchPavement(shader: WebGLProgramParametersWithUniforms): void {
    patchPavement(shader, this.uniforms);
  }

  /**
   * lay the city out around a hero of this size; returns whether it changed.
   * Builds are cached: going back to a building type or a size seen recently
   * is a swap, not a rebuild.
   */
  update(input: CityInput): boolean {
    this.input = input;
    const key = [input.width, input.length, input.height, input.margin, input.site].map(v => v.toFixed(2)).join() + `|${input.flavor}|${this.seed}`;
    if (this.current?.key === key) return false;
    let b = this.cache.find(c => c.key === key);
    if (b) this.cache.splice(this.cache.indexOf(b), 1);
    else b = this.build(input, key);
    this.cache.push(b);
    this.use(b);
    while (this.cache.length > CACHE_SIZE) this.disposeBuild(this.cache.shift()!);
    return true;
  }

  /** a new random city (same footprint) */
  reseed(seed: number): void {
    this.seed = seed;
    if (this.input) this.update(this.input);
  }

  /** per frame: buildings in the way sink out of it */
  tick(dt: number, camera: Camera, focus: Vector3, focusR: number): void {
    camera.getWorldPosition(this.camPos);
    this.focus.copy(focus);
    this.uniforms.uFocusR.value = focusR;
    if (!this.current) return;
    this.sink(this.current, dt);
    // in step with the boxes: a roof under a stale (taller) column shades itself
    if (this.pending[1] >= 0) this.redrawMap(this.current);
  }

  /**
   * The view cone runs from the camera to just in front of the hero (its
   * radius grows from 1.5 m to 0.8 × the hero's): a building it touches sinks
   * into the ground, whole and eased, and rises again once the camera moves on.
   */
  private sink(b: CityBuild, dt: number): void {
    const st = b.sink;
    const C = this.camPos, F = this.focus, R = this.uniforms.uFocusR.value;
    const dx = F.x - C.x, dy = F.y - C.y, dz = F.z - C.z;
    const L = Math.hypot(dx, dy, dz) || 1e-3;
    const len = Math.max(L - R * 0.55, 0);
    const ux = dx / L, uy = dy / L, uz = dz / L;
    // the cone's ground track, for a quick reject
    const hxz = Math.hypot(ux, uz), track = len * hxz;
    const gx = hxz > 1e-6 ? ux / hxz : 0, gz = hxz > 1e-6 ? uz / hxz : 0;
    const ease = Math.min(1, dt * 5);
    let any = false;
    for (let g = 0; g < st.shown.length; g++) {
      const o = g * 5;
      const bx = st.boxes[o], bz = st.boxes[o + 1], hx = st.boxes[o + 2], hz = st.boxes[o + 3], top = st.boxes[o + 4];
      let target = 0;
      if (this.fadeOn) {
        const t = Math.min(Math.max((bx - C.x) * gx + (bz - C.z) * gz, 0), track);
        if (Math.hypot(C.x + gx * t - bx, C.z + gz * t - bz) - Math.max(hx, hz) * 1.42 < R * 0.8 + 8) {
          let m = Infinity;
          for (let k = 0; k <= 10; k++) {
            const s = (k / 10) * len;
            const qx = C.x + ux * s, qy = C.y + uy * s, qz = C.z + uz * s;
            const ex = Math.max(Math.abs(qx - bx) - hx, 0), ey = Math.max(Math.abs(qy - top / 2) - top / 2, 0), ez = Math.max(Math.abs(qz - bz) - hz, 0);
            m = Math.min(m, Math.hypot(ex, ey, ez) - (1.5 + (R * 0.8 - 1.5) * (k / 10)));
          }
          target = (1 - smooth(Math.min(Math.max(m / 6, 0), 1))) * (top + 0.5);
        }
      }
      const cur = st.shown[g];
      let next = cur + (target - cur) * ease;
      if (Math.abs(next - target) < 0.01) next = target;
      st.changed[g] = next !== cur ? 1 : 0;
      if (next !== cur) {
        st.shown[g] = next;
        any = true;
      }
    }
    if (!any) return;
    for (let g = 0; g < st.shown.length; g++) {
      if (!st.changed[g]) continue;
      const r = g * 4, q = this.pending;
      q[0] = Math.min(q[0], st.rects[r]); q[1] = Math.max(q[1], st.rects[r + 1]);
      q[2] = Math.min(q[2], st.rects[r + 2]); q[3] = Math.max(q[3], st.rects[r + 3]);
    }
    const a = b.mesh.instanceMatrix.array as Float32Array;
    let lo = -1, hi = -1;
    for (let i = 0; i < st.group.length; i++) {
      const g = st.group[i];
      if (g < 0 || !st.changed[g]) continue;
      a[i * 16 + 13] = st.baseY[i] - st.shown[g];
      if (lo < 0) lo = i;
      hi = i;
    }
    if (lo < 0) return;
    b.mesh.instanceMatrix.clearUpdateRanges();
    b.mesh.instanceMatrix.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
    b.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * a sunk building must not shade the city through the heightmap: redraw the
   * texels under the buildings that moved, with every piece there at its
   * current height, and upload just those
   */
  private redrawMap(b: CityBuild): void {
    const st = b.sink;
    const [i0, i1, j0, j1] = this.pending;
    this.pending = [MAP_N, -1, MAP_N, -1];
    if (i1 < 0) return;
    const d = b.mapData;
    for (let j = j0; j <= j1; j++) d.fill(0, j * MAP_N + i0, j * MAP_N + i1 + 1);
    rasterize(b.pieces, d, [i0, i1, j0, j1], i => {
      const g = st.group[i];
      return g < 0 ? 0 : st.shown[g];
    });
    tmpRect.min.set(i0, j0);
    tmpRect.max.set(i1 + 1, j1 + 1);
    this.renderer.copyTextureToTexture(b.mapSrc, b.map, tmpRect, tmpAt.set(i0, j0));
  }

  /** drop every cached build (a material changed) and rebuild the current one */
  private flush(): void {
    for (const b of this.cache) this.disposeBuild(b);
    this.cache = [];
    this.current = null;
    if (this.input) this.update(this.input);
  }

  private use(b: CityBuild): void {
    if (this.current) {
      this.group.remove(this.current.mesh);
      if (this.current.shell) this.snowShell.remove(this.current.shell);
    }
    this.current = b;
    this.pending = [MAP_N, -1, MAP_N, -1];
    this.group.add(b.mesh);
    if (b.shell) this.snowShell.add(b.shell);
    const u = this.uniforms;
    u.uCityMap.value = b.map;
    u.uCityMaxH.value = b.maxH;
    u.uNumRoadsX.value = b.roadsX.length;
    u.uNumRoadsZ.value = b.roadsZ.length;
    b.roadsX.forEach((r, i) => u.uRoadsX.value[i].copy(r));
    b.roadsZ.forEach((r, i) => u.uRoadsZ.value[i].copy(r));
    u.uCenterDashed.value = b.flavor === "paris" ? 1 : 0;
  }

  private build(inp: CityInput, key: string): CityBuild {
    const t0 = performance.now();
    const L = layoutCity({ ...inp, seed: this.seed });
    const roads = (list: CityLayout["roadsX"]) => {
      if (list.length > MAX_ROADS) console.warn(`city: ${list.length} roads, shading the nearest ${MAX_ROADS}`);
      // the nearest roads to the hero first, so a truncation drops the far ones
      return [...list].sort((a, b) => Math.abs(a.c) - Math.abs(b.c)).slice(0, MAX_ROADS).map(r => new Vector3(r.c, r.hw, r.mh));
    };
    const { mesh, shell, sink } = this.buildMesh(L.pieces);
    const { map, mapSrc, mapData, maxH } = this.buildMap(L.pieces);
    console.info(`city: ${L.pieces.length} boxes — ${(performance.now() - t0).toFixed(0)} ms`);
    return { key, layout: L, pieces: L.pieces, mapData, flavor: inp.flavor, mesh, shell, map, mapSrc, maxH, roadsX: roads(L.roadsX), roadsZ: roads(L.roadsZ), sink };
  }

  private disposeBuild(b: CityBuild): void {
    if (this.current === b) {
      this.group.remove(b.mesh);
      if (b.shell) this.snowShell.remove(b.shell);
      this.current = null;
    }
    b.mesh.geometry.dispose(); // its per-instance clone (the shell shares it)
    b.mesh.dispose();
    b.map.dispose();
  }

  private buildMesh(pieces: Piece[]): { mesh: InstancedMesh; shell: InstancedMesh | null; sink: Sink } {
    const g = this.box.clone();
    const mesh = new InstancedMesh(g, this.material, pieces.length);
    mesh.name = "city";
    mesh.castShadow = mesh.receiveShadow = true;
    const attr = new Float32Array(pieces.length * 4);
    const group = new Int32Array(pieces.length), baseY = new Float32Array(pieces.length);
    // the buildings that sink as one: towers share a box, everything else is its own
    const boxes: number[] = [];
    const index = new Map<FadeBox, number>();
    pieces.forEach((p, i) => {
      tmpM.makeScale(p.sx, p.sy, p.sz).setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, tmpM);
      tmpC.setHex(p.color).convertSRGBToLinear();
      attr.set([tmpC.r, tmpC.g, tmpC.b, p.style], i * 4);
      baseY[i] = p.y;
      if (p.fade === null) {
        group[i] = -1;
        return;
      }
      const f = p.fade ?? { x: p.x, z: p.z, hx: p.sx / 2, hz: p.sz / 2, top: p.y + p.sy };
      let k = index.get(f);
      if (k === undefined) {
        k = boxes.length / 5;
        index.set(f, k);
        boxes.push(f.x, f.z, f.hx, f.hz, f.top);
      }
      group[i] = k;
    });
    g.setAttribute("aCity", new InstancedBufferAttribute(attr, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    let shell: InstancedMesh | null = null;
    if (this.shellMaterial) {
      shell = new InstancedMesh(g, this.shellMaterial, pieces.length);
      shell.instanceMatrix = mesh.instanceMatrix; // sinks with it
      shell.boundingSphere = mesh.boundingSphere;
      shell.receiveShadow = true;
    }
    const n = boxes.length / 5;
    const rects = new Int32Array(n * 4);
    for (let k = 0; k < n; k++) {
      const [x, z, hx, hz] = boxes.slice(k * 5, k * 5 + 4);
      rects.set([Math.max(0, Math.floor(texel(x - hx))), Math.min(MAP_N - 1, Math.ceil(texel(x + hx))), Math.max(0, Math.floor(texel(z - hz))), Math.min(MAP_N - 1, Math.ceil(texel(z + hz)))], k * 4);
    }
    return { mesh, shell, sink: { boxes: new Float32Array(boxes), shown: new Float32Array(n), changed: new Uint8Array(n), group, baseY, rects } };
  }

  /** building heights (R8, metres) for the heightmap shadows */
  private buildMap(pieces: Piece[]): { map: DataTexture; mapSrc: DataTexture; mapData: Uint8Array; maxH: number } {
    const d = new Uint8Array(MAP_N * MAP_N);
    const maxH = rasterize(pieces, d, [0, MAP_N - 1, 0, MAP_N - 1], () => 0);
    const map = new DataTexture(d, MAP_N, MAP_N, RedFormat, UnsignedByteType);
    map.wrapS = map.wrapT = ClampToEdgeWrapping;
    map.magFilter = map.minFilter = LinearFilter;
    map.generateMipmaps = false;
    map.needsUpdate = true;
    const mapSrc = new DataTexture(d, MAP_N, MAP_N, RedFormat, UnsignedByteType);
    return { map, mapSrc, mapData: d, maxH: maxH + 1 };
  }
}

/** heightmap texel coordinate of a world x / z */
const texel = (a: number) => (a + MAP_EXTENT) * (MAP_N / (2 * MAP_EXTENT)) - 0.5;

/**
 * draw the pieces' tops (minus how far each has sunk) into the heightmap,
 * within a texel rect; returns the tallest top
 */
function rasterize(pieces: Piece[], d: Uint8Array, [ri0, ri1, rj0, rj1]: number[], sunk: (i: number) => number): number {
  let maxH = 0;
  pieces.forEach((p, n) => {
    if (p.style === S.SLAB || Math.hypot(p.x, p.z) > CITY_R + 40) return;
    const top = Math.min(255, Math.max(0, p.y + p.sy - sunk(n)));
    maxH = Math.max(maxH, top);
    const i0 = Math.max(ri0, Math.round(texel(p.x - p.sx / 2))), i1 = Math.min(ri1, Math.round(texel(p.x + p.sx / 2)));
    const j0 = Math.max(rj0, Math.round(texel(p.z - p.sz / 2))), j1 = Math.min(rj1, Math.round(texel(p.z + p.sz / 2)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * MAP_N + i;
        if (d[k] < top) d[k] = top;
      }
    }
  });
  return maxH;
}
