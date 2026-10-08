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
      const limited = e.code === "quota_exceeded";
      setError(limited ? "Too many reset requests for now. Try again in an hour, or reset your password on the sign-in page."
        : e.code === "bad_request" ? "Enter your email address, like name@example.com." : "Couldn't send that. Check your connection and try again.");
      el.querySelector("#resetFallback").hidden = !limited;
      return false;
    }
    finally { busy(el, false); }
  }
  // Another Managed Login page with the same sign-in request (and so the same PKCE state, which
  // only the newest link made has): /signup and /forgotPassword take /oauth2/authorize's parameters
  const managed = (url, page) => url.replace("/oauth2/authorize?", `/${page}?`);
  // Shown past the limits: Managed Login's own reset
  const fallback = (url) => `<p class="hint" id="resetFallback" hidden><a href="${esc(managed(url, "forgotPassword"))}" id="resetElsewhere">Reset it on the sign-in page instead</a>.</p>`;

  async function askForAddress() {
    const url = await signInUrl();
    show(`<h2>Reset your password</h2>
      <p>Enter the email address you sign in with. If there's an account for it, we'll email you a code to set a new password.</p>
      <form id="resetForm" method="post" novalidate>
        <div class="field"><label for="resetEmail">Email address</label><input type="email" id="resetEmail" name="email" autocomplete="username" required data-autofocus></div>
        <p class="error" role="alert" id="accountError" hidden></p>
        ${fallback(url)}
        <div class="actions"><button type="submit" class="btn primary" id="resetSend">Send code</button> <button type="button" class="btn ghost" id="resetBack">Back to sign in</button></div>
      </form>`, (el) => {
      wireBack(el);
      el.querySelector("#resetForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const address = el.querySelector("#resetEmail").value.trim();
        if (!ADDRESS.test(address)) { setError("Enter your email address, like name@example.com."); el.querySelector("#resetEmail").focus(); return; }
        if (await ask(el, address)) await enterCode(address);
      });
    });
  }

  async function enterCode(email) {
    const url = await signInUrl();
    show(`<h2>Check your email</h2>
      <p>If there's an account for this address (<strong>${esc(email)}</strong>), we've sent a code. It works for an hour.</p>
      <p class="hint" id="resetNothing">Nothing in a few minutes? You may have signed up with a different email or with Google, or you may not have an account yet. <a href="${esc(managed(url, "signup"))}" id="resetSignUp">Create an account</a></p>
      <form id="resetConfirm" method="post" novalidate>
        <input type="text" name="username" autocomplete="username" value="${esc(email)}" hidden readonly tabindex="-1" aria-hidden="true">
        <div class="field"><label for="resetCode">Code from the email</label><input type="text" id="resetCode" name="code" class="reset-code" inputmode="numeric" autocomplete="one-time-code" required data-autofocus></div>
        <div class="field"><label for="newPassword">New password</label><input type="password" id="newPassword" name="new-password" autocomplete="new-password" passwordrules="${MANAGER_RULES}" aria-describedby="newHint" required>
        <p class="hint" id="newHint">${RULES}</p></div>
        <div class="field"><label for="confirmPassword">Confirm new password</label><input type="password" id="confirmPassword" name="confirm-password" autocomplete="new-password" passwordrules="${MANAGER_RULES}" required></div>
        <p class="hint" role="status" id="resetStatus"></p>
        <p class="error" role="alert" id="accountError" hidden></p>
        ${fallback(url)}
        <div class="actions"><button type="submit" class="btn primary" id="resetSave">Set password</button> <button type="button" class="btn" id="resetAgain">Send a new code</button> <button type="button" class="btn ghost" id="resetBack">Back to sign in</button></div>
      </form>`, (el) => {
      const $ = (s) => el.querySelector(s);
      const status = (text) => { $("#resetStatus").textContent = text; };
      wireBack(el);
      $("#resetAgain").addEventListener("click", async () => {
        status("");
        $("#accountError").hidden = true;
        if (await ask(el, email)) status("If there's an account for this address, we've emailed it a new code. Use the newest one.");
      });
      $("#resetConfirm").addEventListener("submit", async (e) => {
        e.preventDefault();
        status("");
        const code = $("#resetCode").value.replace(/\s/g, ""), password = $("#newPassword").value, again = $("#confirmPassword").value;
        const problem = !CODE.test(code) ? ["#resetCode", "Enter the 6-digit code from the email."]
          : !password ? ["#newPassword", "Choose a password."]
          : password !== again ? ["#confirmPassword", "The new passwords don't match. Type the new one again."]
          : null;
        if (problem) { setError(problem[1]); $(problem[0]).focus(); return; }
        busy(el, true);
        try { await post("/auth/password-reset/confirm", { email, code, password }); }
        catch (err) {
          busy(el, false);
          setError(err.reason === "code_mismatch" ? "That code isn't right, or it has expired. Check the email, or send a new code."
            : passwordFailure(err) || "Couldn't set the password. Check your connection and try again.");
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
    show(`<h2>Your password is reset</h2>
      <p>Sign in with your email address and your new password.</p>
      <div class="actions"><a class="btn primary big" href="${esc(url)}" id="signIn" data-autofocus>Sign in</a></div>`);
  }

  return askForAddress();
}
