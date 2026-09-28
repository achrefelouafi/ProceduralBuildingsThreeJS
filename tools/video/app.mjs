/**
 * Headless app harness for the video recorder: a production build served
 * straight from disk (request interception, no dev server that could reload
 * mid-recording) and a virtual clock. After `virtualTime()`, the page's
 * requestAnimationFrame only fires from `advance()`, one fixed step at a time,
 * so a frame that takes seconds to evaluate (a graph rebuild) still lasts
 * exactly 1/60 s in the video.
 */
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ORIGIN = "http://app.local";
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".bin": "application/octet-stream", ".glb": "model/gltf-binary",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".hdr": "application/octet-stream", ".ico": "image/x-icon",
};

/** replaces requestAnimationFrame before any page script runs */
function clockShim() {
  const realRAF = window.requestAnimationFrame.bind(window);
  let virtual = false, now = 0, queue = [];
  window.requestAnimationFrame = cb => {
    if (!virtual) return realRAF(t => { now = t; cb(t); });
    queue.push(cb);
    return queue.length;
  };
  window.__clock = {
    virtual() { virtual = true; },
    pending: () => queue.length,
    /** one frame: `ms` of virtual time, every queued callback once */
    advance(ms) {
      now += ms;
      const q = queue;
      queue = [];
      for (const cb of q) cb(now);
    },
  };
}

export async function openApp({ dist, width = 1920, height = 1080, scale = 1, log = true }) {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    protocolTimeout: 600000,
    args: [
      "--use-angle=default", `--window-size=${width},${height}`, "--hide-scrollbars",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--force-color-profile=srgb",
    ],
    defaultViewport: { width, height, deviceScaleFactor: scale },
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", async req => {
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return req.abort();
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(dist, path));
    try {
      const body = await readFile(file);
      req.respond({ status: 200, contentType: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", body });
    } catch {
      req.respond({ status: 404, body: "" });
    }
  });
  if (log) {
    page.on("console", m => { const t = m.text(); if (!/DevTools|Download the/.test(t)) console.log("[page]", t.slice(0, 400)); });
    page.on("pageerror", e => console.log("[pageerror]", e.message));
  }
  await page.evaluateOnNewDocument(clockShim);
  await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
  await page.waitForFunction("window.__ready === true", { timeout: 300000, polling: 250 });
  return { browser, page };
}

/** switch to the virtual clock (after the pending real frame has run) */
export async function virtualTime(page) {
  await page.evaluate(() => window.__clock.virtual());
  await page.waitForFunction("window.__clock.pending() > 0", { polling: 16 });
}
