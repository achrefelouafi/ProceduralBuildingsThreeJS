/**
 * The README screenshots (docs/screenshots/), shot headlessly from a production build.
 *
 *   npx vite build --outDir <dist>
 *   node tools/readme_shots.mjs <dist> [outDir = docs/screenshots] [name …]
 *
 * Names pick shots from SHOTS (all of them by default). Shots without `ui` hide
 * the GUI, the contact card and the busy pill.
 */
import { mkdir } from "node:fs/promises";
import { openApp } from "./video/app.mjs";

const W = 1600, H = 900;

/**
 * kind, mood, camera (a named shot or [px,py,pz, tx,ty,tz]; `pull` scales its
 * distance from the target), weather, graph params
 */
const SHOTS = [
  { name: "app", kind: "French", mood: "Architectural", shot: "Hero ¾", ui: true },
  { name: "paris", kind: "French", mood: "Architectural", shot: "Hero ¾" },
  { name: "new-york", kind: "New York", mood: "Architectural", shot: "Hero ¾" },
  { name: "chinese", kind: "Chinese", mood: "Architectural", shot: "Hero ¾" },
  { name: "city", kind: "New York", mood: "Architectural", shot: "Aerial", pull: 2.4 },
  { name: "golden-hour", kind: "French", mood: "Golden Hour", shot: "Street level" },
  { name: "blue-hour", kind: "Chinese", mood: "Blue Hour", shot: "Hero ¾" },
  { name: "neon-night", kind: "New York", mood: "Neon Night", shot: "Hero ¾" },
  { name: "rain", kind: "New York", mood: "Storm", shot: "Street level", rain: true },
  { name: "snow", kind: "French", mood: "Blue Hour", shot: "Hero ¾", snow: true },
  { name: "facade-detail", kind: "Chinese", mood: "Golden Hour", shot: "Facade detail" },
];

const [, , dist, outDir = "docs/screenshots", ...only] = process.argv;
if (!dist) {
  console.error("usage: readme_shots.mjs <dist> [outDir] [name …]");
  process.exit(1);
}
const todo = only.length ? SHOTS.filter(s => only.includes(s.name)) : SHOTS;
await mkdir(outDir, { recursive: true });

const { browser, page } = await openApp({ dist, width: W, height: H });
const chrome = await page.addStyleTag({ content: "/* ui */" });
const setUi = on => chrome.evaluate((el, on) => {
  el.textContent = on ? "/* ui */" : ".lil-gui, #busy, #preloader, #contact { display: none !important; }";
}, on);
await page.evaluate(() => window.__orbit(false));

for (const s of todo) {
  await setUi(!!s.ui);
  await page.evaluate(k => window.__building(k), s.kind);
  if (s.params) await page.evaluate(p => window.__setNyc(p), s.params);
  await page.evaluate(s => {
    window.__snow(!!s.snow);
    window.__rain(!!s.rain);
    window.__mood(s.mood, 0);
    if (Array.isArray(s.shot)) window.__setCamera(...s.shot);
    else window.__shot(s.shot, 0);
    if (s.pull) {
      const { camera, controls } = window.__three;
      const p = camera.position.clone().sub(controls.target).multiplyScalar(s.pull).add(controls.target);
      const t = controls.target;
      window.__setCamera(p.x, p.y, p.z, t.x, t.y, t.z);
    }
  }, s);
  // DoF autofocus, "clear the view" and the weather settle over a couple of seconds
  await new Promise(r => setTimeout(r, 3000));
  const path = `${outDir}/${s.name}.jpg`;
  await page.screenshot({ path, type: "jpeg", quality: 88 });
  console.log("saved", path);
}
await browser.close();
