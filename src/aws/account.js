// Getting a signed-in user into a team (docs/api/onboarding.md), and the screens for it:
// sign-in, "name your team", joining from an invite link, and errors. They take the app's
// place until a team is open; then a bar under the header shows the team (a switcher when
// there are several), Members and Import CSV for owners, Leave team for everyone else,
// Account (deleting it) and Sign out. A team an owner closed is read-only, with a notice
// saying when its data will be deleted, and for its owners a way to reopen it. So is a team
// whose subscription ended (its trial ended without a card, or payments stopped), with a
// notice, and for its owners a way to subscribe again on Stripe Checkout. Owners of a team
// with a Stripe customer get Billing, the Stripe Customer Portal (a card, plan changes,
// invoices, cancelling), and a canceled subscription says when it ends.
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
const moment = (iso) => new Date(iso).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
// The team switcher asks /me again (dropping teams the user was removed from, adding ones
// they joined) when the team's data is re-listed, at most this often; /me is the API's
// heaviest route, so the polling fallback's re-lists (every 15 seconds) ask far less often
const ME_EVERY = 60e3, ME_EVERY_POLLING = 600e3;
// Why the app is read-only when the team is closed (src/main.js asks, user.viewOnlyNotice)
const CLOSED_NOTICE = "This team is closed, so nothing in it can be changed.";
// When /me can't say when it will be deleted (it didn't load, or doesn't list it closed yet)
const CLOSED_MEANWHILE = "An owner closed this team, so nothing in it can be changed now. Reload the page to see when it will be deleted.";
// Why it's read-only when its subscription ended, as the team opened or after a refused write
const ENDED_NOTICE = "This team's subscription ended, so nothing in it can be changed until an owner subscribes.";
// How long a Customer Portal link is offered before the button makes a new one: Stripe's
// sessions are short-lived
const PORTAL_LINK_MS = 4 * 60e3;
const ENDED_MEANWHILE = "This team's subscription ended, so nothing in it can be changed now. An owner can subscribe again from the team bar.";

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
// Not once another screen has taken over (the session ended while a request was on its way)
const setError = (m) => { const e = box.querySelector("#accountError"); if (e) { e.textContent = m; e.hidden = false; } };

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
// The last user's mark goes first, so another tab open as them sees the change even if
// nothing else can be written; the new user's is set only once nothing of the last user's is
// left, so if something couldn't be removed the next sign-in tries again.
function claim(userId) {
  if (local.get(OWNER_KEY) === userId) return;
  local.remove(OWNER_KEY);
  if (forgetLocal()) local.set(OWNER_KEY, userId);
}

export async function start(config) {
  box = document.createElement("section");
  box.id = "account";
  box.className = "account";
  box.setAttribute("aria-live", "polite");
  document.querySelector(".top").after(box);
  // owner: the signed-in user, once the device's owner mark says it's them (see watchOwner)
  let db = null, created = null, owner = null, switched = false;
  const session = createSession(config, {
    onSignedOut: () => { if (db) db.stop(); signIn(); },
    onRefreshed: () => { if (db) db.reconnect(); },
    // A refresh answered with another user's tokens: the refresh cookie is someone else's now
    onUserChanged: () => accountChanged(),
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
  // The owner mark isn't watched meanwhile: signing out removes it, and the reload that would
  // set off (the tab hidden before Managed Login's page loads) would replace the sign-out there
  async function signOut(e) {
    const button = e.currentTarget, was = owner;
    button.disabled = true;
    owner = null;
    if (await session.signOut()) { if (db) db.stop(); }
    else { owner = was; button.disabled = false; toast("Couldn't sign out. Try again.", 5000); }
  }

  // The account is gone: forget everything here, stop live updates, and say so. Done signs
  // out of Managed Login too.
  // The owner mark isn't watched any more: forgetting the user removes it, and a reload would
  // replace this screen and its sign-out link
  async function deleted() {
    owner = null;
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

  // Someone else signed in, or this user signed out, in another tab: what this tab shows, and
  // anything it has yet to save, is the last user's. Stop before anything else is sent or saved
  // (no refresh, no live updates, API calls refused, drafts no longer kept, the app hidden),
  // then load the page again, which opens as whoever is signed in now. Once: a sign-in
  // elsewhere changes several keys.
  function accountChanged() {
    if (switched) return;
    switched = true;
    session.end();
    if (db) db.stop();
    closeModal();
    show(`<h2>Your account changed</h2>
      <p>Someone signed in or out in another tab. Loading Supply Checkout again…</p>`);
    location.reload();
  }
  // The owner mark (OWNER_KEY in session.js) changed from this user's: when another tab writes
  // storage, and when this tab is shown again (it may have missed the change, asleep or in the
  // back-forward cache). Not before the mark is this user's: if it couldn't be written, there's
  // nothing to watch.
  const checkOwner = () => { if (owner && local.get(OWNER_KEY) !== owner) accountChanged(); };
  addEventListener("storage", checkOwner);
  addEventListener("pageshow", checkOwner);
  document.addEventListener("visibilitychange", checkOwner);

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

  // Which team: a switcher when there are several. Switching loads the page again for the
  // other team: new data, role and live updates.
  function drawSwitcher(el, teams, team) {
    el.innerHTML = teams.length > 1
      ? `<label for="teamSwitch">Team</label><select id="teamSwitch">${teams.map((t) => `<option value="${esc(t.id)}"${t.id === team.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>`
      : `<span>Team: <strong>${esc(team.name)}</strong></span>`;
    const pick = el.querySelector("#teamSwitch");
    if (pick) pick.addEventListener("change", () => { local.set(TEAM_KEY, pick.value); location.reload(); });
  }

  // /me again, when the team's data is re-listed (at most every ME_EVERY, or ME_EVERY_POLLING
  // for the polling fallback's re-lists): the switcher then
  // drops teams the user was removed from meanwhile, which nothing else tells this page. If
  // the open team is gone too, the re-list's 403 says so (removed), so the switcher waits.
  let meAt = 0;
  async function refreshTeams(me, team, el, why) {
    if (Date.now() - meAt < (why === "poll" ? ME_EVERY_POLLING : ME_EVERY)) return;
    meAt = Date.now();
    let teams;
    try { teams = (await session.api("GET", "/me")).teams; } catch { return; }
    if (!teams.some((t) => t.id === team.id)) return;
    me.teams = teams;
    drawSwitcher(el, teams, team);
  }

  // A closed team's owners can reopen it until reopenBy (an hour before it's deleted); then
  // the button goes. An API from before reopenBy leaves the button, and the server refuses a
  // late reopening (team_deleting). Checked again at least daily, so a page left open notices.
  function reopenWindow(bar, team) {
    const left = Date.parse(team.reopenBy) - Date.now();
    if (left > 0) { setTimeout(() => reopenWindow(bar, team), Math.min(left, 864e5)); return; }
    bar.querySelector("#reopenTeam").remove();
    bar.querySelector("#reopenBy").textContent = " It's too close to being deleted to reopen now.";
  }

  // The team bar under the header: which team, a switcher, managing members and importing
  // inventory (owners; importing only while the team is open), leaving (everyone else), the
  // account, and Sign out. A closed team says when it will be deleted; its owners can reopen it.
  function teamBar(me, team, fr) {
    const bar = document.createElement("div");
    bar.className = "teambar";
    const owner = team.role === "owner";
    const reopenBy = owner && team.reopenBy ? `<span id="reopenBy"> Reopen by ${esc(moment(team.reopenBy))} to keep it.</span>` : "";
    const ended = !team.closedAt && team.subscriptionEnded;
    // The Customer Portal: owners of an open team that has a Stripe customer
    const billing = owner && !team.closedAt && team.billingAccount;
    bar.innerHTML = `<span class="team-pick"></span><span class="spacer"></span>${unverified(me) ? `<button type="button" class="btn ghost" id="verifyEmail">Verify email</button>` : ""}${owner ? `<button type="button" class="btn ghost" id="members">Members</button>${billing ? `<button type="button" class="btn ghost" id="manageBilling">Billing</button>` : ""}${team.closedAt || ended ? "" : `<button type="button" class="btn ghost" id="importInventory">Import CSV</button>`}` : `<button type="button" class="btn ghost" id="leaveTeam">Leave team</button>`}<button type="button" class="btn ghost" id="accountOpen">Account</button><button type="button" class="btn ghost" id="signOut">Sign out</button>`
      + (team.closedAt ? `<p class="closed-note" role="status">This team was closed on ${esc(day(team.closedAt))}. It's read-only, and everything in it will be deleted on ${esc(day(team.deletesAt))}.${owner ? " Use Export data to keep a copy." : ""}${reopenBy}</p>${owner ? `<button type="button" class="btn" id="reopenTeam">Reopen team</button>` : ""}` : "")
      + (!team.closedAt && !ended && team.cancelsAt ? `<p class="closed-note" role="status" id="cancelNote">This team's subscription was canceled. Everything works until ${esc(day(team.cancelsAt))}; then the team becomes read-only.${billing ? " To keep it, renew it from Billing." : " Ask an owner to renew it to keep it."}</p>` : "")
      + (ended ? `<p class="closed-note" role="status">This team's subscription has ended, so it's read-only. Nothing has been deleted: everyone can still see it${owner ? ", and you can export it. Subscribe to make changes again." : ". Ask an owner to subscribe to make changes again."}</p>${owner ? `<button type="button" class="btn" id="subscribe">Subscribe</button>` : ""}` : "");
    box.after(bar);
    drawSwitcher(bar.querySelector(".team-pick"), me.teams, team);
    bar.querySelector("#signOut").addEventListener("click", signOut);
    bar.querySelector("#accountOpen").addEventListener("click", () => account(me));
    // Verifying here needs nothing else to change: the team is open, and invites only matter
    // before one is. The button goes once it's done.
    const verify = bar.querySelector("#verifyEmail");
    if (verify) verify.addEventListener("click", () => openVerifyEmail(session, me.user.email, (fresh) => { me.user = fresh.user; verify.remove(); }));
    if (owner) {
      bar.querySelector("#members").addEventListener("click", () => openMembers(session.api, team, me.user.id, changed, invited(fr)));
      if (billing) bar.querySelector("#manageBilling").addEventListener("click", (e) => manageBilling(team, e.currentTarget));
      if (ended) bar.querySelector("#subscribe").addEventListener("click", (e) => subscribe(team, e.currentTarget));
      else if (!team.closedAt) bar.querySelector("#importInventory").addEventListener("click", () => openImport(session.api, team.id, download));
      else {
        bar.querySelector("#reopenTeam").addEventListener("click", () => openReopen(session.api, team, changed));
        if (team.reopenBy) reopenWindow(bar, team);
      }
    } else {
      const leave = bar.querySelector("#leaveTeam");
      armButton(leave, "Tap again to leave", () => leaveTeam(me, team, leave));
    }
    return bar;
  }

  // An owner subscribes a team whose subscription ended: Stripe Checkout for the Starter plan,
  // monthly, with a seat for each member. The server makes the page; a link to it replaces
  // the button, so the owner goes to Stripe with one more tap (and a retry gets the same page).
  let checkoutKey = null;
  async function subscribe(team, button) {
    checkoutKey ||= crypto.randomUUID();
    button.disabled = true;
    try {
      const { checkout } = await session.api("POST", `/teams/${encodeURIComponent(team.id)}/billing/checkout`, { plan: "starter", interval: "month", seats: Math.max(team.members || 1, 1) }, { "Idempotency-Key": checkoutKey });
      const link = document.createElement("a");
      link.className = "btn primary";
      link.id = "checkoutLink";
      link.href = checkout.url;
      link.textContent = "Continue to checkout";
      button.replaceWith(link);
      link.focus();
    } catch (e) {
      button.disabled = false;
      toast(e.reason === "already_subscribed" ? "This team already has a subscription. Reload the page to see it." : "Couldn't start checkout. Check your connection and try again.", 5000);
    }
  }

  // An owner opens the Stripe Customer Portal: the server makes a session for the team's own
  // Stripe customer, and a link to it replaces the button, as for Checkout. A session soon
  // expires, so after PORTAL_LINK_MS the button comes back to make a new one.
  async function manageBilling(team, button) {
    button.disabled = true;
    try {
      const { portal } = await session.api("POST", `/teams/${encodeURIComponent(team.id)}/billing/portal`);
      const link = document.createElement("a");
      link.className = "btn primary";
      link.id = "billingLink";
      link.href = portal.url;
      link.textContent = "Continue to billing";
      button.disabled = false;
      button.replaceWith(link);
      link.focus();
      setTimeout(() => link.replaceWith(button), PORTAL_LINK_MS);
    } catch (e) {
      button.disabled = false;
      toast(e.reason === "no_billing_account" ? "This team has no billing account yet. Reload the page, then subscribe." : "Couldn't open billing. Check your connection and try again.", 5000);
    }
  }

  // The first-run checklist (src/first-run.js) for an owner's open team: for a team they just
  // created, or one whose checklist this device started and they haven't finished or
  // dismissed. Its state is kept per team (firstRunKey); if storage can't be read, a team
  // created now still gets it until the page is closed.
  function firstRun(me, team) {
    if (team.role !== "owner" || team.closedAt || team.subscriptionEnded) return null;
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
    let bar = teamBar(me, team, fr);
    // /me was just loaded
    meAt = Date.now();
    let viewOnly = team.closedAt ? CLOSED_NOTICE : team.subscriptionEnded ? ENDED_NOTICE : null;
    // A write was refused because another owner closed the team meanwhile: ask /me when it will
    // be deleted, and draw the team bar again as a closed team's (its notice, no Import CSV).
    // The view-only notice waits for it, and says to reload if /me couldn't say.
    let closing = null;
    const closedMeanwhile = () => { closing = (async () => {
      viewOnly = CLOSED_MEANWHILE;
      let teams;
      try { teams = (await session.api("GET", "/me")).teams; } catch { return; }
      const now = teams.find((t) => t.id === team.id);
      if (!now || !now.closedAt) return;
      me.teams = teams;
      meAt = Date.now();
      Object.assign(team, now);
      const old = bar;
      bar = teamBar(me, team, fr);
      old.remove();
      viewOnly = CLOSED_NOTICE;
    })(); };
    const name = [claims.given_name, claims.family_name].filter(Boolean).join(" ") || claims.email;
    const profile = { id: me.user.id, name, avatarUrl: AVATAR, isMe: true };
    db = createDb({
      api: session.api, config, teamId: team.id, userId: me.user.id, token: session.token,
      onRemoved: () => removed(team),
      // A write refused because another owner closed the team meanwhile
      onClosed: closedMeanwhile,
      // One refused because the team's subscription ended meanwhile
      onEnded: () => { viewOnly = ENDED_MEANWHILE; },
      onResync: (why) => refreshTeams(me, team, bar.querySelector(".team-pick"), why),
    });
    return {
      db,
      user: {
        id: async () => me.user.id,
        // Viewers read; so does everyone once an owner has closed the team
        can: async (what) => what === "data.write" && team.role !== "viewer" && !team.closedAt && !team.subscriptionEnded,
        // Team owners can export all the team's data (the app's "Export data")
        isOwner: async () => team.role === "owner",
        // Why it's read-only, when that's because the team is closed; null: the role says why
        viewOnlyNotice: async () => { await closing; return viewOnly; },
        // Only the signed-in user's own profile: the API doesn't share other members' names yet
        profiles: async (ids) => Object.fromEntries([].concat(ids).filter((id) => id === me.user.id).map((id) => [id, profile])),
      },
      downloads: { save: download },
      // Where src/main.js keeps this team's receipt draft
      // Read on every load and save: null once the session has ended (signed out, it expired,
      // or someone else signed in), so a save failing then can't write this user's draft back;
      // and once the owner mark isn't this user's, even before this tab has heard, so a save
      // finishing just before the storage event can't either
      drafts: { get key() { return session.token() && (!owner || local.get(OWNER_KEY) === owner) ? draftKey(team.id) : null; } },
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
      owner = local.get(OWNER_KEY) === me.user.id ? me.user.id : null;
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
