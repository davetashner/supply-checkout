// Renders the home page's link-preview image, site/share.png (1200 x 630, what iMessage, Slack
// and the like show when the link is shared), from the checkout clip's poster, with Playwright's
// Chromium. Run after the clips or the wording change, and commit the PNG: npm run site:share
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const poster = readFileSync(new URL("../site/clips/J4-checkout.jpg", import.meta.url)).toString("base64");
const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:1200px;height:630px;background:#EDF1EE;color:#17211E;font:600 22px/1.4 "Public Sans",system-ui,sans-serif;display:flex;align-items:center;overflow:hidden}
  .copy{padding:0 0 0 80px;width:640px}
  .brand{font:700 30px/1 "Barlow Condensed","Arial Narrow",system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#0E6B58;margin-bottom:28px}
  h1{font:700 78px/1.02 "Barlow Condensed","Arial Narrow",system-ui,sans-serif;margin:0 0 26px}
  p{margin:0;color:#56655F;font-weight:400;font-size:28px}
  .phone{margin-left:auto;margin-right:96px;width:330px;height:560px;padding:9px;border-radius:44px;background:#101614;box-shadow:0 24px 60px rgba(18,33,28,.3)}
  .phone img{display:block;width:100%;height:100%;object-fit:cover;object-position:top;border-radius:36px}
</style>
<div class="copy"><div class="brand">Supply Checkout</div><h1>Scan supplies out to the job. Scan them back.</h1><p>Bill clients for exactly what was used.</p></div>
<div class="phone"><img src="data:image/jpeg;base64,${poster}"></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html);
  await page.locator("img").evaluate((img) => img.decode());
  writeFileSync(new URL("../site/share.png", import.meta.url), await page.screenshot());
  console.log("site/share.png: 1200 x 630");
} finally {
  await browser.close();
}
