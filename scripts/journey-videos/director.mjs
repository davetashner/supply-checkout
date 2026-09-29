// What a journey video draws on the page, and how it moves through it: a visible mouse
// cursor with a click ripple (Playwright's videos don't show the mouse), a caption banner
// with the journey and the current step, and title and end cards. See record.mjs.

const BANNER = 84;

// In the page, before the app (context.addInitScript). Self-contained: it's serialized.
// The elements go on <html>, outside <body>, so the app's redraws never remove them, and
// none of them take pointer events.
export function installOverlay(bannerHeight) {
  if (window.__jv) return;
  const api = { ready: false, x: -100, y: -100 };
  window.__jv = api;
  const css = `
    html.jv-banner { padding-top: ${bannerHeight}px !important; scroll-padding-top: ${bannerHeight + 16}px; }
    html.jv-banner .overlay { top: ${bannerHeight}px !important; }
    #jv-banner, #jv-cursor, #jv-card, .jv-ripple { pointer-events: none !important; }
    #jv-banner { position: fixed; top: 0; left: 0; right: 0; height: ${bannerHeight}px; z-index: 2147483600; box-sizing: border-box;
      display: none; align-items: center; gap: 18px; padding: 0 24px; background: #0b1b2b; color: #fff;
      font: 500 15px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,.35); border-bottom: 3px solid #3ea6ff; }
    html.jv-banner #jv-banner { display: flex; }
    #jv-banner .jv-id { flex: none; font: 800 26px/1 system-ui, sans-serif; background: #3ea6ff; color: #04121f; border-radius: 10px; padding: 10px 12px; }
    #jv-banner .jv-text { flex: 1; min-width: 0; }
    #jv-banner .jv-title { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #9cc9f0; margin-bottom: 3px; }
    #jv-banner .jv-step { font-size: 20px; font-weight: 650; line-height: 1.25; }
    #jv-banner .jv-kind { flex: none; font: 800 13px/1 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; border-radius: 999px; padding: 8px 12px; }
    #jv-banner .jv-kind:empty { display: none; }
    #jv-banner[data-kind="check"] { border-bottom-color: #3ddc84; }
    #jv-banner[data-kind="check"] .jv-kind { background: #3ddc84; color: #06220f; }
    #jv-banner[data-kind="simulated"] { border-bottom-color: #ffb020; }
    #jv-banner[data-kind="simulated"] .jv-kind { background: #ffb020; color: #2a1a00; }
    #jv-banner[data-kind="planned"] { border-bottom-color: #ff5fa2; }
    #jv-banner[data-kind="planned"] .jv-kind { background: #ff5fa2; color: #2b0014; }
    #jv-cursor { position: fixed; left: 0; top: 0; width: 28px; height: 28px; z-index: 2147483647; transform: translate(-100px, -100px);
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
    .jv-ripple { position: fixed; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
      border: 3px solid #ff3b30; background: rgba(255,59,48,.25); animation: jv-ripple .6s ease-out forwards; }
    @keyframes jv-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
    #jv-card { position: fixed; inset: 0; z-index: 2147483640; display: none; flex-direction: column; justify-content: center; gap: 18px;
      padding: 0 10%; background: linear-gradient(135deg, #0b1b2b, #123a5c); color: #fff; font: 400 22px/1.45 system-ui, sans-serif; }
    #jv-card.on { display: flex; }
    #jv-card .jv-big { font: 800 64px/1.05 system-ui, sans-serif; }
    #jv-card .jv-id { display: inline-block; font: 800 30px/1 system-ui, sans-serif; background: #3ea6ff; color: #04121f; border-radius: 12px; padding: 10px 16px; align-self: flex-start; }
    #jv-card .jv-meta { color: #9cc9f0; }
    #jv-card ul { margin: 0; padding-left: 1.2em; }
    #jv-card li { margin: 4px 0; }
    #jv-card .jv-planned { color: #ff9cc6; }
    #jv-card .jv-small { font-size: 16px; color: #9cc9f0; }
  `;
  let banner, cursor, card;
  // Once per document: setContent replaces the document but keeps this window
  const make = () => {
    if (banner && banner.isConnected) return;
    const root = document.documentElement;
    const style = document.createElement("style");
    style.textContent = css;
    banner = document.createElement("div");
    banner.id = "jv-banner";
    banner.setAttribute("aria-hidden", "true");
    banner.innerHTML = `<div class="jv-id"></div><div class="jv-text"><div class="jv-title"></div><div class="jv-step"></div></div><div class="jv-kind"></div>`;
    cursor = document.createElement("div");
    cursor.id = "jv-cursor";
    cursor.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 2 L3 19 L7.5 14.8 L10.6 21.6 L13.6 20.3 L10.6 13.6 L17 13.4 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    card = document.createElement("div");
    card.id = "jv-card";
    root.append(style, banner, card, cursor);
    const place = () => { cursor.style.transform = `translate(${api.x - 3}px, ${api.y - 2}px)`; };
    document.addEventListener("mousemove", (e) => { api.x = e.clientX; api.y = e.clientY; place(); }, { capture: true, passive: true });
    document.addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.className = "jv-ripple";
      r.style.left = e.clientX + "px";
      r.style.top = e.clientY + "px";
      root.append(r);
      setTimeout(() => r.remove(), 700);
    }, { capture: true, passive: true });
    api.ready = true;
  };
  const labels = { check: "Checks", simulated: "Simulated", planned: "Not built yet", step: "" };
  api.caption = (id, title, text, kind = "step") => {
    make();
    document.documentElement.classList.add("jv-banner");
    banner.dataset.kind = kind;
    banner.querySelector(".jv-id").textContent = id;
    banner.querySelector(".jv-title").textContent = title;
    banner.querySelector(".jv-step").textContent = text;
    banner.querySelector(".jv-kind").textContent = labels[kind] ?? "";
  };
  api.card = (html) => { make(); card.innerHTML = html; card.classList.add("on"); };
  api.hideCard = () => { make(); card.classList.remove("on"); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make);
  else make();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class Director {
  // pace scales every pause (1 for watching, lower for a quick check); slowMo is the
  // browser's, which the cursor's steps take into account
  constructor(page, journey, { pace = 1, slowMo = 0 } = {}) {
    Object.assign(this, { page, journey, pace, slowMo });
    this.x = 640;
    this.y = 460;
    this.last = null;
  }

  static bannerHeight = BANNER;

  async pause(ms) {
    await sleep(Math.round(ms * this.pace));
  }

  // Waits for the overlay in the current document, and puts back the caption and cursor
  // after a navigation
  async ready() {
    // A document the init script didn't reach (setContent) gets the overlay now
    if (!(await this.page.evaluate(() => !!window.__jv))) await this.page.evaluate(installOverlay, BANNER);
    await this.page.waitForFunction(() => window.__jv.ready);
    if (this.last) await this.show(...this.last);
    await this.page.mouse.move(this.x, this.y);
  }

  async show(text, kind) {
    this.last = [text, kind];
    const { id, title } = this.journey;
    await this.page.evaluate(([i, t, s, k]) => window.__jv.caption(i, t, s, k), [id, title, text, kind]);
  }

  // A new caption, held long enough to read. kind: step, check (what the step checks),
  // simulated (an outside service stood in for), planned (not built yet)
  async say(text, kind = "step") {
    await this.show(text, kind);
    await this.pause(Math.min(5500, Math.max(2000, 900 + 42 * text.length)));
  }

  async check(text) { await this.say(text, "check"); }
  async simulated(text) { await this.say(text, "simulated"); }
  async planned(text) { await this.say(text, "planned"); }

  // Glides the real mouse to the element's centre, in small steps so the motion shows
  async moveTo(locator) {
    await locator.waitFor({ state: "visible" });
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Nothing to point at: ${locator}`);
    const tx = box.x + box.width / 2, ty = box.y + box.height / 2;
    const dist = Math.hypot(tx - this.x, ty - this.y);
    const steps = Math.max(10, Math.min(28, Math.round(dist / 20)));
    const x0 = this.x, y0 = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await this.page.mouse.move(x0 + (tx - x0) * e, y0 + (ty - y0) * e);
      if (this.slowMo < 16) await sleep(16 - this.slowMo);
    }
    this.x = tx;
    this.y = ty;
    await this.pause(250);
  }

  async click(locator) {
    await this.moveTo(locator);
    await locator.click();
    await this.pause(550);
  }

  // Types as a person would, a key at a time, replacing what was there
  async type(locator, text, { enter = false } = {}) {
    await this.moveTo(locator);
    await locator.click();
    await locator.fill("");
    await locator.pressSequentially(text, { delay: Math.max(20, Math.round(45 * this.pace)) });
    if (enter) await locator.press("Enter");
    await this.pause(500);
  }

  async select(locator, value) {
    await this.moveTo(locator);
    await locator.selectOption(value);
    await this.pause(800);
  }

  // Clicks something that opens a file picker, and picks the file
  async chooseFile(locator, files) {
    const chooser = this.page.waitForEvent("filechooser");
    await this.click(locator);
    await (await chooser).setFiles(files);
    await this.pause(600);
  }

  // A caption shown large, over the whole page, for a step with nothing on screen to show
  async note(text, kind = "planned") {
    const label = { planned: "Not built yet", simulated: "Simulated", check: "Checks", step: "" }[kind];
    await this.page.evaluate((h) => window.__jv.card(h), `${label ? `<div class="jv-meta" style="text-transform:uppercase;letter-spacing:.08em">${esc(label)}</div>` : ""}<div class="jv-big" style="font-size:40px;line-height:1.2">${esc(text)}</div>`);
    await this.say(text, kind);
    await this.hideCard();
  }

  async card(html, ms) {
    await this.page.evaluate((h) => window.__jv.card(h), html);
    await this.pause(ms);
  }

  async hideCard() {
    await this.page.evaluate(() => window.__jv.hideCard());
  }

  // The first frames: journey, name and persona, before the app opens
  async titleCard() {
    const j = this.journey;
    await this.page.setContent("<!doctype html><title>Supply Checkout journey</title><body style='margin:0;background:#0b1b2b'></body>");
    await this.ready();
    await this.card(`<div class="jv-id">${esc(j.id)}</div><div class="jv-big">${esc(j.title)}</div>
      <div class="jv-meta">Persona: ${esc(j.persona)}${j.critical ? " · Critical journey" : ""} · Status: ${esc(j.status)}</div>
      <div class="jv-small">Supply Checkout customer journey (docs/journeys.md). Recorded against the web build with the test suite's fakes: no real AWS, Stripe or email. Captions marked Simulated stand in for an outside service; Not built yet marks what's still planned.</div>`, 4500);
  }

  async endCard() {
    const j = this.journey;
    const shown = j.shown.map((s) => `<li>${esc(s)}</li>`).join("");
    const list = (items, cls = "") => (items || []).map((s) => `<li class="${cls}">${esc(s)}</li>`).join("");
    const simulated = list(j.simulated), planned = list(j.planned, "jv-planned");
    await this.card(`<div class="jv-id">${esc(j.id)}</div><div class="jv-big" style="font-size:44px">End of ${esc(j.title)}</div>
      <div><div class="jv-meta">Shown</div><ul>${shown}</ul></div>
      ${simulated ? `<div><div class="jv-meta">Simulated in this recording</div><ul>${simulated}</ul></div>` : ""}
      ${planned ? `<div><div class="jv-meta">Not built yet</div><ul>${planned}</ul></div>` : ""}`, 6000);
  }
}
