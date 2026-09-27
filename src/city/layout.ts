/**
 * Procedural city around the hero building — the layout, as plain data.
 *
 * A white massing model: roads, sidewalk slabs and plain white volumes, one per
 * lot (towers: a podium and a setback or two). No greenery, no street furniture.
 *
 * The hero stands on the centre block: its footprint, its sidewalk, and a paved
 * forecourt around that (SITE m; none when the building brings its own
 * sidewalk — the streets start at its curb). A street grid wraps it: the first roads hug
 * the hero block, and every block beyond has a size drawn from a per-index
 * hash, so when the hero grows the whole city slides outward and keeps its
 * buildings (only the blocks in the hero's row / column stretch and
 * re-subdivide). The first ring stays below the building's height; a skyline
 * rises beyond.
 *
 * Everything is deterministic from (seed, block index). World space, Y up,
 * hero centred at the origin, front facade towards +Z.
 */

export type Flavor = "paris" | "nyc" | "asia";

/** piece kinds, read by the city shader (glsl.ts) */
export const S = { MASS: 0, SLAB: 1 } as const;

/** the pieces of one building sink together when they block the view */
export interface FadeBox { x: number; z: number; hx: number; hz: number; top: number }

/** one instanced box: base centre (x, y, z), size, kind, colour */
export interface Piece {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  style: number;
  color: number; // sRGB 0xRRGGBB
  /** the building it belongs to (default: its own box); null: never sinks */
  fade?: FadeBox | null;
}

/** a road centreline: centre, half width, median half width */
export interface Road { c: number; hw: number; mh: number }
export type BlockKind = "buildings" | "lowrise" | "open";
export interface Block { i: number; j: number; x0: number; x1: number; z0: number; z1: number; kind: BlockKind }

export interface CityLayout {
  roadsX: Road[]; // roads running along Z (constant x)
  roadsZ: Road[]; // roads running along X (constant z)
  blocks: Block[];
  pieces: Piece[];
  /** hero block half extents (forecourt included) */
  hx: number;
  hz: number;
}

export interface LayoutInput {
  width: number; // hero footprint along X
  length: number; // along Z
  height: number; // hero height (the first rings stay below / around it)
  margin: number; // sidewalk reach around the footprint
  site: number; // forecourt past the sidewalk
  flavor: Flavor;
  seed: number;
}

export const CITY_R = 400; // city disc radius (the stage floor is 420)
export const CURB = 0.15; // sidewalk / slab height (= studio SIDEWALK)
/** the paved forecourt between the hero's sidewalk and its streets */
export const SITE = 5;
export const WALK = 3.6; // block sidewalk width
export const STREET_HW = 6; // 12 m streets
export const AVENUE_HW = 8.5; // 17 m avenues (2 m median)
const BLOCK_SIZES: [number[], number[]] = [[58, 66, 74, 82, 62], [46, 52, 60, 56, 50]];

// --- deterministic randomness ---------------------------------------------------

function hash(...n: number[]): number {
  let h = 0x811c9dc5;
  for (const v of n) {
    h ^= Math.imul((v * 1000) | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r01 = (...n: number[]) => hash(...n) / 4294967296;
const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];

// --- flavours: the massing only (heights, lot widths, towers) -----------------------

interface FlavorSpec {
  floors: (rnd: () => number, dt: number) => number;
  towerChance: (dt: number) => number;
  towerFloors: (rnd: () => number, dt: number) => number;
  frontage: [number, number];
  /** the clay: a whisper of warm / neutral / cool */
  clay: number[];
  /** downtown centre (world XZ, behind the hero from the ¾ shot) */
  downtown: [number, number];
}

const FLAVORS: Record<Flavor, FlavorSpec> = {
  paris: {
    floors: rnd => 6 + Math.floor(rnd() * 3),
    towerChance: dt => (dt > 0.45 ? 0.75 : 0),
    towerFloors: (rnd, dt) => 22 + Math.floor(rnd() * (10 + dt * 30)),
    frontage: [11, 20],
    clay: [0xe8e8e6, 0xe3e3e1, 0xeceae8, 0xe0e0de, 0xe6e5e3],
    downtown: [-210, -300],
  },
  nyc: {
    floors: (rnd, dt) => 4 + Math.floor(rnd() * (5 + dt * 10)),
    towerChance: dt => 0.03 + dt * 0.75,
    towerFloors: (rnd, dt) => 20 + Math.floor(rnd() * (14 + dt * 42)),
    frontage: [8, 19],
    clay: [0xe8e8e7, 0xe3e3e2, 0xecebea, 0xe0e0df, 0xe6e6e4],
    downtown: [-150, -215],
  },
  asia: {
    floors: (rnd, dt) => 6 + Math.floor(rnd() * (7 + dt * 10)),
    towerChance: dt => 0.08 + dt * 0.6,
    towerFloors: (rnd, dt) => 24 + Math.floor(rnd() * (12 + dt * 36)),
    frontage: [12, 24],
    clay: [0xe7e8e9, 0xe2e3e4, 0xebeced, 0xdfe0e1, 0xe5e6e7],
    downtown: [-160, -220],
  },
};

const FLOOR_H = 3.3;
const SLAB = 0xdcdcda;

// --- grid ------------------------------------------------------------------

interface Cell { i: number; a0: number; a1: number }

/** roads + block spans along one axis, outward from the hero block (cell 0) */
function axisGrid(half: number, ax: 0 | 1, seed: number): { roads: Road[]; cells: Cell[] } {
  const roads: Road[] = [];
  const cells: Cell[] = [{ i: 0, a0: -half, a1: half }];
  for (const s of [1, -1] as const) {
    let edge = half;
    for (let k = 1; edge < CITY_R; k++) {
      const avenue = k > 1 && r01(seed, ax, s * k, 1) < 0.24; // the hero ring are plain streets
      const hw = avenue ? AVENUE_HW : STREET_HW;
      const c = edge + hw;
      roads.push({ c: s * c, hw, mh: avenue ? 1 : 0 });
      const sizes = BLOCK_SIZES[ax];
      const size = sizes[Math.floor(r01(seed, ax, s * k, 2) * sizes.length) % sizes.length];
      const a0 = c + hw, a1 = a0 + size;
      if (a0 < CITY_R) cells.push({ i: s * k, a0: s > 0 ? a0 : -a1, a1: s > 0 ? a1 : -a0 });
      edge = a1;
    }
  }
  roads.sort((a, b) => a.c - b.c);
  cells.sort((a, b) => a.a0 - b.a0);
  return { roads, cells };
}

// --- generation ------------------------------------------------------------------

class Builder {
  readonly pieces: Piece[] = [];
  readonly spec: FlavorSpec;

  constructor(readonly flavor: Flavor) {
    this.spec = FLAVORS[flavor];
  }

  /** 0..1 — how "downtown" a point is */
  downtown(x: number, z: number): number {
    const [dx, dz] = this.spec.downtown;
    return Math.exp(-((x - dx) ** 2 + (z - dz) ** 2) / (2 * 130 * 130));
  }

  /** a plain volume on a lot, its top under the cap */
  midrise(x0: number, x1: number, z0: number, z1: number, floors: number, rnd: () => number, capH = Infinity): void {
    floors += Math.round((rnd() - 0.5) * 3);
    floors = Math.max(2, Math.min(floors, Math.floor((capH - 1.5) / FLOOR_H) - Math.floor(rnd() * 2.5)));
    const top = floors * FLOOR_H + 1.2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    this.pieces.push({ x: cx, y: CURB, z: cz, sx: w, sy: top, sz: d, style: S.MASS, color: pick(rnd, this.spec.clay) });
  }

  /** a podium and a shaft with a setback or two, sinking as one */
  tower(x0: number, x1: number, z0: number, z1: number, dt: number, rnd: () => number): void {
    const floors = this.spec.towerFloors(rnd, dt);
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const color = pick(rnd, this.spec.clay);
    const fade: FadeBox = { x: cx, z: cz, hx: w / 2, hz: d / 2, top: 0 };
    const pf = 3 + Math.floor(rnd() * 3);
    const ph = pf * 3.8 + 1;
    this.pieces.push({ x: cx, y: CURB, z: cz, sx: w, sy: ph, sz: d, style: S.MASS, color, fade });
    let tw = w * (0.62 + rnd() * 0.2), td = d * (0.62 + rnd() * 0.2);
    let y = CURB + ph;
    let remaining = floors - pf;
    const tiers = rnd() < 0.4 ? 2 : 1;
    for (let t = 0; t < tiers && remaining > 0; t++) {
      const f = t === tiers - 1 ? remaining : Math.max(3, Math.round(remaining * 0.65));
      const h = f * 3.8 + 1.2;
      this.pieces.push({ x: cx, y, z: cz, sx: tw, sy: h, sz: td, style: S.MASS, color, fade });
      y += h;
      remaining -= f;
      tw *= 0.76;
      td *= 0.76;
    }
    fade.top = y;
  }
}

export function layoutCity(inp: LayoutInput): CityLayout {
  const ix = inp.width / 2 + inp.margin, iz = inp.length / 2 + inp.margin;
  const hx = ix + inp.site, hz = iz + inp.site;
  const gx = axisGrid(hx, 0, inp.seed);
  const gz = axisGrid(hz, 1, inp.seed + 17);
  const b = new Builder(inp.flavor);
  const blocks: Block[] = [];

  for (const cx of gx.cells) {
    for (const cz of gz.cells) {
      if (cx.i === 0 && cz.i === 0) continue; // the hero block
      const mx = (cx.a0 + cx.a1) / 2, mz = (cz.a0 + cz.a1) / 2;
      // keep blocks that reach into the city disc
      const nx = Math.max(Math.abs(mx) - (cx.a1 - cx.a0) / 2, 0), nz = Math.max(Math.abs(mz) - (cz.a1 - cz.a0) / 2, 0);
      if (Math.hypot(nx, nz) > CITY_R - 8) continue;
      // low-rise in front of the hero and on its right: the hero shots look over them
      const kind: BlockKind = (cx.i === 0 && cz.i === 1) || (cx.i === 1 && cz.i === 0) ? "lowrise" : "buildings";
      blocks.push({ i: cx.i, j: cz.i, x0: cx.a0, x1: cx.a1, z0: cz.a0, z1: cz.a1, kind });
    }
  }

  for (const blk of blocks) {
    // every block stands on its sidewalk slab
    b.pieces.push({
      x: (blk.x0 + blk.x1) / 2, y: 0, z: (blk.z0 + blk.z1) / 2, sx: blk.x1 - blk.x0, sy: CURB, sz: blk.z1 - blk.z0,
      style: S.SLAB, color: SLAB, fade: null,
    });
    if (blk.kind !== "open") fillBlock(blk, b, inp.seed, inp.height);
  }
  return { roadsX: gx.roads, roadsZ: gz.roads, blocks, pieces: b.pieces, hx, hz };
}

function fillBlock(blk: Block, b: Builder, seed: number, heroH: number): void {
  const rnd = mulberry(hash(seed, blk.i, blk.j, 7));
  const x0 = blk.x0 + WALK, x1 = blk.x1 - WALK, z0 = blk.z0 + WALK, z1 = blk.z1 - WALK;
  const W = x1 - x0, D = z1 - z0;
  if (W < 8 || D < 8) return;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const inDisc = (x: number, z: number) => Math.hypot(x, z) < CITY_R - 4;
  const dt = b.downtown(cx, cz);
  const ring = Math.max(Math.abs(blk.i), Math.abs(blk.j));
  const sp = b.spec;
  // the first rings frame the building instead of towering over it
  const capH = ring === 1 ? Math.max(heroH * 0.95, 9) : ring === 2 ? Math.max(heroH * 1.35, 14) : Infinity;

  if (ring >= 3 && rnd() < sp.towerChance(dt) && inDisc(cx, cz)) {
    const alongX = W >= D;
    const L = alongX ? W : D;
    const n = L > 64 ? 2 : 1;
    const gap = 6;
    const lot = (L - gap * (n - 1)) / n;
    for (let k = 0; k < n; k++) {
      const a0 = k * (lot + gap), a1 = a0 + lot;
      if (alongX) b.tower(x0 + a0, x0 + a1, z0, z1, dt, rnd);
      else b.tower(x0, x1, z0 + a0, z0 + a1, dt, rnd);
    }
    return;
  }

  // rows of lots along the long side, flush with the street
  const alongX = W >= D;
  const L = alongX ? W : D, Sd = alongX ? D : W;
  const rows: [number, number][] = [];
  if (Sd > 30) {
    const d1 = Math.min(Sd / 2, 13 + rnd() * 9), d2 = Math.min(Sd / 2, 13 + rnd() * 9);
    rows.push([0, d1], [Sd - d2, Sd]);
  } else rows.push([0, Sd]);
  const [fMin, fMax] = sp.frontage;
  const low = blk.kind === "lowrise";
  for (const [s0, s1] of rows) {
    let a = 0;
    while (a < L - 3) {
      let fr = fMin + rnd() * (fMax - fMin);
      if (L - (a + fr) < fMin) fr = L - a;
      const lx0 = alongX ? x0 + a : x0 + s0, lx1 = alongX ? x0 + a + fr : x0 + s1;
      const lz0 = alongX ? z0 + s0 : z0 + a, lz1 = alongX ? z0 + s1 : z0 + a + fr;
      a += fr;
      if (!inDisc((lx0 + lx1) / 2, (lz0 + lz1) / 2)) continue;
      let floors = low ? 2 + Math.floor(rnd() * 2) : sp.floors(rnd, dt);
      if (ring === 1 && !low) floors = Math.min(floors, 4 + Math.floor(rnd() * 3));
      b.midrise(lx0, lx1, lz0, lz1, floors, rnd, capH);
    }
  }
}
