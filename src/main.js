import "./theme.js";
import { use, help } from "./runtime.js";
import { checkOut, recordReturn, markLost, saveItem, addLines, markOf, quickTake, moveLine } from "./moves.js";
import { esc, money, todayISO, fmtDate, keyOf, own, int, codeText, hasStock, hasCost, unitValue, isEquipment, newKey, uid, round2, numOrNull, MAX_MONEY, MAX_BRAND, brandOf, nameWithBrand, brandHTML } from "./format.js";
import { lines, lineCharge, totals, isEquipmentLine, equipmentCounts, lostRows, lineLabel, isAdhoc, projectTitle, leftOut } from "./project-math.js";
import { $, toast, openModal, closeModal, dismiss, arm, armButton, stepperHTML, setText, setHTML, setAttr, morph, wireStepper } from "./dom.js";
import { scanFromInput } from "./barcode.js";
import { shrinkPhoto } from "./photo.js";
import { RECEIPT_PROMPT, sampleErr } from "./receipt-prompt.js";
import { projectCsv, projectsCsv, inventoryCsv, allJson } from "./export.js";
import { createFirstRun } from "./first-run.js";

let db = null, userNs = null, dl = null, myId = null, canWrite = true, connected = false, isOwner = false;
// Keyed by product key, which can be any barcode's: no prototype, so a key like
// "constructor" finds nothing until there's a product with that key
let products = Object.create(null), projects = [], people = {};
// kind: the Inventory's Supplies / Equipment filter ("all" shows both); equip: with Equipment
// picked, what's in storage ("in") or still out on open projects ("out")
// q: the project list's search; year: its year filter ("" for all years); years: the year groups
// someone opened (true) or closed (false) on the project list, for the session
const ui = { tab: "projects", projectId: null, mode: "out", filter: "open", receipt: false, kind: "all", equip: "in", q: "", year: "", years: {} };
// The web build's first-run checklist for an owner's new team (src/first-run.js), or null
let firstRun = null;

// projectId: the project this write changes, if any, so a write to a project someone else deleted
// says so. claude.ai's db refuses an update to a missing document as invalid_argument, the
// same code as a viewer's write, so that asks whether the project is still there; the web
// build's db rejects it as not_found.
//
// Resolves to whether it saved. `retryable` then says whether it failed for the connection
// (not refused or overtaken), so the same save is worth trying again (saving() below).
// Offline, nothing is sent: it can't be confirmed, so it isn't tried.
//
// The web build's requests give up after 15 s each (src/aws/http.js).
let retryable = false;
async function write(fn, okMsg, projectId) {
  retryable = false;
  if (!db) { toast("Not connected to shared storage."); return false; }
  if (!navigator.onLine) { retryable = true; toast(OFFLINE); return false; }
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) {
    if (projectId && e && (e.code === "not_found" || (e.code === "invalid_argument" && await projectGone(projectId)))) {
      closeModal(); toast("Someone else deleted this project, so your change wasn't saved.");
    }
    else if (e && e.code === "invalid_argument") { canWrite = false; await readViewOnly(); render(); toast(viewOnly || "You have view-only access. Ask the owner for Contributor access to make changes."); }
    else if (e && e.code === "quota_exceeded") toast("Storage is full. Delete old projects or items to make room.");
    // Someone else saved this first (the web build's versioned writes, ADR 0006). Close the
    // editor so the latest values show, rather than an edit made on the old ones.
    // Finished Return on a project with equipment out that this page didn't know about (someone
    // took more meanwhile): the server refuses to close it (ADR 0017, docs/api/commands.md)
    // Reopening a General Use project while another is open, which this page didn't know about
    else if (e && e.reason === "adhoc_open") { toast(ADHOC_OPEN); }
    else if (e && e.reason === "equipment_out") { closeModal(); toast("Equipment is still out on this project, so it wasn't finished. Tap Finished Return again to say where each piece is."); }
    else if (e && e.code === "aborted") { closeModal(); toast("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed."); }
    // Refused for what's saved now, such as returning more than are left (the web build's
    // checkout and return commands, src/aws/db.js): the message says why. The latest is showing.
    // `refused` is that adapter's own code, so no other write shows a raw message.
    else if (e && e.code === "refused") { closeModal(); toast(e.message); }
    // The web build's session ended (signed out, here or in another tab, or it expired): the
    // connection isn't the problem, and trying again won't help until they sign in
    else if (e && e.code === "unauthenticated") toast("You're signed out, so that wasn't saved. Sign in, then make your change again.");
    else { retryable = true; toast("That didn't save. Check your connection and try again."); }
    return false;
  }
}
const ADHOC_OPEN = "Another General Use project is open. Finish it before reopening this one.";
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
// A price or cost field (data-money) over the API's limit says so, and its form won't submit
// until it's fixed: never a silent cap, and never a save the API refuses
const MONEY_LIMIT = `Prices and costs go up to ${money(MAX_MONEY)}.`;
const checkMoney = e => { if (e.target.matches("[data-money]")) e.target.setCustomValidity(Number(e.target.value) > MAX_MONEY ? MONEY_LIMIT : ""); };
$("#modal").addEventListener("input", checkMoney);
$("#rBody").addEventListener("input", checkMoney);
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

// A checkout or return whose project line saved but whose storage count didn't (the artifact's
// two writes, src/moves.js): the quantity can't change, so Try again finishes the same action,
// and the note says the project has it.
//
// Until it's finished, Escape and tapping outside don't close the form (src/dom.js), and Cancel
// asks for a second tap first, since closing it leaves the storage count unchanged.
function owing(m, action) {
  if (!action.due) return;
  m.querySelectorAll(".stepper input, .stepper button").forEach(c => { c.disabled = true; });
  m.querySelector("#f").dataset.owing = "";
  const note = m.querySelector("#saveFailed");
  if (note) note.textContent = "Saved on the project, but the storage count didn't save. Tap Try again to finish; nothing is counted twice. Cancel leaves storage as it is.";
}
// Cancel, which warns first while a storage count is owed (owing above)
const cancelling = (m, action) => {
  const b = m.querySelector("#cancel");
  b.addEventListener("click", () => (action.due ? arm(b, "Tap again to leave storage as it is", closeModal) : closeModal()));
};

const currentProject = () => projects.find(s => s.id === ui.projectId);
// The team's open General Use project (ADR 0017, section 4), if this page has one
const openAdhoc = () => projects.find(s => isAdhoc(s) && s.status !== "closed");
// The project a quick take aims at: the open General Use project, or the next adhoc-<n> after every one this page holds
function adhocStart() {
  const open = openAdhoc(), date = todayISO();
  // Only adhoc-<integer> IDs count, so it's never adhoc-NaN
  const n = Math.max(0, ...projects.filter(isAdhoc).map(s => Number(s.id.slice(6))).filter(Number.isInteger)) + 1;
  return { id: open ? open.id : `adhoc-${n}`, date, body: { kind: "adhoc", client: "", date, createdBy: myId, createdAt: new Date().toISOString(), status: "open", items: {} } };
}
// Open projects where an item still has something out, the General Use project first, then newest first (as held):
// returns from anywhere (ADR 0017, section 5). The item is its key, or its barcode on a line.
function outOn(key, code) {
  return projects.filter(s => s.status !== "closed")
    .map(s => { const k = Object.keys(s.items || {}).find(k => k === key || (code && s.items[k].code === code)); return { s, k, left: k ? leftOut(s.items[k]) : 0 }; })
    .filter(x => x.left > 0)
    .sort((a, b) => Number(isAdhoc(b.s)) - Number(isAdhoc(a.s)));
}
const projectName = s => `${projectTitle(s)}, ${fmtDate(s.date)}`;
async function projectGone(id) {
  try { return !(await db.doc("projects/" + id).get()).exists; } catch { return false; }
}
// Show a project we just created right away; the next snapshot replaces this copy
const addLocalProject = (id, body) => { if (!projects.some(s => s.id === id)) projects = [{ id, ...body }, ...projects]; };
function personHTML(s) {
  if (s.createdBy) {
    const p = own(people, s.createdBy);
    return `<span class="who">${p ? `<img src="${esc(p.avatarUrl)}" alt="">` : ""}${esc((p && p.name) || "Someone")}</span>`;
  }
  return `<span class="who">${esc(s.createdByName || "Unknown")}</span>`;
}
function personText(s) { return s.createdBy ? ((own(people, s.createdBy) || {}).name || "Someone") : (s.createdByName || "Unknown"); }
// Who last took a piece of equipment (ADR 0017): a user ID (the web build, or claude.ai with a
// signed-in user), or the name typed on the project when there's none. Missing on older lines.
function takerText(id) {
  if (!id) return "—";
  const p = own(people, id);
  return p && p.name ? p.name : "Someone";
}
const whenText = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"; };

/* ---------- render ---------- */
let seq = 0;
async function render() {
  const n = ++seq;
  if (userNs) {
    // The projects' preparers, and who took the equipment still out (Inventory, Equipment, Out)
    const takers = projects.flatMap(s => lines(s).filter(isEquipmentLine).map(l => l.takenBy));
    const typers = projects.flatMap(s => lines(s).map(l => l.priceSetBy));
    const ids = [...new Set([...projects.map(s => s.createdBy), ...takers, ...typers].filter(Boolean))];
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

// The view, then the first-run checklist above the project list or inventory (web build). Only
// an owner of an open team gets one; if a write is refused because the team was closed
// meanwhile, the page is read-only (canWrite) and it hides, as for a team that opens closed.
function draw() {
  drawView();
  if (firstRun) firstRun.draw(connected && canWrite && !$("#main").hidden, Object.keys(products).length, projects.length);
}
function drawView() {
  $("#tab-projects").setAttribute("aria-pressed", ui.tab === "projects");
  $("#tab-prices").setAttribute("aria-pressed", ui.tab === "prices");
  paintNotice();

  $("#receiptView").hidden = !ui.receipt;
  if (ui.receipt) { $("#main").hidden = true; $("#projectView").hidden = true; return; }
  const project = ui.tab === "projects" && ui.projectId ? currentProject() : null;
  if (ui.tab === "projects" && ui.projectId && !project && connected) ui.projectId = null;
  $("#projectView").hidden = !project;
  $("#main").hidden = !!project;
  if (project) drawProject(project);
  else if (ui.tab === "prices") drawPrices();
  else drawList();
}

// #main (the project list and inventory) is redrawn on every snapshot. morph() keeps the
// elements that didn't change, so a tap in progress survives; its events are delegated
// here instead of wired on each redraw.
$("#main").addEventListener("click", e => {
  const t = e.target.closest("button, tr[data-prod], tr[data-project]");
  if (!t) return;
  if (t.dataset.project) { openProjectFromInventory(t.dataset.project); return; }
  if (t.id === "newProject") newProjectModal();
  else if (t.id === "quickTake") quickTakeModal();
  else if (t.id === "returnAny") returnAnyModal();
  else if (t.id === "exportAll") exportAllModal();
  else if (t.id === "resume") { ui.receipt = true; draw(); refreshMarkup().then(renderReceipt); window.scrollTo(0, 0); }
  else if (t.id === "addProduct") productModal(null);
  else if (t.dataset.filter) { ui.filter = t.dataset.filter; draw(); }
  else if (t.dataset.year) { const b = t.getAttribute("aria-expanded") === "true"; ui.years[t.dataset.year] = !b; draw(); }
  else if (t.dataset.kind) { ui.kind = t.dataset.kind; draw(); }
  else if (t.dataset.equip) { ui.equip = t.dataset.equip; draw(); }
  else if (t.dataset.open) { ui.projectId = t.dataset.open; draw(); window.scrollTo(0, 0); }
  else if (t.dataset.prod && canWrite) productModal(t.dataset.prod);
});
// preventDefault: otherwise this Enter press also submits the editor's form
$("#main").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const out = e.target.closest("tr[data-project]");
  if (out) { e.preventDefault(); openProjectFromInventory(out.dataset.project); return; }
  const tr = canWrite && e.target.closest("tr[data-prod]");
  if (tr) { e.preventDefault(); productModal(tr.dataset.prod); }
});
// A row of Inventory, Equipment, Out opens the project the equipment is out on
function openProjectFromInventory(id) { ui.tab = "projects"; ui.projectId = id; draw(); window.scrollTo(0, 0); }

// A project's card on the list. The General Use project shows no money (nothing on it is charged), and
// while it's open it's a card of its own above the client projects: since when, and how many are out.
function cardHTML(s) {
  const t = totals(s), closed = s.status === "closed", adhoc = isAdhoc(s);
  if (adhoc && !closed) {
    const n = lines(s).reduce((a, l) => a + leftOut(l), 0);
    return `
        <button type="button" class="project-card adhoc" data-open="${esc(s.id)}">
          <h3>${esc(projectTitle(s))}</h3>
          <div class="right"><span class="pill open">Taken for no job</span></div>
          <div class="meta"><span>Since ${esc(fmtDate(s.date))}</span><span>${n} item${n === 1 ? "" : "s"} out</span></div>
        </button>`;
  }
  return `
        <button type="button" class="project-card" data-open="${esc(s.id)}">
          <h3>${esc(projectTitle(s))}</h3>
          <div class="right">
            <span class="pill ${closed ? "closed" : "open"}">${closed ? "Returned" : "Checked out"}</span>
            ${adhoc ? "" : `<span class="num">${money(closed ? t.charge : t.value)}</span>`}
          </div>
          <div class="meta"><span>${esc(fmtDate(s.date))}</span>${personHTML(s)}<span>${t.count} item${t.count===1?"":"s"} · ${t.out} taken${t.ret ? ` · ${t.ret} back` : ""}${t.equipmentOut ? ` · ${t.equipmentOut} equipment out` : ""}</span></div>
        </button>`;
}

// Finding a project on the list (supply-checkout-005.5): a search over each project's client ("Ad
// hoc" for the General Use project), who prepared it and its items' names; and a year filter, which
// also scopes the owner's projects CSV (exportAllModal). Finished projects, on Returned and All,
// are grouped by month under year headings, newest first. This year's group is open, and the
// newest group too (early in January, when this year has none yet); an older one opens when
// it's picked in the year filter or searched. ui.years keeps the years someone opened or
// closed, for the session.
const yearOf = s => /^\d{4}-(0[1-9]|1[0-2])/.test(s.date || "") ? s.date.slice(0, 4) : "";
const projectYears = () => [...new Set(projects.map(yearOf).filter(Boolean))].sort().reverse();
// The year picked in the year filter, while a project has it
const pickedYear = () => projectYears().includes(ui.year) ? ui.year : "";
const matches = (s, q) => [projectTitle(s), personText(s), ...lines(s).map(lineLabel)].join("\n").toLowerCase().includes(q);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// A group's count, and for owners its total charge (the General Use project is never charged)
function groupMeta(list) {
  const cents = list.filter(s => !isAdhoc(s)).reduce((a, s) => a + Math.round(totals(s).charge * 100), 0);
  return `${plural(list.length, "project")}${isOwner ? ` · ${money(cents / 100)}` : ""}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function groupedHTML(closed) {
  const years = new Map();
  const day = s => String(s.date || "");
  [...closed].sort((a, b) => day(b).localeCompare(day(a))).forEach(s => {
    const y = yearOf(s) || "No date";
    years.set(y, [...(years.get(y) || []), s]);
  });
  const thisYear = todayISO().slice(0, 4);
  return [...years].map(([y, list], i) => {
    const open = ui.years[y] ?? (i === 0 || y === thisYear || y === ui.year || !!ui.q), id = `yr-${y.replace(/\W/g, "")}`;
    const months = new Map();
    list.forEach(s => { const m = yearOf(s) ? MONTHS[Number(s.date.slice(5, 7)) - 1] : "No date"; months.set(m, [...(months.get(m) || []), s]); });
    return `
      <section class="year-group" aria-labelledby="${id}-h">
        <h2 class="year-head" id="${id}-h"><button type="button" class="year-toggle" data-year="${esc(y)}" aria-expanded="${open}" aria-controls="${id}"><span>${esc(y)}</span><span class="group-meta">${groupMeta(list)}</span></button></h2>
        <div class="list" id="${id}"${open ? "" : " hidden"}>${open ? [...months].map(([m, ms]) => `
          <h3 class="month-head"><span>${m}</span><span class="group-meta">${groupMeta(ms)}</span></h3>
          ${ms.map(cardHTML).join("")}`).join("") : ""}
        </div>
      </section>`;
  }).join("");
}

function drawList() {
  const q = ui.q.trim().toLowerCase(), year = pickedYear(), years = projectYears();
  const found = s => !q || matches(s, q);
  const adhocOpen = ui.filter === "closed" ? undefined : openAdhoc();
  const adhoc = adhocOpen && found(adhocOpen) ? adhocOpen : undefined;
  const shown = projects.filter(s => s !== adhocOpen && (ui.filter === "all" || (ui.filter === "open" ? s.status !== "closed" : s.status === "closed")) && (!year || yearOf(s) === year) && found(s));
  const openCount = projects.filter(s => s.status !== "closed").length;
  // Out now is a flat list, as it always was; finished projects are grouped by year and month
  const flat = shown.filter(s => s.status !== "closed"), grouped = shown.filter(s => s.status === "closed");
  morph($("#main"), `
    <div class="bar">
      <div class="chips">
        <div class="chips" role="group" aria-label="Filter projects">
          <button type="button" class="chip" data-filter="open" aria-pressed="${ui.filter==="open"}">Out now (${openCount})</button>
          <button type="button" class="chip" data-filter="closed" aria-pressed="${ui.filter==="closed"}">Returned</button>
          <button type="button" class="chip" data-filter="all" aria-pressed="${ui.filter==="all"}">All</button>
        </div>
        ${years.length ? `<select id="yearFilter" class="year-filter" aria-label="Year"><option value="">All years</option>${years.map(y => `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`).join("")}</select>` : ""}
      </div>
      <div class="chips">
        ${canWrite && receiptOK ? `<label class="btn" for="receiptFile">Scan receipt</label>` : ""}
        ${dl && isOwner && connected ? `<button type="button" class="btn" id="exportAll">${year ? `Export ${year}` : "Export data"}</button>` : ""}
        ${canWrite ? `<button type="button" class="btn" id="returnAny">Return</button><button type="button" class="btn" id="quickTake">Quick take</button><button type="button" class="btn primary" id="newProject">+ New project</button>` : ""}
      </div>
    </div>
    ${canWrite && receiptOK && receiptUsage ? `<p class="muted receipts-left" id="receiptsLeft">${esc(receiptUsage.label)}</p>` : ""}
    <div class="search-row"><input type="search" id="projectSearch" aria-label="Search projects" placeholder="Search by client, who prepared it, or item" autocomplete="off"></div>
    ${draft && canWrite ? `<div class="notice resume"><span>You have a receipt that hasn't been saved yet.</span><button type="button" class="btn" id="resume">Continue review</button></div>` : ""}
    <div class="list">
      ${adhoc ? cardHTML(adhoc) : ""}
      ${flat.map(cardHTML).join("")}
      ${shown.length || adhoc ? "" : `<div class="empty">${!connected ? "Loading projects…" : q ? `No projects match “${esc(ui.q.trim())}”.` : ui.filter === "open" ? "Nothing is checked out right now." : "No projects here yet."}</div>`}
    </div>
    ${groupedHTML(grouped)}`);
  // Not in the HTML, so a redraw while someone types leaves the field (and its caret) alone;
  // set here when the list is drawn afresh (back from the Inventory)
  const box = $("#projectSearch");
  if (box.value !== ui.q) box.value = ui.q;
}
$("#main").addEventListener("input", e => { if (e.target.id === "projectSearch") { ui.q = e.target.value; draw(); } });
$("#main").addEventListener("change", e => { if (e.target.id === "yearFilter") { ui.year = e.target.value; draw(); } });

// A line's row: tapping it opens the line editor (lineModal)
const rowAttrs = l => `class="${canWrite ? "click" : ""}" data-line="${esc(l.key)}" ${canWrite ? 'tabindex="0"' : ""}`;
// A typed price on a line bought for the client says who typed it and when (priceSetBy, priceSetAt)
const typedNote = l => l.priceSet === "manual" && l.priceSetBy ? `<span class="code">Price typed by ${esc(takerText(l.priceSetBy))}, ${esc(whenText(l.priceSetAt))}</span>` : "";
const itemCell = l => `<td>${esc(lineLabel(l))}<span class="code">${esc(codeText(l.code))}</span>${typedNote(l)}</td>`;
// Company equipment on the project (ADR 0017): its own section below the supplies, with no price
// or charge, since taking it to a job isn't charged. Lost or broken shows once there is any.
function equipmentHTML(eq) {
  if (!eq.length) return "";
  const counts = eq.map(l => ({ l, ...equipmentCounts(l) })), anyLost = counts.some(c => c.lost);
  return `
    <h3 class="section-head" id="equipHead">Equipment (not charged)</h3>
    <div class="table-wrap"><table class="equipment" aria-labelledby="equipHead">
      <thead><tr><th>Item</th><th>Taken</th><th>Returned</th>${anyLost ? "<th>Lost or broken</th>" : ""}<th>Still out</th></tr></thead>
      <tbody>${counts.map(({ l, o, r, lost, still }) => `
        <tr ${rowAttrs(l)}>${itemCell(l)}<td>${o}</td><td>${r}</td>${anyLost ? `<td>${lost}</td>` : ""}<td>${still}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

// What a project's scan bar does: the General Use project only takes returns (taking is Quick take)
const modeOf = s => isAdhoc(s) ? "return" : ui.mode;
function drawProject(s) {
  const closed = s.status === "closed", t = totals(s), all = lines(s), lost = lostRows(s), adhoc = isAdhoc(s), mode = modeOf(s);
  const ls = all.filter(l => !isEquipmentLine(l)), eq = all.filter(isEquipmentLine);
  morph($("#projectHead"), `
    <div class="project-head">
      <h2>${esc(projectTitle(s))}</h2>
      <div class="meta"><span>${adhoc ? "Since " : ""}${esc(fmtDate(s.date))}</span><span>${adhoc ? "Started" : "Prepared"} by ${personHTML(s)}</span><span class="pill ${closed ? "closed" : "open"}">${closed ? "Returned" : "Checked out"}</span></div>
      ${adhoc ? `<p class="hint">Taken for no job. Nothing here is charged; move a line to a client's project to bill it.</p>` : ""}
      <div class="project-actions">
        ${dl && !adhoc ? `<button type="button" class="btn" id="exportCsv">Download CSV</button>` : ""}
        ${canWrite && !adhoc ? `<button type="button" class="btn" id="editProject">Edit details</button>` : ""}
        ${canWrite ? (closed ? actionButton("reopen", "btn", "Reopen") : actionButton("closeProject", "btn", "Finished Return")) : ""}
      </div>
    </div>`);
  // Each only changes the DOM when its value changes (toggleAttribute too)
  $("#scanbar").toggleAttribute("hidden", closed || !canWrite);
  $(".mode").toggleAttribute("hidden", adhoc);
  document.querySelectorAll(".mode button").forEach(b => setAttr(b, "aria-pressed", b.dataset.mode === mode));
  setText($("#scanLabel"), mode === "out" ? "Scan to check out" : "Scan to return");
  setText($("#noCodeBtn"), mode === "out" ? "Add item without a barcode" : "Return item without a barcode");
  setText($("#modeHint"), mode === "out"
    ? "Take a photo of the barcode, then choose how many you're taking."
    : "Scan an item you're bringing back and enter how many are unused. Whatever isn't returned counts as used. Tap Finished Return when everything is back.");

  morph($("#projectBody"), `
    <div class="totals">
      <div><div class="k">Taken</div><div class="v">${t.out}</div></div>
      <div><div class="k">Returned</div><div class="v">${t.ret}</div></div>
      <div><div class="k">Used</div><div class="v">${t.used}</div></div>
      ${adhoc ? "" : `<div><div class="k">Charge</div><div class="v charge">${money(t.charge)}</div></div>`}
    </div>
    ${adhoc && ls.length ? adhocTableHTML(ls, t) : ls.length || lost.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Price</th><th>Taken</th><th>Returned</th><th>Used</th><th>Charge</th></tr></thead>
      <tbody>${ls.map(l => { const o = int(l.out), r = Math.min(int(l.returned), o), u = o - r; return `
        <tr ${rowAttrs(l)}>
          ${itemCell(l)}
          <td>${money(l.price)}</td><td>${o}</td><td>${r}</td>
          <td>${u}</td><td class="charge">${money(lineCharge(l))}</td>
        </tr>`; }).join("")}${lost.map(r => `
        <tr ${rowAttrs(r)}>${itemCell(r)}<td></td><td></td><td></td><td>${r.used}</td><td class="charge">${money(r.charge)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td><td></td><td>${t.out}</td><td>${t.ret}</td><td>${t.used}</td><td>${money(t.charge)}</td></tr></tfoot>
    </table></div>` : eq.length ? "" : `<div class="empty">${adhoc ? "Nothing on General Use yet. Take items with Quick take on the project list." : "No supplies on this project yet. Scan a barcode to check one out."}</div>`}
    ${equipmentHTML(eq)}
    ${canWrite ? `<div class="project-actions" style="margin-top:18px">${actionButton("delProject", "btn danger", "Delete project")}</div>` : ""}`);
}

// The General Use project's supplies: taken, returned and used, and no money (ADR 0017, section 4)
const adhocTableHTML = (ls, t) => `
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Taken</th><th>Returned</th><th>Used</th></tr></thead>
      <tbody>${ls.map(l => { const o = int(l.out), r = Math.min(int(l.returned), o); return `
        <tr ${rowAttrs(l)}>${itemCell(l)}<td>${o}</td><td>${r}</td><td>${o - r}</td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td>Total</td><td>${t.out}</td><td>${t.ret}</td><td>${t.used}</td></tr></tfoot>
    </table></div>`;

// Finishing, reopening or deleting the project, while its write is on its way: that button says
// Saving… and every one of them is disabled, redraws included, so a second tap sends nothing
let pending = null;
const actionButton = (id, cls, label) => `<button type="button" class="${cls}" id="${id}"${pending ? ` disabled${pending === id ? ' aria-busy="true"' : ""}` : ""}>${pending === id ? "Saving…" : label}</button>`;
async function once(id, fn) {
  if (pending) return;
  pending = id; draw();
  await fn();
  pending = null; draw();
}

const finish = id => write(() => db.doc("projects/" + id).update({ status: "closed", closedAt: new Date().toISOString() }), "Return finished", id);

// Before you finish: for each piece of equipment still out, how many are back, how many were
// lost or broken (with what to charge the client for them, if anything), and the rest are still
// at the job. Backs are returns and losses are the lost command (src/moves.js), each its own
// action per line, so Try again after a failure saves each once. The project closes only when
// nothing is left out; otherwise it stays open, and the next Finished Return asks again.
function finishModal(s, out) {
  const acts = out.map(() => ({ back: {}, lost: {} }));
  openModal(`
    <h2>Before you finish</h2>
    <p class="hint" style="margin-top:-6px">Some company equipment is still out. For each piece, say how many are back and how many were lost or broken; the rest stay out, still at the job, and the project stays open.</p>
    <form id="f" style="display:grid;gap:14px">
      ${out.map((l, i) => { const still = equipmentCounts(l).still; return `
      <fieldset class="field finish" data-i="${i}"><legend>${esc(l.name || "Unnamed item")} · ${still} still out</legend>
        <div class="row2">
          <div class="field"><label for="fBack${i}">It's back</label>${stepperHTML(`fBack${i}`, 0, still)}</div>
          <div class="field"><label for="fLost${i}">Lost or broken</label>${stepperHTML(`fLost${i}`, 0, still)}</div>
        </div>
        <p class="hint" data-left aria-live="polite">Still at the job: ${still}</p>
        ${isAdhoc(s) ? "" : `<div class="field" data-charge hidden><label for="fCharge${i}">Charge the client for what was lost or broken ($, optional)</label>
          <input type="number" id="fCharge${i}" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money placeholder="Leave blank to not charge">
          <p class="hint">${hasCost(l) ? `Worth ${money(l.cost)} each.` : "Its value isn't known."} The amount is for all of them, not each.</p></div>`}
      </fieldset>`; }).join("")}
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const counts = out.map((l, i) => {
      const box = m.querySelector(`[data-i="${i}"]`), still = equipmentCounts(l).still;
      const paint = () => {
        const back = int(box.querySelector(`#fBack${i}`).value), lost = int(box.querySelector(`#fLost${i}`).value);
        setText(box.querySelector("[data-left]"), back + lost > still ? `That's more than the ${still} still out.` : `Still at the job: ${still - back - lost}`);
        // The General Use project has no client to charge
        const field = box.querySelector("[data-charge]");
        if (field) field.hidden = !lost;
      };
      // Each stepper wired within its own box, since the form has several
      const stepper = id => wireStepper(box.querySelector("#" + id).closest(".stepper"), id, paint);
      return { back: stepper(`fBack${i}`), lost: stepper(`fLost${i}`), still };
    });
    const form = m.querySelector("#f");
    onSubmit(form, () => {
      const plans = out.map((l, i) => {
        const field = m.querySelector(`#fCharge${i}`), raw = field ? field.value.trim() : "";
        return { l, back: counts[i].back(), lost: counts[i].lost(), still: counts[i].still, charge: raw === "" ? undefined : Math.max(0, round2(raw)), act: acts[i] };
      });
      const over = plans.find(p => p.back + p.lost > p.still);
      if (over) { toast(`That's more ${over.l.name || "of that item"} than are still out.`); return; }
      const left = plans.reduce((a, p) => a + p.still - p.back - p.lost, 0);
      saving(form, async () => {
        for (const p of plans) {
          if (p.back && !(await write(() => recordReturn(db, p.act.back, s.id, p.l.key, p.back), undefined, s.id))) return false;
          if (p.lost && !(await write(() => markLost(db, p.act.lost, s.id, p.l.key, p.lost, p.charge), undefined, s.id))) return false;
        }
        if (left) { closeModal(); toast(`Saved. ${left} still at the job, so the project stays open.`); return true; }
        return closing(finish(s.id));
      });
    });
  });
}

// The project view is redrawn on every snapshot, with morph() like #main. Its events are
// delegated here, and each looks up the project when it runs, so it acts on the latest copy.
const projectAction = {
  exportCsv: () => exportCsv(currentProject()),
  editProject: () => newProjectModal(currentProject()),
  // Company equipment still out stops it until each piece is accounted for (ADR 0017, section 3)
  closeProject: () => {
    const s = currentProject(), out = lines(s).filter(l => isEquipmentLine(l) && equipmentCounts(l).still > 0);
    if (out.length) finishModal(s, out);
    else once("closeProject", () => finish(s.id));
  },
  reopen: () => {
    // A team has one open General Use project at a time (the web build's server refuses another too)
    if (isAdhoc(currentProject()) && openAdhoc()) { toast(ADHOC_OPEN); return; }
    once("reopen", () => write(() => db.doc("projects/" + ui.projectId).update({ status: "open" }), "Project reopened", ui.projectId));
  },
  delProject: b => arm(b, "Tap again to delete", () => once("delProject", async () => {
    const id = ui.projectId;
    if (await write(() => db.doc("projects/" + id).delete(), "Project deleted", id)) ui.projectId = null;
  })),
};
["#projectHead", "#projectBody"].forEach(sel => {
  $(sel).addEventListener("click", e => {
    const t = e.target.closest("button, tr[data-line]");
    if (!t) return;
    if (t.dataset.line) { if (canWrite) lineModal(currentProject(), t.dataset.line); }
    else projectAction[t.id](t);
  });
});
// preventDefault: otherwise this Enter press also submits the editor's form
$("#projectBody").addEventListener("keydown", e => {
  const tr = e.key === "Enter" && canWrite && e.target.closest("tr[data-line]");
  if (tr) { e.preventDefault(); lineModal(currentProject(), tr.dataset.line); }
});

// Inventory: every item, or supplies or company equipment only (ADR 0017). With Equipment
// picked, In lists what's in storage, and Out each open project with equipment still out on it:
// how many, the project, who took it last and when (from the line, so it needs only the projects).
const KINDS = [["all", "All"], ["supply", "Supplies"], ["equipment", "Equipment"]];
const chip = (attr, value, label, on) => `<button type="button" class="chip" data-${attr}="${value}" aria-pressed="${on}">${label}</button>`;
function drawPrices() {
  const all = Object.entries(products).map(([key, p]) => ({ key, ...p })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const list = ui.kind === "all" ? all : all.filter(p => isEquipment(p) === (ui.kind === "equipment"));
  const out = ui.kind === "equipment" && ui.equip === "out";
  const kinds = `<div class="chips" role="group" aria-label="Show">${KINDS.map(([k, label]) => chip("kind", k, label, ui.kind === k)).join("")}</div>`;
  const where = ui.kind === "equipment" ? `<div class="chips" role="group" aria-label="Equipment">${chip("equip", "in", "In storage", !out)}${chip("equip", "out", "Out on jobs", out)}</div>` : "";
  const n = list.length;
  morph($("#main"), `
    <div class="bar">
      <p class="muted" style="margin:0">${n} item${n===1?"":"s"}. Storage counts go down when items are checked out and up when they're returned or bought for general inventory.</p>
      ${canWrite ? `<button type="button" class="btn primary" id="addProduct">+ Add item</button>` : ""}
    </div>
    <div class="bar">${kinds}${where}</div>
    ${out ? equipmentOutHTML() : list.length ? `<div class="table-wrap"><table class="prices">
      <thead><tr><th>Item</th><th>In storage</th><th>Price each</th><th>${ui.kind === "equipment" ? "Value each" : "Cost each"}</th><th>Value</th></tr></thead>
      <tbody>${list.map(p => `<tr class="${canWrite ? "click" : ""}" data-prod="${esc(p.key)}" ${canWrite ? 'tabindex="0"' : ""}><td>${esc(p.name || "Unnamed item")}${brandHTML(p)}<span class="code">${esc(codeText(p.code))}</span>${isEquipment(p) ? `<span class="kind">Company equipment</span>` : ""}</td><td class="${hasStock(p) ? "" : "muted"}">${hasStock(p) ? p.stock : "—"}</td>${isEquipment(p) ? `<td class="muted">Not charged</td>` : `<td>${money(p.price)}</td>`}<td class="${hasCost(p) ? "" : "muted"}">${hasCost(p) ? money(p.cost) : "—"}</td><td>${hasStock(p) ? money(storageCents(p) / 100) : "—"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total in storage</td><td>${list.reduce((a, p) => a + (hasStock(p) ? p.stock : 0), 0)}</td><td></td><td></td><td>${money(list.reduce((a, p) => a + storageCents(p), 0) / 100)}</td></tr></tfoot>
    </table></div>` : `<div class="empty">${!connected ? "Loading…" : !all.length ? "No items yet. Add one, or scan a barcode on a project." : ui.kind === "equipment" ? "No company equipment yet. Edit an item and choose Company equipment." : "No supplies yet."}</div>`}`);
}
// Inventory, Equipment, Out: one row per open project and piece of equipment still out on it
function equipmentOutHTML() {
  const rows = projects.filter(s => s.status !== "closed")
    .flatMap(s => lines(s).filter(isEquipmentLine).map(l => ({ s, l, still: equipmentCounts(l).still })))
    .filter(r => r.still > 0)
    .sort((a, b) => String(a.l.name).localeCompare(String(b.l.name)) || String(a.s.date).localeCompare(String(b.s.date)));
  if (!rows.length) return `<div class="empty">No company equipment is out on a job right now.</div>`;
  return `<div class="table-wrap"><table class="equipment out">
      <thead><tr><th>Item</th><th>Out</th><th>Project</th><th>Taken by</th><th>When</th></tr></thead>
      <tbody>${rows.map(({ s, l, still }) => `<tr class="click" data-project="${esc(s.id)}" tabindex="0"><td>${esc(l.name || "Unnamed item")}<span class="code">${esc(codeText(l.code))}</span></td><td>${still}</td><td>${esc(projectTitle(s))}<span class="code">${esc(fmtDate(s.date))}</span></td><td>${esc(takerText(l.takenBy))}</td><td>${esc(whenText(l.takenAt))}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

function newProjectModal(existing) {
  const editing = existing && existing.id;
  const needName = !editing && !myId;
  openModal(`
    <h2>${editing ? "Edit project" : "New project"}</h2>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fClient">Client</label><input type="text" id="fClient" required data-autofocus value="${esc(editing ? existing.client : "")}" placeholder="Client or job name"></div>
      <div class="field"><label for="fDate">Date</label><input type="date" id="fDate" required value="${esc(editing ? existing.date : todayISO())}"></div>
      ${needName ? `<div class="field"><label for="fBy">Prepared by</label><input type="text" id="fBy" required placeholder="Your name"></div>` : ""}
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">${editing ? "Save" : "Create project"}</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    // One new project per form: trying again saves the same project, so a save whose answer was
    // lost doesn't make a second one
    let ref, createdAt;
    const form = m.querySelector("#f");
    onSubmit(form, () => {
      const client = m.querySelector("#fClient").value.trim(), date = m.querySelector("#fDate").value;
      if (!client || !date) return;
      if (editing) {
        saving(form, () => closing(write(() => db.doc("projects/" + existing.id).update({ client, date }), "Saved", existing.id)));
        return;
      }
      createdAt ||= new Date().toISOString();
      const body = { client, date, createdBy: myId || null, createdAt, status: "open", items: {} };
      if (needName) body.createdByName = m.querySelector("#fBy").value.trim();
      saving(form, async () => {
        const ok = await write(() => (ref ||= db.collection("projects").doc()).set(body), "Project created");
        if (ok) { addLocalProject(ref.id, body); closeModal(); ui.projectId = ref.id; ui.mode = "out"; draw(); }
        return ok;
      });
    });
  });
}

// A scanned or typed barcode, shown before anything is saved. A photo can be misread, so with
// recode (how to start over with another code) the number can be corrected in place: the form
// opens again for the corrected code, looking it up in inventory and on the project afresh.
function codeHTML(code, recode) {
  return `<div class="code${recode ? " recode" : ""}" id="codeBox"><span>${esc(codeText(code))}</span>${recode ? ` <button type="button" class="btn ghost" id="fixCode">Not this number?</button>` : ""}</div>`;
}
function wireRecode(m, code, recode) {
  const fix = m.querySelector("#fixCode");
  if (!fix) return;
  fix.addEventListener("click", () => {
    const box = m.querySelector("#codeBox");
    box.innerHTML = `<form class="manual" id="fixForm"><label class="vh" for="fixInput">Barcode number</label><input type="text" id="fixInput" inputmode="numeric" autocomplete="off" value="${esc(code)}"><button type="submit" class="btn">Use this number</button></form>`;
    const input = box.querySelector("#fixInput");
    input.focus(); input.select();
    box.querySelector("#fixForm").addEventListener("submit", e => { e.preventDefault(); const c = input.value.trim(); if (c) recode(c); });
  });
}

// s: the project, or null for a quick take onto the General Use project (ADR 0017, section 4)
// recode: see codeHTML
function checkoutModal(s, code, key = keyOf(code), recode = null) {
  const on = s || openAdhoc() || {}, prod = products[key], line = own(on.items || {}, key), action = {};
  openModal(`
    <h2>${s ? "Check out" : "Quick take"}</h2>
    ${codeHTML(code, recode)}
    <form id="f" style="display:grid;gap:14px">
      ${prod ? `<div class="item-known"><strong>${esc(nameWithBrand(prod))}</strong><span class="num">${isEquipment(prod) ? "Company equipment · not charged" : `${money(prod.price)} each`}</span></div>${hasStock(prod) ? `<div class="summary"><span>In storage</span><b>${prod.stock}</b></div>` : ""}`
             : `<p class="hint" style="margin-top:-4px">${code ? "New barcode. Name it and set a price, and it'll be saved to inventory." : "Name the item and set a price."}</p>
                <div class="field"><label for="fName">Item name</label><input type="text" id="fName" required data-autofocus placeholder="${code ? "e.g. Nitrile gloves, box of 100" : "e.g. Leftover storage bins"}"></div>
                <div class="field"><label for="fPrice">Price each ($)</label><input type="number" id="fPrice" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money placeholder="0.00"></div>
                ${code ? "" : `<label class="check"><input type="checkbox" id="fSave" checked> Save to inventory for next time</label>`}`}
      ${line ? `<div class="summary"><span>Already on ${s ? "this project" : "General Use"}</span><b>${int(line.out)} taken</b></div>` : ""}
      <div class="field"><label for="fQty">How many are you taking?</label>${stepperHTML("fQty", 1)}</div>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary" id="go">Add to project</button></div>
    </form>`, m => {
    wireRecode(m, code, recode);
    const goText = v => s ? `Add ${v} to project` : `Take ${v}`;
    const getQty = wireStepper(m, "fQty", v => setText(m.querySelector("#go"), goText(v)));
    m.querySelector("#go").textContent = goText(1);
    cancelling(m, action);
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
        const fresh = (s ? currentProject() || s : openAdhoc()) || {}, cur = own(fresh.items || {}, key);
        // A new line copies the item's cost too (ADR 0014); an existing line keeps its snapshot
        const from = cur || prod, cost = from && hasCost(from) ? { cost: from.cost } : {};
        const counts = { out: int(cur && cur.out) + qty, returned: int(cur && cur.returned) };
        // Company equipment (ADR 0017) has no price on the project, and says who took it last and
        // when. The artifact build writes this line; the web build's server makes the same one.
        const item = (cur ? isEquipmentLine(cur) : isEquipment(prod))
          ? { code, name: cur ? cur.name : name, kind: "equipment", ...cost, ...counts, takenBy: myId || fresh.createdByName || "", takenAt: new Date().toISOString() }
          : { code, name: cur ? cur.name : name, price: cur ? cur.price : price, ...cost, ...counts };
        if (!s) return closing(write(() => quickTake(db, action, key, qty, item, oneOff, adhocStart()), `Took ${qty} × ${item.name} (General Use)`));
        return closing(write(() => checkOut(db, action, s.id, key, qty, item, oneOff), `Checked out ${qty} × ${item.name}`, s.id));
      }).then(() => owing(m, action));
    });
  });
}

// s: the project, or null for a quick take
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
      // By name, brand or barcode
      const hits = all.filter(p => !q || [p.name, brandOf(p), p.code || ""].some(t => String(t).toLowerCase().includes(q)));
      box.innerHTML = hits.length ? hits.map(p => `<button type="button" data-k="${esc(p.key)}"><span>${esc(p.name)}${brandHTML(p)}<span class="code" style="display:block">${esc(codeText(p.code))}</span></span><span class="num">${hasStock(p) ? p.stock + " in storage" : isEquipment(p) ? "Equipment" : money(p.price)}</span></button>`).join("") : `<p class="hint">No matches. Use + New item.</p>`;
      box.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { const p = products[b.dataset.k] || {}; checkoutModal(s, p.code || "", b.dataset.k); }));
    };
    find.addEventListener("input", paint); paint();
  });
}

function pickReturnModal(s) {
  // Not what was bought for the client: it isn't coming back
  const ls = lines(s).filter(l => l.purchased !== true);
  openModal(`
    <h2>Return an item</h2>
    <p class="hint" style="margin-top:-6px">Pick the item you're bringing back.</p>
    ${ls.length ? `<div class="pick">${ls.map(l => `<button type="button" data-k="${esc(l.key)}"><span>${esc(l.name)}<span class="code" style="display:block">${esc(codeText(l.code))}</span></span><span class="num">${int(l.out)} taken</span></button>`).join("")}</div>` : `<p>Nothing has been checked out on this project yet.</p>`}
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { const l = own(s.items || {}, b.dataset.k) || {}; returnModal(s, l.code || "", b.dataset.k); }));
  });
}

// named: opened from the project list's Return, so it says which project it returns to
// The project list's Quick take and Return: a barcode (scanned or typed), or an item picked from a
// list, without opening a project first
function codeEntryHTML(label) {
  return `<div class="scan-row">
      <label class="btn primary big" for="qScan">${esc(label)}</label>
      <input class="vh" type="file" id="qScan" accept="image/*" capture="environment" aria-label="Barcode photo">
      <form class="manual" id="qForm"><label class="vh" for="qCode">Barcode number</label><input type="text" id="qCode" inputmode="numeric" autocomplete="off" placeholder="Or type the barcode"><button type="submit" class="btn">Enter</button></form>
    </div>`;
}
function wireCodeEntry(m, onCode) {
  const scan = m.querySelector("#qScan");
  scan.addEventListener("change", async () => { const c = await scanFromInput(scan); if (c) onCode(c); });
  m.querySelector("#qForm").addEventListener("submit", e => { e.preventDefault(); const c = m.querySelector("#qCode").value.trim(); if (c) onCode(c); });
}

// Quick take (ADR 0017, section 4): what's taken goes on the team's General Use project
function quickTakeCode(c) { checkoutModal(null, c, keyForCode(c), quickTakeCode); }
function quickTakeModal() {
  openModal(`
    <h2>Quick take</h2>
    <p class="hint" style="margin-top:-6px">For supplies taken for no job, or before you know which job. They go on General Use (no job).</p>
    ${codeEntryHTML("Scan to take")}
    <button type="button" class="btn" id="qPick">Item without a barcode</button>
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelector("#qPick").addEventListener("click", () => pickOutModal(null));
    wireCodeEntry(m, quickTakeCode);
  });
}

// Return from anywhere (ADR 0017, section 5): finds each open project where the item is still out
function returnAnyModal() {
  const out = new Map();
  for (const s of projects) {
    if (s.status === "closed") continue;
    for (const l of lines(s)) if (leftOut(l) > 0 && !out.has(l.key)) out.set(l.key, l);
  }
  const items = [...out.values()];
  openModal(`
    <h2>Return</h2>
    <p class="hint" style="margin-top:-6px">Scan what you're bringing back, or pick it. It goes back to the project it's out on.</p>
    ${codeEntryHTML("Scan to return")}
    ${items.length ? `<div class="pick">${items.map(l => `<button type="button" data-k="${esc(l.key)}"><span>${esc(l.name)}<span class="code" style="display:block">${esc(codeText(l.code))}</span></span></button>`).join("")}</div>` : `<p>Nothing is checked out right now.</p>`}
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { const l = out.get(b.dataset.k); returnFrom(outOn(l.key), l.code || ""); }));
    wireCodeEntry(m, returnAnyCode);
  });
}
function returnAnyCode(c) { returnFrom(outOn(keyForCode(c), c), c, returnAnyCode); }
// The return form for the one project the item is out on, or a list to pick from, the General Use project first
function returnFrom(hits, code, recode = null) {
  if (!hits.length) { closeModal(); toast("Nothing of this is checked out right now."); return; }
  if (hits.length === 1) { returnModal(hits[0].s, code, hits[0].k, true, recode); return; }
  openModal(`
    <h2>Which project?</h2>
    <p class="hint" style="margin-top:-6px">${esc(own(hits[0].s.items, hits[0].k).name)} is out on more than one project. Pick the one it's coming back from.</p>
    <div class="pick">${hits.map(({ s, left }, i) => `<button type="button" data-i="${i}"><span>${esc(projectTitle(s))}<span class="code" style="display:block">${esc(fmtDate(s.date))}</span></span><span class="num">${left} out</span></button>`).join("")}</div>
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => { const h = hits[Number(b.dataset.i)]; returnModal(h.s, code, h.k, true, recode); }));
  });
}

// recode: see codeHTML
function returnModal(s, code, key = keyOf(code), named = false, recode = null) {
  const line = own(s.items || {}, key), prod = products[key], action = {};
  if (!line) {
    // Still out on another open project: return it there instead (ADR 0017, section 5)
    const elsewhere = outOn(key, code).filter(x => x.s.id !== s.id);
    const there = elsewhere.length === 1 ? `Return it to ${projectName(elsewhere[0].s)}` : "Return it from another project";
    openModal(`
      <h2>Not on this project</h2>
      ${codeHTML(code, recode)}
      <p style="margin:0">${prod ? `<strong>${esc(prod.name)}</strong> wasn't` : "This item wasn't"} checked out on this project, so there's nothing to return.${elsewhere.length ? " It's out on another project." : ""}</p>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Close</button>${elsewhere.length ? `<button type="button" class="btn" id="elsewhere">${esc(there)}</button>` : ""}${isAdhoc(s) ? "" : `<button type="button" class="btn primary" id="switch">Check it out instead</button>`}</div>`, m => {
      m.querySelector("#cancel").addEventListener("click", closeModal);
      wireRecode(m, code, recode);
      const other = m.querySelector("#elsewhere"), sw = m.querySelector("#switch");
      if (other) other.addEventListener("click", () => returnFrom(elsewhere, code, recode));
      if (sw) sw.addEventListener("click", () => { ui.mode = "out"; draw(); checkoutModal(s, code, key, recode); });
    });
    return;
  }
  // Company equipment lost or broken isn't coming back either (ADR 0017), and unreturned
  // equipment is still out, not used, so it has no charge
  const equip = isEquipmentLine(line), o = int(line.out), price = Number(line.price) || 0;
  const already = Math.min(int(line.returned), o), left = equip ? equipmentCounts(line).still : o - already;
  if (!left) {
    openModal(`
      <h2>Already returned</h2>
      ${codeHTML(code, recode)}
      <p style="margin:0">${equip ? `None of <strong>${esc(line.name)}</strong> is still out.` : `All ${o} of <strong>${esc(line.name)}</strong> have been returned.`} To correct the counts, tap the item's row on the project.</p>
      <div class="modal-actions"><button type="button" class="btn primary" id="cancel">Close</button></div>`, m => {
      m.querySelector("#cancel").addEventListener("click", closeModal);
      wireRecode(m, code, recode);
    });
    return;
  }
  openModal(`
    <h2>${named ? `Return to ${esc(projectName(s))}` : "Return"}</h2>
    ${codeHTML(code, recode)}
    <div class="item-known"><strong>${esc(line.name)}</strong><span class="num">${o} taken${already ? ` · ${already} back` : ""}</span></div>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fRet">How many are you returning now?</label>${stepperHTML("fRet", 1, left)}</div>
      <div class="summary" id="sum"></div>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save return</button></div>
    </form>`, m => {
    const paint = r => {
      const now = Math.min(int(r), left), back = already + now;
      setHTML(m.querySelector("#sum"), equip ? `<span>Returned <b>${back}</b> of ${o}</span><span>Still out <b>${left - now}</b></span>`
        : `<span>Returned <b>${back}</b> of ${o}</span><span>Used <b>${o - back}</b></span>${isAdhoc(s) ? "" : `<span>Charge <b>${money((o - back) * price)}</b></span>`}`);
    };
    wireRecode(m, code, recode);
    const getR = wireStepper(m, "fRet", paint); paint(1);
    cancelling(m, action);
    const form = m.querySelector("#f");
    onSubmit(form, () => {
      const r = getR(); if (!r) { toast("Choose at least 1."); return; }
      saving(form, async () => {
        return closing(write(async () => {
          const done = await recordReturn(db, action, s.id, key, r);
          // Back on the project list (a return from anywhere), the project it went to opens
          if (named) { ui.tab = "projects"; ui.projectId = s.id; draw(); }
          toast(`${done.quantity} returned · ${int(done.line.returned)} of ${int(done.line.out)} back`);
        }, undefined, s.id));
      }).then(() => owing(m, action));
    });
  });
}

function lineModal(s, key) {
  const l = own(s.items || {}, key); if (!l) return;
  // Company equipment on loan has no price on the project (ADR 0017), and nor does the General Use project
  const equip = isEquipmentLine(l), bought = l.purchased === true, adhoc = isAdhoc(s);
  // The open General Use project's line can move, whole, to an open client project (ADR 0017, section 5)
  const jobs = adhoc && s.status !== "closed" ? projects.filter(x => !isAdhoc(x) && x.status !== "closed") : null;
  openModal(`
    <h2>${esc(bought ? lineLabel(l) : l.name || "Item")}</h2>
    <div class="code">${esc(codeText(l.code))}</div>
    <form id="f" style="display:grid;gap:14px">
      ${equip ? `<p class="hint" style="margin:0">Company equipment: not charged.</p>` : adhoc ? `<p class="hint" style="margin:0">Taken for no job: not charged.</p>` : `<div class="field"><label for="fPrice">Price each on this project ($)</label><input type="number" id="fPrice" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money value="${Number(l.price) || 0}"></div>`}
      <div class="row2">
        <div class="field"><label for="fOut">Taken</label><input type="number" id="fOut" min="0" inputmode="numeric" value="${int(l.out)}"></div>
        ${bought ? "" : `<div class="field"><label for="fRet">Returned</label><input type="number" id="fRet" min="0" inputmode="numeric" value="${int(l.returned)}"></div>`}
      </div>
      <div class="modal-actions"><button type="button" class="btn danger" id="remove">Remove</button><span class="spacer"></span><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>
    ${jobs ? `<form id="mv" class="move" style="display:grid;gap:10px;margin-top:18px">
      <h3>Move to a project</h3>
      ${jobs.length ? `<p class="hint" style="margin:0">The whole line, with its counts, goes to that project at the price it was taken at. Storage doesn't change.</p>
      <div class="field"><label for="fTo">Project</label><select id="fTo">${jobs.map(x => `<option value="${esc(x.id)}">${esc(projectName(x))}</option>`).join("")}</select></div>
      <div class="modal-actions"><button type="submit" class="btn primary">Move</button></div>` : `<p class="hint" style="margin:0">There's no open project to move it to. Start one with + New project.</p>`}
    </form>` : ""}`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const form = m.querySelector("#f"), mv = m.querySelector("#mv");
    // One action per client project picked: Try again moves it once, and another pick is another move
    const moves = Object.create(null);
    if (mv && jobs.length) onSubmit(mv, () => {
      const to = m.querySelector("#fTo").value, x = projects.find(j => j.id === to);
      saving(mv, () => closing(write(() => moveLine(db, (moves[to] ||= {}), s.id, key, to), `Moved to ${projectTitle(x)}`, s.id)));
    });
    // The form is busy until it's removed, so it's removed once
    armButton(m.querySelector("#remove"), "Tap to remove", () => busy(form, () => closing(write(() => removeLine(s.id, key), "Removed", s.id))));
    onSubmit(form, () => {
      // Taken never below what's back and lost; returned never above what isn't lost
      // Bought for the client: nothing comes back, so there's no returned to change
      const lost = int(l.lost), out = Math.max(int(m.querySelector("#fOut").value), lost);
      const returned = bought ? 0 : Math.min(int(m.querySelector("#fRet").value), out - lost);
      // Typed prices are kept in whole cents (ADR 0014); the server records who typed one on a bought line
      const price = equip || adhoc ? {} : { price: Math.max(0, round2(m.querySelector("#fPrice").value)) };
      const patch = bought ? { out, ...price } : { out, returned, ...price };
      saving(form, () => closing(write(() => db.doc("projects/" + s.id).update({ items: { [key]: patch } }), "Saved", s.id)));
    });
  });
}

// Removes a line without making a project someone else deleted again. The web build's db saves the
// project without it, on the version it read, so a project deleted since is refused (ADR 0006).
// claude.ai's db has no conditional writes, but its update refuses a document that's gone, so
// the artifact build sets the line to null in one update: nothing is read first, so there's no
// moment in which the project could be deleted and then saved again. A null line is a removed one
// (projects are read without them, liveProject below). If the runtime refuses a null value, the
// project is read and saved whole without the line, as long as it's still there: that leaves the
// moment between the read and the write, as before.
async function removeLine(id, key) {
  const ref = db.doc("projects/" + id);
  // Without commands (the demo and the tests' mock runtime), the update comes first
  if (!db.command) {
    try { await ref.update({ items: { [key]: null } }); return; }
    // Refused: the project is gone (not_found below), the runtime doesn't take a null value, or
    // this user is a viewer (the set below is refused too)
    catch (e) { if (e.code !== "invalid_argument") throw e; }
  }
  const got = await ref.get();
  if (!got.exists) throw { code: "not_found" };
  const body = got.data(); body.items = { ...(body.items || {}) }; delete body.items[key];
  await ref.set(body);
}
// A project as the app shows it: without lines the artifact build removed (removeLine above)
function liveProject(d) {
  const s = { id: d.id, ...d.data() };
  // ...and without the markers of lines moved to a client project (moveLine in src/moves.js)
  for (const [k, it] of Object.entries(Object(s.items))) {
    if (it === null || it.moved) delete s.items[k];
    else delete it.moved;
  }
  return s;
}

// An item's storage value in whole cents (ADR 0014): its count times its cost each, or
// its price each where the cost isn't known
const MAX_PACK = 10000;
const storageCents = p => hasStock(p) ? Math.round(p.stock * round2(unitValue(p)) * 100) : 0;
const packInput = v => Math.min(MAX_PACK, Math.max(1, int(v)));
// A count of single items as full packs and loose ones, for the line under the count
function packsText(n, size) {
  const full = Math.floor(n / size), loose = n % size;
  if (!full) return `= ${loose} loose, less than a full pack`;
  const packs = `= ${full} full pack${full === 1 ? "" : "s"}`;
  return loose ? `${packs} + ${loose} loose` : packs;
}

const SUPPLY_HINT = "Price is what a client is charged. Cost is what you paid each, before tax, and isn't shown on projects.";
const EQUIPMENT_HINT = "Company equipment goes to jobs and comes back. It's listed on projects but not charged. Value is what you paid for one.";
function productModal(key) {
  const p = key ? products[key] : null;
  // One count per form: every attempt at saving the same count is the same stock command.
  // And one key for a new item without a barcode, so trying again doesn't make a second item.
  const action = {}, newItemKey = newKey(), equip = isEquipment(p);
  openModal(`
    <h2>${p ? "Edit item" : "Add item"}</h2>
    <form id="f" style="display:grid;gap:14px">
      <fieldset class="field kinds"><legend>What is it?</legend>
        <label class="check"><input type="radio" name="fKind" value="supply" ${equip ? "" : "checked"}> Supply (used up, charged)</label>
        <label class="check"><input type="radio" name="fKind" value="equipment" ${equip ? "checked" : ""}> Company equipment (reused, not charged)</label>
      </fieldset>
      <div class="field"><label for="fCode">Barcode${p ? "" : " (optional)"}</label>
        ${p ? `<div class="code" style="margin:0">${esc(codeText(p.code))}</div>`
            : `<div class="manual"><input type="text" id="fCode" inputmode="numeric" autocomplete="off" placeholder="Type, scan, or leave blank"><label class="btn" for="fScan">Scan</label></div><input class="vh" type="file" id="fScan" accept="image/*" capture="environment">`}
      </div>
      <div class="field"><label for="fName">Item name</label><input type="text" id="fName" required value="${esc(p ? p.name : "")}" ${p ? "data-autofocus" : ""}></div>
      <div class="field"><label for="fBrand">Brand (optional)</label><input type="text" id="fBrand" maxlength="${MAX_BRAND}" autocomplete="off" value="${esc(p ? brandOf(p) : "")}" placeholder="e.g. Glad"></div>
      <div class="field" id="fPriceField" ${equip ? "hidden" : ""}><label for="fPrice">Price each ($)</label><input type="number" id="fPrice" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money value="${p && !equip ? round2(p.price) : ""}" placeholder="0.00"></div>
      <div class="field"><label for="fCost" id="fCostLabel">${equip ? "Value each" : "Cost each"} ($)</label><input type="number" id="fCost" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money value="${p && hasCost(p) ? round2(p.cost) : ""}" placeholder="Leave blank if not known"></div>
      <div class="field"><label for="fPack">Comes in packs of (optional)</label><input type="number" id="fPack" min="1" max="${MAX_PACK}" step="1" inputmode="numeric" value="${p && Number.isInteger(p.packSize) ? p.packSize : ""}" placeholder="Leave blank if bought one at a time" aria-describedby="fPackHint"><p class="hint" id="fPackHint">Receipts add packs × this many to storage.</p></div>
      <div class="field"><label for="fStock">Single items in storage now</label><input type="number" id="fStock" min="0" inputmode="numeric" value="${hasStock(p) ? p.stock : ""}" placeholder="Leave blank if not counted"><p class="hint" id="fPacks" aria-live="polite" hidden></p></div>
      <p class="hint" id="fKindHint">${equip ? EQUIPMENT_HINT : SUPPLY_HINT}</p>
      ${p ? `<p class="hint">Price changes apply to new checkouts. Projects keep the price they were checked out at; change it on a project by tapping the row. So does a change between supply and equipment.</p>` : ""}
      <div class="modal-actions">${p ? `<button type="button" class="btn danger" id="remove">Delete</button><span class="spacer"></span>` : ""}<button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    // Equipment has no client price, and its cost is its value
    const kindOf = () => m.querySelector("input[name=fKind]:checked").value;
    m.querySelectorAll("input[name=fKind]").forEach(r => r.addEventListener("change", () => {
      const eq = kindOf() === "equipment";
      m.querySelector("#fPriceField").hidden = eq;
      m.querySelector("#fCostLabel").textContent = `${eq ? "Value each" : "Cost each"} ($)`;
      m.querySelector("#fKindHint").textContent = eq ? EQUIPMENT_HINT : SUPPLY_HINT;
    }));
    const scan = m.querySelector("#fScan");
    scan && scan.addEventListener("change", async () => { const c = await scanFromInput(scan); if (c) m.querySelector("#fCode").value = c; });
    const stock = m.querySelector("#fStock"), pack = m.querySelector("#fPack"), packs = m.querySelector("#fPacks");
    const paintPacks = () => {
      const n = int(stock.value), size = packInput(pack.value);
      packs.hidden = !(n > 0 && size > 1);
      packs.textContent = packs.hidden ? "" : packsText(n, size);
    };
    stock.addEventListener("input", paintPacks); pack.addEventListener("input", paintPacks); paintPacks();
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
      // A whole-item write carries the kind (ADR 0017): equipment says so and has no price; a supply needs no kind
      delete body.kind;
      if (kindOf() === "equipment") { body.kind = "equipment"; delete body.price; }
      const opt = (id, field, val) => { const v = m.querySelector(id).value.trim(); if (v === "") delete body[field]; else body[field] = val(v); };
      opt("#fStock", "stock", int);
      opt("#fCost", "cost", v => Math.max(0, round2(v)));
      opt("#fPack", "packSize", packInput);
      // Tabs and other control characters pasted in are spaces: the API refuses them in a brand
      // eslint-disable-next-line no-control-regex -- replacing control characters is the point
      opt("#fBrand", "brand", v => v.replace(/[\u0000-\u001f\u007f]+/g, " "));
      // Only a count the person changed is saved: the stock may have moved since the form opened
      // (a checkout, someone else's count), and the count it opened with would undo that. A
      // changed one is checked against the count it opened with (`expected`, null: not counted).
      // `counted`: the form showed a count when it opened, so a blank one means stop counting.
      const change = m.querySelector("#fStock").value.trim() === (hasStock(p) ? String(p.stock) : "") ? { reason: "count", keep: true }
        : { reason: "count", count: body.stock, counted: !!hasStock(p), expected: hasStock(p) ? p.stock : null };
      saving(form, () => closing(write(() => saveItem(db, action, docKey, body, change), "Saved")));
    });
  });
}

function keyForCode(code) {
  const k = keyOf(code); if (products[k]) return k;
  return Object.keys(products).find(x => products[x].code === code) || k;
}
function handleCode(code) {
  const s = currentProject(); if (!s || !code) return;
  if (modeOf(s) === "out") { checkoutModal(s, code, keyForCode(code), handleCode); return; }
  const items = s.items || {};
  const onProject = Object.keys(items).find(k => items[k].purchased !== true && (k === keyOf(code) || items[k].code === code));
  returnModal(s, code, onProject || keyForCode(code), false, handleCode);
}

/* ---------- export ---------- */
async function save(filename, data) {
  try { await dl.save({ filename, data }); return true; }
  catch (e) { if (e && e.code !== "declined") toast("Couldn't prepare the download here."); return false; }
}
function exportCsv(s) {
  return save(`${[(s.client || "project").replace(/[\\/:*?"<>|]/g, ""), s.date].filter(Boolean).join(" ").trim()}.csv`, projectCsv(s, personText(s)));
}

// Owners download every project and the inventory, whatever their write access (a team
// that's read-only after cancelling can still take its data)
// The projects CSV has the projects of the year picked in the project list's year filter, if one
// is; the inventory and the JSON (a backup) are always whole
function exportAllModal() {
  const year = pickedYear(), inYear = year ? projects.filter(s => yearOf(s) === year) : projects;
  const n = projects.length, k = Object.keys(products).length;
  openModal(`
    <h2>Export all data</h2>
    <p class="hint" style="margin-top:-6px">${n} project${n === 1 ? "" : "s"} and ${k} inventory item${k === 1 ? "" : "s"}, as the app shows them. CSV files open in a spreadsheet; the JSON file has everything, for a backup or another tool.</p>
    <div style="display:grid;gap:10px">
      <button type="button" class="btn" data-export="projects">${year ? `Projects from ${year} (CSV, ${plural(inYear.length, "project")})` : "Projects (CSV)"}</button>
      <button type="button" class="btn" data-export="inventory">Inventory (CSV)</button>
      <button type="button" class="btn" data-export="json">Everything (JSON)</button>
    </div>
    <div class="modal-actions"><button type="button" class="btn" id="cancel">Close</button></div>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const day = todayISO();
    const files = {
      projects: () => [`Supply Checkout projects ${year ? year + " " : ""}${day}.csv`, projectsCsv(inYear, personText)],
      inventory: () => [`Supply Checkout inventory ${day}.csv`, inventoryCsv(products)],
      json: () => [`Supply Checkout export ${day}.json`, allJson(products, projects, personText)],
    };
    m.querySelectorAll("[data-export]").forEach(b => b.addEventListener("click", () => save(...files[b.dataset.export]())));
  });
}

/* ---------- wiring ---------- */
$("#tab-projects").addEventListener("click", () => { ui.tab = "projects"; ui.projectId = null; ui.receipt = false; draw(); });
$("#tab-prices").addEventListener("click", () => { ui.tab = "prices"; ui.receipt = false; draw(); });
// The logo goes home: the project list on Out now, as the app opens, with no project or dialog
// open. It's a link to the app's root, so in the web build a Ctrl/Cmd or Shift click opens
// the app in a new tab or window. Not while a dialog is saving (dismiss); a receipt being
// entered stays as its draft, which the project list offers to resume.
$("#home").addEventListener("click", e => {
  if ((e.ctrlKey || e.metaKey || e.shiftKey)) return;
  e.preventDefault();
  if (!dismiss()) return;
  ui.tab = "projects"; ui.projectId = null; ui.receipt = false; ui.filter = "open"; draw(); window.scrollTo(0, 0);
});
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
// The web build's receipt scans left (src/aws/receipts.js, usage()): shown under the bar to
// those who can scan; null until read, and in the artifact build, which has no limits
let receiptUsage = null;
const loadReceiptUsage = async () => { receiptUsage = await sampleFn.usage(); draw(); };
// The web build's team settings, for owners only (src/aws/settings.js; null for anyone else and in
// the artifact build), and the equipment markup read from them: an owner sees the price it gives
// equipment bought for a client. Nobody else's page ever has the percentage (ADR 0017, 2a).
let settingsCap = null, markup = null;
async function refreshMarkup() {
  if (!settingsCap) return;
  // Anything but a number (an owner demoted meanwhile gets an empty settings) is no markup
  try { const v = (await settingsCap.get()).settings.equipmentMarkup; markup = typeof v === "number" && Number.isFinite(v) ? v : null; } catch { markup = null; }
}
const stored = fn => { const k = draftKeyNow(); if (!k) return; try { fn(k); } catch {} };
const loadDraft = () => stored(k => { draft = JSON.parse(localStorage.getItem(k) || "null"); });
const saveDraft = () => stored(k => { draft ? localStorage.setItem(k, JSON.stringify(draft)) : localStorage.removeItem(k); });

// A name or brand on its one line of the prompt's list, as the server quotes it (inventoryList in
// backend/src/receipts/prompt.ts): no line breaks or control characters, and no "|" of its own
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const cellText = (t, max) => String(t || "").replace(/[\s|\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max);
function receiptPrompt() {
  const inv = Object.entries(products).slice(0, 500);
  const ids = Object.create(null);
  const list = inv.map(([k, p], i) => { ids["i" + (i + 1)] = k; return `i${i + 1} | ${cellText(p.name, 120)} | ${cellText(brandOf(p), MAX_BRAND)} | ${money(p.price)}`; }).join("\n");
  return { prompt: RECEIPT_PROMPT + "\n\nCurrent inventory (id | name | brand | price):\n" + (list || "(empty)"), ids };
}

function receiptError(msg) {
  $("#rBody").innerHTML = `<div class="reading"><h2>Couldn't read that receipt</h2><p>${esc(msg)}</p>
    <div class="project-actions"><label class="btn primary" for="receiptFile">Try another photo</label><button type="button" class="btn" id="rManual">Enter items by hand</button></div></div>`;
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
// Company equipment bought for a client (ADR 0017, 2a): the line's own price, if the reviewer
// typed one; otherwise the server adds the team's markup to the receipt price, which the review
// shows an owner (who has the markup), and the artifact build charges the receipt price
const isBought = l => isEquipment(lineProd(l)) && l.dest !== "stock";
const typedPrice = l => l.typed === undefined || l.typed === "" ? undefined : Math.max(0, round2(l.typed));
const boughtPrice = l => typedPrice(l) ?? (markup !== null ? round2(unitCost(l) * (1 + markup / 100)) : unitCost(l));
function chargedText(l) {
  const typed = typedPrice(l);
  if (typed !== undefined) return `Charged: ${money(typed)} each, the price you typed`;
  return markup !== null ? `Charged: ${money(boughtPrice(l))} each (receipt price + ${markup}% markup)` : "Charged: receipt price + team markup";
}
// The server adds a markup this page doesn't know (web build, not an owner), so the total is short of the charge
const preMarkup = l => markup === null && isBought(l) && typedPrice(l) === undefined;
const totalText = l => money(charge(l)) + (preMarkup(l) ? " (before markup)" : "");
const effPrice = l => { const p = lineProd(l); return isBought(l) ? boughtPrice(l) : p && priceChoice(l) === "inv" ? round2(p.price) : unitCost(l); };
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
    dests: [{ id: d1, projectId: "", client: "" }],
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
    const res = await sampleFn.json(prompt, { images: await shrinkPhoto(file), signal: ctl.signal });
    // The AWS runtime's server names the matched product by its key (src/aws/receipts.js sets
    // byKey); claude.ai's model by the prompt's ids
    const matchOf = m => res.byKey ? (typeof m === "string" && own(products, m) ? m : "") : own(ids, m) || "";
    const items = res && Array.isArray(res.items) ? res.items.filter(i => i && i.name).map(i => ({ ...i, match: matchOf(i.match) })) : [];
    // The AWS runtime's answer has the team's scans left, this one counted
    if (res.usage) { receiptUsage = res.usage; }
    if (!items.length) { receiptError("No line items were found in that photo. Lay the receipt flat, fill the frame, and make sure the text is in focus."); return; }
    draft = newDraft({ ...res, items }); saveDraft();
    await refreshMarkup(); renderReceipt();
  } catch (e) {
    if (e && e.code === "cancelled") { ui.receipt = false; draw(); return; }
    receiptError(sampleErr(e && e.code, e && e.message));
    // Refused for the team's allowance: what's left now (none)
    if (/receipt_limit$/.test(e && e.code) && sampleFn.usage) loadReceiptUsage();
  }
}

function destLabel(x, i) {
  if (x.projectId) { const s = projects.find(s => s.id === x.projectId); return s ? `${s.client} (existing project)` : "Missing project"; }
  return x.client.trim() || `Client ${i + 1}`;
}
function destOptions(sel) {
  return draft.dests.map((x, i) => `<option value="${x.id}" ${sel === x.id ? "selected" : ""}>${esc(destLabel(x, i))}</option>`).join("")
    + `<option value="stock" ${sel === "stock" ? "selected" : ""}>General inventory (storage)</option>`;
}

function renderReceipt() {
  const d = draft; if (!d) { ui.receipt = false; draw(); return; }
  // Client projects only: the General Use project takes no receipt lines (ADR 0017, section 4)
  const openProjects = projects.filter(s => s.status !== "closed" && !isAdhoc(s));
  $("#rBody").innerHTML = `
    <fieldset id="rForm" ${d.locked ? "disabled" : ""}>
    <div class="project-head">
      <h2>Review receipt</h2>
      <div class="meta">${d.store ? `<span>${esc(d.store)}</span>` : ""}<span>Purchased ${esc(fmtDate(d.receiptDate))}</span></div>
      <p class="hint">Check each item's name, quantity and price, then choose which client it's for, or General inventory for supplies going into storage. If one item is shared, tap Split and divide the quantity. Nothing is saved until you tap Save.</p>
    </div>
    <div class="panel">
      <h3>Clients on this trip</h3>
      <div class="dests">${d.dests.map((x, i) => `
        <div class="dest" data-d="${x.id}">
          <select data-dsel aria-label="Project for client ${i + 1}">
            <option value="">New project</option>
            ${openProjects.map(s => `<option value="${esc(s.id)}" ${x.projectId === s.id ? "selected" : ""}>Add to ${esc(s.client)} (${esc(fmtDate(s.date))})</option>`).join("")}
          </select>
          ${x.projectId ? "" : `<input type="text" data-dname id="dname-${x.id}" placeholder="Client name" value="${esc(x.client)}" aria-label="Client name">`}
          ${d.dests.length > 1 ? `<button type="button" class="btn ghost" data-drm aria-label="Remove this client">Remove</button>` : ""}
        </div>`).join("")}</div>
      <button type="button" class="btn" id="rAddDest">+ Add another client</button>
      <div class="row2">
        <div class="field"><label for="rDate">Date for new projects</label><input type="date" id="rDate" value="${esc(d.date)}"></div>
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
  return `<option value="">New item (not in inventory yet)</option>` + all.map(([k, p]) => `<option value="${esc(k)}" ${sel === k ? "selected" : ""}>${esc(nameWithBrand(p))}${p.code ? " · " + esc(p.code) : ""}</option>`).join("");
}
// A receipt line for company equipment: where it goes says what it is, and a bought one's price
function receiptEquipmentHTML(l) {
  if (l.dest === "stock") return `<p class="hint equip">Company equipment · added to storage, not charged</p>`;
  return `<p class="hint equip">Company equipment · bought for this client: charged on their project, not kept in storage</p>
        <p class="hint" data-charged>${esc(chargedText(l))}</p>
        <label class="lbl">Charge a different price ($)<input type="number" data-f="typed" id="t-${l.id}" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money value="${esc(l.typed ?? "")}" placeholder="Leave blank"></label>`;
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
        ${isEquipment(p) ? receiptEquipmentHTML(l) : priceDiff ? `<div class="choice warn" role="group" aria-label="Price to charge">
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
        <label>${packOf(l) > 1 ? "Per case" : "Each"} ($)<input type="number" data-f="price" id="p-${l.id}" min="0" max="${MAX_MONEY}" step="0.01" inputmode="decimal" data-money value="${l.price}"></label>
        <label class="grow">For<select data-f="dest" id="d-${l.id}">${destOptions(l.dest)}</select></label>
      </div>
      <p class="hint" data-note>${lineNote(l)}</p>
      <div class="ractions"><span class="num" data-total>${totalText(l)}</span><span class="spacer"></span><button type="button" class="btn ghost" data-split>Split</button><button type="button" class="btn ghost" data-del>Remove</button></div>
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
    .map(r => { const ls = d.lines.filter(l => l.dest === r.id); return { ...r, n: ls.reduce((a, l) => a + eaches(l), 0), $: ls.reduce((a, l) => a + Math.round(charge(l) * 100), 0) / 100, pre: ls.some(preMarkup) }; })
    .filter(r => r.n || r.id !== "stock");
  // At the receipt's prices, to compare with its subtotal
  const all = d.lines.reduce((a, l) => a + Math.round(int(l.qty) * round2(l.price) * 100), 0) / 100;
  el.innerHTML = `<h3>Summary</h3><table class="sumtable"><tbody>
    ${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.n} item${r.n === 1 ? "" : "s"}</td><td>${money(r.$)}${r.pre ? " (before markup)" : ""}</td></tr>`).join("")}
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
    if (t.dataset.f === "typed") l.typed = t.value.trim();
    if (t.dataset.f === "dest") l.dest = t.value;
    if (t.dataset.f === "code") l.code = t.value.trim();
    if (t.dataset.f === "perEach") { l.perEach = t.checked; saveDraft(); rerenderLine(l); return; }
    if (t.dataset.f === "code" || t.dataset.f === "match") return;
    const charged = row.querySelector("[data-charged]");
    if (charged) charged.textContent = chargedText(l);
    row.querySelector("[data-total]").textContent = totalText(l);
    row.querySelector("[data-note]").textContent = lineNote(l);
    paintSum();
  } else if (t.id === "rDate") d.date = t.value;
  else if (t.id === "rBy") d.by = t.value;
  saveDraft();
});
$("#rBody").addEventListener("change", e => {
  const d = draft, t = e.target; if (!editable(t)) return;
  if (t.matches("[data-dsel]")) { const x = d.dests.find(x => x.id === t.closest("[data-d]").dataset.d); x.projectId = t.value; saveDraft(); renderReceipt(); }
  else if (t.dataset.f === "dest") {
    const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); l.dest = t.value; saveDraft();
    // Equipment says what it is where it goes: bought for a client, or into storage
    if (isEquipment(lineProd(l))) rerenderLine(l); else paintSum();
  }
  else if (t.dataset.f === "match") { const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); l.match = t.value; l.suggested = false; l.useName = "inv"; l.usePrice = ""; l.perEach = false; saveDraft(); rerenderLine(l); }
  else if (t.dataset.f === "code") { const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); const before = l.match; setCode(l, t.value); saveDraft(); if (l.match !== before) rerenderLine(l); }
  else if (t.id === "rScanFile") { const f = t; (async () => { const c = await scanFromInput(f); const l = d.lines.find(l => l.id === rScanLine); if (c && l) { setCode(l, c); saveDraft(); rerenderLine(l); } })(); }
  else if (t.id === "rSavePrices") { d.savePrices = t.checked; saveDraft(); }
});
$("#rBody").addEventListener("click", e => {
  const d = draft, t = e.target.closest("button"); if (!t || !editable(t)) return;
  const row = t.closest("[data-l]"), line = row && d.lines.find(l => l.id === row.dataset.l);
  if (t.id === "rAddDest") { d.dests.push({ id: uid(), projectId: "", client: "" }); saveDraft(); renderReceipt(); const x = d.dests[d.dests.length - 1]; const f = $("#dname-" + x.id); f && f.focus(); }
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
  // A price over the API's limit, read from the photo or typed, is fixed before anything is saved
  const over = lines.find(l => Number(l.price) > MAX_MONEY);
  if (over) { toast(MONEY_LIMIT); const f = $("#p-" + over.id); f.setCustomValidity(MONEY_LIMIT); f.focus(); return; }
  const usedDests = d.dests.filter(x => lines.some(l => l.dest === x.id));
  const unnamed = usedDests.find(x => !x.projectId && !x.client.trim());
  if (unnamed) { toast("Enter a client name for each new project."); const f = $("#dname-" + unnamed.id); f && f.focus(); return; }
  if (usedDests.some(x => !x.projectId) && !d.date) { toast("Choose a date for the new projects."); return; }
  if (!myId && usedDests.some(x => !x.projectId) && !d.by.trim()) { toast("Enter who prepared these projects."); $("#rBy") && $("#rBy").focus(); return; }
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
  // stays locked and the button says Try again. Refused (a project deleted, view-only, storage
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
    // Company equipment has no client price: a receipt sets only its value, its cost (ADR 0017)
    if (isEquipment(ex)) delete body.price;
    if (add) body.stock = (hasStock(ex) ? ex.stock : 0) + add;
    if (!await write(() => saveItem(db, null, k, body, { reason: "receipt", lines: stocked.map(stockIn) }))) { failed(); return; }
    // Written: drop its stock lines, so they can't be added twice
    d.lines = d.lines.filter(l => !stocked.includes(l)); saveDraft();
  }

  const savedIds = [];
  for (const x of usedDests) {
    // Equipment bought for the client goes on lines of its own (bought), added after the rest
    const ls = lines.filter(l => l.dest === x.id), items = {}, bought = {};
    for (const l of ls) {
      const k = keyOfLine[l.id], code = (products[k] && products[k].code) || l.code || "";
      if (isBought(l)) {
        // The receipt price each, and the reviewer's price if they typed one; never a markup price
        const typed = typedPrice(l);
        const b = own(bought, k) || (bought[k] = { code, name: effName(l), cost: unitCost(l), out: 0, ...(typed === undefined ? {} : { typed, by: myId || d.by.trim() }) });
        b.out += eaches(l);
        continue;
      }
      const it = own(items, k) || (items[k] = { code, name: effName(l), price: effPrice(l), cost: unitCost(l), out: 0, returned: 0 });
      it.out += eaches(l);
    }
    let ok;
    if (x.projectId) {
      if (!projects.some(s => s.id === x.projectId)) {
        toast("One of the chosen projects was deleted. Pick another and save again.");
        d.lines = d.lines.filter(l => !usedDests.slice(0, usedDests.indexOf(x)).some(y => y.id === l.dest));
        retryable = false; failed(); return;
      }
      ok = await write(() => addLines(db, x, x.projectId, items, bought), undefined, x.projectId);
      if (ok) savedIds.push(x.projectId);
    } else {
      // One new project per destination, whatever the attempt: its ID and creation time are kept
      // with the draft. Once an attempt has been made, the next looks for the project first, so
      // one whose answer was lost isn't saved again.
      const tried = !!x.newId;
      x.newId ||= db.collection("projects").doc().id;
      x.createdAt ||= new Date().toISOString();
      saveDraft();
      const ref = db.collection("projects").doc(x.newId);
      const body = { client: x.client.trim(), date: d.date, createdBy: myId || null, createdAt: x.createdAt, status: "open", items };
      if (!myId) body.createdByName = d.by.trim();
      if (d.store) body.source = { store: d.store, receiptDate: d.receiptDate };
      // A line bought for the client is added to the new project once it exists, as to any project
      ok = await write(async () => {
        if (!tried || !(await ref.get()).exists) await ref.set(body);
        if (Object.keys(bought).length) await addLines(db, x, ref.id, {}, bought);
      });
      if (ok) addLocalProject(ref.id, body);
      if (ok) savedIds.push(ref.id);
    }
    if (!ok) {
      // Keep only what hasn't been saved, so saving again won't duplicate
      d.lines = d.lines.filter(l => !usedDests.slice(0, usedDests.indexOf(x)).some(y => y.id === l.dest));
      failed(); return;
    }
  }
  rSaving = false; draft = null; saveDraft(); ui.receipt = false;
  if (savedIds.length === 1) ui.projectId = savedIds[0];
  ui.tab = "projects"; draw(); window.scrollTo(0, 0);
  const nStock = toStock.reduce((a, l) => a + eaches(l), 0);
  toast([savedIds.length ? `Saved to ${savedIds.length} project${savedIds.length === 1 ? "" : "s"}` : "", nStock ? `${nStock} added to storage` : ""].filter(Boolean).join(" · "));
  if (!savedIds.length) { ui.tab = "prices"; draw(); }
}

$("#receiptFile").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f && sampleFn) startReceipt(f); });
$("#rBack").addEventListener("click", () => { ui.receipt = false; draw(); });

$("#backBtn").addEventListener("click", () => { ui.projectId = null; draw(); });
document.querySelectorAll(".mode button").forEach(b => b.addEventListener("click", () => { ui.mode = b.dataset.mode; draw(); }));
$("#scanFile").addEventListener("change", async e => { const c = await scanFromInput(e.target); if (c) handleCode(c); });
$("#noCodeBtn").addEventListener("click", () => { const s = currentProject(); if (s) (modeOf(s) === "out" ? pickOutModal : pickReturnModal)(s); });
$("#manualForm").addEventListener("submit", e => { e.preventDefault(); const i = $("#manualCode"); const c = i.value.trim(); i.value = ""; if (c) handleCode(c); });

draw();

(async () => {
  [db, userNs, dl, sampleFn] = await Promise.all([use("db"), use("user"), use("downloads"), use("sample")]);
  {
    const drafts = await use("drafts"); if (drafts) draftKeyNow = () => drafts.key; loadDraft();
    const fr = await use("firstRun");
    settingsCap = await use("settings");
    if (fr) firstRun = createFirstRun(fr, { addItem: () => { ui.tab = "prices"; draw(); productModal(null); }, newProject: () => { ui.tab = "projects"; draw(); newProjectModal(); }, redraw: draw });
  }
  if (sampleFn) { try { const lim = await sampleFn.limits(); receiptOK = !!(lim && lim.images); } catch {} }
  // Only the AWS runtime has usage(); the tests' mock runtime, in the web build too, hasn't
  if (receiptOK && sampleFn.usage) loadReceiptUsage();
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
  db.collection("projects").orderBy("date", "desc").onSnapshot(snap => {
    projects = snap.docs.map(liveProject);
    if (sFirst) { sFirst = false; ready(); } else render();
  }, onErr);
})();
