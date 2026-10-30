// Importing inventory from a CSV file, for a team's owners in the web build (assisted
// onboarding). The server reads and checks the file, and the preview shows what each row
// will do; then it imports every row or none (POST /teams/{teamId}/imports in
// docs/api/openapi.yaml). An import that stops part-way is finished by sending the same
// request again, which "Try again" does, so nothing is added twice. When the server says
// the import can't go on (409 "aborted": items kept changing, the import expired, or a
// planned key was taken), its message says what to do.
import { esc, money, brandHTML } from "../format.js";
import { msg } from "../i18n.js";
import { openModal, closeModal, toast } from "../dom.js";
// The template the dialog offers: the eight columns and three made-up example rows. Importing
// it unchanged passes the preview (backend/test/imports-api.test.ts parses this file).
import TEMPLATE from "./import-template.csv?raw";

// The server's limits (backend/src/data/imports.ts)
const MAX_BYTES = 300_000;
// Rows shown in the preview; the summary counts all of them
const SHOWN = 100;
const CHANGE = { code: "importer.changeCode", name: "importer.changeName", brand: "importer.changeBrand", kind: "importer.changeKind", price: "importer.changePrice", cost: "importer.changeCost", packSize: "importer.changePackSize", packCost: "importer.changePackCost", reorderAt: "importer.changeReorderAt", reorderQty: "importer.changeReorderQty", length: "importer.changeLength", width: "importer.changeWidth", height: "importer.changeHeight", dimUnit: "importer.changeDimUnit", stock: "importer.changeStock" };

function actionText(r) {
  if (r.action === "create") return msg("importer.actionNew");
  if (r.action === "unchanged") return msg("importer.actionUnchanged");
  return msg("importer.actionUpdate", { changes: r.changes.map((c) => msg(CHANGE[c])).join(", ") });
}

function previewHTML(res) {
  const s = res.summary;
  let html = "";
  if (res.errorCount) {
    const more = res.errorCount - res.errors.length;
    html += `<p class="error" role="alert">${msg("importer.errorRows", { count: res.errorCount })}</p>
      <ul class="import-errors">${res.errors.map((e) => `<li>${msg("importer.errorLine", { line: e.line, column: e.column ? ` (${esc(e.column)})` : "", message: esc(e.message) })}</li>`).join("")}</ul>
      ${more ? `<p class="hint">${msg("importer.moreProblems", { count: more })}</p>` : ""}`;
  } else {
    html += `<p>${msg("importer.summary", { count: s.rows, created: s.created, updated: s.updated, unchanged: s.unchanged })}</p>`;
  }
  if (res.ignoredColumns.length) html += `<p class="hint">${msg("importer.notImported", { columns: res.ignoredColumns.map((c) => `“${esc(c)}”`).join(", ") })}</p>`;
  if (!res.errorCount) {
    // Company equipment has no price (ADR 0017)
    const rows = res.rows.slice(0, SHOWN).map((r) => `<tr><td>${esc(r.name)}${brandHTML(r)}${r.barcode ? `<span class="code">${esc(r.barcode)}</span>` : ""}</td><td>${r.kind === "equipment" ? msg("importer.equipment") : money(r.price)}</td><td>${r.stock ?? "—"}</td><td>${r.reorderAt ?? "—"}</td><td>${esc(actionText(r))}</td></tr>`);
    // Focusable, so the preview can be scrolled from the keyboard when it's taller or wider than the dialog
    html += `<div class="table-wrap import-table" tabindex="0" role="region" aria-label="${msg("importer.previewLabel")}"><table><thead><tr><th>${msg("importer.colItem")}</th><th>${msg("importer.colPrice")}</th><th>${msg("importer.colStock")}</th><th>${msg("importer.colReorderAt")}</th><th>${msg("importer.colChange")}</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
    if (res.rows.length > SHOWN) html += `<p class="hint">${msg("importer.moreRows", { count: res.rows.length - SHOWN })}</p>`;
  }
  return html;
}

const doneText = (s) => s.created + s.updated ? msg("importer.doneChanged", { created: s.created, updated: s.updated }) : msg("importer.doneNothing");

// What each column means (ADR 0014)
const GUIDE = [
  ["name", "importer.guideName"],
  ["brand", "importer.guideBrand"],
  ["price", "importer.guidePrice"],
  ["barcode", "importer.guideBarcode"],
  ["kind", "importer.guideKind"],
  ["cost", "importer.guideCost"],
  ["stock", "importer.guideStock"],
  ["pack_size", "importer.guidePackSize"],
  ["pack_cost", "importer.guidePackCost"],
  ["reorder_at", "importer.guideReorderAt"],
  ["reorder_qty", "importer.guideReorderQty"],
  ["length, width, height", "importer.guideSize"],
  ["size_unit", "importer.guideSizeUnit"],
];

// save: the runtime's download (downloads.save in account.js)
export function openImport(api, teamId, save) {
  const path = `/teams/${encodeURIComponent(teamId)}/imports`;
  let csv = "", importId = "";
  openModal(`<h2>${msg("importer.title")}</h2>
    <p class="hint">${msg("importer.intro")}</p>
    <p><button type="button" class="btn" id="importTemplate">${msg("importer.template")}</button></p>
    <details class="import-guide"><summary>${msg("importer.guideSummary")}</summary><dl>${GUIDE.map(([c, key]) => `<dt>${c}</dt><dd>${msg(key)}</dd>`).join("")}</dl><p class="hint">${msg("importer.guideNote")}</p></details>
    <div class="field"><label for="importFile">${msg("importer.fileLabel")}</label><input type="file" id="importFile" accept=".csv,text/csv"></div>
    <p class="error" role="alert" id="importFail" hidden></p>
    <div class="import-result" id="importResult" aria-live="polite"></div>
    <div class="modal-actions"><button type="button" class="btn" id="importCancel">${msg("importer.cancel")}</button><button type="button" class="btn primary" id="importGo" hidden>${msg("importer.import")}</button></div>`, (m) => {
    const out = m.querySelector("#importResult"), go = m.querySelector("#importGo"), fail = m.querySelector("#importFail");
    const show = (html, ready) => { out.innerHTML = html; fail.hidden = true; go.hidden = !ready; go.disabled = false; go.textContent = msg("importer.import"); };
    const failed = (text) => `<p class="error" role="alert">${esc(text)}</p>`;
    m.querySelector("#importCancel").addEventListener("click", closeModal);
    m.querySelector("#importTemplate").addEventListener("click", () => save({ filename: "inventory-template.csv", data: TEMPLATE }));

    async function preview() {
      show(`<p class="muted" role="status">${msg("importer.checking")}</p>`, false);
      try {
        const res = await api("POST", path, { dryRun: true, csv });
        show(previewHTML(res), !res.errorCount);
      } catch (e) {
        show(failed(e.code === "bad_request" ? e.message : e.code === "permission_denied" ? msg("importer.ownersOnly") : msg("importer.checkFailed")), false);
      }
    }

    m.querySelector("#importFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > MAX_BYTES) { show(failed(msg("importer.tooBig")), false); return; }
      csv = await file.text();
      // One ID per file: every retry of this import sends it again
      importId = crypto.randomUUID();
      preview();
    });

    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = msg("importer.importing");
      try {
        const res = await api("POST", path, { importId, csv });
        closeModal();
        toast(doneText(res.summary), 5000);
      } catch (e) {
        // Inventory changed since the preview, so a row now clashes: show what's wrong
        if (e.code === "bad_request") { preview(); return; }
        go.disabled = false;
        go.textContent = msg("importer.tryAgain");
        fail.textContent = e.code === "aborted" ? e.message : msg("importer.unfinished");
        fail.hidden = false;
      }
    });
  });
}
