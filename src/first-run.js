// The first-run checklist (web build only; src/main.js creates it behind WEB). After an owner
// names a new team (src/aws/account.js), a short list above the sheets and inventory gets the
// empty team ready: add supplies (by hand, or a CSV from the import's template), invite the
// crew, and create a first sheet. Each step ticks itself off from what's saved: the team has
// an item, someone was invited from the members screen, the team has a sheet. It shows until
// every step is done or the owner dismisses it, and that's remembered for the team.
//
// cap is the runtime's use("firstRun") (account.js): { state, save(), invite(), importCsv(),
// onChange }. act is the app's side: { addItem(), newSheet(), redraw() }.
import { morph } from "./dom.js";

const STEPS = [
  { id: "items", title: "Add your supplies", text: "Add each item with its barcode, price and how many are in storage, or import a list you already have. The import has a template to fill in.",
    actions: [["addItem", "Add an item", "primary"], ["importCsv", "Import a CSV file", ""]] },
  { id: "crew", title: "Invite your crew", text: "Invite the people who take supplies to jobs. They get an email with a link to join.",
    actions: [["invite", "Invite people", ""]] },
  { id: "sheet", title: "Create your first sheet", text: "A sheet is one client job: scan what goes out, then what comes back.",
    actions: [["newSheet", "Create a sheet", ""]] },
];

export function createFirstRun(cap, act) {
  const { state } = cap;
  let done = { items: false, crew: false, sheet: false }, closed = false;
  // Kept from the start, so a reload before any step is done still shows it
  cap.save();
  cap.onChange = act.redraw;

  const box = document.createElement("section");
  box.className = "first-run";
  box.id = "firstRun";
  box.setAttribute("aria-labelledby", "firstRunTitle");
  box.hidden = true;
  document.getElementById("main").before(box);

  function finish() { state.done = true; cap.save(); }
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
        <div class="chips">${s.actions.map(([a, label, cls]) => `<button type="button" class="btn ${cls}" data-act="${a}">${label}</button>`).join("")}</div>`}
      </div>
    </li>`;

  // visible: the sheet list or inventory is showing, with the team's data loaded
  return {
    draw(visible, items, sheets) {
      done = { items: items > 0, crew: !!state.invited, sheet: sheets > 0 };
      const count = Object.values(done).filter(Boolean).length;
      const all = count === STEPS.length;
      if (all && !state.done) finish();
      box.hidden = closed || !visible;
      if (box.hidden) return;
      morph(box, all
        ? `<div class="first-run-head"><h2 id="firstRunTitle">You're all set</h2></div>
          <p>Your team has supplies, a crew and a first sheet. Scan items onto a sheet as they go out, and back in when they return.</p>
          <div class="chips"><button type="button" class="btn primary" data-act="dismiss">Close</button></div>`
        : `<div class="first-run-head"><h2 id="firstRunTitle">Get your team started</h2>
          <button type="button" class="btn ghost" data-act="dismiss" aria-label="Dismiss the getting started checklist">Dismiss</button></div>
          <p class="hint" id="firstRunProgress">${count} of ${STEPS.length} done</p>
          <ol class="first-run-steps" aria-describedby="firstRunProgress">${STEPS.map(stepHTML).join("")}</ol>`);
    },
  };
}
