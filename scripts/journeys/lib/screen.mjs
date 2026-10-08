// What a page showed when a step couldn't go on, for the error a prod journey test fails with.
// The Actions log is public, so it carries only the page's path (no query: Managed Login's
// carries the OAuth state), its headings, alerts, field labels and the names of its controls,
// never a field's value, and all of it redacted.

const MAX_ITEMS = 12;
const MAX_TEXT = 80;

const clean = (text, redact) => {
  const one = redact(String(text ?? "").replace(/\s+/g, " ").trim());
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
};
const list = (items, redact) => {
  const seen = [...new Set((items ?? []).map((t) => clean(t, redact)).filter(Boolean))];
  const shown = seen.slice(0, MAX_ITEMS).map((t) => JSON.stringify(t)).join(", ");
  return seen.length > MAX_ITEMS ? `${shown}, and ${seen.length - MAX_ITEMS} more` : shown || "none";
};
const pathOf = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return "(no URL)"; } };

/**
 * One line describing a screen: `{ url, headings, alerts, fields, controls }` as read by
 * readScreen (tests/prod/fixtures.mjs), each text passed through `redact`.
 */
export function formatScreen(screen, redact = (s) => s) {
  const s = screen ?? {};
  return [
    `page ${redact(pathOf(s.url))}`,
    `headings ${list(s.headings, redact)}`,
    `alerts ${list(s.alerts, redact)}`,
    `fields ${list(s.fields, redact)}`,
    `controls ${list(s.controls, redact)}`,
  ].join("; ");
}

/**
 * The names of a control that signs in with the password: exactly "Password", "Use (a|your)
 * password" or "Sign in with (a|your) password" (Playwright trims and collapses an accessible
 * name before matching). Never "Email one-time password", "Show password" or "Forgot your
 * password?": Managed Login's "Choose a sign-in method" offers the email code first, already
 * selected, and a looser match picked it.
 */
export const PASSWORD_CHOICE = /^(password|use (a |your )?password|sign in with (a |your )?password)$/i;

/** Whether a control's accessible name is a way to sign in with the password (PASSWORD_CHOICE). */
export const isPasswordChoice = (name) => PASSWORD_CHOICE.test(String(name ?? "").replace(/\s+/g, " ").trim());
