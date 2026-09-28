/**
 * Frame-exact showcase videos of the procedural buildings.
 *
 *   npx vite build --outDir <dist>
 *   node tools/video/record.mjs <story> <dist> <out.mp4> [--from s] [--to s] [--step n] [--stills t,t,…] [--scale k]
 *
 * <story> is a key of stories.mjs (french | nyc | cn). The app runs headless
 * on a virtual clock (app.mjs): each video frame sets the building parameters
 * for its time (rebuilding the building when they change, however long that
 * takes), poses the camera and the overlay, advances the app by exactly 1/60 s
 * and is captured, then piped to ffmpeg. `--stills` renders single frames
 * (PNG, next to <out>) to check framing without recording.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openApp, virtualTime } from "./app.mjs";
import { installOverlay } from "./overlay.mjs";
import { STORIES } from "./stories.mjs";
import { cameraAt as camAt, clamp01, EASE, fadeWin, rowState, trackValue } from "./timeline.mjs";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const [storyName, dist, out] = argv;
const story = STORIES[storyName];
if (!story || !dist || !out) {
  console.error(`usage: record.mjs <${Object.keys(STORIES).join("|")}> <dist> <out.mp4> [--from s] [--to s] [--step n] [--stills t,…]`);
  process.exit(1);
}
const FPS = 60;
const STEP = Number(flag("step", 1));
const SCALE = Number(flag("scale", story.scale ?? 1));
const [W, H] = story.size ?? [1920, 1080];
const cameraAt = (t, b) => camAt(story.cam, t, b, W / H);
const T0 = Number(flag("from", 0));
const T1 = Math.min(Number(flag("to", story.duration)), story.duration);
const stills = flag("stills", "")?.split(",").filter(Boolean).map(Number) ?? [];

function overlayAt(t, applied, changedAt) {
  const s = { progress: t / story.duration, brand: 1 };
  if (story.overlay === false) return s;
  for (const [key, card] of [["title", story.title], ["outro", story.outro]]) {
    if (!card || t < card.t0 || t > card.t1) continue;
    const a = fadeWin(t, card.t0, card.t1, card.fin ?? 0.6, card.fout ?? 0.5);
    const inT = clamp01((t - card.t0) / 1.2);
    s[key] = { ...card, opacity: a, dy: (1 - EASE.out(inT)) * 30, spacing: 0.01 + 0.18 * (1 - EASE.out(inT)) };
  }
  if (story.title && t < story.title.t1) s.brand = clamp01((t - story.title.t1 + 0.4) / 0.5);
  const segs = story.segments.filter(g => g.rows?.length);
  const seg = segs.find(g => t >= g.t && t < g.t + g.dur);
  if (seg) {
    const a = fadeWin(t, seg.t, seg.t + seg.dur, 0.3, 0.22);
    const inT = clamp01((t - seg.t) / 0.45);
    s.card = {
      opacity: a, dy: (1 - EASE.out(inT)) * 36,
      label: seg.label, counter: `${String(segs.indexOf(seg) + 1).padStart(2, "0")} / ${String(segs.length).padStart(2, "0")}`,
      rows: seg.rows.map(r => rowState(r, applied[r.key], t - (changedAt[r.key] ?? -9), t)),
    };
  }
  return s;
}

// ---------------------------------------------------------------- run

const tracks = story.params;
const { browser, page } = await openApp({ dist, width: W, height: H, scale: SCALE });
const apply = story.kind === "French" ? "__setParams" : "__setNyc";
await page.evaluate(k => new Promise(res => { window.__building(k).then(res); }), story.kind);
await page.evaluate(() => window.__orbit(false));
if (story.overlay === false) {
  // a bare panel: the split-screen compositor draws the graphics
  await page.addStyleTag({ content: ".lil-gui, #busy, #preloader { display: none !important; }" });
  await page.evaluate(() => { window.__ov = () => {}; });
} else await page.evaluate(installOverlay, story.theme);
await page.evaluate(() => {
  const s = window.__three.studio;
  s.setMood("Architectural", 0);
});
if (story.setup) await page.evaluate(story.setup);
await virtualTime(page);

// the lighting set's state shows on the card like a parameter
const applied = { mood: "Architectural", snow: false, rain: false };
const changedAt = {};
const lastApplyFrame = {};
const readBounds = () => page.evaluate(() => {
  const b = window.__three.studio.bounds;
  return { w: b.width, l: b.length, h: b.height };
});

/** set every track's value for time t (only the ones that changed, throttled per track) */
async function applyParams(t, frame, force = false) {
  const changes = {};
  for (const tr of tracks) {
    const v = trackValue(tr, t);
    const old = applied[tr.key];
    const same = typeof v === "number" && typeof old === "number" ? Math.abs(v - old) < 1e-7 : JSON.stringify(v) === JSON.stringify(old);
    if (same) continue;
    if (!force && tr.every && frame - (lastApplyFrame[tr.key] ?? -1e9) < tr.every && t < tr.keys[tr.keys.length - 1][0]) continue;
    changes[tr.key] = v;
  }
  if (!Object.keys(changes).length) return false;
  const t0 = Date.now();
  await page.evaluate((fn, c) => window[fn](c), apply, changes);
  const ms = Date.now() - t0;
  if (ms > 200) console.log(`  t=${t.toFixed(2)} rebuild ${ms} ms`, Object.keys(changes).join(", "));
  for (const [k, v] of Object.entries(changes)) {
    // the first value is the building's starting state, not a change to announce
    if (k in applied) changedAt[k] = t;
    applied[k] = v;
    lastApplyFrame[k] = frame;
  }
  return true;
}

let evIndex = 0;
const events = [...(story.events ?? [])].sort((a, b) => a.t - b.t);
/** fire the events (moods, weather…) whose time has come */
async function runEvents(t, instant = false) {
  while (evIndex < events.length && events[evIndex].t <= t + 1e-9) {
    const e = events[evIndex++];
    for (const k of ["mood", "snow", "rain"]) {
      if (e[k] === undefined || applied[k] === e[k]) continue;
      applied[k] = e[k];
      changedAt[k] = t;
    }
    await page.evaluate((e, instant) => {
      if (e.mood) window.__mood(e.mood, instant ? 0 : e.fade ?? 1.6);
      if (e.snow !== undefined) window.__snow(e.snow);
      if (e.rain !== undefined) window.__rain(e.rain);
      if (e.js) (0, eval)(e.js);
    }, e, instant);
  }
}

const poseAndStep = (cam, ov, ms) => page.evaluate((cam, ov, ms) => {
  const { camera } = window.__three;
  window.__setCamera(...cam.p, ...cam.t);
  if (Math.abs(camera.fov - cam.fov) > 1e-6) {
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
  }
  window.__ov(ov);
  window.__clock.advance(ms);
}, cam, ov, ms);

const withR = b => ({ ...b, r: 0.5 * Math.hypot(b.w, b.l, b.h) });

if (stills.length) {
  await mkdir(dirname(out), { recursive: true });
  for (const t of stills) {
    evIndex = 0;
    await applyParams(t, 0, true);
    await runEvents(t, true);
    const b = withR(await readBounds());
    const cam = cameraAt(t, b);
    for (let i = 0; i < 40; i++) await poseAndStep(cam, overlayAt(t, applied, changedAt), 1000 / FPS);
    const file = out.replace(/\.mp4$/, "") + `_t${t.toFixed(2)}.png`;
    await page.screenshot({ path: file });
    console.log("still", file, JSON.stringify(cam));
  }
  await browser.close();
  process.exit(0);
}

await mkdir(dirname(out), { recursive: true });
const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS / STEP), "-c:v", "mjpeg", "-i", "-",
  ...(SCALE !== 1 ? ["-vf", `scale=${W}:${H}:flags=lanczos`] : []),
  "-c:v", "libx264", "-preset", "slow", "-crf", String(story.crf ?? 16), "-pix_fmt", "yuv420p", "-profile:v", "high",
  "-movflags", "+faststart", "-r", String(FPS / STEP), out,
], { stdio: ["pipe", "inherit", "inherit"] });
const ffDone = new Promise((res, rej) => ff.on("close", c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

// warm the state up to the first frame (params, events, smoothed bounds)
const f0 = Math.round(T0 * FPS), f1 = Math.round(T1 * FPS);
await applyParams(T0, f0, true);
await runEvents(T0, true);
let bs = withR(await readBounds());
const started = Date.now();
let n = 0;
for (let f = f0; f < f1; f += STEP) {
  const t = f / FPS;
  const dt = STEP / FPS;
  const changed = await applyParams(t, f);
  await runEvents(t);
  const bt = changed ? await readBounds() : bs;
  // the framing follows the building's size, eased (a growing building pushes the camera back smoothly)
  const k = 1 - Math.exp(-dt / (story.boundsLag ?? 0.45));
  bs = withR({ w: bs.w + (bt.w - bs.w) * k, l: bs.l + (bt.l - bs.l) * k, h: bs.h + (bt.h - bs.h) * k });
  await poseAndStep(cameraAt(t, bs), overlayAt(t, applied, changedAt), dt * 1000);
  const jpg = await page.screenshot({ type: "jpeg", quality: 96, optimizeForSpeed: true });
  if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once("drain", r));
  n++;
  if (n % 60 === 0) {
    const el = (Date.now() - started) / 1000;
    const left = ((f1 - f) / STEP) * (el / n);
    console.log(`${storyName} ${t.toFixed(1)}s / ${T1}s · ${(el / n * 1000).toFixed(0)} ms/frame · ~${(left / 60).toFixed(1)} min left`);
  }
}
ff.stdin.end();
await ffDone;
await browser.close();
console.log(`saved ${out} (${n} frames in ${((Date.now() - started) / 60000).toFixed(1)} min)`);
