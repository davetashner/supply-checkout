// The first-run checklist (web build only; src/main.js creates it when the runtime has one). After an owner
// names a new team (src/aws/account.js), a short list above the projects and inventory gets the
// empty team ready: add supplies (by hand, or a CSV from the import's template), invite the
// crew, create a first project, and scan a receipt where receipt reading is available. Each step
// ticks itself off from what's saved: the team has an item, someone was invited from the
// members screen (or the team has other members or a pending invite), the team has a project, a
// scanned receipt was saved (receiptSaved()). It shows until every step is done or an owner
// dismisses it, and that's kept for the team on the server, so it's the same on every device.
//
// cap is the runtime's use("firstRun") (account.js): { state: { receipt, invited }, save(change),
// invite(), importCsv(), onChange }, where save sends { receipt: true } or { done: true }. act
// is the app's side: { addItem(), newProject(), redraw() }.
import { morph } from "./dom.js";

const STEPS = [
  { id: "items", title: "Add your supplies", text: "Add each item with its barcode, price and how many are in storage, or import a list you already have. The import has a template to fill in.",
    actions: [["addItem", "Add an item", "primary"], ["importCsv", "Import a CSV file", ""]] },
  { id: "crew", title: "Invite your crew", text: "Invite the people who take supplies to jobs. They get an email with a link to join.",
    actions: [["invite", "Invite people", ""]] },
  { id: "project", title: "Create your first project", text: "A project is one client job: scan what goes out, then what comes back.",
    actions: [["newProject", "Create a project", ""]] },
  // Only where receipt reading is available. Its action is the app's own file input's label
  // (#receiptFile in src/index.html), so a tap opens the camera or photo picker directly
  { id: "receipt", title: "Scan a receipt", text: "Take a photo of a receipt from the store. Its items are read for you to check, then added to a project or to storage.",
    actions: [["receiptFile", "Scan a receipt", ""]] },
];
const action = ([a, label, cls]) => a === "receiptFile"
  ? `<label class="btn ${cls}" for="receiptFile">${label}</label>`
  : `<button type="button" class="btn ${cls}" data-act="${a}">${label}</button>`;

export function createFirstRun(cap, act) {
  const { state } = cap;
  let done = {}, closed = false;
  cap.onChange = act.redraw;

  const box = document.createElement("section");
  box.className = "first-run";
  box.id = "firstRun";
  box.setAttribute("aria-labelledby", "firstRunTitle");
  box.hidden = true;
  document.getElementById("main").before(box);

  function finish() { state.done = true; cap.save({ done: true }); }
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const what = b.dataset.act;
    if (what === "dismiss") { finish(); closed = true; box.hidden = true; }
    else if (what === "invite" || what === "importCsv") cap[what]();
    else act[what]();
  });

  const stepHTML = (s) => `<li class="${done[s.id] ? "done" : ""}">
      <span class="check" aria-hidden="true"></span>
      <div class="step">
        <h3>${done[s.id] ? `<span class="vh">Done: </span>` : ""}${s.title}</h3>
        ${done[s.id] ? "" : `<p class="hint">${s.text}</p>
        <div class="chips">${s.actions.map(action).join("")}</div>`}
      </div>
    </li>`;

  // visible: the project list or inventory is showing, with the team's data loaded; receipts:
  // receipt reading is available, so the receipt step is on the list
  return {
    draw(visible, items, projects, receipts) {
      const steps = STEPS.filter((s) => s.id !== "receipt" || receipts);
      done = { items: items > 0, crew: !!state.invited, project: projects > 0, receipt: !!state.receipt };
      const count = steps.filter((s) => done[s.id]).length;
      const all = count === steps.length;
      if (all && !state.done) finish();
      box.hidden = closed || !visible;
      if (box.hidden) return;
      morph(box, all
        ? `<div class="first-run-head"><h2 id="firstRunTitle">You're all set</h2></div>
          <p>Your team has supplies, a crew and a first project. Scan items onto a project as they go out, and back in when they return.</p>
          <div class="chips"><button type="button" class="btn primary" data-act="dismiss">Close</button></div>`
        : `<div class="first-run-head"><h2 id="firstRunTitle">Get your team started</h2>
          <button type="button" class="btn ghost" data-act="dismiss" aria-label="Dismiss the getting started checklist">Dismiss</button></div>
          <p class="hint" id="firstRunProgress">${count} of ${steps.length} done</p>
          <ol class="first-run-steps" aria-describedby="firstRunProgress">${steps.map(stepHTML).join("")}</ol>`);
    },
    // A receipt was saved (src/main.js's saveReceipt): its step is done, and stays done
    receiptSaved() {
      if (state.receipt) return;
      state.receipt = true;
      cap.save({ receipt: true });
    },
  };
}
