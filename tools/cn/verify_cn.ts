/**
 * Compare the graph evaluator on CN_ApartmentBuilding.blend with Blender
 * (tools/cn/truth.json from dump_cn_truth.py): for every parameter set, the
 * realized output mesh must have the same vertex / face / corner counts and,
 * per material, the same face, corner and smooth-face counts, area, bounding
 * box and area-weighted moments of face centers, UVMap and Col.
 *
 *   npm run verify:cn
 */
import { readFileSync } from "node:fs";
import { Evaluator, realize, type GraphJson } from "../../src/nyc/gn";
import { NycKit, type KitJson } from "../../src/nyc/kit";
import type { Mesh } from "../../src/nyc/geo";

const dir = "public/assets/cn/";
const graph = JSON.parse(readFileSync(dir + "graph.json", "utf8")) as GraphJson;
const kitJson = JSON.parse(readFileSync(dir + "kit.json", "utf8")) as KitJson;
const b = readFileSync(dir + "kit.bin");
const kit = new NycKit(kitJson, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

interface MatStats {
  faces: number; corners: number; smooth: number; area: number;
  moment: number[]; uv: number[]; col: number[]; min: number[]; max: number[];
}
interface MeshStats { verts: number; faces: number; corners: number; materials: Record<string, MatStats> }
const truth = JSON.parse(readFileSync(process.argv[2] ?? "tools/cn/truth.json", "utf8")) as {
  sets: { params: Record<string, unknown>; mesh: MeshStats }[];
};

function stats(m: Mesh | null): MeshStats {
  const out: MeshStats = { verts: m?.points ?? 0, faces: m?.faces ?? 0, corners: m?.cornerCount ?? 0, materials: {} };
  if (!m) return out;
  const uv = m.corner.get("UVMap"), col = m.point.get("Col");
  for (let f = 0; f < m.faces; f++) {
    const name = m.materials[m.matIndex[f]] ?? "-";
    const s = (out.materials[name] ??= {
      faces: 0, corners: 0, smooth: 0, area: 0, moment: [0, 0, 0], uv: [0, 0], col: [0, 0, 0, 0],
      min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
    });
    const a = m.faceArea(f), c = m.faceCenter(f), fv = m.face_(f), c0 = m.faceStart[f];
    s.faces++; s.corners += fv.length; s.smooth += m.smooth[f]; s.area += a;
    for (let k = 0; k < 3; k++) s.moment[k] += a * c[k];
    for (let j = 0; j < fv.length; j++) {
      const v = fv[j];
      for (let k = 0; k < 3; k++) { s.min[k] = Math.min(s.min[k], m.pos[v * 3 + k]); s.max[k] = Math.max(s.max[k], m.pos[v * 3 + k]); }
      if (uv) for (let k = 0; k < 2; k++) s.uv[k] += (a * uv.data[(c0 + j) * uv.size + k]) / fv.length;
      if (col) for (let k = 0; k < 4; k++) s.col[k] += (a * col.data[v * col.size + k]) / fv.length;
    }
  }
  return out;
}

const close = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol;
let allOk = true;
truth.sets.forEach((set, si) => {
  const ev = new Evaluator(graph, kit);
  const t0 = performance.now();
  let mesh: Mesh | null;
  try {
    const geo = ev.run(graph.root, set.params);
    mesh = (geo.instances ? realize(geo) : geo).mesh;
  } catch (e) {
    console.log(`set ${si}: EVALUATION FAILED — ${(e as Error).stack}`);
    allOk = false;
    return;
  }
  const ms = performance.now() - t0;
  const mine = stats(mesh), theirs = set.mesh;
  const report: string[] = [];
  if (mine.verts !== theirs.verts || mine.faces !== theirs.faces || mine.corners !== theirs.corners) {
    report.push(`    totals: mine ${mine.verts} v / ${mine.faces} f / ${mine.corners} c, blender ${theirs.verts} / ${theirs.faces} / ${theirs.corners}`);
  }
  let bad = 0;
  for (const name of [...new Set([...Object.keys(mine.materials), ...Object.keys(theirs.materials)])].sort()) {
    const a = mine.materials[name], t = theirs.materials[name];
    if (!a || !t) { bad++; report.push(`    ${name}: ${a ? "only mine" : "only blender"} (${(a ?? t)!.faces} faces)`); continue; }
    const why: string[] = [];
    // counts can differ where Blender's CDT and our fill triangulate n-gons differently, so they're checked as area
    if (a.faces !== t.faces) why.push(`faces ${a.faces}/${t.faces}`);
    if (a.corners !== t.corners) why.push(`corners ${a.corners}/${t.corners}`);
    if (a.smooth !== t.smooth) why.push(`smooth ${a.smooth}/${t.smooth}`);
    const tolA = 1e-4 * Math.max(1, t.area);
    if (!close(a.area, t.area, tolA)) why.push(`area ${a.area.toFixed(4)}/${t.area.toFixed(4)}`);
    const ext = Math.max(1, ...t.max.map((x, k) => Math.abs(x - t.min[k])));
    a.moment.forEach((x, k) => { if (!close(x, t.moment[k], 2e-4 * t.area * ext + 1e-3)) why.push(`moment.${"xyz"[k]} ${x.toFixed(3)}/${t.moment[k].toFixed(3)}`); });
    a.uv.forEach((x, k) => { if (!close(x, t.uv[k], 2e-4 * t.area * Math.max(1, Math.abs(t.uv[k] / Math.max(t.area, 1e-9))) + 1e-3)) why.push(`uv.${"uv"[k]} ${x.toFixed(3)}/${t.uv[k].toFixed(3)}`); });
    a.col.forEach((x, k) => { if (!close(x, t.col[k], 2e-4 * t.area + 1e-3)) why.push(`col.${"rgba"[k]} ${x.toFixed(3)}/${t.col[k].toFixed(3)}`); });
    a.min.forEach((x, k) => { if (!close(x, t.min[k], 2e-3)) why.push(`min.${"xyz"[k]} ${x.toFixed(3)}/${t.min[k].toFixed(3)}`); });
    a.max.forEach((x, k) => { if (!close(x, t.max[k], 2e-3)) why.push(`max.${"xyz"[k]} ${x.toFixed(3)}/${t.max[k].toFixed(3)}`); });
    if (why.length) { bad++; report.push(`    ${name}: ${why.join(", ")}`); }
  }
  const nMat = Object.keys(theirs.materials).length;
  console.log(`set ${si}: ${mine.verts} verts / ${mine.faces} faces in ${ms.toFixed(0)} ms, blender ${theirs.verts} / ${theirs.faces}; ` +
    `${nMat} materials, ${bad} mismatched`);
  report.slice(0, 40).forEach(r => console.log(r));
  if (report.length) allOk = false;
});
console.log(allOk ? "\nCN: ALL SETS MATCH BLENDER" : "\nCN: MISMATCHES");
if (!allOk) process.exitCode = 1;
