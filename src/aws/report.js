// Report an issue (supply-checkout-bmsh.2): a form in the app's modal that sends a short report
// to POST /teams/{teamId}/feedback (docs/api/openapi.yaml). Any member can send one, a viewer
// and a closed team's members included. Opened from the team bar's "Report an issue", and from
// the "Couldn't connect" screen when the last team is known.
//
// What goes up: the type, what happened, what they expected, whether we may email them, and a
// context of the app version, the screen they were on and their browser family, each from a
// short list the API accepts. The role comes from the token on the server. The report's text is
// private: it is never logged, never put in an analytics event and never kept on the device.
//
// A report is sent with an Idempotency-Key that is reused when the same text is sent again (a
// lost answer, a double tap), so one report is stored; text that was edited after a failure gets
// a new key, so the edit isn't swallowed as a repeat. Every failure keeps what was typed.
// Web build only, like the rest of src/aws/.
import { openModal, closeModal } from "../dom.js";
import { version } from "../../package.json";

const KINDS = [
  ["bug", "Something is broken"],
  ["idea", "I have an idea"],
  ["question", "I have a question"],
];
export const MESSAGE_MAX = 2000, EXPECTED_MAX = 1000;

// The browser family, in the API's words: the first pattern that matches (Edge, Opera and
// Samsung Internet say "Chrome" too, and Chrome says "Safari"; Chrome and Firefox on iPhone say
// CriOS and FxiOS), and `other` for anything else
const BROWSERS = [
  [/\b(?:Edg|EdgA|EdgiOS)\//, "edge"],
  [/\b(?:OPR|OPiOS|OPT)\//, "opera"],
  [/SamsungBrowser\//, "samsung"],
  [/\b(?:Firefox|FxiOS)\//, "firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "chrome"],
  [/Version\/[\d.]+.*Safari\//, "safari"],
  [/(?:)/, "other"],
];
export const browserFamily = (ua) => BROWSERS.find(([re]) => re.test(ua))[1];

// Which screen the report comes from, in the API's words, read from what the page shows now
// (the screens before a team opens say `sign-in` themselves)
export function currentScreen(doc = document) {
  const shown = (id) => !doc.getElementById(id).hidden;
  return shown("receiptView") ? "receipt"
    : shown("projectView") ? "project"
    : doc.getElementById("tab-prices").getAttribute("aria-pressed") === "true" ? "prices"
    : "projects";
}

// What went wrong, in words. Null: the answer never came, so the button offers Try again.
function failure(e) {
  if (e.reason === "feedback_limit") return "You've sent today's limit of 5 reports. Try again tomorrow: the day changes at midnight UTC. Your text is still here.";
  if (e.status === 429) return "Lots of reports are coming in right now. Wait a minute, then send it again.";
  if (e.status === 413) return "That report is too long to send. Shorten it a little, then send it again.";
  if (e.code === "bad_request") return "We couldn't use that report. Check that you wrote what happened, then send it again.";
  if (e.code === "permission_denied") return "You aren't in this team any more, so a report can't be sent from here. Reload the page, then try again.";
  if (e.code === "aborted") return "This team, or your account, is being deleted, so we can't take a report from here.";
  return null;
}
const OFFLINE = "Couldn't send your report. Check your connection, then try again. Your text is still here.";

/**
 * Opens the form. `api` is the session's api(); `teamId` is the team the report is sent
 * under; `role` is the signed-in user's role in it when known (it's only listed for them: the
 * server takes it from the token); `screen` is where they are (default: read from the page);
 * `opener` is the button that was pressed, which gets the focus back (Safari doesn't focus a
 * button when it's clicked, so the focused element can't be asked).
 */
export function openReport(api, { teamId, role = null, screen = currentScreen(), opener }) {
  const context = { build: version, screen, browser: browserFamily(navigator.userAgent) };
  const sends = [`the app version (${version})`, "the screen you're on", "your browser"].concat(role ? [`your role (${role})`] : []);
  const list = `${sends.slice(0, -1).join(", ")} and ${sends.at(-1)}`;
  openModal(`<h2 id="reportTitle">Report an issue</h2>
    <form id="reportForm" class="report-form" novalidate>
      <p class="error" role="alert" id="reportError" hidden></p>
      <fieldset class="kinds"><legend>What kind of report is this?</legend>
        ${KINDS.map(([id, label], i) => `<label class="check report-kind"><input type="radio" name="reportKind" value="${id}"${i === 0 ? " checked" : ""}> ${label}</label>`).join("")}
      </fieldset>
      <div class="field"><label for="reportMessage">What happened</label>
        <textarea id="reportMessage" rows="5" maxlength="${MESSAGE_MAX}" required aria-describedby="reportMessageCount" data-autofocus></textarea>
        <p class="hint" id="reportMessageCount">0 of ${MESSAGE_MAX.toLocaleString("en-US")} characters</p></div>
      <div class="field"><label for="reportExpected">What did you expect? (optional)</label>
        <textarea id="reportExpected" rows="3" maxlength="${EXPECTED_MAX}" aria-describedby="reportExpectedCount"></textarea>
        <p class="hint" id="reportExpectedCount">0 of ${EXPECTED_MAX.toLocaleString("en-US")} characters</p></div>
      <label class="check report-kind"><input type="checkbox" id="reportContact"> You can email me about this</label>
      <p class="hint" id="reportSends">Sent with your report: ${list}. Please don't include passwords or card numbers.</p>
      <div class="modal-actions" id="reportActions">
        <button type="button" class="btn" id="reportCancel">Cancel</button>
        <button type="submit" class="btn primary" id="reportSend">Send report</button>
      </div>
      <div id="reportDiscard" hidden>
        <p role="alert">Discard what you wrote?</p>
        <div class="modal-actions"><button type="button" class="btn" id="reportKeep">Keep writing</button><button type="button" class="btn danger" id="reportDiscardNow">Discard</button></div>
      </div>
    </form>`, (m) => {
    m.setAttribute("aria-labelledby", "reportTitle");
    const form = m.querySelector("#reportForm"), title = m.querySelector("#reportTitle");
    const message = m.querySelector("#reportMessage"), expected = m.querySelector("#reportExpected");
    const contact = m.querySelector("#reportContact");
    const send = m.querySelector("#reportSend"), cancel = m.querySelector("#reportCancel");
    const error = m.querySelector("#reportError");
    const actions = m.querySelector("#reportActions"), discard = m.querySelector("#reportDiscard");
    const overlay = document.getElementById("overlay");
    let sending = false, key = null, sentAs = null, done = false;

    const say = (text) => { error.textContent = text; error.hidden = false; };
    const count = (field, max, id) => {
      m.querySelector(id).textContent = `${field.value.length.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} characters`;
    };
    message.addEventListener("input", () => count(message, MESSAGE_MAX, "#reportMessageCount"));
    expected.addEventListener("input", () => count(expected, EXPECTED_MAX, "#reportExpectedCount"));

    // The dialog is still the one on screen (something else may have closed it)
    const live = () => m.contains(form);
    const typed = () => message.value.trim() !== "" || expected.value.trim() !== "";
    function finish() {
      document.removeEventListener("keydown", onKey, true);
      overlay.removeEventListener("click", onBackdrop, true);
      m.removeAttribute("aria-labelledby");
      closeModal();
      if (opener.isConnected) opener.focus();
    }
    // Close, asking first if something was written and not sent
    function leave() {
      if (sending) return;
      if (done || !typed()) { finish(); return; }
      actions.hidden = true;
      discard.hidden = false;
      m.querySelector("#reportKeep").focus();
    }
    function onKey(e) {
      if (!live()) { document.removeEventListener("keydown", onKey, true); return; }
      if (e.key === "Escape") {
        // Instead of the app's own Escape, which would close the dialog and lose the text
        e.stopPropagation();
        e.preventDefault();
        leave();
      } else if (e.key === "Tab") {
        // Stay in the dialog: wrap from the last control to the first and back
        const focusable = [...m.querySelectorAll("input,textarea,button")].filter((el) => !el.disabled && el.offsetParent !== null && (el.type !== "radio" || el.checked));
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    }
    // A tap outside the dialog: the same as Escape, not a silent loss
    function onBackdrop(e) {
      if (!live()) { overlay.removeEventListener("click", onBackdrop, true); return; }
      if (e.target !== overlay) return;
      e.stopPropagation();
      leave();
    }
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", onBackdrop, true);

    cancel.addEventListener("click", leave);
    m.querySelector("#reportKeep").addEventListener("click", () => {
      discard.hidden = true;
      actions.hidden = false;
      message.focus();
    });
    m.querySelector("#reportDiscardNow").addEventListener("click", finish);

    function thanks(report) {
      done = true;
      form.innerHTML = `<h2 id="reportThanks" tabindex="-1">Thanks, we read every report</h2>
        <p>Your reference is <strong id="reportRef">${report.shortId}</strong>. Keep it if you write to us about this report.</p>
        <div class="modal-actions"><button type="button" class="btn primary" id="reportDone">Done</button></div>`;
      title.hidden = true;
      m.setAttribute("aria-labelledby", "reportThanks");
      const doneButton = form.querySelector("#reportDone");
      doneButton.addEventListener("click", finish);
      doneButton.focus();
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      // A second tap, or Enter, while it's on its way
      if (sending) return;
      const what = message.value.trim();
      if (!what) {
        say("Tell us what happened, so we know what to look at.");
        message.setAttribute("aria-invalid", "true");
        message.focus();
        return;
      }
      message.removeAttribute("aria-invalid");
      const body = {
        category: m.querySelector("input[name=reportKind]:checked").value,
        message: what,
        ...(expected.value.trim() ? { expected: expected.value.trim() } : {}),
        contactOk: contact.checked,
        context,
      };
      // The same report is sent with the same key, so a retry after a lost answer is one report;
      // edited text is a new one
      const signature = JSON.stringify(body);
      if (key === null || signature !== sentAs) key = crypto.randomUUID();
      sentAs = signature;
      sending = true;
      send.disabled = true;
      send.textContent = "Sending…";
      error.hidden = true;
      let report;
      try {
        ({ report } = await api("POST", `/teams/${encodeURIComponent(teamId)}/feedback`, body, { "Idempotency-Key": key }));
      } catch (err) {
        sending = false;
        send.disabled = false;
        const text = failure(err);
        send.textContent = text ? "Send report" : "Try again";
        say(text || OFFLINE);
        // The summary is announced (role=alert); the focus goes to the button that retries
        send.focus();
        return;
      }
      sending = false;
      thanks(report);
    });
  });
}
