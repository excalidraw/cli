// Renders the README banner, hero.html, to ../banner-light.png and ../banner-dark.png.
// Fonts: Geist and Geist Mono (Vercel) and Excalifont (Excalidraw), all under the SIL Open Font License 1.1.
// The diagram in it comes from flow.mmd:
//   excalidraw mermaid flow.mmd --out flow-light.png --scale 2 --padding 24 --theme light
// (and again with --theme dark). The terminal shows the real output of
// "excalidraw mermaid flow.mmd --out flow.svg" run in /tmp/work; update it when the output changes.
// Run with: node .github/assets/banner/render.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = new URL(".", import.meta.url);
const browser = await chromium.launch({
  executablePath: process.env.EXCALIDRAW_BROWSER_PATH ?? "/opt/google/chrome/chrome",
});
const page = await browser.newPage({ deviceScaleFactor: 1.5, viewport: { width: 1280, height: 600 } });
for (const theme of ["light", "dark"]) {
  await page.goto(new URL(`hero.html?theme=${theme}`, here).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getElementById("diagram").complete);
  await page.locator("#hero").screenshot({ path: fileURLToPath(new URL(`../banner-${theme}.png`, here)), omitBackground: true });
}
await browser.close();
