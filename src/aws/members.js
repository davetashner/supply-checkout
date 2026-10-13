// The members screen, for a team's owners in the web build: who's in the team and their
// roles (ADR 0007), changing a role, and removing someone (GET, PATCH and DELETE
// /teams/{teamId}/members in docs/api/openapi.yaml). An owner can step down or leave
// while another owner remains; the server refuses anything that would leave the team
// without an owner (409 `last_owner`), and this screen doesn't offer it either.
//
// Below the members, the team's invites (/teams/{teamId}/invites): inviting an address
// with a role (the server emails the link), and each invite as pending, failed ("Couldn't
// deliver", with why) or expired, with Resend (a new link) and Revoke.
//
// Last, closing the team (POST /teams/{teamId}/close): the owner types the team's name, and
// the button stays off until it matches. A closed team is read-only: this screen then only
// removes people and lets anyone leave, its last owner too, and invites nobody. The whole of
// src/aws/ is web-only, so none of this is in the artifact build.
//
// Reopening a closed team (POST /teams/{teamId}/reopen, openReopen) is offered to its owners
// in the team bar's closed-team notice, typing the team's name the same way.
//
// The screen also shows how many of the team's seats are used ("7 of 10 members", the cap
// from /me's memberCap, asked again as it opens), turning Send invite off once members and invites waiting fill it,
// as the server would refuse (team_full); and what Supply Checkout support did to the team
// (GET /teams/{teamId}/support-actions, ADR 0015).
import { esc } from "../format.js";
import { armButton, openModal, closeModal, toast } from "../dom.js";
import { avatarHTML } from "../avatar.js";
import { msg } from "../i18n.js";

// id, label key, description key
const ROLES = [
  ["owner", "members.roleOwner", "members.roleOwnerDesc"],
  ["contributor", "members.roleContributor", "members.roleContributorDesc"],
  ["viewer", "members.roleViewer", "members.roleViewerDesc"],
];
const AS = { owner: "members.asOwner", contributor: "members.asContributor", viewer: "members.asViewer" };
const INVITE_AS = { owner: "members.inviteAsOwner", contributor: "members.inviteAsContributor", viewer: "members.inviteAsViewer" };
// Why an invite's email didn't arrive, and what the owner can do about it
const WHY = {
  bounced: "members.whyBounced",
  complained: "members.whyComplained",
  not_sent: "members.whyNotSent",
};
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
// What support did, in words (the actions in listSupportActions, backend/src/data/audit.ts)
const SUPPORT = {
  "ops.team.read": () => msg("members.supportRead"),
  "ops.comp.set": (a) => a.after && a.after.until ? msg("members.supportCompSetUntil", { date: day(a.after.until) }) : msg("members.supportCompSet"),
  "ops.comp.end": () => msg("members.supportCompEnd"),
  // What billing did about a free plan's months on the team's Stripe bills (supply-checkout-6e4b)
  "ops.comp.discount": (a) => {
    const outcome = a.after && a.after.outcome;
    return msg(outcome === "applied" ? "members.supportDiscountApplied" : outcome === "removed" ? "members.supportDiscountRemoved" : "members.supportDiscountChecked");
  },
  "ops.import.clear": () => msg("members.supportImportClear"),
};
const SUPPORT_PAGE = 20;

// What went wrong, in words: the server's own for the last owner, and for a team that became
// read-only for billing meanwhile (its trial or subscription ended, or a payment is overdue),
// which say what to do
// `fallback`: the catalog key for any other error
const failure = (e, fallback) =>
  e.reason === "last_owner" || e.reason === "subscription_ended" ? e.message
    : msg(e.code === "not_found" ? "members.failNotFound"
    : e.code === "aborted" ? "members.failAborted"
    : e.code === "permission_denied" ? "members.failDenied"
    : fallback);

// Who a member is, in a sentence: their name (from their account, supply-checkout-lx7), else
// their email. A member chooses their own name, so the row also shows the email under it.
const who = (m) => m.name || m.email;

// `fixed`: roles can't change (a closed team, or one read-only for billing). `photo` is the
// member's photo link, or null for their initials.
function rowHTML(m, me, owners, closed, fixed, photo) {
  const you = m.userId === me;
  const name = (m.name
    ? `${esc(m.name)}${you ? ` <span class="muted">${msg("members.you")}</span>` : ""}<br><span class="muted member-email">${esc(m.email || msg("members.noEmail"))}</span>`
    : esc(m.email || msg("members.noEmailMember")) + (you ? ` <span class="muted">${msg("members.you")}</span>` : ""));
  // The only owner can't step down or leave: a team always keeps an owner, until it's closed
  const last = m.role === "owner" && owners === 1 && !closed;
  const options = ROLES.map(([id, label]) => `<option value="${id}"${id === m.role ? " selected" : ""}>${msg(label)}</option>`).join("");
  return `<li class="member" data-user="${esc(m.userId)}">
    ${avatarHTML(photo, who(m), 32, m.userId)}
    <span class="member-name">${name}</span>
    <select aria-label="${msg("members.roleFor", { name: esc(who(m) || msg("members.thisMember")) })}"${last || fixed ? " disabled" : ""}>${options}</select>
    <button type="button" class="btn danger" data-remove${last ? " disabled" : ""}>${msg(you ? "members.leave" : "members.remove")}</button>
  </li>`;
}

// What went wrong with an invite, in words: the server's own where it says what to do (a full
// team says how many; one read-only for billing says who can make changes again)
const inviteFailure = (e, fallback) =>
  e.reason === "team_full" || e.reason === "subscription_ended" ? e.message
    : e.code === "aborted" ? e.message
    : msg(e.code === "quota_exceeded" ? "members.inviteQuota"
    : e.code === "bad_request" ? "members.inviteBadEmail"
    : e.code === "not_found" ? "members.inviteGone"
    : e.code === "permission_denied" ? "members.inviteDenied"
    : fallback);

// `ended`: the team is read-only for billing, so an invite can be revoked but not re-sent
function inviteHTML(i, ended) {
  const status = i.inviteStatus === "failed" ? `<span class="invite-failed">${msg("members.inviteFailed", { why: msg(WHY[i.failureReason] || "members.whyOther") })}</span>`
    : i.inviteStatus === "expired" ? msg("members.inviteExpired", { date: day(i.expiresAt) })
    : msg("members.invitePending", { date: day(i.expiresAt) });
  return `<li class="member invite-row" data-invite="${esc(i.id)}">
    <span class="member-name">${esc(i.email)} <span class="muted">${msg(INVITE_AS[i.role])}</span><br><span class="invite-status">${status}</span></span>
    ${ended ? "" : `<button type="button" class="btn" data-resend>${msg("members.resend")}</button>`}
    <button type="button" class="btn danger" data-revoke>${msg("members.revoke")}</button>
  </li>`;
}

// A typed team name, as the server compares it (closeTeam): ignoring case and surrounding spaces
const typed = (value) => value.normalize("NFKC").trim().toLowerCase();

// What went wrong closing the team, in words
const closeFailure = (e) =>
  msg(e.code === "bad_request" ? "members.closeBadName"
    : e.code === "aborted" ? "members.closeAborted"
    : e.code === "permission_denied" ? "members.closeDenied"
    : "members.closeFailed");

// The team's invites and closing it, while it's open. A team that's read-only for billing
// (`ended`) can't invite anyone: the form is hidden, and the screen says why.
function openParts(team, ended) {
  return `<h3>${msg(ended ? "members.invitesHeading" : "members.inviteHeading")}</h3>
    ${ended ? `<p class="hint" id="endedMembers">${msg("members.endedHint")}</p>` : ""}
    <form id="inviteForm" class="invite-form" novalidate${ended ? " hidden" : ""}>
      <div class="field"><label for="inviteEmail">${msg("members.emailLabel")}</label><input type="email" id="inviteEmail" required maxlength="254" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="inviteRole">${msg("members.roleLabel")}</label><select id="inviteRole">${ROLES.map(([id, label]) => `<option value="${id}"${id === "contributor" ? " selected" : ""}>${msg(label)}</option>`).join("")}</select></div>
      <button type="submit" class="btn primary" id="inviteSend">${msg("members.sendInvite")}</button>
    </form>
    <p class="hint"${ended ? " hidden" : ""}>${msg("members.inviteHint")}</p>
    <p class="hint" id="teamFull" hidden>${msg("members.teamFull")}</p>
    <p class="error" role="alert" id="invitesFail" hidden></p>
    <div id="invitesList" aria-live="polite"><p class="muted" role="status">${msg("members.loadingInvites")}</p></div>
    <h3>${msg("members.closeHeading")}</h3>
    <p class="hint">${msg("members.closeHint")}</p>
    <form id="closeForm" class="close-form" novalidate>
      <div class="field"><label for="closeName">${msg("members.closeLabel", { name: esc(team.name) })}</label><input type="text" id="closeName" autocomplete="off" spellcheck="false"></div>
      <p class="error" role="alert" id="closeFail" hidden></p>
      <div class="modal-actions"><button type="submit" class="btn danger" id="closeTeam" disabled>${msg("members.closeTeam")}</button></div>
    </form>`;
}

// The invites half of the screen, while the team is open. `invited` runs when an invite is
// sent or re-sent; `changed` gets the invites each time they change. Returns a way to drop the
// invites for an address, which the server revoked when that member was removed, and one to
// turn Send invite off while the team is full.
function wireInvites(api, team, m, invited, changed) {
  const invitesPath = `/teams/${encodeURIComponent(team.id)}/invites`;
  const inviteList = m.querySelector("#invitesList"), inviteFail = m.querySelector("#invitesFail");
  const form = m.querySelector("#inviteForm"), email = m.querySelector("#inviteEmail"), role = m.querySelector("#inviteRole"), send = m.querySelector("#inviteSend");
  const sayInvite = (text) => { inviteFail.textContent = text; inviteFail.hidden = !text; };
  let invites = [], busy = false, full = false;
  const gate = () => { send.disabled = busy || full; };

  function drawInvites() {
    changed(invites);
    inviteList.innerHTML = invites.length ? `<ul class="members invites">${invites.map((i) => inviteHTML(i, team.subscriptionEnded)).join("")}</ul>` : `<p class="muted">${msg("members.noInvites")}</p>`;
    inviteList.querySelectorAll(".invite-row").forEach((row) => {
      const invite = invites.find((x) => x.id === row.dataset.invite);
      const resend = row.querySelector("[data-resend]"), revoke = row.querySelector("[data-revoke]");
      if (resend) resend.addEventListener("click", () => resendInvite(invite, resend));
      armButton(revoke, msg("members.tapToRevoke"), () => revokeInvite(invite, revoke));
    });
  }

  // Shows a new or re-sent invite, and says whether its email went
  function sent(invite, replacing) {
    invites = [invite, ...invites.filter((x) => x.id !== replacing && x.id !== invite.id)];
    drawInvites();
    invited();
    toast(invite.inviteStatus === "failed" ? msg("members.inviteToastFailed", { email: invite.email }) : msg("members.inviteToast", { email: invite.email }));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const address = email.value.trim();
    sayInvite("");
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) { sayInvite(msg("members.inviteBadEmail")); email.focus(); return; }
    busy = true;
    gate();
    try {
      const res = await api("POST", invitesPath, { email: address, role: role.value });
      email.value = "";
      sent(res.invite);
    } catch (err) {
      sayInvite(inviteFailure(err, "members.inviteFailSend"));
    }
    busy = false;
    gate();
  });

  async function resendInvite(invite, button) {
    button.disabled = true;
    sayInvite("");
    try {
      sent((await api("POST", `${invitesPath}/${encodeURIComponent(invite.id)}/resend`)).invite, invite.id);
    } catch (err) {
      // Accepted or revoked meanwhile: it's gone
      if (err.code === "not_found") { invites = invites.filter((x) => x.id !== invite.id); drawInvites(); } else button.disabled = false;
      sayInvite(inviteFailure(err, "members.inviteFailResend"));
    }
  }

  async function revokeInvite(invite, button) {
    button.disabled = true;
    sayInvite("");
    try {
      await api("DELETE", `${invitesPath}/${encodeURIComponent(invite.id)}`);
      invites = invites.filter((x) => x.id !== invite.id);
      drawInvites();
      toast(msg("members.revokedToast", { email: invite.email }));
    } catch (err) {
      button.disabled = false;
      sayInvite(inviteFailure(err, "members.inviteFailRevoke"));
    }
  }

  (async () => {
    try {
      invites = (await api("GET", invitesPath)).invites;
      drawInvites();
    } catch (e) {
      inviteList.innerHTML = "";
      sayInvite(inviteFailure(e, "members.inviteFailLoad"));
    }
  })();
  return {
    dropFor(address) { invites = invites.filter((x) => x.email !== address); drawInvites(); },
    setFull(value) { full = value; m.querySelector("#teamFull").hidden = !full; gate(); },
  };
}

// Closing the team, while it's open: the button stays off until the typed name matches
function wireClose(api, team, m, leave) {
  const name = m.querySelector("#closeName"), button = m.querySelector("#closeTeam"), fail = m.querySelector("#closeFail");
  name.addEventListener("input", () => { button.disabled = typed(name.value) !== typed(team.name); });
  m.querySelector("#closeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    button.disabled = true;
    fail.hidden = true;
    try {
      const res = await api("POST", `/teams/${encodeURIComponent(team.id)}/close`, { name: name.value });
      closeModal();
      leave(msg("members.closed", { team: team.name, date: day(res.team.deletesAt) }));
    } catch (err) {
      fail.textContent = closeFailure(err);
      fail.hidden = false;
      button.disabled = false;
    }
  });
}

// What went wrong reopening the team, in words
const reopenFailure = (e) =>
  msg(e.reason === "team_deleting" ? "members.reopenDeleting"
    : e.code === "bad_request" ? "members.reopenBadName"
    : e.code === "quota_exceeded" ? "members.reopenQuota"
    : e.code === "aborted" ? "members.reopenAborted"
    : e.code === "permission_denied" ? "members.reopenDenied"
    : "members.reopenFailed");

// Reopening a closed team, for its owners: the button stays off until the typed name matches.
// `done` runs once it's open again: the team's access changed, so the page starts again.
export function openReopen(api, team, done) {
  openModal(`<h2>${msg("members.reopenTitle", { team: esc(team.name) })}</h2>
    <p class="hint">${msg("members.reopenIntro")}</p>
    <p class="hint">${msg("members.reopenInvites")}</p>
    <p class="hint">${msg("members.reopenSubscription")}</p>
    <form id="reopenForm" class="close-form" novalidate>
      <div class="field"><label for="reopenName">${msg("members.reopenLabel", { name: esc(team.name) })}</label><input type="text" id="reopenName" autocomplete="off" spellcheck="false" data-autofocus></div>
      <p class="error" role="alert" id="reopenFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="reopenCancel">${msg("members.reopenCancel")}</button><button type="submit" class="btn primary" id="reopenTeamGo" disabled>${msg("members.reopenTeam")}</button></div>
    </form>`, (m) => {
    const name = m.querySelector("#reopenName"), button = m.querySelector("#reopenTeamGo"), fail = m.querySelector("#reopenFail");
    m.querySelector("#reopenCancel").addEventListener("click", closeModal);
    name.addEventListener("input", () => { button.disabled = typed(name.value) !== typed(team.name); });
    m.querySelector("#reopenForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      button.disabled = true;
      fail.hidden = true;
      try {
        await api("POST", `/teams/${encodeURIComponent(team.id)}/reopen`, { name: name.value });
      } catch (err) {
        fail.textContent = reopenFailure(err);
        fail.hidden = false;
        button.disabled = false;
        return;
      }
      closeModal();
      done(msg("members.reopened", { team: team.name }));
    });
  });
}

function supportHTML(a) {
  const what = (SUPPORT[a.action] || (() => msg("members.supportOther")))(a);
  return `<li class="support-action"><span class="muted">${esc(when(a.ts))}</span> ${esc(what)}${a.reason ? `<br><span class="muted">${msg("members.supportReason", { reason: esc(a.reason) })}</span>` : ""}</li>`;
}

// What Supply Checkout support did to the team, newest first, a page at a time. If the first
// page doesn't load, Try again asks for it again; a later one, Show more does.
function wireSupport(api, team, m) {
  const path = `/teams/${encodeURIComponent(team.id)}/support-actions?limit=${SUPPORT_PAGE}`;
  const list = m.querySelector("#supportList"), more = m.querySelector("#supportMore"), fail = m.querySelector("#supportFail");
  let cursor = null, shown = 0;
  async function load() {
    more.disabled = true;
    fail.hidden = true;
    try {
      const page = await api("GET", cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path);
      if (!shown) list.innerHTML = page.actions.length ? `<ul class="support-actions"></ul>` : `<p class="muted">${msg("members.supportNone")}</p>`;
      shown += page.actions.length;
      if (shown) list.querySelector("ul").insertAdjacentHTML("beforeend", page.actions.map(supportHTML).join(""));
      cursor = page.cursor || null;
    } catch {
      if (!shown) {
        list.innerHTML = `<button type="button" class="btn" id="supportRetry">${msg("members.supportRetry")}</button>`;
        list.querySelector("#supportRetry").addEventListener("click", () => {
          list.innerHTML = `<p class="muted" role="status">${msg("members.loading")}</p>`;
          load();
        });
      }
      fail.textContent = msg("members.supportFailed");
      fail.hidden = false;
    }
    more.hidden = !cursor;
    more.disabled = false;
  }
  more.addEventListener("click", load);
  load();
}

// `leave` runs when the owner changes their own role, leaves or closes the team: their access
// changed, so the page starts again (account.js). `invited` runs when an invite is sent or
// re-sent (the first-run checklist's step). `photoOf(userId)` is a member's photo link, or null.
export function openMembers(api, team, me, leave, invited, photoOf) {
  const path = `/teams/${encodeURIComponent(team.id)}/members`;
  const closed = !!team.closedAt;
  // Read-only for billing (/me's subscriptionEnded): members can be removed, but not invited or given another role
  const ended = !closed && !!team.subscriptionEnded;
  // From /me, asked again as the screen opens, since the plan (and so the cap) can change
  // while the page is open; until it answers, or if it doesn't, the one from page load. An
  // API from before it has none, and the screen then shows no count.
  let cap = team.memberCap;
  let members = [], waiting = 0, loaded = false;
  openModal(`<h2>${msg("members.title")}</h2>
    <p class="hint">${ROLES.map(([, name, what]) => msg("members.roleLine", { name: msg(name), description: msg(what) })).join(" ")}</p>
    <p class="seats" id="seats" hidden></p>
    <p class="error" role="alert" id="membersFail" hidden></p>
    <div id="membersList" aria-live="polite"><p class="muted" role="status">${msg("members.loadingMembers")}</p></div>
    ${closed ? `<p class="hint">${msg("members.closedHint")}</p>` : openParts(team, ended)}
    <h3>${msg("members.supportHeading")}</h3>
    <p class="hint">${msg("members.supportIntro")}</p>
    <p class="error" role="alert" id="supportFail" hidden></p>
    <div id="supportList" aria-live="polite"><p class="muted" role="status">${msg("members.loading")}</p></div>
    <button type="button" class="btn" id="supportMore" hidden>${msg("members.showMore")}</button>
    <div class="modal-actions"><button type="button" class="btn" id="membersClose">${msg("members.close")}</button></div>`, (m) => {
    const list = m.querySelector("#membersList"), fail = m.querySelector("#membersFail");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    m.querySelector("#membersClose").addEventListener("click", closeModal);
    // Invites that haven't expired count against the cap, failed ones too, as the server counts them
    const invites = closed ? null : wireInvites(api, team, m, invited, (list) => { waiting = list.filter((i) => Date.parse(i.expiresAt) > Date.now()).length; gate(); });
    if (!closed) wireClose(api, team, m, leave);
    wireSupport(api, team, m);

    // Send invite is off once members and invites waiting fill the team (before the members
    // load, it counts none, so only the server can refuse)
    function gate() {
      if (invites) invites.setFull(!!cap && members.length + waiting >= cap);
    }

    // How many seats are used, once the members have loaded. Not once the screen is gone: /me
    // or the members can answer after it closed (or the session ended and closed it)
    function seats() {
      if (!list.isConnected) return;
      const el = m.querySelector("#seats");
      el.hidden = !(cap && loaded);
      if (!el.hidden) el.textContent = msg("members.seats", { count: members.length, cap });
      gate();
    }

    (async () => {
      let teams;
      try { teams = (await api("GET", "/me")).teams; } catch { return; }
      const now = teams.find((t) => t.id === team.id);
      if (!now) return;
      cap = team.memberCap = now.memberCap;
      seats();
    })();

    function draw() {
      seats();
      const owners = members.filter((x) => x.role === "owner").length;
      list.innerHTML = `<ul class="members">${members.map((x) => rowHTML(x, me, owners, closed, closed || ended, photoOf(x.userId))).join("")}</ul>`
        + (owners === 1 && !closed ? `<p class="hint">${msg("members.needOwner")}</p>` : "");
      list.querySelectorAll(".member").forEach((row) => {
        const member = members.find((x) => x.userId === row.dataset.user);
        const select = row.querySelector("select"), remove = row.querySelector("[data-remove]");
        select.addEventListener("change", () => changeRole(member, select));
        armButton(remove, msg(member.userId === me ? "members.tapToLeave" : "members.tapToRemove"), () => removeMember(member, remove));
      });
    }

    async function changeRole(member, select) {
      const role = select.value;
      select.disabled = true;
      say("");
      try {
        const res = await api("PATCH", `${path}/${encodeURIComponent(member.userId)}`, { role });
        if (member.userId === me) { closeModal(); leave(msg("members.nowRoleYou", { role: msg(AS[role]), team: team.name })); return; }
        members = members.map((x) => (x.userId === member.userId ? res.member : x));
        draw();
        toast(msg("members.nowRole", { name: who(member) || msg("members.theMember"), role: msg(AS[role]) }));
      } catch (e) {
        select.value = member.role;
        select.disabled = false;
        say(failure(e, "members.failChangeRole"));
      }
    }

    async function removeMember(member, button) {
      button.disabled = true;
      say("");
      try {
        await api("DELETE", `${path}/${encodeURIComponent(member.userId)}`);
        if (member.userId === me) { closeModal(); leave(msg("members.left", { team: team.name }), true); return; }
        members = members.filter((x) => x.userId !== member.userId);
        draw();
        // The server revoked their other invites to the team too (a closed team has none)
        if (member.email && invites) invites.dropFor(member.email);
        toast(msg("members.removed", { name: who(member) || msg("members.theMemberLower") }));
      } catch (e) {
        button.disabled = false;
        say(failure(e, "members.failRemove"));
      }
    }

    (async () => {
      try {
        members = (await api("GET", path)).members;
        loaded = true;
        draw();
      } catch (e) {
        list.innerHTML = "";
        say(failure(e, "members.failLoad"));
      }
    })();
  });
}
