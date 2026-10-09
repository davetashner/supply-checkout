// The app's transactional email: an invite, and the billing and account
// notices (including a team's closure and reopening, to every owner, and the
// security notices to the account's own verified address when a password is
// set or two-step sign-in is turned on, and to its previous address when its
// email changes), and the welcome email a new account gets once
// (supply-checkout-6uw.25). Each renders to a subject, an HTML body and a
// plain-text body.
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
// Everything that comes from a user (a team name, a given name) is escaped for HTML and has
// control characters removed, and links must be on the app's own origin, so a
// team name can't add markup or a link of its own. Link-like text in a team
// name is defanged too (teamLabel), and an invite quotes the name, so a
// name can't pose as an instruction from us.

import { deletionLastDay, PAYMENT_GRACE_DAYS as GRACE_DAYS, READ_ONLY_RETENTION_DAYS as READ_ONLY_DAYS, type ReadOnlyReason, TRIAL_DAYS } from "../data/index.js";
import type { EmailKind } from "./names.js";
import { withoutHiddenCharacters } from "../text/hidden-characters.js";

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
  | {
      readonly kind: "readOnly";
      readonly teamName: string;
      /** Why (billingAccess): the subscription ended (the default), the trial ended without one, or a payment is overdue past the grace period. */
      readonly reason?: ReadOnlyReason;
      /** When the team is deleted unless an owner subscribes (ISO 8601, a deletionTime), if it will be. The email states its deletionLastDay. */
      readonly deletesAt?: string;
    }
  | { readonly kind: "exportReady"; readonly teamName: string; readonly exportId: string; readonly expiresAt: string }
  | {
      readonly kind: "teamClosed";
      readonly teamName: string;
      /** When the purge deletes the team: the team item's purgeAfter (ISO 8601). */
      readonly purgeAfter: string;
    }
  | { readonly kind: "teamReopened"; readonly teamName: string }
  /**
   * A team read-only because its trial or subscription ended will be deleted
   * at `deletesAt` (ISO 8601, a deletionTime) unless an owner subscribes (the
   * lapsed-team job, supply-checkout-qdx): after the date it states
   * (deletionLastDay) has ended everywhere. Sent at least 7 days before.
   */
  | { readonly kind: "deletionWarning"; readonly teamName: string; readonly deletesAt: string }
  /**
   * Security notices to the account's own verified address (supply-checkout-8jc.15): a
   * password was set or changed, or two-step sign-in (an authenticator app) was turned on;
   * and, to the address the account had before, that its email changed (supply-checkout-8jc.29).
   * `at` is when (ISO 8601). No team: they're about the account. Never the new address.
   */
  | { readonly kind: "passwordSet"; readonly at: string }
  | { readonly kind: "twoStepOn"; readonly at: string }
  | { readonly kind: "emailChanged"; readonly at: string }
  /**
   * The password was reset with a code sent to the account's address
   * (Cognito's ConfirmForgotPassword, from the app or Managed Login,
   * supply-checkout-6uw.32). `signedOut`: the account was signed out
   * everywhere (AdminUserGlobalSignOut), which the message says only if so.
   * That revokes refresh tokens only: an access token stays valid for up to
   * an hour, and so may a Managed Login session, so the message says so.
   */
  | { readonly kind: "passwordReset"; readonly at: string; readonly signedOut: boolean }
  /**
   * The welcome email, once per new account, to its verified address
   * (supply-checkout-6uw.25). `givenName` is the account's own (Cognito's
   * given_name, from sign-up or Google or Apple), if it has one. `invited`: a
   * live invite is waiting for the address, or the account is in a team
   * already, so the next step is that team rather than a new one.
   * `supportAddress` is `support@<env domain>`.
   */
  | { readonly kind: "welcome"; readonly givenName?: string; readonly invited: boolean; readonly supportAddress: string }
  /**
   * Someone asked in the app to reset the password for an address that only a
   * Google or Apple account has (supply-checkout-6uw.26): there's no password,
   * so sign in with that provider. Sent only to that address, which the pool
   * knows and the provider verified. Nothing in it comes from the request but
   * the recipient.
   */
  | { readonly kind: "passwordResetProvider"; readonly signInWith: "Google" | "SignInWithApple"; readonly supportAddress: string };

/** The security notices, to an account's own address rather than a team's owners. */
export type SecurityNotice = Extract<EmailInput, { kind: "passwordSet" | "twoStepOn" | "emailChanged" | "passwordReset" }>;

/** The welcome email (welcomeContent). */
export type WelcomeEmail = Extract<EmailInput, { kind: "welcome" }>;

/** The hint for a password reset asked for a Google or Apple account's address (resetProviderContent). */
export type ResetProviderEmail = Extract<EmailInput, { kind: "passwordResetProvider" }>;

/** A notice about a team, to its owners: every kind but an invite, the security notices, the welcome email and the password reset hint. */
export type TeamNoticeInput = Exclude<EmailInput, { kind: "invite" } | SecurityNotice | WelcomeEmail | ResetProviderEmail>;

export interface RenderedEmail {
  readonly kind: EmailKind;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface RenderOptions {
  /** `https://app.<env domain>`: every link in the message starts with it. */
  readonly appUrl: string;
  /** `support@<env domain>`, which every security notice names (supply-checkout-3sv.12). A security notice won't render without it. */
  readonly supportAddress?: string;
}

const ROLE_PHRASE: Record<InviteRole, string> = { owner: "an owner", contributor: "a contributor", viewer: "a viewer" };
const ROLE_WHAT: Record<InviteRole, string> = {
  owner: "Owners manage the team, its members and billing, and can edit everything.",
  contributor: "Contributors check supplies out and back in, and edit projects and inventory.",
  viewer: "Viewers can see the team's projects and inventory, but not change them.",
};

/** A user-supplied name, safe for a subject line or a text body: one line, bounded. */
export function plainName(value: string, max = 80): string {
  // Without control and invisible characters (src/text/hidden-characters.ts): bidi controls could
  // reorder a subject line. Cut to a few times the limit first, so only that much is scanned.
  const flat = withoutHiddenCharacters(String(value).slice(0, 4 * max)).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${withoutHiddenCharacters(flat.slice(0, max - 1)).trimEnd()}…` : flat || "your team";
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

/** A time for people: "October 3, 2026 at 23:30 UTC". */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(date);
  return `${formatDate(value)} at ${time} UTC`;
}

/** A bare address with no spaces, quotes or angle brackets: the support address as the welcome email and the security notices show it. */
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * What a security notice says to do if the change wasn't the account's owner
 * (supply-checkout-3sv.12): the same recovery path in every kind, in order.
 * It links nowhere but the app, and asks for nothing: a message like this is
 * what a phisher copies. The last step names the support address, says what
 * support will do (confirm it's their account first, then sign it out, and
 * help reset the password and two-step sign-in), and what support never asks.
 */
const IF_NOT_YOU: Record<SecurityNotice["kind"], string> = {
  passwordSet: "If it wasn't you, someone else may be able to sign in to your account. Act now:",
  twoStepOn:
    "If it wasn't you, someone else may be able to sign in to your account, and may have turned this on to keep you out. Act now:",
  passwordReset: "If it wasn't you, someone who can read this mailbox may have reset it. Act now:",
  emailChanged:
    "If it wasn't you, someone else may have taken over your account: sign-in codes and password resets now go to their address, so you can't reset your password yourself. Act now:",
};

/** First, the mailbox: every reset code goes to it. */
const SECURE_MAILBOX = "1. Secure this email account: change its password, and check that nobody has added a forwarding rule or a recovery address you don't know.";

/** Then the Supply Checkout password, with a code sent to that mailbox (not after an email change: codes go to the new address). */
const RESET_PASSWORD =
  "2. Reset your Supply Checkout password: on the sign-in page, choose to reset it and enter the code we send to this address. Then check that the email address on your account is still yours, and tell the other owners of your teams.";

/** After an email change, support is the only way back. */
const EMAIL_CHANGED_STEP = "2. Tell the other owners of your teams.";

/** The last step: write to support, from this address. */
function contactSupport(supportAddress: string, step: number, kind: SecurityNotice["kind"]): string {
  const stuck =
    kind === "emailChanged"
      ? ""
      : " If you can't sign in, for example because it asks for a code from an authenticator app that isn't yours, support can get you back in.";
  return `${step}. Write to Supply Checkout support at ${supportAddress} from this address, and say what you noticed.${stuck}`;
}

/** What support will do, and never ask: the last line of every security notice. */
const SUPPORT_WILL =
  "We'll confirm that the account is yours before we change anything, then sign it out everywhere and help you reset its password, email address and two-step sign-in. We'll never ask you for your password or a sign-in code.";

/** The recovery path as paragraphs: the opening line, the steps, and what support will do. */
function recoveryPath(kind: SecurityNotice["kind"], supportAddress: string): string[] {
  if (!PLAIN_ADDRESS.test(supportAddress)) throw new Error("Invalid support address");
  const steps = kind === "emailChanged" ? [SECURE_MAILBOX, EMAIL_CHANGED_STEP] : [SECURE_MAILBOX, RESET_PASSWORD];
  return [IF_NOT_YOU[kind], ...steps, contactSupport(supportAddress, steps.length + 1, kind), SUPPORT_WILL];
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
  /** Why the recipient is getting it, when that isn't their account or an invitation (FOOTER). */
  readonly footer?: string;
}

/** Why someone is getting the app's email, at the foot of every message unless it says otherwise. */
const FOOTER = "You're getting this email because of your Supply Checkout account or an invitation to a team. It was sent from an address that doesn't take replies.";

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
    `<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e4e7eb;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(c.footer ?? FOOTER)}</td></tr>`,
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
    c.footer ?? FOOTER,
    "",
  ].join("\n");
}

function content(input: EmailInput, options: RenderOptions): Content {
  const { appUrl } = options;
  if (input.kind === "passwordSet" || input.kind === "twoStepOn" || input.kind === "emailChanged" || input.kind === "passwordReset") return securityContent(input, appUrl, options.supportAddress ?? "");
  if (input.kind === "welcome") return welcomeContent(input, appUrl);
  if (input.kind === "passwordResetProvider") return resetProviderContent(input, appUrl);
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
        preheader: `Add a payment method to keep editing ${team}'s projects and inventory.`,
        heading: "Your free trial is ending",
        paragraphs: [
          `The free trial for ${team} ends on ${ends}.`,
          "To keep checking supplies out and editing projects, an owner can choose a plan and add a payment method in the app.",
          `If there's no plan when the trial ends, ${team} becomes read-only: everyone on the team can still see it, and owners can export it, for ${READ_ONLY_DAYS} days. After that, the team and everything in it are deleted.`,
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
          `An owner can update the payment method in the app, from Billing. The team keeps working for ${GRACE_DAYS} days while we try again. If the payment still hasn't gone through by then, the team becomes read-only until the subscription is paid.`,
        ],
        button: { label: "Update payment method", url: appLink(appUrl, "/") },
      };
    }
    case "readOnly": {
      // The last day it's kept: deleted only once that date has ended everywhere
      const deletes = input.deletesAt ? formatDate(deletionLastDay(input.deletesAt)) : undefined;
      if (input.reason === "payment_overdue") {
        return {
          subject: `${team} is now read-only on Supply Checkout`,
          preheader: "The payment is still overdue. Update the payment method to edit again.",
          heading: `${team} is read-only`,
          paragraphs: [
            `The payment for ${team}'s Supply Checkout subscription is still overdue, so its projects and inventory are read-only until it's paid. Nothing has been deleted: everyone on the team can still see it, and owners can still export it.`,
            "An owner can update the payment method in the app, from Billing, to start editing again.",
          ],
          button: { label: "Update payment method", url: appLink(appUrl, "/") },
        };
      }
      const why = input.reason === "trial_ended" ? `The free trial for ${team} has ended without a plan` : `${team} no longer has an active subscription`;
      return {
        subject: `${team} is now read-only on Supply Checkout`,
        preheader: deletes ? `Subscribe by ${deletes} to keep your team's data.` : "Your team's data is safe. Subscribe to edit again.",
        heading: `${team} is read-only`,
        paragraphs: [
          `${why}, so its projects and inventory are read-only. Nothing has been deleted yet: everyone on the team can still see it, and owners can still export it.`,
          ...(deletes ? [`After ${deletes}, ${team} and everything in it will be deleted, unless an owner subscribes by then.`] : []),
          "An owner can subscribe in the app to start editing again.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
    }
    case "exportReady": {
      const expires = formatDate(input.expiresAt);
      return {
        subject: `Your Supply Checkout export for ${team} is ready`,
        preheader: `Download ${team}'s projects and inventory before ${expires}.`,
        heading: "Your export is ready",
        paragraphs: [`The export of ${team}'s projects and inventory is ready to download.`, "Sign in to download it. Only the team's owners can."],
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
          `An owner of ${team} closed the team. It's read-only now: its members can still see its projects and inventory, but nobody can change them or join it, and its invites were cancelled.`,
          `On ${purge}, the team, its projects and its inventory will be deleted for good. Until then, owners can export its data, or reopen the team, in the app.`,
          "You're getting this because you're an owner of the team. If you didn't expect it to close, check with its other owners, and make sure nobody else can sign in to your account.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
    }
    case "deletionWarning": {
      const deletes = formatDate(deletionLastDay(input.deletesAt));
      return {
        subject: `${team} will be deleted after ${deletes}`,
        preheader: `Subscribe or export your data by ${deletes}.`,
        heading: `${team} will be deleted after ${deletes}`,
        paragraphs: [
          `${team} has been read-only since its free trial or subscription ended. After ${deletes}, the team, its projects and its inventory will be deleted for good, and this can't be undone.`,
          `To keep the team, an owner can subscribe in the app by ${deletes}. To keep a copy instead, an owner can use Export data.`,
          "You're getting this because you're an owner of the team.",
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
          `An owner of ${team} reopened the team, so it won't be deleted. Its members can change its projects and inventory again.`,
          "Invites that were cancelled when it closed stay cancelled, and anyone who left or was removed while it was closed isn't back. Owners can invite them again in the app.",
          // Sent as the team reopens, before the billing worker resyncs its subscription (billing/reopening.ts), so it can't know the outcome.
          // The resume can fail or be left for a person, so this points owners at the app's note ("To keep it, renew it from Billing")
          "If closing the team set its subscription to end, we'll set it to renew again. If the app still says the subscription will end, an owner can renew it from Billing. If its subscription had already ended, an owner can subscribe again in the app.",
          "You're getting this because you're an owner of the team. If you didn't expect it to reopen, check with its other owners, and make sure nobody else can sign in to your account.",
        ],
        button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
      };
  }
}

/** A security notice: what changed on the account, when, and what to do if it wasn't them (recoveryPath). */
function securityContent(input: SecurityNotice, appUrl: string, supportAddress: string): Content {
  const when = formatDateTime(input.at);
  const notYou = recoveryPath(input.kind, supportAddress);
  const button = { label: "Open Supply Checkout", url: appLink(appUrl, "/") };
  if (input.kind === "passwordSet") {
    return {
      subject: "A password was set on your Supply Checkout account",
      preheader: `Your password was set or changed on ${when}.`,
      heading: "Your password was set",
      paragraphs: [`A new password was set on your Supply Checkout account on ${when}.`, "If this was you, you don't need to do anything.", ...notYou],
      button,
    };
  }
  if (input.kind === "passwordReset") {
    return {
      subject: "Your Supply Checkout password was reset",
      preheader: `Your password was reset on ${when}.`,
      heading: "Your password was reset",
      paragraphs: [
        `The password on your Supply Checkout account was reset on ${when}, with a code sent to this address.${input.signedOut ? " Devices that were signed in were signed out, though a session may keep working for up to an hour." : ""}`,
        "If this was you, you don't need to do anything.",
        ...notYou,
      ],
      button,
    };
  }
  if (input.kind === "emailChanged") {
    return {
      subject: "The email address on your Supply Checkout account was changed",
      preheader: `Your account's email address was changed on ${when}.`,
      heading: "Your email address was changed",
      paragraphs: [
        `The email address on your Supply Checkout account was changed on ${when}. We're writing to this address, the address the account had before, so you know. Account email and sign-in codes now go to the new address.`,
        "If this was you, you don't need to do anything.",
        ...notYou,
      ],
      button,
    };
  }
  return {
    subject: "Two-step sign-in was turned on for your Supply Checkout account",
    preheader: `An authenticator app was added on ${when}.`,
    heading: "Two-step sign-in is on",
    paragraphs: [
      `Two-step sign-in was turned on for your Supply Checkout account on ${when}: signing in now takes your password and a code from an authenticator app. The account was signed out everywhere.`,
      "If this was you, you don't need to do anything.",
      ...notYou,
    ],
    button,
  };
}

/**
 * Someone's given name as a greeting shows it: one line, at most 40
 * characters, with anything link-like defanged (as teamLabel does), so a name
 * can't add a link of its own. Undefined when there's nothing left.
 */
export function greetingName(value: string | undefined): string | undefined {
  if (value === undefined || !withoutHiddenCharacters(value.slice(0, 160)).trim()) return undefined;
  return plainName(value, 40).replace(LINKISH, (token) => token.replaceAll(".", "[.]").replaceAll(":", "[:]").replaceAll("@", "[at]"));
}

/** What a new team comes with (docs/journeys.md, J1). */
const TRIAL = `A new team comes with a ${TRIAL_DAYS}-day free trial, and you don't need a card to start it.`;

/**
 * The welcome email: who it's for, the app, the next step (a new team and its
 * trial; or, for someone invited, that team) and the support address. It asks
 * for nothing and links only to the app. Transactional: no tracking, nothing
 * to unsubscribe from.
 */
function welcomeContent(input: WelcomeEmail, appUrl: string): Content {
  if (!PLAIN_ADDRESS.test(input.supportAddress)) throw new Error("Invalid support address");
  const name = greetingName(input.givenName);
  const greeting = name ? `Hi ${name},` : "Hi there,";
  const ready = "Your Supply Checkout account is ready. Sign in any time with this email address.";
  const questions = `Questions? Write to us at ${input.supportAddress}.`;
  const url = appLink(appUrl, "/");
  if (input.invited) {
    return {
      subject: "Welcome to Supply Checkout",
      preheader: "Your account is ready. Open Supply Checkout to join your team.",
      heading: "Welcome to Supply Checkout",
      paragraphs: [
        greeting,
        ready,
        "You've been invited to a team. Open Supply Checkout and accept the invite, if you haven't already, to see the team's projects and inventory.",
        `Want a team of your own too? You can create one in the app. ${TRIAL}`,
        questions,
      ],
      button: { label: "Open Supply Checkout", url },
    };
  }
  return {
    subject: "Welcome to Supply Checkout",
    preheader: `Your account is ready. Create your team and try it free for ${TRIAL_DAYS} days.`,
    heading: "Welcome to Supply Checkout",
    paragraphs: [
      greeting,
      ready,
      `Next, create your team: give it a name, then add your supplies and invite your crew. ${TRIAL}`,
      "If someone invites you to their team, you'll find the invite in the app too.",
      questions,
    ],
    button: { label: "Create your team", url },
  };
}

const PROVIDER_NAMES = { Google: "Google", SignInWithApple: "Apple" } as const;

/**
 * The hint for a password reset asked for a Google or Apple account's address
 * (supply-checkout-6uw.26): it has no password, so sign in with the provider.
 * It asks for nothing and links only to the app, like the welcome email.
 */
function resetProviderContent(input: ResetProviderEmail, appUrl: string): Content {
  if (!PLAIN_ADDRESS.test(input.supportAddress)) throw new Error("Invalid support address");
  const provider = PROVIDER_NAMES[input.signInWith];
  if (!provider) throw new Error("Invalid provider");
  return {
    subject: `Sign in to Supply Checkout with ${provider}`,
    preheader: `This address signs in with ${provider}, so there's no password to reset.`,
    heading: `Sign in with ${provider}`,
    paragraphs: [
      `Someone, probably you, asked to reset the Supply Checkout password for this email address. This address signs in to Supply Checkout with ${provider}, so it has no Supply Checkout password to reset, and we haven't sent a reset code.`,
      `To sign in, open Supply Checkout, choose Sign in, then choose ${provider} and use this address.`,
      "If you didn't ask for this, you can ignore this email. Nothing about your account has changed.",
      `Questions? Write to us at ${input.supportAddress}.`,
    ],
    button: { label: "Open Supply Checkout", url: appLink(appUrl, "/") },
    footer: "You're getting this email because someone asked to reset the Supply Checkout password for this address, which signs in with " + provider + ". It was sent from an address that doesn't take replies.",
  };
}

/** Renders one message. Throws on a bad date or a link off the app's origin. */
export function renderEmail(input: EmailInput, options: RenderOptions): RenderedEmail {
  const c = content(input, options);
  return { kind: input.kind, subject: c.subject, html: html(c), text: text(c) };
}
