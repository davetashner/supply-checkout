// Verifying the signed-in user's email address, in the app's modal (POST /me/email/code and
// POST /me/email/verify in docs/api/openapi.yaml). Only a verified address lists and accepts
// invites. Cognito emails a 6-digit code and checks it; the API makes those calls with the
// user's own access token, as it does for GetUser, so the app still only talks to the API.
// Once the code is accepted, the session refreshes its tokens (the pre token generation
// trigger records a linked user's new address at that refresh) and loads /me again, and
// only when /me says verified does this say so. Cognito limits codes and tries; its refusals
// come back as quota_exceeded, and a new code can be asked for once a minute here.
import { esc } from "../format.js";
import { openModal, closeModal } from "../dom.js";

// Seconds before another code can be asked for
export const RESEND_AFTER = 60;

// What went wrong, in words
const failure = (e, sending) =>
  e.reason === "code_mismatch" ? "That code isn't right. Check the email and try again."
    : e.reason === "code_expired" ? "That code has expired. Send a new one."
    : e.reason === "email_in_use" ? "Another account already uses this email address, so it can't be verified here."
    : e.code === "quota_exceeded" ? "Too many tries for now. Wait a few minutes, then try again."
    : `Couldn't ${sending ? "send the code" : "check the code"}. Check your connection and try again.`;

// `onVerified(me)` runs with the new /me once it says the address is verified
export function openVerifyEmail(session, email, onVerified) {
  openModal(`<h2>Verify your email address</h2>
    <div class="verify" id="verify">
      <p id="verifyAbout">We'll email a 6-digit code to <strong>${esc(email)}</strong>. Once it's verified, you can see and join teams that invite this address.</p>
      <form id="verifyForm" class="verify-form" novalidate hidden>
        <div class="field"><label for="verifyCode">Code from the email</label>
        <input type="text" id="verifyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="12" spellcheck="false"></div>
        <div class="actions"><button type="submit" class="btn primary" id="verifySubmit">Verify</button></div>
      </form>
      <p class="error" role="alert" id="verifyFail" hidden></p>
      <p class="verify-done" role="status" id="verifyDone" hidden></p>
      <div class="actions">
        <button type="button" class="btn primary" id="sendCode" data-autofocus>Send code</button>
        <button type="button" class="btn" id="verifyAgain" hidden>Try again</button>
        <button type="button" class="btn ghost" id="verifyClose">Cancel</button>
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
    close.addEventListener("click", () => { stop(); closeModal(); });

    // Another code, once a minute; the button counts down until then
    // (the modal closed some other way: stop counting)
    function cooldown() {
      left = RESEND_AFTER;
      const tick = () => {
        if (!send.isConnected) return stop();
        send.disabled = left > 0;
        send.textContent = left > 0 ? `Resend code in ${left}s` : "Resend code";
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
        say("Your code was accepted, but your account hasn't caught up yet. Try again in a moment, or sign out and sign in again.");
        return;
      }
      stop();
      form.hidden = true;
      send.hidden = again.hidden = true;
      $("#verifyAbout").hidden = true;
      done.textContent = `${email} is verified.`;
      done.hidden = false;
      close.textContent = "Done";
      close.className = "btn primary";
      onVerified(me);
      close.focus();
    }
    again.addEventListener("click", finish);

    send.addEventListener("click", async () => {
      busy(true);
      say("");
      try {
        await session.api("POST", "/me/email/code");
      } catch (e) {
        busy(false);
        if (e.reason === "already_verified") return finish();
        return say(failure(e, true));
      }
      busy(false);
      $("#verifyAbout").innerHTML = `We sent a code to <strong>${esc(email)}</strong>. Enter it below. It may take a minute to arrive; check your spam folder too.`;
      form.hidden = false;
      send.className = "btn";
      cooldown();
      input.focus();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.replace(/\D/g, "");
      if (code.length !== 6) { say("Enter the 6-digit code from the email."); input.focus(); return; }
      busy(true);
      say("");
      try {
        await session.api("POST", "/me/email/verify", { code });
      } catch (err) {
        busy(false);
        if (err.reason === "already_verified") return finish();
        say(failure(err, false));
        input.select();
        return;
      }
      finish();
    });
  });
}
