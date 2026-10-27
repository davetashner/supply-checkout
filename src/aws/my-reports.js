// Your reports (supply-checkout-loxj): the issues the signed-in person sent from Report an issue
// in this team, and what happened to each (GET /teams/{teamId}/feedback/mine). Opened from the
// team bar, next to Report an issue, for every role. The server answers only the caller's own
// reports, newest first, with the first line of what they wrote, a category and a status:
// received, being looked at, fixed (with the release, when known) or not planned. A reason for
// not planning one is internal, so the screen never has one to show. The text is private to the
// person: shown here only, never logged or kept on the device. Web build only.
import { esc } from "../format.js";
import { openModal, closeModal } from "../dom.js";
import { msg, dateText } from "../i18n.js";

const KINDS = { bug: "myReports.kindBug", idea: "myReports.kindIdea", question: "myReports.kindQuestion" };

// The status in words; an unknown one (a newer server) reads as received
function statusText(r) {
  switch (r.status) {
    case "looking": return msg("myReports.looking");
    case "fixed": return r.release ? msg("myReports.fixedIn", { release: r.release }) : msg("myReports.fixed");
    case "not_planned": return msg("myReports.notPlanned");
    default: return msg("myReports.received");
  }
}

function reportHTML(r) {
  const kind = KINDS[r.category] ? msg(KINDS[r.category]) : r.category;
  return `<li class="my-report" data-status="${esc(r.status)}">
    <span class="my-report-what"><span class="my-report-text">${esc(r.summary)}</span> <span class="muted">${esc(dateText(r.createdAt))} · ${esc(kind)}</span></span>
    <span class="my-report-status">${esc(statusText(r))}</span>
  </li>`;
}

/** Opens the list. `api` is the session's api(); `team` the current team; `opener` gets the focus back. */
export function openMyReports(api, team, opener) {
  openModal(`<h2 id="myReportsTitle">${msg("myReports.title")}</h2>
    <p class="hint">${msg("myReports.hint")}</p>
    <p class="error" role="alert" id="myReportsFail" hidden></p>
    <div id="myReportsList" aria-live="polite"><p class="muted" role="status">${msg("myReports.loading")}</p></div>
    <div class="modal-actions"><button type="button" class="btn" id="myReportsClose">${msg("myReports.close")}</button></div>`, (m) => {
    m.setAttribute("aria-labelledby", "myReportsTitle");
    const list = m.querySelector("#myReportsList"), fail = m.querySelector("#myReportsFail");
    m.querySelector("#myReportsClose").addEventListener("click", () => {
      m.removeAttribute("aria-labelledby");
      closeModal();
      opener.focus();
    });

    async function load() {
      fail.hidden = true;
      list.innerHTML = `<p class="muted" role="status">${msg("myReports.loading")}</p>`;
      try {
        const page = await api("GET", `/teams/${encodeURIComponent(team.id)}/feedback/mine`);
        list.innerHTML = (page.reports.length ? `<ul class="my-reports">${page.reports.map(reportHTML).join("")}</ul>` : `<p class="muted" id="myReportsNone">${msg("myReports.none")}</p>`)
          + (page.more ? `<p class="hint" id="myReportsMore">${msg("myReports.more")}</p>` : "");
      } catch (e) {
        fail.textContent = e.code === "permission_denied" ? msg("myReports.notInTeam") : msg("myReports.failed");
        fail.hidden = false;
        list.innerHTML = e.code === "permission_denied" ? "" : `<button type="button" class="btn" id="myReportsRetry">${msg("myReports.retry")}</button>`;
        const retry = list.querySelector("#myReportsRetry");
        if (retry) retry.addEventListener("click", load);
      }
    }
    load();
  });
}
