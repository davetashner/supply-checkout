import { use } from "./runtime.js";
import { esc, money, todayISO, fmtDate, keyOf, int, codeText, hasStock, newKey, uid, round2, numOrNull } from "./format.js";
import { lines, totals } from "./sheet-math.js";
import { $, toast, openModal, closeModal, armButton, stepperHTML, setText, setHTML, wireStepper } from "./dom.js";
import { scanFromInput } from "./barcode.js";
import { RECEIPT_PROMPT, sampleErr } from "./receipt-prompt.js";

async function bumpStock(key, delta) {
  // Adds (or removes) units from the storage count. Items nobody has counted stay uncounted when removing.
  const p = products[key]; if (!p || !delta) return true;
  if (!hasStock(p) && delta < 0) return true;
  return write(() => db.doc("products/" + key).update({ stock: Math.max(0, (hasStock(p) ? p.stock : 0) + delta) }));
}

let db = null, userNs = null, dl = null, myId = null, canWrite = true, connected = false;
let products = {}, sheets = [], people = {};
const ui = { tab: "sheets", sheetId: null, mode: "out", filter: "open", receipt: false };

async function write(fn, okMsg) {
  if (!db) { toast("Not connected to shared storage."); return false; }
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) {
    if (e && e.code === "invalid_argument") { canWrite = false; render(); toast("You have view-only access. Ask the owner for Contributor access to make changes."); }
    else if (e && e.code === "quota_exceeded") toast("Storage is full. Delete old sheets or items to make room.");
    else toast("That didn't save. Check your connection and try again.");
    return false;
  }
}

const currentSheet = () => sheets.find(s => s.id === ui.sheetId);
// Show a sheet we just created right away; the next snapshot replaces this copy
const addLocalSheet = (id, body) => { if (!sheets.some(s => s.id === id)) sheets = [{ id, ...body }, ...sheets]; };
function personHTML(s) {
  if (s.createdBy) {
    const p = people[s.createdBy];
    return `<span class="who">${p ? `<img src="${esc(p.avatarUrl)}" alt="">` : ""}${esc((p && p.name) || "Someone")}</span>`;
  }
  return `<span class="who">${esc(s.createdByName || "Unknown")}</span>`;
}
function personText(s) { return s.createdBy ? ((people[s.createdBy] || {}).name || "Someone") : (s.createdByName || "Unknown"); }

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

function draw() {
  $("#tab-sheets").setAttribute("aria-pressed", ui.tab === "sheets");
  $("#tab-prices").setAttribute("aria-pressed", ui.tab === "prices");
  const notice = $("#notice");
  if (!connected) { notice.hidden = false; notice.textContent = "Connecting to shared storage… If this doesn't clear, open this page on claude.ai while signed in."; }
  else if (!canWrite) { notice.hidden = false; notice.textContent = "You have view-only access. Ask the owner to give you Contributor access to scan and edit."; }
  else notice.hidden = true;

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

function drawList() {
  const shown = sheets.filter(s => ui.filter === "all" || (ui.filter === "open" ? s.status !== "closed" : s.status === "closed"));
  const openCount = sheets.filter(s => s.status !== "closed").length;
  $("#main").innerHTML = `
    <div class="bar">
      <div class="chips" role="group" aria-label="Filter sheets">
        <button type="button" class="chip" data-filter="open" aria-pressed="${ui.filter==="open"}">Out now (${openCount})</button>
        <button type="button" class="chip" data-filter="closed" aria-pressed="${ui.filter==="closed"}">Returned</button>
        <button type="button" class="chip" data-filter="all" aria-pressed="${ui.filter==="all"}">All</button>
      </div>
      <div class="chips">
        ${canWrite && receiptOK ? `<label class="btn" for="receiptFile">Scan receipt</label>` : ""}
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
    </div>`;
  const ns = $("#newSheet"); ns && ns.addEventListener("click", () => newSheetModal());
  const rs = $("#resume"); rs && rs.addEventListener("click", () => { ui.receipt = true; draw(); renderReceipt(); window.scrollTo(0, 0); });
  $("#main").querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => { ui.filter = b.dataset.filter; draw(); }));
  $("#main").querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { ui.sheetId = b.dataset.open; draw(); window.scrollTo(0,0); }));
}

function drawSheet(s) {
  const closed = s.status === "closed", t = totals(s), ls = lines(s);
  $("#sheetHead").innerHTML = `
    <div class="sheet-head">
      <h2>${esc(s.client || "Untitled")}</h2>
      <div class="meta"><span>${esc(fmtDate(s.date))}</span><span>Prepared by ${personHTML(s)}</span><span class="pill ${closed ? "closed" : "open"}">${closed ? "Returned" : "Checked out"}</span></div>
      <div class="sheet-actions">
        ${dl ? `<button type="button" class="btn" id="exportCsv">Download CSV</button>` : ""}
        ${canWrite ? `<button type="button" class="btn" id="editSheet">Edit details</button>` : ""}
        ${canWrite ? (closed ? `<button type="button" class="btn" id="reopen">Reopen</button>` : `<button type="button" class="btn" id="closeSheet">Finished Return</button>`) : ""}
      </div>
    </div>`;
  $("#scanbar").hidden = closed || !canWrite;
  document.querySelectorAll(".mode button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === ui.mode));
  $("#scanLabel").textContent = ui.mode === "out" ? "Scan to check out" : "Scan to return";
  $("#noCodeBtn").textContent = ui.mode === "out" ? "Add item without a barcode" : "Return item without a barcode";
  $("#modeHint").textContent = ui.mode === "out"
    ? "Take a photo of the barcode, then choose how many you're taking."
    : "Scan an item you're bringing back and enter how many are unused. Whatever isn't returned counts as used. Tap Finished Return when everything is back.";

  $("#sheetBody").innerHTML = `
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
          <td>${u}</td><td class="charge">${money(u * (Number(l.price)||0))}</td>
        </tr>`; }).join("")}</tbody>
      <tfoot><tr><td>Total</td><td></td><td>${t.out}</td><td>${t.ret}</td><td>${t.used}</td><td>${money(t.charge)}</td></tr></tfoot>
    </table></div>` : `<div class="empty">No supplies on this sheet yet. Scan a barcode to check one out.</div>`}
    ${canWrite ? `<div class="sheet-actions" style="margin-top:18px"><button type="button" class="btn danger" id="delSheet">Delete sheet</button></div>` : ""}`;

  const on = (id, fn) => { const el = document.getElementById(id); el && el.addEventListener("click", fn); };
  on("exportCsv", () => exportCsv(s));
  on("editSheet", () => newSheetModal(s));
  on("closeSheet", () => write(() => db.doc("sheets/" + s.id).update({ status: "closed", closedAt: new Date().toISOString() }), "Return finished"));
  on("reopen", () => write(() => db.doc("sheets/" + s.id).update({ status: "open" }), "Sheet reopened"));
  const del = $("#delSheet");
  del && armButton(del, "Tap again to delete", async () => { if (await write(() => db.doc("sheets/" + s.id).delete(), "Sheet deleted")) { ui.sheetId = null; draw(); } });
  $("#sheetBody").querySelectorAll("tr[data-line]").forEach(tr => {
    if (!canWrite) return;
    const go = () => lineModal(s, tr.dataset.line);
    tr.addEventListener("click", go);
    // preventDefault: otherwise this Enter press also submits the editor's form
    tr.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  });
}

function drawPrices() {
  const list = Object.entries(products).map(([key, p]) => ({ key, ...p })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  $("#main").innerHTML = `
    <div class="bar">
      <p class="muted" style="margin:0">${list.length} item${list.length===1?"":"s"}. Storage counts go down when items are checked out and up when they're returned or bought for general inventory.</p>
      ${canWrite ? `<button type="button" class="btn primary" id="addProduct">+ Add item</button>` : ""}
    </div>
    ${list.length ? `<div class="table-wrap"><table class="prices">
      <thead><tr><th>Item</th><th>In storage</th><th>Price each</th><th>Value</th></tr></thead>
      <tbody>${list.map(p => `<tr class="${canWrite ? "click" : ""}" data-prod="${esc(p.key)}" ${canWrite ? 'tabindex="0"' : ""}><td>${esc(p.name || "Unnamed item")}<span class="code">${esc(codeText(p.code))}</span></td><td class="${hasStock(p) ? "" : "muted"}">${hasStock(p) ? p.stock : "—"}</td><td>${money(p.price)}</td><td>${hasStock(p) ? money(p.stock * (Number(p.price) || 0)) : "—"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total in storage</td><td>${list.reduce((a, p) => a + (hasStock(p) ? p.stock : 0), 0)}</td><td></td><td>${money(list.reduce((a, p) => a + (hasStock(p) ? p.stock * (Number(p.price) || 0) : 0), 0))}</td></tr></tfoot>
    </table></div>` : `<div class="empty">${connected ? "No items yet. Add one, or scan a barcode on a sheet." : "Loading…"}</div>`}`;
  const ap = $("#addProduct"); ap && ap.addEventListener("click", () => productModal(null));
  $("#main").querySelectorAll("tr[data-prod]").forEach(tr => {
    if (!canWrite) return;
    const go = () => productModal(tr.dataset.prod);
    tr.addEventListener("click", go);
    // preventDefault: otherwise this Enter press also submits the editor's form
    tr.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  });
}

function newSheetModal(existing) {
  const editing = existing && existing.id;
  const needName = !editing && !myId;
  openModal(`
    <h2>${editing ? "Edit sheet" : "New sheet"}</h2>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fClient">Client</label><input type="text" id="fClient" required autofocus value="${esc(editing ? existing.client : "")}" placeholder="Client or job name"></div>
      <div class="field"><label for="fDate">Date</label><input type="date" id="fDate" required value="${esc(editing ? existing.date : todayISO())}"></div>
      ${needName ? `<div class="field"><label for="fBy">Prepared by</label><input type="text" id="fBy" required placeholder="Your name"></div>` : ""}
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">${editing ? "Save" : "Create sheet"}</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelector("#f").addEventListener("submit", async e => {
      e.preventDefault();
      const client = m.querySelector("#fClient").value.trim(), date = m.querySelector("#fDate").value;
      if (!client || !date) return;
      if (editing) {
        if (await write(() => db.doc("sheets/" + existing.id).update({ client, date }), "Saved")) closeModal();
        return;
      }
      const ref = db.collection("sheets").doc();
      const body = { client, date, createdBy: myId || null, createdAt: new Date().toISOString(), status: "open", items: {} };
      if (needName) body.createdByName = m.querySelector("#fBy").value.trim();
      if (await write(() => ref.set(body), "Sheet created")) { addLocalSheet(ref.id, body); closeModal(); ui.sheetId = ref.id; ui.mode = "out"; draw(); }
    });
  });
}

function checkoutModal(s, code, key = keyOf(code)) {
  const prod = products[key], line = (s.items || {})[key];
  openModal(`
    <h2>Check out</h2>
    <div class="code">${esc(codeText(code))}</div>
    <form id="f" style="display:grid;gap:14px">
      ${prod ? `<div class="item-known"><strong>${esc(prod.name)}</strong><span class="num">${money(prod.price)} each</span></div>${hasStock(prod) ? `<div class="summary"><span>In storage</span><b>${prod.stock}</b></div>` : ""}`
             : `<p class="hint" style="margin-top:-4px">${code ? "New barcode. Name it and set a price, and it'll be saved to inventory." : "Name the item and set a price."}</p>
                <div class="field"><label for="fName">Item name</label><input type="text" id="fName" required autofocus placeholder="${code ? "e.g. Nitrile gloves, box of 100" : "e.g. Leftover storage bins"}"></div>
                <div class="field"><label for="fPrice">Price each ($)</label><input type="number" id="fPrice" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>
                ${code ? "" : `<label class="check"><input type="checkbox" id="fSave" checked> Save to inventory for next time</label>`}`}
      ${line ? `<div class="summary"><span>Already on this sheet</span><b>${int(line.out)} taken</b></div>` : ""}
      <div class="field"><label for="fQty">How many are you taking?</label>${stepperHTML("fQty", 1)}</div>
      <div class="modal-actions"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary" id="go">Add to sheet</button></div>
    </form>`, m => {
    const getQty = wireStepper(m, "fQty", v => setText(m.querySelector("#go"), `Add ${v} to sheet`));
    m.querySelector("#go").textContent = "Add 1 to sheet";
    m.querySelector("#cancel").addEventListener("click", closeModal);
    m.querySelector("#f").addEventListener("submit", async e => {
      e.preventDefault();
      const qty = getQty(); if (!qty) { toast("Choose at least 1."); return; }
      let name = prod && prod.name, price = prod ? Number(prod.price) || 0 : 0;
      if (!prod) {
        name = m.querySelector("#fName").value.trim(); price = Math.max(0, Number(m.querySelector("#fPrice").value) || 0);
        if (!name) return;
        const save = code || m.querySelector("#fSave").checked;
        if (save && !await write(() => db.doc("products/" + key).set({ code, name, price, updatedAt: new Date().toISOString() }))) return;
      }
      const fresh = currentSheet() || s, cur = (fresh.items || {})[key];
      const item = { code, name: cur ? cur.name : name, price: cur ? cur.price : price, out: int(cur && cur.out) + qty, returned: int(cur && cur.returned) };
      if (await write(() => db.doc("sheets/" + s.id).update({ items: { [key]: item } }), `Checked out ${qty} × ${item.name}`)) { closeModal(); await bumpStock(key, -qty); }
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
    m.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { const l = (s.items || {})[b.dataset.k] || {}; returnModal(s, l.code || "", b.dataset.k); }));
  });
}

function returnModal(s, code, key = keyOf(code)) {
  const line = (s.items || {})[key], prod = products[key];
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
    m.querySelector("#f").addEventListener("submit", async e => {
      e.preventDefault();
      const r = getR(); if (!r) { toast("Choose at least 1."); return; }
      // Add to the latest count, in case someone else recorded a return meanwhile
      const cur = ((currentSheet() || s).items || {})[key] || line;
      const out = int(cur.out), before = Math.min(int(cur.returned), out), back = Math.min(out, before + r);
      if (await write(() => db.doc("sheets/" + s.id).update({ items: { [key]: { returned: back } } }), `${back - before} returned · ${back} of ${out} back`)) { closeModal(); await bumpStock(key, back - before); }
    });
  });
}

function lineModal(s, key) {
  const l = (s.items || {})[key]; if (!l) return;
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
    armButton(m.querySelector("#remove"), "Tap to remove", async () => {
      const fresh = currentSheet() || s; const items = { ...(fresh.items || {}) }; delete items[key];
      const body = { ...fresh }; delete body.id; body.items = items;
      if (await write(() => db.doc("sheets/" + s.id).set(body), "Removed")) closeModal();
    });
    m.querySelector("#f").addEventListener("submit", async e => {
      e.preventDefault();
      const out = int(m.querySelector("#fOut").value), returned = Math.min(int(m.querySelector("#fRet").value), out);
      const price = Math.max(0, Number(m.querySelector("#fPrice").value) || 0);
      if (await write(() => db.doc("sheets/" + s.id).update({ items: { [key]: { out, returned, price } } }), "Saved")) closeModal();
    });
  });
}

function productModal(key) {
  const p = key ? products[key] : null;
  openModal(`
    <h2>${p ? "Edit item" : "Add item"}</h2>
    <form id="f" style="display:grid;gap:14px">
      <div class="field"><label for="fCode">Barcode${p ? "" : " (optional)"}</label>
        ${p ? `<div class="code" style="margin:0">${esc(codeText(p.code))}</div>`
            : `<div class="manual"><input type="text" id="fCode" inputmode="numeric" autocomplete="off" placeholder="Type, scan, or leave blank"><label class="btn" for="fScan">Scan</label></div><input class="vh" type="file" id="fScan" accept="image/*" capture="environment">`}
      </div>
      <div class="field"><label for="fName">Item name</label><input type="text" id="fName" required value="${esc(p ? p.name : "")}" ${p ? "autofocus" : ""}></div>
      <div class="field"><label for="fPrice">Price each ($)</label><input type="number" id="fPrice" min="0" step="0.01" inputmode="decimal" value="${p ? (Number(p.price) || 0) : ""}" placeholder="0.00"></div>
      <div class="field"><label for="fStock">In storage now</label><input type="number" id="fStock" min="0" inputmode="numeric" value="${hasStock(p) ? p.stock : ""}" placeholder="Leave blank if not counted"></div>
      ${p ? `<p class="hint">Price changes apply to new checkouts. Sheets keep the price they were checked out at; change it on a sheet by tapping the row.</p>` : ""}
      <div class="modal-actions">${p ? `<button type="button" class="btn danger" id="remove">Delete</button><span class="spacer"></span>` : ""}<button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, m => {
    m.querySelector("#cancel").addEventListener("click", closeModal);
    const scan = m.querySelector("#fScan");
    scan && scan.addEventListener("change", async () => { const c = await scanFromInput(scan); if (c) m.querySelector("#fCode").value = c; });
    const rm = m.querySelector("#remove");
    rm && armButton(rm, "Tap to delete", async () => { if (await write(() => db.doc("products/" + key).delete(), "Item deleted")) closeModal(); });
    m.querySelector("#f").addEventListener("submit", async e => {
      e.preventDefault();
      const code = p ? (p.code || "") : m.querySelector("#fCode").value.trim();
      const name = m.querySelector("#fName").value.trim(), price = Math.max(0, Number(m.querySelector("#fPrice").value) || 0);
      if (!name) return;
      const docKey = p ? key : (code ? keyOf(code) : newKey());
      const body = { code, name, price, updatedAt: new Date().toISOString() };
      const st = m.querySelector("#fStock").value.trim(); if (st !== "") body.stock = int(st);
      if (await write(() => db.doc("products/" + docKey).set(body), "Saved")) closeModal();
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
async function exportCsv(s) {
  const q = v => { const t = String(v ?? ""); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const t = totals(s);
  const rows = [
    ["Client", s.client], ["Date", s.date], ["Prepared by", personText(s)], ["Status", s.status === "closed" ? "Returned" : "Checked out"], [],
    ["Item", "Barcode", "Price each", "Taken", "Returned", "Used", "Charge"],
    ...lines(s).map(l => { const o = int(l.out), r = Math.min(int(l.returned), o); return [l.name, l.code || "", (Number(l.price)||0).toFixed(2), o, r, o - r, ((o - r) * (Number(l.price)||0)).toFixed(2)]; }),
    ["Total", "", "", t.out, t.ret, t.used, t.charge.toFixed(2)]
  ];
  const data = rows.map(r => r.map(q).join(",")).join("\n");
  try { await dl.save({ filename: `${[(s.client || "sheet").replace(/[\\/:*?"<>|]/g, ""), s.date].filter(Boolean).join(" ").trim()}.csv`, data }); }
  catch (e) { if (e && e.code !== "declined") toast("Couldn't prepare the download here."); }
}

/* ---------- wiring ---------- */
$("#tab-sheets").addEventListener("click", () => { ui.tab = "sheets"; ui.sheetId = null; ui.receipt = false; draw(); });
$("#tab-prices").addEventListener("click", () => { ui.tab = "prices"; ui.receipt = false; draw(); });
/* ---------- receipts ---------- */
const DKEY = "supplyCheckout.receiptDraft";
let sampleFn = null, receiptOK = false, draft = null;
try { draft = JSON.parse(localStorage.getItem(DKEY) || "null"); } catch {}
const saveDraft = () => { try { draft ? localStorage.setItem(DKEY, JSON.stringify(draft)) : localStorage.removeItem(DKEY); } catch {} };

function receiptPrompt() {
  const inv = Object.entries(products).slice(0, 500);
  const ids = {};
  const list = inv.map(([k, p], i) => { ids["i" + (i + 1)] = k; return `i${i + 1} | ${String(p.name || "").replace(/\s+/g, " ").slice(0, 120)} | ${money(p.price)}`; }).join("\n");
  return { prompt: RECEIPT_PROMPT + "\n\nCurrent inventory (id | name | price):\n" + (list || "(empty)"), ids };
}

function receiptError(msg) {
  $("#rBody").innerHTML = `<div class="reading"><h2>Couldn't read that receipt</h2><p>${esc(msg)}</p>
    <div class="sheet-actions"><label class="btn primary" for="receiptFile">Try another photo</label><button type="button" class="btn" id="rManual">Enter items by hand</button></div></div>`;
  $("#rManual").addEventListener("click", () => { draft = newDraft({ items: [{ name: "", qty: 1, price: 0 }] }); saveDraft(); renderReceipt(); });
}

function newLine(o) { return { id: uid(), name: "", raw: "", qty: 1, price: 0, dest: "", code: "", match: "", suggested: false, useName: "inv", usePrice: "receipt", ...o }; }
const lineProd = l => (l.match && products[l.match]) || null;
const effName = l => { const p = lineProd(l); return p && l.useName === "inv" ? p.name : l.name.trim(); };
const effPrice = l => { const p = lineProd(l); return p && l.usePrice === "inv" ? (Number(p.price) || 0) : (Number(l.price) || 0); };
let rScanLine = null;

function newDraft(res) {
  const date = typeof res.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(res.date) ? res.date : todayISO();
  const d1 = uid();
  return {
    store: typeof res.store === "string" ? res.store.trim() : "", receiptDate: date, date: todayISO(),
    subtotal: numOrNull(res.subtotal), tax: numOrNull(res.tax), total: numOrNull(res.total),
    savePrices: true, by: "",
    dests: [{ id: d1, sheetId: "", client: "" }],
    lines: (res.items || []).map(it => newLine({ name: String(it.name || "").trim(), raw: String(it.raw || "").trim(), qty: Math.max(1, Math.round(Number(it.qty) || 1)), price: round2(it.price), match: it.match || "", suggested: !!it.match, dest: d1 })),
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
    const items = res && Array.isArray(res.items) ? res.items.filter(i => i && i.name).map(i => ({ ...i, match: ids[i.match] || "" })) : [];
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
    <div class="modal-actions"><button type="button" class="btn danger" id="rDiscard">Discard</button><span class="spacer"></span><button type="button" class="btn primary big" id="rSave">Save</button></div>`;
  armButton($("#rDiscard"), "Tap again to discard", () => { draft = null; saveDraft(); ui.receipt = false; draw(); toast("Receipt discarded"); });
  paintSum();
}

function invOptions(sel) {
  const all = Object.entries(products).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
  return `<option value="">New item (not in inventory yet)</option>` + all.map(([k, p]) => `<option value="${esc(k)}" ${sel === k ? "selected" : ""}>${esc(p.name)}${p.code ? " · " + esc(p.code) : ""}</option>`).join("");
}
function lineHTML(l) {
  const p = lineProd(l);
  const priceDiff = p && Math.abs((Number(p.price) || 0) - (Number(l.price) || 0)) > 0.004;
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
        ${priceDiff ? `<div class="choice warn" role="group" aria-label="Price to use">
          <span class="lbl">Price changed</span>
          <button type="button" data-price="receipt" aria-pressed="${l.usePrice === "receipt"}">${money(l.price)}<small>Receipt price</small></button>
          <button type="button" data-price="inv" aria-pressed="${l.usePrice === "inv"}">${money(p.price)}<small>Keep inventory price</small></button>
        </div>` : ""}
        ${hasStock(p) ? `<div class="hint">${p.stock} in storage now</div>` : ""}`
      : `<label class="lbl">Item name<input type="text" data-f="name" id="n-${l.id}" value="${esc(l.name)}" placeholder="Item name"></label>`}
      <div class="lbl">Barcode (optional)
        <div class="manual"><input type="text" data-f="code" id="c-${l.id}" value="${esc(l.code || (p && p.code) || "")}" inputmode="numeric" autocomplete="off" placeholder="Type or scan" ${p && p.code ? "readonly" : ""}>${p && p.code ? "" : `<button type="button" class="btn" data-scan>Scan</button>`}</div>
      </div>
      ${codeClash ? `<p class="hint warn">This inventory item already has barcode ${esc(p.code)}. Pick a different inventory item if this is a different product.</p>` : ""}
      <div class="rrow">
        <label>Qty<input type="number" data-f="qty" id="q-${l.id}" min="0" inputmode="numeric" value="${l.qty}"></label>
        <label>Each ($)<input type="number" data-f="price" id="p-${l.id}" min="0" step="0.01" inputmode="decimal" value="${l.price}"></label>
        <label class="grow">For<select data-f="dest" id="d-${l.id}">${destOptions(l.dest)}</select></label>
      </div>
      <div class="ractions"><span class="num" data-total>${money(int(l.qty) * effPrice(l))}</span><span class="spacer"></span><button type="button" class="btn ghost" data-split>Split</button><button type="button" class="btn ghost" data-del>Remove</button></div>
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
    .map(r => { const ls = d.lines.filter(l => l.dest === r.id); return { ...r, n: ls.reduce((a, l) => a + int(l.qty), 0), $: ls.reduce((a, l) => a + int(l.qty) * effPrice(l), 0) }; })
    .filter(r => r.n || r.id !== "stock");
  const all = d.lines.reduce((a, l) => a + int(l.qty) * effPrice(l), 0);
  el.innerHTML = `<h3>Summary</h3><table class="sumtable"><tbody>
    ${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.n} item${r.n === 1 ? "" : "s"}</td><td>${money(r.$)}</td></tr>`).join("")}
    <tr class="strong"><td>Items total</td><td></td><td>${money(all)}</td></tr>
    ${d.subtotal != null ? `<tr><td>Receipt subtotal</td><td></td><td>${money(d.subtotal)}</td></tr>` : ""}
    ${d.tax != null ? `<tr><td>Tax on receipt (not added)</td><td></td><td>${money(d.tax)}</td></tr>` : ""}
  </tbody></table>
  ${d.subtotal != null && Math.abs(d.subtotal - all) > 0.01 ? `<p class="hint warn">Items total doesn't match the receipt subtotal. Check for a missed or misread line.</p>` : ""}`;
}

$("#rBody").addEventListener("input", e => {
  const d = draft; if (!d) return; const t = e.target;
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
    if (t.dataset.f === "code" || t.dataset.f === "match") return;
    row.querySelector("[data-total]").textContent = money(int(l.qty) * effPrice(l));
    paintSum();
  } else if (t.id === "rDate") d.date = t.value;
  else if (t.id === "rBy") d.by = t.value;
  saveDraft();
});
$("#rBody").addEventListener("change", e => {
  const d = draft; if (!d) return; const t = e.target;
  if (t.matches("[data-dsel]")) { const x = d.dests.find(x => x.id === t.closest("[data-d]").dataset.d); x.sheetId = t.value; saveDraft(); renderReceipt(); }
  else if (t.dataset.f === "dest") { d.lines.find(l => l.id === t.closest("[data-l]").dataset.l).dest = t.value; saveDraft(); paintSum(); }
  else if (t.dataset.f === "match") { const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); l.match = t.value; l.suggested = false; l.useName = "inv"; l.usePrice = "receipt"; saveDraft(); rerenderLine(l); }
  else if (t.dataset.f === "code") { const l = d.lines.find(l => l.id === t.closest("[data-l]").dataset.l); const before = l.match; setCode(l, t.value); saveDraft(); if (l.match !== before) rerenderLine(l); }
  else if (t.id === "rScanFile") { const f = t; (async () => { const c = await scanFromInput(f); const l = d.lines.find(l => l.id === rScanLine); if (c && l) { setCode(l, c); saveDraft(); rerenderLine(l); } })(); }
  else if (t.id === "rSavePrices") { d.savePrices = t.checked; saveDraft(); }
});
$("#rBody").addEventListener("click", e => {
  const d = draft; if (!d) return; const t = e.target.closest("button"); if (!t) return;
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
    d.lines.splice(d.lines.indexOf(line) + 1, 0, copy); saveDraft(); renderReceipt();
    const f = $("#q-" + copy.id); f && f.focus();
  }
  else if (t.matches("[data-del]") && line) { d.lines = d.lines.filter(l => l !== line); saveDraft(); renderReceipt(); }
  else if (t.id === "rAddLine") { const l = newLine({ dest: d.dests[0].id }); d.lines.push(l); saveDraft(); renderReceipt(); $("#n-" + l.id).focus(); }
  else if (t.id === "rSave") saveReceipt(t);
});

function rerenderLine(l) {
  const old = document.querySelector(`#rBody .rline[data-l="${l.id}"]`); if (!old) return;
  const tmp = document.createElement("div"); tmp.innerHTML = lineHTML(l).trim();
  old.replaceWith(tmp.firstElementChild); paintSum();
}

async function saveReceipt(btn) {
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
  btn.disabled = true; btn.textContent = "Saving…";
  const done = () => { btn.disabled = false; btn.textContent = "Save"; };

  const byName = {};
  for (const [k, p] of Object.entries(products)) byName[String(p.name || "").trim().toLowerCase()] = k;
  const keyOfLine = {}, newByName = {};
  for (const l of lines) {
    let k = lineProd(l) ? l.match : "";
    if (!k && l.code) k = keyForCode(l.code);
    if (!k) { const n = l.name.trim().toLowerCase(); k = byName[n] || newByName[n] || (newByName[n] = newKey()); }
    keyOfLine[l.id] = k;
  }
  const groups = {};
  for (const l of lines) (groups[keyOfLine[l.id]] = groups[keyOfLine[l.id]] || []).push(l);
  for (const [k, ls] of Object.entries(groups)) {
    const ex = products[k], add = ls.filter(l => l.dest === "stock").reduce((a, l) => a + int(l.qty), 0);
    if (!ex && !add && !d.savePrices) continue;
    const l0 = ls[0], code = (ex && ex.code) || (ls.find(l => l.code) || {}).code || "";
    const body = { ...(ex || {}), code, name: effName(l0), price: round2(effPrice(l0)), updatedAt: new Date().toISOString() };
    if (add) body.stock = (hasStock(ex) ? ex.stock : 0) + add;
    if (!await write(() => db.doc("products/" + k).set(body))) { done(); return; }
  }
  // Inventory is written; drop those lines so a retry can't add them twice
  d.lines = d.lines.filter(l => l.dest !== "stock"); saveDraft();

  const savedIds = [];
  for (const x of usedDests) {
    const ls = lines.filter(l => l.dest === x.id), items = {};
    for (const l of ls) {
      const k = keyOfLine[l.id];
      const it = items[k] || (items[k] = { code: (products[k] && products[k].code) || l.code || "", name: effName(l), price: round2(effPrice(l)), out: 0, returned: 0 });
      it.out += int(l.qty);
    }
    let ok;
    if (x.sheetId) {
      const s = sheets.find(s => s.id === x.sheetId);
      if (!s) { toast("One of the chosen sheets was deleted. Pick another and save again."); done(); renderReceipt(); return; }
      for (const [k, it] of Object.entries(items)) { const cur = (s.items || {})[k]; if (cur) Object.assign(it, { name: cur.name, price: cur.price, out: it.out + int(cur.out), returned: int(cur.returned), code: cur.code || it.code }); }
      ok = await write(() => db.doc("sheets/" + s.id).update({ items }));
      if (ok) savedIds.push(s.id);
    } else {
      const ref = db.collection("sheets").doc();
      const body = { client: x.client.trim(), date: d.date, createdBy: myId || null, createdAt: new Date().toISOString(), status: "open", items };
      if (!myId) body.createdByName = d.by.trim();
      if (d.store) body.source = { store: d.store, receiptDate: d.receiptDate };
      ok = await write(() => ref.set(body));
      if (ok) addLocalSheet(ref.id, body);
      if (ok) savedIds.push(ref.id);
    }
    if (!ok) {
      // Keep only what hasn't been saved, so saving again won't duplicate
      d.lines = d.lines.filter(l => !usedDests.slice(0, usedDests.indexOf(x)).some(y => y.id === l.dest));
      saveDraft(); done(); renderReceipt(); return;
    }
  }
  draft = null; saveDraft(); ui.receipt = false;
  if (savedIds.length === 1) ui.sheetId = savedIds[0];
  ui.tab = "sheets"; draw(); window.scrollTo(0, 0);
  const nStock = toStock.reduce((a, l) => a + int(l.qty), 0);
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
  if (sampleFn) { try { const lim = await sampleFn.limits(); receiptOK = !!(lim && lim.images); } catch {} }
  if (userNs) {
    try { myId = await userNs.id(); } catch {}
    try { const w = await userNs.can("data.write"); if (w === false) canWrite = false; } catch {}
  }
  if (!db) { $("#notice").hidden = false; $("#notice").textContent = "Shared storage isn't available in this view. Open this page on claude.ai while signed in."; return; }
  const onErr = () => toast("Lost connection to shared storage. Reload the page.");
  let got = 0; const ready = () => { if (++got >= 2) connected = true; render(); };
  let pFirst = true, sFirst = true;
  db.collection("products").onSnapshot(snap => {
    products = {}; snap.docs.forEach(d => products[d.id] = d.data());
    if (pFirst) { pFirst = false; ready(); } else render();
  }, onErr);
  db.collection("sheets").orderBy("date", "desc").onSnapshot(snap => {
    sheets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (sFirst) { sFirst = false; ready(); } else render();
  }, onErr);
})();
