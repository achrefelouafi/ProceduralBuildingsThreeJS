/**
 * The video's on-screen graphics, drawn as HTML over the canvas (captured with
 * it by the page screenshot): a brand pill, the intro / outro titles, the
 * parameter card (name, live value, slider / chips / toggle / swatch / text)
 * and a progress line. Everything is posed per frame from the recorder
 * (`window.__ov(state)`), never by CSS transitions: those run on wall-clock
 * time, the video on the virtual clock.
 */

/** runs in the page */
export function installOverlay(theme) {
  const css = `
  .lil-gui, #busy, #preloader { display: none !important; }
  #ov { position: fixed; inset: 0; pointer-events: none; z-index: 50; font-family: Bahnschrift, "Microsoft YaHei", "Segoe UI", sans-serif;
        color: #fff; -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
  #ov * { box-sizing: border-box; }
  .ov-brand { position: absolute; left: 64px; top: 56px; display: flex; align-items: center; gap: 14px; padding: 12px 20px 12px 16px;
        border-radius: 999px; background: rgba(14,16,20,.58); backdrop-filter: blur(14px) saturate(140%);
        border: 1px solid rgba(255,255,255,.10); }
  .ov-brand .mk { width: 26px; height: 26px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; align-items: end; }
  .ov-brand .mk i { background: #fff; border-radius: 1px; }
  .ov-brand .mk i:nth-child(1) { height: 50%; } .ov-brand .mk i:nth-child(2) { height: 100%; background: var(--acc); } .ov-brand .mk i:nth-child(3) { height: 72%; }
  .ov-brand b { font-size: 19px; letter-spacing: .22em; font-weight: 600; }
  .ov-brand span { font-size: 15px; letter-spacing: .06em; opacity: .62; margin-left: 4px; }

  .ov-title { position: absolute; left: 96px; top: 50%; transform: translateY(-50%); }
  .ov-title .k { font-size: 24px; letter-spacing: .32em; font-weight: 600; color: var(--acc); margin-bottom: 18px; }
  .ov-title .t { font-size: 168px; line-height: .9; font-weight: 700; font-stretch: 80%; letter-spacing: .01em; }
  .ov-title .s { font-size: 34px; margin-top: 26px; font-weight: 400; letter-spacing: .02em; }
  .ov-title .s2 { font-size: 22px; margin-top: 12px; letter-spacing: .14em; opacity: .7; text-transform: uppercase; }
  .ov-title.ink { color: #121417; }
  .ov-title.ink .s2 { opacity: .6; }
  .ov-title.ink .k { color: color-mix(in srgb, var(--acc) 62%, #000); }
  .ov-title.paper { text-shadow: 0 2px 30px rgba(0,0,0,.35); }

  .ov-card { position: absolute; left: 64px; bottom: 64px; width: 600px; padding: 24px 30px 28px; border-radius: 22px;
        background: rgba(14,16,20,.62); backdrop-filter: blur(18px) saturate(150%); border: 1px solid rgba(255,255,255,.10);
        box-shadow: 0 18px 60px rgba(0,0,0,.25); }
  .ov-card .hd { display: flex; align-items: center; gap: 12px; font-size: 17px; letter-spacing: .24em; font-weight: 600; opacity: .9; }
  .ov-card .hd .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--acc); box-shadow: 0 0 14px var(--acc); }
  .ov-card .hd .n { margin-left: auto; opacity: .55; letter-spacing: .12em; }
  .ov-row { margin-top: 20px; }
  .ov-row .top { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; }
  .ov-row .nm { font-size: 36px; font-weight: 600; letter-spacing: .005em; white-space: nowrap; }
  .ov-row .v { font-size: 44px; font-weight: 700; color: var(--acc); white-space: nowrap; transform-origin: right center; }
  .ov-row .v.mn { font-size: 32px; }
  .ov-row .v small { font-size: 26px; opacity: .8; margin-left: 2px; }
  .trk { position: relative; height: 6px; margin-top: 14px; border-radius: 3px; background: rgba(255,255,255,.16); }
  .trk .f { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--acc); }
  .trk .kn { position: absolute; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: #fff;
        box-shadow: 0 2px 10px rgba(0,0,0,.35), 0 0 0 5px rgba(255,255,255,.14); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .chip { font-size: 19px; padding: 7px 14px; border-radius: 999px; background: rgba(255,255,255,.08); color: rgba(255,255,255,.62);
        border: 1px solid rgba(255,255,255,.08); letter-spacing: .02em; }
  .chip.on { background: var(--acc); color: #111; border-color: transparent; font-weight: 600; }
  .tg { position: relative; width: 74px; height: 40px; border-radius: 20px; background: rgba(255,255,255,.18); flex: none; }
  .tg i { position: absolute; top: 4px; left: 4px; width: 32px; height: 32px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .sw { display: inline-block; width: 40px; height: 40px; border-radius: 10px; vertical-align: -6px; margin-right: 12px;
        border: 2px solid rgba(255,255,255,.7); }
  .txt { font-family: Bahnschrift, "Microsoft YaHei", sans-serif; }
  .caret { display: inline-block; width: 4px; height: 38px; margin-left: 4px; background: #fff; vertical-align: -4px; }

  .ov-prog { position: absolute; left: 0; bottom: 0; height: 5px; background: var(--acc); }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.id = "ov";
  root.style.setProperty("--acc", theme.accent);
  root.innerHTML = `
    <div class="ov-brand"><div class="mk"><i></i><i></i><i></i></div><b>PROCEDURAL BUILDINGS</b><span>${theme.brandSub ?? ""}</span></div>
    <div class="ov-title" id="ov-title"></div>
    <div class="ov-title" id="ov-outro"></div>
    <div class="ov-card" id="ov-card"></div>
    <div class="ov-prog" id="ov-prog"></div>`;
  document.body.appendChild(root);

  const $ = id => document.getElementById(id);
  const brand = root.querySelector(".ov-brand");
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cache = {};
  const html = (el, key, h) => { if (cache[key] !== h) { el.innerHTML = h; cache[key] = h; } };

  function title(el, key, s) {
    if (!s || s.opacity <= 0.001) { el.style.opacity = "0"; return; }
    el.className = `ov-title ${s.ink ? "ink" : "paper"}`;
    html(el, key, `<div class="k">${esc(s.kicker ?? "")}</div><div class="t">${s.big}</div>` +
      (s.sub ? `<div class="s">${esc(s.sub)}</div>` : "") + (s.sub2 ? `<div class="s2">${esc(s.sub2)}</div>` : ""));
    el.style.opacity = String(s.opacity);
    el.style.transform = `translateY(calc(-50% + ${s.dy ?? 0}px))`;
    const t = el.querySelector(".t");
    if (t) t.style.letterSpacing = `${s.spacing ?? 0.01}em`;
  }

  function row(r) {
    const pop = 1 + 0.12 * (r.pop ?? 0);
    const v = `<div class="v${r.type === "menu" ? " mn" : ""}" style="transform:scale(${pop.toFixed(3)})">`;
    let top = `<div class="top"><div class="nm">${esc(r.name)}</div>`;
    let below = "";
    if (r.type === "menu") {
      top += `${v}${esc(r.text)}</div></div>`;
      below = `<div class="chips">${r.options.map(o => `<span class="chip${o === r.text ? " on" : ""}">${esc(o)}</span>`).join("")}</div>`;
    } else if (r.type === "bool") {
      const x = r.knob ?? (r.on ? 1 : 0);
      top += `<div class="tg" style="background:${r.on ? "var(--acc)" : "rgba(255,255,255,.18)"}"><i style="transform:translateX(${(x * 34).toFixed(1)}px)"></i></div></div>`;
    } else if (r.type === "color") {
      top += `${v}<span class="sw" style="background:${r.css}"></span>${esc(r.text)}</div></div>`;
    } else if (r.type === "text") {
      top += `</div>`;
      below = `<div class="v txt" style="margin-top:10px;text-align:left">“${esc(r.text)}<span class="caret" style="opacity:${r.caret ?? 1}"></span>”</div>`;
    } else {
      top += `${v}${esc(r.text)}${r.unit ? `<small>${esc(r.unit)}</small>` : ""}</div></div>`;
      if (r.frac !== undefined) {
        const p = (Math.min(Math.max(r.frac, 0), 1) * 100).toFixed(2);
        below = `<div class="trk"><div class="f" style="width:${p}%"></div><div class="kn" style="left:${p}%"></div></div>`;
      }
    }
    return `<div class="ov-row">${top}${below}</div>`;
  }

  window.__ov = s => {
    brand.style.opacity = String(s.brand ?? 1);
    title($("ov-title"), "title", s.title);
    title($("ov-outro"), "outro", s.outro);
    const card = $("ov-card");
    if (!s.card || s.card.opacity <= 0.001) card.style.opacity = "0";
    else {
      const c = s.card;
      card.style.opacity = String(c.opacity);
      card.style.transform = `translateY(${(c.dy ?? 0).toFixed(1)}px)`;
      html(card, "card", `<div class="hd"><span class="dot"></span>${esc(c.label)}<span class="n">${esc(c.counter ?? "")}</span></div>` +
        c.rows.map(row).join(""));
    }
    $("ov-prog").style.width = `${(s.progress * 100).toFixed(3)}%`;
  };
}
