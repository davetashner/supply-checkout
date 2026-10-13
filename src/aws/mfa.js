// Two-step sign-in with an authenticator app, which owners need before they manage billing
// (POST /me/password, /me/mfa/totp and /me/mfa/totp/verify in docs/api/openapi.yaml,
// supply-checkout-8jc.12). The API makes the Cognito calls with the user's own access token,
// as it does for verifying an email, so the app still only talks to the API.
//
// Once an authenticator is on, Cognito lets the user sign in only with a password and its
// code: email codes and passkeys stop working for them. So the dialog has them set a
// password first (their current one confirms it, if they have one), unless they're only
// moving to a new phone. Then it shows the app's secret as a QR code and as text, and checks
// a code from the app. That turns it on and signs the user out everywhere, this tab too, so
// then `onOn` shows a screen with a way to sign in again. The password step's fields and
// errors are password.js's, shared with Account's Change password. Web build only, like the
// rest of src/aws/.
import { esc } from "../format.js";
import { msg } from "../i18n.js";
import { openModal, closeModal } from "../dom.js";
import { clearPassword, passwordFailure, passwordFields, readPassword } from "./password.js";

const ISSUER = "Supply Checkout";

// What went wrong, in words. `doing`: what was being done (a twoStep.failed… key), for an error with no reason of its own
const failure = (e, doing) =>
  passwordFailure(e)
    || msg(e.reason === "code_mismatch" ? "twoStep.codeMismatch"
    : e.reason === "code_expired" ? "twoStep.codeExpired"
    : doing);

// The key as the app shows it, in groups of four
const grouped = (secret) => secret.replace(/(.{4})(?=.)/g, "$1 ");
// The link authenticator apps take (Google's Key Uri Format)
const otpauth = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${email}`)}?${new URLSearchParams({ secret, issuer: ISSUER })}`;

// `why` says what sent them here (billing refused), if anything. `moving`: it's already on,
// and they're moving to a new phone, so there's no password step. `onOn` runs once it's on
// and this tab's session has ended.
export function openTwoStep(session, email, onOn, { why = "", moving = false } = {}) {
  openModal(`<h2>${msg("twoStep.title")}</h2>
    <div class="two-step" id="twoStep">
      ${why ? `<p class="two-step-why" role="status">${esc(why)}</p>` : ""}
      <p class="hint">${msg(moving ? "twoStep.introMoving" : "twoStep.intro")}</p>
      <form id="passwordStep" class="two-step-form" method="post" novalidate${moving ? " hidden" : ""}>
        <h3>${msg("twoStep.passwordHeading")}</h3>
        ${passwordFields(email)}
        <div class="actions"><button type="submit" class="btn primary" id="savePassword">${msg("twoStep.continue")}</button><button type="button" class="btn ghost" id="keepPassword">${msg("twoStep.keepPassword")}</button></div>
      </form>
      <form id="appStep" class="two-step-form" novalidate hidden>
        <h3>${msg(moving ? "twoStep.appHeadingMoving" : "twoStep.appHeading")}</h3>
        <p>${msg("twoStep.scan")}</p>
        <div class="two-step-qr" id="qr"></div>
        <p>${msg("twoStep.key", { key: '<code id="totpKey"></code>' })}</p>
        <p><a href="#" id="openApp">${msg("twoStep.openApp")}</a></p>
        <div class="field"><label for="totpCode">${msg("twoStep.codeLabel")}</label>
        <input type="text" id="totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" spellcheck="false"></div>
        <div class="actions"><button type="submit" class="btn primary" id="turnOn">${msg("twoStep.turnOn")}</button></div>
      </form>
      <p class="error" role="alert" id="twoStepFail" hidden></p>
      <div class="actions"><button type="button" class="btn ghost" id="twoStepClose">${msg("twoStep.cancel")}</button></div>
    </div>`, (m) => {
    const $ = (s) => m.querySelector(s);
    const box = $("#twoStep"), fail = $("#twoStepFail");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    // While a request runs: nothing to press twice, and the modal stays open (dom.js)
    const busy = (on) => {
      box.toggleAttribute("aria-busy", on);
      for (const b of m.querySelectorAll("button")) b.disabled = on;
    };
    $("#twoStepClose").addEventListener("click", closeModal);

    // The secret for the app, then its QR code
    async function showApp() {
      $("#passwordStep").hidden = true;
      say("");
      busy(true);
      let secret;
      try {
        ({ totp: { secret } } = await session.api("POST", "/me/mfa/totp"));
      } catch (e) {
        busy(false);
        // Nothing to go back to when it's the first step
        if (moving) say(failure(e, "twoStep.failedStart"));
        else { $("#passwordStep").hidden = false; say(failure(e, "twoStep.failedStart")); }
        return;
      }
      const link = otpauth(secret, email);
      const { qrSvg } = await import("./qr.js");
      $("#qr").innerHTML = qrSvg(link, msg("twoStep.qrLabel"));
      $("#totpKey").textContent = grouped(secret);
      $("#openApp").href = link;
      busy(false);
      $("#appStep").hidden = false;
      $("#totpCode").focus();
    }

    $("#passwordStep").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = readPassword(m, say);
      if (!body) return;
      say("");
      busy(true);
      try {
        await session.api("POST", "/me/password", body);
      } catch (err) {
        busy(false);
        say(failure(err, "twoStep.failedPassword"));
        return;
      }
      clearPassword(m);
      busy(false);
      await showApp();
    });
    $("#keepPassword").addEventListener("click", showApp);

    // Once it's on but the API couldn't end the other sessions (signout_failed), the button
    // only finishes that: until it's done, they could still reach billing
    let finishing = false;
    const finish = () => {
      finishing = true;
      $("#totpCode").closest(".field").hidden = true;
      $("#turnOn").textContent = msg("twoStep.signOutEverywhere");
      $("#twoStepClose").hidden = true;
      say(msg("twoStep.notSignedOut"));
      $("#turnOn").focus();
    };

    $("#appStep").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = $("#totpCode").value.replace(/\s/g, "");
      if (!finishing && !/^\d{6}$/.test(code)) { say(msg("twoStep.badCode")); $("#totpCode").focus(); return; }
      say("");
      busy(true);
      try {
        await (finishing ? session.api("POST", "/me/sign-out-everywhere") : session.api("POST", "/me/mfa/totp/verify", { code }));
      } catch (err) {
        busy(false);
        if (err.reason === "signout_failed" && !finishing) finish();
        else say(failure(err, finishing ? "twoStep.failedSignOut" : "twoStep.failedCode"));
        return;
      }
      // Every session has ended, this one too: the only way on is to sign in again
      box.removeAttribute("aria-busy");
      closeModal();
      onOn();
    });

    if (moving) showApp();
  });
}
