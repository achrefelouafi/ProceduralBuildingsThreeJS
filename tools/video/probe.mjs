// where is a material's geometry on the stage (world AABB), for framing shots
import { openApp } from "./app.mjs";
const [dist, kind, params, match] = process.argv.slice(2);
const { browser, page } = await openApp({ dist, log: false });
await page.evaluate(k => window.__building(k), kind);
if (params) await page.evaluate(p => window.__setNyc(JSON.parse(p)), params);
const r = await page.evaluate(match => {
  const { scene } = window.__three;
  const out = {};
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh || !o.visible && false) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const name = mats.map(m => m.name).join("|");
    if (!new RegExp(match).test(name)) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    if (o.isInstancedMesh) { o.computeBoundingBox(); b.copy(o.boundingBox).applyMatrix4(o.matrixWorld); }
    const e = out[name] ?? (out[name] = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] });
    ["x", "y", "z"].forEach((a, i) => { e.min[i] = Math.min(e.min[i], b.min[a]); e.max[i] = Math.max(e.max[i], b.max[a]); });
  });
  const s = window.__three.studio.bounds;
  return { bounds: [s.width, s.length, s.height], out };
}, match);
console.log(JSON.stringify(r, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v), 1));
await browser.close();
