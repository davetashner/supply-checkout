// The app's builds (see vite.config.js), for the tests and HTML validation.
//
//   artifact   dist/artifact/index.html, the self-contained page published to claude.ai
//   web        dist/web/, index.html plus hashed assets, for CloudFront
//   demo       dist/demo/, the web build in demo mode, for supplycheckout.com
//   ops        dist/ops/, the operator page (ops/), for ops.<env domain>
//   site       dist/site/, the marketing home page (site/), for the apex
//
// Tests pick artifact or web with BUILD=artifact (the default) or BUILD=web. The
// demo isn't a BUILD of its own: it's built and tested alongside the web build
// (tests/demo.spec.js), because it brings its own runtime.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage } from "./page.mjs";

export const BUILDS = ["artifact", "web"];

export function currentBuild() {
  const build = process.env.BUILD || "artifact";
  if (!BUILDS.includes(build)) throw new Error(`BUILD must be one of ${BUILDS.join(", ")}. Got: ${build}`);
  return build;
}

export const distDir = (build) => fileURLToPath(new URL(`../dist/${build}/`, import.meta.url));

export async function buildApp(build) {
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)), mode: build, logLevel: "warn" });
}

// Built with the web build, for tests/demo.spec.js
export const DEMO = "demo";
// Built with the web build too, for tests/ops.spec.js
export const OPS = "ops";
// And the marketing home page, for tests/site.spec.js
export const SITE = "site";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".json": "application/json" };

// What a server hosting the build would serve, by URL path. The artifact is only
// the page, in the document skeleton claude.ai adds when it's published.
export function builtFiles(build) {
  if (build === "artifact") return new Map([["/", { contentType: "text/html", body: buildPage() }]]);
  const dir = distDir(build);
  const files = new Map();
  for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(file.parentPath, file.name);
    const url = "/" + relative(dir, path).split(sep).join("/");
    files.set(url === "/index.html" ? "/" : url, { contentType: TYPES[extname(path)] || "application/octet-stream", body: readFileSync(path) });
  }
  return files;
}
