// Transactional email settings, and the one way to let a Lambda send.
//
// The SES domain identity, its configuration set and the bounce and
// complaint topic are in the primary region's domain stack; the handler for
// those events is the email stack. A function that sends (the account
// function, for invites; billing notices, supply-checkout-x0l) gets
// grantSendEmail(), and nothing else may send.
import { Stack } from "aws-cdk-lib";
import { PolicyStatement, type User } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import type { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { configurationSetName, EMAIL_ENV, FROM_LOCAL_PART } from "../../backend/src/email/names.js";
import type { DeploymentConfig } from "./config.js";
import { hostNames } from "./domain.js";

export interface EmailSettings {
  /** `noreply@<env domain>`: the only address the app sends from. */
  readonly fromAddress: string;
  /** The domain SES verified (the env domain's apex). */
  readonly identity: string;
  readonly configurationSet: string;
  /** SES lives in the primary region; SES in the second region is phase 2 (supply-checkout-3x3.1). */
  readonly region: string;
  /** `https://app.<env domain>`, the base of every link in a message. */
  readonly appUrl: string;
  /** `support@<env domain>`, which the security notices name. */
  readonly supportAddress: string;
}

export function emailSettings(config: DeploymentConfig): EmailSettings {
  const names = hostNames(config);
  return {
    fromAddress: `${FROM_LOCAL_PART}@${names.apex}`,
    identity: names.apex,
    configurationSet: configurationSetName(config.envName),
    region: config.primaryRegion,
    appUrl: `https://${names.app}`,
    supportAddress: `${SUPPORT_LOCAL_PART}@${names.apex}`,
  };
}

/**
 * Lets `fn` send the app's email (backend/src/email/mailer.ts): ses:SendEmail
 * on the domain identity and the configuration set only, and only with the
 * From address `noreply@<env domain>`. Sets the environment mailerFromEnv()
 * reads. No SendRawEmail (it could set arbitrary headers), no templates API,
 * and no other identity.
 */
export function grantSendEmail(fn: LambdaFunction, config: DeploymentConfig): void {
  const email = emailSettings(config);
  const arn = (resource: string, resourceName: string) => Stack.of(fn).formatArn({ service: "ses", region: email.region, resource, resourceName });
  fn.addToRolePolicy(
    new PolicyStatement({
      sid: "SendAppEmail",
      actions: ["ses:SendEmail"],
      resources: [arn("identity", email.identity), arn("configuration-set", email.configurationSet)],
      conditions: { StringEquals: { "ses:FromAddress": email.fromAddress } },
    }),
  );
  fn.addEnvironment(EMAIL_ENV.fromAddress, email.fromAddress);
  fn.addEnvironment(EMAIL_ENV.configurationSet, email.configurationSet);
  fn.addEnvironment(EMAIL_ENV.region, email.region);
  fn.addEnvironment(EMAIL_ENV.appUrl, email.appUrl);
  fn.addEnvironment(EMAIL_ENV.supportAddress, email.supportAddress);
}

/** The support mailbox's local part: `support@<env domain>` (supply-checkout-6qd). */
export const SUPPORT_LOCAL_PART = "support";

/** `support@<env domain>`. */
export const supportAddress = (config: DeploymentConfig): string => `${SUPPORT_LOCAL_PART}@${hostNames(config).apex}`;

/**
 * The display name support replies go out with ("Your name" in Gmail's "send
 * as" settings). The SMTP user's policy requires it (ses:FromDisplayName).
 */
export const SUPPORT_DISPLAY_NAME = "Supply Checkout Support";

/** The IAM user whose SES SMTP credentials Gmail uses to send support replies. */
export const supportSmtpUserName = (envName: string): string => `supply-checkout-${envName}-support-smtp`;

/** Its permissions boundary policy's name. */
export const supportSmtpBoundaryName = (envName: string): string => `${supportSmtpUserName(envName)}-boundary`;

/** Its IAM path (and its boundary's), which sets it apart from any other user. */
export const SUPPORT_SMTP_USER_PATH = "/smtp/";

/**
 * Sends by the support SMTP user in an hour above which its P2 alarm goes off
 * (observability/support-smtp-watch.ts): one person answering support sends
 * far fewer, so more is likely a leaked key.
 */
export const SUPPORT_SENDS_PER_HOUR_ALARM = 50;

/**
 * The CloudWatch dimension the transactional configuration set publishes its
 * sends under: SES's auto-tag naming the IAM identity that sent (the support
 * SMTP user's name, for its sends). Messages without one count as "none".
 */
export const CALLER_IDENTITY_DIMENSION = "ses:caller-identity";

export interface MailForwarder {
  /** The apex's MX records, lowest priority first. */
  readonly mx: readonly { readonly priority: number; readonly hostName: string }[];
}

/**
 * Forwarding services the apex's MX can point at, so mail to support@ reaches
 * a personal inbox (supply-checkout-6qd). ImprovMX's values were checked
 * against its DNS setup guides (improvmx.com/guides) on 2026-10-01.
 *
 * No SPF include for the forwarder: it forwards with SRS (its own envelope
 * sender), so it never needs to pass SPF as this domain, and including it
 * would let its servers pass SPF for the apex. The apex SPF stays SES only.
 */
export const MAIL_FORWARDERS: Readonly<Record<string, MailForwarder>> = Object.freeze({
  improvmx: {
    mx: [
      { priority: 10, hostName: "mx1.improvmx.com" },
      { priority: 20, hostName: "mx2.improvmx.com" },
    ],
  },
});

/**
 * The forwarder that receives the env domain's mail, from `-c supportMail=improvmx`
 * (cdk.json sets it). Only prod uses it: other environments get no apex MX
 * and no support SMTP user. Keep it in cdk.json, like delegatedEnvs: a prod
 * deploy without it removes the MX records, and support@ stops receiving mail.
 */
export function supportMailFromContext(node: { tryGetContext(key: string): unknown }, envName: string): MailForwarder | undefined {
  const value = node.tryGetContext("supportMail");
  if (value === undefined || value === "" || value === false || value === "false") return undefined;
  const name = String(value);
  const forwarder = Object.hasOwn(MAIL_FORWARDERS, name) ? MAIL_FORWARDERS[name] : undefined;
  if (!forwarder) throw new Error(`supportMail must be one of ${Object.keys(MAIL_FORWARDERS).join(", ")} (got "${name}")`);
  return envName === "prod" ? forwarder : undefined;
}

/**
 * The one statement the support SMTP user is allowed, as its policy and as
 * its permissions boundary: ses:SendRawEmail (what SES SMTP sends are
 * authorized as) on the domain identity and the configuration set only, with
 * the sender `support@<env domain>` and the display name SUPPORT_DISPLAY_NAME.
 * No other SES action, identity or AWS API.
 *
 * What it doesn't stop: ses:FromAddress is most likely matched against the
 * envelope sender of an SMTP send, not the From header, so whoever holds the
 * key can probably send any mail the domain identity can, with a header From
 * of noreply@ or anything else at the domain, DKIM-signed and passing DMARC.
 * The display name condition only adds friction. Treat the key like the
 * domain's signing key: hence the alerts on its use and on changes to the
 * user (observability/support-smtp-watch.ts).
 */
export function supportSendStatement(scope: Construct, config: DeploymentConfig): PolicyStatement {
  const email = emailSettings(config);
  const arn = (resource: string, resourceName: string) => Stack.of(scope).formatArn({ service: "ses", region: email.region, resource, resourceName });
  return new PolicyStatement({
    sid: "SendSupportReplies",
    actions: ["ses:SendRawEmail"],
    resources: [arn("identity", email.identity), arn("configuration-set", email.configurationSet)],
    conditions: { StringEquals: { "ses:FromAddress": supportAddress(config), "ses:FromDisplayName": SUPPORT_DISPLAY_NAME } },
  });
}

/** Gives `user` (the support SMTP user) supportSendStatement as its only permission. */
export function grantSendSupportMail(user: User, config: DeploymentConfig): void {
  user.addToPrincipalPolicy(supportSendStatement(user, config));
}
