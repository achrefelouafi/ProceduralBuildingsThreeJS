/**
 * Timeline math shared by the recorders: parameter tracks, the camera path
 * and the values shown on the parameter cards.
 */

export const clamp01 = x => Math.min(Math.max(x, 0), 1);
export const EASE = {
  linear: x => x,
  inOut: x => x * x * x * (x * (x * 6 - 15) + 10),
  out: x => 1 - (1 - x) ** 3,
  in: x => x * x * x,
};
const deg = r => (r * 180) / Math.PI;

/** a param track's value at t: keys [t, value, how], how = "cut" (jump) or an ease (tween from the previous key) */
export function trackValue(tr, t) {
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

/**
 * camera at t from the story's keys (split into shots at `cut`); values may be
 * functions of the bounds. `fit` sizes the distance so the bounds' sphere fits
 * the narrower of the vertical / horizontal field of view (aspect = w / h).
 */
export function cameraAt(keys, t, b, aspect = 16 / 9) {
  let start = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i].cut && keys[i].t <= t) start = i;
  let end = keys.length;
  for (let i = start + 1; i < keys.length; i++) if (keys[i].cut) { end = i; break; }
  const shot = keys.slice(start, end);
  const val = (k, name, def) => {
    const v = k[name] ?? def;
    return typeof v === "function" ? v(b) : v;
  };
  const cache = new Map();
  function resolved(k) {
    let r = cache.get(k);
    if (!r) {
      const fov = val(k, "fov", 32);
      const half = Math.min((fov * Math.PI) / 360, Math.atan(Math.tan((fov * Math.PI) / 360) * aspect));
      const dist = k.fit !== undefined ? (b.r / Math.sin(half)) * val(k, "fit") : val(k, "dist", 40);
      r = { az: val(k, "az", 0), el: val(k, "el", 10), dist, fov, tx: val(k, "tx", 0), ty: val(k, "ty", b.h * 0.42), tz: val(k, "tz", 0), sx: val(k, "sx", 0) };
      cache.set(k, r);
    }
    return r;
  }
  const ch = name => monotone(shot.map(k => ({ t: k.t, hold: k.hold, v: resolved(k)[name] })), t);
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

export const fadeWin = (t, t0, t1, fin = 0.35, fout = 0.3) => clamp01(Math.min((t - t0) / fin, (t1 - t) / fout));

function fmtRow(r, v) {
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
}

/** a card row for value v, `since` seconds after it last changed */
export function rowState(r, v, since, t) {
  const row = { name: r.name, type: ["pct", "deg", "m", "seed"].includes(r.type) ? "num" : r.type, ...fmtRow(r, v) };
  row.pop = since < 0.18 ? 1 - since / 0.18 : 0;
  if (r.type === "bool") row.knob = v ? EASE.out(clamp01(since / 0.2)) : 1 - EASE.out(clamp01(since / 0.2));
  if (r.type === "text") row.caret = Math.floor(t * 2.2) % 2 === 0 || since < 0.5 ? 1 : 0;
  return row;
}
