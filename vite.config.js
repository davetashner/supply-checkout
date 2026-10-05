// Three builds of the same app in src/:
//
//   vite build --mode artifact   dist/artifact/index.html: one self-contained file for
//                                claude.ai, with the script and styles inlined
//   vite build --mode web        dist/web/: index.html plus hashed assets, for CloudFront,
//                                with the AWS runtime (src/aws/main.js) running first
//   vite build --mode demo       dist/demo/: the web build in demo mode, for supplycheckout.com
//                                until sign-in exists (demo/main.js). Relative URLs, so it
//                                works from any path.
//   vite build --mode site       dist/site/: the marketing home page (site/) for the apex, a
//                                separate small site with none of src/ in it.
//   vite build --mode ops        dist/ops/: the operator page (ops/, ADR 0015), a separate
//                                small site for ops.<env domain> with none of src/ in it.
//
// Each writes hidden source maps (no sourceMappingURL comment in the output), which
// the coverage run uses to report by src/ file and line.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import browserslist from "browserslist";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Names the script's source map app.js.map. viteSingleFile inlines the script
// into index.html but leaves the map, which the coverage run reads.
const keepArtifactSourceMap = () => ({
  name: "supply-checkout:keep-artifact-source-map",
  enforce: "post",
  generateBundle(_options, bundle) {
    const maps = Object.keys(bundle).filter((f) => f.endsWith(".js.map"));
    if (maps.length !== 1) this.error(`Expected one script source map, found ${maps.length}`);
    const map = bundle[maps[0]];
    delete bundle[maps[0]];
    this.emitFile({ type: "asset", fileName: "app.js.map", source: map.source });
  },
});

// claude.ai wraps a published page in its own document skeleton (doctype, <html>,
// <head> with charset and viewport, <body>), so the artifact is a fragment: the
// head content, then the markup, with the app script last, as index.html always was.
// scripts/page.mjs adds the same skeleton back for tests and validation.
const artifactFragment = () => ({
  name: "supply-checkout:artifact-fragment",
  enforce: "post",
  generateBundle(_options, bundle) {
    const html = bundle["index.html"];
    let source = String(html.source);
    const script = source.match(/<script type="module"[^>]*>[\s\S]*?<\/script>\n?/);
    if (!script) this.error("index.html has no inlined module script");
    source = source.replace(script[0], "");
    const wrapper = [
      /^<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"[^>]*>\n/,
      /<\/head>\n<body>\n/,
      /<\/body>\n<\/html>\n?$/,
    ];
    for (const re of wrapper) {
      if (!re.test(source)) this.error(`index.html doesn't match ${re}`);
      source = source.replace(re, "");
    }
    const code = script[0].replace(/^<script type="module"[^>]*>/, '<script type="module">').trim();
    // viteSingleFile keeps the <link> tag's attributes and indent on <style>
    source = source.replace(/[ \t]*<style[^>]*>/, "<style>\n").replace("/*$vite$:1*/", "");
    html.source = source.trimEnd() + "\n\n" + code + "\n";
  },
});

// The artifact's icon: claude.ai publishes only the page, so the SVG favicon is
// inlined as a data: URI, and the PNG fallbacks (for browsers without SVG favicons,
// and iOS home screens) are left to the web build. Vite never inlines icon links.
const ICON_LINKS = /<link rel="icon" href="\.\/icons\/favicon-32\.png"[^>]*>\n<link rel="icon" href="\.\/icons\/favicon\.svg" type="image\/svg\+xml">\n<link rel="apple-touch-icon"[^>]*>\n/;
const artifactIcon = () => ({
  name: "supply-checkout:artifact-icon",
  transformIndexHtml: {
    order: "pre",
    handler(html) {
      if (!ICON_LINKS.test(html)) throw new Error("src/index.html has no favicon links");
      const svg = readFileSync(new URL("src/icons/favicon.svg", import.meta.url));
      return html.replace(ICON_LINKS, `<link rel="icon" href="data:image/svg+xml;base64,${svg.toString("base64")}" type="image/svg+xml">\n`);
    },
  },
});

// The demo build: the app with demo/main.js running first (the in-memory runtime
// and demo data), a banner saying it's a demo, and its own title. Only this build
// gets it; demo/ is outside src/, so it isn't part of src/'s coverage.
const DEMO_BANNER = `<aside class="demo-banner" aria-label="Demo">
  <p><strong>Demo:</strong> nothing you enter is saved. Data resets when you reload.</p>
</aside>
`;
const demoPage = () => ({
  name: "supply-checkout:demo-page",
  transformIndexHtml: {
    order: "pre",
    handler(html) {
      const steps = [
        ["<title>Supply Checkout</title>", "<title>Supply Checkout demo</title>"],
        ["<body>\n", "<body>\n" + DEMO_BANNER],
        ['<script type="module" src="./main.js"></script>', '<script type="module" src="../demo/main.js"></script>\n<script type="module" src="./main.js"></script>'],
      ];
      for (const [from, to] of steps) {
        if (!html.includes(from)) throw new Error(`src/index.html has no ${from}`);
        html = html.replace(from, to);
      }
      return html;
    },
  },
});

// The web build: src/aws/main.js runs first and provides window.claude on the AWS backend
// (sign-in, teams, the data API and live updates), unless a runtime is already there, as in
// the tests. Only this build gets it; the artifact keeps claude.ai's runtime.
const WEB_ENTRY = '<script type="module" src="./main.js"></script>';
const awsRuntime = () => ({
  name: "supply-checkout:aws-runtime",
  transformIndexHtml: {
    order: "pre",
    handler(html) {
      if (!html.includes(WEB_ENTRY)) throw new Error(`src/index.html has no ${WEB_ENTRY}`);
      return html.replace(WEB_ENTRY, '<script type="module" src="./aws/main.js"></script>\n' + WEB_ENTRY);
    },
  },
});

// The web and demo builds load the app from its own file, which a browser could still be
// fetching when it first paints. blocking="render" holds that paint until the script has
// run, so a saved Light or Dark theme (src/theme.js) shows without a flash of the other.
// Browsers without it ignore the attribute. The artifact's script is inline.
const RENDER_BLOCKING_ENTRY = /<script type="module" crossorigin src="([^"]+)">/;
const renderBlockingEntry = () => ({
  name: "supply-checkout:render-blocking-entry",
  enforce: "post",
  transformIndexHtml: {
    order: "post",
    handler(html) {
      if (!RENDER_BLOCKING_ENTRY.test(html)) throw new Error("index.html has no module entry script");
      return html.replace(RENDER_BLOCKING_ENTRY, '<script type="module" crossorigin blocking="render" src="$1">');
    },
  },
});

// The oldest version of each supported browser, from the browserslist field in
// package.json, as esbuild-style targets (["chrome153", "edge151", ...]). Vite lowers
// JavaScript syntax and CSS for these, in both builds.
const ESBUILD_BROWSERS = { chrome: "chrome", edge: "edge", firefox: "firefox", safari: "safari", ios_saf: "ios" };
export function browserTargets(query = browserslist.loadConfig({ path: fileURLToPath(new URL(".", import.meta.url)) })) {
  const oldest = new Map();
  for (const entry of browserslist(query)) {
    const [name, versions] = entry.split(" ");
    const target = ESBUILD_BROWSERS[name];
    if (!target) throw new Error(`No esbuild target for browserslist entry "${entry}"`);
    // Safari and iOS list ranges like "18.5-18.6"; the range starts at the oldest
    const version = versions.split("-")[0];
    const old = oldest.get(target);
    if (!old || compareVersions(version, old) < 0) oldest.set(target, version);
  }
  return [...oldest].map(([target, version]) => target + version);
}

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// The operator page: its own root (ops/), no plugins, and nothing inlined as data: URIs,
// because its CSP allows only its own files (infra/lib/web/ops-content-security-policy.ts).
const opsConfig = () => ({
  root: fileURLToPath(new URL("ops", import.meta.url)),
  base: "/",
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("dist/ops", import.meta.url)),
    emptyOutDir: true,
    sourcemap: "hidden",
    target: browserTargets(),
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: { input: fileURLToPath(new URL("ops/index.html", import.meta.url)) },
  },
});

// The marketing home page: its own root (site/), no scripts but its own, and every file hashed
// into assets/ (the clips and posters too, so a release's clips are never cached under an old
// name). site-release.json marks the build as the site's, for scripts/publish-web.mjs. The
// page is served by the same distribution as the app, under that CSP.
const siteMarker = () => ({
  name: "supply-checkout:site-marker",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "site-release.json", source: '{"site":true}\n' });
  },
});
const siteConfig = () => ({
  root: fileURLToPath(new URL("site", import.meta.url)),
  base: "/",
  publicDir: false,
  plugins: [siteMarker()],
  build: {
    outDir: fileURLToPath(new URL("dist/site", import.meta.url)),
    emptyOutDir: true,
    target: browserTargets(),
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: { input: fileURLToPath(new URL("site/index.html", import.meta.url)) },
  },
});

export default defineConfig(({ mode }) => {
  if (mode === "ops") return opsConfig();
  if (mode === "site") return siteConfig();
  if (!["artifact", "web", "demo"].includes(mode)) throw new Error("Build with --mode artifact, web, demo, ops or site");
  const artifact = mode === "artifact";
  return {
    root: fileURLToPath(new URL("src", import.meta.url)),
    // The demo is uploaded as a folder and may be served from any path
    base: mode === "demo" ? "./" : "/",
    // No public/ folder: the artifact can only be one file
    publicDir: false,
    build: {
      outDir: fileURLToPath(new URL(`dist/${mode}`, import.meta.url)),
      emptyOutDir: true,
      sourcemap: "hidden",
      // Also the CSS target (build.cssTarget defaults to this)
      target: browserTargets(),
      // No polyfill: every supported browser has modulepreload. The dynamic imports are
      // the RUM client (src/aws/rum.js, web build only, its own chunk) and
      // ZXing (src/barcode.js), its own chunk in the web build, inlined in the artifact.
      modulePreload: { polyfill: false },
      // The artifact stays readable, like the hand-written file it replaces
      minify: !artifact,
      cssMinify: !artifact,
    },
    plugins: artifact ? [artifactIcon(), viteSingleFile(), keepArtifactSourceMap(), artifactFragment()] : mode === "demo" ? [demoPage(), renderBlockingEntry()] : [awsRuntime(), renderBlockingEntry()],
  };
});
