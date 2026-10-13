// Resetting a forgotten password from the sign-in screen (supply-checkout-6uw.26; the
// password reset routes in docs/api/openapi.yaml). Managed Login has its own reset, but it
// says nothing when the address has no account, and its pages can't be reworded. This one
// asks for the address, then for the emailed code and a new password, then offers sign-in.
//
// It never says whether the address has an account: the API answers every request the same
// way, and the screen shows everyone the same guidance (another address, Google, or no account
// yet, with a link to create one). If there's an account that can have a password, Cognito
// emails it a code; a Google or Apple account's address gets a "sign in with Google" hint; any
// other address gets nothing (the owner's decision, 2026-10-08). Web build only, like the rest
// of src/aws/.
import { esc } from "../format.js";
import { msg } from "../i18n.js";
import { json, request } from "./http.js";
import { MANAGER_RULES, passwordFailure, RULES } from "./password.js";

const CODE = /^\d{6}$/;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;

// `show(html, mount)` and `setError(text)` are the account screens' (account.js); `apiUrl` is
// the API's; `signInUrl()` makes a new Managed Login link; `back()` shows the sign-in screen.
export function openReset({ show, setError, apiUrl, signInUrl, back }) {
  const post = (path, body) => request(apiUrl + path, json("POST", body));
  const busy = (el, on) => { for (const b of el.querySelectorAll("button")) b.disabled = on; };
  const wireBack = (el) => el.querySelector("#resetBack").addEventListener("click", back);

  // Asks for a code for `email`: resolves true once the API took it, or says why not. Past
  // the API's limits (per address and per network), the way left is Managed Login's own reset,
  // on the sign-in page, which has Cognito's limits instead of ours.
  async function ask(el, email) {
    busy(el, true);
    try { await post("/auth/password-reset", { email }); return true; }
    catch (e) {
      // API Gateway's own throttle answers a bare 429 ({"message":"Too Many Requests"}), which reads as internal
      const limited = e.code === "quota_exceeded" || e.status === 429;
      setError(msg(limited ? "resetPassword.tooMany" : e.code === "bad_request" ? "resetPassword.badEmail" : "resetPassword.sendFailed"));
      el.querySelector("#resetFallback").hidden = !limited;
      return false;
    }
    finally { busy(el, false); }
  }
  // Another Managed Login page with the same sign-in request (and so the same PKCE state, which
  // only the newest link made has): /signup and /forgotPassword take /oauth2/authorize's parameters
  const managed = (url, page) => url.replace("/oauth2/authorize?", `/${page}?`);
  // Shown past the limits: Managed Login's own reset
  const fallback = (url) => `<p class="hint" id="resetFallback" hidden>${msg("resetPassword.elsewhere", { href: esc(managed(url, "forgotPassword")) })}</p>`;

  async function askForAddress() {
    const url = await signInUrl();
    show(`<h2>${msg("resetPassword.askTitle")}</h2>
      <p>${msg("resetPassword.askIntro")}</p>
      <form id="resetForm" method="post" novalidate>
        <div class="field"><label for="resetEmail">${msg("resetPassword.emailLabel")}</label><input type="email" id="resetEmail" name="email" autocomplete="username" required data-autofocus></div>
        <p class="error" role="alert" id="accountError" hidden></p>
        ${fallback(url)}
        <div class="actions"><button type="submit" class="btn primary" id="resetSend">${msg("resetPassword.sendCode")}</button> <button type="button" class="btn ghost" id="resetBack">${msg("resetPassword.backToSignIn")}</button></div>
      </form>`, (el) => {
      wireBack(el);
      el.querySelector("#resetForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const address = el.querySelector("#resetEmail").value.trim();
        if (!ADDRESS.test(address)) { setError(msg("resetPassword.badEmail")); el.querySelector("#resetEmail").focus(); return; }
        if (await ask(el, address)) await enterCode(address);
      });
    });
  }

  async function enterCode(email) {
    const url = await signInUrl();
    show(`<h2>${msg("resetPassword.checkTitle")}</h2>
      <p>${msg("resetPassword.checkIntro", { email: esc(email) })}</p>
      <p class="hint" id="resetNothing">${msg("resetPassword.nothing", { href: esc(managed(url, "signup")) })}</p>
      <form id="resetConfirm" method="post" novalidate>
        <input type="text" class="vh" name="username" autocomplete="username" value="${esc(email)}" readonly tabindex="-1" aria-hidden="true">
        <div class="field"><label for="resetCode">${msg("resetPassword.codeLabel")}</label><input type="text" id="resetCode" name="code" class="reset-code" inputmode="numeric" autocomplete="one-time-code" required data-autofocus></div>
        <div class="field"><label for="newPassword">${msg("resetPassword.newPasswordLabel")}</label><input type="password" id="newPassword" name="new-password" autocomplete="new-password" passwordrules="${MANAGER_RULES}" aria-describedby="newHint" required>
        <p class="hint" id="newHint">${RULES}</p></div>
        <div class="field"><label for="confirmPassword">${msg("resetPassword.confirmLabel")}</label><input type="password" id="confirmPassword" name="confirm-password" autocomplete="new-password" passwordrules="${MANAGER_RULES}" required></div>
        <p class="hint" role="status" id="resetStatus"></p>
        <p class="error" role="alert" id="accountError" hidden></p>
        ${fallback(url)}
        <div class="actions"><button type="submit" class="btn primary" id="resetSave">${msg("resetPassword.setPassword")}</button> <button type="button" class="btn" id="resetAgain">${msg("resetPassword.sendAgain")}</button> <button type="button" class="btn ghost" id="resetBack">${msg("resetPassword.backToSignIn")}</button></div>
      </form>`, (el) => {
      const $ = (s) => el.querySelector(s);
      const status = (text) => { $("#resetStatus").textContent = text; };
      wireBack(el);
      $("#resetAgain").addEventListener("click", async () => {
        status("");
        $("#accountError").hidden = true;
        if (await ask(el, email)) status(msg("resetPassword.newCodeSent"));
      });
      $("#resetConfirm").addEventListener("submit", async (e) => {
        e.preventDefault();
        status("");
        const code = $("#resetCode").value.replace(/\s/g, ""), password = $("#newPassword").value, again = $("#confirmPassword").value;
        const problem = !CODE.test(code) ? ["#resetCode", msg("resetPassword.badCode")]
          : !password ? ["#newPassword", msg("resetPassword.noPassword")]
          : password !== again ? ["#confirmPassword", msg("resetPassword.mismatch")]
          : null;
        if (problem) { setError(problem[1]); $(problem[0]).focus(); return; }
        busy(el, true);
        try { await post("/auth/password-reset/confirm", { email, code, password }); }
        catch (err) {
          busy(el, false);
          setError(err.reason === "code_mismatch" ? msg("resetPassword.codeWrong") : passwordFailure(err) || msg("resetPassword.setFailed"));
          return;
        }
        // Nothing keeps the password in the page
        $("#newPassword").value = $("#confirmPassword").value = "";
        await done();
      });
    });
  }

  async function done() {
    const url = await signInUrl();
    show(`<h2>${msg("resetPassword.doneTitle")}</h2>
      <p>${msg("resetPassword.doneIntro")}</p>
      <div class="actions"><a class="btn primary big" href="${esc(url)}" id="signIn" data-autofocus>${msg("resetPassword.signIn")}</a></div>`);
  }

  return askForAddress();
}
