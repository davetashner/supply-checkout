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
// then `onOn` shows a screen with a way to sign in again. Web build only, like the rest of
// src/aws/.
import { esc } from "../format.js";
import { openModal, closeModal } from "../dom.js";

const ISSUER = "Supply Checkout";

// What went wrong, in words
const failure = (e, doing) =>
  e.reason === "password_invalid" ? "Choose a password of at least 12 characters, with upper and lower case letters, a number and a symbol."
    : e.reason === "password_mismatch" ? "That current password isn't right. If you've only signed in with an email code or a passkey, leave it empty."
    : e.reason === "code_mismatch" ? "That code isn't right. Check the app and try the newest code."
    : e.reason === "code_expired" ? "This setup expired. Close this and start again."
    : e.code === "quota_exceeded" ? "Too many tries for now. Wait a few minutes, then try again."
    : `Couldn't ${doing}. Check your connection and try again.`;

// The key as the app shows it, in groups of four
const grouped = (secret) => secret.replace(/(.{4})(?=.)/g, "$1 ");
// The link authenticator apps take (Google's Key Uri Format)
const otpauth = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${email}`)}?${new URLSearchParams({ secret, issuer: ISSUER })}`;

// `why` says what sent them here (billing refused), if anything. `moving`: it's already on,
// and they're moving to a new phone, so there's no password step. `onOn` runs once it's on
// and this tab's session has ended.
export function openTwoStep(session, email, onOn, { why = "", moving = false } = {}) {
  openModal(`<h2>Two-step sign-in</h2>
    <div class="two-step" id="twoStep">
      ${why ? `<p class="two-step-why" role="status">${esc(why)}</p>` : ""}
      <p class="hint">${moving
        ? "Set up the authenticator app on your new phone. Your old phone's codes keep working until this is done."
        : "You'll sign in with your email, a password and a 6-digit code from an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password. Email codes and passkeys stop working for signing in."}</p>
      <form id="passwordStep" class="two-step-form" novalidate${moving ? " hidden" : ""}>
        <h3>1. Your password</h3>
        <div class="field"><label for="newPassword">New password</label><input type="password" id="newPassword" autocomplete="new-password" data-autofocus></div>
        <div class="field"><label for="currentPassword">Current password</label><input type="password" id="currentPassword" autocomplete="current-password" aria-describedby="currentHint">
        <p class="hint" id="currentHint">Leave it empty if you've only signed in with an email code or a passkey.</p></div>
        <div class="actions"><button type="submit" class="btn primary" id="savePassword">Continue</button><button type="button" class="btn ghost" id="keepPassword">Keep my current password</button></div>
      </form>
      <form id="appStep" class="two-step-form" novalidate hidden>
        <h3>${moving ? "Your authenticator app" : "2. Your authenticator app"}</h3>
        <p>Scan this with the app, or enter the key by hand.</p>
        <div class="two-step-qr" id="qr"></div>
        <p>Key: <code id="totpKey"></code></p>
        <p><a href="#" id="openApp">Open in an authenticator app on this device</a></p>
        <div class="field"><label for="totpCode">Code from the app</label>
        <input type="text" id="totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" spellcheck="false"></div>
        <div class="actions"><button type="submit" class="btn primary" id="turnOn">Turn on</button></div>
      </form>
      <p class="error" role="alert" id="twoStepFail" hidden></p>
      <div class="actions"><button type="button" class="btn ghost" id="twoStepClose">Cancel</button></div>
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
        if (moving) say(failure(e, "start the setup"));
        else { $("#passwordStep").hidden = false; say(failure(e, "start the setup")); }
        return;
      }
      const link = otpauth(secret, email);
      const { qrSvg } = await import("./qr.js");
      $("#qr").innerHTML = qrSvg(link, "QR code for your authenticator app");
      $("#totpKey").textContent = grouped(secret);
      $("#openApp").href = link;
      busy(false);
      $("#appStep").hidden = false;
      $("#totpCode").focus();
    }

    $("#passwordStep").addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = $("#newPassword").value, current = $("#currentPassword").value;
      if (!password) { say("Choose a password."); $("#newPassword").focus(); return; }
      say("");
      busy(true);
      try {
        await session.api("POST", "/me/password", current ? { password, currentPassword: current } : { password });
      } catch (err) {
        busy(false);
        say(failure(err, "set the password"));
        return;
      }
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
      $("#turnOn").textContent = "Sign out everywhere";
      $("#twoStepClose").hidden = true;
      say("Two-step sign-in is on, but your other sessions weren't signed out yet. Sign out everywhere to finish.");
      $("#turnOn").focus();
    };

    $("#appStep").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = $("#totpCode").value.replace(/\s/g, "");
      if (!finishing && !/^\d{6}$/.test(code)) { say("Enter the 6-digit code from the app."); $("#totpCode").focus(); return; }
      say("");
      busy(true);
      try {
        await (finishing ? session.api("POST", "/me/sign-out-everywhere") : session.api("POST", "/me/mfa/totp/verify", { code }));
      } catch (err) {
        busy(false);
        if (err.reason === "signout_failed" && !finishing) finish();
        else say(failure(err, finishing ? "sign you out everywhere" : "check the code"));
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
