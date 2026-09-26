// Two builds of the same app in src/:
//
//   vite build --mode artifact   dist/artifact/index.html: one self-contained file for
//                                claude.ai, with the script and styles inlined
//   vite build --mode web        dist/web/: index.html plus hashed assets, for CloudFront
//
// Both write hidden source maps (no sourceMappingURL comment in the output), which
// the coverage run uses to report by src/ file and line.
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

export default defineConfig(({ mode }) => {
  if (mode !== "artifact" && mode !== "web") throw new Error("Build with --mode artifact or --mode web");
  const artifact = mode === "artifact";
  return {
    root: fileURLToPath(new URL("src", import.meta.url)),
    // No public/ folder: the artifact can only be one file
    publicDir: false,
    build: {
      outDir: fileURLToPath(new URL(`dist/${mode}`, import.meta.url)),
      emptyOutDir: true,
      sourcemap: "hidden",
      // Also the CSS target (build.cssTarget defaults to this)
      target: browserTargets(),
      // One entry chunk and no dynamic imports, so there's nothing to preload
      modulePreload: { polyfill: false },
      // The artifact stays readable, like the hand-written file it replaces
      minify: !artifact,
      cssMinify: !artifact,
    },
    plugins: artifact ? [viteSingleFile(), keepArtifactSourceMap(), artifactFragment()] : [],
  };
});
