// The Name section of Account (supply-checkout-bt3g): the user's first and last name, saved
// with PUT /me/name, which sets them in Cognito and on the user's member item in each of their
// teams. `name.saved()` then gets new tokens, so the ID token, the bar under the header and the
// user's own profile carry the new name. Both empty clears it. The API takes a name only on one
// line with no control or invisible characters, at most NAME_MAX characters together.
import { esc, visibleText } from "../format.js";
import { toast } from "../dom.js";

export const NAME_MAX = 100;

const TOO_LONG = `Enter a first and last name of up to ${NAME_MAX} characters together.`;
const FAILED = "Couldn't save your name. Check your connection and try again.";
// Cognito refused the value (a name Google or Apple provides, for some accounts)
const REFUSED = "That name couldn't be saved. If you sign in with Google or Apple, change your name there.";

// `name.given` and `name.family` are the ID token's; `name.provider`: a Google or Apple user,
// whose provider may set the name back when they next sign in with it
export function nameSection(name) {
  return `<h3>Name</h3>
    <form id="nameForm" class="name-form" novalidate>
      <div class="name-fields">
        <div class="field"><label for="givenName">First name</label><input type="text" id="givenName" maxlength="${NAME_MAX}" autocomplete="given-name" value="${esc(name.given)}"></div>
        <div class="field"><label for="familyName">Last name</label><input type="text" id="familyName" maxlength="${NAME_MAX}" autocomplete="family-name" value="${esc(name.family)}"></div>
      </div>
      <p class="hint" id="nameHint">Your teammates see it next to your photo, on projects you prepared and in Members.${name.provider ? " Signing in with Google or Apple may set it back to your name there." : ""}</p>
      <p class="error" role="alert" id="nameFail" hidden></p>
      <div class="actions"><button type="submit" class="btn" id="nameSave">Save name</button></div>
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
    if (`${first} ${last}`.trim().length > NAME_MAX) return say(TOO_LONG);
    say("");
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await api("PUT", "/me/name", { givenName: first, familyName: last });
      await name.saved();
      toast(first || last ? "Your name is saved" : "Your name is cleared");
    } catch (err) {
      say(err.reason === "name_invalid" ? TOO_LONG : err.reason === "name_refused" ? REFUSED : FAILED);
    }
    save.disabled = false;
    save.textContent = "Save name";
  });
}
