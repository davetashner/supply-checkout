import { readFileSync } from "node:fs";
import { HtmlValidate, formatterFactory } from "html-validate";
import { buildPage } from "./page.mjs";
import { distDir } from "./builds.mjs";

const validator = new HtmlValidate({
  extends: ["html-validate:recommended"],
  rules: {
    // The barcode mark in the header uses inline widths.
    "no-inline-style": "off",
    // Google Fonts CSS is generated per browser, so it can't carry an integrity hash.
    "require-sri": "off",
  },
});

// Run `npm run build` first (npm run lint does).
const pages = {
  "dist/artifact/index.html (as published)": buildPage(),
  "dist/web/index.html": readFileSync(distDir("web") + "index.html", "utf8"),
  "dist/demo/index.html": readFileSync(distDir("demo") + "index.html", "utf8"),
  "dist/ops/index.html": readFileSync(distDir("ops") + "index.html", "utf8"),
  "dist/site/index.html": readFileSync(distDir("site") + "index.html", "utf8"),
};
let valid = true;
for (const [name, html] of Object.entries(pages)) {
  const report = await validator.validateString(html, name);
  if (!report.valid) {
    console.error(formatterFactory("stylish")(report.results));
    valid = false;
  } else console.log(`${name}: HTML is valid`);
}
if (!valid) process.exit(1);
