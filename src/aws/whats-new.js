// The What's New banner (supply-checkout-005.17): a short, plain-language summary of what
// changed in releases from the last WINDOW_DAYS, under the team bar when a team opens. The
// notes are curated per release in src/whats-new.json (docs/releases.md, "What's New notes"),
// never raw commit titles. It shows at most once a day per user, and only when there's
// something from the window they haven't been shown: /me's `user.preferences` say whether
// it's on and the local day it was last shown, and showing it records today
// (PATCH /me/preferences), so the same person on another device doesn't see it again
// today. Account turns it off and on again (the same preferences, so that follows them too).
//
// It never gets in the way: not a modal, it doesn't take the focus, it's drawn once as the
// team opens (so nothing moves under a finger mid-checkout, J4), and it's dismissed with one
// button. A screen reader hears one short polite announcement. An API from before the
// preferences shows nothing. Web build only, like the rest of src/aws/.
import notes from "../whats-new.json";
import { esc } from "../format.js";

export const WINDOW_DAYS = 14;
// How many notes the banner lists before "Show all"
const FIRST = 3;

const pad = (n) => String(n).padStart(2, "0");
// A date as YYYY-MM-DD in the reader's own time zone: what "today" means for once a day
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The YYYY-MM-DD `days` before another, counted on the calendar (noon UTC, clear of DST)
const daysBefore = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10);

// The notes from releases dated within the window up to today, newest release first (the
// file's order, which scripts/check-whats-new.mjs keeps)
export function recentNotes(today) {
  const from = daysBefore(today, WINDOW_DAYS - 1);
  return notes.releases
    .filter((r) => r.date >= from && r.date <= today)
    .flatMap((r) => r.notes.map((n) => ({ title: n.title, text: n.text, date: r.date })));
}

// Whether to show it today: it's on, it wasn't shown today, and something in the window is
// from the day it was last shown or later (a release that day may have come after it)
export function shouldShow(prefs, recent, today) {
  if (!prefs || !prefs.whatsNew || !recent.length || prefs.whatsNewLastShown === today) return false;
  return !prefs.whatsNewLastShown || recent.some((n) => n.date >= prefs.whatsNewLastShown);
}

// Draws the banner after `after` if it's due, and records that it was shown. `prefs` is
// /me's user.preferences, kept up to date here. Returns hide(), which takes it away (Account
// turning it off).
export function showWhatsNew(api, prefs, after) {
  const today = localDay();
  const recent = recentNotes(today);
  if (!shouldShow(prefs, recent, today)) return () => {};
  const item = (n) => `<li><strong>${esc(n.title)}</strong> <span>${esc(n.text)}</span></li>`;
  const banner = document.createElement("section");
  banner.className = "whats-new";
  banner.id = "whatsNew";
  banner.setAttribute("aria-labelledby", "whatsNewTitle");
  banner.innerHTML = `<div class="whats-new-head"><h2 id="whatsNewTitle">What's new</h2>
      <button type="button" class="btn ghost" id="whatsNewDismiss" aria-label="Dismiss What's new">Dismiss</button></div>
    <p class="sr-only" role="status">What's new in Supply Checkout from the last two weeks, below the team bar.</p>
    <ul class="whats-new-list">${recent.slice(0, FIRST).map(item).join("")}</ul>
    <details class="whats-new-more"><summary>Show all ${recent.length}</summary><ul class="whats-new-list">${recent.slice(FIRST).map(item).join("")}</ul></details>
    <p class="hint">Turn these off in Account.</p>`;
  // Nothing more to show: no "Show all"
  banner.querySelector(".whats-new-more").hidden = recent.length <= FIRST;
  after.after(banner);
  const hide = () => banner.remove();
  banner.querySelector("#whatsNewDismiss").addEventListener("click", () => {
    // The focus was on Dismiss: leave it on the Account button, where these are turned off
    hide();
    document.getElementById("accountOpen").focus();
  });
  // Shown today, on every device. If it isn't recorded, it may show again on the next load
  // today, which is better than saying nothing went wrong to someone who didn't ask
  prefs.whatsNewLastShown = today;
  api("PATCH", "/me/preferences", { whatsNewLastShown: today }).catch(() => {});
  return hide;
}

// Account's setting: a checkbox that turns the banner off and on, saved at once. `prefs` is
// /me's user.preferences; nothing from an API without them.
export function whatsNewSetting(prefs) {
  if (!prefs) return "";
  return `<h3>What's new</h3>
    <label class="check"><input type="checkbox" id="whatsNewOn"${prefs.whatsNew ? " checked" : ""}> Show what's new after an update, at most once a day</label>
    <p class="error" role="alert" id="whatsNewFail" hidden></p>`;
}

// Saves the checkbox as it changes; `onOff` runs once it's saved off (hiding the banner)
export function wireWhatsNewSetting(m, api, prefs, onOff) {
  const box = m.querySelector("#whatsNewOn");
  if (!box) return;
  const fail = m.querySelector("#whatsNewFail");
  box.addEventListener("change", async () => {
    const on = box.checked;
    box.disabled = true;
    fail.hidden = true;
    try {
      const { preferences } = await api("PATCH", "/me/preferences", { whatsNew: on });
      Object.assign(prefs, preferences);
      if (!on) onOff();
    } catch {
      box.checked = !on;
      fail.textContent = "Couldn't save that. Check your connection and try again.";
      fail.hidden = false;
    }
    box.disabled = false;
  });
}
