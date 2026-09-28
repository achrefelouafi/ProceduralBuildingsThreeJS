/**
 * The 3-second split-screen hook: the three buildings side by side, each
 * changing fast, under a "Blender Geometry Nodes → three.js" header.
 *
 *   node tools/video/split.mjs <dist> <out.mp4> [--skip-panels]
 *
 * 1. records the three portrait panels (stories split_fr / split_ny / split_cn,
 *    in parallel, each with record.mjs),
 * 2. renders the graphics as transparent frames (header, logos, dividers and a
 *    live parameter chip per panel, values read from the same tracks),
 * 3. stacks the panels and lays the graphics over them with ffmpeg.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPLIT, STORIES } from "./stories.mjs";
import { clamp01, EASE, rowState, trackValue } from "./timeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const puppeteer = createRequire(import.meta.url)("puppeteer-core");
const [dist, out] = process.argv.slice(2);
const skipPanels = process.argv.includes("--skip-panels");
const FPS = 60, W = 1920, H = 1080;
const N = Math.round(SPLIT.duration * FPS);
const work = out.replace(/\.mp4$/, "") + "_work";
await mkdir(join(work, "ov"), { recursive: true });

const run = (cmd, args, log) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", d => log?.(String(d)));
  p.stderr.on("data", d => log?.(String(d)));
  p.on("close", c => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
});

// ---------------------------------------------------------------- 1 · panels
const panelFile = i => join(work, `panel${i}.mp4`);
if (!skipPanels) {
  console.log("recording the three panels…");
  await Promise.all(SPLIT.panels.map((p, i) => run("node", [join(here, "record.mjs"), p.story, dist, panelFile(i)],
    s => { for (const l of s.split("\n")) if (/saved|rebuild|error/i.test(l) && !/X4122/.test(l)) console.log(`  [${p.city}] ${l.trim()}`); })));
}

// ---------------------------------------------------------------- 2 · graphics
const blender = (await readFile(join(here, "assets/blender-logo.png"))).toString("base64");
const three = await readFile(join(here, "assets/threejs-logo.svg"), "utf8");
const PW = W / SPLIT.panels.length;

const html = `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; overflow: hidden; }
  body { font-family: Bahnschrift, "Microsoft YaHei", "Segoe UI", sans-serif; color: #fff; -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
  .scrim { position: absolute; left: 0; right: 0; top: 0; height: 300px;
    background: linear-gradient(to bottom, rgba(8,10,14,.7) 0, rgba(8,10,14,.42) 150px, rgba(8,10,14,0) 300px); }
  .head { position: absolute; left: 0; right: 0; top: 34px; text-align: center; }
  .head h1 { margin: 0; font-size: 70px; line-height: 1; font-weight: 700; letter-spacing: .04em; text-shadow: 0 4px 24px rgba(0,0,0,.35); }
  .lock { display: inline-flex; align-items: center; gap: 16px; margin-top: 20px; padding: 10px 26px 10px 18px; border-radius: 999px;
    background: rgba(14,16,20,.62); border: 1px solid rgba(255,255,255,.12); backdrop-filter: blur(10px); font-size: 27px; letter-spacing: .02em; }
  .lock img, .lock svg { width: 40px; height: 40px; display: block; }
  .lock svg { color: #fff; }
  .lock .arrow { opacity: .6; font-size: 30px; margin: 0 4px; }
  .lock .dim { opacity: .66; }
  .div { position: absolute; top: 0; bottom: 0; width: 4px; margin-left: -2px; background: #0b0c0f; }
  .chip { position: absolute; bottom: 40px; width: 560px; padding: 20px 26px 24px; border-radius: 22px; box-sizing: border-box;
    background: rgba(14,16,20,.66); backdrop-filter: blur(16px) saturate(150%); border: 1px solid rgba(255,255,255,.1);
    box-shadow: 0 16px 50px rgba(0,0,0,.28); }
  .chip .city { display: flex; align-items: center; gap: 12px; font-size: 19px; letter-spacing: .26em; font-weight: 600; }
  .chip .dot { width: 11px; height: 11px; border-radius: 50%; }
  .chip .live { margin-left: auto; font-size: 15px; letter-spacing: .18em; opacity: .7; display: flex; align-items: center; gap: 8px; }
  .chip .live i { width: 9px; height: 9px; border-radius: 50%; background: #ff3b3b; box-shadow: 0 0 10px #ff3b3b; }
  .chip .row { display: flex; align-items: baseline; justify-content: space-between; margin-top: 14px; gap: 16px; }
  .chip .nm { font-size: 34px; font-weight: 600; white-space: nowrap; }
  .chip .v { font-size: 46px; font-weight: 700; white-space: nowrap; transform-origin: right center; }
  .chip .v small { font-size: 26px; opacity: .8; margin-left: 2px; }
  .chip .sw { display: inline-block; width: 34px; height: 34px; border-radius: 9px; vertical-align: -4px; margin-right: 10px; border: 2px solid rgba(255,255,255,.75); }
  .trk { position: relative; height: 6px; margin-top: 14px; border-radius: 3px; background: rgba(255,255,255,.16); }
  .trk .f { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; }
  .trk .kn { position: absolute; top: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
</style></head><body>
  <div class="scrim"></div>
  ${SPLIT.panels.slice(1).map((_, i) => `<div class="div" style="left:${PW * (i + 1)}px"></div>`).join("")}
  <div class="head" id="head"><h1 id="h1">3 PROCEDURAL BUILDINGS</h1>
    <div class="lock"><img src="data:image/png;base64,${blender}"><span>Blender Geometry Nodes</span><span class="arrow">→</span>${three}<span>three.js <span class="dim">· real-time in the browser</span></span></div>
  </div>
  ${SPLIT.panels.map((p, i) => `<div class="chip" id="chip${i}" style="left:${PW * i + (PW - 560) / 2}px"></div>`).join("")}
  <script>
    window.__frame = s => {
      const h = document.getElementById("h1");
      h.style.letterSpacing = s.spacing + "em";
      document.getElementById("head").style.transform = "translateY(" + s.headY + "px)";
      s.chips.forEach((c, i) => { document.getElementById("chip" + i).innerHTML = c; });
    };
  </script>
</body></html>`;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function chipHtml(p, r, pop) {
  const v = `<div class="v" style="color:${p.accent};transform:scale(${(1 + 0.14 * pop).toFixed(3)})">`;
  let val = "", bar = "";
  if (r.type === "color") val = `${v}<span class="sw" style="background:${r.css}"></span>${esc(r.text)}</div>`;
  else val = `${v}${esc(r.text)}${r.unit ? `<small>${esc(r.unit)}</small>` : ""}</div>`;
  if (r.frac !== undefined) {
    const f = (clamp01(r.frac) * 100).toFixed(2);
    bar = `<div class="trk"><div class="f" style="width:${f}%;background:${p.accent}"></div><div class="kn" style="left:${f}%"></div></div>`;
  }
  return `<div class="city"><span class="dot" style="background:${p.accent};box-shadow:0 0 12px ${p.accent}"></span>${esc(p.city)}` +
    `<span class="live"><i></i>LIVE</span></div><div class="row"><div class="nm">${esc(r.name)}</div>${val}</div>${bar}`;
}

console.log("rendering the graphics…");
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--force-color-profile=srgb"], defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
const last = SPLIT.panels.map(() => ({}));
const changed = SPLIT.panels.map(() => ({}));
for (let f = 0; f < N; f++) {
  const t = f / FPS;
  const chips = SPLIT.panels.map((p, i) => {
    const story = STORIES[p.story];
    const vals = Object.fromEntries(story.params.map(tr => [tr.key, trackValue(tr, t)]));
    for (const [k, v] of Object.entries(vals)) {
      if (k in last[i] && JSON.stringify(last[i][k]) !== JSON.stringify(v)) changed[i][k] = t;
      last[i][k] = v;
    }
    let ci = 0;
    for (let j = 0; j < p.chips.length; j++) if (p.chips[j].t <= t) ci = j;
    const c = p.chips[ci];
    const keys = c.keys ?? (c.key ? [c.key] : []);
    const since = Math.min(t - c.t, ...keys.map(k => t - (changed[i][k] ?? -9)));
    const row = c.key ? rowState(c, vals[c.key], since, t) : { name: c.name, text: c.text(vals), frac: c.frac?.(vals) };
    return chipHtml(p, row, since < 0.16 ? 1 - since / 0.16 : 0);
  });
  const e = EASE.out(clamp01(t / 0.5));
  await page.evaluate(s => window.__frame(s), { chips, spacing: 0.04 + 0.1 * (1 - e), headY: -10 * (1 - e) });
  await page.screenshot({ path: join(work, "ov", `${String(f).padStart(4, "0")}.png`), omitBackground: true });
}
await browser.close();

// ---------------------------------------------------------------- 3 · composite
console.log("compositing…");
await mkdir(dirname(out), { recursive: true });
await run("ffmpeg", [
  "-y", "-loglevel", "error",
  ...SPLIT.panels.flatMap((_, i) => ["-i", panelFile(i)]),
  "-framerate", String(FPS), "-i", join(work, "ov", "%04d.png"),
  "-filter_complex", `${SPLIT.panels.map((_, i) => `[${i}:v]`).join("")}hstack=inputs=${SPLIT.panels.length}[bg];[bg][${SPLIT.panels.length}:v]overlay=0:0:format=auto,format=yuv420p`,
  "-frames:v", String(N), "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high", "-r", String(FPS),
  "-movflags", "+faststart", out,
], s => process.stdout.write(s));
if (!process.argv.includes("--keep")) await rm(join(work, "ov"), { recursive: true });
console.log("saved", out);
