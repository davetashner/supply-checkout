// The team's settings, for its owners in the web build (ADR 0017, section 2a): today the
// markup added to the receipt price of company equipment bought for a client. Only owners
// read or change it (GET and PUT /teams/{teamId}/settings); the server works the marked-up
// price out itself, and never sends the percentage to anyone else. The claude.ai artifact
// build has no markup, so it has no such screen.
import { openModal, closeModal, toast } from "../dom.js";

// The runtime capability src/main.js asks for (use("settings")): owners only, null for anyone
// else, so a contributor's or viewer's page never even asks for the markup
export function settingsFor(api, team) {
  if (team.role !== "owner") return null;
  const path = `/teams/${encodeURIComponent(team.id)}/settings`;
  return {
    get: () => api("GET", path),
    set: (equipmentMarkup, expectedVersion) => api("PUT", path, { equipmentMarkup, expectedVersion }),
  };
}

export function openSettings(settings) {
  openModal(`<h2>Team settings</h2>
    <form id="settingsForm" style="display:grid;gap:14px">
      <div class="field"><label for="markup">Markup on company equipment bought for a client (%)</label>
        <input type="number" id="markup" min="0" max="1000" step="0.01" inputmode="decimal" disabled aria-describedby="markupHint">
        <p class="hint" id="markupHint">When a receipt has company equipment you bought for a client, their sheet charges the receipt price plus this much. Only owners see this percentage; everyone who can see the sheet sees the price. 0 charges the receipt price.</p></div>
      <p class="error" role="alert" id="settingsFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="settingsCancel">Cancel</button><button type="submit" class="btn primary" id="settingsSave" disabled>Save</button></div>
    </form>`, async (m) => {
    const field = m.querySelector("#markup"), save = m.querySelector("#settingsSave"), fail = m.querySelector("#settingsFail");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    m.querySelector("#settingsCancel").addEventListener("click", closeModal);
    let version = 0;
    try {
      const got = await settings.get();
      // An owner demoted meanwhile gets an empty settings: never show or save on "undefined"
      const markup = got.settings.equipmentMarkup;
      if (typeof markup !== "number" || !Number.isFinite(markup) || typeof got.version !== "number") throw new Error("no settings");
      version = got.version;
      field.value = String(markup);
      field.disabled = false;
      save.disabled = false;
    } catch {
      say("Couldn't load the settings. Check your connection, then open them again.");
      return;
    }
    m.querySelector("#settingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = Number(field.value);
      if (field.value.trim() === "" || !(value >= 0 && value <= 1000) || Math.round(value * 100) !== Number((value * 100).toPrecision(12))) {
        say("Enter a percentage from 0 to 1,000, with at most two decimals.");
        return;
      }
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await settings.set(value, version);
        closeModal();
        toast(`Saved: ${value}% on equipment bought for clients`);
      } catch (err) {
        save.disabled = false;
        save.textContent = "Save";
        say(err.code === "aborted" ? "Another owner changed the settings meanwhile. Close and open them again to see theirs." : "That didn't save. Check your connection and try again.");
      }
    });
  });
}
