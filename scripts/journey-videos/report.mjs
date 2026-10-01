// The release evidence report: one self-contained HTML page from the journey videos' sidecars
// (record.mjs --evidence). For each journey, its video; for each step, its result, each test that
// proves it with the test's result, the second in the video where it shows the step, a screenshot
// at the step's end and the test's trace; and the alarms that watch the journey
// (journeys/registry.json, which `npm run journeys:trace` keeps in step with docs/journeys.md).
// The release workflow attaches it to the GitHub Release with the videos and the traces.
//
//   npm run journeys:report                                  dist/journey-videos/journey-evidence.html
//   npm run journeys:report -- --tag v1.7.0 --repo owner/name   links each test's file at that tag
//   npm run journeys:report -- --dir <folder> --out <file>
//
// Release assets are public. It refuses a recording that doesn't say it ran against the test
// suite's fakes (the sidecar's `runtime`), and embeds only the screenshots inside the folder.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { esc, plain } from "./director.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const USAGE = "Usage: npm run journeys:report -- [--dir dist/journey-videos] [--out <file>] [--tag v1.2.3] [--repo owner/name]";

export function parseArgs(argv) {
  const opts = { dir: "dist/journey-videos", out: null, tag: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.replace(/^--/, "").split("=")[0];
    if (!arg.startsWith("--") || !(name in opts)) throw new Error(`Unknown option ${arg}\n${USAGE}`);
    const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
    if (!v) throw new Error(`--${name} needs a value\n${USAGE}`);
    opts[name] = v;
  }
  if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo is owner/name, not ${opts.repo}`);
  return opts;
}

// Seconds into the video as m:ss
export function clock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const order = (id) => Number(id.slice(1));
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const RESULT = { passed: "Passed", failed: "Failed", planned: "Not built yet", backend: "Backend tests", untested: "No test yet", skipped: "Not run" };
const tag = (kind, text = RESULT[kind] || kind) => `<span class="tag ${esc(kind)}">${esc(text)}</span>`;
const alarmState = (a) => (a.infra ? "built" : a.coveredBy ? `covered by ${a.coveredBy}` : "planned");
const alarmLink = (a) => `<a href="#alarm-${slug(a.name)}">${esc(a.name)}</a> (${esc(alarmState(a))})`;

const CSS = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #5c6670; --line: #d9dee3; --head: #f3f5f7; --link: #0b62c4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111417; --fg: #e8eaed; --muted: #9aa3ab; --line: #2c3238; --head: #1a1f24; --link: #7cb8ff; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 16px; }
  a { color: var(--link); }
  h1 { margin: .2em 0; } h2 { margin-top: 2em; border-top: 1px solid var(--line); padding-top: 1em; }
  .muted { color: var(--muted); }
  .note { border-left: 4px solid #ffb020; padding: 6px 12px; background: var(--head); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: var(--head); }
  ul { margin: 0; padding-left: 1.1em; } li { margin: 2px 0; }
  video { width: 100%; max-height: 70vh; background: #000; }
  .tag { display: inline-block; font: 700 11px/1 system-ui, sans-serif; letter-spacing: .05em; text-transform: uppercase; border-radius: 999px; padding: 4px 8px; margin-right: 4px; }
  .passed { background: #3ddc84; color: #06220f; } .failed { background: #ff4d4d; color: #200000; }
  .simulated { background: #ffb020; color: #2a1a00; } .planned { background: #ff5fa2; color: #2b0014; }
  .backend { background: #b48cff; color: #1a0638; } .skipped, .untested { background: #b8b8b8; color: #111; }
  .err { color: #d93025; font-family: ui-monospace, monospace; font-size: 13px; }
  details img { display: block; max-width: 480px; width: 100%; margin-top: 4px; border: 1px solid var(--line); }
  code { font-size: 13px; }
`;

// Seeks the journey's player when a timestamp is clicked; the link itself (video#t=) still works
// without it, in a browser that opens the video file
const SCRIPT = `document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-t]");
  const v = a && document.getElementById("video-" + a.dataset.video);
  if (!v || !v.currentSrc) return;
  e.preventDefault();
  v.currentTime = Number(a.dataset.t);
  v.scrollIntoView({ block: "nearest" });
  v.play().catch(() => {});
});`;

function testItem(t, journey, video, { repo, tag: ref, image }) {
  const where = `${t.file}:${t.line}`;
  const file = repo && ref ? `<a href="https://github.com/${esc(repo)}/blob/${esc(ref)}/${esc(t.file)}#L${t.line}"><code>${esc(where)}</code></a>` : `<code>${esc(where)}</code>`;
  const at = t.at !== undefined ? ` <a href="${esc(video)}#t=${t.at}" data-video="${esc(journey)}" data-t="${t.at}">${clock(t.at)}</a>` : "";
  const trace = t.trace ? ` · <a href="${esc(t.trace)}">trace</a>` : "";
  const src = t.shot ? image(t.shot) : null;
  const shot = t.shot ? (src ? `<details><summary>Screenshot at the step's end</summary><img src="${src}" alt="${esc(t.title)}, at the end of the step"></details>` : `<div class="muted">(no screenshot)</div>`) : "";
  return `<li>${tag(t.result)}${esc(t.title)}${at}${trace}<div>${file}</div>${t.error ? `<div class="err">${esc(t.error)}</div>` : ""}${shot}</li>`;
}

function stepRow(s, sc, alarms, opts) {
  const id = sc.journey.id;
  let detail;
  if (s.tests.length) detail = `<ul>${s.tests.map((t) => testItem(t, id, sc.video, opts)).join("")}</ul>`;
  else if (s.result === "planned") detail = `Not built yet.${s.beads?.length ? ` Planned in ${esc(s.beads.join(", "))}.` : ""}`;
  else if (s.result === "backend") detail = `Proved by backend tests, not in the video: <ul>${s.backendTests.map((b) => `<li><code>${esc(b)}</code></li>`).join("")}</ul>`;
  else detail = esc(s.untested ? `No automated test yet: ${s.untested}` : "Its tests didn't run.");
  // A step with no test in the video has a card there
  const card = !s.tests.length && s.at !== undefined ? ` <a href="${esc(sc.video)}#t=${s.at}" data-video="${esc(id)}" data-t="${s.at}">${clock(s.at)}</a>` : "";
  const watched = alarms.length ? alarms.map(alarmLink).join(", ") : `<span class="muted">None of its own; see <a href="#alarms">Every journey</a></span>`;
  return `<tr id="step-${esc(s.id.replace(".", "-"))}"><td><b>${esc(s.id)}</b></td><td>${esc(plain(s.text))}${s.simulated ? `<div class="muted">Simulated: ${esc(s.simulated)}</div>` : ""}</td>
    <td>${tag(s.result)}${s.simulated ? tag("simulated", "Simulated") : ""}${card}</td><td>${detail}</td><td>${watched}</td></tr>`;
}

function journeySection(sc, registry, opts) {
  const id = sc.journey.id;
  const alarms = (registry.alarms || []).filter((a) => a.journeys.includes(id));
  return `<section id="${esc(id)}"><h2>${esc(id)} ${esc(sc.journey.name)}</h2>
    <p class="muted">Persona: ${esc(sc.journey.persona)}${sc.journey.critical ? " · Critical journey" : ""} · ${esc(sc.journey.status)} · ${esc(sc.viewport)} · ${clock(sc.duration)}</p>
    <video id="video-${esc(id)}" controls preload="metadata" src="${esc(sc.video)}"></video>
    <p class="muted">Video: <a href="${esc(sc.video)}">${esc(sc.video)}</a> (download it into the same folder as this page to play it here)</p>
    <div class="scroll"><table><thead><tr><th>Step</th><th>What the customer does</th><th>Result</th><th>Tests, where each shows in the video</th><th>Alarms that watch it</th></tr></thead>
    <tbody>${sc.steps.map((s) => stepRow(s, sc, alarms, opts)).join("")}</tbody></table></div></section>`;
}

function alarmsSection(registry) {
  const rows = (registry.alarms || []).map((a) => {
    const journeys = a.journeys.map((j) => (j === "*" ? "Every journey" : `<a href="#${esc(j)}">${esc(j)}</a>`)).join(", ");
    return `<tr id="alarm-${slug(a.name)}"><td>${esc(a.name)}</td><td>${journeys}</td><td>${esc(alarmState(a))}</td></tr>`;
  }).join("");
  return `<section id="alarms"><h2>Alarms</h2><p class="muted">From journeys/registry.json, which matches docs/journeys.md ("Alarms for blocked journeys"). Built alarms exist in production; planned ones don't yet.</p>
    <div class="scroll"><table><thead><tr><th>Alarm</th><th>Journeys</th><th>State</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// The page. `image(rel)` gives a screenshot's data: URI, or null when it isn't there.
export function buildReport({ sidecars, registry, tag: ref = null, repo = null, generatedAt = new Date().toISOString(), image = () => null }) {
  if (!sidecars.length) throw new Error("No journey recordings: run npm run journeys:video -- --evidence first");
  for (const sc of sidecars) {
    if (sc.runtime !== "fakes") throw new Error(`${sc.video} wasn't recorded against the test suite's fakes; release assets are public, so it can't go in the report`);
  }
  const sorted = [...sidecars].sort((a, b) => order(a.journey.id) - order(b.journey.id) || a.video.localeCompare(b.video));
  const opts = { repo, tag: ref, image };
  const commits = [...new Set(sorted.map((s) => s.commit).filter(Boolean))].join(", ");
  const total = (k) => sorted.reduce((n, s) => n + (s.summary?.[k] || 0), 0);
  const summary = sorted.map((sc) => `<tr><td><a href="#${esc(sc.journey.id)}">${esc(sc.journey.id)}</a></td><td>${esc(sc.journey.name)}${sc.journey.critical ? " <span class=\"muted\">(critical)</span>" : ""}</td>
    <td>${tag(sc.summary.failed ? "failed" : "passed", sc.summary.failed ? `${sc.summary.failed} failed` : "No failures")}</td>
    <td>${["passed", "simulated", "planned", "backend", "untested", "skipped"].filter((k) => sc.summary[k]).map((k) => `${sc.summary[k]} ${k === "planned" ? "not built yet" : k === "backend" ? "backend only" : k}`).join(", ")}</td>
    <td><a href="${esc(sc.video)}">${esc(sc.video)}</a> (${clock(sc.duration)})</td></tr>`).join("");
  const title = `Journey evidence${ref ? ` ${ref}` : ""}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>Supply Checkout ${esc(title)}</h1>
<p class="muted">${ref ? `Release ${esc(ref)}. ` : ""}${commits ? `Commit ${esc(commits)}. ` : ""}Report built ${esc(generatedAt)}.</p>
<p class="note">Each video is the automated tests tagged with the journey's steps (docs/journeys.md), recorded as they ran in Chromium against the web build, with the test suite's fakes and demo data: no production system, real account, payment or email. Steps marked Simulated rely on a fake (a camera, a sign-in provider, Stripe).</p>
<p>Steps: ${total("passed")} passed, ${total("failed")} failed, ${total("planned")} not built yet, ${total("backend")} proved by backend tests only. To play the videos and open the traces from this page, download it, the <code>.webm</code> videos and <code>journey-traces.zip</code> from the release into one folder and unzip the traces there; a trace opens with <code>npx playwright show-trace</code> or at trace.playwright.dev.</p>
<div class="scroll"><table><thead><tr><th>Journey</th><th>Name</th><th>Result</th><th>Steps</th><th>Video</th></tr></thead><tbody>${summary}</tbody></table></div>
${sorted.map((sc) => journeySection(sc, registry, opts)).join("\n")}
${alarmsSection(registry)}
</main><script>${SCRIPT}</script></body></html>
`;
}

// The sidecars in a folder: each .json with a journey and a video
export function readSidecars(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((s) => s.journey?.id && s.video);
}

export function writeReport({ dir, out = join(dir, "journey-evidence.html"), registry, tag: ref = null, repo = null }) {
  const base = resolve(dir);
  // Only a .jpg inside the folder is embedded
  const image = (rel) => {
    const path = resolve(base, rel);
    if (!path.startsWith(base + sep) || !path.endsWith(".jpg") || !existsSync(path)) return null;
    return `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;
  };
  writeFileSync(out, buildReport({ sidecars: readSidecars(dir), registry, tag: ref, repo, image }));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const dir = resolve(ROOT, opts.dir);
    const registry = JSON.parse(readFileSync(join(ROOT, "journeys/registry.json"), "utf8"));
    const out = writeReport({ dir, out: opts.out ? resolve(opts.out) : undefined, registry, tag: opts.tag, repo: opts.repo });
    console.log(`Wrote ${relative(process.cwd(), out) || out}`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
