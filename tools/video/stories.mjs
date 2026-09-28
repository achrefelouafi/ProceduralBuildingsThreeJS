/**
 * The three showcase videos: one per building, 60 fps. Each is
 *  - a hook: the building morphing through variations under its title,
 *  - segments: one parameter group each, with its own camera move and the
 *    parameter card (live values),
 *  - a lighting finale and an outro.
 *
 * Params: per key, keyframes [t, value, how] where `how` is "cut" (jump at t)
 * or an ease ("linear", "inOut", "out", "in": tween from the previous key).
 * Camera: keys {t, az, el, fit | dist, tx, ty, tz, sx, fov, cut, hold}; az 0°
 * looks at the front facade (+Z), positive az swings to +X; `fit` sizes the
 * distance to the building's (eased) bounds; `sx` pans the frame sideways
 * (negative: the building sits right of centre). Values may be functions of
 * the bounds b = { w, l, h, r } (x extent, z extent, height, half diagonal).
 */

function timeline() {
  const map = new Map();
  const get = k => {
    if (!map.has(k)) map.set(k, { key: k, keys: [] });
    return map.get(k);
  };
  const api = {
    set(t, o) {
      for (const [k, v] of Object.entries(o)) get(k).keys.push([t, v, "cut"]);
      return api;
    },
    tween(t0, t1, o, ease = "inOut") {
      for (const [k, v] of Object.entries(o)) get(k).keys.push([t0, undefined, "cut"], [t1, v, ease]);
      return api;
    },
    /** values one after another, every dt */
    seq(t0, dt, key, values) {
      values.forEach((v, i) => api.set(t0 + i * dt, { [key]: v }));
      return t0 + values.length * dt;
    },
    /** backspace `from`, then type `to` */
    type(t0, key, from, to, del = 0.07, add = 0.16) {
      let t = t0;
      for (let i = from.length - 1; i >= 0; i--) api.set((t += del), { [key]: from.slice(0, i) });
      t += 0.25;
      for (let i = 1; i <= to.length; i++) api.set((t += add), { [key]: [...to].slice(0, i).join("") });
      return t;
    },
    opts(k, o) {
      Object.assign(get(k), o);
      return api;
    },
    build() {
      const out = [];
      for (const tr of map.values()) {
        tr.keys.sort((a, b) => a[0] - b[0]);
        let last;
        for (const k of tr.keys) {
          if (k[1] === undefined) {
            if (last === undefined) throw new Error(`${tr.key}: tween before any value`);
            k[1] = last;
          }
          last = k[1];
        }
        out.push(tr);
      }
      return out;
    },
  };
  return api;
}

const rad = d => (d * Math.PI) / 180;
/** linear Blender color from sRGB hex */
const lin = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).concat(1);
};

// =====================================================================================
// PARIS — the Haussmann building (src/generator.ts)
// =====================================================================================

const french = (() => {
  const P = timeline();
  const D = { baysX: 6, baysY: 3, floors: 3, dormers: true, balcony: "exterior", detailPattern: "alternate", detailStyle: "pilasters", detailSeed: 0, detailDepth: 1, closedChance: 0.32, noCurtainChance: 0.3, roomSeed: 0 };
  P.set(0, D);
  // hook: variations
  const V = [
    { baysX: 5, baysY: 3, floors: 5, detailStyle: "refends", detailPattern: "same", balcony: "existing", dormers: true },
    { baysX: 8, baysY: 4, floors: 4, detailStyle: "ornamented", detailPattern: "alternate", balcony: "exterior", dormers: false },
    { baysX: 4, baysY: 4, floors: 6, detailStyle: "pilasters", detailPattern: "random", balcony: "exterior", dormers: true },
    { baysX: 9, baysY: 2, floors: 3, detailStyle: "refends", detailPattern: "alternate", balcony: "existing", dormers: true },
    { baysX: 6, baysY: 5, floors: 7, detailStyle: "ornamented", detailPattern: "same", balcony: "existing", dormers: false },
    { baysX: 7, baysY: 3, floors: 4, detailStyle: "pilasters", detailPattern: "random", balcony: "exterior", dormers: true },
  ];
  V.forEach((v, i) => P.set(0.6 + i * 0.42, v));
  P.set(3.12, D);

  // S1 floors
  P.tween(3.9, 6.3, { floors: 10 }, "linear");
  P.tween(6.55, 7.1, { floors: 6 }, "linear");
  // S2 footprint
  P.tween(7.9, 9.3, { baysX: 14 }, "linear");
  P.tween(8.2, 9.7, { baysY: 7 }, "linear");
  P.tween(10.0, 10.9, { baysX: 8, baysY: 4 }, "linear");
  // S3 dormers
  P.seq(12.0, 0.6, "dormers", [false, true, false, true]);
  // S4 balconies
  P.seq(14.5, 0.7, "balcony", ["existing", "exterior", "existing", "exterior"]);
  // S5 detail style
  P.seq(17.2, 1.05, "detailStyle", ["refends", "ornamented", "pilasters"]);
  // S6 detail pattern
  P.seq(20.7, 0.7, "detailPattern", ["off", "same", "alternate", "random"]);
  // S7 relief depth
  P.tween(23.9, 25.0, { detailDepth: 3 });
  P.tween(25.3, 26.1, { detailDepth: 0 });
  P.tween(26.25, 26.75, { detailDepth: 1.4 });
  // S8 detail seed
  P.seq(27.2, 0.11, "detailSeed", [...Array(17)].map((_, i) => i + 1));
  // S9 curtains
  P.tween(29.4, 30.5, { closedChance: 1 });
  P.tween(30.8, 31.8, { closedChance: 0 });
  P.tween(31.9, 32.4, { closedChance: 0.35 });
  ["floors", "baysX", "baysY", "detailSeed", "roomSeed"].forEach(k => P.opts(k, { int: true }));

  const front = b => b.l / 2;
  return {
    kind: "French",
    duration: 44,
    theme: { accent: "#e2c08d", brandSub: "three.js · live" },
    title: { t0: 0.15, t1: 3.3, ink: true, kicker: "PROCEDURAL BUILDING · 01", big: "PARIS", sub: "The Haussmann apartment building", sub2: "every value is a parameter" },
    outro: { t0: 39.9, t1: 44, fout: 0.6, kicker: "ONE GENERATOR", big: "ENDLESS<br>PARIS", sub: "Ported from Blender geometry nodes to three.js", sub2: "real-time · in the browser" },
    params: P.build(),
    segments: [
      { t: 3.45, dur: 3.95, label: "BUILDING", rows: [{ key: "floors", name: "Floors", type: "int", min: 2, max: 12 }] },
      { t: 7.4, dur: 4.2, label: "FOOTPRINT", rows: [
        { key: "baysX", name: "Bays X", type: "int", min: 1, max: 20 },
        { key: "baysY", name: "Bays Y", type: "int", min: 1, max: 20 }] },
      { t: 11.6, dur: 2.5, label: "ROOF", rows: [{ key: "dormers", name: "Dormers", type: "bool" }] },
      { t: 14.1, dur: 2.8, label: "BALCONIES", rows: [{ key: "balcony", name: "Balcony type", type: "menu", options: ["existing", "exterior"], labels: { existing: "Existing", exterior: "Exterior" } }] },
      { t: 16.9, dur: 3.5, label: "WALL DETAIL", rows: [{ key: "detailStyle", name: "Detail style", type: "menu", options: ["refends", "pilasters", "ornamented"], labels: { refends: "Refends", pilasters: "Pilasters", ornamented: "Ornamented panels" } }] },
      { t: 20.4, dur: 3.2, label: "WALL DETAIL", rows: [{ key: "detailPattern", name: "Detail pattern", type: "menu", options: ["off", "same", "alternate", "random"], labels: { off: "Off", same: "Same", alternate: "Alternate", random: "Random" } }] },
      { t: 23.6, dur: 3.2, label: "WALL DETAIL", rows: [{ key: "detailDepth", name: "Relief depth", type: "float", min: 0, max: 3 }] },
      { t: 26.8, dur: 2.3, label: "WALL DETAIL", rows: [{ key: "detailSeed", name: "Detail seed", type: "seed" }] },
      { t: 29.1, dur: 3.6, label: "INTERIORS", rows: [{ key: "closedChance", name: "Closed curtains", type: "pct" }] },
      { t: 32.7, dur: 7.0, label: "LIGHTING SET", rows: [
        { key: "mood", name: "Mood", type: "menu", options: ["Architectural", "Golden Hour", "Blue Hour"] },
        { key: "snow", name: "Snow", type: "bool" }] },
    ],
    events: [
      { t: 33.3, mood: "Golden Hour", fade: 1.3 },
      { t: 35.6, mood: "Blue Hour", fade: 1.3 },
      { t: 37.6, snow: true },
    ],
    cam: [
      // hook: building right of the title
      { t: 0, az: 26, el: 9, dist: 78, ty: 11, sx: -15, fov: 32 },
      { t: 3.4, az: 34, el: 11, dist: 70, ty: 11, sx: -12, fov: 32 },
      // S1 floors: low, craning up as it grows
      { t: 3.4, cut: true, az: 24, el: 3, fit: 1.22, ty: b => b.h * 0.5, fov: 34 },
      { t: 7.4, az: 36, el: 10, fit: 1.15, ty: b => b.h * 0.47, fov: 34 },
      // S2 footprint: from above
      { t: 7.4, cut: true, az: 40, el: 34, fit: 1.0, ty: b => b.h * 0.25, fov: 30 },
      { t: 11.6, az: 28, el: 30, fit: 0.98, ty: b => b.h * 0.25, fov: 30 },
      // S3 dormers: at the mansard
      { t: 11.6, cut: true, az: 12, el: 11, dist: 42, ty: b => b.h - 4, tz: b => b.l * 0.3, fov: 30 },
      { t: 14.1, az: 26, el: 9, dist: 38, ty: b => b.h - 4, tz: b => b.l * 0.3, fov: 30 },
      // S4 balconies: front ¾
      { t: 14.1, cut: true, az: -26, el: 6, dist: 34, tx: b => -b.w * 0.05, ty: b => b.h * 0.42, tz: front, fov: 32 },
      { t: 16.9, az: -18, el: 9, dist: 30, tx: b => -b.w * 0.05, ty: b => b.h * 0.42, tz: front, fov: 32 },
      // S5 style: close on the front facade
      { t: 16.9, cut: true, az: 10, el: 5, dist: 20, tx: b => b.w * 0.12, ty: 11, tz: front, fov: 32 },
      { t: 20.4, az: 20, el: 6, dist: 18, tx: b => b.w * 0.12, ty: 11.5, tz: front, fov: 32 },
      // S6 pattern: pull back to see every floor
      { t: 20.4, cut: true, az: -8, el: 4, dist: 44, tx: 0, ty: b => b.h * 0.45, tz: front, fov: 32 },
      { t: 23.6, az: 4, el: 6, dist: 40, tx: 0, ty: b => b.h * 0.45, tz: front, fov: 32 },
      // S7 relief: grazing along the front
      { t: 23.6, cut: true, az: 64, el: 4, dist: 22, tx: b => b.w * 0.18, ty: 10, tz: front, fov: 30 },
      { t: 26.8, az: 56, el: 7, dist: 20, tx: b => b.w * 0.18, ty: 11, tz: front, fov: 30 },
      // S8 seed: medium on the front
      { t: 26.8, cut: true, az: 18, el: 8, dist: 36, tx: 0, ty: b => b.h * 0.45, tz: front, fov: 32 },
      { t: 29.1, az: 26, el: 9, dist: 34, tx: 0, ty: b => b.h * 0.45, tz: front, fov: 32 },
      // S9 curtains: close on windows
      { t: 29.1, cut: true, az: -14, el: 3, dist: 17, tx: b => -b.w * 0.15, ty: 13.5, tz: front, fov: 30 },
      { t: 32.7, az: -6, el: 5, dist: 15.5, tx: b => -b.w * 0.15, ty: 14, tz: front, fov: 30 },
      // finale: slow arc
      { t: 32.7, cut: true, az: 18, el: 5, fit: 1.05, ty: b => b.h * 0.42, sx: -3, fov: 32 },
      { t: 39.9, az: 52, el: 8, fit: 1.0, ty: b => b.h * 0.42, sx: -3, fov: 32 },
      { t: 44, az: 64, el: 14, fit: 1.12, ty: b => b.h * 0.42, sx: -14, fov: 32 },
    ],
  };
})();

// =====================================================================================
// NEW YORK — NYC_CornerBuilding.blend's NYC_Building graph
// =====================================================================================

const nyc = (() => {
  const P = timeline();
  const D = {
    "Building Height": 0, "Floor Count": 8, "Building Width": 50.4, "Building Depth": 15.49, "Corner Angle": rad(90),
    "Facade Seed": 18372, "Module Seed": 12, "Window Seed": 91, "Shop Seed": 6, "Balcony Seed": 84, "AC Seed": 109, "Roof Seed": 0,
    "Shop Count": 5, "Awning Probability": 0.6, "Custom Sign Text": "HOTEL", "Custom Sign Size": 1,
    "Open Probability": 0.39, "Window Open Amount": 0.54, "AC Probability": 0.15, "Balcony Probability": 0.41,
    "Balcony Style": "Vertical Bars", "Fire Escape Side": "Random", "Water Tower Probability": 0.6, "HVAC Units": 4,
    "Clotheslines": 2, "Clothes Density": 0, "Window Light Probability": 0.5,
  };
  P.set(0, D);
  const V = [
    { "Floor Count": 6, "Building Width": 36, "Building Depth": 18, "Corner Angle": rad(90), "Facade Seed": 3, "Module Seed": 5, "Window Seed": 7, "Shop Seed": 2 },
    { "Floor Count": 12, "Building Width": 28, "Building Depth": 20, "Corner Angle": rad(72), "Facade Seed": 11, "Module Seed": 9, "Window Seed": 13, "Shop Seed": 8 },
    { "Floor Count": 9, "Building Width": 44, "Building Depth": 14, "Corner Angle": rad(110), "Facade Seed": 27, "Module Seed": 31, "Window Seed": 2, "Shop Seed": 4 },
    { "Floor Count": 5, "Building Width": 32, "Building Depth": 24, "Corner Angle": rad(90), "Facade Seed": 40, "Module Seed": 1, "Window Seed": 5, "Shop Seed": 12 },
    { "Floor Count": 14, "Building Width": 24, "Building Depth": 16, "Corner Angle": rad(80), "Facade Seed": 77, "Module Seed": 21, "Window Seed": 42, "Shop Seed": 3 },
    { "Floor Count": 7, "Building Width": 40, "Building Depth": 18, "Corner Angle": rad(100), "Facade Seed": 5, "Module Seed": 17, "Window Seed": 60, "Shop Seed": 9 },
  ];
  V.forEach((v, i) => P.set(0.6 + i * 0.42, v));
  P.set(3.12, { "Floor Count": 8, "Building Width": 50.4, "Building Depth": 15.49, "Corner Angle": rad(90), "Facade Seed": 18372, "Module Seed": 12, "Window Seed": 91, "Shop Seed": 6 });

  // S1 floors
  P.tween(3.9, 6.3, { "Floor Count": 16 }, "linear");
  P.tween(6.55, 7.0, { "Floor Count": 10 }, "linear");
  // S2 footprint
  P.tween(7.6, 8.9, { "Building Width": 22 });
  P.tween(7.9, 9.1, { "Building Depth": 26 });
  P.tween(9.4, 10.6, { "Building Width": 34, "Building Depth": 18 });
  // S3 corner angle
  P.tween(11.4, 12.7, { "Corner Angle": rad(58) });
  P.tween(12.9, 14.2, { "Corner Angle": rad(128) });
  P.tween(14.35, 14.9, { "Corner Angle": rad(90) });
  // S4 shops
  P.tween(15.3, 15.8, { "Shop Count": 1 }, "linear");
  P.tween(16.0, 17.2, { "Shop Count": 8 }, "linear");
  P.tween(17.3, 18.3, { "Awning Probability": 1 });
  // S5 custom sign
  P.type(18.9, "Custom Sign Text", "HOTEL", "BROADWAY", 0.07, 0.15);
  P.tween(21.2, 22.0, { "Custom Sign Size": 1.5 });
  // S6 windows
  P.tween(22.8, 24.0, { "Open Probability": 1 });
  P.tween(24.2, 25.4, { "Window Open Amount": 1 });
  P.tween(25.5, 25.9, { "Open Probability": 0.45, "Window Open Amount": 0.6 });
  // S7 AC units
  P.tween(26.4, 27.8, { "AC Probability": 1 });
  P.tween(28.2, 28.8, { "AC Probability": 0.35 });
  // S8 balconies
  P.tween(29.3, 30.3, { "Balcony Probability": 1 });
  P.seq(30.6, 0.65, "Balcony Style", ["Horizontal Bars", "Industrial", "Ornamental"]);
  // S9 fire escapes
  P.seq(33.0, 0.6, "Fire Escape Side", ["None", "Left", "Right", "Both"]);
  // S10 roof
  P.set(36.4, { "Water Tower Probability": 1 });
  P.tween(36.6, 37.8, { "HVAC Units": 10 }, "linear");
  P.tween(37.8, 38.6, { Clotheslines: 6 }, "linear");
  P.tween(38.6, 39.4, { "Clothes Density": 1 });
  // S11 night
  P.set(40.0, { "Window Light Probability": 0 });
  P.tween(41.0, 43.4, { "Window Light Probability": 1 }, "linear");
  ["Floor Count", "Shop Count", "HVAC Units", "Clotheslines"].forEach(k => P.opts(k, { int: true }));
  ["Building Width", "Building Depth"].forEach(k => P.opts(k, { every: 2 }));

  // the corner (Blender origin) is front-left: x = −w/2, z = +l/2
  const cx = b => -b.w / 2, front = b => b.l / 2;
  return {
    kind: "New York",
    duration: 48,
    theme: { accent: "#ff7a45", brandSub: "three.js · live" },
    title: { t0: 0.15, t1: 3.3, ink: true, kicker: "PROCEDURAL BUILDING · 02", big: "NEW YORK", sub: "The pre-war corner building", sub2: "3,500 geometry nodes · evaluated live" },
    outro: { t0: 44.3, t1: 48, fout: 0.6, kicker: "ONE GRAPH", big: "EVERY<br>BLOCK", sub: "Blender geometry nodes, running in three.js", sub2: "real-time · in the browser" },
    params: P.build(),
    segments: [
      { t: 3.45, dur: 3.75, label: "BUILDING", rows: [{ key: "Floor Count", name: "Floor count", type: "int", min: 2, max: 20 }] },
      { t: 7.2, dur: 3.9, label: "FOOTPRINT", rows: [
        { key: "Building Width", name: "Width", type: "m", min: 6, max: 80 },
        { key: "Building Depth", name: "Depth", type: "m", min: 6, max: 80 }] },
      { t: 11.1, dur: 3.9, label: "FOOTPRINT", rows: [{ key: "Corner Angle", name: "Corner angle", type: "deg", min: rad(45), max: rad(150) }] },
      { t: 15.0, dur: 3.6, label: "SHOPS", rows: [
        { key: "Shop Count", name: "Shop count", type: "int", min: 1, max: 8 },
        { key: "Awning Probability", name: "Awnings", type: "pct" }] },
      { t: 18.6, dur: 3.8, label: "SIGNS", rows: [
        { key: "Custom Sign Text", name: "Custom sign", type: "text" },
        { key: "Custom Sign Size", name: "Sign size", type: "float", min: 0.3, max: 3 }] },
      { t: 22.4, dur: 3.6, label: "WINDOWS", rows: [
        { key: "Open Probability", name: "Open windows", type: "pct" },
        { key: "Window Open Amount", name: "Open amount", type: "pct" }] },
      { t: 26.0, dur: 3.0, label: "FACADE MODULES", rows: [{ key: "AC Probability", name: "AC units", type: "pct" }] },
      { t: 29.0, dur: 3.6, label: "BALCONIES", rows: [
        { key: "Balcony Probability", name: "Balconies", type: "pct" },
        { key: "Balcony Style", name: "Style", type: "menu", options: ["Vertical Bars", "Horizontal Bars", "Industrial", "Ornamental"] }] },
      { t: 32.6, dur: 3.4, label: "FIRE ESCAPES", rows: [{ key: "Fire Escape Side", name: "Side", type: "menu", options: ["Random", "None", "Left", "Right", "Both"] }] },
      { t: 36.0, dur: 3.6, label: "ROOF", rows: [
        { key: "HVAC Units", name: "HVAC units", type: "int", min: 0, max: 10 },
        { key: "Clotheslines", name: "Clotheslines", type: "int", min: 0, max: 6 },
        { key: "Clothes Density", name: "Laundry", type: "pct" }] },
      { t: 39.6, dur: 4.6, label: "LIGHTING", rows: [
        { key: "mood", name: "Mood", type: "menu", options: ["Architectural", "Blue Hour"] },
        { key: "Window Light Probability", name: "Lit windows", type: "pct" }] },
    ],
    events: [{ t: 39.9, mood: "Blue Hour", fade: 1.4 }],
    cam: [
      // hook
      { t: 0, az: -30, el: 10, dist: 118, ty: 14, sx: -22, fov: 32 },
      { t: 3.4, az: -40, el: 12, dist: 108, ty: 14, sx: -19, fov: 32 },
      // S1 floors: corner, low, craning
      { t: 3.4, cut: true, az: -42, el: 3, fit: 1.2, ty: b => b.h * 0.5, fov: 34 },
      { t: 7.2, az: -30, el: 11, fit: 1.12, ty: b => b.h * 0.47, fov: 34 },
      // S2 footprint: aerial
      { t: 7.2, cut: true, az: -38, el: 38, fit: 1.0, ty: b => b.h * 0.25, fov: 30 },
      { t: 11.1, az: -26, el: 42, fit: 1.0, ty: b => b.h * 0.25, fov: 30 },
      // S3 corner angle: above the corner
      { t: 11.1, cut: true, az: -24, el: 66, fit: 0.95, ty: b => b.h * 0.3, fov: 30 },
      { t: 15.0, az: -4, el: 72, fit: 0.95, ty: b => b.h * 0.3, fov: 30 },
      // S4 shops: street level on the storefronts
      { t: 15.0, cut: true, az: 14, el: 2, dist: 36, tx: b => -b.w * 0.05, ty: 4.5, tz: front, fov: 34 },
      { t: 18.6, az: 24, el: 4, dist: 32, tx: b => -b.w * 0.05, ty: 5, tz: front, fov: 34 },
      // S5 sign: at the corner
      { t: 18.6, cut: true, az: -34, el: 4, dist: 22, tx: b => cx(b) + 2, ty: 10, tz: b => front(b), fov: 32 },
      { t: 22.4, az: -26, el: 7, dist: 19, tx: b => cx(b) + 2, ty: 10, tz: b => front(b), fov: 32 },
      // S6 windows: close on the front
      { t: 22.4, cut: true, az: 20, el: 6, dist: 20, tx: 2, ty: 13, tz: front, fov: 32 },
      { t: 26.0, az: 12, el: 8, dist: 18, tx: 2, ty: 13.5, tz: front, fov: 32 },
      // S7 AC: grazing along the front
      { t: 26.0, cut: true, az: 50, el: 6, dist: 30, tx: 0, ty: b => b.h * 0.45, tz: front, fov: 32 },
      { t: 29.0, az: 42, el: 9, dist: 28, tx: 0, ty: b => b.h * 0.45, tz: front, fov: 32 },
      // S8 balconies: close
      { t: 29.0, cut: true, az: -12, el: 5, dist: 22, tx: -2, ty: 14, tz: front, fov: 32 },
      { t: 32.6, az: -4, el: 8, dist: 20, tx: -2, ty: 14.5, tz: front, fov: 32 },
      // S9 fire escapes: the whole front
      { t: 32.6, cut: true, az: 6, el: 5, fit: 1.0, ty: b => b.h * 0.46, fov: 32 },
      { t: 36.0, az: 16, el: 8, fit: 0.96, ty: b => b.h * 0.46, fov: 32 },
      // S10 roof: high
      { t: 36.0, cut: true, az: -30, el: 42, dist: 46, ty: b => b.h, fov: 32 },
      { t: 39.6, az: -10, el: 38, dist: 42, ty: b => b.h, fov: 32 },
      // S11 night + outro: slow arc from the corner
      { t: 39.6, cut: true, az: -48, el: 5, fit: 0.98, ty: b => b.h * 0.45, sx: -2, fov: 34 },
      { t: 44.3, az: -24, el: 8, fit: 0.95, ty: b => b.h * 0.45, sx: -2, fov: 34 },
      { t: 48, az: -14, el: 12, fit: 1.1, ty: b => b.h * 0.45, sx: -14, fov: 34 },
    ],
  };
})();

// =====================================================================================
// 中国 — CN_ApartmentBuilding.blend's CN_Building graph
// =====================================================================================

const cn = (() => {
  const P = timeline();
  const D = {
    Floors: 6, Width: 18, Depth: 13, Seed: 3, "Shop Seed": 4, "Facade Finish": "Stucco", "Wall Tint": [1, 1, 1, 1],
    "Balcony Probability": 0.35, "Enclosed Balcony Probability": 0.45, "AC Unit Probability": 0.5, "Laundry Probability": 0.35,
    "Plant Probability": 0.3, "Lantern Probability": 0.35, "Awning Probability": 0.35, "Blade Sign Probability": 0.3,
    "Sign Text": "幸福公寓", "Corner Radius": 3, "Street Trees": true, "Detail Level": "LOD0", "Lit Window Probability": 0.2,
  };
  P.set(0, D);
  const V = [
    { Floors: 8, Width: 22, Depth: 14, Seed: 11, "Shop Seed": 7, "Facade Finish": "Ceramic Tile", "Wall Tint": lin("#f3d9cf") },
    { Floors: 5, Width: 26, Depth: 16, Seed: 5, "Shop Seed": 1, "Facade Finish": "Stucco", "Wall Tint": lin("#dfe9dc") },
    { Floors: 9, Width: 16, Depth: 14, Seed: 21, "Shop Seed": 9, "Facade Finish": "Ceramic Tile", "Wall Tint": [1, 1, 1, 1] },
    { Floors: 7, Width: 20, Depth: 18, Seed: 8, "Shop Seed": 3, "Facade Finish": "Stucco", "Wall Tint": lin("#f4e6b8") },
    { Floors: 9, Width: 24, Depth: 12, Seed: 2, "Shop Seed": 5, "Facade Finish": "Ceramic Tile", "Wall Tint": lin("#d6e4f0") },
    { Floors: 6, Width: 18, Depth: 15, Seed: 14, "Shop Seed": 11, "Facade Finish": "Stucco", "Wall Tint": lin("#efd3c4") },
  ];
  V.forEach((v, i) => P.set(0.6 + i * 0.42, v));
  P.set(3.12, { Floors: 6, Width: 18, Depth: 13, Seed: 3, "Shop Seed": 4, "Facade Finish": "Stucco", "Wall Tint": [1, 1, 1, 1] });

  // S1 floors
  P.tween(3.9, 6.3, { Floors: 14 }, "linear");
  P.tween(6.55, 7.0, { Floors: 9 }, "linear");
  // S2 footprint
  P.tween(7.6, 8.9, { Width: 34 });
  P.tween(7.9, 9.1, { Depth: 22 });
  P.tween(9.4, 10.6, { Width: 22, Depth: 16 });
  // S3 facade finish + tint
  P.set(11.4, { "Facade Finish": "Ceramic Tile" });
  P.seq(12.1, 0.62, "Wall Tint", ["#f2c9c0", "#cfe6d6", "#f6e3a8", "#c9dcf0", "#f3ddd0"].map(lin));
  // S4 balconies
  P.tween(15.4, 16.5, { "Balcony Probability": 1 });
  P.tween(16.7, 17.3, { "Enclosed Balcony Probability": 0 });
  P.tween(17.5, 18.2, { "Enclosed Balcony Probability": 1 });
  // S5 residents' additions
  P.tween(18.8, 19.6, { "AC Unit Probability": 1 });
  P.tween(19.8, 20.6, { "Laundry Probability": 1 });
  P.tween(20.8, 21.6, { "Plant Probability": 1 });
  // S6 shops
  P.tween(22.8, 23.6, { "Lantern Probability": 1 });
  P.tween(23.8, 24.6, { "Awning Probability": 1 });
  P.tween(24.8, 25.6, { "Blade Sign Probability": 1 });
  // S7 rooftop sign
  P.type(26.4, "Sign Text", "幸福公寓", "欢迎光临", 0.1, 0.32);
  // S8 street
  P.tween(30.4, 31.3, { "Corner Radius": 6 });
  P.set(31.6, { "Street Trees": false });
  P.set(32.3, { "Street Trees": true });
  P.tween(32.5, 33.2, { "Corner Radius": 3 });
  // S9 detail level: the same graph's LODs and collision boxes
  P.seq(34.0, 0.62, "Detail Level", ["LOD1", "LOD2", "Collision", "LOD0"]);
  // S10 night
  P.tween(38.6, 40.6, { "Lit Window Probability": 1 }, "linear");
  ["Floors"].forEach(k => P.opts(k, { int: true }));
  ["Width", "Depth", "AC Unit Probability", "Laundry Probability", "Plant Probability", "Balcony Probability", "Enclosed Balcony Probability",
    "Lantern Probability", "Awning Probability", "Blade Sign Probability", "Corner Radius", "Lit Window Probability"]
    .forEach(k => P.opts(k, { every: 3 }));

  const cx = b => -b.w / 2, front = b => b.l / 2;
  return {
    kind: "Chinese",
    duration: 46,
    theme: { accent: "#ff4d4d", brandSub: "three.js · live" },
    title: { t0: 0.15, t1: 3.3, ink: true, kicker: "PROCEDURAL BUILDING · 03", big: "中国", sub: "The corner apartment building", sub2: "3,100 geometry nodes · evaluated live" },
    outro: { t0: 42.2, t1: 46, fout: 0.6, kicker: "ONE GRAPH", big: "万家灯火", sub: "Every window, every balcony: a parameter", sub2: "Blender geometry nodes · three.js · real-time" },
    params: P.build(),
    segments: [
      { t: 3.45, dur: 3.75, label: "BUILDING", rows: [{ key: "Floors", name: "Floors", type: "int", min: 2, max: 16 }] },
      { t: 7.2, dur: 3.8, label: "FOOTPRINT", rows: [
        { key: "Width", name: "Width", type: "m", min: 8, max: 60 },
        { key: "Depth", name: "Depth", type: "m", min: 8, max: 60 }] },
      { t: 11.0, dur: 4.0, label: "FACADE", rows: [
        { key: "Facade Finish", name: "Finish", type: "menu", options: ["Stucco", "Ceramic Tile"] },
        { key: "Wall Tint", name: "Wall tint", type: "color" }] },
      { t: 15.0, dur: 3.4, label: "RESIDENTS' ADDITIONS", rows: [
        { key: "Balcony Probability", name: "Balconies", type: "pct" },
        { key: "Enclosed Balcony Probability", name: "Enclosed", type: "pct" }] },
      { t: 18.4, dur: 3.9, label: "RESIDENTS' ADDITIONS", rows: [
        { key: "AC Unit Probability", name: "AC units", type: "pct" },
        { key: "Laundry Probability", name: "Laundry", type: "pct" },
        { key: "Plant Probability", name: "Plants", type: "pct" }] },
      { t: 22.3, dur: 3.7, label: "SHOPS", rows: [
        { key: "Lantern Probability", name: "Lanterns", type: "pct" },
        { key: "Awning Probability", name: "Awnings", type: "pct" },
        { key: "Blade Sign Probability", name: "Blade signs", type: "pct" }] },
      { t: 26.0, dur: 4.0, label: "ROOFTOP SIGN", rows: [{ key: "Sign Text", name: "Sign text", type: "text" }] },
      { t: 30.0, dur: 3.6, label: "STREET", rows: [
        { key: "Corner Radius", name: "Corner radius", type: "m", min: 1.5, max: 6 },
        { key: "Street Trees", name: "Street trees", type: "bool" }] },
      { t: 33.6, dur: 3.0, label: "EXPORT", rows: [{ key: "Detail Level", name: "Detail level", type: "menu", options: ["LOD0", "LOD1", "LOD2", "Collision"] }] },
      { t: 36.6, dur: 5.6, label: "LIGHTING", rows: [
        { key: "mood", name: "Mood", type: "menu", options: ["Architectural", "Blue Hour"] },
        { key: "Lit Window Probability", name: "Lit windows", type: "pct" },
        { key: "rain", name: "Rain", type: "bool" }] },
    ],
    events: [
      { t: 37.0, mood: "Blue Hour", fade: 1.4 },
      { t: 41.0, rain: true },
    ],
    cam: [
      // hook
      { t: 0, az: -30, el: 10, dist: 92, ty: 14, sx: -17, fov: 32 },
      { t: 3.4, az: -40, el: 12, dist: 84, ty: 14, sx: -14, fov: 32 },
      // S1 floors
      { t: 3.4, cut: true, az: -44, el: 3, fit: 1.22, ty: b => b.h * 0.5, fov: 34 },
      { t: 7.2, az: -32, el: 11, fit: 1.15, ty: b => b.h * 0.47, fov: 34 },
      // S2 footprint
      { t: 7.2, cut: true, az: -38, el: 38, fit: 1.0, ty: b => b.h * 0.25, fov: 30 },
      { t: 11.0, az: -26, el: 42, fit: 1.0, ty: b => b.h * 0.25, fov: 30 },
      // S3 facade: ¾ on the corner
      { t: 11.0, cut: true, az: -40, el: 6, fit: 1.0, ty: b => b.h * 0.47, fov: 32 },
      { t: 15.0, az: -30, el: 8, fit: 0.96, ty: b => b.h * 0.47, fov: 32 },
      // S4 balconies: the front
      { t: 15.0, cut: true, az: 14, el: 6, dist: 34, ty: b => b.h * 0.5, tz: front, fov: 32 },
      { t: 18.4, az: 22, el: 8, dist: 31, ty: b => b.h * 0.5, tz: front, fov: 32 },
      // S5 additions: closer on the front
      { t: 18.4, cut: true, az: -18, el: 4, dist: 26, tx: 0, ty: 12, tz: front, fov: 32 },
      { t: 22.3, az: -8, el: 7, dist: 23, tx: 0, ty: 12, tz: front, fov: 32 },
      // S6 shops: street level at the corner
      { t: 22.3, cut: true, az: -52, el: 2, dist: 22, tx: b => cx(b) + 2, ty: 3.5, tz: b => front(b) - 2, fov: 36 },
      { t: 26.0, az: -38, el: 3, dist: 19, tx: b => cx(b) + 2, ty: 3.8, tz: b => front(b) - 2, fov: 36 },
      // S7 rooftop sign
      { t: 26.0, cut: true, az: -22, el: 7, dist: 24, tx: 0, ty: b => b.h - 2.4, tz: front, fov: 32 },
      { t: 30.0, az: -8, el: 9, dist: 20, tx: 0, ty: b => b.h - 2.4, tz: front, fov: 32 },
      // S8 street corner from above
      { t: 30.0, cut: true, az: -45, el: 48, dist: 38, tx: cx, ty: 0, tz: front, fov: 32 },
      { t: 33.6, az: -35, el: 44, dist: 35, tx: cx, ty: 0, tz: front, fov: 32 },
      // S9 detail level: the whole building
      { t: 33.6, cut: true, az: -26, el: 9, fit: 1.0, ty: b => b.h * 0.46, fov: 32 },
      { t: 36.6, az: -38, el: 7, fit: 0.96, ty: b => b.h * 0.46, fov: 32 },
      // S10 night + outro: arc from the corner
      { t: 36.6, cut: true, az: -56, el: 4, fit: 1.0, ty: b => b.h * 0.46, sx: -2, fov: 34 },
      { t: 42.2, az: -30, el: 8, fit: 0.95, ty: b => b.h * 0.46, sx: -2, fov: 34 },
      { t: 46, az: -20, el: 12, fit: 1.1, ty: b => b.h * 0.46, sx: -12, fov: 34 },
    ],
  };
})();

// =====================================================================================
// SPLIT — the 3-second hook: three portrait panels side by side (split.mjs
// composites them and draws the graphics). Every change reads at whole-building
// scale: height, footprint, colour, then the lights come on together.
// =====================================================================================

const SPLIT_T = 3;
const LIGHTS = 1.95; // all three go to blue hour
const FADE = 0.1;
// the city reflections follow the crossfade (the app re-captures them only once a fade has settled)
const recapture = [...Array(Math.ceil((FADE + 0.05) * 60))].map((_, i) => ({ t: LIGHTS + i / 60, js: "window.__three.studio.captureEnvironment()" }));
const panel = (kind, P, cam, extra = {}) => ({
  kind, duration: SPLIT_T, size: [640, 1080], scale: 2, overlay: false, crf: 10, boundsLag: 0.22,
  params: P.build(), segments: [], cam, events: [{ t: LIGHTS, mood: "Blue Hour", fade: FADE }, ...recapture], ...extra,
});

const splitFr = (() => {
  const P = timeline();
  P.set(0, { baysX: 5, baysY: 3, floors: 2, dormers: true, balcony: "exterior", detailPattern: "same", detailStyle: "refends", detailSeed: 0, detailDepth: 1.2 });
  P.tween(0.02, 0.74, { floors: 10 }, "linear");
  P.tween(0.8, 1.4, { baysX: 7, baysY: 6 }, "linear");
  P.seq(1.48, 0.16, "detailStyle", ["ornamented", "pilasters", "ornamented"]);
  ["floors", "baysX", "baysY"].forEach(k => P.opts(k, { int: true }));
  return panel("French", P, [
    { t: 0, az: 22, el: 5, fit: 1.3, ty: b => b.h * 0.47, fov: 34 },
    { t: SPLIT_T, az: 36, el: 9, fit: 1.18, ty: b => b.h * 0.47, fov: 34 },
  ]);
})();

const splitNy = (() => {
  const P = timeline();
  P.set(0, { "Building Height": 0, "Floor Count": 6, "Building Width": 26, "Building Depth": 18, "Corner Angle": rad(90), "AC Probability": 0.15, "Window Light Probability": 0 });
  P.tween(0.02, 0.74, { "Floor Count": 16 }, "linear");
  P.tween(0.8, 1.4, { "Corner Angle": rad(62) });
  P.tween(1.43, 1.9, { "AC Probability": 1 });
  P.tween(2.0, 2.55, { "Window Light Probability": 1 }, "linear");
  P.opts("Floor Count", { int: true });
  return panel("New York", P, [
    { t: 0, az: -30, el: 5, fit: 1.24, ty: b => b.h * 0.47, fov: 34 },
    { t: SPLIT_T, az: -44, el: 9, fit: 1.1, ty: b => b.h * 0.47, fov: 34 },
  ]);
})();

const splitCn = (() => {
  const P = timeline();
  P.set(0, { Floors: 5, Width: 18, Depth: 13, "Facade Finish": "Stucco", "Wall Tint": [1, 1, 1, 1], "Balcony Probability": 0.35, "Lit Window Probability": 0 });
  P.tween(0.02, 0.74, { Floors: 13 }, "linear");
  P.set(0.8, { "Facade Finish": "Ceramic Tile", "Wall Tint": lin("#f2c9c0") });
  P.set(1.03, { "Wall Tint": lin("#cfe6d6") });
  P.set(1.26, { "Wall Tint": lin("#f6e3a8") });
  P.set(1.45, { "Wall Tint": lin("#f3d6cc") });
  P.tween(1.48, 1.9, { "Balcony Probability": 1 });
  P.tween(2.0, 2.55, { "Lit Window Probability": 1 }, "linear");
  P.opts("Floors", { int: true });
  ["Balcony Probability", "Lit Window Probability"].forEach(k => P.opts(k, { every: 3 }));
  return panel("Chinese", P, [
    { t: 0, az: -32, el: 5, fit: 1.3, ty: b => b.h * 0.47, fov: 34 },
    { t: SPLIT_T, az: -46, el: 9, fit: 1.18, ty: b => b.h * 0.47, fov: 34 },
  ]);
})();

/** the compositor's layout: panels left to right, and what each panel's chip shows when */
export const SPLIT = {
  duration: SPLIT_T,
  panels: [
    { story: "split_fr", city: "PARIS", accent: "#e2c08d", chips: [
      { t: 0, key: "floors", name: "Floors", type: "int", min: 2, max: 12 },
      { t: 0.78, name: "Bays", text: v => `${v.baysX} × ${v.baysY}`, frac: v => (v.baysX + v.baysY - 2) / 38, keys: ["baysX", "baysY"] },
      { t: 1.45, key: "detailStyle", name: "Detail style", type: "menu", options: ["refends", "pilasters", "ornamented"], labels: { refends: "Refends", pilasters: "Pilasters", ornamented: "Ornamented" } },
      { t: LIGHTS, name: "Mood", text: () => "Blue Hour" }] },
    { story: "split_ny", city: "NEW YORK", accent: "#ff7a45", chips: [
      { t: 0, key: "Floor Count", name: "Floors", type: "int", min: 2, max: 20 },
      { t: 0.78, key: "Corner Angle", name: "Corner angle", type: "deg", min: rad(45), max: rad(150) },
      { t: 1.43, key: "AC Probability", name: "AC units", type: "pct" },
      { t: LIGHTS, key: "Window Light Probability", name: "Lit windows", type: "pct" }] },
    { story: "split_cn", city: "中国", accent: "#ff4d4d", chips: [
      { t: 0, key: "Floors", name: "Floors", type: "int", min: 2, max: 16 },
      { t: 0.78, key: "Wall Tint", name: "Wall tint", type: "color" },
      { t: 1.48, key: "Balcony Probability", name: "Balconies", type: "pct" },
      { t: LIGHTS, key: "Lit Window Probability", name: "Lit windows", type: "pct" }] },
  ],
};

export const STORIES = { french, nyc, cn, split_fr: splitFr, split_ny: splitNy, split_cn: splitCn };
