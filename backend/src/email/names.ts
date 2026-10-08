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
  /** Security notice events (CloudTrail records) the function or EventBridge gave up on, to replay ("Security notices dropped"). */
  securityNoticesDeadLetterQueue: `supply-checkout-${envName}-security-notices-dlq`,
  /**
   * The welcome email function (supply-checkout-6uw.25). A fixed name: the user
   * pool's triggers, in the identity stack (which deploys first), invoke it by
   * name, and the "Welcome emails failing" alarm reads its metrics.
   */
  welcomeFunction: `supply-checkout-${envName}-welcome-email`,
  /** Welcome requests (a user's sub and how they signed up) the function failed on after Lambda's retries, to replay ("Welcome emails dropped"). */
  welcomeDeadLetterQueue: `supply-checkout-${envName}-welcome-email-dlq`,
  /**
   * The password reset function (supply-checkout-6uw.26). A fixed name: the
   * API's password reset function, in the api stack, invokes it by name.
   */
  passwordResetFunction: `supply-checkout-${envName}-password-reset`,
  /**
   * The security notices function (supply-checkout-8jc.28). A fixed name: the
   * user pool's post confirmation trigger, in the identity stack (which deploys
   * first), invokes it by name with a confirmed password reset
   * (supply-checkout-6uw.32).
   */
  securityNoticesFunction: `supply-checkout-${envName}-security-notices`,
});

/** How a new account was made: an email code (Cognito's own sign-up), or a first Google or Apple sign-in. */
export const WELCOME_VIA = ["email", "Google", "SignInWithApple"] as const;
export type WelcomeVia = (typeof WELCOME_VIA)[number];

/**
 * What the user pool's triggers send the welcome email function (an
 * asynchronous invoke): the new account's sub and how it signed up. Never an
 * address or a name: the function looks the user up in the pool itself.
 */
export interface WelcomeRequest {
  readonly userId: string;
  readonly via: WelcomeVia;
}

/** The welcome email function's environment, besides what grantSendEmail sets. */
export const WELCOME_ENV = {
  /** The app pool it looks the new user up in. */
  userPoolId: "USER_POOL_ID",
  /** `support@<env domain>`, which the email names for questions. */
  supportAddress: "SUPPORT_ADDRESS",
} as const;

/**
 * What the API's password reset route (POST /auth/password-reset) hands the
 * password reset function (an asynchronous invoke, supply-checkout-6uw.26),
 * once it has counted the request's limits: the address as the person typed
 * it, trimmed. The function decides everything else, out of the request's
 * sight, so the API's answer can't say whether the address has an account.
 */
export interface PasswordResetRequest {
  readonly email: string;
}

/** The password reset function's environment, besides what grantSendEmail sets. */
export const PASSWORD_RESET_ENV = {
  /** The app pool it looks the address up in. */
  userPoolId: "USER_POOL_ID",
  /** The web app's public client, for Cognito's ForgotPassword. */
  clientId: "CLIENT_ID",
} as const;

/** The triggers' environment: the welcome email function's name, to invoke. Without it, they send no welcome. */
export const WELCOME_FUNCTION_ENV = "WELCOME_FUNCTION";

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
  /** `support@<env domain>`: the security notices tell the reader to write to it (supply-checkout-3sv.12). */
  supportAddress: "EMAIL_SUPPORT_ADDRESS",
} as const;

/**
 * Message tags (SES EmailTags). SES copies them into bounce and complaint
 * events, so the events handler knows which invite an address was sent for.
 * Values are IDs only, never an address or a name.
 */
export const EMAIL_TAGS = { kind: "kind", teamId: "teamId", inviteId: "inviteId" } as const;

/** The kinds of message the app sends (templates.ts). */
export const EMAIL_KINDS = ["invite", "trialEnding", "paymentFailed", "readOnly", "exportReady", "teamClosed", "teamReopened", "deletionWarning", "passwordSet", "twoStepOn", "emailChanged", "passwordReset", "welcome", "passwordResetProvider"] as const;
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
