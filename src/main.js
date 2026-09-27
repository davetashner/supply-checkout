import "./theme.js";
import { use, help } from "./runtime.js";
import { WEB } from "./build.js";
import { checkOut, recordReturn, saveItem, addLines, markOf } from "./moves.js";
import { esc, money, todayISO, fmtDate, keyOf, own, int, codeText, hasStock, hasCost, unitValue, newKey, uid, round2, numOrNull } from "./format.js";
import { lines, lineCharge, totals } from "./sheet-math.js";
import { $, toast, openModal, closeModal, arm, armButton, stepperHTML, setText, setHTML, setAttr, morph, wireStepper } from "./dom.js";
import { scanFromInput } from "./barcode.js";
import { RECEIPT_PROMPT, sampleErr } from "./receipt-prompt.js";
import { sheetCsv, sheetsCsv, inventoryCsv, allJson } from "./export.js";
import { createFirstRun } from "./first-run.js";

let db = null, userNs = null, dl = null, myId = null, canWrite = true, connected = false, isOwner = false;
// Keyed by product key, which can be any barcode's: no prototype, so a key like
// "constructor" finds nothing until there's a product with that key
let products = Object.create(null), sheets = [], people = {};
const ui = { tab: "sheets", sheetId: null, mode: "out", filter: "open", receipt: false };
// The web build's first-run checklist for an owner's new team (src/first-run.js), or null
let firstRun = null;

// sheetId: the sheet this write changes, if any, so a write to a sheet someone else deleted
// says so. claude.ai's db refuses an update to a missing document as invalid_argument, the
// same code as a viewer's write, so that asks whether the sheet is still there; the web
// build's db rejects it as not_found.
//
// Resolves to whether it saved. `retryable` then says whether it failed for the connection
// (not refused or overtaken), so the same save is worth trying again (saving() below).
// Offline, nothing is sent: it can't be confirmed, so it isn't tried.
//
// claude.ai's db has no timeout of its own, so in the artifact build a write that hasn't
// answered in WRITE_TIMEOUT fails as the connection's (the web build's requests give up
// after 15 s each, src/aws/http.js).
let retryable = false;
const WRITE_TIMEOUT = 20000;
// WEB: the web build's requests time out themselves, so the artifact build keeps only the right side
const timed = WEB ? p => p : p => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject({ code: "timeout" }), WRITE_TIMEOUT); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
async function write(fn, okMsg, sheetId) {
  retryable = false;
  if (!db) { toast("Not connected to shared storage."); return false; }
  if (!navigator.onLine) { retryable = true; toast(OFFLINE); return false; }
  try { await timed(fn()); if (okMsg) toast(okMsg); return true; }
  catch (e) {
    if (sheetId && e && (e.code === "not_found" || (e.code === "invalid_argument" && await sheetGone(sheetId)))) {
      closeModal(); toast("Someone else deleted this sheet, so your change wasn't saved.");
    }
    else if (e && e.code === "invalid_argument") { canWrite = false; await readViewOnly(); render(); toast(viewOnly || "You have view-only access. Ask the owner for Contributor access to make changes."); }
    else if (e && e.code === "quota_exceeded") toast("Storage is full. Delete old sheets or items to make room.");
    // Someone else saved this first (the web build's versioned writes, ADR 0006). Close the
    // editor so the latest values show, rather than an edit made on the old ones.
    else if (e && e.code === "aborted") { closeModal(); toast("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed."); }
    // Refused for what's saved now, such as returning more than are left (the web build's
    // checkout and return commands, src/aws/db.js): the message says why. The latest is showing.
    // `refused` is that adapter's own code, so no other write shows a raw message.
    else if (e && e.code === "refused") { closeModal(); toast(e.message); }
    // The web build's session ended (signed out, here or in another tab, or it expired): the
    // connection isn't the problem, and trying again won't help until they sign in
    else if (WEB && e && e.code === "unauthenticated") toast("You're signed out, so that wasn't saved. Sign in, then make your change again.");
    else { retryable = true; toast("That didn't save. Check your connection and try again."); }
    return false;
  }
}
const OFFLINE = "You're offline, so that wasn't saved. Try again when you're back online.";
// Why the page is read-only, when the runtime says (the web build: an owner closed the team);
// otherwise it's the viewer's role. Asked again when a write is refused, since the reason can
// change while the page is open. A runtime without it (claude.ai) throws, and the role it is.
let viewOnly = null;
async function readViewOnly() { try { viewOnly = (await userNs.viewOnlyNotice()) || null; } catch {} }

// Saves a modal's form. Until the server answers, the submit button says Saving… and nothing
// in the form can be changed, sent again or closed (src/dom.js), so a second tap can't save
// twice, and nothing shows as saved before it is. If it didn't save for the connection, what
// was entered stays, the form says it isn't saved, and the button says Try again: the same
// action again, with the same operation ID (src/moves.js), so a save whose answer was lost
// counts once. fn resolves to whether it saved.
const TRY = "Try again";
// Wires a modal form's submit. Not while it's saving: the button is disabled then, so only a
// submit that gets through anyway (a browser letting a very quick second tap through) is ignored.
const onSubmit = (form, fn) => form.addEventListener("submit", e => { e.preventDefault(); if (!form.hasAttribute("aria-busy")) fn(); });
// Closes the modal once the write saved, and resolves to whether it did
const closing = async saved => { const ok = await saved; if (ok) closeModal(); return ok; };
// Runs fn (a write, which never throws) with the form busy: its controls disabled and the
// modal kept open, so nothing in it can be sent again meanwhile. Resolves to what fn does.
async function busy(form, fn) {
  const controls = [...form.querySelectorAll("input, select, button")].filter(c => !c.disabled);
  form.setAttribute("aria-busy", "true"); controls.forEach(c => { c.disabled = true; });
  const ok = await fn();
  form.removeAttribute("aria-busy"); controls.forEach(c => { c.disabled = false; });
  return ok;
}
async function saving(form, fn) {
  const go = form.querySelector("[type=submit]"), failed = form.querySelector(".save-failed");
  if (go.textContent !== TRY) form.dataset.label = go.textContent;
  if (failed) { failed.remove(); go.removeAttribute("aria-describedby"); }
  go.textContent = "Saving…";
  const ok = await busy(form, fn);
  go.textContent = form.dataset.label;
  // Gone if it saved, or if the save closed it (someone else deleted or changed this)
  if (ok || !form.isConnected || !retryable) return;
  go.textContent = TRY;
  form.querySelector(".modal-actions").insertAdjacentHTML("beforebegin", `<p class="save-failed" id="saveFailed">${navigator.onLine ? "Not saved. Check your connection, then tap Try again." : "Not saved: you're offline. Tap Try again when you're back online."}</p>`);
  go.setAttribute("aria-describedby", "saveFailed");
  go.focus();
}

// A checkout or return whose sheet line saved but whose storage count didn't (the artifact's
// two writes, src/moves.js): the quantity can't change, so Try again finishes the same action,
// and the note says the sheet has it.
function owing(m, action) {
  if (!action.due) return;
  m.querySelectorAll(".stepper input, .stepper button").forEach(c => { c.disabled = true; });
  const note = m.querySelector("#saveFailed");
  if (note) note.textContent = "Saved on the sheet, but the storage count didn't save. Tap Try again to finish; nothing is counted twice.";
}

const currentSheet = () => sheets.find(s => s.id === ui.sheetId);
async function sheetGone(id) {
  try { return !(await db.doc("sheets/" + id).get()).exists; } catch { return false; }
}
// Show a sheet we just created right away; the next snapshot replaces this copy
const addLocalSheet = (id, body) => { if (!sheets.some(s => s.id === id)) sheets = [{ id, ...body }, ...sheets]; };
function personHTML(s) {
  if (s.createdBy) {
    const p = own(people, s.createdBy);
    return `<span class="who">${p ? `<img src="${esc(p.avatarUrl)}" alt="">` : ""}${esc((p && p.name) || "Someone")}</span>`;
  }
  return `<span class="who">${esc(s.createdByName || "Unknown")}</span>`;
}
function personText(s) { return s.createdBy ? ((own(people, s.createdBy) || {}).name || "Someone") : (s.createdByName || "Unknown"); }

/* ---------- render ---------- */
let seq = 0;
async function render() {
  const n = ++seq;
  if (userNs) {
    const ids = [...new Set(sheets.map(s => s.createdBy).filter(Boolean))];
    if (ids.length) { try { people = await userNs.profiles(ids); } catch {} }
  }
  if (n !== seq) return;
  draw();
}

function paintNotice() {
  const notice = $("#notice");
  if (!navigator.onLine) { notice.hidden = false; notice.textContent = "You're offline. Nothing can be saved until the connection is back."; }
  else if (!connected) { notice.hidden = false; notice.textContent = `Connecting to shared storage… If this doesn't clear, ${help().connecting}.`; }
  else if (!canWrite) { notice.hidden = false; notice.textContent = viewOnly || "You have view-only access. Ask the owner to give you Contributor access to scan and edit."; }
  else notice.hidden = true;
}
// Going offline and back: the notice says so, and a form that didn't save says it can be
// tried again now. (The web build's db re-lists when the connection is back, src/aws/live.js.)
window.addEventListener("offline", paintNotice);
window.addEventListener("online", () => {
  paintNotice();
  const f = $("#saveFailed"); if (f) f.textContent = "Not saved yet. You're back online: tap Try again.";
});

// The view, then the first-run checklist above the sheet list or inventory (web build)
function draw() {
  drawView();
  if (WEB && firstRun) firstRun.draw(connected && !$("#main").hidden, Object.keys(products).length, sheets.length);
}
function drawView() {
  $("#tab-sheets").setAttribute("aria-pressed", ui.tab === "sheets");
  $("#tab-prices").setAttribute("aria-pressed", ui.tab === "prices");
  paintNotice();

  $("#receiptView").hidden = !ui.receipt;
  if (ui.receipt) { $("#main").hidden = true; $("#sheetView").hidden = true; return; }
  const sheet = ui.tab === "sheets" && ui.sheetId ? currentSheet() : null;
  if (ui.tab === "sheets" && ui.sheetId && !sheet && connected) ui.sheetId = null;
  $("#sheetView").hidden = !sheet;
  $("#main").hidden = !!sheet;
  if (sheet) drawSheet(sheet);
  else if (ui.tab === "prices") drawPrices();
  else drawList();
}

// #main (the sheet list and inventory) is redrawn on every snapshot. morph() keeps the
// elements that didn't change, so a tap in progress survives; its events are delegated
// here instead of wired on each redraw.
$("#main").addEventListener("click", e => {
  const t = e.target.closest("button, tr[data-prod]");
  if (!t) return;
  if (t.id === "newSheet") newSheetModal();
  else if (t.id === "exportAll") exportAllModal();
  else if (t.id === "resume") { ui.receipt = true; draw(); renderReceipt(); window.scrollTo(0, 0); }
  else if (t.id === "addProduct") productModal(null);
  else if (t.dataset.filter) { ui.filter = t.dataset.filter; draw(); }
  else if (t.dataset.open) { ui.sheetId = t.dataset.open; draw(); window.scrollTo(0, 0); }
  else if (t.dataset.prod && canWrite) productModal(t.dataset.prod);
});
// preventDefault: otherwise this Enter press also submits the editor's form
$("#main").addEventListener("keydown", e => {
  const tr = e.key === "Enter" && canWrite && e.target.closest("tr[data-prod]");
  if (tr) { e.preventDefault(); productModal(tr.dataset.prod); }
});

function drawList() {
  const shown = sheets.filter(s => ui.filter === "all" || (ui.filter === "open" ? s.status !== "closed" : s.status === "closed"));
  const openCount = sheets.filter(s => s.status !== "closed").length;
  morph($("#main"), `
    <div class="bar">
      <div class="chips" role="group" aria-label="Filter sheets">
        <button type="button" class="chip" data-filter="open" aria-pressed="${ui.filter==="open"}">Out now (${openCount})</button>
        <button type="button" class="chip" data-filter="closed" aria-pressed="${ui.filter==="closed"}">Returned</button>
        <button type="button" class="chip" data-filter="all" aria-pressed="${ui.filter==="all"}">All</button>
      </div>
      <div class="chips">
        ${canWrite && receiptOK ? `<label class="btn" for="receiptFile">Scan receipt</label>` : ""}
        ${dl && isOwner && connected ? `<button type="button" class="btn" id="exportAll">Export data</button>` : ""}
        ${canWrite ? `<button type="button" class="btn primary" id="newSheet">+ New sheet</button>` : ""}
      </div>
    </div>
    ${draft && canWrite ? `<div class="notice resume"><span>You have a receipt that hasn't been saved yet.</span><button type="button" class="btn" id="resume">Continue review</button></div>` : ""}
    <div class="list">
      ${shown.length ? shown.map(s => { const t = totals(s); const closed = s.status === "closed"; return `
        <button type="button" class="sheet-card" data-open="${esc(s.id)}">
          <h3>${esc(s.client || "Untitled")}</h3>
          <div class="right">
            <span class="pill ${closed ? "closed" : "open"}">${closed ? "Returned" : "Checked out"}</span>
            <span class="num">${money(closed ? t.charge : t.value)}</span>
          </div>
          <div class="meta"><span>${esc(fmtDate(s.date))}</span>${personHTML(s)}<span>${t.count} item${t.count===1?"":"s"} · ${t.out} taken${t.ret ? ` · ${t.ret} back` : ""}</span></div>
        </button>`; }).join("") : `<div class="empty">${connected ? (ui.filter === "open" ? "Nothing is checked out right now." : "No sheets here yet.") : "Loading sheets…"}</div>`}
    </div>`);
}

function drawSheet(s) {
  const closed = s.status === "closed", t = totals(s), ls = lines(s);
  morph($("#sheetHead"), `
    <div class="sheet-head">
      <h2>${esc(s.client || "Untitled")}</h2>
      <div class="meta"><span>${esc(fmtDate(s.date))}</span><span>Prepared by ${personHTML(s)}</span><span class="pill ${closed ? "closed" : "open"}">${closed ? "Returned" : "Checked out"}</span></div>
      <div class="sheet-actions">
        ${dl ? `<button type="button" class="btn" id="exportCsv">Download CSV</button>` : ""}
        ${canWrite ? `<button type="button" class="btn" id="editSheet">Edit details</button>` : ""}
        ${canWrite ? (closed ? actionButton("reopen", "btn", "Reopen") : actionButton("closeSheet", "btn", "Finished Return")) : ""}
      </div>
    </div>`);
  // Each only changes the DOM when its value changes (toggleAttribute too)
  $("#scanbar").toggleAttribute("hidden", closed || !canWrite);
  document.querySelectorAll(".mode button").forEach(b => setAttr(b, "aria-pressed", b.dataset.mode === ui.mode));
  setText($("#scanLabel"), ui.mode === "out" ? "Scan to check out" : "Scan to return");
  setText($("#noCodeBtn"), ui.mode === "out" ? "Add item without a barcode" : "Return item without a barcode");
  setText($("#modeHint"), ui.mode === "out"
    ? "Take a photo of the barcode, then choose how many you're taking."
    : "Scan an item you're bringing back and enter how many are unused. Whatever isn't returned counts as used. Tap Finished Return when everything is back.");

  morph($("#sheetBody"), `
    <div class="totals">
      <div><div class="k">Taken</div><div class="v">${t.out}</div></div>
      <div><div class="k">Returned</div><div class="v">${t.ret}</div></div>
      <div><div class="k">Used</div><div class="v">${t.used}</div></div>
      <div><div class="k">Charge</div><div class="v charge">${money(t.charge)}</div></div>
    </div>
    ${ls.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Price</th><th>Taken</th><th>Returned</th><th>Used</th><th>Charge</th></tr></thead>
      <tbody>${ls.map(l => { const o = int(l.out), r = Math.min(int(l.returned), o), u = o - r; return `
        <tr class="${canWrite ? "click" : ""}" data-line="${esc(l.key)}" ${canWrite ? 'tabindex="0"' : ""}>
          <td>${esc(l.name || "Unnamed item")}<span class="code">${esc(codeText(l.code))}</span></td>
          <td>${money(l.price)}</td><td>${o}</td><td>${r}</td>
          <td>${u}</td><td class="charge">${money(lineCharge(l))}</td>
        </tr>`; }).join("")}</tbody>
      <tfoot><tr><td>Total</td><td></td><td>${t.out}</td><td>${t.ret}</td><td>${t.used}</td><td>${money(t.charge)}</td></tr></tfoot>
    </table></div>` : `<div class="empty">No supplies on this sheet yet. Scan a barcode to check one out.</div>`}
    ${canWrite ? `<div class="sheet-actions" style="margin-top:18px">${actionButton("delSheet", "btn danger", "Delete sheet")}</div>` : ""}`);
}

// Finishing, reopening or deleting the sheet, while its write is on its way: that button says
// Saving… and every one of them is disabled, redraws included, so a second tap sends nothing
let pending = null;
const actionButton = (id, cls, label) => `<button type="button" class="${cls}" id="${id}"${pending ? ` disabled${pending === id ? ' aria-busy="true"' : ""}` : ""}>${pending === id ? "Saving…" : label}</button>`;
async function once(id, fn) {
  if (pending) return;
  pending = id; draw();
  await fn();
  pending = null; draw();
}

// The sheet view is redrawn on every snapshot, with morph() like #main. Its events are
// delegated here, and each looks up the sheet when it runs, so it acts on the latest copy.
const sheetAction = {
  exportCsv: () => exportCsv(currentSheet()),
  editSheet: () => newSheetModal(currentSheet()),
  closeSheet: () => once("closeSheet", () => write(() => db.doc("sheets/" + ui.sheetId).update({ status: "closed", closedAt: new Date().toISOString() }), "Return finished", ui.sheetId)),
  reopen: () => once("reopen", () => write(() => db.doc("sheets/" + ui.sheetId).update({ status: "open" }), "Sheet reopened", ui.sheetId)),
  delSheet: b => arm(b, "Tap again to delete", () => once("delSheet", async () => {
    const id = ui.sheetId;
    if (await write(() => db.doc("sheets/" + id).delete(), "Sheet deleted", id)) ui.sheetId = null;
  })),
};
["#sheetHead", "#sheetBody"].forEach(sel => {
  $(sel).addEventListener("click", e => {
    const t = e.target.closest("button, tr[data-line]");
    if (!t) return;
    if (t.dataset.line) { if (canWrite) lineModal(currentSheet(), t.dataset.line); }
    else sheetAction[t.id](t);
  });
});
// preventDefault: otherwise this Enter press also submits the editor's form
$("#sheetBody").addEventListener("keydown", e => {
  const tr = e.key === "Enter" && canWrite && e.target.closest("tr[data-line]");
  if (tr) { e.preventDefault(); lineModal(currentSheet(), tr.dataset.line); }
});

function drawPrices() {
  const list = Object.entries(products).map(([key, p]) => ({ key, ...p })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  morph($("#main"), `
    <div class="bar">
      <p class="muted" style="margin:0">${list.length} item${list.length===1?"":"s"}. Storage counts go down when items are checked out and up when they're returned or bought for general inventory.</p>
      ${canWrite ? `<button type="button" class="btn primary" id="addProduct">+ Add item</button>` : ""}
    </div>
    ${list.length ? `<div class="table-wrap"><table class="prices">
      <thead><tr><th>Item</th><th>In storage</th><th>Price each</th><th>Cost each</th><th>Value</th></tr></thead>
      <tbody>${list.map(p => `<tr class="${canWrite ? "click" : ""}" data-prod="${esc(p.key)}" ${canWrite ? 'tabindex="0"' : ""}><td>${esc(p.name || "Unnamed item")}<span class="code">${esc(codeText(p.code))}</span></td><td class="${hasStock(p) ? "" : "muted"}">${hasStock(p) ? p.stock : "—"}</td><td>${money(p.price)}</td><td class="${hasCost(p) ? "" : "muted"}">${hasCost(p) ? money(p.cost) : "—"}</td><td>${hasStock(p) ? money(storageCents(p) / 100) : "—"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total in storage</td><td>${list.reduce((a, p) => a + (hasStock(p) ? p.stock : 0), 0)}</td><td></td><td></td><td>${money(list.reduce((a, p) => a + storageCents(p), 0) / 100)}</td></tr></tfoot>
    </table></div>` : `<div class="empty">${connected ? "No items yet. Add one, or scan a barcode on a sheet." : "Loading…"}</div>`}`);
}

function newSheetModal(existing) {
  const editing = existing && existing.id;
  const needName = !editing && !myId;
  openModal(`
    <h2>${editing ? "Edit sheet" : "New sheet"}</h2>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fClient">Client</label><input type="text" id="fClient" required data-autofocus value="${esc(editing ? existing.client : "")}" placeholder="Client or job name"></div>
      <div class="field"><label for="fDate">Date</label><input type="date" id="fDate" required value="${esc(editing ? existing.date : todayISO())}"></div>
      ${needName ? `<div class="field"><label for="fBy">Prepared by</label><input type="text" id="fBy" required placeholder="Your name"></div>` : ""}
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">${editing ? "Save" : "Create sheet"}</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    // One new sheet per form: trying again saves the same sheet, so a save whose answer was
    // lost doesn't make a second one
    let ref, createdAt;
    const form = m.querySelector("#f");
    onSubmit(form, () => {
      const client = m.querySelector("#fClient").value.trim(), date = m.querySelector("#fDate").value;
      if (!client || !date) return;
      if (editing) {
        saving(form, () => closing(write(() => db.doc("sheets/" + existing.id).update({ client, date }), "Saved", existing.id)));
        return;
      }
      createdAt ||= new Date().toISOString();
      const body = { client, date, createdBy: myId || null, createdAt, status: "open", items: {} };
      if (needName) body.createdByName = m.querySelector("#fBy").value.trim();
      saving(form, async () => {
        const ok = await write(() => (ref ||= db.collection("sheets").doc()).set(body), "Sheet created");
        if (ok) { addLocalSheet(ref.id, body); closeModal(); ui.sheetId = ref.id; ui.mode = "out"; draw(); }
        return ok;
      });
    });
  });
}

function checkoutModal(s, code, key = keyOf(code)) {
  const prod = products[key], line = own(s.items || {}, key), action = {};
  openModal(`
    <h2>Check out</h2>
    <div class="code">${esc(codeText(code))}</div>
    <form id="f" style="display:grid;gap:14px">
      ${prod ? `<div class="item-known"><strong>${esc(prod.name)}</strong><span class="num">${money(prod.price)} each</span></div>${hasStock(prod) ? `<div class="summary"><span>In storage</span><b>${prod.stock}</b></div>` : ""}`
             : `<p class="hint" style="margin-top:-4px">${code ? "New barcode. Name it and set a price, and it'll be saved to inventory." : "Name the item and set a price."}</p>
                <div class="field"><label for="fName">Item name</label><input type="text" id="fName" required data-autofocus placeholder="${code ? "e.g. Nitrile gloves, box of 100" : "e.g. Leftover storage bins"}"></div>
                <div class="field"><label for="fPrice">Price each ($)</label><input type="number" id="fPrice" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>
                ${code ? "" : `<label class="check"><input type="checkbox" id="fSave" checked> Save to inventory for next time</label>`}`}
      ${line ? `<div class="summary"><span>Already on this sheet</span><b>${int(line.out)} taken</b></div>` : ""}
      <div class="field"><label for="fQty">How many are you taking?</label>${stepperHTML("fQty", 1)}</div>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary" id="go">Add to sheet</button></div>
    </form>`, m => {
    const getQty = wireStepper(m, "fQty", v => setText(m.querySelector("#go"), `Add ${v} to sheet`));
    m.querySelector("#go").textContent = "Add 1 to sheet";
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const form = m.querySelector("#f");
    onSubmit(form, () => {
      const qty = getQty(); if (!qty) { toast("Choose at least 1."); return; }
      let name = prod && prod.name, price = prod ? Number(prod.price) || 0 : 0, oneOff = {}, save = false;
      if (!prod) {
        // A typed price is kept in whole cents, as the API takes it (ADR 0014)
        name = m.querySelector("#fName").value.trim(); price = Math.max(0, round2(m.querySelector("#fPrice").value));
        if (!name) return;
        save = code || m.querySelector("#fSave").checked;
        // Not saved to inventory: the line's name and price come from here
        if (!save) oneOff = { name, price, code };
      }
      saving(form, async () => {
        // Saved once per action: a retry after the checkout failed doesn't save it again
        if (save && !action.saved) {
          if (!await write(() => db.doc("products/" + key).set({ code, name, price, updatedAt: new Date().toISOString() }))) return false;
          action.saved = true;
        }
        const fresh = currentSheet() || s, cur = own(fresh.items || {}, key);
        // A new line copies the item's cost too (ADR 0014); an existing line keeps its snapshot
        const from = cur || prod, cost = from && hasCost(from) ? { cost: from.cost } : {};
        const item = { code, name: cur ? cur.name : name, price: cur ? cur.price : price, ...cost, out: int(cur && cur.out) + qty, returned: int(cur && cur.returned) };
        return closing(write(() => checkOut(db, action, s.id, key, qty, item, oneOff), `Checked out ${qty} × ${item.name}`, s.id));
      }).then(() => owing(m, action));
    });
  });
}

function pickOutModal(s) {
  const all = Object.entries(products).map(([key, p]) => ({ key, ...p })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  openModal(`
    <h2>Add without barcode</h2>
    <button type="button" class="btn primary" id="newItem">+ New item</button>
    ${all.length ? `<div class="field"><label for="fFind">Or pick from inventory</label><input type="search" id="fFind" placeholder="Search items" autocomplete="off"></div>
    <div class="pick" id="pick"></div>` : ""}
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelector("#newItem").addEventListener("click", () => checkoutModal(s, "", newKey()));
    const box = m.querySelector("#pick"), find = m.querySelector("#fFind");
    if (!box) return;
    const paint = () => {
      const q = find.value.trim().toLowerCase();
      const hits = all.filter(p => !q || String(p.name).toLowerCase().includes(q) || String(p.code || "").toLowerCase().includes(q));
      box.innerHTML = hits.length ? hits.map(p => `<button type="button" data-k="${esc(p.key)}"><span>${esc(p.name)}<span class="code" style="display:block">${esc(codeText(p.code))}</span></span><span class="num">${hasStock(p) ? p.stock + " in storage" : money(p.price)}</span></button>`).join("") : `<p class="hint">No matches. Use + New item.</p>`;
      box.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { const p = products[b.dataset.k] || {}; checkoutModal(s, p.code || "", b.dataset.k); }));
    };
    find.addEventListener("input", paint); paint();
  });
}

function pickReturnModal(s) {
  const ls = lines(s);
  openModal(`
    <h2>Return an item</h2>
    <p class="hint" style="margin-top:-6px">Pick the item you're bringing back.</p>
    ${ls.length ? `<div class="pick">${ls.map(l => `<button type="button" data-k="${esc(l.key)}"><span>${esc(l.name)}<span class="code" style="display:block">${esc(codeText(l.code))}</span></span><span class="num">${int(l.out)} taken</span></button>`).join("")}</div>` : `<p>Nothing has been checked out on this sheet yet.</p>`}
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { const l = own(s.items || {}, b.dataset.k) || {}; returnModal(s, l.code || "", b.dataset.k); }));
  });
}

function returnModal(s, code, key = keyOf(code)) {
  const line = own(s.items || {}, key), prod = products[key], action = {};
  if (!line) {
    openModal(`
      <h2>Not on this sheet</h2>
      <div class="code">${esc(codeText(code))}</div>
      <p style="margin:0">${prod ? `<strong>${esc(prod.name)}</strong> wasn't` : "This item wasn't"} checked out on this sheet, so there's nothing to return.</p>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Close</button><button type="button" class="btn primary" id="switch">Check it out instead</button></div>`, m => {
      m.querySelector("#cancel").addEventListener("click", closeModal);
      m.querySelector("#switch").addEventListener("click", () => { ui.mode = "out"; draw(); checkoutModal(s, code, key); });
    });
    return;
  }
  const o = int(line.out), price = Number(line.price) || 0;
  const already = Math.min(int(line.returned), o), left = o - already;
  if (!left) {
    openModal(`
      <h2>Already returned</h2>
      <div class="code">${esc(codeText(code))}</div>
      <p style="margin:0">All ${o} of <strong>${esc(line.name)}</strong> have been returned. To correct the counts, tap the item's row on the sheet.</p>
      <div class="modal-actions"><button type="button" class="btn primary" id="cancel">Close</button></div>`, m => {
      m.querySelector("#cancel").addEventListener("click", closeModal);
    });
    return;
  }
  openModal(`
    <h2>Return</h2>
    <div class="code">${esc(codeText(code))}</div>
    <div class="item-known"><strong>${esc(line.name)}</strong><span class="num">${o} taken${already ? ` · ${already} back` : ""}</span></div>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fRet">How many are you returning now?</label>${stepperHTML("fRet", 1, left)}</div>
      <div class="summary" id="sum"></div>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save return</button></div>
    </form>`, m => {
    const paint = r => {
      const back = already + Math.min(int(r), left);
      setHTML(m.querySelector("#sum"), `<span>Returned <b>${back}</b> of ${o}</span><span>Used <b>${o - back}</b></span><span>Charge <b>${money((o - back) * price)}</b></span>`);
    };
    const getR = wireStepper(m, "fRet", paint); paint(1);
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const form = m.querySelector("#f");
    onSubmit(form, () => {
      const r = getR(); if (!r) { toast("Choose at least 1."); return; }
      saving(form, async () => {
        const cur = own((currentSheet() || s).items || {}, key) || line;
        return closing(write(async () => {
          const done = await recordReturn(db, action, s.id, key, r, cur);
          toast(`${done.quantity} returned · ${int(done.line.returned)} of ${int(done.line.out)} back`);
        }, undefined, s.id));
      }).then(() => owing(m, action));
    });
  });
}

function lineModal(s, key) {
  const l = own(s.items || {}, key); if (!l) return;
  openModal(`
    <h2>${esc(l.name || "Item")}</h2>
    <div class="code">${esc(codeText(l.code))}</div>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fPrice">Price each on this sheet ($)</label><input type="number" id="fPrice" min="0" step="0.01" inputmode="decimal" value="${Number(l.price) || 0}"></div>
      <div class="row2">
        <div class="field"><label for="fOut">Taken</label><input type="number" id="fOut" min="0" inputmode="numeric" value="${int(l.out)}"></div>
        <div class="field"><label for="fRet">Returned</label><input type="number" id="fRet" min="0" inputmode="numeric" value="${int(l.returned)}"></div>
      </div>
      <div class="modal-actions"><button type="button" class="btn danger" id="remove">Remove</button><span class="spacer"></span><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const form = m.querySelector("#f");
    // The form is busy until it's removed, so it's removed once
    armButton(m.querySelector("#remove"), "Tap to remove", () => busy(form, () => closing(write(async () => {
      // Saved as the whole sheet without the line, so only if the sheet is still there:
      // a set would make a sheet someone else deleted again
      const ref = db.doc("sheets/" + s.id);
      const got = await ref.get();
      if (!got.exists) throw { code: "not_found" };
      const body = got.data(); body.items = { ...(body.items || {}) }; delete body.items[key];
      await ref.set(body);
    }, "Removed", s.id))));
    onSubmit(form, () => {
      const out = int(m.querySelector("#fOut").value), returned = Math.min(int(m.querySelector("#fRet").value), out);
      // Typed prices are kept in whole cents (ADR 0014)
      const price = Math.max(0, round2(m.querySelector("#fPrice").value));
      saving(form, () => closing(write(() => db.doc("sheets/" + s.id).update({ items: { [key]: { out, returned, price } } }), "Saved", s.id)));
    });
  });
}

// An item's storage value in whole cents (ADR 0014): its count times its cost each, or
// its price each where the cost isn't known
const MAX_PACK = 10000;
const storageCents = p => hasStock(p) ? Math.round(p.stock * round2(unitValue(p)) * 100) : 0;

function productModal(key) {
  const p = key ? products[key] : null;
  // One count per form: every attempt at saving the same count is the same stock command.
  // And one key for a new item without a barcode, so trying again doesn't make a second item.
  const action = {}, newItemKey = newKey();
  openModal(`
    <h2>${p ? "Edit item" : "Add item"}</h2>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fCode">Barcode${p ? "" : " (optional)"}</label>
        ${p ? `<div class="code" style="margin:0">${esc(codeText(p.code))}</div>`
            : `<div class="manual"><input type="text" id="fCode" inputmode="numeric" autocomplete="off" placeholder="Type, scan, or leave blank"><label class="btn" for="fScan">Scan</label></div><input class="vh" type="file" id="fScan" accept="image/*" capture="environment">`}
      </div>
      <div class="field"><label for="fName">Item name</label><input type="text" id="fName" required value="${esc(p ? p.name : "")}" ${p ? "data-autofocus" : ""}></div>
      <div class="field"><label for="fPrice">Price each ($)</label><input type="number" id="fPrice" min="0" step="0.01" inputmode="decimal" value="${p ? round2(p.price) : ""}" placeholder="0.00"></div>
      <div class="field"><label for="fCost">Cost each ($)</label><input type="number" id="fCost" min="0" step="0.01" inputmode="decimal" value="${p && hasCost(p) ? round2(p.cost) : ""}" placeholder="Leave blank if not known"></div>
      <div class="field"><label for="fStock">In storage now</label><input type="number" id="fStock" min="0" inputmode="numeric" value="${hasStock(p) ? p.stock : ""}" placeholder="Leave blank if not counted"></div>
      <div class="field"><label for="fPack">Comes in packs of</label><input type="number" id="fPack" min="1" max="${MAX_PACK}" step="1" inputmode="numeric" value="${p && Number.isInteger(p.packSize) ? p.packSize : ""}" placeholder="1"></div>
      <p class="hint">Price is what a client is charged. Cost is what you paid each, before tax, and isn't shown on sheets. Storage counts single items, not packs.</p>
      ${p ? `<p class="hint">Price changes apply to new checkouts. Sheets keep the price they were checked out at; change it on a sheet by tapping the row.</p>` : ""}
      <div class="modal-actions">${p ? `<button type="button" class="btn danger" id="remove">Delete</button><span class="spacer"></span>` : ""}<button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const scan = m.querySelector("#fScan");
    scan && scan.addEventListener("change", async () => { const c = await scanFromInput(scan); if (c) m.querySelector("#fCode").value = c; });
    const rm = m.querySelector("#remove"), form = m.querySelector("#f");
    rm && armButton(rm, "Tap to delete", () => busy(form, () => closing(write(() => db.doc("products/" + key).delete(), "Item deleted"))));
    onSubmit(form, () => {
      const code = p ? (p.code || "") : m.querySelector("#fCode").value.trim();
      const name = m.querySelector("#fName").value.trim(), price = Math.max(0, round2(m.querySelector("#fPrice").value));
      if (!name) return;
      const docKey = p ? key : (code ? keyOf(code) : newItemKey);
      // set replaces the whole item, so start from what's there: fields this form doesn't
      // manage survive an edit (ADR 0014). A blank optional field removes it.
      const body = { ...(p || {}), code, name, price, updatedAt: new Date().toISOString() };
      const opt = (id, field, val) => { const v = m.querySelector(id).value.trim(); if (v === "") delete body[field]; else body[field] = val(v); };
      opt("#fStock", "stock", int);
      opt("#fCost", "cost", v => Math.max(0, round2(v)));
      opt("#fPack", "packSize", v => Math.min(MAX_PACK, Math.max(1, int(v))));
      saving(form, () => closing(write(() => saveItem(db, action, docKey, body, { reason: "count", count: body.stock }), "Saved")));
    });
  });
}

function keyForCode(code) {
  const k = keyOf(code); if (products[k]) return k;
  return Object.keys(products).find(x => products[x].code === code) || k;
}
function handleCode(code) {
  const s = currentSheet(); if (!s || !code) return;
  if (ui.mode === "out") { checkoutModal(s, code, keyForCode(code)); return; }
  const items = s.items || {};
  const onSheet = Object.keys(items).find(k => k === keyOf(code) || items[k].code === code);
  returnModal(s, code, onSheet || keyForCode(code));
}

/* ---------- export ---------- */
async function save(filename, data) {
  try { await dl.save({ filename, data }); return true; }
  catch (e) { if (e && e.code !== "declined") toast("Couldn't prepare the download here."); return false; }
}
function exportCsv(s) {
  return save(`${[(s.client || "sheet").replace(/[\\/:*?"<>|]/g, ""), s.date].filter(Boolean).join(" ").trim()}.csv`, sheetCsv(s, personText(s)));
}

// Owners download every sheet and the inventory, whatever their write access (a team
// that's read-only after cancelling can still take its data)
function exportAllModal() {
  const n = sheets.length, k = Object.keys(products).length;
  openModal(`
    <h2>Export all data</h2>
    <p class="hint" style="margin-top:-6px">${n} sheet${n === 1 ? "" : "s"} and ${k} inventory item${k === 1 ? "" : "s"}, as the app shows them. CSV files open in a spreadsheet; the JSON file has everything, for a backup or another tool.</p>
    <div style="display:grid;gap:10px">
      <button type="button" class="btn" data-export="sheets">Sheets (CSV)</button>
      <button type="button" class="btn" data-export="inventory">Inventory (CSV)</button>
      <button type="button" class="btn" data-export="json">Everything (JSON)</button>
    </div>
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Close</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const day = todayISO();
    const files = {
      sheets: () => [`Supply Checkout sheets ${day}.csv`, sheetsCsv(sheets, personText)],
      inventory: () => [`Supply Checkout inventory ${day}.csv`, inventoryCsv(products)],
      json: () => [`Supply Checkout export ${day}.json`, allJson(products, sheets, personText)],
    };
    m.querySelectorAll("[data-export]").forEach(b => b.addEventListener("click", () => save(...files[b.dataset.export]())));
  });
}

/* ---------- wiring ---------- */
$("#tab-sheets").addEventListener("click", () => { ui.tab = "sheets"; ui.sheetId = null; ui.receipt = false; draw(); });
$("#tab-prices").addEventListener("click", () => { ui.tab = "prices"; ui.receipt = false; draw(); });
/* ---------- receipts ---------- */
// The artifact keeps one draft. The web build's runtime names a key per team (use("drafts"),
// src/aws/account.js), so it's read once the team is known; its drafts are forgotten on
// sign-out and when someone else signs in (src/aws/session.js). The web build's key is read on
// every load and save: it's null once the session has ended, and then nothing is read or kept,
// so a save that fails as the session ends (someone else signed in in another tab, whose
// sign-in forgot this user's drafts) can't write this user's draft back.
const DKEY = "supplyCheckout.receiptDraft";
let draftKeyNow = () => DKEY;
// rSaving: a receipt is being saved (saveReceipt)
let sampleFn = null, receiptOK = false, draft = null, rSaving = false;
const stored = fn => { const k = draftKeyNow(); if (WEB && !k) return; try { fn(k); } catch {} };
const loadDraft = () => stored(k => { draft = JSON.parse(localStorage.getItem(k) || "null"); });
if (!WEB) loadDraft();
const saveDraft = () => stored(k => { draft ? localStorage.setItem(k, JSON.stringify(draft)) : localStorage.removeItem(k); });

function receiptPrompt() {
  const inv = Object.entries(products).slice(0, 500);
  const ids = Object.create(null);
  const list = inv.map(([k, p], i) => { ids["i" + (i + 1)] = k; return `i${i + 1} | ${String(p.name || "").replace(/\s+/g, " ").slice(0, 120)} | ${money(p.price)}`; }).join("\n");
  return { prompt: RECEIPT_PROMPT + "\n\nCurrent inventory (id | name | price):\n" + (list || "(empty)"), ids };
}

function receiptError(msg) {
  $("#rBody").innerHTML = `<div class="reading"><h2>Couldn't read that receipt</h2><p>${esc(msg)}</p>
    <div class="sheet-actions"><label class="btn primary" for="receiptFile">Try another photo</label><button type="button" class="btn" id="rManual">Enter items by hand</button></div></div>`;
  $("#rManual").addEventListener("click", () => { draft = newDraft({ items: [{ name: "", qty: 1, price: 0 }] }); saveDraft(); renderReceipt(); });
}

// usePrice: "receipt" (charge the receipt price), "inv" (keep the client price), or "" for the
// default. perEach: the store sold singles, so a pack item's receipt price is per each.
function newLine(o) { return { id: uid(), name: "", raw: "", qty: 1, price: 0, dest: "", code: "", match: "", suggested: false, useName: "inv", usePrice: "", perEach: false, ...o }; }
const lineProd = l => (l.match && products[l.match]) || null;
const effName = l => { const p = lineProd(l); return p && l.useName === "inv" ? p.name : l.name.trim(); };
// Units (ADR 0014): a matched item that comes in packs of n takes the receipt's quantity and
// price as per pack, unless the reviewer says it was priced per each
const packSizeOf = p => p && Number.isInteger(p.packSize) && p.packSize > 1 ? p.packSize : 1;
const packOf = l => l.perEach ? 1 : packSizeOf(lineProd(l));
const eaches = l => int(l.qty) * packOf(l);
// What one each cost, before tax, in cents
const unitCost = l => Math.max(0, round2((Number(l.price) || 0) / packOf(l)));
// Keep the client price by default when the item has a cost and its price is above it (a markup)
const priceChoice = l => { const p = lineProd(l); return l.usePrice || (p && hasCost(p) && p.price > p.cost ? "inv" : "receipt"); };
const effPrice = l => { const p = lineProd(l); return p && priceChoice(l) === "inv" ? round2(p.price) : unitCost(l); };
const charge = l => round2(eaches(l) * effPrice(l));
const lineNote = l => packOf(l) > 1 ? `${eaches(l)} each, cost ${money(unitCost(l))} each` : "";
let rScanLine = null;

function newDraft(res) {
  const date = typeof res.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(res.date) ? res.date : todayISO();
  const d1 = uid();
  return {
    store: typeof res.store === "string" ? res.store.trim() : "", receiptDate: date, date: todayISO(),
    subtotal: numOrNull(res.subtotal), tax: numOrNull(res.tax), total: numOrNull(res.total),
    savePrices: true, by: "",
    dests: [{ id: d1, sheetId: "", client: "" }],
    lines: res.items.map(it => newLine({ name: String(it.name || "").trim(), raw: String(it.raw || "").trim(), qty: Math.max(1, Math.round(Number(it.qty) || 1)), price: round2(it.price), match: it.match || "", suggested: !!it.match, dest: d1 })),
  };
}

async function startReceipt(file) {
  ui.receipt = true; draw(); window.scrollTo(0, 0);
  const ctl = new AbortController();
  $("#rBody").innerHTML = `<div class="reading"><h2>Reading receipt…</h2><p class="muted">This usually takes 15 to 60 seconds. You'll be able to check everything before it's saved.</p><button type="button" class="btn" id="rStop">Stop</button></div>`;
  $("#rStop").addEventListener("click", () => ctl.abort());
  try {
    const { prompt, ids } = receiptPrompt();
    const res = await sampleFn.json(prompt, { images: file, signal: ctl.signal });
    const items = res && Array.isArray(res.items) ? res.items.filter(i => i && i.name).map(i => ({ ...i, match: own(ids, i.match) || "" })) : [];
    if (!items.length) { receiptError("No line items were found in that photo. Lay the receipt flat, fill the frame, and make sure the text is in focus."); return; }
    draft = newDraft({ ...res, items }); saveDraft(); renderReceipt();
  } catch (e) {
    if (e && e.code === "cancelled") { ui.receipt = false; draw(); return; }
    receiptError(sampleErr(e && e.code));
  }
}

function destLabel(x, i) {
  if (x.sheetId) { const s = sheets.find(s => s.id === x.sheetId); return s ? `${s.client} (existing sheet)` : "Missing sheet"; }
  return x.client.trim() || `Client ${i + 1}`;
}
function destOptions(sel) {
  return draft.dests.map((x, i) => `<option value="${x.id}" ${sel === x.id ? "selected" : ""}>${esc(destLabel(x, i))}</option>`).join("")
    + `<option value="stock" ${sel === "stock" ? "selected" : ""}>General inventory (storage)</option>`;
}

function renderReceipt() {
  const d = draft; if (!d) { ui.receipt = false; draw(); return; }
  const openSheets = sheets.filter(s => s.status !== "closed");
  $("#rBody").innerHTML = `
    <fieldset id="rForm" ${d.locked ? "disabled" : ""}>
    <div class="sheet-head">
      <h2>Review receipt</h2>
      <div class="meta">${d.store ? `<span>${esc(d.store)}</span>` : ""}<span>Purchased ${esc(fmtDate(d.receiptDate))}</span></div>
      <p class="hint">Check each item's name, quantity and price, then choose which client it's for, or General inventory for supplies going into storage. If one item is shared, tap Split and divide the quantity. Nothing is saved until you tap Save.</p>
    </div>
    <div class="panel">
      <h3>Clients on this trip</h3>
      <div class="dests">${d.dests.map((x, i) => `
        <div class="dest" data-d="${x.id}">
          <select data-dsel aria-label="Sheet for client ${i + 1}">
            <option value="">New sheet</option>
            ${openSheets.map(s => `<option value="${esc(s.id)}" ${x.sheetId === s.id ? "selected" : ""}>Add to ${esc(s.client)} (${esc(fmtDate(s.date))})</option>`).join("")}
          </select>
          ${x.sheetId ? "" : `<input type="text" data-dname id="dname-${x.id}" placeholder="Client name" value="${esc(x.client)}" aria-label="Client name">`}
          ${d.dests.length > 1 ? `<button type="button" class="btn ghost" data-drm aria-label="Remove this client">Remove</button>` : ""}
        </div>`).join("")}</div>
      <button type="button" class="btn" id="rAddDest">+ Add another client</button>
      <div class="row2">
        <div class="field"><label for="rDate">Date for new sheets</label><input type="date" id="rDate" value="${esc(d.date)}"></div>
        ${myId ? "" : `<div class="field"><label for="rBy">Prepared by</label><input type="text" id="rBy" value="${esc(d.by)}" placeholder="Your name"></div>`}
      </div>
    </div>
    <h3 class="rhead">Items (${d.lines.length})</h3>
    <div class="rlines">${d.lines.map(lineHTML).join("")}</div>
    <input class="vh" type="file" id="rScanFile" accept="image/*" capture="environment" aria-label="Barcode photo for this item">
    <button type="button" class="btn" id="rAddLine">+ Add item</button>
    <div class="panel" id="rSum"></div>
    <label class="check"><input type="checkbox" id="rSavePrices" ${d.savePrices ? "checked" : ""}> Also add client items to inventory with their prices</label>
    </fieldset>
    ${d.locked && !rSaving ? `<p class="hint warn" id="rLocked">Not saved yet: the answer didn't come back, so part of this receipt may have saved. Tap Try again to finish. It can't be changed until it's saved, so nothing is added twice.</p>` : ""}
    <div class="modal-actions"><button type="button" class="btn danger" id="rDiscard" ${rSaving ? "disabled" : ""}>Discard</button><span class="spacer"></span><button type="button" class="btn primary big" id="rSave" ${rSaving ? "disabled" : ""} ${d.locked && !rSaving ? `aria-describedby="rLocked"` : ""}>${rSaving ? "Saving…" : d.locked ? TRY : "Save"}</button></div>`;
  armButton($("#rDiscard"), "Tap again to discard", () => { draft = null; saveDraft(); ui.receipt = false; draw(); toast("Receipt discarded"); });
  paintSum();
}

function invOptions(sel) {
  const all = Object.entries(products).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
  return `<option value="">New item (not in inventory yet)</option>` + all.map(([k, p]) => `<option value="${esc(k)}" ${sel === k ? "selected" : ""}>${esc(p.name)}${p.code ? " · " + esc(p.code) : ""}</option>`).join("");
}
function lineHTML(l) {
  const p = lineProd(l);
  const priceDiff = p && Math.abs((Number(p.price) || 0) - unitCost(l)) > 0.004, pack = packSizeOf(p), use = priceChoice(l);
  const nameDiff = p && l.name.trim() && String(p.name).trim().toLowerCase() !== l.name.trim().toLowerCase();
  const codeClash = p && p.code && l.code && p.code !== l.code;
  return `
    <div class="rline${p ? " matched" : ""}" data-l="${l.id}">
      ${l.raw ? `<div class="raw">Receipt: <span>${esc(l.raw)}</span></div>` : ""}
      <label class="lbl">Inventory item${p && l.suggested ? ` <span class="tag">Suggested match, please check</span>` : ""}
        <select data-f="match" id="m-${l.id}">${invOptions(l.match)}</select></label>
      ${p ? `
        ${nameDiff ? `<div class="choice" role="group" aria-label="Name to use">
          <span class="lbl">Name</span>
          <button type="button" data-name="inv" aria-pressed="${l.useName === "inv"}">${esc(p.name)}<small>Inventory name</small></button>
          <button type="button" data-name="receipt" aria-pressed="${l.useName === "receipt"}">${esc(l.name)}<small>From receipt</small></button>
        </div>` : ""}
        ${pack > 1 ? `<div class="pack"><span>1 case = ${pack} each</span>
          <label class="check"><input type="checkbox" data-f="perEach" ${l.perEach ? "checked" : ""}> Priced per each</label></div>` : ""}
        ${priceDiff ? `<div class="choice warn" role="group" aria-label="Price to charge">
          <span class="lbl">Price changed</span>
          <button type="button" data-price="receipt" aria-pressed="${use === "receipt"}">${money(unitCost(l))}<small>Charge the receipt price</small></button>
          <button type="button" data-price="inv" aria-pressed="${use === "inv"}">${money(p.price)}<small>Keep the client price</small></button>
        </div>` : ""}
        ${hasStock(p) ? `<div class="hint">${p.stock} in storage now</div>` : ""}`
      : `<label class="lbl">Item name<input type="text" data-f="name" id="n-${l.id}" value="${esc(l.name)}" placeholder="Item name"></label>`}
      <div class="lbl">Barcode (optional)
        <div class="manual"><input type="text" data-f="code" id="c-${l.id}" value="${esc(l.code || (p && p.code) || "")}" inputmode="numeric" autocomplete="off" placeholder="Type or scan" ${p && p.code ? "readonly" : ""}>${p && p.code ? "" : `<button type="button" class="btn" data-scan>Scan</button>`}</div>
      </div>
      ${codeClash ? `<p class="hint warn">This inventory item already has barcode ${esc(p.code)}. Pick a different inventory item if this is a different product.</p>` : ""}
      <div class="rrow">
        <label>${packOf(l) > 1 ? "Cases" : "Qty"}<input type="number" data-f="qty" id="q-${l.id}" min="0" inputmode="numeric" value="${l.qty}"></label>
        <label>${packOf(l) > 1 ? "Per case" : "Each"} ($)<input type="number" data-f="price" id="p-${l.id}" min="0" step="0.01" inputmode="decimal" value="${l.price}"></label>
        <label class="grow">For<select data-f="dest" id="d-${l.id}">${destOptions(l.dest)}</select></label>
      </div>
      <p class="hint" data-note>${lineNote(l)}</p>
      <div class="ractions"><span class="num" data-total>${money(charge(l))}</span><span class="spacer"></span><button type="button" class="btn ghost" data-split>Split</button><button type="button" class="btn ghost" data-del>Remove</button></div>
    </div>`;
}
function setCode(l, code) {
  l.code = code.trim();
  if (!l.code) return;
  const k = keyForCode(l.code);
  if (products[k] && l.match !== k) { l.match = k; l.suggested = false; l.useName = "inv"; toast("Barcode found in inventory: " + products[k].name); }
}

function paintSum() {
  const d = draft, el = $("#rSum"); if (!d || !el) return;
  const rows = [...d.dests.map((x, i) => ({ id: x.id, label: destLabel(x, i) })), { id: "stock", label: "General inventory" }]
    .map(r => { const ls = d.lines.filter(l => l.dest === r.id); return { ...r, n: ls.reduce((a, l) => a + eaches(l), 0), $: ls.reduce((a, l) => a + Math.round(charge(l) * 100), 0) / 100 }; })
    .filter(r => r.n || r.id !== "stock");
  // At the receipt's prices, to compare with its subtotal
  const all = d.lines.reduce((a, l) => a + Math.round(int(l.qty) * round2(l.price) * 100), 0) / 100;
  el.innerHTML = `<h3>Summary</h3><table class="sumtable"><tbody>
    ${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.n} item${r.n === 1 ? "" : "s"}</td><td>${money(r.$)}</td></tr>`).join("")}
    <tr class="strong"><td>Items total</td><td></td><td>${money(all)}</td></tr>
    ${d.subtotal != null ? `<tr><td>Receipt subtotal</td><td></td><td>${money(d.subtotal)}</td></tr>` : ""}
    ${d.tax != null ? `<tr><td>Tax on receipt (not added)</td><td></td><td>${money(d.tax)}</td></tr>` : ""}
  </tbody></table>
  ${d.subtotal != null && Math.abs(d.subtotal - all) > 0.01 ? `<p class="hint warn">Items total doesn't match the receipt subtotal. Check for a missed or misread line.</p>` : ""}`;
}

// A locked draft (saveReceipt) can't be changed: its fields are disabled, and these ignore anything that gets through
const editable = t => draft && !(draft.locked && t.closest("#rForm"));
$("#rBody").addEventListener("input", e => {
  const d = draft, t = e.target; if (!editable(t)) return;
  if (t.matches("[data-dname]")) {
    const x = d.dests.find(x => x.id === t.closest("[data-d]").dataset.d); x.client = t.value;
    const i = d.dests.indexOf(x);
    document.querySelectorAll(`#rBody option[value="${x.id}"]`).forEach(o => o.textContent = destLabel(x, i));
    paintSum();
  } else if (t.dataset.f && t.closest("[data-l]")) {
    const row = t.closest("[data-l]"), l = d.lines.find(l => l.id === row.dataset.l);
    if (t.dataset.f === "name") l.name = t.value;
    if (t.dataset.f === "qty") l.qty = int(t.value);
    if (t.dataset.f === "price") l.price = Math.max(0, Number(t.value) || 0);
    if (t.dataset.f === "dest") l.dest = t.value;
    if (t.dataset.f === "code") l.code = t.value.trim();
    if (t.dataset.f === "perEach") { l.perEach = t.checked; saveDraft(); rerenderLine(l); return; }
    if (t.dataset.f === "code" || t.dataset.f === "match") return;
    row.querySelector("[data-total]").textContent = money(charge(l));
    row.querySelector("[data-note]").textContent = lineNote(l);
    paintSum();
  } else if (t.id === "rDate") d.date = t.value;
  else if (t.id === "rBy") d.by = t.value;
  saveDraft();
});
$("#rBody").addEventListener("change", e => {
  const d = draft, t = e.target; if (!editable(t)) return;
  if (t.matches("[data-dsel]")) { const x = d.dests.find(x => x.id === t.closest("[data-d]").dataset.d); x.sheetId = t.value; saveDraft(); renderReceipt(); }
  else if (t.dataset.f === "dest") { d.lines.find(l => l.id === t.closest("[data-l]").dataset.l).dest = t.value; saveDraft(); paintSum(); }
  else if (t.dataset.f === "match") { const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); l.match = t.value; l.suggested = false; l.useName = "inv"; l.usePrice = ""; l.perEach = false; saveDraft(); rerenderLine(l); }
  else if (t.dataset.f === "code") { const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); const before = l.match; setCode(l, t.value); saveDraft(); if (l.match !== before) rerenderLine(l); }
  else if (t.id === "rScanFile") { const f = t; (async () => { const c = await scanFromInput(f); const l = d.lines.find(l => l.id === rScanLine); if (c && l) { setCode(l, c); saveDraft(); rerenderLine(l); } })(); }
  else if (t.id === "rSavePrices") { d.savePrices = t.checked; saveDraft(); }
});
$("#rBody").addEventListener("click", e => {
  const d = draft, t = e.target.closest("button"); if (!t || !editable(t)) return;
  const row = t.closest("[data-l]"), line = row && d.lines.find(l => l.id === row.dataset.l);
  if (t.id === "rAddDest") { d.dests.push({ id: uid(), sheetId: "", client: "" }); saveDraft(); renderReceipt(); const x = d.dests[d.dests.length - 1]; const f = $("#dname-" + x.id); f && f.focus(); }
  else if (t.matches("[data-drm]")) {
    const id = t.closest("[data-d]").dataset.d; d.dests = d.dests.filter(x => x.id !== id);
    d.lines.forEach(l => { if (l.dest === id) l.dest = d.dests[0].id; }); saveDraft(); renderReceipt();
  }
  else if (t.matches("[data-scan]") && line) { rScanLine = line.id; $("#rScanFile").click(); }
  else if (t.dataset.name && line) { line.useName = t.dataset.name; saveDraft(); rerenderLine(line); }
  else if (t.dataset.price && line) { line.usePrice = t.dataset.price; saveDraft(); rerenderLine(line); }
  else if (t.matches("[data-split]") && line) {
    const half = Math.floor(int(line.qty) / 2); line.qty = int(line.qty) - half;
    const other = d.dests.find(x => x.id !== line.dest);
    const copy = { ...line, id: uid(), qty: half, dest: other ? other.id : line.dest };
    // Its own action: not the operation or mark the line it came from may have kept (src/aws/db.js, src/moves.js)
    delete copy.operation; delete copy.mark;
    d.lines.splice(d.lines.indexOf(line) + 1, 0, copy); saveDraft(); renderReceipt();
    const f = $("#q-" + copy.id); f && f.focus();
  }
  else if (t.matches("[data-del]") && line) { d.lines = d.lines.filter(l => l !== line); saveDraft(); renderReceipt(); }
  else if (t.id === "rAddLine") { const l = newLine({ dest: d.dests[0].id }); d.lines.push(l); saveDraft(); renderReceipt(); $("#n-" + l.id).focus(); }
  else if (t.id === "rSave") saveReceipt();
});

function rerenderLine(l) {
  const old = document.querySelector(`#rBody .rline[data-l="${l.id}"]`); if (!old) return;
  const tmp = document.createElement("div"); tmp.innerHTML = lineHTML(l).trim();
  old.replaceWith(tmp.firstElementChild); paintSum();
}

// What a general-inventory line adds to storage: its quantity in eaches (packs converted) at
// the receipt's cost each. The line is the action, so saving the same line again (a retry after
// a failure) is the same stock command.
const stockIn = l => ({ action: l, quantity: eaches(l), unitCost: unitCost(l) });

async function saveReceipt() {
  const d = draft;
  const lines = d.lines.filter(l => (lineProd(l) || l.name.trim()) && int(l.qty) > 0);
  if (!lines.length) { toast("Add at least one item with a name and a quantity."); return; }
  const usedDests = d.dests.filter(x => lines.some(l => l.dest === x.id));
  const unnamed = usedDests.find(x => !x.sheetId && !x.client.trim());
  if (unnamed) { toast("Enter a client name for each new sheet."); const f = $("#dname-" + unnamed.id); f && f.focus(); return; }
  if (usedDests.some(x => !x.sheetId) && !d.date) { toast("Choose a date for the new sheets."); return; }
  if (!myId && usedDests.some(x => !x.sheetId) && !d.by.trim()) { toast("Enter who prepared these sheets."); $("#rBy") && $("#rBy").focus(); return; }
  const toStock = lines.filter(l => l.dest === "stock");
  if (!usedDests.length && !toStock.length) { toast("Nothing to save. Assign each item to a client or to General inventory."); return; }
  // From the first attempt until it's saved, the draft is locked: each destination and stock
  // line is one action, with its operation IDs and marks (src/aws/db.js, src/moves.js), so
  // saving again after a lost answer adds nothing twice. A changed line would be a new
  // operation, adding again what an earlier attempt may have saved, so nothing can be changed
  // meanwhile. The marks are made and the lock saved with the draft before anything is sent,
  // so they last through a reload.
  for (const l of toStock) markOf(l);
  for (const x of usedDests) markOf(x);
  d.locked = true; rSaving = true; saveDraft(); renderReceipt();
  // Didn't save: the draft keeps what hasn't been saved. If it failed for the connection, it
  // stays locked and the button says Try again. Refused (a sheet deleted, view-only, storage
  // full), nothing more was saved and what was is out of the draft, so it can be changed.
  const failed = () => { rSaving = false; if (!retryable) d.locked = false; saveDraft(); renderReceipt(); };

  // Keyed by names, barcodes' keys and line ids: no prototype, so "constructor" and
  // "__proto__" are ordinary keys
  const byName = Object.create(null);
  for (const [k, p] of Object.entries(products)) byName[String(p.name || "").trim().toLowerCase()] = k;
  const keyOfLine = Object.create(null), newByName = Object.create(null);
  for (const l of lines) {
    let k = lineProd(l) ? l.match : "";
    if (!k && l.code) k = keyForCode(l.code);
    // A new item's key is kept with its line, so saving again makes the same item, not another
    if (!k) { const n = l.name.trim().toLowerCase(); k = byName[n] || newByName[n] || (newByName[n] = (l.newKey ||= newKey())); }
    keyOfLine[l.id] = k;
  }
  const groups = Object.create(null);
  for (const l of lines) (groups[keyOfLine[l.id]] = groups[keyOfLine[l.id]] || []).push(l);
  for (const [k, ls] of Object.entries(groups)) {
    const ex = products[k], stocked = ls.filter(l => l.dest === "stock"), add = stocked.reduce((a, l) => a + eaches(l), 0);
    if (!ex && !add && !d.savePrices) continue;
    const l0 = ls[0], code = (ex && ex.code) || (ls.find(l => l.code) || {}).code || "";
    const body = { ...(ex || {}), code, name: effName(l0), price: effPrice(l0), cost: unitCost(l0), updatedAt: new Date().toISOString() };
    if (add) body.stock = (hasStock(ex) ? ex.stock : 0) + add;
    if (!await write(() => saveItem(db, null, k, body, { reason: "receipt", lines: stocked.map(stockIn) }))) { failed(); return; }
    // Written: drop its stock lines, so they can't be added twice
    d.lines = d.lines.filter(l => !stocked.includes(l)); saveDraft();
  }

  const savedIds = [];
  for (const x of usedDests) {
    const ls = lines.filter(l => l.dest === x.id), items = {};
    for (const l of ls) {
      const k = keyOfLine[l.id];
      const it = own(items, k) || (items[k] = { code: (products[k] && products[k].code) || l.code || "", name: effName(l), price: effPrice(l), cost: unitCost(l), out: 0, returned: 0 });
      it.out += eaches(l);
    }
    let ok;
    if (x.sheetId) {
      if (!sheets.some(s => s.id === x.sheetId)) {
        toast("One of the chosen sheets was deleted. Pick another and save again.");
        d.lines = d.lines.filter(l => !usedDests.slice(0, usedDests.indexOf(x)).some(y => y.id === l.dest));
        retryable = false; failed(); return;
      }
      ok = await write(() => addLines(db, x, x.sheetId, items), undefined, x.sheetId);
      if (ok) savedIds.push(x.sheetId);
    } else {
      // One new sheet per destination, whatever the attempt: its ID and creation time are kept
      // with the draft. Once an attempt has been made, the next looks for the sheet first, so
      // one whose answer was lost isn't saved again.
      const tried = !!x.newId;
      x.newId ||= db.collection("sheets").doc().id;
      x.createdAt ||= new Date().toISOString();
      saveDraft();
      const ref = db.collection("sheets").doc(x.newId);
      const body = { client: x.client.trim(), date: d.date, createdBy: myId || null, createdAt: x.createdAt, status: "open", items };
      if (!myId) body.createdByName = d.by.trim();
      if (d.store) body.source = { store: d.store, receiptDate: d.receiptDate };
      ok = await write(async () => { if (!tried || !(await ref.get()).exists) await ref.set(body); });
      if (ok) addLocalSheet(ref.id, body);
      if (ok) savedIds.push(ref.id);
    }
    if (!ok) {
      // Keep only what hasn't been saved, so saving again won't duplicate
      d.lines = d.lines.filter(l => !usedDests.slice(0, usedDests.indexOf(x)).some(y => y.id === l.dest));
      failed(); return;
    }
  }
  rSaving = false; draft = null; saveDraft(); ui.receipt = false;
  if (savedIds.length === 1) ui.sheetId = savedIds[0];
  ui.tab = "sheets"; draw(); window.scrollTo(0, 0);
  const nStock = toStock.reduce((a, l) => a + eaches(l), 0);
  toast([savedIds.length ? `Saved to ${savedIds.length} sheet${savedIds.length === 1 ? "" : "s"}` : "", nStock ? `${nStock} added to storage` : ""].filter(Boolean).join(" · "));
  if (!savedIds.length) { ui.tab = "prices"; draw(); }
}

$("#receiptFile").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f && sampleFn) startReceipt(f); });
$("#rBack").addEventListener("click", () => { ui.receipt = false; draw(); });

$("#backBtn").addEventListener("click", () => { ui.sheetId = null; draw(); });
document.querySelectorAll(".mode button").forEach(b => b.addEventListener("click", () => { ui.mode = b.dataset.mode; draw(); }));
$("#scanFile").addEventListener("change", async e => { const c = await scanFromInput(e.target); if (c) handleCode(c); });
$("#noCodeBtn").addEventListener("click", () => { const s = currentSheet(); if (s) (ui.mode === "out" ? pickOutModal : pickReturnModal)(s); });
$("#manualForm").addEventListener("submit", e => { e.preventDefault(); const i = $("#manualCode"); const c = i.value.trim(); i.value = ""; if (c) handleCode(c); });

draw();

(async () => {
  [db, userNs, dl, sampleFn] = await Promise.all([use("db"), use("user"), use("downloads"), use("sample")]);
  if (WEB) {
    const drafts = await use("drafts"); if (drafts) draftKeyNow = () => drafts.key; loadDraft();
    const fr = await use("firstRun");
    if (fr) firstRun = createFirstRun(fr, { addItem: () => { ui.tab = "prices"; draw(); productModal(null); }, newSheet: () => { ui.tab = "sheets"; draw(); newSheetModal(); }, redraw: draw });
  }
  if (sampleFn) { try { const lim = await sampleFn.limits(); receiptOK = !!(lim && lim.images); } catch {} }
  if (userNs) {
    try { myId = await userNs.id(); } catch {}
    try { const w = await userNs.can("data.write"); if (w === false) canWrite = false; } catch {}
    try { isOwner = (await userNs.isOwner()) === true; } catch {}
    await readViewOnly();
  }
  if (!db) { $("#notice").hidden = false; $("#notice").textContent = "Shared storage isn't available in this view. " + help().missing; return; }
  const onErr = () => toast("Lost connection to shared storage. Reload the page.");
  let got = 0; const ready = () => { if (++got >= 2) connected = true; render(); };
  let pFirst = true, sFirst = true;
  db.collection("products").onSnapshot(snap => {
    // Not a product saved as "__proto__" before keyOf avoided that key: it was never
    // shown (it set the old map's prototype), and the API refuses it
    products = Object.create(null); snap.docs.forEach(d => { if (d.id !== "__proto__") products[d.id] = d.data(); });
    if (pFirst) { pFirst = false; ready(); } else render();
  }, onErr);
  db.collection("sheets").orderBy("date", "desc").onSnapshot(snap => {
    sheets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (sFirst) { sFirst = false; ready(); } else render();
  }, onErr);
})();
