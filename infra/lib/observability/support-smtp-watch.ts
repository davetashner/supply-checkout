import { Aws, Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { CALLER_IDENTITY_DIMENSION, SUPPORT_SENDS_PER_HOUR_ALARM, supportSmtpUserName } from "../email.js";
import type { AlarmTopics } from "./alarm-topics.js";

/**
 * IAM calls that give the support SMTP user a new or re-enabled key, more
 * permissions, a console password or a looser boundary, or take its key away
 * (supply-checkout-6qd). Each alerts P2, CloudFormation's included: none is
 * made by an ordinary deploy except the first (PutUserPolicy and
 * PutUserPermissionsBoundary), and the owner's own key rotation.
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
] as const;

/** The rule's fixed name: under the operator prefix, so the operator rule-tampering rules watch it too. */
export const supportSmtpRuleName = (envName: string) => `supply-checkout-${envName}-support-smtp-user`;

export interface SupportSmtpWatchProps {
  readonly envName: string;
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
 * - `userChanges`: P2 on SUPPORT_SMTP_USER_EVENTS naming the user, from
 *   CloudTrail through EventBridge. Only this rule, by ARN, may publish to
 *   the P2 topic for it, and EventBridge may use the topics' key.
 * - `sends`: P2 when the user sends more than SUPPORT_SENDS_PER_HOUR_ALARM
 *   messages in an hour, from the transactional configuration set's sends by
 *   ses:caller-identity (the domain stack's SendsByCaller event destination).
 *   A leaked key is most likely used to send a lot.
 */
export class SupportSmtpWatch extends Construct {
  readonly userChanges?: Rule;
  readonly sends?: Alarm;

  constructor(scope: Construct, id: string, props: SupportSmtpWatchProps) {
    super(scope, id);
    const userName = supportSmtpUserName(props.envName);

    if (props.userChanges) {
      const rule = new Rule(this, "UserChanges", {
        ruleName: supportSmtpRuleName(props.envName),
        description: "The support SMTP user got or lost an access key, more permissions, a password or another boundary (supply-checkout-6qd)",
        eventPattern: {
          source: ["aws.iam"],
          detailType: ["AWS API Call via CloudTrail"],
          detail: { eventSource: ["iam.amazonaws.com"], eventName: [...SUPPORT_SMTP_USER_EVENTS], requestParameters: { userName: [userName] } },
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
      this.sends = new Alarm(this, "Sends", {
        alarmName: `supply-checkout-${props.envName}-p2-support-smtp-sends`,
        alarmDescription:
          `P2. Support SMTP sends: the support SMTP user sent more than ${SUPPORT_SENDS_PER_HOUR_ALARM} messages in an hour, far more than one person answering support. Its key may be leaked. ` +
          'Runbook: docs/infrastructure.md, "When the support SMTP key may be leaked".',
        metric: new Metric({
          namespace: "AWS/SES",
          metricName: "Send",
          dimensionsMap: { [CALLER_IDENTITY_DIMENSION]: userName },
          statistic: "Sum",
          period: Duration.hours(1),
          label: "Support SMTP sends",
        }),
        threshold: SUPPORT_SENDS_PER_HOUR_ALARM,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      props.topics.notify(this.sends, "P2");
    }
  }
}
