// The app's transactional email: an invite, and the billing and account
// notices (including a team's closure and reopening, to every owner). Each renders to a subject, an HTML body and a plain-text body.
//
// Built for the mail clients people actually use (Gmail, Outlook including
// Word-rendered desktop Outlook, iOS Mail):
//
// - Layout tables with role="presentation", a 600px column, inline styles
//   only (no <style> block, classes, flexbox, grid, web fonts or images), and
//   a button made of a table cell with bgcolor, which Outlook draws.
// - A hidden preheader for the inbox preview line.
// - A plain-text part with every link written out, for clients and people
//   that don't show HTML.
//
// Everything that comes from a user (a team name) is escaped for HTML and has
// control characters removed, and links must be on the app's own origin, so a
// team name can't add markup or a link of its own. Link-like text in a team
// name is defanged too (teamLabel), and an invite quotes the name, so a
// name can't pose as an instruction from us.

import type { EmailKind } from "./names.js";

export type InviteRole = "owner" | "contributor" | "viewer";

export type EmailInput =
  | {
      readonly kind: "invite";
      readonly teamName: string;
      readonly role: InviteRole;
      readonly inviteId: string;
      /** The one-time token for the link. Never stored or logged. */
      readonly token: string;
      /** When the invite expires: epoch seconds, as on the invite item. */
      readonly expiresAt: number;
    }
  | { readonly kind: "trialEnding"; readonly teamName: string; readonly trialEndsAt: string }
  | { readonly kind: "paymentFailed"; readonly teamName: string; readonly nextAttemptAt?: string }
  | { readonly kind: "readOnly"; readonly teamName: string }
  | { readonly kind: "exportReady"; readonly teamName: string; readonly exportId: string; readonly expiresAt: string }
  | {
      readonly kind: "teamClosed";
      readonly teamName: string;
      /** When the purge deletes the team: the team item's purgeAfter (ISO 8601). */
      readonly purgeAfter: string;
    }
  | { readonly kind: "teamReopened"; readonly teamName: string };

export interface RenderedEmail {
  readonly kind: EmailKind;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface RenderOptions {
  /** `https://app.<env domain>`: every link in the message starts with it. */
  readonly appUrl: string;
}

const ROLE_PHRASE: Record<InviteRole, string> = { owner: "an owner", contributor: "a contributor", viewer: "a viewer" };
const ROLE_WHAT: Record<InviteRole, string> = {
  owner: "Owners manage the team, its members and billing, and can edit everything.",
  contributor: "Contributors check supplies out and back in, and edit sheets and inventory.",
  viewer: "Viewers can see the team's sheets and inventory, but not change them.",
};

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** A user-supplied name, safe for a subject line or a text body: one line, bounded. */
export function plainName(value: string, max = 80): string {
  const flat = String(value).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat || "your team";
}

// Something a mail client might turn into a link: a scheme (https://, mailto:),
// www., an address, or a dotted name ending in a TLD-like label (acme.com).
const LINKISH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]*|\b(?:mailto|tel|sms|javascript|data):[^\s]*|\bwww\.[^\s]*|[^\s@]+@[^\s@]+|\b[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.\p{L}{2,}\b/giu;

/**
 * A team name as a message shows it: one line, bounded, and with anything
 * that looks like a link or an address defanged ("evil.example" becomes
 * "evil[.]example", "https://" becomes "https[:]//"), so mail clients don't
 * link it. Team names are chosen by whoever made the team, and an invite
 * goes to someone who isn't in it yet: a name like "Payroll - verify at
 * evil.example" mustn't read as ours.
 */
export function teamLabel(value: string): string {
  return plainName(value).replace(LINKISH, (token) => token.replaceAll(".", "[.]").replaceAll(":", "[:]").replaceAll("@", "[at]"));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** A link on the app's origin, or an error: messages never link anywhere else. */
function appLink(appUrl: string, path: string, query: Record<string, string> = {}): string {
  const base = new URL(appUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost") throw new Error("The app URL must be https");
  const url = new URL(path, base.origin);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (url.origin !== base.origin) throw new Error("Links must stay on the app's origin");
  return url.toString();
}

/** A date for people: "October 3, 2026", in UTC so it doesn't depend on where the Lambda runs. */
export function formatDate(value: string | number): string {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
}

interface Content {
  readonly subject: string;
  /** The inbox preview line. */
  readonly preheader: string;
  readonly heading: string;
  /** Plain-text paragraphs; they're escaped for the HTML part. */
  readonly paragraphs: readonly string[];
  readonly button: { readonly label: string; readonly url: string };
  /** A closing line under the button, e.g. when a link expires. */
  readonly note?: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#1f2933";
const MUTED = "#52606d";
const ACCENT = "#1d5fbf";

function html(c: Content): string {
  const p = (text: string) => `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${INK};">${escapeHtml(text)}</p>`;
  const url = escapeHtml(c.button.url);
  return [
    "<!DOCTYPE html>",
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(c.subject)}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#f5f7fa;">',
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f5f7fa;">${escapeHtml(c.preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f7fa;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:8px;">',
    `<tr><td style="padding:24px 32px 0 32px;font-family:${FONT};font-size:14px;font-weight:bold;color:${ACCENT};">Supply Checkout</td></tr>`,
    '<tr><td style="padding:16px 32px 8px 32px;">',
    `<h1 style="margin:0 0 16px 0;font-family:${FONT};font-size:22px;line-height:30px;font-weight:bold;color:${INK};">${escapeHtml(c.heading)}</h1>`,
    ...c.paragraphs.map(p),
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;">',
    `<tr><td align="center" bgcolor="${ACCENT}" style="border-radius:6px;background-color:${ACCENT};">`,
    `<a href="${url}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:16px;font-weight:bold;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(c.button.label)}</a>`,
    "</td></tr></table>",
    `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">If the button doesn't work, copy this link into your browser:<br><a href="${url}" target="_blank" style="color:${ACCENT};word-break:break-all;">${url}</a></p>`,
    ...(c.note ? [`<p style="margin:0 0 16px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(c.note)}</p>`] : []),
    "</td></tr>",
    `<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e4e7eb;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">You're getting this email because of your Supply Checkout account or an invitation to a team. It was sent from an address that doesn't take replies.</td></tr>`,
    "</table>",
    "</td></tr></table>",
    "</body>",
    "</html>",
  ].join("\n");
}

function text(c: Content): string {
  return [
    c.heading,
    "",
    ...c.paragraphs.flatMap((para) => [para, ""]),
    `${c.button.label}: ${c.button.url}`,
    "",
    ...(c.note ? [c.note, ""] : []),
    "--",
    "Supply Checkout",
    "You're getting this email because of your Supply Checkout account or an invitation to a team. It was sent from an address that doesn't take replies.",
    "",
  ].join("\n");
}

function content(input: EmailInput, appUrl: string): Content {
  const team = teamLabel(input.teamName);
  switch (input.kind) {
    case "invite": {
      const expires = formatDate(input.expiresAt);
      // Quoted, so the name reads as a name the team chose, not as our words
      const quoted = `“${team}”`;
      return {
        subject: `You're invited to join the team ${quoted} on Supply Checkout`,
        preheader: `Join ${quoted} as ${ROLE_PHRASE[input.role]}. The invite expires on ${expires}.`,
        heading: `Join the team ${quoted} on Supply Checkout`,
        paragraphs: [
          `You've been invited to join the team ${quoted} as ${ROLE_PHRASE[input.role]}. ${ROLE_WHAT[input.role]}`,
          "Sign in or create an account with this email address, and you'll join the team.",
        ],
        button: { label: "Accept the invite", url: appLink(appUrl, "/", { invite: input.inviteId, token: input.token }) },
        note: `This invite expires on ${expires} and works once. If you weren't expecting it, you can ignore this email.`,
      };
    }
    case "trialEnding": {
      const ends = formatDate(input.trialEndsAt);
      return {
        subject: `Your Supply Checkout trial for ${team} ends on ${ends}`,
        preheader: `Add a payment method to keep editing ${team}'s sheets and inventory.`,
        heading: "Your free trial is ending",
        paragraphs: [
          `The free trial for ${team} ends on ${ends}.`,
          "To keep checking supplies out and editing sheets, an owner can add a payment method in the app. After the trial, the team stays readable, and nothing is deleted.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
    }
    case "paymentFailed": {
      const retry = input.nextAttemptAt ? ` We'll try again on ${formatDate(input.nextAttemptAt)}.` : "";
      return {
        subject: `Payment failed for ${team} on Supply Checkout`,
        preheader: `Update the payment method for ${team} to keep your subscription.`,
        heading: "We couldn't take your payment",
        paragraphs: [
          `The latest payment for ${team}'s Supply Checkout subscription didn't go through.${retry}`,
          "An owner can update the payment method in the app. If payments keep failing, the team becomes read-only until the subscription is paid.",
        ],
        button: { label: "Update payment method", url: appLink(appUrl, "/") },
      };
    }
    case "readOnly":
      return {
        subject: `${team} is now read-only on Supply Checkout`,
        preheader: `Your team's data is safe. Subscribe to edit again.`,
        heading: `${team} is read-only`,
        paragraphs: [
          `${team} no longer has an active subscription, so its sheets and inventory are read-only. Nothing has been deleted: everyone on the team can still see it, and owners can still export it.`,
          "An owner can subscribe in the app to start editing again.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
    case "exportReady": {
      const expires = formatDate(input.expiresAt);
      return {
        subject: `Your Supply Checkout export for ${team} is ready`,
        preheader: `Download ${team}'s sheets and inventory before ${expires}.`,
        heading: "Your export is ready",
        paragraphs: [`The export of ${team}'s sheets and inventory is ready to download.`, "Sign in to download it. Only the team's owners can."],
        button: { label: "Download the export", url: appLink(appUrl, "/", { export: input.exportId }) },
        note: `The download is available until ${expires}.`,
      };
    }
    case "teamClosed": {
      const purge = formatDate(input.purgeAfter);
      return {
        subject: `${team} was closed on Supply Checkout`,
        preheader: `It will be deleted for good on ${purge}.`,
        heading: `${team} was closed`,
        paragraphs: [
          `An owner of ${team} closed the team. It's read-only now: its members can still see its sheets and inventory, but nobody can change them or join it, and its invites were cancelled.`,
          `On ${purge}, the team, its sheets and its inventory will be deleted for good. Until then, owners can export its data, or reopen the team, in the app.`,
          "You're getting this because you're an owner of the team. If you didn't expect it to close, check with its other owners, and make sure nobody else can sign in to your account.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
    }
    case "teamReopened":
      return {
        subject: `${team} was reopened on Supply Checkout`,
        preheader: "It won't be deleted, and its members can change it again.",
        heading: `${team} was reopened`,
        paragraphs: [
          `An owner of ${team} reopened the team, so it won't be deleted. Its members can change its sheets and inventory again.`,
          "Invites that were cancelled when it closed stay cancelled, and anyone who left or was removed while it was closed isn't back. Owners can invite them again in the app.",
          "You're getting this because you're an owner of the team. If you didn't expect it to reopen, check with its other owners, and make sure nobody else can sign in to your account.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
  }
}

/** Renders one message. Throws on a bad date or a link off the app's origin. */
export function renderEmail(input: EmailInput, options: RenderOptions): RenderedEmail {
  const c = content(input, options.appUrl);
  return { kind: input.kind, subject: c.subject, html: html(c), text: text(c) };
}
