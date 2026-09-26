// Transactional email settings, and the one way to let a Lambda send.
//
// The SES domain identity, its configuration set and the bounce and
// complaint topic are in the primary region's domain stack; the handler for
// those events is the email stack. A function that sends (the account
// function, for invites; billing notices, supply-checkout-x0l) gets
// grantSendEmail(), and nothing else may send.
import { Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
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
