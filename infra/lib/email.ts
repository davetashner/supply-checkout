// Transactional email settings, and the one way to let a Lambda send.
//
// The SES domain identity, its configuration set and the bounce and
// complaint topic are in the primary region's domain stack; the handler for
// those events is the email stack. A function that sends (the account
// function, for invites; billing notices, supply-checkout-x0l) gets
// grantSendEmail(), and nothing else may send.
import { Stack } from "aws-cdk-lib";
import { PolicyStatement, type User } from "aws-cdk-lib/aws-iam";
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
}

export function emailSettings(config: DeploymentConfig): EmailSettings {
  const names = hostNames(config);
  return {
    fromAddress: `${FROM_LOCAL_PART}@${names.apex}`,
    identity: names.apex,
    configurationSet: configurationSetName(config.envName),
    region: config.primaryRegion,
    appUrl: `https://${names.app}`,
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
}

/** The support mailbox's local part: `support@<env domain>` (supply-checkout-6qd). */
export const SUPPORT_LOCAL_PART = "support";

/** `support@<env domain>`. */
export const supportAddress = (config: DeploymentConfig): string => `${SUPPORT_LOCAL_PART}@${hostNames(config).apex}`;

export interface MailForwarder {
  /** The apex's MX records, lowest priority first. */
  readonly mx: readonly { readonly priority: number; readonly hostName: string }[];
  /** What the forwarder asks the apex's SPF record to include. */
  readonly spfInclude: string;
}

/**
 * Forwarding services the apex's MX can point at, so mail to support@ reaches
 * a personal inbox (supply-checkout-6qd). ImprovMX's values were checked
 * against its DNS setup guides (improvmx.com/guides) on 2026-10-01, and
 * spf.improvmx.com was flat (ip4 and ip6 only, no further lookups) that day.
 */
export const MAIL_FORWARDERS: Readonly<Record<string, MailForwarder>> = Object.freeze({
  improvmx: {
    mx: [
      { priority: 10, hostName: "mx1.improvmx.com" },
      { priority: 20, hostName: "mx2.improvmx.com" },
    ],
    spfInclude: "spf.improvmx.com",
  },
});

/**
 * The forwarder that receives the env domain's mail, from `-c supportMail=improvmx`
 * (cdk.json sets it). Only prod uses it: other environments get no apex MX.
 * Keep it in cdk.json, like delegatedEnvs: a prod deploy without it removes
 * the MX records, and support@ stops receiving mail.
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
 * Lets `user` (the support SMTP user) send support replies through SES's
 * SMTP interface: ses:SendRawEmail (what SMTP sends are authorized as) on the
 * domain identity and the configuration set only, and only with the From
 * address `support@<env domain>`. It can't send as noreply@ or any other
 * address, use another identity, or call any other SES action.
 */
export function grantSendSupportMail(user: User, config: DeploymentConfig): void {
  const email = emailSettings(config);
  const arn = (resource: string, resourceName: string) => Stack.of(user).formatArn({ service: "ses", region: email.region, resource, resourceName });
  user.addToPrincipalPolicy(
    new PolicyStatement({
      sid: "SendSupportReplies",
      actions: ["ses:SendRawEmail"],
      resources: [arn("identity", email.identity), arn("configuration-set", email.configurationSet)],
      conditions: { StringEquals: { "ses:FromAddress": supportAddress(config) } },
    }),
  );
}
