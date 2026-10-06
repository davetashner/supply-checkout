// What a journey video draws (npm run journeys:video, record.mjs): the viewports, the overlay
// drawn over each recorded test's page (tests/journey-video.js), and the cards between the
// tests. Playwright's videos don't show the mouse, so the overlay draws a cursor that glides to
// each element a test acts on, with a ripple on each click, and a caption banner with the step
// IDs, the registry's text for them, the test's name, and whether the step passed or failed.

// The Playwright device each viewport emulates (the test projects' own), the banner's height
// above its viewport, and how much larger than the page the video is. The phone is an iPhone 13
// in Chromium's mobile emulation, recorded at twice its CSS size so text stays sharp.
export const VIEWPORTS = {
  desktop: { device: "Desktop Chrome", viewport: { width: 1280, height: 720 }, banner: 84, scale: 1 },
  phone: { device: "iPhone 13", viewport: { width: 390, height: 664 }, banner: 112, scale: 2 },
};

// The page's viewport (the test's own, plus the banner), and the video's size
// The marketing profile has no banner: its caption is drawn over the bottom of the page
export function frame(name, { marketing = false } = {}) {
  const base = VIEWPORTS[name];
  if (!base) throw new Error(`--viewport is desktop or phone, not ${name}`);
  // Playwright's video doesn't scale the page up to a larger canvas: the clips are at 1x
  const v = marketing ? { ...base, banner: 0, scale: 1 } : base;
  const page = { width: v.viewport.width, height: v.viewport.height + v.banner };
  return { ...v, page, video: { width: page.width * v.scale, height: page.height * v.scale } };
}

// In the page, before the app (context.addInitScript). Self-contained: it's serialized. The
// elements go on <html>, outside <body>, so the app's redraws never remove them; none of them
// take pointer events, and none is in the accessibility tree. The styles are a constructed
// stylesheet, so a Content Security Policy that forbids inline styles doesn't stop them.
export function installOverlay({ banner: height, compact, marketing = false, captions = true }) {
  if (window.top !== window || window.__jv) return;
  const api = { ready: false, state: null };
  window.__jv = api;
  const css = `
    html.jv-on { padding-top: ${height}px !important; scroll-padding-top: ${height + 16}px; }
    html.jv-on .overlay { top: ${height}px !important; }
    #jv-banner, #jv-cursor, .jv-ripple { pointer-events: none !important; }
    #jv-banner { position: fixed; top: 0; left: 0; right: 0; height: ${height}px; z-index: 2147483600; box-sizing: border-box; overflow: hidden;
      display: none; align-items: center; gap: ${compact ? 8 : 16}px; padding: 0 ${compact ? 10 : 20}px; background: #0b1b2b; color: #fff;
      font: 500 ${compact ? 12 : 15}px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; border-bottom: 4px solid #3ea6ff; }
    html.jv-on #jv-banner { display: flex; }
    #jv-banner .jv-id { flex: none; max-width: ${compact ? 30 : 22}%; font: 800 ${compact ? 14 : 22}px/1.1 system-ui, sans-serif; background: #3ea6ff; color: #04121f; border-radius: 8px; padding: ${compact ? "6px 7px" : "9px 11px"}; }
    #jv-banner .jv-text { flex: 1; min-width: 0; }
    #jv-banner .jv-test { font-size: ${compact ? 10 : 12}px; color: #9cc9f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
    #jv-banner .jv-step { font-size: ${compact ? 13 : 18}px; font-weight: 650; line-height: 1.25; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${compact ? 3 : 2}; overflow: hidden; }
    #jv-banner .jv-note { font-size: ${compact ? 10 : 12}px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ffd27a; }
    #jv-banner .jv-note:empty { display: none; }
    #jv-banner .jv-state { flex: none; font: 800 ${compact ? 11 : 14}px/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; border-radius: 999px; padding: ${compact ? "6px 8px" : "9px 13px"}; background: #d8e6f3; color: #0b1b2b; }
    #jv-banner[data-state="passed"] { border-bottom-color: #3ddc84; }
    #jv-banner[data-state="passed"] .jv-state { background: #3ddc84; color: #06220f; }
    #jv-banner[data-state="failed"] { border-bottom-color: #ff4d4d; background: #3a0b0b; }
    #jv-banner[data-state="failed"] .jv-state { background: #ff4d4d; color: #200000; }
    #jv-banner[data-state="failed"] .jv-note { color: #ffb3b3; }
    #jv-banner[data-state="skipped"] .jv-state { background: #b8b8b8; color: #111; }
    #jv-cursor { position: fixed; left: 0; top: 0; width: 28px; height: 28px; z-index: 2147483647; transform: translate(-100px, -100px);
      transition: transform var(--jv-glide, 400ms) cubic-bezier(.45, 0, .25, 1); filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
    .jv-ripple { position: fixed; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
      border: 3px solid #ff3b30; background: rgba(255,59,48,.25); animation: jv-ripple .6s ease-out forwards; }
    @keyframes jv-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
  ` + (marketing ? `
    #jv-banner { top: auto; bottom: ${compact ? 12 : 20}px; left: ${compact ? 10 : 24}px; right: ${compact ? 10 : 24}px; height: auto; border: 0; border-radius: 14px; padding: ${compact ? "10px 14px" : "12px 20px"}; background: rgba(11, 27, 43, .92); justify-content: center; text-align: center; }
    #jv-banner .jv-id, #jv-banner .jv-test, #jv-banner .jv-note, #jv-banner .jv-state { display: none; }
    #jv-banner .jv-text { flex: none; max-width: 100%; }
    #jv-banner .jv-step { font-size: ${compact ? 15 : 20}px; font-weight: 700; -webkit-line-clamp: 2; }
  ` + (captions ? "" : "#jv-banner { display: none !important; }") : "");
  let banner, cursor;
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  // Once per document
  const make = () => {
    if (banner && banner.isConnected) return;
    const root = document.documentElement;
    if (!root) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch { /* the overlay still shows the cursor's position, unstyled */ }
    banner = el("div");
    banner.id = "jv-banner";
    banner.setAttribute("aria-hidden", "true");
    const text = el("div", "jv-text");
    text.append(el("div", "jv-test"), el("div", "jv-step"), el("div", "jv-note"));
    banner.append(el("div", "jv-id"), text, el("div", "jv-state"));
    cursor = el("div");
    cursor.id = "jv-cursor";
    cursor.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "28");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const [k, v] of Object.entries({ d: "M3 2 L3 19 L7.5 14.8 L10.6 21.6 L13.6 20.3 L10.6 13.6 L17 13.4 Z", fill: "#111", stroke: "#fff", "stroke-width": "1.6", "stroke-linejoin": "round" })) path.setAttribute(k, v);
    svg.append(path);
    cursor.append(svg);
    root.append(banner, cursor);
    api.ready = true;
    if (api.state) api.caption(api.state);
    if (api.at) cursor.style.transform = `translate(${api.at.x - 3}px, ${api.at.y - 2}px)`;
  };
  const labels = { running: "Running", passed: "Passed", failed: "Failed", skipped: "Skipped" };
  // state: { id, test, step, note, state }
  api.caption = (state) => {
    api.state = state;
    make();
    if (!banner) return;
    document.documentElement.classList.add("jv-on");
    banner.dataset.state = state.state;
    banner.querySelector(".jv-id").textContent = state.id;
    banner.querySelector(".jv-test").textContent = state.test;
    banner.querySelector(".jv-step").textContent = state.step;
    banner.querySelector(".jv-note").textContent = state.note || "";
    banner.querySelector(".jv-state").textContent = labels[state.state] || state.state;
  };
  // Glides the drawn cursor to (x, y) over ms, and ripples there for a click
  api.point = (x, y, ms, click) => {
    make();
    if (!cursor) return;
    api.at = { x, y };
    cursor.style.setProperty("--jv-glide", `${ms}ms`);
    cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    if (!click) return;
    setTimeout(() => {
      const r = el("div", "jv-ripple");
      r.setAttribute("aria-hidden", "true");
      r.style.left = x + "px";
      r.style.top = y + "px";
      document.documentElement.append(r);
      setTimeout(() => r.remove(), 700);
    }, ms);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make);
  else make();
}

// ---------------------------------------------------------------------------
// Cards: whole-frame pages recorded between the tests (record.mjs)

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// One line for a failed assertion: the matcher, and what it expected and got
export function errorSummary(message) {
  // eslint-disable-next-line no-control-regex -- terminal colors in Playwright's messages
  const lines = String(message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const head = (lines[0] || "").replace(/^Error:\s*/, "").replace(/\s*\/\/.*$/, "");
  const detail = ["Expected", "Received"].map((w) => lines.find((l) => l.startsWith(w))).filter(Boolean);
  const out = [head, ...detail].join(" · ");
  return out.length > 240 ? `${out.slice(0, 239)}…` : out;
}

// The registry's step text is Markdown; the video shows it plain
export const plain = (s) => String(s ?? "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

const CARD_CSS = `
  html, body { margin: 0; height: 100%; }
  body { box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; gap: 14px; padding: 5vh 7vw;
    background: linear-gradient(135deg, #0b1b2b, #123a5c); color: #fff; font: 400 clamp(13px, 2.1vw, 21px)/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
  .id { display: inline-block; align-self: flex-start; font: 800 clamp(18px, 3vw, 30px)/1 system-ui, sans-serif; background: #3ea6ff; color: #04121f; border-radius: 12px; padding: 10px 16px; }
  .big { font: 800 clamp(26px, 5vw, 60px)/1.08 system-ui, sans-serif; }
  .mid { font: 700 clamp(18px, 3.2vw, 36px)/1.2 system-ui, sans-serif; }
  .meta { color: #9cc9f0; }
  .small { font-size: clamp(11px, 1.5vw, 16px); color: #9cc9f0; }
  ul { margin: 0; padding-left: 1.1em; }
  li { margin: 3px 0; }
  .tag { display: inline-block; font: 800 .72em/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; border-radius: 999px; padding: 5px 9px; margin-right: 6px; vertical-align: .1em; }
  .passed { background: #3ddc84; color: #06220f; } .failed { background: #ff4d4d; color: #200000; }
  .simulated { background: #ffb020; color: #2a1a00; } .planned { background: #ff5fa2; color: #2b0014; }
  .backend { background: #b48cff; color: #1a0638; } .skipped, .untested { background: #b8b8b8; color: #111; }
  .count { font-weight: 700; }
`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CARD_CSS}</style></head><body>${body}</body></html>`;

const RESULT_LABEL = { passed: "Passed", failed: "Failed", planned: "Not built yet", backend: "Backend tests", untested: "No test yet", skipped: "Not run" };
const tag = (kind, text = RESULT_LABEL[kind]) => `<span class="tag ${kind}">${esc(text)}</span>`;

// The first frames: the journey, who does it, and what the video is
export function titleCard(journey, { viewport, build, commit, date, tests }) {
  return page(`${journey.id} ${journey.name}`, `<div class="id">${esc(journey.id)}</div><div class="big">${esc(journey.name)}</div>
    <div class="meta">Persona: ${esc(journey.persona)}${journey.critical ? " · Critical journey" : ""} · ${esc(journey.status)}</div>
    <div>The ${tests} automated test${tests === 1 ? "" : "s"} that prove this journey's steps, recorded as they run: each caption is the step from docs/journeys.md, and each step shows whether it passed or failed.</div>
    <div class="small">The ${esc(build)} build in ${viewport === "phone" ? "a phone (iPhone 13 in Chromium)" : "desktop Chromium"}, against the test suite's fakes: no real AWS, Stripe or email.${commit ? ` Commit ${esc(commit)}.` : ""} ${esc(date)}.</div>`);
}

// A step with nothing to show on screen: not built yet, or proved by backend tests only
export function stepCard(journey, step) {
  const kind = step.result;
  const body = kind === "planned"
    ? `<div>Not built yet.${step.beads?.length ? ` Planned in ${esc(step.beads.join(", "))}.` : ""}</div>`
    : kind === "backend"
      ? `<div>No screen to show: this step is proved by backend tests, which aren't in this video.</div><ul>${step.backendTests.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
      : `<div>No automated test yet: ${esc(step.untested)}</div>`;
  return page(`${step.id}`, `<div class="id">${esc(step.id)}</div><div class="mid">${esc(plain(step.text))}</div>
    <div>${tag(kind)}${step.simulated ? tag("simulated", "Simulated") : ""}</div>${body}
    ${step.simulated ? `<div class="small">Simulated: ${esc(step.simulated)}.</div>` : ""}`);
}

// The last frames: each step's result
export function endCard(journey, steps, summary) {
  const MAX = 4;
  const rows = steps.map((s) => {
    const failed = s.tests.filter((t) => t.result === "failed");
    const detail = s.result === "passed" || s.result === "failed"
      ? ` <span class="small">(${s.tests.filter((t) => t.result === "passed").length} passed${failed.length ? `, ${failed.length} failed` : ""} of ${s.tests.length} test${s.tests.length === 1 ? "" : "s"})</span>`
      : "";
    const failures = failed.length
      ? `<ul class="small">${failed.slice(0, MAX).map((t) => `<li>${esc(t.title)}</li>`).join("")}${failed.length > MAX ? `<li>and ${failed.length - MAX} more</li>` : ""}</ul>`
      : "";
    return `<li><b>${esc(s.id)}</b> ${tag(s.result)}${s.simulated ? tag("simulated", "Simulated") : ""}${esc(plain(s.text))}${detail}${failures}</li>`;
  }).join("");
  const counts = [["passed", "passed"], ["failed", "failed"], ["simulated", "simulated"], ["planned", "not built yet"], ["backend", "proved by backend tests"]]
    .filter(([k]) => summary[k]).map(([k, label]) => `<span class="count">${summary[k]}</span> ${label}`).join(" · ");
  return page(`End of ${journey.id}`, `<div class="id">${esc(journey.id)}</div><div class="mid">End of ${esc(journey.name)}</div>
    <div class="meta">Steps: ${counts || "none"}</div><ul>${rows}</ul>`);
}
