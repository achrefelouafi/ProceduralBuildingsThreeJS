/**
 * Compare the TypeScript generator with Blender's evaluated geometry
 * (tools/dump_truth.py output): building instances (module + exact float32
 * position + rotation), roof cap, room mesh (positions + shader attributes)
 * and curtain mesh.
 *
 *   npm run verify          (reads tools/truth.json)
 */
import { readFileSync } from "node:fs";
import { generateBuilding } from "../src/generator";
import { generateCurtains, generateRooms } from "../src/interiors";
import { defaultParams, type BuildingParams } from "../src/params";

interface TruthConfig {
  baysX: number; baysY: number; floors: number; dormers: boolean;
  balcony: BuildingParams["balcony"]; pattern: BuildingParams["detailPattern"];
  style: BuildingParams["detailStyle"]; detailSeed: number; detailDepth: number;
  roomSeed: number; curtainSeed: number;
}
interface Truth {
  config: TruthConfig;
  instances: { name: string; m: number[] }[];
  cap: number[][];
  rooms: Record<"position" | "room_local" | "room_p1" | "room_p2" | "room_p3", number[][]> | null;
  curtains: number[][];
}

const truths: Truth[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

/** multiset comparison of keyed items */
function compareBags(label: string, a: string[], b: string[]): void {
  const bag = new Map<string, number>();
  for (const k of a) bag.set(k, (bag.get(k) ?? 0) + 1);
  for (const k of b) bag.set(k, (bag.get(k) ?? 0) - 1);
  const off = [...bag].filter(([, n]) => n !== 0);
  check(label, off.length === 0, off.length ? `${off.length} differ, e.g. ${off.slice(0, 3).map(([k, n]) => `${k} (${n > 0 ? "blender" : "port"} +${Math.abs(n)})`).join("; ")}` : `(${a.length})`);
}

const q = (v: number, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

/**
 * multiset comparison of float tuples within `tol` (per component) — a
 * spatial hash on the first three components, greedy one-to-one matching
 */
function compareClouds(label: string, blender: number[][], port: number[][], tol = 2e-4): void {
  const cell = (v: number[]) => v.slice(0, 3).map(x => Math.floor(x / (tol * 4)));
  const grid = new Map<string, number[][]>();
  for (const v of port) {
    const k = cell(v).join(",");
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(v);
  }
  let unmatched = 0;
  const examples: string[] = [];
  outer: for (const v of blender) {
    const [cx, cy, cz] = cell(v);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      const i = list?.findIndex(w => w.every((x, j) => Math.abs(x - v[j]) <= tol)) ?? -1;
      if (i >= 0) { list!.splice(i, 1); continue outer; }
    }
    unmatched++;
    if (examples.length < 3) examples.push(v.map(x => q(x)).join(","));
  }
  const leftover = [...grid.values()].reduce((n, l) => n + l.length, 0);
  check(label, unmatched === 0 && leftover === 0,
    unmatched || leftover ? `blender-only ${unmatched} (e.g. ${examples.join("; ")}), port-only ${leftover}` : `(${blender.length})`);
}

for (const t of truths) {
  const c = t.config;
  const p: BuildingParams = {
    ...defaultParams(),
    baysX: c.baysX, baysY: c.baysY, floors: c.floors, dormers: c.dormers, balcony: c.balcony,
    detailPattern: c.pattern, detailStyle: c.style, detailSeed: c.detailSeed, detailDepth: c.detailDepth,
    roomSeed: c.roomSeed, curtainSeed: c.curtainSeed,
  };
  console.log(`\n${JSON.stringify(c)}`);
  const b = generateBuilding(p);

  // instances: module + bit-exact translation, rotation/scale to 1e-6
  const instKey = (name: string, m: number[]) =>
    `${name}@${m[12]},${m[13]},${m[14]}|${[0, 1, 4, 5, 10].map(i => q(m[i], 5)).join(",")}`;
  compareBags("instances (exact float32 positions)",
    t.instances.map(i => instKey(i.name, i.m)),
    b.instances.map(i => instKey(i.key, i.m)));

  compareClouds("roof cap", t.cap, b.cap);

  const rooms = generateRooms(b.instances, p);
  if (t.rooms) {
    const tr = t.rooms;
    const tVerts = tr.position.map((v, i) => [v, tr.room_local[i], tr.room_p1[i], tr.room_p2[i], tr.room_p3[i]].flat());
    const rVerts: number[][] = [];
    for (let i = 0; i < rooms.position.length / 3; i++) {
      const s = (a: number[]) => a.slice(i * 3, i * 3 + 3);
      rVerts.push([s(rooms.position), s(rooms.roomLocal), s(rooms.p1), s(rooms.p2), s(rooms.p3)].flat());
    }
    compareClouds("rooms (position + room_local + p1..p3)", tVerts, rVerts);
  }

  const cur = generateCurtains(b.instances, p);
  const cVerts: number[][] = [];
  for (let i = 0; i < cur.position.length; i += 3) cVerts.push(cur.position.slice(i, i + 3));
  compareClouds("curtains", t.curtains, cVerts);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS MATCH BLENDER");
process.exit(failures ? 1 : 0);
