// The team's settings, for its owners in the web build (ADR 0017, section 2a): today the
// markup added to the receipt price of company equipment bought for a client, and, to read
// only, the team's receipt scans left (GET /teams/{teamId}/receipts/usage, supply-checkout-wxx). Only owners
// read or change it (GET and PUT /teams/{teamId}/settings); the server works the marked-up
// price out itself, and never sends the percentage to anyone else. The claude.ai artifact
// build has no markup, so it has no such screen.
import { openModal, closeModal, toast } from "../dom.js";
import { msg } from "../i18n.js";
import { readUsage } from "./receipts.js";

// The runtime capability src/main.js asks for (use("settings")): owners only, null for anyone
// else, so a contributor's or viewer's page never even asks for the markup
export function settingsFor(api, team) {
  if (team.role !== "owner") return null;
  const path = `/teams/${encodeURIComponent(team.id)}/settings`;
  return {
    get: () => api("GET", path),
    set: (equipmentMarkup, expectedVersion) => api("PUT", path, { equipmentMarkup, expectedVersion }),
    usage: () => readUsage(api, team),
  };
}

export function openSettings(settings) {
  openModal(`<h2>${msg("settings.title")}</h2>
    <form id="settingsForm" style="display:grid;gap:14px">
      <div class="field"><label for="markup">${msg("settings.markupLabel")}</label>
        <input type="number" id="markup" min="0" max="1000" step="0.01" inputmode="decimal" disabled aria-describedby="markupHint">
        <p class="hint" id="markupHint">${msg("settings.markupHint")}</p></div>
      <div class="field"><p class="hint" id="receiptUsage">${msg("settings.usageLoading")}</p></div>
      <p class="error" role="alert" id="settingsFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="settingsCancel">${msg("settings.cancel")}</button><button type="submit" class="btn primary" id="settingsSave" disabled>${msg("settings.save")}</button></div>
    </form>`, async (m) => {
    const field = m.querySelector("#markup"), save = m.querySelector("#settingsSave"), fail = m.querySelector("#settingsFail");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    m.querySelector("#settingsCancel").addEventListener("click", closeModal);
    // The scans left, beside the settings: its own request, so a failure here doesn't stop them
    settings.usage().then((usage) => {
      m.querySelector("#receiptUsage").textContent = !usage ? msg("settings.usageFailed")
        : msg(usage.period === "trial" ? "settings.usageTrial" : "settings.usageMonth", { used: usage.used, limit: usage.limit, remaining: usage.remaining });
    });
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
      say(msg("settings.loadFailed"));
      return;
    }
    m.querySelector("#settingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = Number(field.value);
      if (field.value.trim() === "" || !(value >= 0 && value <= 1000) || Math.round(value * 100) !== Number((value * 100).toPrecision(12))) {
        say(msg("settings.badPercent"));
        return;
      }
      save.disabled = true;
      save.textContent = msg("settings.saving");
      try {
        await settings.set(value, version);
        closeModal();
        toast(msg("settings.saved", { value }));
      } catch (err) {
        save.disabled = false;
        save.textContent = msg("settings.save");
        say(msg(err.code === "aborted" ? "settings.changedMeanwhile" : "settings.saveFailed"));
      }
    });
  });
}
