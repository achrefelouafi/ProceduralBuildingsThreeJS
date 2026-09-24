/**
 * Headless screenshot of the running dev/preview server.
 * Usage: node tools/screenshot.mjs <url> <outDir> [baysX baysY floors preset]
 */
import puppeteer from "puppeteer-core";

const [, , url = "http://localhost:4173", outDir = ".", bx, by, floors, preset] = process.argv;

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
if (preset) await page.evaluate(p => window.__preset(p), preset);
await new Promise(r => setTimeout(r, 800));
const name = bx ? `shot_${bx}x${by}x${floors}${preset ? "_" + preset.replace(" ", "-") : ""}` : "shot_default";
await page.screenshot({ path: `${outDir}/${name}.png` });
console.log("saved", `${outDir}/${name}.png`);
await browser.close();
