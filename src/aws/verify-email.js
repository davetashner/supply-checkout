// Verifying the signed-in user's email address, in the app's modal (POST /me/email/code and
// POST /me/email/verify in docs/api/openapi.yaml). Only a verified address lists and accepts
// invites. Cognito emails a 6-digit code and checks it; the API makes those calls with the
// user's own access token, as it does for GetUser, so the app still only talks to the API.
// Once the code is accepted, the session refreshes its tokens (the pre token generation
// trigger records a linked user's new address at that refresh) and loads /me again, and
// only when /me says verified does this say so. Cognito limits codes and tries; its refusals
// come back as quota_exceeded, and a new code can be asked for once a minute here. A code
// counts only for the address it was sent to: when the address changed (409 email_changed,
// from either route), the dialog loads /me again and starts over at sending a code.
import { esc } from "../format.js";
import { msg } from "../i18n.js";
import { openModal, closeModal } from "../dom.js";

// Seconds before another code can be asked for
export const RESEND_AFTER = 60;

// What went wrong, in words
const failure = (e, sending) =>
  msg(e.reason === "email_changed" ? "verifyEmail.emailChanged"
    : e.reason === "code_mismatch" ? "verifyEmail.codeMismatch"
    : e.reason === "code_expired" ? "verifyEmail.codeExpired"
    : e.reason === "email_in_use" ? "verifyEmail.emailInUse"
    : e.code === "quota_exceeded" ? "verifyEmail.tooMany"
    : sending ? "verifyEmail.sendFailed" : "verifyEmail.checkFailed");

// `onVerified(me)` runs with the new /me once it says the address is verified
export function openVerifyEmail(session, email, onVerified) {
  openModal(`<h2>${msg("verifyEmail.title")}</h2>
    <div class="verify" id="verify">
      <p id="verifyAbout"></p>
      <form id="verifyForm" class="verify-form" novalidate hidden>
        <div class="field"><label for="verifyCode">${msg("verifyEmail.codeLabel")}</label>
        <input type="text" id="verifyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="12" spellcheck="false"></div>
        <div class="actions"><button type="submit" class="btn primary" id="verifySubmit">${msg("verifyEmail.verify")}</button></div>
      </form>
      <p class="error" role="alert" id="verifyFail" hidden></p>
      <p class="verify-done" role="status" id="verifyDone" hidden></p>
      <div class="actions">
        <button type="button" class="btn primary" id="sendCode" data-autofocus>${msg("verifyEmail.sendCode")}</button>
        <button type="button" class="btn" id="verifyAgain" hidden>${msg("verifyEmail.tryAgain")}</button>
        <button type="button" class="btn ghost" id="verifyClose">${msg("verifyEmail.cancel")}</button>
      </div>
    </div>`, (m) => {
    const $ = (s) => m.querySelector(s);
    const box = $("#verify"), form = $("#verifyForm"), input = $("#verifyCode"), send = $("#sendCode"), again = $("#verifyAgain"), close = $("#verifyClose"), fail = $("#verifyFail"), done = $("#verifyDone");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    // Seconds until another code can be asked for, and the countdown's timer
    let left = 0, timer;
    // While a request runs: nothing to press twice, and the modal stays open (dom.js)
    const busy = (on) => {
      box.toggleAttribute("aria-busy", on);
      again.disabled = $("#verifySubmit").disabled = on;
      send.disabled = on || left > 0;
    };
    const stop = () => clearInterval(timer);
    const about = () => { $("#verifyAbout").innerHTML = msg("verifyEmail.about", { email: esc(email) }); };
    about();
    close.addEventListener("click", () => { stop(); closeModal(); });

    // Another code, once a minute; the button counts down until then
    // (the modal closed some other way: stop counting)
    function cooldown() {
      left = RESEND_AFTER;
      const tick = () => {
        if (!send.isConnected) return stop();
        send.disabled = left > 0;
        send.textContent = left > 0 ? msg("verifyEmail.resendIn", { seconds: left }) : msg("verifyEmail.resend");
        if (left > 0) left--;
        else stop();
      };
      stop();
      tick();
      timer = setInterval(tick, 1000);
    }

    // The code was accepted (or the address already was verified): new tokens, then /me
    async function finish() {
      busy(true);
      say("");
      let me = null;
      try {
        await session.refresh();
        me = await session.api("GET", "/me");
      } catch { /* said below */ }
      busy(false);
      if (!me || !me.user.emailVerified) {
        again.hidden = false;
        say(msg("verifyEmail.notCaughtUp"));
        return;
      }
      stop();
      form.hidden = true;
      send.hidden = again.hidden = true;
      $("#verifyAbout").hidden = true;
      done.textContent = msg("verifyEmail.verified", { email });
      done.hidden = false;
      close.textContent = msg("verifyEmail.done");
      close.className = "btn primary";
      onVerified(me);
      close.focus();
    }
    again.addEventListener("click", finish);

    // The address changed since the code was sent (or while it was sent or checked): load
    // /me for the current address and start over at sending a code, saying why
    async function restart(e) {
      busy(true);
      stop();
      left = 0;
      let me = null;
      try { me = await session.api("GET", "/me"); } catch { /* keep the address shown */ }
      if (me) email = me.user.email;
      form.hidden = again.hidden = true;
      input.value = "";
      about();
      send.textContent = msg("verifyEmail.sendCode");
      send.className = "btn primary";
      busy(false);
      say(failure(e));
      send.focus();
    }

    send.addEventListener("click", async () => {
      busy(true);
      say("");
      try {
        await session.api("POST", "/me/email/code");
      } catch (e) {
        busy(false);
        if (e.reason === "already_verified") return finish();
        if (e.reason === "email_changed") return restart(e);
        return say(failure(e, true));
      }
      busy(false);
      $("#verifyAbout").innerHTML = msg("verifyEmail.sent", { email: esc(email) });
      form.hidden = false;
      send.className = "btn";
      cooldown();
      input.focus();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.replace(/\D/g, "");
      if (code.length !== 6) { say(msg("verifyEmail.badCode")); input.focus(); return; }
      busy(true);
      say("");
      try {
        await session.api("POST", "/me/email/verify", { code });
      } catch (err) {
        busy(false);
        if (err.reason === "already_verified") return finish();
        if (err.reason === "email_changed") return restart(err);
        say(failure(err, false));
        input.select();
        return;
      }
      finish();
    });
  });
}
