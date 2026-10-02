import { Aws, Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { EventField, Match, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { CALLER_IDENTITY_DIMENSION, SUPPORT_SENDS_PER_HOUR_ALARM, SUPPORT_SMTP_USER_PATH, supportSmtpBoundaryName, supportSmtpUserName } from "../email.js";
import type { AlarmTopics } from "./alarm-topics.js";

/**
 * IAM calls on the support SMTP user that give it a new or re-enabled key or
 * other credential, more permissions, a console password or a looser
 * boundary, take its key away, or rename it (which would take it out of both
 * alerts: UpdateUser logs the old name in requestParameters.userName)
 * (supply-checkout-6qd). Each alerts P2, CloudFormation's included: a deploy
 * makes them only when it changes the user's policy or boundary, and the
 * owner when rotating the key.
 */
export const SUPPORT_SMTP_USER_EVENTS = [
  "CreateAccessKey",
  "UpdateAccessKey",
  "DeleteAccessKey",
  "PutUserPolicy",
  "AttachUserPolicy",
  "AddUserToGroup",
  "CreateLoginProfile",
  "UpdateLoginProfile",
  "PutUserPermissionsBoundary",
  "DeleteUserPermissionsBoundary",
  "UpdateUser",
  "CreateServiceSpecificCredential",
  "UploadSigningCertificate",
  "UploadSSHPublicKey",
] as const;

/**
 * IAM calls that rewrite the user's permissions boundary policy in place: a
 * new default version would widen the boundary without touching the user.
 * Matched on the policy's ARN.
 */
export const SUPPORT_SMTP_BOUNDARY_EVENTS = ["CreatePolicyVersion", "SetDefaultPolicyVersion"] as const;

/** Sends by the user in a day above which the daily P2 alarm goes off. */
export const SUPPORT_SENDS_PER_DAY_ALARM = 150;

/** The boundary policy's ARN (the domain stack's SupportSmtpBoundary). */
export const supportSmtpBoundaryArn = (envName: string) => `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy${SUPPORT_SMTP_USER_PATH}${supportSmtpBoundaryName(envName)}`;

export interface SupportSmtpWatchProps {
  readonly envName: string;
  /**
   * The rule's fixed name. The observability stack names it under the
   * operator prefix (operatorRuleName), so the operator rule-tampering rules,
   * in the primary region, watch it too: that holds while the primary region
   * is GLOBAL_SERVICES_REGION, as it is for prod (a test checks).
   */
  readonly ruleName: string;
  /** The region this stack is in. */
  readonly region: string;
  readonly topics: AlarmTopics;
  /**
   * Watch IAM calls on the user. Only in GLOBAL_SERVICES_REGION: CloudTrail
   * delivers IAM's (global) events to EventBridge there.
   */
  readonly userChanges: boolean;
  /** Alarm on the user's sends. Only in the primary region, where SES sends. */
  readonly sends: boolean;
}

/**
 * Alerts for the support SMTP user (supply-checkout-6qd), whose access key
 * lives in Gmail's settings and can send mail as the domain:
 *
 * - `userChanges`: P2 on SUPPORT_SMTP_USER_EVENTS naming the user (in any
 *   case), and SUPPORT_SMTP_BOUNDARY_EVENTS on its boundary policy, from
 *   CloudTrail through EventBridge. Only this rule, by ARN, may publish to
 *   the P2 topic for it, and EventBridge may use the topics' key.
 * - `sends` and `dailySends`: P2 when the user sends more than
 *   SUPPORT_SENDS_PER_HOUR_ALARM messages in an hour, or
 *   SUPPORT_SENDS_PER_DAY_ALARM in a day, from the transactional configuration set's sends by
 *   ses:caller-identity (the domain stack's SendsByCaller event destination).
 *   A leaked key is most likely used to send a lot.
 */
export class SupportSmtpWatch extends Construct {
  readonly userChanges?: Rule;
  readonly sends?: Alarm;
  readonly dailySends?: Alarm;

  constructor(scope: Construct, id: string, props: SupportSmtpWatchProps) {
    super(scope, id);
    const userName = supportSmtpUserName(props.envName);

    if (props.userChanges) {
      const rule = new Rule(this, "UserChanges", {
        ruleName: props.ruleName,
        description: "The support SMTP user got or lost a key, credential, permissions, a password or its boundary, or was renamed, or its boundary policy was rewritten (supply-checkout-6qd)",
        eventPattern: {
          source: ["aws.iam"],
          detailType: ["AWS API Call via CloudTrail"],
          detail: {
            eventSource: ["iam.amazonaws.com"],
            // IAM names are case-insensitive: SupplyCheckout-... names the same user
            $or: [
              { eventName: [...SUPPORT_SMTP_USER_EVENTS], requestParameters: { userName: Match.equalsIgnoreCase(userName) } },
              { eventName: [...SUPPORT_SMTP_BOUNDARY_EVENTS], requestParameters: { policyArn: Match.equalsIgnoreCase(supportSmtpBoundaryArn(props.envName)) } },
            ],
          },
        },
      });
      const p2 = props.topics.topics.P2;
      p2.addToResourcePolicy(
        new PolicyStatement({
          sid: "AllowSupportSmtpUserAlertToPublish",
          principals: [new ServicePrincipal("events.amazonaws.com")],
          actions: ["sns:Publish"],
          resources: [p2.topicArn],
          conditions: { ArnEquals: { "aws:SourceArn": rule.ruleArn } },
        }),
      );
      // The topic is encrypted: EventBridge may use its key, for this account's
      // rules (as the operator alerts allow in the primary region). Naming
      // this rule's ARN would make the key depend on the rule, which depends
      // on the topic, which depends on the key. The topic policy above still
      // lets only this rule publish.
      props.topics.key.addToResourcePolicy(
        new PolicyStatement({
          sid: "AllowSupportSmtpUserAlertToEncrypt",
          principals: [new ServicePrincipal("events.amazonaws.com")],
          actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
          resources: ["*"],
          conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
        }),
      );
      const message = RuleTargetInput.fromText(
        `Supply Checkout ${props.envName}: ${EventField.fromPath("$.detail.eventName")} on the support SMTP user at ${EventField.fromPath("$.detail.eventTime")} (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). Expected only when the owner rotates its key, and PutUserPolicy or PutUserPermissionsBoundary in a deploy of the domain stack. Otherwise follow "When the support SMTP key may be leaked" in docs/infrastructure.md.`,
      );
      // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
      rule.addTarget({ bind: () => ({ arn: p2.topicArn, input: message }) });
      this.userChanges = rule;
    }

    if (props.sends) {
      const sendsAlarm = (id: string, name: string, period: Duration, threshold: number, when: string) => {
        const alarm = new Alarm(this, id, {
          alarmName: `supply-checkout-${props.envName}-p2-${name}`,
          alarmDescription:
            `P2. Support SMTP sends: the support SMTP user sent more than ${threshold} messages in ${when}, far more than one person answering support. Its key may be leaked. ` +
            'Runbook: docs/infrastructure.md, "When the support SMTP key may be leaked".',
          metric: new Metric({
            namespace: "AWS/SES",
            metricName: "Send",
            dimensionsMap: { [CALLER_IDENTITY_DIMENSION]: userName },
            statistic: "Sum",
            period,
            label: `Support SMTP sends in ${when}`,
          }),
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        });
        props.topics.notify(alarm, "P2");
        return alarm;
      };
      this.sends = sendsAlarm("Sends", "support-smtp-sends", Duration.hours(1), SUPPORT_SENDS_PER_HOUR_ALARM, "an hour");
      // A slower leak, under the hourly limit
      this.dailySends = sendsAlarm("DailySends", "support-smtp-daily-sends", Duration.days(1), SUPPORT_SENDS_PER_DAY_ALARM, "a day");
    }
  }
}
