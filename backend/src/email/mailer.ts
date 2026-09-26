// Sends the app's transactional email through SES (API v2), always from
// noreply@<env domain> and always through the configuration set, which
// suppresses addresses that bounce or complain and reports bounces and
// complaints to the email-events handler (events-handler.ts).
//
// - The IAM policy (grantSendEmail in infra/lib/email.ts) allows ses:SendEmail
//   only on the domain identity and the configuration set, and only from that
//   From address.
// - Each message carries tags with its kind and, for an invite, the team and
//   invite IDs, so a bounce can be matched to the invite (EMAIL_TAGS).
// - Recipients, names and tokens never go in a log line, an error or a metric.

import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { type Invite, normalizeEmail } from "../data/index.js";
import { EMAIL_ENV, EMAIL_TAGS, FROM_NAME } from "./names.js";
import { type EmailInput, renderEmail } from "./templates.js";

/** What the mailer needs from an SES client: `send`, as SESv2Client has it. */
export interface SesSender {
  send(command: SendEmailCommand): Promise<{ MessageId?: string }>;
}

export interface MailerOptions {
  readonly fromAddress: string;
  readonly configurationSet: string;
  readonly appUrl: string;
  readonly ses: SesSender;
}

/** IDs to tag a message with, so its bounces and complaints can be traced. Letters, digits, _ and - only. */
export interface MessageTags {
  readonly teamId?: string;
  readonly inviteId?: string;
}

export interface Mailer {
  /** Renders and sends one message to one recipient; returns SES's message ID. */
  send(to: string, input: EmailInput, tags?: MessageTags): Promise<{ messageId: string }>;
}

/** SES refused the message (for example, sending is paused). Carries no address. */
export class EmailNotSentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`SES didn't accept the message (${code})`);
    this.name = "EmailNotSentError";
    this.code = code;
  }
}

// SES tag values: ASCII letters, digits, _ and -, at most 256 characters
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;

function tagValue(name: string, value: string): string {
  if (!TAG_VALUE.test(value)) throw new Error(`Invalid ${name} for a message tag`);
  return value;
}

export function createMailer(options: MailerOptions): Mailer {
  const { fromAddress, configurationSet, appUrl, ses } = options;
  if (!fromAddress || !configurationSet || !appUrl) throw new Error("The mailer needs a From address, a configuration set and the app URL");
  return {
    async send(to, input, tags = {}) {
      const recipient = normalizeEmail(to);
      const message = renderEmail(input, { appUrl });
      const params: SendEmailCommandInput = {
        FromEmailAddress: `${FROM_NAME} <${fromAddress}>`,
        Destination: { ToAddresses: [recipient] },
        ConfigurationSetName: configurationSet,
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: { Html: { Data: message.html, Charset: "UTF-8" }, Text: { Data: message.text, Charset: "UTF-8" } },
          },
        },
        EmailTags: [
          { Name: EMAIL_TAGS.kind, Value: input.kind },
          ...(tags.teamId !== undefined ? [{ Name: EMAIL_TAGS.teamId, Value: tagValue("team ID", tags.teamId) }] : []),
          ...(tags.inviteId !== undefined ? [{ Name: EMAIL_TAGS.inviteId, Value: tagValue("invite ID", tags.inviteId) }] : []),
        ],
      };
      try {
        const { MessageId } = await ses.send(new SendEmailCommand(params));
        if (!MessageId) throw new EmailNotSentError("NoMessageId");
        return { messageId: MessageId };
      } catch (error) {
        if (error instanceof EmailNotSentError) throw error;
        // Keep only the error's name: SES messages can quote the address
        throw new EmailNotSentError((error as { name?: string } | null)?.name || "Unknown");
      }
    },
  };
}

/** A mailer from the environment grantSendEmail sets, with one SES client per container. */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return createMailer({
    fromAddress: need(EMAIL_ENV.fromAddress),
    configurationSet: need(EMAIL_ENV.configurationSet),
    appUrl: need(EMAIL_ENV.appUrl),
    ses: new SESv2Client({ region: need(EMAIL_ENV.region) }),
  });
}

/**
 * Sends an invite's email, tagged with its team and invite, so a bounce marks
 * this invite failed. `token` is the one createInvite returned; it's only in
 * the link. Invites are never re-sent automatically: an owner re-sends.
 */
export function sendInviteEmail(mailer: Mailer, invite: Invite, token: string): Promise<{ messageId: string }> {
  return mailer.send(
    invite.email,
    { kind: "invite", teamName: invite.teamName, role: invite.role, inviteId: invite.inviteId, token, expiresAt: invite.expiresAt },
    { teamId: invite.teamId, inviteId: invite.inviteId },
  );
}

/** A billing or account notice to one of a team's owners, tagged with the team. */
export function sendTeamNotice(
  mailer: Mailer,
  to: string,
  teamId: string,
  input: Exclude<EmailInput, { kind: "invite" }>,
): Promise<{ messageId: string }> {
  return mailer.send(to, input, { teamId });
}
