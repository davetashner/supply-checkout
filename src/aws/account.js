// Getting a signed-in user into a team (docs/api/onboarding.md), and the screens for it:
// sign-in, "name your team", joining from an invite link, and errors. They take the app's
// place until a team is open; then a bar under the header shows the team (a switcher when
// there are several), Members and Import CSV for owners, Leave team for everyone else,
// Account (who is signed in, with their photo and role; their profile photo, profile-photo.js;
// What's New on or off; deleting the account) and
// Sign out. Under the bar, the What's New banner, at most once a day (whats-new.js). A team an owner closed is read-only, with a notice
// saying when its data will be deleted, and for its owners a way to reopen it. So is a team
// whose subscription ended (its trial ended without a card, or payments stopped), with a
// notice, and for its owners a way to subscribe again on Stripe Checkout. Owners of a team
// with a Stripe customer get Billing, the Stripe Customer Portal (a card, plan changes,
// invoices, cancelling) and Invoices (the latest ones, invoices.js; a closed team's owners
// keep Invoices until it's deleted), and a canceled
// subscription says when it ends. Billing needs
// two-step sign-in (an authenticator app, mfa.js), which Account sets up; when the server
// refuses billing for want of it, the setup opens. Account also changes the password
// (password.js). Help (help.js), the how-to lesson for the screen, and Report an issue (report.js) sit
// beside Sign out; Report an issue is on the "Couldn't connect" screen too.
import { esc, visibleText } from "../format.js";
import { msg, dateText, dateTimeText, calendarDateText } from "../i18n.js";
import { armButton, closeModal, openModal, toast } from "../dom.js";
import { createSession, INVITE_KEY, TEAM_KEY, OWNER_KEY, draftKey, firstRunKey, forgetLocal, local, tab } from "./session.js";
import { createDb } from "./db.js";
import { openImport } from "./import.js";
import { openSettings, settingsFor } from "./settings.js";
import { receiptsFor } from "./receipts.js";
import { openMembers, openReopen } from "./members.js";
import { openDeleteAccount } from "./delete-account.js";
import { openVerifyEmail } from "./verify-email.js";
import { openTwoStep } from "./mfa.js";
import { openChangePassword } from "./password.js";
import { openReset } from "./reset-password.js";
import { openInvoices } from "./invoices.js";
import { showWhatsNew } from "./whats-new.js";
import { openReport } from "./report.js";
import { helpLink, wireHelp } from "./help.js";
import { legalNotice } from "./legal.js";
import { createPhotos } from "./photos.js";
import { avatarHTML } from "../avatar.js";
import { PARAMS as CAMPAIGN_PARAMS, STORAGE_KEY as CAMPAIGN_KEY, loadCampaign, readCampaign, saveCampaign } from "../campaign.js";

const ROLE = { owner: "account.asOwner", contributor: "account.asContributor", viewer: "account.asViewer" };
// A screen's promise resolves with this key after the user verifies their email: start the
// screens again with the new /me it holds (its invites, and whether they're verified)
const AGAIN = Symbol("again");
const day = (iso) => dateText(iso, "long");
const moment = (iso) => dateTimeText(iso, { style: "long", zone: true });
// The team switcher asks /me again (dropping teams the user was removed from, adding ones
// they joined) when the team's data is re-listed, at most this often; /me is the API's
// heaviest route, so the polling fallback's re-lists (every 15 seconds) ask far less often
const ME_EVERY = 60e3, ME_EVERY_POLLING = 600e3;
// Why the app is read-only when the team is closed (src/main.js asks, user.viewOnlyNotice)
const closedNotice = () => msg("account.closedNotice");
// When /me can't say when it will be deleted (it didn't load, or doesn't list it closed yet)
const closedMeanwhile = () => msg("account.closedMeanwhile");
// Why it's read-only for billing (/me's subscriptionEnded), by readOnlyReason, as the team
// opened or once /me says so after a refused write
const ENDED_NOTICES = {
  subscription_ended: "account.endedSubscription",
  trial_ended: "account.endedTrial",
  payment_overdue: "account.endedPayment",
};
// Why a team is read-only for billing: an API from before readOnlyReason, or a reason this
// page doesn't know, reads as an ended subscription (an owner subscribes)
const endedReason = (team) => (Object.hasOwn(ENDED_NOTICES, team.readOnlyReason ?? "") ? team.readOnlyReason : "subscription_ended");
// What the app says is read-only and why: a closed team, one read-only for billing, or null (the role says)
const viewOnlyFor = (team) => (team.closedAt ? closedNotice() : team.subscriptionEnded ? msg(ENDED_NOTICES[endedReason(team)]) : null);
// readOnlyLastDay, a calendar date (YYYY-MM-DD) the emails state too: shown as that date wherever the reader is
const lastDay = (ymd) => calendarDateText(ymd, "long");
// How long a Customer Portal link is offered before the button makes a new one: Stripe's
// sessions are short-lived
const PORTAL_LINK_MS = 4 * 60e3;
// A write refused for billing while the page was open, when /me can't say why
const endedMeanwhile = () => msg("account.endedMeanwhile");

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

// The invite in the link (?invite=<id>&token=<token>), kept across sign-in. A link copied
// from the email's HTML source has "&amp;token=" (supply-checkout-6uw.29): read that too.
function takeInvite() {
  const q = new URLSearchParams(location.search);
  if (q.has("invite")) {
    tab.set(INVITE_KEY, JSON.stringify({ id: q.get("invite"), token: q.get("token") ?? q.get("amp;token") }));
    history.replaceState(null, "", location.pathname);
  }
  return tab.json(INVITE_KEY);
}
const dropInvite = () => tab.remove(INVITE_KEY);

// The campaign tags in the link (utm_source, utm_medium, utm_campaign; src/campaign.js,
// supply-checkout-kajm): kept in this browser, apart from the rest of the link which stays,
// until the team is created, which sends them once and forgets them. Never a URL or referrer.
const campaignStore = { getItem: (k) => local.get(k), setItem: (k, v) => local.set(k, v), removeItem: (k) => local.remove(k) };
function takeCampaign() {
  const q = new URLSearchParams(location.search);
  const names = Object.keys(CAMPAIGN_PARAMS).filter((name) => q.has(name));
  if (!names.length) return;
  saveCampaign(campaignStore, readCampaign(location.search));
  for (const name of names) q.delete(name);
  const rest = q.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
}
// An invite link with its ID or token missing or mangled (cut short, or broken across lines
// when copied): the server can't accept it, so say so rather than try. IDs are the API's
// (1 to 128 letters, digits, - or _); tokens are base64url.
const INVITE_ID = /^[A-Za-z0-9_-]{1,128}$/, INVITE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const wellFormed = (invite) => typeof invite.id === "string" && INVITE_ID.test(invite.id) && typeof invite.token === "string" && INVITE_TOKEN.test(invite.token);
const incomplete = () => msg("account.incomplete");

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

// Who the ID token's claims say is signed in: their name, else their email
const nameOf = (claims) => [claims.given_name, claims.family_name].filter(Boolean).join(" ") || claims.email;

export async function start(config) {
  takeCampaign();
  box = document.createElement("section");
  box.id = "account";
  box.className = "account";
  box.setAttribute("aria-live", "polite");
  document.querySelector(".top").after(box);
  // owner: the signed-in user, once the device's owner mark says it's them (see watchOwner)
  let db = null, owner = null, switched = false;
  // Screens drawn after waiting take a turn first; one that started later wins. A sign-out
  // everywhere refused because the session already ended starts the session's sign-in screen
  // and then the changed password's: the second is drawn, whichever finishes first.
  let turn = 0;
  // The team's profile photos (photos.js), once a team is open and the API has photos
  let photos = null;
  const session = createSession(config, {
    onSignedOut: () => { if (db) db.stop(); signIn(); },
    onRefreshed: () => { if (db) db.reconnect(); },
    // A refresh answered with another user's tokens: the refresh cookie is someone else's now
    onUserChanged: () => accountChanged(),
    // The API refused this session as older than the account's password reset
    onPasswordReset: () => passwordWasReset(),
  });

  // Signed out: a link to Managed Login. Following it leaves the page.
  async function signIn() {
    // A Google or Apple sign-in was just linked to the existing account: sign in with it again
    if (session.relink) {
      const provider = session.relink, url = await session.signInUrl(provider);
      session.relink = "";
      show(`<h2>${msg("account.relinkTitle")}</h2>
        <p>${msg("account.relinkBody", { provider: provider === "Google" ? "Google" : "Apple" })}</p>
        <div class="actions"><a class="btn primary big" href="${esc(url)}" id="signIn">${msg("account.continue")}</a></div>`);
      location.assign(url);
      return until(() => {});
    }
    const mine = ++turn;
    const url = await session.signInUrl();
    if (mine !== turn) return until(() => {});
    const invited = !!takeInvite();
    show(`<h2>${msg("account.signInTitle")}</h2>
      <p>${msg(invited ? "account.signInInvited" : "account.signInPlain")}</p>
      ${errorText(session.notice)}
      <div class="actions"><a class="btn primary big" href="${esc(url)}" id="signIn">${msg("account.signIn")}</a></div>
      <p><button type="button" class="btn ghost" id="forgotPassword">${msg("account.forgot")}</button></p>
      ${legalNotice()}`, (el) => {
      // Our own reset (reset-password.js), which helps when the address has no account
      el.querySelector("#forgotPassword").addEventListener("click", () => {
        session.notice = "";
        openReset({ show, setError, apiUrl: config.apiUrl, signInUrl: () => session.signInUrl(), back: signIn });
      });
    });
    return until(() => {});
  }

  // Leaves the page once the session is revoked; otherwise stays signed in and says so.
  // The button is off while it runs, so it can't be pressed again meanwhile.
  // The owner mark isn't watched meanwhile: signing out removes it, and the reload that would
  // set off (the tab hidden before Managed Login's page loads) would replace the sign-out there
  async function signOut(e, keep = false) {
    const button = e.currentTarget, was = owner;
    button.disabled = true;
    owner = null;
    if (await session.signOut(keep)) { if (db) db.stop(); }
    else { owner = was; button.disabled = false; toast(msg("account.signOutFailed"), 5000); }
  }

  // The account is gone: forget everything here, stop live updates, and say so. Done signs
  // out of Managed Login too.
  // The owner mark isn't watched any more: forgetting the user removes it, and a reload would
  // replace this screen and its sign-out link
  async function deleted() {
    owner = null;
    if (db) db.stop();
    const out = await session.forgetDeleted();
    show(`<h2>${msg("account.deletedTitle")}</h2>
      <p>${msg("account.deletedBody")}</p>
      <div class="actions"><a class="btn primary" href="${esc(out)}" id="deletedDone" autofocus>${msg("account.done")}</a></div>`);
  }
  // Two-step sign-in is on, and the API signed the user out everywhere: this tab's session is
  // over, so stop, and offer to sign in again (with the password and the app's code). The
  // owner mark stays, so the same person keeps their team and drafts.
  // The same after a password change that signed out everywhere (password.js).
  // `title` and `text` are catalog keys
  async function signedOutEverywhere(title, text) {
    turn++;
    owner = null;
    if (db) db.stop();
    const out = await session.endEverywhere();
    show(`<h2>${msg(title)}</h2>
      <p>${msg(text)}</p>
      <div class="actions"><a class="btn primary big" href="${esc(out)}" id="signInAgain" data-autofocus>${msg("account.signInAgain")}</a></div>`);
  }
  // This session began before the account was last signed out everywhere (supply-checkout-6uw.33):
  // after a password reset, or a password change or turning two-step sign-in on in another session,
  // so the message names none of them (supply-checkout-6uw.34). The API refuses it everywhere, so
  // stop, and offer to sign in again. Signing
  // out here and of Managed Login, whose session from before would otherwise sign straight back
  // in, keeps the team and drafts for the same person, as signing in again for billing does.
  function passwordWasReset() {
    owner = null;
    if (db) db.stop();
    closeModal();
    show(`<h2>${msg("account.resetTitle")}</h2>
      <p>${msg("account.resetBody")}</p>
      <div class="actions"><button type="button" class="btn primary big" id="resetSignInAgain" data-autofocus>${msg("account.signInAgain")}</button></div>`, (el) => {
      el.querySelector("#resetSignInAgain").addEventListener("click", (e) => signOut(e, true));
    });
  }
  const twoStepOn = () => signedOutEverywhere("account.twoStepOnTitle", "account.twoStepOnBody");
  const passwordChanged = () => signedOutEverywhere("account.passwordChangedTitle", "account.passwordChangedBody");
  const twoStep = (me, options) => openTwoStep(session, me.user.email, twoStepOn, options);
  // Takes the What's New banner away once Account turns it off; nothing until it's shown
  let hideWhatsNew = () => {};
  // Shows a name Account just saved in the bar under the header; nothing until a team is open
  let renamed = () => {};
  // The user's first and last name, for Account's Name section (name.js): the ID token's. Once
  // it's saved, new tokens carry it (a failed refresh leaves the old one until the next), and
  // the team bar shows it
  const ownName = (me) => {
    // Account is only offered while signed in, so there are claims
    const claims = session.claims();
    return {
      given: claims.given_name || "", family: claims.family_name || "", provider: me.user.mfa === "provider",
      saved: async () => { await session.refresh().catch(() => {}); renamed(); },
    };
  };
  // The user's own photo, for Account: the team's list's link once a team is open, else /me's.
  // Nothing from an API without photos (no photoUrl in /me).
  const ownPhoto = (me, name) => me.user.photoUrl === undefined ? null : {
    name, userId: me.user.id,
    url: () => (photos ? photos.url(me.user.id) : me.user.photoUrl),
    set: (url) => { me.user.photoUrl = url; if (photos) photos.set(me.user.id, url); },
  };
  // `name`: who they are, for their initials
  const account = (me, name) => openDeleteAccount(session.api, me.user.email, deleted, {
    mfa: me.user.mfa,
    setUp: (moving) => twoStep(me, { moving }),
    changePassword: () => openChangePassword(session, me.user.email, passwordChanged, { required: me.user.mfa === "totp" }),
  }, { prefs: me.user.preferences, off: () => hideWhatsNew() }, ownPhoto(me, name), ownName(me));

  // Who's signed in, with a way out, on the screens before a team is open
  const whoami = (me) => `<p class="whoami">${msg("account.whoami", { email: esc(me.user.email || msg("account.you")) })} <button type="button" class="btn ghost" id="accountSignOut">${msg("account.signOut")}</button> <button type="button" class="btn ghost" id="accountDelete">${msg("account.deleteAccount")}</button></p>`;
  const wireWhoami = (el, me) => {
    el.querySelector("#accountSignOut").addEventListener("click", signOut);
    el.querySelector("#accountDelete").addEventListener("click", () => account(me, me.user.email));
  };

  // The email isn't verified yet, so no invites are listed or can be accepted: offer to
  // verify it. Hidden (but there, for a refused join to show) when it is verified; nothing
  // when there's no address. Verifying starts the screens again with the new /me.
  const unverified = (me) => !!me.user.email && !me.user.emailVerified;
  const verifyPrompt = (me) => me.user.email ? `<div class="verify-prompt" id="verifyPrompt"${unverified(me) ? "" : " hidden"}>
      <p>${msg("account.verifyPrompt", { email: esc(me.user.email) })}</p>
      <div class="actions"><button type="button" class="btn" id="verifyEmail">${msg("account.verifyEmail")}</button></div>
    </div>` : "";
  const wireVerify = (el, me, resolve) => {
    const button = el.querySelector("#verifyEmail");
    if (button) button.addEventListener("click", () => openVerifyEmail(session, me.user.email, (fresh) => resolve({ [AGAIN]: fresh })));
  };

  // Anything else that went wrong: say so, and try again from the start
  // With a way to report it when the last team is known: a report is sent under a team
  const failed = () => until((resolve) => {
    const teamId = local.get(TEAM_KEY);
    show(`<h2>${msg("account.failedTitle")}</h2>
    <p>${msg("account.failedBody")}</p>
    <div class="actions"><button type="button" class="btn primary" id="retry" data-autofocus>${msg("account.tryAgain")}</button>${teamId ? `<button type="button" class="btn" id="reportIssue">${msg("account.reportIssue")}</button>` : ""}</div>`,
    (el) => {
      el.querySelector("#retry").addEventListener("click", resolve);
      if (teamId) el.querySelector("#reportIssue").addEventListener("click", (e) => openReport(session.api, { teamId, screen: "sign-in", opener: e.currentTarget }));
    });
  });

  // A new team, with an Idempotency-Key per name, so a retry or double tap makes one team
  const newTeam = (me) => until((resolve) => {
    const seen = me.invites.map((i) => `<p class="invite">${msg("account.invitedAs", { team: esc(i.teamName), role: msg(ROLE[i.role]) })}</p>`).join("");
    let key = crypto.randomUUID(), keyName = null;
    show(`<h2>${msg("account.nameTeamTitle")}</h2>
      <p>${msg("account.nameTeamBody")}</p>
      ${seen}
      ${verifyPrompt(me)}
      <form id="teamForm">
        <div class="field"><label for="teamName">${msg("account.teamName")}</label><input type="text" id="teamName" required maxlength="200" autocomplete="organization" data-autofocus></div>
        ${errorText("")}
        <div class="actions"><button type="submit" class="btn primary" id="createTeam">${msg("account.createTeam")}</button></div>
      </form>
      ${whoami(me)}`, (el) => { wireWhoami(el, me); wireVerify(el, me, resolve); el.querySelector("#teamForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      // Pasted control and invisible characters are cleaned, not sent: the API refuses them (supply-checkout-1dg.13)
      const name = visibleText(el.querySelector("#teamName").value).trim(), btn = el.querySelector("#createTeam");
      if (!name) return;
      // Same name, same key; a new name after a failed attempt needs a new key
      if (keyName !== null && keyName !== name) key = crypto.randomUUID();
      keyName = name;
      btn.disabled = true;
      try {
        // A new team comes with the first-run checklist for its owner (firstRun below)
        const campaign = loadCampaign(campaignStore);
        const { team } = await session.api("POST", "/teams", { name, ...(campaign ? { campaign } : {}) }, { "Idempotency-Key": key });
        local.remove(CAMPAIGN_KEY);
        resolve(team);
      }
      catch (err) {
        btn.disabled = false;
        setError(msg(err.code === "quota_exceeded" ? "account.teamQuota" : err.code === "bad_request" ? "account.teamBadName" : "account.teamFailed"));
      }
    }); });
  });

  // The invite from the link: join it, or (with no team yet) make one instead
  const joinInvite = (me, invite) => until((resolve) => {
    const known = me.invites.find((i) => i.id === invite.id);
    const hasTeams = me.teams.length > 0;
    // A broken link can't be joined: say so at once, with no Join, and forget it
    const broken = !wellFormed(invite);
    if (broken) dropInvite();
    show(`<h2>${known ? msg("account.joinTeamTitle", { team: esc(known.teamName) }) : msg("account.joinTitle")}</h2>
      <p>${known ? msg("account.joinKnown", { team: esc(known.teamName), role: msg(ROLE[known.role]) }) : msg("account.joinUnknown")}</p>
      ${verifyPrompt(me)}
      ${errorText(broken ? incomplete() : "")}
      <div class="actions"><button type="button" class="btn primary" id="join"${broken ? " hidden" : " data-autofocus"}>${msg("account.join")}</button>
      <button type="button" class="btn" id="skip">${msg(hasTeams ? "account.notNow" : "account.createInstead")}</button></div>
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
          // not_found: expired, used or someone else's; bad_request: the link is broken
          if (err.code === "not_found" || err.code === "bad_request") { dropInvite(); join.hidden = true; }
          const prompt = el.querySelector("#verifyPrompt");
          if (err.code === "permission_denied" && prompt) prompt.hidden = false;
          setError(err.code === "bad_request" ? incomplete()
            : msg(err.code === "not_found" ? "account.joinExpired"
            : err.code === "permission_denied" ? "account.joinUnverified"
            : err.reason === "team_full" ? "account.joinFull"
            : err.code === "quota_exceeded" ? "account.joinQuota"
            : "account.joinFailed"));
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
    show(`<h2>${msg("account.changedTitle")}</h2>
      <p>${msg("account.changedBody")}</p>`);
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
    // The /me that loaded the page doesn't list the team just joined: add it, so the switcher
    // shows it with the others without a reload (supply-checkout-6uw.29)
    if (joined) {
      me.teams = [...me.teams.filter((t) => t.id !== joined.id), joined];
      return joined;
    }
    if (!me.teams.length) return newTeam(me);
    return me.teams.find((t) => t.id === local.get(TEAM_KEY)) || me.teams[0];
  }

  // Removed from the team while using it: start again with the teams they're still in
  const removed = (team) => show(`<h2>${msg("account.removedTitle", { team: esc(team.name) })}</h2>
    <p>${msg("account.removedBody")}</p>
    <div class="actions"><button type="button" class="btn primary" id="continue" data-autofocus>${msg("account.continue")}</button></div>`,
  (el) => el.querySelector("#continue").addEventListener("click", () => { local.remove(TEAM_KEY); location.reload(); }));

  // The owner changed their own role or left the team (the members screen): their access
  // changed, so start again from /me. Leaving forgets the team, so another one opens.
  const changed = (text, left) => {
    if (left) local.remove(TEAM_KEY);
    show(`<h2>${msg("account.accessChangedTitle")}</h2>
    <p>${esc(text)}</p>
    <div class="actions"><button type="button" class="btn primary" id="continue" data-autofocus>${msg("account.continue")}</button></div>`,
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
      toast(msg("account.leaveFailed"), 5000);
      return;
    }
    db.stop();
    changed(msg("account.left", { team: team.name }), true);
  }

  // Which team: a switcher when there are several. Switching loads the page again for the
  // other team: new data, role and live updates.
  function drawSwitcher(el, teams, team) {
    el.innerHTML = teams.length > 1
      ? `<label for="teamSwitch">${msg("account.team")}</label><select id="teamSwitch">${teams.map((t) => `<option value="${esc(t.id)}"${t.id === team.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>`
      : `<span>${msg("account.teamLine", { team: esc(team.name) })}</span>`;
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
    bar.querySelector("#reopenBy").textContent = msg("account.tooCloseToReopen");
  }

  // Who is signed in, and their role in this team, on the team bar's Account button: their
  // name from the token, else their email, cut short with an ellipsis on a narrow screen. A
  // screen reader reads it all, as "Signed in as …".
  const ROLE_NAME = { owner: "account.roleOwner", contributor: "account.roleContributor", viewer: "account.roleViewer" };
  // With their photo, or their initials.
  const identity = (name, team, userId) => {
    const who = esc(visibleText(name)), role = msg(ROLE_NAME[team.role]);
    return `<button type="button" class="btn ghost whoami-chip" id="accountOpen" title="${who}" aria-label="${msg("account.chipLabel", { who, role })}">${avatarHTML(photoOf(userId), visibleText(name), 32, userId)}<span class="who-name">${who}</span><span class="who-role">${role}</span></button>`;
  };
  // A member's photo link, or null: none, or no photos (no team open, or an API without them)
  const photoOf = (userId) => (photos ? photos.url(userId) : null);

  // The team bar under the header: which team, a switcher, managing members and importing
  // inventory (owners; importing only while the team is open), leaving (everyone else), the
  // account, and Sign out. A closed team says when it will be deleted; its owners can reopen it.
  function teamBar(me, team, fr, who) {
    const bar = document.createElement("div");
    bar.className = "teambar";
    const owner = team.role === "owner";
    const reopenBy = owner && team.reopenBy ? `<span id="reopenBy">${msg("account.reopenBy", { date: esc(moment(team.reopenBy)) })}</span>` : "";
    const ended = !team.closedAt && team.subscriptionEnded;
    // The Customer Portal: owners of an open team that has a Stripe customer
    const billing = owner && !team.closedAt && team.billingAccount;
    // Invoices: owners of a team with a Stripe customer, closed or not, so a closed team's owners can save them
    // before it's deleted (the server refuses once the deletion is due)
    const invoices = owner && team.billingAccount;
    bar.innerHTML = `<span class="team-pick"></span><span class="spacer"></span>${unverified(me) ? `<button type="button" class="btn ghost" id="verifyEmail">${msg("account.verifyEmail")}</button>` : ""}${owner ? `<button type="button" class="btn ghost" id="members">${msg("account.members")}</button>${billing ? `<button type="button" class="btn ghost" id="manageBilling">${msg("account.billing")}</button>` : ""}${invoices ? `<button type="button" class="btn ghost" id="invoices">${msg("account.invoices")}</button>` : ""}${team.closedAt || ended ? "" : `<button type="button" class="btn ghost" id="importInventory">${msg("account.importCsv")}</button><button type="button" class="btn ghost" id="teamSettings">${msg("account.teamSettings")}</button>`}` : `<button type="button" class="btn ghost" id="leaveTeam">${msg("account.leaveTeam")}</button>`}${identity(who, team, me.user.id)}${helpLink()}<button type="button" class="btn ghost" id="reportIssue">${msg("account.reportIssue")}</button><button type="button" class="btn ghost" id="signOut">${msg("account.signOut")}</button>`
      + (team.closedAt ? `<p class="closed-note" role="status">${msg("account.closedNote", { closed: esc(day(team.closedAt)), deletes: esc(day(team.deletesAt)) })}${owner ? msg("account.closedExport") : ""}${reopenBy}</p>${owner ? `<button type="button" class="btn" id="reopenTeam">${msg("account.reopenTeam")}</button>` : ""}` : "")
      + (!team.closedAt && !ended && team.cancelsAt ? `<p class="closed-note" role="status" id="cancelNote">${msg("account.cancelNote", { date: esc(day(team.cancelsAt)) })}${msg(billing ? "account.cancelRenewOwner" : "account.cancelRenew")}</p>` : "")
      + (!team.closedAt && !ended && team.paymentGraceEndsAt ? `<p class="closed-note" role="status" id="graceNote">${msg("account.graceNote", { date: esc(moment(team.paymentGraceEndsAt)) })}${msg(owner ? "account.graceOwner" : "account.grace")}</p>` : "")
      + (ended ? endedNote(team, owner, billing) : "");
    box.after(bar);
    drawSwitcher(bar.querySelector(".team-pick"), me.teams, team);
    bar.querySelector("#signOut").addEventListener("click", signOut);
    bar.querySelector("#reportIssue").addEventListener("click", (e) => openReport(session.api, { teamId: team.id, role: team.role, opener: e.currentTarget }));
    wireHelp(bar);
    bar.querySelector("#accountOpen").addEventListener("click", () => account(me, who));
    // Verifying here needs nothing else to change: the team is open, and invites only matter
    // before one is. The button goes once it's done.
    const verify = bar.querySelector("#verifyEmail");
    if (verify) verify.addEventListener("click", () => openVerifyEmail(session, me.user.email, (fresh) => { me.user = fresh.user; verify.remove(); }));
    if (owner) {
      bar.querySelector("#members").addEventListener("click", () => openMembers(session.api, team, me.user.id, changed, invited(fr), photoOf));
      if (billing) bar.querySelector("#manageBilling").addEventListener("click", (e) => manageBilling(me, team, e.currentTarget));
      if (invoices) bar.querySelector("#invoices").addEventListener("click", () => openInvoices(session.api, team, (e) => needsTwoStep(me, e)));
      if (ended) {
        const subscribeButton = bar.querySelector("#subscribe"), pay = bar.querySelector("#payBilling");
        if (subscribeButton) subscribeButton.addEventListener("click", (e) => subscribe(me, team, e.currentTarget));
        if (pay) pay.addEventListener("click", (e) => manageBilling(me, team, e.currentTarget));
      }
      else if (!team.closedAt) {
        bar.querySelector("#importInventory").addEventListener("click", () => openImport(session.api, team.id, download));
        bar.querySelector("#teamSettings").addEventListener("click", () => openSettings(settingsFor(session.api, team)));
      }
      else {
        bar.querySelector("#reopenTeam").addEventListener("click", () => openReopen(session.api, team, changed));
        if (team.reopenBy) reopenWindow(bar, team);
      }
    } else {
      const leave = bar.querySelector("#leaveTeam");
      armButton(leave, msg("account.tapToLeave"), () => leaveTeam(me, team, leave));
    }
    return bar;
  }

  // Why a team that's read-only for billing is, what happens next, and what to do: everyone can
  // still see and export it; owners subscribe (a trial or subscription that ended, which is
  // deleted after readOnlyLastDay unless they do) or pay in Billing (a payment overdue, never
  // deleted for it); anyone else is told to ask an owner (the API doesn't tell them who).
  function endedNote(team, owner, billing) {
    const reason = endedReason(team);
    const overdue = reason === "payment_overdue";
    const why = msg({ subscription_ended: "account.whySubscriptionEnded", trial_ended: "account.whyTrialEnded", payment_overdue: "account.whyPaymentOverdue" }[reason]);
    const deletes = !overdue && team.readOnlyLastDay ? msg("account.willBeDeleted", { date: esc(lastDay(team.readOnlyLastDay)) }) : "";
    const todo = msg(overdue
      ? (owner ? "account.todoOverdueOwner" : "account.todoOverdue")
      : (owner ? "account.todoSubscribeOwner" : "account.todoSubscribe"));
    const action = !owner ? "" : overdue ? (billing ? `<button type="button" class="btn" id="payBilling">${msg("account.updatePayment")}</button>` : "") : `<button type="button" class="btn" id="subscribe">${msg("account.subscribe")}</button>`;
    return `<p class="closed-note" role="status" id="endedNote">${why} ${msg(owner ? "account.nothingDeletedOwner" : "account.nothingDeleted")}${deletes}${todo}</p>${action}`;
  }

  // An owner subscribes a team whose subscription ended: Stripe Checkout for the Starter plan,
  // monthly. The server sets the seats from the team's billed members (viewers are free) and
  // makes the page; a link to it replaces the button, so the owner goes to Stripe with one
  // more tap (and a retry gets the same page).
  let checkoutKey = null;
  // Billing refused this session as older than two-step sign-in (mfa_sign_in_again,
  // supply-checkout-8jc.14): sign out here and of Managed Login, whose session would
  // otherwise sign straight back in without the code, and sign in again. The team, drafts and
  // owner mark are kept for the same person.
  function signInAgain() {
    openModal(`<h2>${msg("account.signInAgainTitle")}</h2>
      <p>${msg("account.signInAgainBody")}</p>
      <div class="modal-actions"><button type="button" class="btn" id="signInAgainCancel">${msg("account.cancel")}</button> <button type="button" class="btn primary" id="signInAgainGo" data-autofocus>${msg("account.signInAgain")}</button></div>`, (m) => {
      m.querySelector("#signInAgainCancel").addEventListener("click", closeModal);
      m.querySelector("#signInAgainGo").addEventListener("click", (e) => signOut(e, true));
    });
  }
  // Billing refused for want of two-step sign-in: set it up, saying why
  const needsTwoStep = (me, e) => {
    if (e.reason === "mfa_sign_in_again") { signInAgain(); return true; }
    if (e.reason !== "mfa_required") return false;
    twoStep(me, { why: msg("account.needsTwoStep") });
    return true;
  };
  async function subscribe(me, team, button) {
    checkoutKey ||= crypto.randomUUID();
    button.disabled = true;
    try {
      const { checkout } = await session.api("POST", `/teams/${encodeURIComponent(team.id)}/billing/checkout`, { plan: "starter", interval: "month" }, { "Idempotency-Key": checkoutKey });
      const link = document.createElement("a");
      link.className = "btn primary";
      link.id = "checkoutLink";
      link.href = checkout.url;
      link.textContent = msg("account.checkout");
      button.replaceWith(link);
      link.focus();
    } catch (e) {
      button.disabled = false;
      if (needsTwoStep(me, e)) return;
      toast(msg(e.reason === "already_subscribed" ? "account.alreadySubscribed" : "account.checkoutFailed"), 5000);
    }
  }

  // An owner opens the Stripe Customer Portal: the server makes a session for the team's own
  // Stripe customer, and a link to it replaces the button, as for Checkout. A session soon
  // expires, so after PORTAL_LINK_MS the button comes back to make a new one.
  async function manageBilling(me, team, button) {
    button.disabled = true;
    try {
      const { portal } = await session.api("POST", `/teams/${encodeURIComponent(team.id)}/billing/portal`);
      const link = document.createElement("a");
      link.className = "btn primary";
      link.id = "billingLink";
      link.href = portal.url;
      link.textContent = msg("account.portal");
      button.disabled = false;
      button.replaceWith(link);
      link.focus();
      setTimeout(() => link.replaceWith(button), PORTAL_LINK_MS);
    } catch (e) {
      button.disabled = false;
      if (needsTwoStep(me, e)) return;
      toast(msg(e.reason === "no_billing_account" ? "account.noBillingAccount" : "account.portalFailed"), 5000);
    }
  }

  // The first-run checklist (src/first-run.js) for an owner's open team that has one it hasn't
  // finished or dismissed. Its progress is the team's, kept on the server (supply-checkout-fs56):
  // /me's `checklist`, which every new team starts with, and PATCH /teams/{teamId}/checklist
  // when a receipt is saved or it's finished or dismissed, so every owner sees the same one on
  // every device. The invite step ticks from the team: it has other members (/me's `members`),
  // or a pending invite. A checklist an earlier version kept only on this device (firstRunKey)
  // is started on the server, if the team has none, and then forgotten here.
  function firstRun(me, team) {
    if (team.role !== "owner" || team.closedAt || team.subscriptionEnded) return null;
    const path = `/teams/${encodeURIComponent(team.id)}/checklist`;
    const send = (change) => session.api("PATCH", path, change);
    const key = firstRunKey(team.id), kept = local.json(key);
    let checklist = team.checklist;
    if (kept && !checklist && !kept.done) {
      checklist = { receipt: kept.receipt === true, done: false };
      send({ started: true, ...(checklist.receipt ? { receipt: true } : {}) }).then(() => local.remove(key), () => {});
    } else if (kept) local.remove(key);
    if (!checklist || checklist.done) return null;
    const state = { receipt: checklist.receipt, invited: team.members > 1 };
    const fr = {
      state,
      // Each change is the server's to keep; one that doesn't save is shown on this page only
      save: (change) => { send(change).catch(() => {}); },
      // Set by the checklist, to redraw it
      onChange: () => {},
      invite: () => openMembers(session.api, team, me.user.id, changed, invited(fr), photoOf),
      importCsv: () => openImport(session.api, team.id, download),
    };
    // An invite another owner, or this one on another device, sent and nobody has accepted yet
    if (!state.invited) {
      session.api("GET", `/teams/${encodeURIComponent(team.id)}/invites`).then(({ invites }) => {
        if (invites.some((i) => i.inviteStatus === "pending")) invited(fr)();
      }, () => {});
    }
    return fr;
  }
  // What the members screen runs when an invite is sent: tick the checklist's step
  const invited = (fr) => () => { if (fr && !fr.state.invited) { fr.state.invited = true; fr.onChange(); } };

  function open(me, team) {
    // The session ended while the team was being chosen (a refresh found it over, or another
    // tab changed who's signed in): the sign-in screen, or a reload, has taken over
    const claims = session.claims();
    if (!claims) return until(() => {});
    local.set(TEAM_KEY, team.id);
    document.body.classList.remove("account-open");
    box.innerHTML = "";
    const fr = firstRun(me, team);
    // Who is signed in: their name, else their email (shown on the team bar, and as their profile)
    let name = nameOf(claims);
    // Asked for now, so the team bar and the projects have them as soon as they can
    if (me.user.photoUrl !== undefined) photos = createPhotos(session.api, team.id, me.user.id, me.user.photoUrl);
    let bar = teamBar(me, team, fr, name);
    // Drawn now, as the team opens, so it never moves anything under a finger later
    hideWhatsNew = showWhatsNew(session.api, me.user.preferences, bar);
    // /me was just loaded
    meAt = Date.now();
    let viewOnly = viewOnlyFor(team);
    // A write was refused because another owner closed the team meanwhile, or it became
    // read-only for billing: ask /me why (and when it will be deleted), and draw the team bar
    // again to match (its notice and actions, no Import CSV). The view-only notice waits for
    // it, and says to reload if /me couldn't say.
    let closing = null;
    const changedMeanwhile = (closed) => { closing = (async () => {
      viewOnly = closed ? closedMeanwhile() : endedMeanwhile();
      let teams;
      try { teams = (await session.api("GET", "/me")).teams; } catch { return; }
      const now = teams.find((t) => t.id === team.id);
      if (!now || !(closed ? now.closedAt : now.subscriptionEnded)) return;
      me.teams = teams;
      meAt = Date.now();
      Object.assign(team, now);
      const old = bar;
      bar = teamBar(me, team, fr, name);
      old.remove();
      viewOnly = viewOnlyFor(team);
    })(); };
    const profile = { id: me.user.id, name, isMe: true };
    // A name saved on Account: on the team bar's chip, and as their own profile from now on.
    // Nothing once the session has ended meanwhile (the sign-in screen has taken over)
    renamed = () => {
      const now = session.claims();
      if (!now) return;
      name = profile.name = nameOf(now);
      const chip = bar.querySelector("#accountOpen");
      chip.insertAdjacentHTML("afterend", identity(name, team, me.user.id));
      chip.remove();
      bar.querySelector("#accountOpen").addEventListener("click", () => account(me, name));
    };
    db = createDb({
      api: session.api, config, teamId: team.id, userId: me.user.id, token: session.token,
      onRemoved: () => removed(team),
      // A write refused because another owner closed the team meanwhile
      onClosed: () => changedMeanwhile(true),
      // One refused because the team became read-only for billing meanwhile
      onEnded: () => changedMeanwhile(false),
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
        // Why it's read-only, when that's because the team is closed or read-only for billing; null: the role says why
        viewOnlyNotice: async () => { await closing; return viewOnly; },
        // The signed-in user's own profile, and the name and photo of anyone else in the team
        // who has either (supply-checkout-w5x0); "" for no name shows as "Someone". The first draw
        // waits a moment for the list. A teammate whose photo's link is being asked for again is
        // still there, with a blank circle meanwhile, so the photo can take its place.
        profiles: async (ids) => {
          if (photos) await photos.ready();
          const known = (id) => id === me.user.id || (photos && (photos.has(id) || !!photos.name(id)));
          return Object.fromEntries([].concat(ids).filter(known).map((id) => [id, id === me.user.id ? { ...profile, avatarUrl: photoOf(id) } : { id, name: photos.name(id), avatarUrl: photoOf(id), isMe: false }]));
        },
      },
      downloads: { save: download },
      // Where src/main.js keeps this team's receipt draft
      // Read on every load and save: null once the session has ended (signed out, it expired,
      // or someone else signed in), so a save failing then can't write this user's draft back;
      // and once the owner mark isn't this user's, even before this tab has heard, so a save
      // finishing just before the storage event can't either
      drafts: { get key() { return session.token() && (!owner || local.get(OWNER_KEY) === owner) ? draftKey(team.id) : null; } },
      firstRun: fr,
      // The team settings (the equipment markup, ADR 0017): owners only, null for anyone else
      settings: settingsFor(session.api, team),
      // Receipt reading on Bedrock (ADR 0008); the app offers it only to those who can write
      sample: receiptsFor(session.api, team),
    };
  }

  // Signs in if needed, loads /me and picks a team. Anything that fails shows a screen
  // whose button runs it again; signing in leaves the page.
  for (;;) {
    show(`<p class="muted" role="status">${msg("account.loading")}</p>`);
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
