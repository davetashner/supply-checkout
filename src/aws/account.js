// Getting a signed-in user into a team (docs/api/onboarding.md), and the screens for it:
// sign-in, "name your team", joining from an invite link, and errors. They take the app's
// place until a team is open; then a bar under the header shows the team (a switcher when
// there are several), Members and Import CSV for owners, and Sign out.
import { esc } from "../format.js";
import { toast } from "../dom.js";
import { createSession, INVITE_KEY, TEAM_KEY, OWNER_KEY, draftKey, forgetLocal, local, tab } from "./session.js";
import { createDb } from "./db.js";
import { openImport } from "./import.js";
import { openMembers } from "./members.js";

const ROLE = { owner: "an owner", contributor: "a contributor", viewer: "a viewer" };

// A plain circle for the signed-in user's avatar; the API has no pictures yet
const AVATAR = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1" fill="#0E6B58"/></svg>');

let box;

// Shows a screen in place of the app, and wires it up
function show(html, mount) {
  document.body.classList.add("account-open");
  box.innerHTML = html;
  if (mount) mount(box);
  const f = box.querySelector("[autofocus]");
  if (f) f.focus();
}
const until = (fn) => new Promise(fn);
const errorText = (m) => `<p class="error" role="alert" id="accountError"${m ? "" : " hidden"}>${esc(m)}</p>`;
const setError = (m) => { const e = box.querySelector("#accountError"); e.textContent = m; e.hidden = false; };

// The invite in the link (?invite=<id>&token=<token>), kept across sign-in
function takeInvite() {
  const q = new URLSearchParams(location.search);
  if (q.has("invite")) {
    tab.set(INVITE_KEY, JSON.stringify({ id: q.get("invite"), token: q.get("token") }));
    history.replaceState(null, "", location.pathname);
  }
  return tab.json(INVITE_KEY);
}
const dropInvite = () => tab.remove(INVITE_KEY);

// The saved team and receipt drafts are someone else's (or from before they were marked
// with their user): forget them before anything reads them. Checked at every sign-in rather
// than cleared when a session ends, because a session can end with nothing running (it
// expires while the app is closed), and so the same user coming back keeps their drafts.
function claim(userId) {
  if (local.get(OWNER_KEY) === userId) return;
  forgetLocal();
  local.set(OWNER_KEY, userId);
}

export async function start(config) {
  box = document.createElement("section");
  box.id = "account";
  box.className = "account";
  box.setAttribute("aria-live", "polite");
  document.querySelector(".top").after(box);
  let db = null;
  const session = createSession(config, {
    onSignedOut: () => signIn(),
    onRefreshed: () => { if (db) db.reconnect(); },
  });

  // Signed out: a link to Managed Login. Following it leaves the page.
  async function signIn() {
    // A Google or Apple sign-in was just linked to the existing account: sign in with it again
    if (session.relink) {
      const provider = session.relink, url = await session.signInUrl(provider);
      session.relink = "";
      show(`<h2>Signing in</h2>
        <p>Your ${provider === "Google" ? "Google" : "Apple"} sign-in is now linked to your Supply Checkout account. Finishing sign-in…</p>
        <div class="actions"><a class="btn primary big" href="${esc(url)}" id="signIn">Continue</a></div>`);
      location.assign(url);
      return until(() => {});
    }
    const url = await session.signInUrl();
    const invited = !!takeInvite();
    show(`<h2>Sign in</h2>
      <p>${invited ? "Sign in with the email address your invite was sent to, and then you can join the team." : "Sign in to see your team's sheets and inventory."}</p>
      ${errorText(session.notice)}
      <div class="actions"><a class="btn primary big" href="${esc(url)}" id="signIn">Sign in</a></div>`);
    return until(() => {});
  }

  // Leaves the page once the session is revoked; otherwise stays signed in and says so.
  // The button is off while it runs, so it can't be pressed again meanwhile.
  async function signOut(e) {
    const button = e.currentTarget;
    button.disabled = true;
    if (!(await session.signOut())) { button.disabled = false; toast("Couldn't sign out. Try again.", 5000); }
  }

  // Who's signed in, with a way out, on the screens before a team is open
  const whoami = (me) => `<p class="whoami">Signed in as ${esc(me.user.email || "you")}. <button type="button" class="btn ghost" id="accountSignOut">Sign out</button></p>`;
  const wireWhoami = (el) => el.querySelector("#accountSignOut").addEventListener("click", signOut);

  // Anything else that went wrong: say so, and try again from the start
  const failed = () => until((resolve) => show(`<h2>Couldn't connect</h2>
    <p>Supply Checkout didn't answer. Check your connection and try again.</p>
    <div class="actions"><button type="button" class="btn primary" id="retry" autofocus>Try again</button></div>`,
  (el) => el.querySelector("#retry").addEventListener("click", resolve)));

  // A new team, with an Idempotency-Key per name, so a retry or double tap makes one team
  const newTeam = (me) => until((resolve) => {
    const seen = me.invites.map((i) => `<p class="invite"><strong>${esc(i.teamName)}</strong> invited you as ${ROLE[i.role]}. Open the link in your invite email to join.</p>`).join("");
    let key = crypto.randomUUID(), keyName = null;
    show(`<h2>Name your team</h2>
      <p>Your team shares one inventory and one set of sheets.</p>
      ${seen}
      <form id="teamForm">
        <div class="field"><label for="teamName">Team name</label><input type="text" id="teamName" required maxlength="200" autocomplete="organization" autofocus></div>
        ${errorText("")}
        <div class="actions"><button type="submit" class="btn primary" id="createTeam">Create team</button></div>
      </form>
      ${whoami(me)}`, (el) => { wireWhoami(el); el.querySelector("#teamForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = el.querySelector("#teamName").value.trim(), btn = el.querySelector("#createTeam");
      if (!name) return;
      // Same name, same key; a new name after a failed attempt needs a new key
      if (keyName !== null && keyName !== name) key = crypto.randomUUID();
      keyName = name;
      btn.disabled = true;
      try { resolve((await session.api("POST", "/teams", { name }, { "Idempotency-Key": key })).team); }
      catch (err) {
        btn.disabled = false;
        setError(err.code === "quota_exceeded" ? "You've made as many teams as you can for now. Try again tomorrow, or join a team you've been invited to."
          : err.code === "bad_request" ? "Enter a team name of up to 200 characters."
          : "Couldn't create the team. Check your connection and try again.");
      }
    }); });
  });

  // The invite from the link: join it, or (with no team yet) make one instead
  const joinInvite = (me, invite) => until((resolve) => {
    const known = me.invites.find((i) => i.id === invite.id);
    const hasTeams = me.teams.length > 0;
    show(`<h2>${known ? "Join " + esc(known.teamName) : "Join a team"}</h2>
      <p>${known ? `${esc(known.teamName)} invited you as ${ROLE[known.role]}.` : "You've been invited to join a team."}</p>
      ${errorText("")}
      <div class="actions"><button type="button" class="btn primary" id="join" autofocus>Join</button>
      <button type="button" class="btn" id="skip">${hasTeams ? "Not now" : "Create my own team instead"}</button></div>
      ${whoami(me)}`, (el) => {
      wireWhoami(el);
      el.querySelector("#skip").addEventListener("click", () => { dropInvite(); resolve(null); });
      const join = el.querySelector("#join");
      join.addEventListener("click", async () => {
        join.disabled = true;
        try {
          const { team } = await session.api("POST", `/invites/${encodeURIComponent(invite.id)}/accept`, { token: invite.token });
          dropInvite();
          resolve(team);
        } catch (err) {
          join.disabled = false;
          // Already a member: carry on to the team as usual
          if (err.code === "aborted") { dropInvite(); resolve(null); return; }
          if (err.code === "not_found") { dropInvite(); join.hidden = true; }
          setError(err.code === "not_found" ? "This invite has expired, was already used, or was sent to a different email address. Ask the person who invited you for a new one."
            : err.code === "permission_denied" ? "Your email address isn't verified yet. Verify it when you sign in, then open the invite link again."
            : err.reason === "team_full" ? "This team is full. Ask the person who invited you to make room, then try again."
            : err.code === "quota_exceeded" ? "You're already in as many teams as you can be. Leave one to join this one."
            : "Couldn't join the team. Check your connection and try again.");
        }
      });
    });
  });

  async function chooseTeam(me) {
    const invite = takeInvite();
    const joined = invite && await joinInvite(me, invite);
    if (joined) return joined;
    if (!me.teams.length) return newTeam(me);
    return me.teams.find((t) => t.id === local.get(TEAM_KEY)) || me.teams[0];
  }

  // Removed from the team while using it: start again with the teams they're still in
  const removed = (team) => show(`<h2>You're no longer in ${esc(team.name)}</h2>
    <p>You've been removed from this team, or it was closed. Ask one of its owners if that's a mistake.</p>
    <div class="actions"><button type="button" class="btn primary" id="continue" autofocus>Continue</button></div>`,
  (el) => el.querySelector("#continue").addEventListener("click", () => { local.remove(TEAM_KEY); location.reload(); }));

  // The owner changed their own role or left the team (the members screen): their access
  // changed, so start again from /me. Leaving forgets the team, so another one opens.
  const changed = (text, left) => {
    if (left) local.remove(TEAM_KEY);
    show(`<h2>Your access changed</h2>
    <p>${esc(text)}</p>
    <div class="actions"><button type="button" class="btn primary" id="continue" autofocus>Continue</button></div>`,
    (el) => el.querySelector("#continue").addEventListener("click", () => location.reload()));
  };

  // The team bar under the header: which team, a switcher, managing members and importing
  // inventory (owners), and Sign out
  function teamBar(me, team) {
    const bar = document.createElement("div");
    bar.className = "teambar";
    bar.innerHTML = (me.teams.length > 1
      ? `<label for="teamSwitch">Team</label><select id="teamSwitch">${me.teams.map((t) => `<option value="${esc(t.id)}"${t.id === team.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>`
      : `<span>Team: <strong>${esc(team.name)}</strong></span>`)
      + `<span class="spacer"></span>${team.role === "owner" ? `<button type="button" class="btn ghost" id="members">Members</button><button type="button" class="btn ghost" id="importInventory">Import CSV</button>` : ""}<button type="button" class="btn ghost" id="signOut">Sign out</button>`;
    box.after(bar);
    const pick = bar.querySelector("#teamSwitch");
    // Switching loads the page again for the other team: new data, role and live updates
    if (pick) pick.addEventListener("change", () => { local.set(TEAM_KEY, pick.value); location.reload(); });
    bar.querySelector("#signOut").addEventListener("click", signOut);
    if (team.role === "owner") {
      bar.querySelector("#members").addEventListener("click", () => openMembers(session.api, team, me.user.id, changed));
      bar.querySelector("#importInventory").addEventListener("click", () => openImport(session.api, team.id, download));
    }
  }

  function open(me, team) {
    local.set(TEAM_KEY, team.id);
    document.body.classList.remove("account-open");
    box.innerHTML = "";
    teamBar(me, team);
    const claims = session.claims();
    const name = [claims.given_name, claims.family_name].filter(Boolean).join(" ") || claims.email;
    const profile = { id: me.user.id, name, avatarUrl: AVATAR, isMe: true };
    db = createDb({ api: session.api, config, teamId: team.id, userId: me.user.id, token: session.token, onRemoved: () => removed(team) });
    return {
      db,
      user: {
        id: async () => me.user.id,
        can: async (what) => what === "data.write" && team.role !== "viewer",
        // Team owners can export all the team's data (the app's "Export data")
        isOwner: async () => team.role === "owner",
        // Only the signed-in user's own profile: the API doesn't share other members' names yet
        profiles: async (ids) => Object.fromEntries([].concat(ids).filter((id) => id === me.user.id).map((id) => [id, profile])),
      },
      downloads: { save: download },
      // Where src/main.js keeps this team's receipt draft
      drafts: { key: draftKey(team.id) },
    };
  }

  // Signs in if needed, loads /me and picks a team. Anything that fails shows a screen
  // whose button runs it again; signing in leaves the page.
  for (;;) {
    show(`<p class="muted" role="status">Signing in…</p>`);
    try {
      if (!await session.start()) return signIn();
      const me = await session.api("GET", "/me");
      claim(me.user.id);
      return open(me, await chooseTeam(me));
    } catch (e) {
      if (e.code === "unauthenticated") return signIn();
      await failed();
    }
  }
}

// A CSV or JSON file the app made, saved as a browser download
async function download({ filename, data }) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: filename.endsWith(".json") ? "application/json" : "text/csv" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10e3);
  return { status: "saved" };
}
