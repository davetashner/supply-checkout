// Setting the signed-in user's password (POST /me/password in docs/api/openapi.yaml): the
// fields and errors the two-step setup (mfa.js) and Account's Change password share, and
// the Change password dialog itself (supply-checkout-6uw.28). The API makes Cognito's
// ChangePassword call with the user's own access token, and emails the account's verified
// address that the password changed. Web build only, like the rest of src/aws/.
//
// Password managers: the form says whose password it is (a hidden username field with the
// email), then asks for the current password first (autocomplete=current-password), and
// only then the new one, twice (autocomplete=new-password, with the pool's rules in
// passwordrules). That reads as a password change, not a sign-up, so a manager fills the
// current one from what it has saved and offers to update it, rather than saving the new one
// in its place before the change is sent. Someone who doesn't know their current password is
// told how to reset it ("Forgot your current password?").
import { esc } from "../format.js";
import { openModal, closeModal, toast } from "../dom.js";

// The user pool's password policy (infra), as people read it and as password managers do
export const RULES = "At least 12 characters, with upper and lower case letters, a number and a symbol.";
const MANAGER_RULES = "minlength: 12; required: lower; required: upper; required: digit; required: special;";

// What went wrong setting the password, in words, or null for anything else. `required`: the
// user has a password for sure (two-step sign-in is on), so leaving it empty isn't an option.
export const passwordFailure = (e, required = false) =>
  e.reason === "password_invalid" ? "Choose a password of at least 12 characters, with upper and lower case letters, a number and a symbol."
    : e.reason === "password_mismatch" ? (required ? "That current password isn't right." : "That current password isn't right. If you've only signed in with an email code or a passkey, leave it empty.")
    : e.reason === "federated_sign_in" ? "You sign in with Google or Apple, so there's no Supply Checkout password to change."
    : e.code === "quota_exceeded" ? "Too many tries for now. Wait a few minutes, then try again."
    : null;

// The fields, current password first. `required`: as for passwordFailure.
export const passwordFields = (email, required = false) => `
  <input type="text" name="username" autocomplete="username" value="${esc(email)}" hidden readonly tabindex="-1" aria-hidden="true">
  <div class="field"><label for="currentPassword">Current password</label><input type="password" id="currentPassword" name="current-password" autocomplete="current-password"${required ? " required" : ""} aria-describedby="currentHint" data-autofocus>
  <p class="hint" id="currentHint">${required ? "The password you sign in with now." : "Leave it empty if you've only signed in with an email code or a passkey."}</p></div>
  <details class="password-forgot"><summary>Forgot your current password?</summary>
  <p>Sign out, then on the sign-in page choose to reset your password: we'll email you a code to set a new one. Sign in with it, and you're done.</p></details>
  <div class="field"><label for="newPassword">New password</label><input type="password" id="newPassword" name="new-password" autocomplete="new-password" passwordrules="${MANAGER_RULES}" aria-describedby="newHint">
  <p class="hint" id="newHint">${RULES}</p></div>
  <div class="field"><label for="confirmPassword">Confirm new password</label><input type="password" id="confirmPassword" name="confirm-password" autocomplete="new-password" passwordrules="${MANAGER_RULES}"></div>`;

// The request's body from the fields in `m`, or null after saying (with `say`) what's missing
export function readPassword(m, say) {
  const current = m.querySelector("#currentPassword"), next = m.querySelector("#newPassword"), again = m.querySelector("#confirmPassword");
  const problem = current.required && !current.value ? [current, "Enter your current password."]
    : !next.value ? [next, "Choose a password."]
    : next.value !== again.value ? [again, "The new passwords don't match. Type the new one again."]
    : null;
  if (problem) { say(problem[1]); problem[0].focus(); return null; }
  return current.value ? { password: next.value, currentPassword: current.value } : { password: next.value };
}

// Account's Change password. `required`: as for passwordFailure. Signing out everywhere (on
// by default) ends every session, this one too (GlobalSignOut has no "but this one"), so
// `onSignedOut` then shows a way to sign in again, with the new password.
export function openChangePassword(session, email, onSignedOut, { required }) {
  openModal(`<h2>Change password</h2>
    <div class="two-step" id="passwordBox">
      <form id="passwordForm" class="two-step-form" novalidate>
        <p class="hint">${required ? "Change the password you sign in with." : "Change the password you sign in with, or set one if you've only signed in with an email code or a passkey."}</p>
        ${passwordFields(email, required)}
        <label class="check"><input type="checkbox" id="signOutAll" checked aria-describedby="signOutHint"> Sign out everywhere</label>
        <p class="hint" id="signOutHint">Ends every session on every device, this one too, so anyone who knew the old password is signed out. You'll sign in again here with the new one.</p>
      </form>
      <p class="error" role="alert" id="passwordFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="passwordCancel">Cancel</button><button type="submit" form="passwordForm" class="btn primary" id="passwordSave">Change password</button></div>
    </div>`, (m) => {
    const $ = (s) => m.querySelector(s);
    const box = $("#passwordBox"), fail = $("#passwordFail"), save = $("#passwordSave");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    // While a request runs: nothing to press twice, and the modal stays open (dom.js)
    const busy = (on) => {
      box.toggleAttribute("aria-busy", on);
      for (const b of m.querySelectorAll("button")) b.disabled = on;
    };
    $("#passwordCancel").addEventListener("click", closeModal);
    // Once the password is changed, the button only signs out everywhere
    let changed = false;

    async function signOutEverywhere() {
      say("");
      busy(true);
      try {
        await session.api("POST", "/me/sign-out-everywhere");
      } catch {
        busy(false);
        if (!changed) changedOnly();
        say("Your password is changed, but you weren't signed out everywhere yet. Try again, or close this to stay signed in.");
        return;
      }
      // Every session has ended, this one too: the only way on is to sign in again
      box.removeAttribute("aria-busy");
      closeModal();
      onSignedOut();
    }
    // The password is changed; what's left is signing out everywhere, or not
    function changedOnly() {
      changed = true;
      $("#passwordForm").hidden = true;
      save.removeAttribute("form");
      save.type = "button";
      save.textContent = "Sign out everywhere";
      $("#passwordCancel").textContent = "Close";
      save.addEventListener("click", signOutEverywhere);
      save.focus();
    }

    $("#passwordForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = readPassword(m, say);
      if (!body) return;
      say("");
      busy(true);
      try {
        await session.api("POST", "/me/password", body);
      } catch (err) {
        busy(false);
        say(passwordFailure(err, required) || "Couldn't change the password. Check your connection and try again.");
        return;
      }
      busy(false);
      if ($("#signOutAll").checked) { await signOutEverywhere(); return; }
      closeModal();
      toast("Your password is changed.", 5000);
    });
  });
}
