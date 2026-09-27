// Deleting your own account, from the team bar's Account button or the screens before a
// team is open (DELETE /me in docs/api/openapi.yaml). The user types DELETE to confirm, and
// the button stays off until they have. The server refuses while they're the only owner of
// a team others are still in (409 `last_owner`, with a message naming the teams), and
// otherwise removes them from every team, closes any team they're alone in, and deletes
// their sign-in. Web build only, like the rest of src/aws/.
import { esc } from "../format.js";
import { openModal, closeModal } from "../dom.js";

const WORD = "DELETE";

// What went wrong, in words: the server's own for the last owner, which names the teams
const failure = (e) =>
  e.reason === "last_owner" ? e.message
    : e.code === "bad_request" ? `Type ${WORD} to confirm.`
    : "Couldn't delete your account. Check your connection and try again. Anything already done stays done.";

// `onDeleted` runs once the account is gone
export function openDeleteAccount(api, email, onDeleted) {
  openModal(`<h2>Your account</h2>
    <p>Signed in as <strong>${esc(email || "you")}</strong>.</p>
    <h3>Delete your account</h3>
    <p class="hint">This removes you from every team and deletes your sign-in, so you can't sign in again. A team you're the only member of is closed, and everything in it is deleted after 30 days. Teams other people are in keep their sheets and inventory. It can't be undone.</p>
    <p class="hint">If you're the only owner of a team other people are in, make someone else an owner or close the team first.</p>
    <form id="deleteForm" class="delete-form" novalidate>
      <div class="field"><label for="deleteConfirm">Type ${WORD} to confirm</label><input type="text" id="deleteConfirm" autocomplete="off" spellcheck="false" autocapitalize="characters"></div>
      <p class="error" role="alert" id="deleteFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="deleteCancel">Cancel</button><button type="submit" class="btn danger" id="deleteAccount" disabled>Delete account</button></div>
    </form>`, (m) => {
    const input = m.querySelector("#deleteConfirm"), button = m.querySelector("#deleteAccount"), fail = m.querySelector("#deleteFail");
    const ready = () => input.value.trim().toUpperCase() === WORD;
    m.querySelector("#deleteCancel").addEventListener("click", closeModal);
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
