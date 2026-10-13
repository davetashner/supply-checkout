// Your account, from the team bar's Account button or the screens before a team is open:
// the name (name.js), the profile photo (profile-photo.js), the password (changed in password.js), two-step sign-in (set up in mfa.js), the What's New
// banner on or off (whats-new.js), and deleting the account (DELETE /me in
// docs/api/openapi.yaml). The user types DELETE to confirm, and
// the button stays off until they have. The server refuses while they're the only owner of
// a team others are still in (409 `last_owner`, with a message naming the teams), and
// otherwise removes them from every team, closes any team they're alone in, and deletes
// their sign-in. Web build only, like the rest of src/aws/.
import { esc } from "../format.js";
import { msg } from "../i18n.js";
import { openModal, closeModal } from "../dom.js";
import { whatsNewSetting, wireWhatsNewSetting } from "./whats-new.js";
import { photoSection, wirePhoto } from "./profile-photo.js";
import { nameSection, wireName } from "./name.js";

const WORD = "DELETE";

// What went wrong, in words: the server's own for the last owner, which names the teams
const failure = (e) =>
  e.reason === "last_owner" ? e.message
    : e.code === "bad_request" ? msg("deleteAccount.typeWord", { word: WORD })
    : msg("deleteAccount.failed");

// Two-step sign-in as /me says it (`mfa`), with a button to set it up: owners need it for
// billing. Nothing from an API that doesn't say.
const TWO_STEP = {
  off: ["deleteAccount.twoStepOff", "deleteAccount.twoStepOffButton"],
  totp: ["deleteAccount.twoStepOn", "deleteAccount.twoStepOnButton"],
  provider: ["deleteAccount.twoStepProvider", ""],
};
function twoStepSection(mfa) {
  const [textKey, buttonKey] = TWO_STEP[mfa] || [];
  if (!textKey) return "";
  const text = msg(textKey), button = buttonKey && msg(buttonKey);
  return `<h3>${msg("deleteAccount.twoStepHeading")}</h3>
    <p class="hint" id="twoStepState">${text}</p>
    ${button ? `<div class="actions"><button type="button" class="btn" id="twoStepOpen">${button}</button></div>` : ""}`;
}

// The password: Change password, or a note for a Google or Apple user, who has no password
// here (the API refuses them, federated_sign_in)
const passwordSection = (mfa) => `<h3>${msg("deleteAccount.passwordHeading")}</h3>
    ${mfa === "provider"
      ? `<p class="hint" id="passwordState">${msg("deleteAccount.passwordProvider")}</p>`
      : `<p class="hint" id="passwordState">${msg(mfa === "totp" ? "deleteAccount.passwordTwoStep" : "deleteAccount.passwordMayBeNone")}</p>
    <div class="actions"><button type="button" class="btn" id="passwordOpen">${msg("deleteAccount.changePassword")}</button></div>`}`;

// `onDeleted` runs once the account is gone. `twoStep.setUp(moving)` opens the setup
// (`moving`: it's on already, and they're moving to a new phone); `twoStep.changePassword()`
// opens Change password. `whatsNew.prefs` is /me's user.preferences, and `whatsNew.off()`
// hides the banner once it's turned off. `photo` is the user's own photo (profile-photo.js),
// or null when the API has no photos. `name` is the user's first and last name (name.js).
export function openDeleteAccount(api, email, onDeleted, twoStep, whatsNew, photo, name) {
  openModal(`<h2>${msg("deleteAccount.title")}</h2>
    <p>${msg("deleteAccount.signedInAs", { email: esc(email || msg("deleteAccount.you")) })}</p>
    ${nameSection(name)}
    ${photo ? photoSection(photo) : ""}
    ${passwordSection(twoStep.mfa)}
    ${twoStepSection(twoStep.mfa)}
    ${whatsNewSetting(whatsNew.prefs)}
    <h3>${msg("deleteAccount.deleteHeading")}</h3>
    <p class="hint">${msg("deleteAccount.deleteWarning")}</p>
    <p class="hint">${msg("deleteAccount.lastOwner")}</p>
    <form id="deleteForm" class="delete-form" novalidate>
      <div class="field"><label for="deleteConfirm">${msg("deleteAccount.confirmLabel", { word: WORD })}</label><input type="text" id="deleteConfirm" autocomplete="off" spellcheck="false" autocapitalize="characters"></div>
      <p class="error" role="alert" id="deleteFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="deleteCancel">${msg("deleteAccount.cancel")}</button><button type="submit" class="btn danger" id="deleteAccount" disabled>${msg("deleteAccount.delete")}</button></div>
    </form>`, (m) => {
    const input = m.querySelector("#deleteConfirm"), button = m.querySelector("#deleteAccount"), fail = m.querySelector("#deleteFail");
    const ready = () => input.value.trim().toUpperCase() === WORD;
    m.querySelector("#deleteCancel").addEventListener("click", closeModal);
    const setUp = m.querySelector("#twoStepOpen");
    if (setUp) setUp.addEventListener("click", () => twoStep.setUp(twoStep.mfa === "totp"));
    const change = m.querySelector("#passwordOpen");
    if (change) change.addEventListener("click", twoStep.changePassword);
    wireWhatsNewSetting(m, api, whatsNew.prefs, whatsNew.off);
    wireName(m, api, name);
    if (photo) wirePhoto(m, api, photo);
    input.addEventListener("input", () => { button.disabled = !ready(); });
    m.querySelector("#deleteForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      button.disabled = true;
      fail.hidden = true;
      try {
        await api("DELETE", "/me", { confirm: input.value.trim() });
      } catch (err) {
        fail.textContent = failure(err);
        fail.hidden = false;
        button.disabled = false;
        return;
      }
      closeModal();
      onDeleted();
    });
    input.focus();
  });
}
