// Renders the PNG fallbacks for the favicon from src/icons/favicon.svg, in its light
// colors, with Playwright's Chromium (already a dev dependency):
//
//   src/icons/favicon-32.png         32 x 32, for browsers without SVG favicons
//   src/icons/apple-touch-icon.png   180 x 180, for iOS home screens
//
// Run after changing the SVG, and commit the PNGs: npm run icons
import { writeFileSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const dir = new URL("../src/icons/", import.meta.url);
const svg = readFileSync(new URL("favicon.svg", dir), "utf8");
const PNGS = { "favicon-32.png": { size: 32, tile: true }, "apple-touch-icon.png": { size: 180, tile: false } };

const browser = await chromium.launch();
try {
  for (const [name, { size, tile }] of Object.entries(PNGS)) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, colorScheme: "light" });
    // iOS rounds the corners of a touch icon itself, so that one is square and full bleed
    const source = tile ? svg : svg.replace(/ rx="\d+"/, "");
    await page.setContent(`<style>html,body{margin:0}img{display:block}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}">`);
    await page.locator("img").evaluate((img) => img.decode());
    writeFileSync(new URL(name, dir), await page.screenshot({ omitBackground: true }));
    await page.close();
    console.log(`src/icons/${name}: ${size} x ${size}`);
  }
} finally {
  await browser.close();
}
