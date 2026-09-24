/**
 * Headless screenshot of the running dev/preview server.
 * Usage: node tools/screenshot.mjs <url> <outDir> [baysX baysY floors mood shot]
 * e.g.   node tools/screenshot.mjs http://localhost:4173 . 6 3 3 "Blue Hour" "Street level"
 */
import puppeteer from "puppeteer-core";

const [, , url = "http://localhost:4173", outDir = ".", bx, by, floors, mood, shot] = process.argv;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=default", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
page.on("console", m => console.log("[page]", m.text()));
page.on("pageerror", e => console.log("[pageerror]", e.message));
await page.goto(url, { waitUntil: "networkidle0" });
await page.waitForFunction("window.__ready === true", { timeout: 30000 });

if (bx) {
  await page.evaluate((X, Y, F) => {
    window.__setParams({ baysX: X, baysY: Y, floors: F });
  }, +bx, +by, +floors);
}
await page.evaluate(() => window.__orbit(false));
if (mood) await page.evaluate(m => window.__mood(m), mood);
if (shot) await page.evaluate(s => window.__shot(s), shot);
await new Promise(r => setTimeout(r, 800));
const slug = t => (t ? "_" + t.replace(/[^a-z0-9]+/gi, "-") : "");
const name = bx ? `shot_${bx}x${by}x${floors}${slug(mood)}${slug(shot)}` : "shot_default";
await page.screenshot({ path: `${outDir}/${name}.png` });
console.log("saved", `${outDir}/${name}.png`);
await browser.close();
