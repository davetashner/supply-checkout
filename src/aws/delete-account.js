// Your account, from the team bar's Account button or the screens before a team is open:
// the password (changed in password.js), two-step sign-in (set up in mfa.js), the What's New
// banner on or off (whats-new.js), and deleting the account (DELETE /me in
// docs/api/openapi.yaml). The user types DELETE to confirm, and
// the button stays off until they have. The server refuses while they're the only owner of
// a team others are still in (409 `last_owner`, with a message naming the teams), and
// otherwise removes them from every team, closes any team they're alone in, and deletes
// their sign-in. Web build only, like the rest of src/aws/.
import { esc } from "../format.js";
import { openModal, closeModal } from "../dom.js";
import { whatsNewSetting, wireWhatsNewSetting } from "./whats-new.js";

const WORD = "DELETE";

// What went wrong, in words: the server's own for the last owner, which names the teams
const failure = (e) =>
  e.reason === "last_owner" ? e.message
    : e.code === "bad_request" ? `Type ${WORD} to confirm.`
    : "Couldn't delete your account. Check your connection and try again. Anything already done stays done.";

// Two-step sign-in as /me says it (`mfa`), with a button to set it up: owners need it for
// billing. Nothing from an API that doesn't say.
const TWO_STEP = {
  off: ["Owners need two-step sign-in to manage billing. You'll sign in with a password and a code from an authenticator app on your phone.", "Set up two-step sign-in"],
  totp: ["Two-step sign-in is on: signing in with your email takes your password and a code from your authenticator app.", "Move to a new phone"],
  provider: ["You sign in with Google or Apple, which covers two-step sign-in here.", ""],
};
function twoStepSection(mfa) {
  const [text, button] = TWO_STEP[mfa] || [];
  if (!text) return "";
  return `<h3>Two-step sign-in</h3>
    <p class="hint" id="twoStepState">${text}</p>
    ${button ? `<div class="actions"><button type="button" class="btn" id="twoStepOpen">${button}</button></div>` : ""}`;
}

// The password: Change password, or a note for a Google or Apple user, who has no password
// here (the API refuses them, federated_sign_in)
const passwordSection = (mfa) => `<h3>Password</h3>
    ${mfa === "provider"
      ? `<p class="hint" id="passwordState">You sign in with Google or Apple, so there's no Supply Checkout password to change. Change your password with Google or Apple.</p>`
      : `<p class="hint" id="passwordState">Change the password you sign in with${mfa === "totp" ? "" : ", or set one if you've only signed in with an email code or a passkey"}.</p>
    <div class="actions"><button type="button" class="btn" id="passwordOpen">Change password</button></div>`}`;

// `onDeleted` runs once the account is gone. `twoStep.setUp(moving)` opens the setup
// (`moving`: it's on already, and they're moving to a new phone); `twoStep.changePassword()`
// opens Change password. `whatsNew.prefs` is /me's user.preferences, and `whatsNew.off()`
// hides the banner once it's turned off.
export function openDeleteAccount(api, email, onDeleted, twoStep, whatsNew) {
  openModal(`<h2>Your account</h2>
    <p>Signed in as <strong>${esc(email || "you")}</strong>.</p>
    ${passwordSection(twoStep.mfa)}
    ${twoStepSection(twoStep.mfa)}
    ${whatsNewSetting(whatsNew.prefs)}
    <h3>Delete your account</h3>
    <p class="hint">This removes you from every team and deletes your sign-in, so you can't sign in again. A team you're the only member of is closed, and everything in it is deleted after 30 days. Teams other people are in keep their projects and inventory. It can't be undone.</p>
    <p class="hint">If you're the only owner of a team other people are in, make someone else an owner or close the team first.</p>
    <form id="deleteForm" class="delete-form" novalidate>
      <div class="field"><label for="deleteConfirm">Type ${WORD} to confirm</label><input type="text" id="deleteConfirm" autocomplete="off" spellcheck="false" autocapitalize="characters"></div>
      <p class="error" role="alert" id="deleteFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="deleteCancel">Cancel</button><button type="submit" class="btn danger" id="deleteAccount" disabled>Delete account</button></div>
    </form>`, (m) => {
    const input = m.querySelector("#deleteConfirm"), button = m.querySelector("#deleteAccount"), fail = m.querySelector("#deleteFail");
    const ready = () => input.value.trim().toUpperCase() === WORD;
    m.querySelector("#deleteCancel").addEventListener("click", closeModal);
    const setUp = m.querySelector("#twoStepOpen");
    if (setUp) setUp.addEventListener("click", () => twoStep.setUp(twoStep.mfa === "totp"));
    const change = m.querySelector("#passwordOpen");
    if (change) change.addEventListener("click", twoStep.changePassword);
    wireWhatsNewSetting(m, api, whatsNew.prefs, whatsNew.off);
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
