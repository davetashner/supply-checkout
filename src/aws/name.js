// The Name section of Account (supply-checkout-bt3g): the user's first and last name, saved
// with PUT /me/name, which sets them in Cognito and on the user's member item in each of their
// teams. `name.saved()` then gets new tokens, so the ID token, the bar under the header and the
// user's own profile carry the new name. Both empty clears it. The API takes a name only on one
// line with no control or invisible characters, at most NAME_MAX characters together.
import { esc, visibleText } from "../format.js";
import { toast } from "../dom.js";
import { msg } from "../i18n.js";

export const NAME_MAX = 100;

const tooLong = () => msg("name.tooLong", { max: NAME_MAX });

// `name.given` and `name.family` are the ID token's; `name.provider`: a Google or Apple user,
// whose provider may set the name back when they next sign in with it
export function nameSection(name) {
  return `<h3>${msg("name.heading")}</h3>
    <form id="nameForm" class="name-form" novalidate>
      <div class="name-fields">
        <div class="field"><label for="givenName">${msg("name.first")}</label><input type="text" id="givenName" maxlength="${NAME_MAX}" autocomplete="given-name" value="${esc(name.given)}"></div>
        <div class="field"><label for="familyName">${msg("name.last")}</label><input type="text" id="familyName" maxlength="${NAME_MAX}" autocomplete="family-name" value="${esc(name.family)}"></div>
      </div>
      <p class="hint" id="nameHint">${msg("name.hint")}${name.provider ? msg("name.hintProvider") : ""}</p>
      <p class="error" role="alert" id="nameFail" hidden></p>
      <div class="actions"><button type="submit" class="btn" id="nameSave">${msg("name.save")}</button></div>
    </form>`;
}

export function wireName(m, api, name) {
  const given = m.querySelector("#givenName"), family = m.querySelector("#familyName");
  const save = m.querySelector("#nameSave"), fail = m.querySelector("#nameFail");
  const say = (text) => { fail.textContent = text; fail.hidden = !text; };
  m.querySelector("#nameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    // Pasted control and invisible characters are cleaned, not sent: the API refuses them
    const first = visibleText(given.value).trim(), last = visibleText(family.value).trim();
    given.value = first;
    family.value = last;
    if (`${first} ${last}`.trim().length > NAME_MAX) return say(tooLong());
    say("");
    save.disabled = true;
    save.textContent = msg("name.saving");
    try {
      await api("PUT", "/me/name", { givenName: first, familyName: last });
      await name.saved();
      toast(msg(first || last ? "name.saved" : "name.cleared"));
    } catch (err) {
      // Cognito refused the value (a name Google or Apple provides, for some accounts): name_refused
      say(err.reason === "name_invalid" ? tooLong() : msg(err.reason === "name_refused" ? "name.refused" : "name.failed"));
    }
    save.disabled = false;
    save.textContent = msg("name.save");
  });
}
