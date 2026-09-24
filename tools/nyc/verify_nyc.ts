/**
 * Compare the NYC evaluator with Blender (tools/nyc/truth.json from
 * dump_nyc_truth.py): for every parameter set, the multiset of rendered
 * leaves (mesh signature + world matrix) must match.
 *
 *   npm run verify:nyc
 */
import { readFileSync } from "node:fs";
import { Evaluator, type GraphJson } from "../../src/nyc/gn";
import { NycKit, type KitJson } from "../../src/nyc/kit";
import { leaves, signature } from "../../src/nyc/flatten";

const dir = "public/assets/nyc/";
const graph = JSON.parse(readFileSync(dir + "graph.json", "utf8")) as GraphJson;
const kitJson = JSON.parse(readFileSync(dir + "kit.json", "utf8")) as KitJson;
const b = readFileSync(dir + "kit.bin");
const kit = new NycKit(kitJson, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const truth = JSON.parse(readFileSync(process.argv[2] ?? "tools/nyc/truth.json", "utf8")) as {
  sets: { params: Record<string, unknown>; leaves: { sig: string; m: number[] }[]; own: { sig: string; m: number[] } | null }[];
};

const normSig = (s: string) => {
  const [v, f, mats] = s.split("/");
  const ms = mats.split(",").filter(x => x !== "-");
  return `${v}/${f}/${ms.sort().join(",") || "-"}`;
};
const TOL = 2e-3; // truth.json stores 4 decimals; float32 paths differ in the last bits
const mat12 = (m: Float32Array) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]];
const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= TOL);
/** greedy one-to-one matching of two matrix lists; returns unmatched counts + examples */
function match(a: number[][], b: number[][]): { ma: number; mb: number; ea?: number[]; eb?: number[] } {
  const used = new Uint8Array(b.length);
  const byX = b.map((m, i) => i).sort((i, j) => b[i][9] - b[j][9]);
  const xs = byX.map(i => b[i][9]);
  let ma = 0, ea: number[] | undefined;
  for (const m of a) {
    // binary search the translation-x window, then test candidates
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < m[9] - TOL) lo = mid + 1; else hi = mid; }
    let hit = -1;
    for (let k = lo; k < xs.length && xs[k] <= m[9] + TOL; k++) {
      const j = byX[k];
      if (!used[j] && close(m, b[j])) { hit = j; break; }
    }
    if (hit >= 0) used[hit] = 1; else { ma++; ea ??= m; }
  }
  let mb = 0, eb: number[] | undefined;
  used.forEach((u, j) => { if (!u) { mb++; eb ??= b[j]; } });
  return { ma, mb, ea, eb };
}
const fmt = (m?: number[]) => (m ? m.map(x => x.toFixed(3)).join(" ") : "");

let allOk = true;
truth.sets.forEach((set, si) => {
  const ev = new Evaluator(graph, kit);
  const t0 = performance.now();
  let geo;
  try {
    geo = ev.run(graph.root, set.params);
  } catch (e) {
    console.log(`set ${si}: EVALUATION FAILED — ${(e as Error).message}`);
    allOk = false;
    return;
  }
  const ms = performance.now() - t0;
  const ls = leaves(geo);
  const mine = new Map<string, number[][]>();
  let own: string | null = null;
  for (const l of ls) {
    const s = signature(l.mesh);
    const isOwn = l.matrix.every((x, i) => x === [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i]) && geo.mesh === l.mesh;
    if (isOwn) { own = s; continue; }
    (mine.get(s) ?? mine.set(s, []).get(s)!).push(mat12(l.matrix));
  }
  const theirs = new Map<string, number[][]>();
  for (const l of set.leaves) {
    const s = normSig(l.sig);
    (theirs.get(s) ?? theirs.set(s, []).get(s)!).push(l.m);
  }
  const sigs = new Set([...mine.keys(), ...theirs.keys()]);
  let bad = 0;
  const report: string[] = [];
  for (const s of [...sigs].sort()) {
    const a = mine.get(s) ?? [], b2 = theirs.get(s) ?? [];
    const r = match(a, b2);
    if (r.ma || r.mb) {
      bad++;
      report.push(`    ${s}: mine ${a.length}, blender ${b2.length}, unmatched mine ${r.ma}, unmatched blender ${r.mb}` +
        (r.ea ? `\n      e.g. mine    ${fmt(r.ea)}` : "") + (r.eb ? `\n      e.g. blender ${fmt(r.eb)}` : ""));
    }
  }
  const ownT = set.own ? normSig(set.own.sig) : null;
  const ownOk = own === ownT;
  console.log(`set ${si}: ${ls.length} leaves in ${ms.toFixed(0)} ms, blender ${set.leaves.length}; ` +
    `${sigs.size} mesh kinds, ${bad} mismatched; own mesh ${ownOk ? "ok" : `MISMATCH mine ${own} blender ${ownT}`}`);
  report.slice(0, 25).forEach(r => console.log(r));
  if (bad || !ownOk) allOk = false;
});
console.log(allOk ? "\nNYC: ALL SETS MATCH BLENDER" : "\nNYC: MISMATCHES");
if (!allOk) process.exitCode = 1;
