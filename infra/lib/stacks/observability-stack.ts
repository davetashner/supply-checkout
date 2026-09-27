import { Aws } from "aws-cdk-lib";
import { EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import type { DeploymentConfig } from "../config.js";
import { AlarmTopics, alarmContactsFromContext } from "../observability/alarm-topics.js";
import { apiOutputParameters } from "./api-stack.js";
import { identityOutputParameters } from "../identity.js";
import { OpsDashboard } from "../observability/dashboard.js";
import { JourneyAlarms } from "../observability/journey-alarms.js";
import { OpsChecks } from "../observability/ops-checks.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/** Admin and configuration calls on the operator pool that alert P1 (ADR 0015), unless CloudFormation made them. */
export const OPERATOR_POOL_ADMIN_EVENTS = [
  "AdminCreateUser",
  "AdminAddUserToGroup",
  "AdminRemoveUserFromGroup",
  "AdminSetUserPassword",
  "AdminResetUserPassword",
  "AdminEnableUser",
  "AdminSetUserMFAPreference",
  "AdminUpdateUserAttributes",
  "AdminLinkProviderForUser",
  "CreateGroup",
  "UpdateGroup",
  "DeleteGroup",
  "UpdateUserPool",
  "SetUserPoolMfaConfig",
  "CreateUserPoolClient",
  "UpdateUserPoolClient",
  "CreateIdentityProvider",
] as const;

/** What an operator's own access token can change (the aws.cognito.signin.user.admin scope); each alerts P1. */
export const OPERATOR_SELF_SERVICE_EVENTS = ["AssociateSoftwareToken", "VerifySoftwareToken", "SetUserMFAPreference", "UpdateUserAttributes", "DeleteUser"] as const;

/**
 * Alarms, dashboards and (later) synthetics canaries for the stacks in this
 * region (supply-checkout-7pe, docs/journeys.md).
 *
 * - `topics`: SNS topics per severity. P1 goes to email and SMS, P2 to email.
 *   Recipients are SSM parameters in the account, read at deploy time
 *   (see alarm-topics.ts); nothing personal is in this repository.
 * - `alarms`: the journey alarms whose metrics exist in this region,
 *   including the API's (its ID comes from the api stack's SSM parameter).
 *   Alarms for resources other stacks add later (Cognito, CloudFront) go
 *   here too, with `topics.notify(alarm, severity)`.
 * - `dashboard`: primary region only, drawing every region's metrics.
 * - `checks`: primary region only, the scheduled checks that send the
 *   StuckImports and EmailQuotaUsedPercent gauges (ops-checks.ts).
 * - `operatorChanges`: primary region only, P1 alerts on changes to the
 *   operator pool's users, groups, passwords, MFA and settings, and on what
 *   an operator's own token can change (ADR 0015), from CloudTrail through
 *   EventBridge.
 *
 * Log retention and X-Ray tracing for every function are set app-wide by
 * ObservabilityDefaults (observability/defaults.ts).
 */
export class ObservabilityStack extends SupplyCheckoutStack {
  readonly topics: AlarmTopics;
  readonly alarms: JourneyAlarms;
  readonly dashboard?: OpsDashboard;
  readonly checks?: OpsChecks;
  readonly operatorChanges?: Rule[];

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "observability", layer: "stateless" });

    this.topics = new AlarmTopics(this, "AlarmTopics", {
      envName: config.envName,
      contacts: alarmContactsFromContext(this.node),
    });
    const table = tableName(config.envName);
    // The api stack deploys first and publishes its ID in this region
    const apiId = StringParameter.valueForStringParameter(this, apiOutputParameters(config.envName).apiId);
    this.alarms = new JourneyAlarms(this, "JourneyAlarms", { envName: config.envName, region, tableName: table, apiId, topics: this.topics });

    for (const [severity, topic] of Object.entries(this.topics.topics)) {
      new StringParameter(this, `AlarmTopic${severity}Param`, {
        parameterName: `/supply-checkout/${config.envName}/observability/alarm-topic-${severity.toLowerCase()}-arn`,
        stringValue: topic.topicArn,
        description: `SNS topic for ${severity} alarms in this region`,
      });
    }

    if (this.isPrimaryRegion) {
      this.checks = new OpsChecks(this, "OpsChecks", { envName: config.envName, tableName: table });
      this.operatorChanges = this.alertOnOperatorChanges(config.envName);
      this.dashboard = new OpsDashboard(this, "Dashboard", {
        envName: config.envName,
        regions: config.regions,
        tableName: table,
        alarms: this.alarms.alarms,
      });
    }
  }

  /**
   * ADR 0015's alerts on the operator pool, from CloudTrail through
   * EventBridge (management events reach EventBridge in the region of the
   * call), to the P1 topic. Changes to who is an operator, how they sign in,
   * or how the pool and its client are set up are rare and deliberate, so
   * every one is worth a message; one nobody expected is an escalation.
   *
   * - `OperatorPoolAdminChanges`: the admin and configuration calls in
   *   OPERATOR_POOL_ADMIN_EVENTS on the operator pool, except those
   *   CloudFormation makes for a deploy.
   * - `OperatorSelfServiceChanges`: what an operator's own access token can
   *   do with the aws.cognito.signin.user.admin scope (OPERATOR_SELF_SERVICE_EVENTS):
   *   replace their TOTP, turn MFA settings, change attributes or delete
   *   themselves. A stolen token could use these to keep access. CloudTrail
   *   puts the pool ID in requestParameters or additionalEventData for
   *   these, so the rule matches either ("Operators" in docs/infrastructure.md
   *   says how to check it after a deploy).
   */
  private alertOnOperatorChanges(envName: string): Rule[] {
    const poolId = StringParameter.valueForStringParameter(this, identityOutputParameters(envName).opsUserPoolId);
    const base = { source: ["aws.cognito-idp"], detailType: ["AWS API Call via CloudTrail"] };
    const admin = new Rule(this, "OperatorPoolChanges", {
      description: "Operator pool: users, groups, passwords, MFA or pool and client settings changed outside a deploy (ADR 0015)",
      eventPattern: {
        ...base,
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          eventName: [...OPERATOR_POOL_ADMIN_EVENTS],
          requestParameters: { userPoolId: [poolId] },
          // Not CloudFormation's own calls during a deploy (an absent invokedBy is a person or a script)
          userIdentity: { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] },
        },
      },
    });
    const selfService = new Rule(this, "OperatorSelfServiceChanges", {
      description: "Operator pool: an operator's token replaced TOTP, changed MFA or attributes, or deleted the user (ADR 0015)",
      eventPattern: {
        ...base,
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          eventName: [...OPERATOR_SELF_SERVICE_EVENTS],
          $or: [{ requestParameters: { userPoolId: [poolId] } }, { additionalEventData: { userPoolId: [poolId] } }],
        },
      },
    });
    const topic = this.topics.topics.P1;
    // EventBridge publishes to the encrypted topic: it may use the key, for this account's rules only
    this.topics.key.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
    );
    // Only these rules may publish to the topic (not any rule in the account)
    topic.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowOperatorPoolAlertToPublish",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: { ArnEquals: { "aws:SourceArn": [admin.ruleArn, selfService.ruleArn] } },
      }),
    );
    const message = RuleTargetInput.fromText(
      `Supply Checkout ${envName}: ${EventField.fromPath("$.detail.eventName")} on the operator pool at ${EventField.fromPath("$.detail.eventTime")} (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). If nobody expected it, follow "Operators" in docs/infrastructure.md.`,
    );
    for (const rule of [admin, selfService]) {
      // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
      rule.addTarget({ bind: () => ({ arn: topic.topicArn, input: message }) });
    }
    return [admin, selfService];
  }
}
