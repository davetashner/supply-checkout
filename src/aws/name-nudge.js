// A gentle ask for a name (supply-checkout-i37r): someone signed in with no first or last name
// (the ID token has neither) shows to their teammates as "Someone" on the projects they prepare.
// The notice sits under the team bar like the What's New banner: not a modal, it doesn't take
// the focus, and one button dismisses it. "Add your name" opens Account, whose Name section
// saves it (name.js); once there is a name it never shows. Dismissing it is kept on this device
// for this user, so it doesn't come back at every load. Web build only, like the rest of src/aws/.
import { msg } from "../i18n.js";
import { local } from "./session.js";

export const NUDGE_KEY = "supplyCheckout.nameNudge";

// `after`: the team bar; `claims`: the ID token's; `open`: opens Account. Returns hide().
export function showNameNudge(after, userId, claims, open) {
  const key = `${NUDGE_KEY}.${userId}`;
  if (claims.given_name || claims.family_name || local.get(key)) return () => {};
  const note = document.createElement("section");
  note.className = "whats-new name-nudge";
  note.id = "nameNudge";
  note.setAttribute("aria-label", msg("nameNudge.label"));
  note.innerHTML = `<p>${msg("nameNudge.text")}</p>
    <div class="whats-new-head"><button type="button" class="btn" id="nameNudgeAdd">${msg("nameNudge.add")}</button>
      <button type="button" class="btn ghost" id="nameNudgeDismiss">${msg("nameNudge.dismiss")}</button></div>`;
  after.after(note);
  const hide = () => note.remove();
  note.querySelector("#nameNudgeAdd").addEventListener("click", () => { hide(); open(); });
  note.querySelector("#nameNudgeDismiss").addEventListener("click", () => {
    local.set(key, "1");
    hide();
    document.getElementById("accountOpen").focus();
  });
  return hide;
}
