// Builds of the same app in src/:
//
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
import { fileURLToPath } from "node:url";
import browserslist from "browserslist";
import { defineConfig } from "vite";

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
// the tests. Only this build gets it; the demo brings its own.
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
// Browsers without it ignore the attribute.
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
// Link previews (iMessage, Slack) fetch the image from the page's tags and need a full URL: Vite
// hashes share.png into assets/ and writes it as a path, so this puts the page's origin on it
const SITE_ORIGIN = "https://supplycheckout.com";
const siteShareImage = () => ({
  name: "supply-checkout:site-share-image",
  enforce: "post",
  // After Vite has written the page's asset paths
  generateBundle(_, bundle) {
    const page = bundle["index.html"];
    page.source = String(page.source).replace(/(content=")(\/assets\/share-[\w-]+\.png")/g, `$1${SITE_ORIGIN}$2`);
  },
});
const siteConfig = () => ({
  root: fileURLToPath(new URL("site", import.meta.url)),
  base: "/",
  publicDir: false,
  plugins: [siteMarker(), siteShareImage()],
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
  if (!["web", "demo"].includes(mode)) throw new Error("Build with --mode web, demo, ops or site");
  return {
    root: fileURLToPath(new URL("src", import.meta.url)),
    // The demo is uploaded as a folder and may be served from any path
    base: mode === "demo" ? "./" : "/",
    publicDir: false,
    build: {
      outDir: fileURLToPath(new URL(`dist/${mode}`, import.meta.url)),
      emptyOutDir: true,
      sourcemap: "hidden",
      // Also the CSS target (build.cssTarget defaults to this)
      target: browserTargets(),
      // No polyfill: every supported browser has modulepreload. The dynamic imports are
      // the RUM client (src/aws/rum.js, web build only, its own chunk) and
      // ZXing (src/barcode.js), its own chunk.
      modulePreload: { polyfill: false },
    },
    plugins: mode === "demo" ? [demoPage(), renderBlockingEntry()] : [awsRuntime(), renderBlockingEntry()],
  };
});
