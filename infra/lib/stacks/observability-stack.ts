import { Aws } from "aws-cdk-lib";
import { EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import { backupAlertRuleArns } from "../backup-alerts.js";
import type { DeploymentConfig } from "../config.js";
import { AlarmTopics, alarmContactsFromContext } from "../observability/alarm-topics.js";
import { apiOutputParameters } from "./api-stack.js";
import { identityOutputParameters } from "../identity.js";
import { OpsDashboard } from "../observability/dashboard.js";
import { JourneyAlarms } from "../observability/journey-alarms.js";
import { DeletionRecordsWatch } from "../observability/deletion-records-watch.js";
import { OperatorAuditWatch } from "../observability/operator-audit-watch.js";
import { OpsChecks } from "../observability/ops-checks.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * Calls on the operator pool that change who is an operator or how they sign
 * in: users, group membership, passwords and MFA. Each alerts P1 whoever
 * makes it, CloudFormation included (supply-checkout-6uw.7): a stack deploy
 * must never add an operator silently.
 */
export const OPERATOR_USER_EVENTS = [
  "AdminCreateUser",
  "AdminAddUserToGroup",
  "AdminRemoveUserFromGroup",
  "AdminSetUserPassword",
  "AdminResetUserPassword",
  "AdminEnableUser",
  "AdminSetUserMFAPreference",
  "AdminUpdateUserAttributes",
  "AdminLinkProviderForUser",
] as const;

/**
 * Configuration calls on the operator pool: its groups, settings, app client
 * and identity providers. Each alerts P1 unless CloudFormation made it for a
 * deploy, which is how they're meant to change.
 */
export const OPERATOR_POOL_CONFIG_EVENTS = [
  "CreateGroup",
  "UpdateGroup",
  "DeleteGroup",
  "UpdateUserPool",
  "SetUserPoolMfaConfig",
  "CreateUserPoolClient",
  "UpdateUserPoolClient",
  "CreateIdentityProvider",
] as const;

/** Every admin and configuration call on the operator pool that alerts P1 (ADR 0015). */
export const OPERATOR_POOL_ADMIN_EVENTS = [...OPERATOR_USER_EVENTS, ...OPERATOR_POOL_CONFIG_EVENTS] as const;

/**
 * EventBridge calls that silence one of the operator alert rules: delete or
 * disable it, or take its target away. Each alerts P1 whoever makes it,
 * CloudFormation included (supply-checkout-6uw.7).
 */
export const OPERATOR_RULE_SILENCING_EVENTS = ["DeleteRule", "DisableRule", "RemoveTargets"] as const;

/** EventBridge calls that rewrite an operator alert rule's pattern or targets: P1 unless CloudFormation made them for a deploy. */
export const OPERATOR_RULE_CHANGE_EVENTS = ["PutRule", "PutTargets"] as const;

/** A deploy's own calls carry this in userIdentity.invokedBy; a person's or a script's have none. */
const NOT_CLOUDFORMATION = { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] };

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
 *   StuckImports and EmailQuotaUsedPercent gauges, and the closed-team purge
 *   with its "Deletion job not running" alarm (ops-checks.ts).
 * - `operatorChanges`: primary region only, P1 alerts on changes to the
 *   operator pool's users, groups, passwords, MFA and settings, on what an
 *   operator's own token can change (ADR 0015), and on anything that
 *   silences or rewrites those rules, from CloudTrail through EventBridge.
 *   The P1 topic also takes the backup stack's alerts on changes to its
 *   vault, plan and key (backup-alerts.ts).
 * - `operatorAudit`: primary region only, the P1 alarm on any change or
 *   deletion of an operator audit item other than its TTL expiry, from the
 *   table's stream (operator-audit-watch.ts).
 * - `deletionRecords`: primary region only, the P2 alarm on a deletion
 *   record written over or deleted, from the bucket's S3 events
 *   (deletion-records-watch.ts).
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
  readonly operatorAudit?: OperatorAuditWatch;
  readonly deletionRecords?: DeletionRecordsWatch;

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
      this.checks = new OpsChecks(this, "OpsChecks", { envName: config.envName, tableName: table, topics: this.topics });
      this.deletionRecords = new DeletionRecordsWatch(this, "DeletionRecordsWatch", { envName: config.envName, region, topics: this.topics });
      // The tampering rule also watches the deletion records watch's two rules (supply-checkout-72d.17)
      this.operatorChanges = this.alertOnOperatorChanges(config.envName, [this.deletionRecords.rule, this.deletionRecords.bucketChanges]);
      this.operatorAudit = new OperatorAuditWatch(this, "OperatorAuditWatch", { envName: config.envName, region, topics: this.topics });
      // The backup stack (primary region, deployed after this one) alerts P1
      // when its vault, plan or key is changed (backup-alerts.ts): only its
      // two rules, by name, may publish
      this.topics.topics.P1.addToResourcePolicy(
        new PolicyStatement({
          sid: "AllowBackupChangeAlertsToPublish",
          principals: [new ServicePrincipal("events.amazonaws.com")],
          actions: ["sns:Publish"],
          resources: [this.topics.topics.P1.topicArn],
          conditions: { ArnEquals: { "aws:SourceArn": backupAlertRuleArns(config.envName, "workload") } },
        }),
      );
      this.dashboard = new OpsDashboard(this, "Dashboard", {
        envName: config.envName,
        regions: config.regions,
        tableName: table,
        alarms: [
          ...this.alarms.alarms,
          this.checks.purgeNotRunning,
          this.operatorAudit.changed,
          this.operatorAudit.failing,
          this.deletionRecords.rewritten,
          this.deletionRecords.failing,
        ],
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
   * - `OperatorPoolChanges`: the user, membership, password and MFA calls in
   *   OPERATOR_USER_EVENTS on the operator pool, whoever makes them, and the
   *   configuration calls in OPERATOR_POOL_CONFIG_EVENTS unless
   *   CloudFormation made them for a deploy (supply-checkout-6uw.7). A
   *   template that created an operator user or added one to the group would
   *   still alert.
   * - `OperatorSelfServiceChanges`: what an operator's own access token can
   *   do with the aws.cognito.signin.user.admin scope (OPERATOR_SELF_SERVICE_EVENTS):
   *   replace their TOTP, turn MFA settings, change attributes or delete
   *   themselves. A stolen token could use these to keep access. CloudTrail
   *   puts the pool ID in requestParameters or additionalEventData for
   *   these, so the rule matches either ("Operators" in docs/infrastructure.md
   *   says how to check it after a deploy).
   * - `OperatorRuleTampering`: deleting or disabling either rule above, or
   *   removing its target (OPERATOR_RULE_SILENCING_EVENTS), whoever does it,
   *   and rewriting its pattern or targets (OPERATOR_RULE_CHANGE_EVENTS)
   *   outside a deploy. `alsoWatched` rules (the deletion records watch's
   *   two) are watched the same way. A rule can't report its own deletion, so this is a
   *   separate rule; silencing this one first isn't caught (see "Operators"
   *   in docs/infrastructure.md).
   */
  private alertOnOperatorChanges(envName: string, alsoWatched: Rule[]): Rule[] {
    const poolId = StringParameter.valueForStringParameter(this, identityOutputParameters(envName).opsUserPoolId);
    const cloudTrail = { detailType: ["AWS API Call via CloudTrail"] };
    const base = { source: ["aws.cognito-idp"], ...cloudTrail };
    const admin = new Rule(this, "OperatorPoolChanges", {
      description: "Operator pool: users, groups, passwords or MFA changed (even by a deploy), or pool and client settings changed outside a deploy (ADR 0015)",
      eventPattern: {
        ...base,
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          requestParameters: { userPoolId: [poolId] },
          $or: [
            // Who is an operator and how they sign in: always
            { eventName: [...OPERATOR_USER_EVENTS] },
            // How the pool is set up: not CloudFormation's own calls during a deploy
            { eventName: [...OPERATOR_POOL_CONFIG_EVENTS], userIdentity: NOT_CLOUDFORMATION },
          ],
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
    // DeleteRule, DisableRule and PutRule name the rule in `name`; RemoveTargets and PutTargets in `rule`
    const watched = [admin.ruleName, selfService.ruleName, ...alsoWatched.map((r) => r.ruleName)];
    const silencing = OPERATOR_RULE_SILENCING_EVENTS.filter((e) => e !== "RemoveTargets");
    const tampering = new Rule(this, "OperatorRuleTampering", {
      description: "An operator alert rule was deleted, disabled or lost its target, or was rewritten outside a deploy (ADR 0015)",
      eventPattern: {
        source: ["aws.events"],
        ...cloudTrail,
        detail: {
          eventSource: ["events.amazonaws.com"],
          $or: [
            { eventName: [...silencing], requestParameters: { name: watched } },
            { eventName: ["RemoveTargets"], requestParameters: { rule: watched } },
            { eventName: ["PutRule"], requestParameters: { name: watched }, userIdentity: NOT_CLOUDFORMATION },
            { eventName: ["PutTargets"], requestParameters: { rule: watched }, userIdentity: NOT_CLOUDFORMATION },
          ],
        },
      },
    });
    const rules = [admin, selfService, tampering];
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
        conditions: { ArnEquals: { "aws:SourceArn": rules.map((r) => r.ruleArn) } },
      }),
    );
    const message = (what: string) =>
      RuleTargetInput.fromText(
        `Supply Checkout ${envName}: ${EventField.fromPath("$.detail.eventName")} on ${what} at ${EventField.fromPath("$.detail.eventTime")} (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). If nobody expected it, follow "Operators" in docs/infrastructure.md.`,
      );
    const messages = new Map([
      [admin, message("the operator pool")],
      [selfService, message("the operator pool")],
      [tampering, message("a watched alert rule (the operator pool's or the deletion records')")],
    ]);
    for (const rule of rules) {
      // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
      rule.addTarget({ bind: () => ({ arn: topic.topicArn, input: messages.get(rule) }) });
    }
    return rules;
  }
}
