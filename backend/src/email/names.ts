// Names the email code and the CDK app share (infra/lib/email.ts and
// infra/lib/stacks/email-stack.ts import this file), so the configuration set
// a Lambda sends through, the From address IAM allows and the tags the bounce
// handler reads can't drift apart. No imports.

/** The local part of the one address the app sends from: `noreply@<env domain>`. */
export const FROM_LOCAL_PART = "noreply";

/** The display name on every message. */
export const FROM_NAME = "Supply Checkout";

/**
 * The SES configuration set every message goes through. It suppresses
 * addresses that bounce or complain (SES's account-level suppression list) and
 * publishes bounce and complaint events to the email-events topic.
 */
export const configurationSetName = (envName: string) => `supply-checkout-${envName}-transactional`;

/** Resources the email stack names, so alarms and docs can refer to them. */
export const emailResourceNames = (envName: string) => ({
  /** SNS topic the configuration set publishes bounce and complaint events to. */
  eventsTopic: `supply-checkout-${envName}-email-events`,
  /** Events the handler couldn't process after Lambda's retries. */
  deadLetterQueue: `supply-checkout-${envName}-email-events-dlq`,
});

/** Environment variables a sending Lambda needs (set by grantSendEmail in infra/lib/email.ts). */
export const EMAIL_ENV = {
  /** `noreply@<env domain>`: the only From address the IAM policy allows. */
  fromAddress: "EMAIL_FROM_ADDRESS",
  /** The configuration set's name. */
  configurationSet: "EMAIL_CONFIGURATION_SET",
  /** The region with the SES identity (the primary region; SES in the second region is phase 2). */
  region: "EMAIL_REGION",
  /** `https://app.<env domain>`: the base of every link in a message. */
  appUrl: "EMAIL_APP_URL",
} as const;

/**
 * Message tags (SES EmailTags). SES copies them into bounce and complaint
 * events, so the events handler knows which invite an address was sent for.
 * Values are IDs only, never an address or a name.
 */
export const EMAIL_TAGS = { kind: "kind", teamId: "teamId", inviteId: "inviteId" } as const;

/** The kinds of message the app sends (templates.ts). */
export const EMAIL_KINDS = ["invite", "trialEnding", "paymentFailed", "readOnly", "exportReady", "teamClosed", "teamReopened", "passwordSet", "twoStepOn", "emailChanged"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/**
 * The only attributes the email-events function may read (GetItem on a team's
 * META item, with a projection) and write (UpdateItem on an invite, including
 * the ones its condition reads). The email stack's IAM policy allows exactly
 * these (dynamodb:Attributes); a test checks the data calls stay within them.
 */
export const EMAIL_EVENTS_READS = ["PK", "SK", "homeRegion"] as const;
// None of the written names may be an attribute other items in a team's
// partition have (a team's `status` is its subscription): the policy pins the
// partition, not the item. GSI2PK is only read, by the update's condition.
export const EMAIL_EVENTS_WRITES = ["PK", "SK", "inviteStatus", "failureReason", "failedAt", "GSI2PK"] as const;
