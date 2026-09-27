// Getting a signed-in user into a team (docs/api/onboarding.md), and the screens for it:
// sign-in, "name your team", joining from an invite link, and errors. They take the app's
// place until a team is open; then a bar under the header shows the team (a switcher when
// there are several), Members and Import CSV for owners, Leave team for everyone else,
// Account (deleting it) and Sign out. A team an owner closed is read-only, with a notice
// saying when its data will be deleted, and for its owners a way to reopen it.
import { esc } from "../format.js";
import { armButton, closeModal, toast } from "../dom.js";
import { createSession, INVITE_KEY, TEAM_KEY, OWNER_KEY, draftKey, firstRunKey, forgetLocal, local, tab } from "./session.js";
import { createDb } from "./db.js";
import { openImport } from "./import.js";
import { openMembers, openReopen } from "./members.js";
import { openDeleteAccount } from "./delete-account.js";
import { openVerifyEmail } from "./verify-email.js";

const ROLE = { owner: "an owner", contributor: "a contributor", viewer: "a viewer" };
// A screen's promise resolves with this key after the user verifies their email: start the
// screens again with the new /me it holds (its invites, and whether they're verified)
const AGAIN = Symbol("again");
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

// A plain circle for the signed-in user's avatar; the API has no pictures yet
const AVATAR = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1" fill="#0E6B58"/></svg>');

let box;

// Shows a screen in place of the app, and wires it up
function show(html, mount) {
  document.body.classList.add("account-open");
  box.innerHTML = html;
  if (mount) mount(box);
  // data-autofocus rather than autofocus, as in openModal (src/dom.js). Not under an open
  // modal (verifying an email starts the screens again behind it): it keeps the focus.
  const f = box.querySelector("[data-autofocus]");
  if (f && document.getElementById("overlay").hidden) f.focus();
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

// The saved invite, if it's for this user. It's marked with the first user it's offered to,
// so after that user's session ends without Sign out, the next person to sign in in this tab
// isn't offered it, unless it's one of their own invites (/me lists those).
function inviteFor(me) {
  const invite = takeInvite();
  if (!invite) return null;
  if (invite.user && invite.user !== me.user.id && !me.invites.some((i) => i.id === invite.id)) { dropInvite(); return null; }
  tab.set(INVITE_KEY, JSON.stringify({ ...invite, user: me.user.id }));
  return invite;
}

// The saved team and receipt drafts are someone else's (or from before they were marked
// with their user): forget them before anything reads them. Checked at every sign-in rather
// than cleared when a session ends, because a session can end with nothing running (it
// expires while the app is closed), and so the same user coming back keeps their drafts.
// Marked as theirs only once nothing is left; if something couldn't be removed, the mark goes
// instead, so the next sign-in tries again, and another tab open as the last user still sees
// the change.
function claim(userId) {
  if (local.get(OWNER_KEY) === userId) return;
  if (forgetLocal()) local.set(OWNER_KEY, userId);
  else local.remove(OWNER_KEY);
}

export async function start(config) {
  box = document.createElement("section");
  box.id = "account";
  box.className = "account";
  box.setAttribute("aria-live", "polite");
  document.querySelector(".top").after(box);
  let db = null, created = null;
  const session = createSession(config, {
    onSignedOut: () => { if (db) db.stop(); signIn(); },
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
    if (await session.signOut()) { if (db) db.stop(); }
    else { button.disabled = false; toast("Couldn't sign out. Try again.", 5000); }
  }

  // The account is gone: forget everything here, stop live updates, and say so. Done signs
  // out of Managed Login too.
  async function deleted() {
    if (db) db.stop();
    const out = await session.forgetDeleted();
    show(`<h2>Your account is deleted</h2>
      <p>You've been removed from your teams and can't sign in with this account any more. Thanks for using Supply Checkout.</p>
      <div class="actions"><a class="btn primary" href="${esc(out)}" id="deletedDone" autofocus>Done</a></div>`);
  }
  const account = (me) => openDeleteAccount(session.api, me.user.email, deleted);

  // Who's signed in, with a way out, on the screens before a team is open
  const whoami = (me) => `<p class="whoami">Signed in as ${esc(me.user.email || "you")}. <button type="button" class="btn ghost" id="accountSignOut">Sign out</button> <button type="button" class="btn ghost" id="accountDelete">Delete account</button></p>`;
  const wireWhoami = (el, me) => {
    el.querySelector("#accountSignOut").addEventListener("click", signOut);
    el.querySelector("#accountDelete").addEventListener("click", () => account(me));
  };

  // The email isn't verified yet, so no invites are listed or can be accepted: offer to
  // verify it. Hidden (but there, for a refused join to show) when it is verified; nothing
  // when there's no address. Verifying starts the screens again with the new /me.
  const unverified = (me) => !!me.user.email && !me.user.emailVerified;
  const verifyPrompt = (me) => me.user.email ? `<div class="verify-prompt" id="verifyPrompt"${unverified(me) ? "" : " hidden"}>
      <p>Your email address, <strong>${esc(me.user.email)}</strong>, isn't verified yet. Verify it to see and join teams that invite it.</p>
      <div class="actions"><button type="button" class="btn" id="verifyEmail">Verify email</button></div>
    </div>` : "";
  const wireVerify = (el, me, resolve) => {
    const button = el.querySelector("#verifyEmail");
    if (button) button.addEventListener("click", () => openVerifyEmail(session, me.user.email, (fresh) => resolve({ [AGAIN]: fresh })));
  };

  // Anything else that went wrong: say so, and try again from the start
  const failed = () => until((resolve) => show(`<h2>Couldn't connect</h2>
    <p>Supply Checkout didn't answer. Check your connection and try again.</p>
    <div class="actions"><button type="button" class="btn primary" id="retry" data-autofocus>Try again</button></div>`,
  (el) => el.querySelector("#retry").addEventListener("click", resolve)));

  // A new team, with an Idempotency-Key per name, so a retry or double tap makes one team
  const newTeam = (me) => until((resolve) => {
    const seen = me.invites.map((i) => `<p class="invite"><strong>${esc(i.teamName)}</strong> invited you as ${ROLE[i.role]}. Open the link in your invite email to join.</p>`).join("");
    let key = crypto.randomUUID(), keyName = null;
    show(`<h2>Name your team</h2>
      <p>Your team shares one inventory and one set of sheets.</p>
      ${seen}
      ${verifyPrompt(me)}
      <form id="teamForm">
        <div class="field"><label for="teamName">Team name</label><input type="text" id="teamName" required maxlength="200" autocomplete="organization" data-autofocus></div>
        ${errorText("")}
        <div class="actions"><button type="submit" class="btn primary" id="createTeam">Create team</button></div>
      </form>
      ${whoami(me)}`, (el) => { wireWhoami(el, me); wireVerify(el, me, resolve); el.querySelector("#teamForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = el.querySelector("#teamName").value.trim(), btn = el.querySelector("#createTeam");
      if (!name) return;
      // Same name, same key; a new name after a failed attempt needs a new key
      if (keyName !== null && keyName !== name) key = crypto.randomUUID();
      keyName = name;
      btn.disabled = true;
      try {
        const { team } = await session.api("POST", "/teams", { name }, { "Idempotency-Key": key });
        // A new team: its owner gets the first-run checklist (firstRun below)
        created = team.id;
        resolve(team);
      }
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
      ${verifyPrompt(me)}
      ${errorText("")}
      <div class="actions"><button type="button" class="btn primary" id="join" data-autofocus>Join</button>
      <button type="button" class="btn" id="skip">${hasTeams ? "Not now" : "Create my own team instead"}</button></div>
      ${whoami(me)}`, (el) => {
      wireWhoami(el, me);
      wireVerify(el, me, resolve);
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
          const prompt = el.querySelector("#verifyPrompt");
          if (err.code === "permission_denied" && prompt) prompt.hidden = false;
          setError(err.code === "not_found" ? "This invite has expired, was already used, or was sent to a different email address. Ask the person who invited you for a new one."
            : err.code === "permission_denied" ? "Your email address isn't verified yet. Verify it, then join."
            : err.reason === "team_full" ? "This team is full. Ask the person who invited you to make room, then try again."
            : err.code === "quota_exceeded" ? "You're already in as many teams as you can be. Leave one to join this one."
            : "Couldn't join the team. Check your connection and try again.");
        }
      });
    });
  });

  // Another tab signed someone else in, or signed out (the owner mark changed, see OWNER_KEY
  // in session.js): what this tab shows, and anything it has yet to save, is the last user's.
  // Stop before anything else is sent or saved (no refresh, no live updates, API calls refused,
  // the app hidden), then load the page again, which opens as whoever is signed in now. Only
  // when the mark is this user's: if it couldn't be written, there's nothing to watch.
  function watchOwner(userId) {
    if (local.get(OWNER_KEY) !== userId) return;
    addEventListener("storage", function changed() {
      if (local.get(OWNER_KEY) === userId) return;
      // Once: a sign-in elsewhere changes several keys
      removeEventListener("storage", changed);
      session.end();
      if (db) db.stop();
      closeModal();
      show(`<h2>Your account changed</h2>
        <p>Someone signed in or out in another tab. Loading Supply Checkout again…</p>`);
      location.reload();
    });
  }

  // A team to open, or { [AGAIN]: me } after the user verified their email
  async function chooseTeam(me) {
    const invite = inviteFor(me);
    const joined = invite && await joinInvite(me, invite);
    if (joined) return joined;
    if (!me.teams.length) return newTeam(me);
    return me.teams.find((t) => t.id === local.get(TEAM_KEY)) || me.teams[0];
  }

  // Removed from the team while using it: start again with the teams they're still in
  const removed = (team) => show(`<h2>You're no longer in ${esc(team.name)}</h2>
    <p>You've been removed from this team, or it was closed. Ask one of its owners if that's a mistake.</p>
    <div class="actions"><button type="button" class="btn primary" id="continue" data-autofocus>Continue</button></div>`,
  (el) => el.querySelector("#continue").addEventListener("click", () => { local.remove(TEAM_KEY); location.reload(); }));

  // The owner changed their own role or left the team (the members screen): their access
  // changed, so start again from /me. Leaving forgets the team, so another one opens.
  const changed = (text, left) => {
    if (left) local.remove(TEAM_KEY);
    show(`<h2>Your access changed</h2>
    <p>${esc(text)}</p>
    <div class="actions"><button type="button" class="btn primary" id="continue" data-autofocus>Continue</button></div>`,
    (el) => el.querySelector("#continue").addEventListener("click", () => location.reload()));
  };

  // Leaving from the team bar (anyone but an owner, who leaves from Members): two taps, then
  // their access changed. Only the server's answer says it happened.
  async function leaveTeam(me, team, button) {
    button.disabled = true;
    try {
      await session.api("DELETE", `/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(me.user.id)}`);
    } catch {
      button.disabled = false;
      toast("Couldn't leave the team. Check your connection and try again.", 5000);
      return;
    }
    db.stop();
    changed(`You left ${team.name}.`, true);
  }

  // The team bar under the header: which team, a switcher, managing members and importing
  // inventory (owners; importing only while the team is open), leaving (everyone else), the
  // account, and Sign out. A closed team says when it will be deleted; its owners can reopen it.
  function teamBar(me, team, fr) {
    const bar = document.createElement("div");
    bar.className = "teambar";
    const owner = team.role === "owner";
    bar.innerHTML = (me.teams.length > 1
      ? `<label for="teamSwitch">Team</label><select id="teamSwitch">${me.teams.map((t) => `<option value="${esc(t.id)}"${t.id === team.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>`
      : `<span>Team: <strong>${esc(team.name)}</strong></span>`)
      + `<span class="spacer"></span>${unverified(me) ? `<button type="button" class="btn ghost" id="verifyEmail">Verify email</button>` : ""}${owner ? `<button type="button" class="btn ghost" id="members">Members</button>${team.closedAt ? "" : `<button type="button" class="btn ghost" id="importInventory">Import CSV</button>`}` : `<button type="button" class="btn ghost" id="leaveTeam">Leave team</button>`}<button type="button" class="btn ghost" id="accountOpen">Account</button><button type="button" class="btn ghost" id="signOut">Sign out</button>`
      + (team.closedAt ? `<p class="closed-note" role="status">This team was closed on ${esc(day(team.closedAt))}. It's read-only, and everything in it will be deleted on ${esc(day(team.deletesAt))}.${owner ? " Use Export data to keep a copy." : ""}</p>${owner ? `<button type="button" class="btn" id="reopenTeam">Reopen team</button>` : ""}` : "");
    box.after(bar);
    const pick = bar.querySelector("#teamSwitch");
    // Switching loads the page again for the other team: new data, role and live updates
    if (pick) pick.addEventListener("change", () => { local.set(TEAM_KEY, pick.value); location.reload(); });
    bar.querySelector("#signOut").addEventListener("click", signOut);
    bar.querySelector("#accountOpen").addEventListener("click", () => account(me));
    // Verifying here needs nothing else to change: the team is open, and invites only matter
    // before one is. The button goes once it's done.
    const verify = bar.querySelector("#verifyEmail");
    if (verify) verify.addEventListener("click", () => openVerifyEmail(session, me.user.email, (fresh) => { me.user = fresh.user; verify.remove(); }));
    if (owner) {
      bar.querySelector("#members").addEventListener("click", () => openMembers(session.api, team, me.user.id, changed, invited(fr)));
      if (!team.closedAt) bar.querySelector("#importInventory").addEventListener("click", () => openImport(session.api, team.id, download));
      else bar.querySelector("#reopenTeam").addEventListener("click", () => openReopen(session.api, team, changed));
    } else {
      const leave = bar.querySelector("#leaveTeam");
      armButton(leave, "Tap again to leave", () => leaveTeam(me, team, leave));
    }
  }

  // The first-run checklist (src/first-run.js) for an owner's open team: for a team they just
  // created, or one whose checklist this device started and they haven't finished or
  // dismissed. Its state is kept per team (firstRunKey); if storage can't be read, a team
  // created now still gets it until the page is closed.
  function firstRun(me, team) {
    if (team.role !== "owner" || team.closedAt) return null;
    const key = firstRunKey(team.id);
    const state = local.json(key) || (created === team.id ? {} : null);
    if (!state || state.done) return null;
    const fr = {
      state,
      save: () => local.set(key, JSON.stringify(state)),
      // Set by the checklist, to redraw it
      onChange: () => {},
      invite: () => openMembers(session.api, team, me.user.id, changed, invited(fr)),
      importCsv: () => openImport(session.api, team.id, download),
    };
    return fr;
  }
  // What the members screen runs when an invite is sent: tick the checklist's step
  const invited = (fr) => () => { if (fr) { fr.state.invited = true; fr.save(); fr.onChange(); } };

  function open(me, team) {
    // The session ended while the team was being chosen (a refresh found it over, or another
    // tab changed who's signed in): the sign-in screen, or a reload, has taken over
    const claims = session.claims();
    if (!claims) return until(() => {});
    local.set(TEAM_KEY, team.id);
    document.body.classList.remove("account-open");
    box.innerHTML = "";
    const fr = firstRun(me, team);
    teamBar(me, team, fr);
    const name = [claims.given_name, claims.family_name].filter(Boolean).join(" ") || claims.email;
    const profile = { id: me.user.id, name, avatarUrl: AVATAR, isMe: true };
    db = createDb({ api: session.api, config, teamId: team.id, userId: me.user.id, token: session.token, onRemoved: () => removed(team) });
    return {
      db,
      user: {
        id: async () => me.user.id,
        // Viewers read; so does everyone once an owner has closed the team
        can: async (what) => what === "data.write" && team.role !== "viewer" && !team.closedAt,
        // Team owners can export all the team's data (the app's "Export data")
        isOwner: async () => team.role === "owner",
        // Only the signed-in user's own profile: the API doesn't share other members' names yet
        profiles: async (ids) => Object.fromEntries([].concat(ids).filter((id) => id === me.user.id).map((id) => [id, profile])),
      },
      downloads: { save: download },
      // Where src/main.js keeps this team's receipt draft
      drafts: { key: draftKey(team.id) },
      firstRun: fr,
    };
  }

  // Signs in if needed, loads /me and picks a team. Anything that fails shows a screen
  // whose button runs it again; signing in leaves the page.
  for (;;) {
    show(`<p class="muted" role="status">Signing in…</p>`);
    try {
      if (!await session.start()) return signIn();
      let me = await session.api("GET", "/me");
      claim(me.user.id);
      watchOwner(me.user.id);
      for (;;) {
        const team = await chooseTeam(me);
        if (!team[AGAIN]) return open(me, team);
        me = team[AGAIN];
      }
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
