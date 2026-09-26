// The members screen, for a team's owners in the web build: who's in the team and their
// roles (ADR 0007), changing a role, and removing someone (GET, PATCH and DELETE
// /teams/{teamId}/members in docs/api/openapi.yaml). An owner can step down or leave
// while another owner remains; the server refuses anything that would leave the team
// without an owner (409 `last_owner`), and this screen doesn't offer it either.
import { esc } from "../format.js";
import { armButton, openModal, closeModal, toast } from "../dom.js";

const ROLES = [
  ["owner", "Owner", "Everything, including members and billing"],
  ["contributor", "Contributor", "Scans, and edits sheets and inventory"],
  ["viewer", "Viewer", "Sees everything, changes nothing"],
];
const AS = { owner: "an owner", contributor: "a contributor", viewer: "a viewer" };

// What went wrong, in words: the server's own for the last owner, which says what to do
const failure = (e, what) =>
  e.reason === "last_owner" ? e.message
    : e.code === "not_found" ? "That person isn't in the team any more."
    : e.code === "aborted" ? "Someone else changed the team's members just now. Try again."
    : e.code === "permission_denied" ? "Only the team's owners can manage members."
    : `Couldn't ${what}. Check your connection and try again.`;

function rowHTML(m, me, owners) {
  const you = m.userId === me;
  const name = esc(m.email || "A member without an email address") + (you ? ` <span class="muted">(you)</span>` : "");
  // The only owner can't step down or leave: a team always keeps an owner
  const last = m.role === "owner" && owners === 1;
  const options = ROLES.map(([id, label]) => `<option value="${id}"${id === m.role ? " selected" : ""}>${label}</option>`).join("");
  return `<li class="member" data-user="${esc(m.userId)}">
    <span class="member-name">${name}</span>
    <select aria-label="Role for ${esc(m.email || "this member")}"${last ? " disabled" : ""}>${options}</select>
    <button type="button" class="btn danger" data-remove${last ? " disabled" : ""}>${you ? "Leave" : "Remove"}</button>
  </li>`;
}

// `leave` runs when the owner changes their own role or leaves: their access changed,
// so the page starts again (account.js)
export function openMembers(api, team, me, leave) {
  const path = `/teams/${encodeURIComponent(team.id)}/members`;
  let members = [];
  openModal(`<h2>Members</h2>
    <p class="hint">${ROLES.map(([, name, what]) => `<strong>${name}</strong>: ${what}.`).join(" ")}</p>
    <p class="error" role="alert" id="membersFail" hidden></p>
    <div id="membersList" aria-live="polite"><p class="muted" role="status">Loading members…</p></div>
    <div class="modal-actions"><button type="button" class="btn" id="membersClose">Close</button></div>`, (m) => {
    const list = m.querySelector("#membersList"), fail = m.querySelector("#membersFail");
    const say = (text) => { fail.textContent = text; fail.hidden = !text; };
    m.querySelector("#membersClose").addEventListener("click", closeModal);

    function draw() {
      const owners = members.filter((x) => x.role === "owner").length;
      list.innerHTML = `<ul class="members">${members.map((x) => rowHTML(x, me, owners)).join("")}</ul>`
        + (owners === 1 ? `<p class="hint">A team needs at least one owner. To step down, make someone else an owner first.</p>` : "");
      // Invites (pending and failed, and inviting someone) go below the list here
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
