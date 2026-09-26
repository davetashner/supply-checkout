// Bounce and complaint events from SES, delivered through the email-events
// SNS topic (the configuration set's event destination).
//
// - Suppression is SES's: the configuration set has suppression on for
//   bounces and complaints, so SES adds a hard-bouncing or complaining address
//   to the account-level suppression list and won't send to it again (a later
//   send to it comes back here as a bounce with the OnAccountSuppressionList
//   subtype). This handler doesn't need, and doesn't have, permission to
//   change the list.
// - An invite's email that bounces permanently (including a send to an
//   address SES has suppressed) or draws a complaint marks that invite
//   failed, so the owner sees it and can correct the address. Transient and
//   undetermined bounces (a full mailbox, an out-of-office auto-reply) are
//   counted but don't mark it: the address works. The message's tags name the
//   team and the invite; the invite must also be for the address that
//   bounced. Nothing is re-sent.
// - Addresses never reach a log line or a metric: only kinds, IDs and counts.
// - A DynamoDB failure throws, so Lambda retries the event and, after its
//   retries, puts it on the dead-letter queue. A malformed event is logged
//   and dropped; retrying it wouldn't help.

import type { SNSEvent } from "aws-lambda";
import { type Db, type InviteFailure, hashEmail, markInviteFailed, teamContextForEmailEvent } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { EMAIL_TAGS } from "./names.js";

export interface EmailEventsDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly now?: () => Date;
}

interface Recipient {
  readonly emailAddress?: unknown;
}

/** The parts of an SES event this handler reads (event publishing, or identity notifications). */
interface SesEvent {
  readonly eventType?: unknown;
  readonly notificationType?: unknown;
  readonly bounce?: { readonly bounceType?: unknown; readonly bounceSubType?: unknown; readonly bouncedRecipients?: readonly Recipient[] };
  readonly complaint?: { readonly complainedRecipients?: readonly Recipient[] };
  readonly mail?: { readonly tags?: Record<string, unknown> };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The first value of a message tag, if it's a plain ID. */
function tag(event: SesEvent, name: string): string | undefined {
  const values = event.mail?.tags?.[name];
  const value = Array.isArray(values) ? values[0] : undefined;
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

function parse(message: string): SesEvent | undefined {
  try {
    const event = JSON.parse(message) as unknown;
    return typeof event === "object" && event !== null && !Array.isArray(event) ? (event as SesEvent) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an event reports and the addresses it's about, or undefined for other
 * events. `failure` is set only when the invite should be marked failed: a
 * permanent bounce or a complaint.
 */
function reportOf(event: SesEvent): { reason: string; failure?: InviteFailure; recipients: readonly Recipient[]; detail: string } | undefined {
  const type = event.eventType ?? event.notificationType;
  if (type === "Bounce" && event.bounce) {
    const permanent = event.bounce.bounceType === "Permanent";
    const subType = typeof event.bounce.bounceSubType === "string" && ID.test(event.bounce.bounceSubType) ? event.bounce.bounceSubType : "unknown";
    const recipients = event.bounce.bouncedRecipients ?? [];
    return permanent ? { reason: "bounced", failure: "bounced", recipients, detail: subType } : { reason: "transient", recipients, detail: subType };
  }
  if (type === "Complaint" && event.complaint) {
    return { reason: "complained", failure: "complained", recipients: event.complaint.complainedRecipients ?? [], detail: "complaint" };
  }
  return undefined;
}

export function createEmailEventsHandler(deps: EmailEventsDeps): (event: SNSEvent) => Promise<void> {
  const { db, obs } = deps;
  const now = deps.now ?? (() => new Date());
  return async (event) => {
    for (const record of event.Records ?? []) {
      const ses = parse(record.Sns?.Message ?? "");
      const report = ses && reportOf(ses);
      if (!ses || !report) {
        obs.logger.warn("Ignoring an email event that isn't a bounce or complaint");
        continue;
      }
      const kind = tag(ses, EMAIL_TAGS.kind) ?? "unknown";
      const recipients = Array.isArray(report.recipients) ? report.recipients : [];
      obs.count(report.reason === "complained" ? BusinessMetric.EmailComplaints : BusinessMetric.EmailBounces, recipients.length, {
        kind,
        reason: report.reason,
        detail: report.detail,
      });
      const failure = report.failure;
      if (!failure) continue;
      const teamId = tag(ses, EMAIL_TAGS.teamId);
      const inviteId = tag(ses, EMAIL_TAGS.inviteId);
      if (kind !== "invite" || !teamId || !inviteId) continue;
      const ctx = await teamContextForEmailEvent(db, teamId);
      if (!ctx) {
        obs.logger.info("The invite's team no longer exists", { teamId, inviteId });
        continue;
      }
      for (const recipient of recipients) {
        let emailHash: string;
        try {
          emailHash = hashEmail(String(recipient.emailAddress));
        } catch {
          obs.logger.warn("Ignoring a recipient that isn't an email address", { teamId, inviteId });
          continue;
        }
        const marked = await markInviteFailed(db, ctx, { inviteId, emailHash, reason: failure, at: now() });
        obs.logger.info(marked ? "Marked an invite failed" : "No pending invite for this bounce", { teamId, inviteId, reason: failure });
        if (marked) obs.count(BusinessMetric.InvitesFailed, 1, { teamId, reason: failure });
      }
    }
  };
}
