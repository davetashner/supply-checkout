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
import { esc } from "../format.js";
import { armButton, openModal, closeModal, toast } from "../dom.js";

const ROLES = [
  ["owner", "Owner", "Everything, including members and billing"],
  ["contributor", "Contributor", "Scans, and edits sheets and inventory"],
  ["viewer", "Viewer", "Sees everything, changes nothing"],
];
const AS = { owner: "an owner", contributor: "a contributor", viewer: "a viewer" };
// Why an invite's email didn't arrive, and what the owner can do about it
const WHY = {
  bounced: "The address doesn't take mail. Check it, then revoke this invite and invite the right address.",
  complained: "They marked the invite as spam, so we won't email them again.",
  not_sent: "The email couldn't be sent. Try Resend.",
};
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// What went wrong, in words: the server's own for the last owner, which says what to do
const failure = (e, what) =>
  e.reason === "last_owner" ? e.message
    : e.code === "not_found" ? "That person isn't in the team any more."
    : e.code === "aborted" ? "Someone else changed the team's members just now. Try again."
    : e.code === "permission_denied" ? "Only the team's owners can manage members."
    : `Couldn't ${what}. Check your connection and try again.`;

function rowHTML(m, me, owners, closed) {
  const you = m.userId === me;
  const name = esc(m.email || "A member without an email address") + (you ? ` <span class="muted">(you)</span>` : "");
  // The only owner can't step down or leave: a team always keeps an owner, until it's closed
  const last = m.role === "owner" && owners === 1 && !closed;
  const options = ROLES.map(([id, label]) => `<option value="${id}"${id === m.role ? " selected" : ""}>${label}</option>`).join("");
  return `<li class="member" data-user="${esc(m.userId)}">
    <span class="member-name">${name}</span>
    <select aria-label="Role for ${esc(m.email || "this member")}"${last || closed ? " disabled" : ""}>${options}</select>
    <button type="button" class="btn danger" data-remove${last ? " disabled" : ""}>${you ? "Leave" : "Remove"}</button>
  </li>`;
}

// What went wrong with an invite, in words: the server's own where it says what to do (a full team says how many)
const inviteFailure = (e, what) =>
  e.reason === "team_full" ? e.message
    : e.code === "quota_exceeded" ? "You've sent as many invites as you can for now. Try again tomorrow."
    : e.code === "aborted" ? e.message
    : e.code === "bad_request" ? "Enter an email address, like name@example.com."
    : e.code === "not_found" ? "That invite was accepted or revoked just now."
    : e.code === "permission_denied" ? "Only the team's owners can manage invites."
    : `Couldn't ${what}. Check your connection and try again.`;

function inviteHTML(i) {
  const status = i.inviteStatus === "failed" ? `<span class="invite-failed">Couldn't deliver. ${WHY[i.failureReason] || "Try Resend, or revoke it."}</span>`
    : i.inviteStatus === "expired" ? `Expired ${day(i.expiresAt)}. Resend it for a new link.`
    : `Pending, expires ${day(i.expiresAt)}`;
  return `<li class="member invite-row" data-invite="${esc(i.id)}">
    <span class="member-name">${esc(i.email)} <span class="muted">as ${AS[i.role]}</span><br><span class="invite-status">${status}</span></span>
    <button type="button" class="btn" data-resend>Resend</button>
    <button type="button" class="btn danger" data-revoke>Revoke</button>
  </li>`;
}

// A typed team name, as the server compares it (closeTeam): ignoring case and surrounding spaces
const typed = (value) => value.normalize("NFKC").trim().toLowerCase();

// What went wrong closing the team, in words
const closeFailure = (e) =>
  e.code === "bad_request" ? "Type the team's name as it's shown."
    : e.code === "aborted" ? "Someone else changed the team just now. Try again."
    : e.code === "permission_denied" ? "Only the team's owners can close it."
    : "Couldn't close the team. Check your connection and try again.";

// The team's invites and closing it, while it's open
function openParts(team) {
  return `<h3>Invite someone</h3>
    <form id="inviteForm" class="invite-form" novalidate>
      <div class="field"><label for="inviteEmail">Email</label><input type="email" id="inviteEmail" required maxlength="254" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="inviteRole">Role</label><select id="inviteRole">${ROLES.map(([id, label]) => `<option value="${id}"${id === "contributor" ? " selected" : ""}>${label}</option>`).join("")}</select></div>
      <button type="submit" class="btn primary" id="inviteSend">Send invite</button>
    </form>
    <p class="hint">They get an email with a link that works once and expires in 7 days. They sign in or sign up with that address to join.</p>
    <p class="error" role="alert" id="invitesFail" hidden></p>
    <div id="invitesList" aria-live="polite"><p class="muted" role="status">Loading invites…</p></div>
    <h3>Close the team</h3>
    <p class="hint">Closing makes the team read-only for everyone, straight away, and nobody can join. Owners can still export its data for 30 days; then everything in it is deleted. It can't be undone.</p>
    <form id="closeForm" class="close-form" novalidate>
      <div class="field"><label for="closeName">Type the team's name, <strong>${esc(team.name)}</strong>, to close it</label><input type="text" id="closeName" autocomplete="off" spellcheck="false"></div>
      <p class="error" role="alert" id="closeFail" hidden></p>
      <div class="modal-actions"><button type="submit" class="btn danger" id="closeTeam" disabled>Close team</button></div>
    </form>`;
}

// The invites half of the screen, while the team is open. Returns a way to drop the invites
// for an address, which the server revoked when that member was removed.
function wireInvites(api, team, m) {
  const invitesPath = `/teams/${encodeURIComponent(team.id)}/invites`;
  const inviteList = m.querySelector("#invitesList"), inviteFail = m.querySelector("#invitesFail");
  const form = m.querySelector("#inviteForm"), email = m.querySelector("#inviteEmail"), role = m.querySelector("#inviteRole"), send = m.querySelector("#inviteSend");
  const sayInvite = (text) => { inviteFail.textContent = text; inviteFail.hidden = !text; };
  let invites = [];

  function drawInvites() {
    inviteList.innerHTML = invites.length ? `<ul class="members invites">${invites.map(inviteHTML).join("")}</ul>` : `<p class="muted">No invites waiting.</p>`;
    inviteList.querySelectorAll(".invite-row").forEach((row) => {
      const invite = invites.find((x) => x.id === row.dataset.invite);
      const resend = row.querySelector("[data-resend]"), revoke = row.querySelector("[data-revoke]");
      resend.addEventListener("click", () => resendInvite(invite, resend));
      armButton(revoke, "Tap again to revoke", () => revokeInvite(invite, revoke));
    });
  }

  // Shows a new or re-sent invite, and says whether its email went
  function sent(invite, replacing) {
    invites = [invite, ...invites.filter((x) => x.id !== replacing && x.id !== invite.id)];
    drawInvites();
    toast(invite.inviteStatus === "failed" ? `Couldn't send the invite to ${invite.email}` : `Invite sent to ${invite.email}`);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const address = email.value.trim();
    sayInvite("");
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) { sayInvite("Enter an email address, like name@example.com."); email.focus(); return; }
    send.disabled = true;
    try {
      const res = await api("POST", invitesPath, { email: address, role: role.value });
      email.value = "";
      sent(res.invite);
    } catch (err) {
      sayInvite(inviteFailure(err, "send the invite"));
    }
    send.disabled = false;
  });

  async function resendInvite(invite, button) {
    button.disabled = true;
    sayInvite("");
    try {
      sent((await api("POST", `${invitesPath}/${encodeURIComponent(invite.id)}/resend`)).invite, invite.id);
    } catch (err) {
      // Accepted or revoked meanwhile: it's gone
      if (err.code === "not_found") { invites = invites.filter((x) => x.id !== invite.id); drawInvites(); } else button.disabled = false;
      sayInvite(inviteFailure(err, "resend the invite"));
    }
  }

  async function revokeInvite(invite, button) {
    button.disabled = true;
    sayInvite("");
    try {
      await api("DELETE", `${invitesPath}/${encodeURIComponent(invite.id)}`);
      invites = invites.filter((x) => x.id !== invite.id);
      drawInvites();
      toast(`Revoked the invite to ${invite.email}`);
    } catch (err) {
      button.disabled = false;
      sayInvite(inviteFailure(err, "revoke the invite"));
    }
  }

  (async () => {
    try {
      invites = (await api("GET", invitesPath)).invites;
      drawInvites();
    } catch (e) {
      inviteList.innerHTML = "";
      sayInvite(inviteFailure(e, "load the invites"));
    }
  })();
  return { dropFor(address) { invites = invites.filter((x) => x.email !== address); drawInvites(); } };
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
      leave(`You closed ${team.name}. It's read-only now, and everything in it will be deleted on ${day(res.team.deletesAt)}.`);
    } catch (err) {
      fail.textContent = closeFailure(err);
      fail.hidden = false;
      button.disabled = false;
    }
  });
}

// What went wrong reopening the team, in words
const reopenFailure = (e) =>
  e.reason === "team_deleting" ? "This team is about to be deleted, so it can't be reopened any more."
    : e.code === "bad_request" ? "Type the team's name as it's shown."
    : e.code === "quota_exceeded" ? "This team has been reopened as many times as it can be today. Try again tomorrow."
    : e.code === "aborted" ? "Someone else changed the team just now. Try again."
    : e.code === "permission_denied" ? "Only the team's owners can reopen it."
    : "Couldn't reopen the team. Check your connection and try again.";

// Reopening a closed team, for its owners: the button stays off until the typed name matches.
// `done` runs once it's open again: the team's access changed, so the page starts again.
export function openReopen(api, team, done) {
  openModal(`<h2>Reopen ${esc(team.name)}</h2>
    <p class="hint">Reopening makes the team writable again for its members, straight away, and it won't be deleted. Every owner gets an email about it.</p>
    <p class="hint">Invites that were cancelled when it closed stay cancelled, and anyone who left or was removed while it was closed isn't back: invite them again from Members.</p>
    <form id="reopenForm" class="close-form" novalidate>
      <div class="field"><label for="reopenName">Type the team's name, <strong>${esc(team.name)}</strong>, to reopen it</label><input type="text" id="reopenName" autocomplete="off" spellcheck="false" data-autofocus></div>
      <p class="error" role="alert" id="reopenFail" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" id="reopenCancel">Cancel</button><button type="submit" class="btn primary" id="reopenTeamGo" disabled>Reopen team</button></div>
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
      done(`You reopened ${team.name}. Its members can change it again, and it won't be deleted.`);
    });
  });
}

// `leave` runs when the owner changes their own role, leaves or closes the team: their access
// changed, so the page starts again (account.js)
export function openMembers(api, team, me, leave) {
  const path = `/teams/${encodeURIComponent(team.id)}/members`;
  const closed = !!team.closedAt;
  let members = [];
  openModal(`<h2>Members</h2>
    <p class="hint">${ROLES.map(([, name, what]) => `<strong>${name}</strong>: ${what}.`).join(" ")}</p>
    <p class="error" role="alert" id="membersFail" hidden></p>
    <div id="membersList" aria-live="polite"><p class="muted" role="status">Loading members…</p></div>
    ${closed ? `<p class="hint">This team is closed: you can remove people or leave it, but not invite anyone or change roles.</p>` : openParts(team)}
    <div class="modal-actions"><button type="button" class="btn" id="membersClose">Close</button></div>`, (m) => {
    const list = m.querySelector("#membersList"), fail = m.querySelector("#membersFail");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    m.querySelector("#membersClose").addEventListener("click", closeModal);
    const invites = closed ? null : wireInvites(api, team, m);
    if (!closed) wireClose(api, team, m, leave);

    function draw() {
      const owners = members.filter((x) => x.role === "owner").length;
      list.innerHTML = `<ul class="members">${members.map((x) => rowHTML(x, me, owners, closed)).join("")}</ul>`
        + (owners === 1 && !closed ? `<p class="hint">A team needs at least one owner. To step down, make someone else an owner first.</p>` : "");
      list.querySelectorAll(".member").forEach((row) => {
        const member = members.find((x) => x.userId === row.dataset.user);
        const select = row.querySelector("select"), remove = row.querySelector("[data-remove]");
        select.addEventListener("change", () => changeRole(member, select));
        armButton(remove, member.userId === me ? "Tap again to leave" : "Tap again to remove", () => removeMember(member, remove));
      });
    }

    async function changeRole(member, select) {
      const role = select.value;
      select.disabled = true;
      say("");
      try {
        const res = await api("PATCH", `${path}/${encodeURIComponent(member.userId)}`, { role });
        if (member.userId === me) { closeModal(); leave(`You're now ${AS[role]} in ${team.name}.`); return; }
        members = members.map((x) => (x.userId === member.userId ? res.member : x));
        draw();
        toast(`${member.email || "The member"} is now ${AS[role]}`);
      } catch (e) {
        select.value = member.role;
        select.disabled = false;
        say(failure(e, "change the role"));
      }
    }

    async function removeMember(member, button) {
      button.disabled = true;
      say("");
      try {
        await api("DELETE", `${path}/${encodeURIComponent(member.userId)}`);
        if (member.userId === me) { closeModal(); leave(`You left ${team.name}.`, true); return; }
        members = members.filter((x) => x.userId !== member.userId);
        draw();
        // The server revoked their other invites to the team too (a closed team has none)
        if (member.email && invites) invites.dropFor(member.email);
        toast(`Removed ${member.email || "the member"} from the team`);
      } catch (e) {
        button.disabled = false;
        say(failure(e, "remove them"));
      }
    }

    (async () => {
      try {
        members = (await api("GET", path)).members;
        draw();
      } catch (e) {
        list.innerHTML = "";
        say(failure(e, "load the members"));
      }
    })();
  });
}
