/**
 * Finishes the Blender capture (blender_record.py): a mouse cursor dragging
 * the input that changes (Blender hides it while dragging a number field; the
 * video shows it), a glow on that field, a zoom that lands and then creeps in,
 * and a "Blender Geometry Nodes" card over the node graph.
 *
 *   node tools/video/blender_compose.mjs <frames_dir> <out.mp4>
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clamp01, EASE } from "./timeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const puppeteer = createRequire(import.meta.url)("puppeteer-core");
const [dir, out] = process.argv.slice(2);
const FPS = 60, W = 1920, H = 1080;
const frames = (await readdir(dir)).filter(f => /^\d{4}\.png$/.test(f)).sort();
const blender = (await readFile(join(here, "assets/blender-logo.png"))).toString("base64");

// the input dragged in each second (window pixels of its value field) and its
// value track, as in blender_record.py
const FIELD = { x0: 1732, x1: 1855, h: 23 };
const DRAGS = [
  { t0: 0.04, t1: 0.8, y: 453, dir: 1 },   // Paris · Floors 2 → 9
  { t0: 1.08, t1: 1.85, y: 593, dir: -1 }, // New York · Corner Angle 90° → 60°
  { t0: 2.08, t1: 2.8, y: 458, dir: 1 },   // 中国 · Depth 13 → 20
];
const EASES = [EASE.linear, EASE.inOut, EASE.inOut];
const DRAG_PX = 80;

/** cursor position + drag state at t */
function cursor(t) {
  const i = Math.max(0, DRAGS.findLastIndex(d => t >= d.t0 - 0.2));
  const d = DRAGS[i];
  const cx = (FIELD.x0 + FIELD.x1) / 2 - d.dir * DRAG_PX * 0.45;
  const prev = DRAGS[i - 1];
  // glide in from where the last drag ended
  let x = cx, y = d.y;
  if (prev && t < d.t0) {
    const px = (FIELD.x0 + FIELD.x1) / 2 - prev.dir * DRAG_PX * 0.45 + prev.dir * DRAG_PX;
    const k = EASE.inOut(clamp01((t - (d.t0 - 0.2)) / 0.18));
    x = px + (cx - px) * k;
    y = prev.y + (d.y - prev.y) * k;
  }
  const p = EASES[i](clamp01((t - d.t0) / (d.t1 - d.t0)));
  if (t >= d.t0) x = cx + d.dir * DRAG_PX * p;
  const dragging = t >= d.t0 - 0.03 && t <= d.t1 + 0.05;
  // the arrow tip on the lower edge of the field: the value (centred in it) stays readable
  return { x, y: y + 9, dragging, glow: dragging ? 1 : clamp01(1 - (t - d.t1 - 0.05) / 0.2), fy: d.y };
}

const html = `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
  body { font-family: Bahnschrift, "Segoe UI", sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
  #stage { position: absolute; inset: 0; transform-origin: 86% 42%; }
  #bg { position: absolute; inset: 0; width: ${W}px; height: ${H}px; }
  #glow { position: absolute; left: ${FIELD.x0 - 3}px; width: ${FIELD.x1 - FIELD.x0 + 6}px; height: ${FIELD.h + 6}px; border-radius: 7px;
    box-shadow: 0 0 0 2px #ff9a2e, 0 0 18px 4px rgba(255,154,46,.55); }
  #cur { position: absolute; left: 0; top: 0; width: 26px; height: 38px; transform-origin: 0 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
  .card { position: absolute; left: 50%; top: 700px; transform: translateX(-50%); display: flex; align-items: center; gap: 26px;
    padding: 22px 38px 22px 26px; border-radius: 26px; background: rgba(12,13,16,.72); backdrop-filter: blur(14px) saturate(140%);
    border: 1px solid rgba(255,255,255,.12); box-shadow: 0 20px 60px rgba(0,0,0,.45); white-space: nowrap; }
  .card img { width: 86px; height: 86px; }
  .card h1 { margin: 0; font-size: 56px; line-height: 1; font-weight: 700; letter-spacing: .03em; }
  .card p { margin: 10px 0 0; font-size: 26px; opacity: .78; letter-spacing: .02em; }
  .card p b { color: #ff9a2e; font-weight: 600; }
</style></head><body>
  <div id="stage">
    <img id="bg">
    <div id="glow"></div>
    <svg id="cur" viewBox="0 0 13 19"><path d="M1 1v15.2l3.6-3.4 2.4 5.5 2.4-1-2.4-5.4h5z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/></svg>
  </div>
  <div class="card" id="card" style="left:790px"><img src="data:image/png;base64,${blender}">
    <div><h1>BLENDER GEOMETRY NODES</h1><p>the graphs behind all 3 buildings · <b>every slider rebuilds them</b></p></div></div>
  <script>
    window.__frame = s => new Promise(res => {
      const bg = document.getElementById("bg");
      const done = () => {
        document.getElementById("stage").style.transform = "scale(" + s.zoom + ")";
        const c = document.getElementById("cur");
        c.style.transform = "translate(" + s.cx + "px," + s.cy + "px) scale(" + s.press + ")";
        const g = document.getElementById("glow");
        g.style.top = (s.fy - ${FIELD.h / 2} - 3) + "px";
        g.style.opacity = s.glow;
        const card = document.getElementById("card");
        card.style.opacity = s.card;
        card.style.transform = "translateX(-50%) translateY(" + s.cardY + "px)";
        requestAnimationFrame(() => res());
      };
      bg.onload = () => bg.decode().then(done);
      bg.src = s.src;
    });
  </script>
</body></html>`;
const page_ = join(dir, "compose.html");
await writeFile(page_, html);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--force-color-profile=srgb", "--allow-file-access-from-files"], defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
await page.goto(pathToFileURL(page_).href, { waitUntil: "load" });

const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-profile:v", "high",
  "-movflags", "+faststart", "-r", String(FPS), out,
], { stdio: ["pipe", "inherit", "inherit"] });
const ffDone = new Promise((res, rej) => ff.on("close", c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

for (let f = 0; f < frames.length; f++) {
  const t = f / FPS;
  const c = cursor(t);
  // lands (a quick zoom-out settle), then creeps in
  const zoom = 1 + 0.09 * (1 - EASE.out(clamp01(t / 0.4))) + 0.035 * (t / 3);
  const cardIn = EASE.out(clamp01((t - 0.12) / 0.3));
  await page.evaluate(s => window.__frame(s), {
    src: frames[f], zoom, cx: c.x, cy: c.y, press: c.dragging ? 0.9 : 1, glow: c.glow, fy: c.fy,
    card: cardIn, cardY: (1 - cardIn) * 24,
  });
  const png = await page.screenshot({ type: "png", optimizeForSpeed: true });
  if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once("drain", r));
}
ff.stdin.end();
await ffDone;
await browser.close();
console.log("saved", out, `(${frames.length} frames)`);
