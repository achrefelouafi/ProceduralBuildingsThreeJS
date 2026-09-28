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
const SCALE = Number(flag("scale", 1));
const W = 1920, H = 1080;
const T0 = Number(flag("from", 0));
const T1 = Math.min(Number(flag("to", story.duration)), story.duration);
const stills = flag("stills", "")?.split(",").filter(Boolean).map(Number) ?? [];

// ---------------------------------------------------------------- timeline math

const clamp01 = x => Math.min(Math.max(x, 0), 1);
const EASE = {
  linear: x => x,
  inOut: x => x * x * x * (x * (x * 6 - 15) + 10),
  out: x => 1 - (1 - x) ** 3,
  in: x => x * x * x,
};
const deg = r => (r * 180) / Math.PI;

/** a param track's value at t: keys [t, value, how], how = "cut" (jump) or an ease (tween from the previous key) */
function trackValue(tr, t) {
  const k = tr.keys;
  if (t < k[0][0]) return k[0][1];
  let i = 0;
  while (i + 1 < k.length && k[i + 1][0] <= t) i++;
  const next = k[i + 1];
  if (next && next[2] !== "cut" && typeof next[1] === "number") {
    const [ta, va] = k[i];
    const v = va + (next[1] - va) * EASE[next[2]](clamp01((t - ta) / (next[0] - ta)));
    return tr.int ? Math.round(v) : v;
  }
  return k[i][1];
}

/** monotone cubic (no overshoot) through keys [{t, v}], flat at the ends */
function monotone(keys, t) {
  const n = keys.length;
  if (n === 1 || t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let i = 0;
  while (t > keys[i + 1].t) i++;
  const d = j => (keys[j + 1].v - keys[j].v) / (keys[j + 1].t - keys[j].t);
  const tan = j => {
    if (j === 0 || j === n - 1 || keys[j].hold) return 0;
    const a = d(j - 1), b = d(j);
    return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b);
  };
  const a = keys[i], b = keys[i + 1], h = b.t - a.t, s = (t - a.t) / h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * h * tan(i) + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * h * tan(i + 1);
}

/** camera at t from the story's keys (split into shots at `cut`), values may be functions of the bounds */
function cameraAt(t, b) {
  const keys = story.cam;
  let start = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i].cut && keys[i].t <= t) start = i;
  let end = keys.length;
  for (let i = start + 1; i < keys.length; i++) if (keys[i].cut) { end = i; break; }
  const shot = keys.slice(start, end);
  const val = (k, name, def) => {
    const v = k[name] ?? def;
    return typeof v === "function" ? v(b) : v;
  };
  const ch = name => monotone(shot.map(k => ({ t: k.t, hold: k.hold, v: resolved(k)[name] })), t);
  // every key resolved against the current bounds (distance from `fit` if given)
  const cache = new Map();
  function resolved(k) {
    let r = cache.get(k);
    if (!r) {
      const fov = val(k, "fov", 32);
      const dist = k.fit !== undefined ? (b.r / Math.sin((fov * Math.PI) / 360)) * val(k, "fit") : val(k, "dist", 40);
      r = { az: val(k, "az", 0), el: val(k, "el", 10), dist, fov, tx: val(k, "tx", 0), ty: val(k, "ty", b.h * 0.42), tz: val(k, "tz", 0), sx: val(k, "sx", 0) };
      cache.set(k, r);
    }
    return r;
  }
  const az = (ch("az") * Math.PI) / 180, el = (ch("el") * Math.PI) / 180, dist = ch("dist");
  // pan sideways along the camera's right vector (cos az, 0, −sin az)
  const sx = ch("sx");
  const tx = ch("tx") + Math.cos(az) * sx, ty = ch("ty"), tz = ch("tz") - Math.sin(az) * sx;
  return {
    p: [tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, tz + Math.cos(az) * Math.cos(el) * dist],
    t: [tx, ty, tz],
    fov: ch("fov"),
  };
}

// ---------------------------------------------------------------- overlay state

const fadeWin = (t, t0, t1, fin = 0.35, fout = 0.3) => clamp01(Math.min((t - t0) / fin, (t1 - t) / fout));
const fmtRow = (r, v) => {
  switch (r.type) {
    case "int": case "seed": return { text: String(Math.round(v)), frac: r.type === "int" ? (v - r.min) / (r.max - r.min) : undefined };
    case "float": return { text: Number(v).toFixed(r.digits ?? 2), frac: (v - r.min) / (r.max - r.min) };
    case "pct": return { text: String(Math.round(v * 100)), unit: "%", frac: v };
    case "deg": return { text: deg(v).toFixed(0), unit: "°", frac: (v - r.min) / (r.max - r.min) };
    case "m": return { text: Number(v).toFixed(r.digits ?? 1), unit: " m", frac: (v - r.min) / (r.max - r.min) };
    case "bool": return { on: !!v, text: v ? "ON" : "OFF" };
    case "menu": return { text: r.labels?.[v] ?? String(v), options: r.options.map(o => r.labels?.[o] ?? o) };
    case "color": {
      const c = v.map(x => Math.round(255 * Math.min(1, x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055)));
      const hex = "#" + c.slice(0, 3).map(x => x.toString(16).padStart(2, "0")).join("");
      return { css: hex, text: r.names?.[hex] ?? hex.toUpperCase() };
    }
    case "text": return { text: String(v) };
  }
};

function overlayAt(t, applied, changedAt) {
  const s = { progress: t / story.duration, brand: 1 };
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
      rows: seg.rows.map(r => {
        const v = applied[r.key];
        const since = t - (changedAt[r.key] ?? -9);
        const row = { name: r.name, type: r.type === "pct" || r.type === "deg" || r.type === "m" || r.type === "seed" ? "num" : r.type, ...fmtRow(r, v) };
        row.pop = since < 0.18 ? 1 - since / 0.18 : 0;
        if (r.type === "bool") row.knob = v ? EASE.out(clamp01(since / 0.2)) : 1 - EASE.out(clamp01(since / 0.2));
        if (r.type === "text") row.caret = Math.floor(t * 2.2) % 2 === 0 || since < 0.5 ? 1 : 0;
        if (r.type === "menu") row.options = r.options.map(o => r.labels?.[o] ?? o);
        return row;
      }),
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
await page.evaluate(installOverlay, story.theme);
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
  "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-profile:v", "high",
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
