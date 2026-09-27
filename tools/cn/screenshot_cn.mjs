/**
 * Headless screenshots of the Chinese apartment building.
 * Usage: node tools/cn/screenshot_cn.mjs <url> <outDir> [shot | cam=px,py,pz,tx,ty,tz] [mood] [json params]
 */
import puppeteer from "puppeteer-core";

const [, , url = "http://localhost:5173", outDir = ".", shot = "Hero ¾", mood = "", params = ""] = process.argv;
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=default", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
page.on("console", m => { const t = m.text(); if (!/DevTools|Download the/.test(t)) console.log("[page]", t.slice(0, 1500)); });
page.on("pageerror", e => console.log("[pageerror]", e.message));
page.on("response", r => { if (r.status() >= 400) console.log("[http]", r.status(), r.url()); });
await page.goto(url, { waitUntil: "networkidle0" });
await page.waitForFunction("window.__ready === true", { timeout: 60000 });
await page.evaluate(() => window.__orbit(false));
await page.evaluate(() => window.__building("Chinese"));
await new Promise(r => setTimeout(r, 500));
if (params) await page.evaluate(p => window.__setNyc(JSON.parse(p)), params);
if (mood) await page.evaluate(m => window.__mood(m), mood);
if (shot.startsWith("cam=")) {
  const c = shot.slice(4).split(",").map(Number);
  await page.evaluate(c => window.__setCamera(...c), c);
} else {
  await page.evaluate(s => window.__shot(s), shot);
}
await new Promise(r => setTimeout(r, 2500));
const slug = t => t.replace(/[^a-z0-9]+/gi, "-");
const name = `${outDir}/cn_${slug(shot)}${mood ? "_" + slug(mood) : ""}.png`;
await page.screenshot({ path: name });
console.log("saved", name);
await browser.close();
