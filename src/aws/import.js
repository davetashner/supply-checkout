// Importing inventory from a CSV file, for a team's owners in the web build (assisted
// onboarding). The server reads and checks the file, and the preview shows what each row
// will do; then it imports every row or none (POST /teams/{teamId}/imports in
// docs/api/openapi.yaml). An import that stops part-way is finished by sending the same
// request again, which "Try again" does, so nothing is added twice. When the server says
// the import can't go on (409 "aborted": items kept changing, the import expired, or a
// planned key was taken), its message says what to do.
import { esc, money } from "../format.js";
import { openModal, closeModal, toast } from "../dom.js";

// The server's limits (backend/src/data/imports.ts)
const MAX_BYTES = 300_000;
// Rows shown in the preview; the summary counts all of them
const SHOWN = 100;
const CHANGE = { code: "barcode", name: "name", price: "price", cost: "cost", packSize: "pack size", stock: "stock" };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function actionText(r) {
  if (r.action === "create") return "New";
  if (r.action === "unchanged") return "No change";
  return "Update " + r.changes.map((c) => CHANGE[c]).join(", ");
}

function previewHTML(res) {
  const s = res.summary;
  let html = "";
  if (res.errorCount) {
    const more = res.errorCount - res.errors.length;
    html += `<p class="error" role="alert">${plural(res.errorCount, "row needs", "rows need")} fixing, so nothing can be imported yet. Fix ${res.errorCount === 1 ? "it" : "them"} in the file and choose it again.</p>
      <ul class="import-errors">${res.errors.map((e) => `<li>Line ${e.line}${e.column ? ` (${esc(e.column)})` : ""}: ${esc(e.message)}</li>`).join("")}</ul>
      ${more ? `<p class="hint">…and ${plural(more, "more problem")}.</p>` : ""}`;
  } else {
    html += `<p><strong>${plural(s.rows, "row")}</strong>: ${s.created} new, ${s.updated} to update, ${s.unchanged} unchanged.</p>`;
  }
  if (res.ignoredColumns.length) html += `<p class="hint">Not imported: ${res.ignoredColumns.map((c) => `“${esc(c)}”`).join(", ")}.</p>`;
  if (!res.errorCount) {
    const rows = res.rows.slice(0, SHOWN).map((r) => `<tr><td>${esc(r.name)}${r.barcode ? `<span class="code">${esc(r.barcode)}</span>` : ""}</td><td>${money(r.price)}</td><td>${r.stock ?? "—"}</td><td>${esc(actionText(r))}</td></tr>`);
    html += `<div class="table-wrap import-table"><table><thead><tr><th>Item</th><th>Price</th><th>Stock</th><th>Change</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
    if (res.rows.length > SHOWN) html += `<p class="hint">…and ${plural(res.rows.length - SHOWN, "more row")}.</p>`;
  }
  return html;
}

const doneText = (s) => s.created + s.updated ? `Imported: ${s.created} new, ${s.updated} updated` : "Everything in the file was already in inventory";

export function openImport(api, teamId) {
  const path = `/teams/${encodeURIComponent(teamId)}/imports`;
  let csv = "", importId = "";
  openModal(`<h2>Import inventory</h2>
    <p class="hint">Choose a CSV file whose first row names its columns: <strong>name</strong> and <strong>price</strong>, and if you have them barcode, cost, stock and pack_size. Items already in inventory are matched by barcode, or by name, and updated. Importing a file again doesn't add anything twice.</p>
    <div class="field"><label for="importFile">CSV file</label><input type="file" id="importFile" accept=".csv,text/csv"></div>
    <p class="error" role="alert" id="importFail" hidden></p>
    <div class="import-result" id="importResult" aria-live="polite"></div>
    <div class="modal-actions"><button type="button" class="btn" id="importCancel">Cancel</button><button type="button" class="btn primary" id="importGo" hidden>Import</button></div>`, (m) => {
    const out = m.querySelector("#importResult"), go = m.querySelector("#importGo"), fail = m.querySelector("#importFail");
    const show = (html, ready) => { out.innerHTML = html; fail.hidden = true; go.hidden = !ready; go.disabled = false; go.textContent = "Import"; };
    const failed = (text) => `<p class="error" role="alert">${esc(text)}</p>`;
    m.querySelector("#importCancel").addEventListener("click", closeModal);

    async function preview() {
      show(`<p class="muted" role="status">Checking the file…</p>`, false);
      try {
        const res = await api("POST", path, { dryRun: true, csv });
        show(previewHTML(res), !res.errorCount);
      } catch (e) {
        show(failed(e.code === "bad_request" ? e.message : e.code === "permission_denied" ? "Only the team's owners can import inventory." : "Couldn't check the file. Check your connection and choose it again."), false);
      }
    }

    m.querySelector("#importFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > MAX_BYTES) { show(failed("This file is larger than 300 KB. Split it into smaller files and import each one."), false); return; }
      csv = await file.text();
      // One ID per file: every retry of this import sends it again
      importId = crypto.randomUUID();
      preview();
    });

    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = "Importing…";
      try {
        const res = await api("POST", path, { importId, csv });
        closeModal();
        toast(doneText(res.summary), 5000);
      } catch (e) {
        // Inventory changed since the preview, so a row now clashes: show what's wrong
        if (e.code === "bad_request") { preview(); return; }
        go.disabled = false;
        go.textContent = "Try again";
        fail.textContent = e.code === "aborted" ? e.message : "The import didn't finish. Try again to finish it; nothing will be added twice.";
        fail.hidden = false;
      }
    });
  });
}
