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
import { msg, numberText } from "../i18n.js";
import { version } from "../../package.json";

const KINDS = [
  ["bug", "report.kindBug"],
  ["idea", "report.kindIdea"],
  ["question", "report.kindQuestion"],
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
  if (e.reason === "feedback_limit") return msg("report.limit");
  if (e.status === 429) return msg("report.busy");
  if (e.status === 413) return msg("report.tooLong");
  if (e.code === "bad_request") return msg("report.badRequest");
  if (e.code === "permission_denied") return msg("report.notInTeam");
  if (e.code === "aborted") return msg("report.deleting");
  return null;
}

/**
 * Opens the form. `api` is the session's api(); `teamId` is the team the report is sent
 * under; `role` is the signed-in user's role in it when known (it's only listed for them: the
 * server takes it from the token); `screen` is where they are (default: read from the page);
 * `opener` is the button that was pressed, which gets the focus back (Safari doesn't focus a
 * button when it's clicked, so the focused element can't be asked).
 */
export function openReport(api, { teamId, role = null, screen = currentScreen(), opener }) {
  const context = { build: version, screen, browser: browserFamily(navigator.userAgent) };
  const sends = [msg("report.sendsVersion", { version }), msg("report.sendsScreen"), msg("report.sendsBrowser")].concat(role ? [msg("report.sendsRole", { role })] : []);
  const list = msg("report.and", { head: sends.slice(0, -1).join(", "), last: sends.at(-1) });
  openModal(`<h2 id="reportTitle">${msg("report.title")}</h2>
    <form id="reportForm" class="report-form" novalidate>
      <p class="error" role="alert" id="reportError" hidden></p>
      <fieldset class="kinds"><legend>${msg("report.kinds")}</legend>
        ${KINDS.map(([id, key], i) => `<label class="check report-kind"><input type="radio" name="reportKind" value="${id}"${i === 0 ? " checked" : ""}> ${msg(key)}</label>`).join("")}
      </fieldset>
      <div class="field"><label for="reportMessage">${msg("report.what")}</label>
        <textarea id="reportMessage" rows="5" maxlength="${MESSAGE_MAX}" required aria-describedby="reportMessageCount" data-autofocus></textarea>
        <p class="hint" id="reportMessageCount">${msg("report.count", { count: 0, max: numberText(MESSAGE_MAX) })}</p></div>
      <div class="field"><label for="reportExpected">${msg("report.expected")}</label>
        <textarea id="reportExpected" rows="3" maxlength="${EXPECTED_MAX}" aria-describedby="reportExpectedCount"></textarea>
        <p class="hint" id="reportExpectedCount">${msg("report.count", { count: 0, max: numberText(EXPECTED_MAX) })}</p></div>
      <label class="check report-kind"><input type="checkbox" id="reportContact"> ${msg("report.contact")}</label>
      <p class="hint" id="reportSends">${msg("report.sends", { list })}</p>
      <div class="modal-actions" id="reportActions">
        <button type="button" class="btn" id="reportCancel">${msg("report.cancel")}</button>
        <button type="submit" class="btn primary" id="reportSend">${msg("report.send")}</button>
      </div>
      <div id="reportDiscard" hidden>
        <p role="alert">${msg("report.discardAsk")}</p>
        <div class="modal-actions"><button type="button" class="btn" id="reportKeep">${msg("report.keep")}</button><button type="button" class="btn danger" id="reportDiscardNow">${msg("report.discard")}</button></div>
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
      m.querySelector(id).textContent = msg("report.count", { count: numberText(field.value.length), max: numberText(max) });
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
      form.innerHTML = `<h2 id="reportThanks" tabindex="-1">${msg("report.thanks")}</h2>
        <p>${msg("report.reference", { id: report.shortId })}</p>
        <div class="modal-actions"><button type="button" class="btn primary" id="reportDone">${msg("report.done")}</button></div>`;
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
        say(msg("report.needText"));
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
      send.textContent = msg("report.sending");
      error.hidden = true;
      let report;
      try {
        ({ report } = await api("POST", `/teams/${encodeURIComponent(teamId)}/feedback`, body, { "Idempotency-Key": key }));
      } catch (err) {
        sending = false;
        send.disabled = false;
        const text = failure(err);
        send.textContent = msg(text ? "report.send" : "report.tryAgain");
        say(text || msg("report.offline"));
        // The summary is announced (role=alert); the focus goes to the button that retries
        send.focus();
        return;
      }
      sending = false;
      thanks(report);
    });
  });
}
