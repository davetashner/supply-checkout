// Transactional email: the templates render sanely for real mail clients, the
// mailer sends only from the one address through the configuration set with
// the right tags, and bounce and complaint events mark the matching invite
// failed (and only that invite) without logging an address.

import type { SNSEvent } from "aws-lambda";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it } from "vitest";
import { type Invite, type Member, type Team, hashEmail, markInviteFailed, teamContextForEmailEvent } from "../src/data/index.js";
import { createEmailEventsHandler } from "../src/email/events-handler.js";
import { EmailNotSentError, createMailer, mailerFromEnv, sesClientConfig, sendInviteEmail, sendTeamNotice, type SesSender } from "../src/email/mailer.js";
import { EMAIL_ENV, EMAIL_EVENTS_READS, EMAIL_EVENTS_WRITES, EMAIL_KINDS, EMAIL_TAGS, configurationSetName } from "../src/email/names.js";
import { type EmailInput, type TeamNoticeInput, escapeHtml, formatDate, formatDateTime, plainName, renderEmail, teamLabel } from "../src/email/templates.js";
import type { Observability } from "../src/observability/index.js";
import { contextFor, fakeDb } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const APP = "https://app.supplycheckout.com";
const TEAM = "7d3b8a52-5a61-4c3e-9d1f-0b6f2f7c1a11";
const INVITE = "0b6f2f7c-5a61-4c3e-9d1f-7d3b8a521a11";
const INVITEE = "pat@example.com";
const EXPIRES = Math.floor(Date.parse("2026-10-03T12:00:00Z") / 1000);

const samples: EmailInput[] = [
  { kind: "invite", teamName: "Echo Cleaning", role: "contributor", inviteId: INVITE, token: "tok_abcdefghijklmnopqrstuvwxyz", expiresAt: EXPIRES },
  { kind: "trialEnding", teamName: "Echo Cleaning", trialEndsAt: "2026-10-10T12:00:00.000Z" },
  { kind: "paymentFailed", teamName: "Echo Cleaning", nextAttemptAt: "2026-10-12T00:00:00.000Z" },
  { kind: "readOnly", teamName: "Echo Cleaning" },
  { kind: "exportReady", teamName: "Echo Cleaning", exportId: "exp-1", expiresAt: "2026-10-05T00:00:00.000Z" },
  { kind: "teamClosed", teamName: "Echo Cleaning", purgeAfter: "2026-10-26T12:00:00.000Z" },
  { kind: "teamReopened", teamName: "Echo Cleaning" },
  { kind: "passwordSet", at: "2026-09-30T14:05:09.000Z" },
  { kind: "twoStepOn", at: "2026-09-30T14:05:09.000Z" },
  { kind: "emailChanged", at: "2026-09-30T14:05:09.000Z" },
  // Variants of a kind: last, since tests pick the ones above by position
  { kind: "readOnly", teamName: "Echo Cleaning", reason: "subscription_ended", deletesAt: "2026-11-02T12:00:00.000Z" },
  { kind: "readOnly", teamName: "Echo Cleaning", reason: "trial_ended", deletesAt: "2026-11-02T12:00:00.000Z" },
  { kind: "readOnly", teamName: "Echo Cleaning", reason: "payment_overdue" },
  { kind: "deletionWarning", teamName: "Echo Cleaning", deletesAt: "2026-11-02T12:00:00.000Z" },
];

describe("templates", () => {
  it("has a sample for every kind", () => {
    expect([...new Set(samples.map((s) => s.kind))].sort()).toEqual([...EMAIL_KINDS].sort());
  });

  for (const input of samples) {
    describe(input.kind, () => {
      const email = renderEmail(input, { appUrl: APP });

      it("has a short one-line subject naming the team, or for the account's own notices, the change", () => {
        expect(email.kind).toBe(input.kind);
        expect(email.subject).toContain("teamName" in input ? "Echo Cleaning" : "Supply Checkout");
        expect(email.subject).not.toMatch(/[\r\n]/);
        expect(email.subject.length).toBeLessThan(120);
      });

      it("is a complete HTML document with balanced layout tables", () => {
        expect(email.html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(email.html).toContain('<meta charset="utf-8">');
        expect(email.html).toContain('name="viewport"');
        expect(email.html).toMatch(/<\/body>\s*<\/html>$/);
        for (const tag of ["table", "tr", "td", "p", "a", "h1", "div"]) {
          const opens = email.html.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
          const closes = email.html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
          expect(closes, `<${tag}> balanced`).toBe(opens);
        }
        // Every layout table is presentational, so screen readers skip the grid
        const tables = email.html.match(/<table[^>]*>/g) ?? [];
        expect(tables.length).toBeGreaterThan(0);
        for (const t of tables) expect(t).toContain('role="presentation"');
      });

      it("uses only what Gmail, Outlook and iOS Mail render: inline styles, no scripts, images or remote CSS", () => {
        expect(email.html).not.toMatch(/<style|<script|<img|<link|<iframe|<form|class=|display:\s*flex|display:\s*grid|position:\s*absolute|@import|url\(/i);
        // The button is a table cell with bgcolor, which Word-rendered Outlook draws
        expect(email.html).toMatch(/<td align="center" bgcolor="#[0-9a-f]{6}"/);
        expect(email.html).toMatch(/max-width:600px/);
      });

      it("has no unfilled values", () => {
        for (const part of [email.subject, email.html, email.text]) expect(part).not.toMatch(/undefined|NaN|null|\$\{|Invalid Date|\[object/);
      });

      it("links only to the app, over https, the same link in both parts", () => {
        const links = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] as string).replaceAll("&amp;", "&"));
        expect(links.length).toBeGreaterThanOrEqual(2);
        for (const link of links) expect(new URL(link).origin).toBe(APP);
        const textLinks = email.text.match(/https:\/\/\S+/g) ?? [];
        expect(textLinks.length).toBe(1);
        expect(links).toContain(textLinks[0]);
      });

      it("has a readable text part", () => {
        expect(email.text).toContain("teamName" in input ? "Echo Cleaning" : "September 30, 2026 at 14:05 UTC");
        expect(email.text).not.toMatch(/<[a-z/]/i);
        expect(email.text.split("\n").every((line) => line.length < 400)).toBe(true);
      });
    });
  }

  it("puts the invite's ID and token in the link the app reads (?invite=&token=)", () => {
    const email = renderEmail(samples[0] as EmailInput, { appUrl: APP });
    const link = new URL(email.text.match(/https:\/\/\S+/)?.[0] as string);
    expect(link.searchParams.get("invite")).toBe(INVITE);
    expect(link.searchParams.get("token")).toBe("tok_abcdefghijklmnopqrstuvwxyz");
    expect(email.text).toContain("October 3, 2026");
    expect(email.text).toContain("a contributor");
  });

  it("describes each role", () => {
    for (const role of ["owner", "contributor", "viewer"] as const) {
      const email = renderEmail({ ...(samples[0] as Extract<EmailInput, { kind: "invite" }>), role }, { appUrl: APP });
      expect(email.text).toContain(`as ${role === "owner" ? "an owner" : `a ${role}`}`);
    }
  });

  it("says why a team is read-only, and when it's deleted unless an owner subscribes (supply-checkout-qdx)", () => {
    const text = (input: EmailInput) => renderEmail(input, { appUrl: APP }).text;
    const ended = text({ kind: "readOnly", teamName: "Echo", reason: "subscription_ended", deletesAt: "2026-11-02T12:00:00.000Z" });
    expect(ended).toContain("no longer has an active subscription");
    // The last day it's kept: deleted at noon UTC the next day, once November 1 has ended everywhere
    expect(ended).toContain("After November 1, 2026, Echo and everything in it will be deleted, unless an owner subscribes by then.");
    const trial = text({ kind: "readOnly", teamName: "Echo", reason: "trial_ended", deletesAt: "2026-11-02T12:00:00.000Z" });
    expect(trial).toContain("The free trial for Echo has ended without a plan");
    expect(trial).toContain("After November 1, 2026");
    // No date known: no deletion promised or threatened
    expect(text({ kind: "readOnly", teamName: "Echo" })).not.toContain("deleted,");
    const overdue = text({ kind: "readOnly", teamName: "Echo", reason: "payment_overdue", deletesAt: "2026-11-02T12:00:00.000Z" });
    expect(overdue).toContain("still overdue");
    expect(overdue).toContain("Update payment method:");
    expect(overdue).not.toContain("November 1");
    // The trial and payment notices state the periods the access rules use
    expect(text(samples[1] as EmailInput)).toContain("for 30 days. After that, the team and everything in it are deleted.");
    expect(text(samples[2] as EmailInput)).toContain("keeps working for 7 days while we try again");
  });

  it("warns owners of a lapsed team's deletion, with the date, what to do, and that it can't be undone (supply-checkout-qdx)", () => {
    const email = renderEmail({ kind: "deletionWarning", teamName: "Echo", deletesAt: "2026-11-02T12:00:00.000Z" }, { appUrl: APP });
    // deletesAt is the deletion time (noon UTC the next day); the email states the last day it's kept
    expect(email.subject).toBe("Echo will be deleted after November 1, 2026");
    expect(email.text).toContain("After November 1, 2026, the team, its sheets and its inventory will be deleted for good");
    expect(email.text).toContain("subscribe in the app by November 1, 2026");
    expect(email.text).toContain("Export data");
  });

  it("leaves out the retry date when Stripe gave none", () => {
    const email = renderEmail({ kind: "paymentFailed", teamName: "Echo" }, { appUrl: APP });
    expect(email.text).not.toContain("try again on");
    expect(renderEmail(samples[2] as EmailInput, { appUrl: APP }).text).toContain("try again on October 12, 2026");
  });

  it("escapes a team name with markup, and keeps it on one line in the subject", () => {
    const email = renderEmail({ kind: "readOnly", teamName: '<a href="https://evil.example.com">Win</a>\r\nBcc: x' }, { appUrl: APP });
    expect(email.html).not.toContain('<a href="https://evil');
    // Escaped, and the link-like part defanged so no mail client links it
    expect(email.html).toContain("&lt;a href=&quot;https[:]//evil[.]example[.]com&quot;&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text.split("\n")[0]).toContain("Bcc: x");
    expect([...email.html.matchAll(/href="([^"]+)"/g)].every((m) => new URL((m[1] as string).replaceAll("&amp;", "&")).origin === APP)).toBe(true);
  });

  it("quotes the team name in an invite, and defangs anything in it a mail client could link", () => {
    const teamName = "Payroll: verify at https://evil.example/login or www.evil.example, or mail help@example.com";
    const email = renderEmail({ ...(samples[0] as Extract<EmailInput, { kind: "invite" }>), teamName }, { appUrl: APP });
    for (const part of [email.subject, email.html, email.text]) expect(part).not.toMatch(/evil\.example|example\.com|https:\/\/evil|help@/);
    expect(email.subject).toMatch(/^You're invited to join the team \u201cPayroll: verify at https\[:\]\/\/evil\[\.\]example/);
    expect(email.text).toContain("\u201d as a contributor");
    // Only the one link, to the app
    expect([...email.html.matchAll(/href="([^"]+)"/g)].every((m) => new URL((m[1] as string).replaceAll("&amp;", "&")).origin === APP)).toBe(true);
    // Ordinary names are left alone
    for (const name of ["Echo Cleaning", "J.R. Cleaning", "Crew: north", "3.5 Stars", "A & B, Inc.", "Café Ltd."]) expect(teamLabel(name)).toBe(name);
    expect(teamLabel("Acme.co")).toBe("Acme[.]co");
    expect(teamLabel("mailto:x")).toBe("mailto[:]x");
  });

  it("tells an owner their team closed and the day it'll be deleted, with its name defanged", () => {
    const email = renderEmail(samples[5] as EmailInput, { appUrl: APP });
    expect(email.subject).toBe("Echo Cleaning was closed on Supply Checkout");
    expect(email.text).toContain("On October 26, 2026, the team, its sheets and its inventory will be deleted for good.");
    expect(email.html).toContain("It will be deleted for good on October 26, 2026.");
    const hostile = renderEmail({ kind: "teamClosed", teamName: "<b>Reopen</b> at https://evil.example/restore", purgeAfter: "2026-10-26T12:00:00.000Z" }, { appUrl: APP });
    for (const part of [hostile.subject, hostile.html, hostile.text]) expect(part).not.toMatch(/evil\.example|https:\/\/evil/);
    expect(hostile.html).not.toContain("<b>");
    expect(hostile.html).toContain("&lt;b&gt;Reopen&lt;/b&gt; at https[:]//evil[.]example/restore");
    expect([...hostile.html.matchAll(/href="([^"]+)"/g)].every((m) => new URL((m[1] as string).replaceAll("&amp;", "&")).origin === APP)).toBe(true);
    expect(() => renderEmail({ kind: "teamClosed", teamName: "Echo", purgeAfter: "" }, { appUrl: APP })).toThrow("Invalid date");
  });

  it("tells an owner their team was reopened and what didn't come back, with its name defanged", () => {
    const email = renderEmail(samples[6] as EmailInput, { appUrl: APP });
    expect(email.subject).toBe("Echo Cleaning was reopened on Supply Checkout");
    expect(email.text).toContain("An owner of Echo Cleaning reopened the team, so it won't be deleted.");
    expect(email.text).toContain("Invites that were cancelled when it closed stay cancelled");
    // What happened to billing (supply-checkout-8jc.39). It's sent before the billing worker resyncs the subscription, so it covers both outcomes
    // Never a promise it renews: a resume can fail or be left for a person, so the owner is told where to check (the app's note, then Billing)
    expect(email.text).toContain(
      "If closing the team set its subscription to end, we'll set it to renew again. If the app still says the subscription will end, an owner can renew it from Billing. If its subscription had already ended, an owner can subscribe again in the app.",
    );
    expect(email.text).not.toMatch(/resuming it|renews as before/);
    expect(email.html).toContain("an owner can renew it from Billing.");
    const hostile = renderEmail({ kind: "teamReopened", teamName: "<b>Pay</b> at https://evil.example/pay" }, { appUrl: APP });
    for (const part of [hostile.subject, hostile.html, hostile.text]) expect(part).not.toMatch(/evil\.example|https:\/\/evil/);
    expect(hostile.html).not.toContain("<b>");
    expect([...hostile.html.matchAll(/href="([^"]+)"/g)].every((m) => new URL((m[1] as string).replaceAll("&amp;", "&")).origin === APP)).toBe(true);
  });

  // supply-checkout-8jc.15
  it("tells the account's owner a password was set or two-step sign-in turned on, when, and what to do if it wasn't them", () => {
    const password = renderEmail(samples[7] as EmailInput, { appUrl: APP });
    expect(password.subject).toBe("A password was set on your Supply Checkout account");
    const twoStep = renderEmail(samples[8] as EmailInput, { appUrl: APP });
    expect(twoStep.subject).toBe("Two-step sign-in was turned on for your Supply Checkout account");
    expect(twoStep.text).toContain("signed out everywhere");
    for (const email of [password, twoStep]) {
      expect(email.text).toContain("on September 30, 2026 at 14:05 UTC");
      expect(email.text).toContain("If this was you, you don't need to do anything.");
      expect(email.text).toContain("If it wasn't you");
      expect(email.text).toContain("check that the email address on your account is still yours");
      expect(email.html).toContain("If it wasn&#39;t you");
    }
    expect(() => renderEmail({ kind: "passwordSet", at: "soon" }, { appUrl: APP })).toThrow("Invalid date");
  });

  // supply-checkout-8jc.29
  it("tells the previous address the account's email changed, when, and what to do if it wasn't them", () => {
    const changed = renderEmail(samples[9] as EmailInput, { appUrl: APP });
    expect(changed.subject).toBe("The email address on your Supply Checkout account was changed");
    expect(changed.text).toContain("on September 30, 2026 at 14:05 UTC");
    expect(changed.text).toContain("the address the account had before");
    expect(changed.text).toContain("If this was you, you don't need to do anything.");
    // Codes now go to the new address, so the usual advice (reset with a code sent here) can't work
    expect(changed.text).not.toContain("code sent to this address");
    expect(changed.text).toContain("Contact Supply Checkout support");
    expect(changed.html).toContain("If it wasn&#39;t you");
    expect(() => renderEmail({ kind: "emailChanged", at: "soon" }, { appUrl: APP })).toThrow("Invalid date");
  });

  it("shortens long names and names a blank one", () => {
    expect(plainName("x".repeat(200))).toHaveLength(80);
    expect(plainName("x".repeat(200)).endsWith("…")).toBe(true);
    expect(plainName("  \u0000 \n ")).toBe("your team");
    expect(plainName("A B")).toBe("A B");
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("formats dates in UTC and refuses bad ones", () => {
    expect(formatDate("2026-10-03T23:30:00Z")).toBe("October 3, 2026");
    expect(formatDate(EXPIRES)).toBe("October 3, 2026");
    expect(formatDateTime("2026-10-03T23:30:59Z")).toBe("October 3, 2026 at 23:30 UTC");
    expect(formatDateTime("2026-10-04T00:05:00Z")).toBe("October 4, 2026 at 00:05 UTC");
    expect(() => formatDateTime("soon")).toThrow("Invalid date");
    expect(() => formatDate("soon")).toThrow("Invalid date");
  });

  it("refuses an app URL that isn't https, and allows localhost for development", () => {
    expect(() => renderEmail(samples[3] as EmailInput, { appUrl: "http://app.supplycheckout.com" })).toThrow("https");
    expect(renderEmail(samples[3] as EmailInput, { appUrl: "http://localhost:5173" }).text).toContain("http://localhost:5173/");
  });
});

class FakeSes implements SesSender {
  readonly sent: SendEmailCommand[] = [];
  answer: () => Promise<{ MessageId?: string }> = async () => ({ MessageId: "msg-1" });
  send(command: SendEmailCommand) {
    this.sent.push(command);
    return this.answer();
  }
}

const invite: Invite = {
  type: "invite",
  teamId: TEAM,
  teamName: "Echo Cleaning",
  inviteId: INVITE,
  email: INVITEE,
  role: "viewer",
  invitedBy: "u1",
  createdAt: "2026-09-26T12:00:00.000Z",
  expiresAt: EXPIRES,
};

describe("mailer", () => {
  let ses: FakeSes;
  const mailer = () => createMailer({ fromAddress: "noreply@supplycheckout.com", configurationSet: configurationSetName("prod"), appUrl: APP, ses });
  beforeEach(() => {
    ses = new FakeSes();
  });

  it("sends an invite from noreply through the configuration set, tagged with its team and invite", async () => {
    expect(await sendInviteEmail(mailer(), invite, "tok_abcdefghijklmnopqrstuvwxyz")).toEqual({ messageId: "msg-1" });
    const input = ses.sent[0]?.input;
    expect(input?.FromEmailAddress).toBe("Supply Checkout <noreply@supplycheckout.com>");
    expect(input?.ConfigurationSetName).toBe("supply-checkout-prod-transactional");
    expect(input?.Destination).toEqual({ ToAddresses: [INVITEE] });
    expect(input?.EmailTags).toEqual([
      { Name: EMAIL_TAGS.kind, Value: "invite" },
      { Name: EMAIL_TAGS.teamId, Value: TEAM },
      { Name: EMAIL_TAGS.inviteId, Value: INVITE },
    ]);
    const body = input?.Content?.Simple?.Body;
    expect(body?.Text?.Data).toContain(`invite=${INVITE}`);
    expect(body?.Html?.Charset).toBe("UTF-8");
    expect(input?.Content?.Simple?.Subject?.Data).toContain("Echo Cleaning");
  });

  it("normalizes the recipient and refuses one that isn't an address", async () => {
    await mailer().send(" Pat@Example.COM ", samples[3] as EmailInput);
    expect(ses.sent[0]?.input.Destination?.ToAddresses).toEqual([INVITEE]);
    // Only a bare addr-spec: a display name, a quoted local part, a list or a header
    // would let SES deliver somewhere other than the address that was checked
    for (const to of ["pat@example.com\r\nBcc: x@example.com", "x<v@example.com>", "Pat <v@example.com>", '"a"@b.com', "a,b@c.com", "a@b", "a@b.com, v@example.com", "a@-b.com", "a..b@c.com", "(c)a@b.com"]) { // public-safety: allow (deliberate test addresses)
      await expect(mailer().send(to, samples[3] as EmailInput), to).rejects.toThrow(expect.objectContaining({ name: "EmailNotSentError", code: "InvalidRecipient" }));
    }
    expect(ses.sent).toHaveLength(1);
    // Unusual but plain addresses still go
    await mailer().send("O'Neil+jobs@xn--bcher-kva.example", samples[3] as EmailInput); // public-safety: allow (deliberate test addresses)
    expect(ses.sent[1]?.input.Destination?.ToAddresses).toEqual(["o'neil+jobs@xn--bcher-kva.example"]); // public-safety: allow (deliberate test addresses)
  });

  it("tags a notice with its team only", async () => {
    await sendTeamNotice(mailer(), INVITEE, TEAM, samples[1] as TeamNoticeInput);
    expect(ses.sent[0]?.input.EmailTags).toEqual([
      { Name: EMAIL_TAGS.kind, Value: "trialEnding" },
      { Name: EMAIL_TAGS.teamId, Value: TEAM },
    ]);
  });

  it("refuses a tag value SES wouldn't take", async () => {
    await expect(mailer().send(INVITEE, samples[3] as EmailInput, { teamId: "a#b" })).rejects.toThrow("Invalid team ID");
    await expect(mailer().send(INVITEE, samples[3] as EmailInput, { inviteId: "" })).rejects.toThrow("Invalid invite ID");
  });

  it("reports SES's refusal by error name only, never with the address", async () => {
    ses.answer = () => Promise.reject(Object.assign(new Error(`Email address is not verified: ${INVITEE}`), { name: "MessageRejected" }));
    const error = await mailer().send(INVITEE, samples[3] as EmailInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailNotSentError);
    expect((error as EmailNotSentError).code).toBe("MessageRejected");
    expect(String(error)).not.toContain(INVITEE);
    ses.answer = async () => ({});
    await expect(mailer().send(INVITEE, samples[3] as EmailInput)).rejects.toMatchObject({ code: "NoMessageId" });
    ses.answer = () => Promise.reject("boom");
    await expect(mailer().send(INVITEE, samples[3] as EmailInput)).rejects.toMatchObject({ code: "Unknown" });
    // A message that won't render (a bad date) says so, not "Error", and SES isn't asked
    const asked = ses.sent.length;
    await expect(mailer().send(INVITEE, { kind: "passwordSet", at: "soon" })).rejects.toMatchObject({ name: "EmailNotSentError", code: "RenderFailed" });
    expect(ses.sent.length).toBe(asked);
  });

  it("needs its settings", () => {
    expect(() => createMailer({ fromAddress: "", configurationSet: "c", appUrl: APP, ses })).toThrow("From address");
    expect(() => mailerFromEnv({})).toThrow(`${EMAIL_ENV.fromAddress} is not set`);
    const env = { [EMAIL_ENV.fromAddress]: "noreply@supplycheckout.com", [EMAIL_ENV.configurationSet]: "c", [EMAIL_ENV.appUrl]: APP, [EMAIL_ENV.region]: "test-local-1" };
    expect(typeof mailerFromEnv(env).send).toBe("function");
  });

  // supply-checkout-8jc.28 review: a hung SES call mustn't run a function into its timeout
  it("bounds every SES call: 2 seconds to connect, 5 to answer (failing the call, not only warning), 2 tries", async () => {
    expect(sesClientConfig("test-local-1")).toEqual({
      region: "test-local-1",
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000, throwOnRequestTimeout: true },
    });
    // As the SDK's own HTTP handler resolves it
    const client = new SESv2Client(sesClientConfig("test-local-1"));
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> };
    expect(await handler.configProvider).toMatchObject({ connectionTimeout: 2_000, requestTimeout: 5_000, throwOnRequestTimeout: true });
    client.destroy();
  });
});

describe("markInviteFailed", () => {
  it("is for the system only", async () => {
    const table = new MemoryTable();
    const owner = await contextFor("owner", undefined, TEAM);
    await expect(markInviteFailed(table.db(), owner, { inviteId: INVITE, emailHash: hashEmail(INVITEE), reason: "bounced", at: new Date() })).rejects.toThrow(
      "Needs the system role",
    );
  });
});

function fakeObservability() {
  const logs: { level: string; message: string; data?: unknown }[] = [];
  const counts: { metric: string; value: number; metadata?: unknown }[] = [];
  const at = (level: string) => (message: string, data?: unknown) => logs.push({ level, message, data });
  const obs = {
    region: "test-local-1",
    logger: { info: at("info"), warn: at("warn"), error: at("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric: string, value = 1, metadata?: unknown) => counts.push({ metric, value, metadata }),
    flush: () => {},
  } as unknown as Observability;
  return { obs, logs, counts };
}

const tags = (kind: string, extra: Record<string, string> = {}) => ({ [EMAIL_TAGS.kind]: [kind], ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, [v]])) });
const inviteTags = (inviteId = INVITE, teamId = TEAM) => tags("invite", { [EMAIL_TAGS.teamId]: teamId, [EMAIL_TAGS.inviteId]: inviteId });

const bounce = (bounceType: string, recipients: string[], mailTags: Record<string, string[]>, bounceSubType = "General") => ({
  eventType: "Bounce",
  bounce: { bounceType, bounceSubType, bouncedRecipients: recipients.map((emailAddress) => ({ emailAddress })) },
  mail: { messageId: "msg-1", tags: mailTags },
});
const complaint = (recipients: string[], mailTags: Record<string, string[]>) => ({
  notificationType: "Complaint",
  complaint: { complainedRecipients: recipients.map((emailAddress) => ({ emailAddress })) },
  mail: { messageId: "msg-1", tags: mailTags },
});
const sns = (...messages: unknown[]): SNSEvent => ({
  Records: messages.map((m) => ({ Sns: { Message: typeof m === "string" ? m : JSON.stringify(m) } })) as SNSEvent["Records"],
});

describe("email events", () => {
  const NOW = new Date("2026-09-27T08:00:00.000Z");
  let table: MemoryTable;
  const inviteKey = (inviteId = INVITE) => ({ PK: `TEAM#${TEAM}`, SK: `INVITE#${inviteId}` });
  const putInvite = (inviteId = INVITE, email = INVITEE) =>
    table.put({ ...inviteKey(inviteId), GSI2PK: `INVITEE#${hashEmail(email)}`, GSI2SK: `INVITE#${inviteId}`, ...invite, inviteId, email });
  const run = (event: SNSEvent) => {
    const o = fakeObservability();
    return createEmailEventsHandler({ db: table.db(), obs: o.obs, now: () => NOW })(event).then(() => o);
  };

  beforeEach(() => {
    table = new MemoryTable();
    table.seedTeam(TEAM, { u1: "owner" });
    putInvite();
  });

  it("marks the invite failed on a permanent bounce, without logging the address", async () => {
    const { logs, counts } = await run(sns(bounce("Permanent", ["Pat@Example.com"], inviteTags())));
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)).toMatchObject({ inviteStatus: "failed", failureReason: "bounced", failedAt: NOW.toISOString() });
    expect(counts).toEqual([
      { metric: "EmailBounces", value: 1, metadata: { kind: "invite", reason: "bounced", detail: "General" } },
      { metric: "InvitesFailed", value: 1, metadata: { teamId: TEAM, reason: "bounced" } },
    ]);
    expect(JSON.stringify([logs, counts]).toLowerCase()).not.toContain("pat@");
    expect(logs).toContainEqual({ level: "info", message: "Marked an invite failed", data: { teamId: TEAM, inviteId: INVITE, reason: "bounced" } });
  });

  it("counts transient and undetermined bounces (out-of-office, full mailbox) but leaves the invite pending", async () => {
    const { counts, logs } = await run(
      sns(
        bounce("Transient", [INVITEE], inviteTags(), "MailboxFull"),
        bounce("Transient", [INVITEE], inviteTags(), "General"),
        bounce("Undetermined", [INVITEE], inviteTags(), "Undetermined"),
      ),
    );
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)?.inviteStatus).toBeUndefined();
    expect(counts).toEqual([
      { metric: "EmailBounces", value: 1, metadata: { kind: "invite", reason: "transient", detail: "MailboxFull" } },
      { metric: "EmailBounces", value: 1, metadata: { kind: "invite", reason: "transient", detail: "General" } },
      { metric: "EmailBounces", value: 1, metadata: { kind: "invite", reason: "transient", detail: "Undetermined" } },
    ]);
    expect(logs).toEqual([]);
    expect(table.calls).toEqual([]);
  });

  it("marks a complaint as complained", async () => {
    const { counts } = await run(sns(complaint([INVITEE], inviteTags())));
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)).toMatchObject({ inviteStatus: "failed", failureReason: "complained" });
    expect(counts[0]).toMatchObject({ metric: "EmailComplaints", value: 1 });
  });

  it("marks a send to a suppressed address failed too", async () => {
    await run(sns(bounce("Permanent", [INVITEE], inviteTags(), "OnAccountSuppressionList")));
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)).toMatchObject({ inviteStatus: "failed", failureReason: "bounced" });
  });

  it("marks nothing when the bounced address isn't the invite's", async () => {
    const { logs, counts } = await run(sns(bounce("Permanent", ["someone@example.com"], inviteTags())));
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)?.inviteStatus).toBeUndefined();
    expect(logs.map((l) => l.message)).toContain("No pending invite for this bounce");
    expect(counts.map((c) => c.metric)).toEqual(["EmailBounces"]);
  });

  it("marks nothing for an invite that was accepted or revoked, or a team that's gone", async () => {
    const { logs } = await run(sns(bounce("Permanent", [INVITEE], inviteTags("gone-invite")), bounce("Permanent", [INVITEE], inviteTags(INVITE, "other-team"))));
    expect(table.get(`TEAM#${TEAM}`, `INVITE#gone-invite`)).toBeUndefined();
    expect(table.get(`TEAM#other-team`, `INVITE#${INVITE}`)).toBeUndefined();
    expect(logs.map((l) => l.message)).toEqual(["No pending invite for this bounce", "The invite's team no longer exists"]);
  });

  it("leaves other messages' bounces to SES's suppression, and ignores untagged or malformed tags", async () => {
    const { counts } = await run(
      sns(
        bounce("Permanent", [INVITEE], tags("trialEnding", { [EMAIL_TAGS.teamId]: TEAM })),
        bounce("Permanent", [INVITEE], {}),
        bounce("Permanent", [INVITEE], { [EMAIL_TAGS.kind]: ["invite"], [EMAIL_TAGS.teamId]: [`${TEAM}#x`], [EMAIL_TAGS.inviteId]: [INVITE] }),
        bounce("Permanent", [INVITEE], { [EMAIL_TAGS.kind]: "invite" as never }),
      ),
    );
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)?.inviteStatus).toBeUndefined();
    expect(counts.map((c) => (c.metadata as { kind: string }).kind)).toEqual(["trialEnding", "unknown", "invite", "unknown"]);
    expect(table.calls).toEqual([]);
  });

  it("drops events it can't use, and a recipient that isn't an address", async () => {
    const { logs } = await run(
      sns("not json", "[1]", { eventType: "Delivery", mail: {} }, { eventType: "Bounce" }, bounce("Permanent", ["not an address"], inviteTags()), {
        eventType: "Bounce",
        bounce: { bounceType: "Permanent", bounceSubType: "has spaces" },
        mail: { tags: inviteTags() },
      }),
    );
    expect(logs.filter((l) => l.message === "Ignoring an email event that isn't a bounce or complaint")).toHaveLength(4);
    expect(logs.map((l) => l.message)).toContain("Ignoring a recipient that isn't an email address");
    expect(table.get(`TEAM#${TEAM}`, `INVITE#${INVITE}`)?.inviteStatus).toBeUndefined();
    const empty = await run({} as SNSEvent);
    expect(empty.logs).toEqual([]);
  });

  it("counts the recipients in a detail it doesn't recognize as unknown", async () => {
    const { counts } = await run(sns({ eventType: "Complaint", complaint: {}, mail: {} }, bounce("Permanent", [INVITEE], {}, "has spaces")));
    expect(counts).toEqual([
      { metric: "EmailComplaints", value: 0, metadata: { kind: "unknown", reason: "complained", detail: "complaint" } },
      { metric: "EmailBounces", value: 1, metadata: { kind: "unknown", reason: "bounced", detail: "unknown" } },
    ]);
  });

  it("throws on a DynamoDB failure, so Lambda retries the event", async () => {
    const failing = new MemoryTable();
    failing.seedTeam(TEAM, { u1: "owner" });
    const db = failing.scoped([`TEAM#elsewhere`]);
    await expect(createEmailEventsHandler({ db, obs: fakeObservability().obs })(sns(bounce("Permanent", [INVITEE], inviteTags())))).rejects.toThrow("not authorized");
  });

  it("issues a system context only for a team that exists", async () => {
    expect(await teamContextForEmailEvent(table.db(), "no-team")).toBeUndefined();
    const ctx = await teamContextForEmailEvent(table.db(), TEAM);
    expect(ctx).toMatchObject({ teamId: TEAM, userId: "system:email", role: "system" });
    await expect(teamContextForEmailEvent(table.db(), "a#b")).rejects.toThrow("Invalid team ID");
    await expect(markInviteFailed(table.db(), ctx as never, { inviteId: INVITE, emailHash: hashEmail(INVITEE), reason: "lost" as never, at: NOW })).rejects.toThrow(
      "Invalid failure reason",
    );
  });

  it("reads and writes only the attributes the email stack's IAM policy allows", async () => {
    const inputs: { name: string; input: Record<string, unknown> }[] = [];
    const db = fakeDb(async (command) => {
      inputs.push({ name: (command as unknown as { constructor: { name: string } }).constructor.name, input: command.input });
      return { Item: { homeRegion: "test-local-1" } };
    });
    await createEmailEventsHandler({ db, obs: fakeObservability().obs, now: () => NOW })(sns(bounce("Permanent", [INVITEE], inviteTags())));
    // Attribute names an expression uses: bare names, and #placeholders resolved
    const attributes = (input: Record<string, unknown>) => {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const text = ["ProjectionExpression", "UpdateExpression", "ConditionExpression"].map((k) => input[k] ?? "").join(" ");
      const used = [...text.replace(/:[A-Za-z0-9_]+/g, " ").matchAll(/#?[A-Za-z_][A-Za-z0-9_]*/g)]
        .map((m) => m[0])
        .filter((w) => !["SET", "AND", "OR", "NOT", "attribute_exists", "attribute_not_exists"].includes(w))
        .map((w) => (w.startsWith("#") ? names[w] : w));
      return new Set([...Object.keys(input.Key as object), ...used]);
    };
    expect(inputs.map((i) => i.name)).toEqual(["GetCommand", "UpdateCommand"]);
    const [get, update] = inputs as [(typeof inputs)[0], (typeof inputs)[0]];
    expect(get.input.ProjectionExpression).toBeDefined();
    for (const a of attributes(get.input)) expect(EMAIL_EVENTS_READS).toContain(a);
    for (const a of attributes(update.input)) expect(EMAIL_EVENTS_WRITES).toContain(a);
    expect(attributes(update.input)).toEqual(new Set(EMAIL_EVENTS_WRITES));
    expect(update.input.ReturnValues).toBeUndefined();
  });

  it("writes only names no other item in a team's partition has, so it can't change a team's billing status", () => {
    const team: Required<Team> = {
      type: "team", teamId: "t", name: "n", plan: "p", seats: 1, status: "active", homeRegion: "r", trialEndsAt: "d", owners: 1, members: 1, stripeCustomerId: "c", stripeSubscriptionId: "s", billingInterval: "month", currentPeriodEnd: "d", cancelAtPeriodEnd: false, stripeSyncedAt: "d", pastDueSince: "d", subscriptionEndedAt: "d", closedAt: "d", closedBy: "u", purgeAfter: "d", purging: "d", createdAt: "d", version: 1,
      compPlan: "p", compSeats: 1, compUntil: "d", compReason: "r", compBy: "o", compAt: "d",
    };
    const member: Required<Member> = { type: "member", teamId: "t", userId: "u", role: "owner", email: "e", joinedAt: "d" };
    // Sheets and products carry status, type, version and their document fields
    const others = [...Object.keys(team), ...Object.keys(member), "status", "type", "version", "GSI1PK", "GSI1SK", "GSI2SK", "GSI3PK", "GSI3SK", "expiresAt"];
    const written = EMAIL_EVENTS_WRITES.filter((a) => !["PK", "SK", "GSI2PK"].includes(a));
    expect(written).toEqual(["inviteStatus", "failureReason", "failedAt"]);
    for (const a of written) expect(others).not.toContain(a);
  });

  it("rethrows a DynamoDB error that isn't a failed condition", async () => {
    const ctx = await teamContextForEmailEvent(table.db(), TEAM);
    const broken = new MemoryTable();
    await expect(
      markInviteFailed(broken.scoped([]), ctx as never, { inviteId: INVITE, emailHash: hashEmail(INVITEE), reason: "bounced", at: NOW }),
    ).rejects.toThrow("not authorized");
  });
});
