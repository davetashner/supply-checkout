import { Aws } from "aws-cdk-lib";
import { CfnRule, EventField, type EventPattern, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import { opsResourceNames } from "../../../backend/src/ops/names.js";
import { backupAlertRuleArns } from "../backup-alerts.js";
import { type DeploymentConfig, GLOBAL_SERVICES_REGION, stripeModeOf } from "../config.js";
import { AlarmTopics, alarmContactsFromContext } from "../observability/alarm-topics.js";
import { apiOutputParameters } from "./api-stack.js";
import { auditOutputParameters } from "./audit-stack.js";
import { webOutputParameters } from "./web-stack.js";
import { identityOutputParameters } from "../identity.js";
import { OpsDashboard } from "../observability/dashboard.js";
import { JourneyAlarms } from "../observability/journey-alarms.js";
import { DeletionRecordsWatch } from "../observability/deletion-records-watch.js";
import { OperatorAuditWatch } from "../observability/operator-audit-watch.js";
import { OperatorGroupWatch } from "../observability/operator-group-watch.js";
import { OpsChecks } from "../observability/ops-checks.js";
import { WebAlarms } from "../observability/web-alarms.js";
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

/**
 * EventBridge's default quota on an event pattern is 2,048 characters
 * ("Event pattern size" in the EventBridge quotas; the PutRule API's own
 * limit of 4,096 is not the one that applies). A deploy with a longer pattern
 * fails (supply-checkout-pbp.17), so each rule below covers few enough
 * resources to stay well inside it; the tests measure every pattern with each
 * reference as long as a real name or ARN.
 */
export const EVENT_PATTERN_LIMIT = 2048;

/**
 * Every operator alert rule has a fixed name starting with this, so the two
 * rule-tampering rules watch them all by one prefix: their patterns stay
 * short however many rules there are, and a rule added later with a name
 * from operatorRuleName is watched without changing them.
 */
export const operatorRulePrefix = (envName: string) => `supply-checkout-${envName}-operator-`;

/** The fixed name of an operator alert rule: at most 64 characters with the longest envName (16) and a suffix of up to 22. */
export const operatorRuleName = (envName: string, suffix: string) => `${operatorRulePrefix(envName)}${suffix}`;

/** The suffixes of the operator alert rules' names, by construct ID. */
export const OPERATOR_RULE_SUFFIXES = {
  OperatorPoolChanges: "pool-changes",
  OperatorSelfServiceChanges: "self-service-changes",
  OperatorAuditWatchChanges: "audit-watch-changes",
  OperatorAuditWatchRoleChanges: "audit-watch-role",
  OperatorAuditWatchLogChanges: "audit-watch-logs",
  OperatorAuditWatchTableChanges: "audit-watch-table",
  OperatorAlarmChanges: "alarm-changes",
  OperatorAlertRouteChanges: "alert-route-changes",
  OperatorAlertKeyAndTrailChanges: "alert-key-and-trail",
  OperatorRuleTampering: "rule-tampering",
  OperatorRuleTamperingWatch: "rule-tampering-watch",
} as const;

/**
 * The operator group watch's schedule rule (supply-checkout-3sv.5): under the
 * operator prefix, so the rule-tampering rules alert when it's disabled,
 * deleted or retargeted. It has no event pattern, so it isn't one of
 * OPERATOR_RULE_SUFFIXES.
 */
export const OPERATOR_GROUP_WATCH_RULE_SUFFIX = "group-watch";

/**
 * The state of OperatorPoolChanges: EventBridge also matches CloudTrail
 * management events it counts as read-only. Its pattern names only calls that
 * change something, so this adds no other events; it's there in case
 * EventBridge counts a Cognito call as read-only that CloudTrail records with
 * `readOnly: false`, which would explain AdminAddUserToGroup and
 * AdminRemoveUserFromGroup never reaching the rule (supply-checkout-3sv.5).
 */
export const OPERATOR_POOL_RULE_STATE = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS";

/**
 * The rule that watches the deletion records watch's two rules: fixed, so
 * the operator tampering rules can name it (its name doesn't start with
 * operatorRulePrefix).
 */
export const deletionsRuleTamperingName = (envName: string) => `supply-checkout-${envName}-deletions-rule-tampering`;

/** The name of the second rule-tampering rule. */
export const tamperingWatchRuleName = (envName: string) => operatorRuleName(envName, OPERATOR_RULE_SUFFIXES.OperatorRuleTamperingWatch);

/**
 * Lambda calls that stop the operator audit watch from seeing the stream or
 * change what runs, matched by prefix (CloudTrail adds an API version, e.g.
 * UpdateEventSourceMapping20150331). The mapping's are P1 whoever makes them
 * (Delete) or outside a deploy (Update); the function's outside a deploy.
 */
export const AUDIT_WATCH_MAPPING_EVENTS = { always: ["DeleteEventSourceMapping"], outsideDeploys: ["UpdateEventSourceMapping"] } as const;
export const AUDIT_WATCH_FUNCTION_EVENTS = { always: ["DeleteFunction"], outsideDeploys: ["PutFunctionConcurrency", "UpdateFunctionCode", "UpdateFunctionConfiguration"] } as const;
/** IAM calls on the watch's role that could take away its stream access. */
export const AUDIT_WATCH_ROLE_EVENTS = {
  always: ["DeleteRole", "DeleteRolePolicy", "DetachRolePolicy"],
  outsideDeploys: ["PutRolePolicy", "AttachRolePolicy", "UpdateAssumeRolePolicy", "PutRolePermissionsBoundary"],
} as const;
/**
 * CloudWatch Logs calls that stop the watch's metrics arriving (they're
 * embedded-metric lines in its log group): deleting the group, which its role
 * can't recreate, whoever does it; a transformer or data protection policy
 * that rewrites its lines outside a deploy. And account-wide policies of
 * those kinds (LOG_ACCOUNT_POLICY_TYPES), which this app never makes.
 */
export const AUDIT_WATCH_LOG_EVENTS = { always: ["DeleteLogGroup"], outsideDeploys: ["PutTransformer", "DeleteTransformer", "PutDataProtectionPolicy"] } as const;
export const LOG_ACCOUNT_POLICY_TYPES = ["TRANSFORMER_POLICY", "DATA_PROTECTION_POLICY"] as const;
/**
 * DynamoDB calls that could cut the watch off the table's stream: a resource
 * policy on the table or its stream (a Deny on GetRecords), or UpdateTable
 * (turning the stream off, or another key), outside a deploy. UpdateTable
 * turning the stream off alerts whoever makes it.
 */
export const TABLE_POLICY_EVENTS = { outsideDeploys: ["PutResourcePolicy", "DeleteResourcePolicy"] } as const;
export const TABLE_UPDATE_EVENTS = { outsideDeploys: ["UpdateTable"] } as const;
/** KMS calls that stop the table's key working for the watch (it reads the stream through it), or will. */
export const TABLE_KEY_EVENTS = { always: ["DisableKey", "ScheduleKeyDeletion"], outsideDeploys: ["PutKeyPolicy"] } as const;
/** CloudWatch calls that silence or rewrite the operator audit alarms. */
export const OPERATOR_ALARM_EVENTS = { always: ["DisableAlarmActions", "DeleteAlarms"], outsideDeploys: ["PutMetricAlarm"] } as const;
/** SNS calls that stop an alarm topic delivering: on either topic, or on a subscription to one. */
export const ALARM_TOPIC_EVENTS = { always: ["DeleteTopic", "RemovePermission"], outsideDeploys: ["SetTopicAttributes"] } as const;
/** SNS calls that name the topic in `resourceArn`: a data protection policy can deny every inbound message, and neither topic has one. */
export const ALARM_TOPIC_RESOURCE_EVENTS = { always: ["PutDataProtectionPolicy"] } as const;
export const ALARM_SUBSCRIPTION_EVENTS = { outsideDeploys: ["Unsubscribe", "SetSubscriptionAttributes"] } as const;
/** KMS calls that stop the alarm topics' key working, or will. */
export const ALARM_KEY_EVENTS = { always: ["DisableKey", "ScheduleKeyDeletion"], outsideDeploys: ["PutKeyPolicy"] } as const;
/** KMS calls that point an alias at the topics' key: none is ever made for it, so each alerts, and a call through an alias still names the key in `resources`. */
export const ALARM_KEY_ALIAS_EVENTS = { always: ["CreateAlias", "UpdateAlias"] } as const;
/**
 * CloudTrail calls that stop or narrow a trail in this account: without a
 * trail logging (the audit stack's), none of these rules sees anything.
 */
export const TRAIL_EVENTS = ["StopLogging", "DeleteTrail", "UpdateTrail", "PutEventSelectors", "PutAdvancedEventSelectors"] as const;

/**
 * A deploy's own calls carry this in userIdentity.invokedBy; a person's or a
 * script's have none. It exempts a call made through any CloudFormation
 * stack, not only this app's: someone who can create a stack can make an
 * `outsideDeploys` call unseen (docs/infrastructure.md, "What the rules don't list").
 */
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
 *   Alarms for resources other stacks add later (Cognito) go here too, with
 *   `topics.notify(alarm, severity)`.
 * - `web`: GLOBAL_SERVICES_REGION only, where CloudFront's metrics are: the
 *   P1 alarms on the web distribution's 5xx rate and the router function's
 *   errors (web-alarms.ts), from the web stack's SSM outputs.
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
 * - `operatorGroup`: primary region only, the scheduled check on who is in
 *   the operators group, P1 on any change, which doesn't depend on CloudTrail
 *   reaching EventBridge (operator-group-watch.ts, supply-checkout-3sv.5).
 * - `deletionRecords`: primary region only, the P2 alarm on a deletion
 *   record written over or deleted, from the bucket's S3 events, and the P1
 *   rule on changes to the bucket (deletion-records-watch.ts).
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
  readonly operatorGroup?: OperatorGroupWatch;
  readonly deletionRecords?: DeletionRecordsWatch;
  readonly web?: WebAlarms;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "observability", layer: "stateless" });

    this.topics = new AlarmTopics(this, "AlarmTopics", {
      envName: config.envName,
      contacts: alarmContactsFromContext(this.node),
    });
    const table = tableName(config.envName);
    // The api stack deploys first and publishes its ID in this region
    const apiId = StringParameter.valueForStringParameter(this, apiOutputParameters(config.envName).apiId);
    this.alarms = new JourneyAlarms(this, "JourneyAlarms", { envName: config.envName, region, primary: this.isPrimaryRegion, tableName: table, apiId, topics: this.topics });

    // CloudFront publishes its metrics in GLOBAL_SERVICES_REGION only; the web stack deploys first and publishes these there
    const webIds = region === GLOBAL_SERVICES_REGION
      ? {
          distributionId: StringParameter.valueForStringParameter(this, webOutputParameters(config.envName).distributionId),
          routerFunctionName: StringParameter.valueForStringParameter(this, webOutputParameters(config.envName).routerFunctionName),
        }
      : undefined;
    if (webIds) this.web = new WebAlarms(this, "WebAlarms", { envName: config.envName, ...webIds, topics: this.topics });

    for (const [severity, topic] of Object.entries(this.topics.topics)) {
      new StringParameter(this, `AlarmTopic${severity}Param`, {
        parameterName: `/supply-checkout/${config.envName}/observability/alarm-topic-${severity.toLowerCase()}-arn`,
        stringValue: topic.topicArn,
        description: `SNS topic for ${severity} alarms in this region`,
      });
    }

    if (this.isPrimaryRegion) {
      this.checks = new OpsChecks(this, "OpsChecks", { envName: config.envName, tableName: table, topics: this.topics, stripeMode: stripeModeOf(config) });
      this.operatorAudit = new OperatorAuditWatch(this, "OperatorAuditWatch", { envName: config.envName, region, tableName: table, topics: this.topics });
      this.operatorGroup = new OperatorGroupWatch(this, "OperatorGroupWatch", {
        envName: config.envName,
        region,
        userPoolId: StringParameter.valueForStringParameter(this, identityOutputParameters(config.envName).opsUserPoolId),
        ruleName: operatorRuleName(config.envName, OPERATOR_GROUP_WATCH_RULE_SUFFIX),
        topics: this.topics,
      });
      this.deletionRecords = new DeletionRecordsWatch(this, "DeletionRecordsWatch", { envName: config.envName, region, topics: this.topics });
      // The tampering rules also watch the deletion records watch's two rules (supply-checkout-72d.17)
      this.operatorChanges = this.alertOnOperatorChanges(config.envName, this.operatorAudit, [this.deletionRecords.rule, this.deletionRecords.bucketChanges]);
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
        web: webIds,
        alarms: [...this.alarms.alarms, ...(this.web?.alarms ?? []), this.checks.purgeNotRunning, this.operatorAudit.changed, this.operatorAudit.failing, this.operatorAudit.dropped, this.operatorAudit.silent, this.operatorGroup.changed, this.operatorGroup.silent, this.deletionRecords.rewritten, this.deletionRecords.failing],
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
   * Each rule has a fixed name from operatorRuleName, and each pattern stays
   * well inside EVENT_PATTERN_LIMIT (2,048 characters), which is why the
   * watch's and the alert route's calls are spread over several rules
   * (supply-checkout-pbp.17).
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
   * - `OperatorAuditWatchChanges` (supply-checkout-6uw.11): deleting the
   *   operator audit watch's event source mapping or function whoever does
   *   it, and updating the mapping (disabling it), the function's code,
   *   configuration or concurrency (zero stops it) outside a deploy.
   * - `OperatorAuditWatchRoleChanges`: deleting the watch's role or its role
   *   policies whoever does it, and changing its policies outside a deploy.
   * - `OperatorAuditWatchLogChanges`: deleting the watch's log group whoever
   *   does it, or a transformer or data protection policy on it outside a
   *   deploy (its metric is in its log lines), or such a policy for the whole
   *   account whoever sets it.
   * - `OperatorAuditWatchTableChanges`: a resource policy on the table or
   *   its stream, or UpdateTable, outside a deploy, and UpdateTable turning
   *   the stream off whoever does it; and disabling or scheduling the
   *   deletion of the table key whoever does it, or its policy outside a
   *   deploy. The watch's heartbeat alarm catches whatever else stops it
   *   reading the stream.
   * - `OperatorAlarmChanges`: disabling or deleting the operator audit
   *   alarms whoever does it, and rewriting them outside a deploy.
   * - `OperatorAlertRouteChanges`: deleting either alarm topic, or taking
   *   its permissions away, whoever does it; changing its attributes (its
   *   policy or key) or a subscription to it, including unsubscribing,
   *   outside a deploy; and a data protection policy on either topic,
   *   whoever sets it.
   * - `OperatorAlertKeyAndTrailChanges`: disabling or scheduling the
   *   deletion of the topics' key or the audit stack's trail key whoever does
   *   it, changing either's policy outside a deploy, or pointing an alias at
   *   the topics' key; and stopping, deleting or narrowing any CloudTrail
   *   trail in the account (the audit stack's trail is the one these rules
   *   need, supply-checkout-3sv.3).
   *   Both route rules tell both topics, so deleting one still reaches the other.
   * - `OperatorRuleTampering` and `OperatorRuleTamperingWatch`: deleting or
   *   disabling any rule whose name starts with operatorRulePrefix (every
   *   rule above, and these two), or DeletionsRuleTampering, or removing its
   *   target (OPERATOR_RULE_SILENCING_EVENTS), whoever does it, and
   *   rewriting its pattern or targets (OPERATOR_RULE_CHANGE_EVENTS) outside
   *   a deploy. A rule can't report its own deletion, so there are two, each
   *   watching the other: deleting either first alerts through the other.
   *   What's left is listed under "Operators" in docs/infrastructure.md.
   * - `DeletionsRuleTampering` (supply-checkout-72d.17): the same calls on
   *   `alsoWatched` (the deletion records watch's rule and its bucket-changes
   *   rule), by reference. It has a fixed name, which the two above watch.
   */
  private alertOnOperatorChanges(envName: string, watch: OperatorAuditWatch, alsoWatched: Rule[]): Rule[] {
    const poolId = StringParameter.valueForStringParameter(this, identityOutputParameters(envName).opsUserPoolId);
    const cloudTrail = { detailType: ["AWS API Call via CloudTrail"] };
    const base = { source: ["aws.cognito-idp"], ...cloudTrail };
    const operatorRule = (id: keyof typeof OPERATOR_RULE_SUFFIXES, description: string, eventPattern: EventPattern) =>
      new Rule(this, id, { ruleName: operatorRuleName(envName, OPERATOR_RULE_SUFFIXES[id]), description, eventPattern });
    const admin = operatorRule(
      "OperatorPoolChanges",
      "Operator pool: users, groups, passwords or MFA changed (even by a deploy), or pool and client settings changed outside a deploy (ADR 0015)",
      {
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
    );
    // Read-only management events too (OPERATOR_POOL_RULE_STATE)
    (admin.node.defaultChild as CfnRule).state = OPERATOR_POOL_RULE_STATE;
    const selfService = operatorRule("OperatorSelfServiceChanges", "Operator pool: an operator's token replaced TOTP, changed MFA or attributes, or deleted the user (ADR 0015)", {
      ...base,
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: [...OPERATOR_SELF_SERVICE_EVENTS],
        $or: [{ requestParameters: { userPoolId: [poolId] } }, { additionalEventData: { userPoolId: [poolId] } }],
      },
    });
    // Something that changes the watch, its alarms or the route an alert takes: `always` whoever makes it, `outsideDeploys` unless CloudFormation did
    const calls = (events: { readonly always?: readonly string[]; readonly outsideDeploys?: readonly string[] }, match: Record<string, unknown>, prefix = false) => {
      const names = (list: readonly string[]) => (prefix ? list.map((e) => ({ prefix: e })) : [...list]);
      return [
        ...(events.always?.length ? [{ eventName: names(events.always), ...match }] : []),
        ...(events.outsideDeploys?.length ? [{ eventName: names(events.outsideDeploys), ...match, userIdentity: NOT_CLOUDFORMATION }] : []),
      ];
    };
    // The name as a string (the template knows it), so the patterns hold no references
    const functionName = opsResourceNames(envName).operatorAuditWatchFunction;
    const functionNames = [functionName, { wildcard: `*:function:${functionName}` }, { wildcard: `*:function:${functionName}:*` }];
    const logGroup = watch.logGroup.logGroupName;
    const table = tableName(envName);
    const watchChanges = operatorRule("OperatorAuditWatchChanges", "The operator audit watch's stream mapping or function was deleted, or changed outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.lambda"],
      ...cloudTrail,
      detail: {
        eventSource: ["lambda.amazonaws.com"],
        $or: [
          // Update and Delete name the mapping by its UUID
          ...calls(AUDIT_WATCH_MAPPING_EVENTS, { requestParameters: { uUID: [watch.mapping.eventSourceMappingId] } }, true),
          ...calls(AUDIT_WATCH_FUNCTION_EVENTS, { requestParameters: { functionName: functionNames } }, true),
        ],
      },
    });
    const roleChanges = operatorRule("OperatorAuditWatchRoleChanges", "The operator audit watch's role or its policies were deleted, or changed outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.iam"],
      ...cloudTrail,
      detail: {
        eventSource: ["iam.amazonaws.com"],
        $or: calls(AUDIT_WATCH_ROLE_EVENTS, { requestParameters: { roleName: [watch.role.roleName] } }),
      },
    });
    const logChanges = operatorRule("OperatorAuditWatchLogChanges", "The operator audit watch's log group was deleted, or given a transformer or data protection policy outside a deploy, or one was set for the account (supply-checkout-6uw.11)", {
      source: ["aws.logs"],
      ...cloudTrail,
      detail: {
        eventSource: ["logs.amazonaws.com"],
        $or: [
          // DeleteLogGroup names the group; the transformer and data protection calls take its name or ARN
          ...calls({ always: AUDIT_WATCH_LOG_EVENTS.always }, { requestParameters: { logGroupName: [logGroup] } }),
          ...calls({ outsideDeploys: AUDIT_WATCH_LOG_EVENTS.outsideDeploys }, { requestParameters: { logGroupIdentifier: [logGroup, { wildcard: `*:log-group:${logGroup}` }, { wildcard: `*:log-group:${logGroup}:*` }] } }),
          ...calls({ always: ["PutAccountPolicy"] }, { requestParameters: { policyType: [...LOG_ACCOUNT_POLICY_TYPES] } }),
        ],
      },
    });
    const tableChanges = operatorRule("OperatorAuditWatchTableChanges", "The table's stream or resource policy, or the table key, was disabled, deleted or changed outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.dynamodb", "aws.kms"],
      ...cloudTrail,
      detail: {
        $or: [
          // A resource policy names the table or its stream by ARN; UpdateTable takes its name or ARN
          ...calls(TABLE_POLICY_EVENTS, { eventSource: ["dynamodb.amazonaws.com"], requestParameters: { resourceArn: [watch.tableArn, { prefix: `${watch.tableArn}/stream/` }] } }),
          ...calls(TABLE_UPDATE_EVENTS, { eventSource: ["dynamodb.amazonaws.com"], requestParameters: { tableName: [table, watch.tableArn] } }),
          ...calls({ always: TABLE_UPDATE_EVENTS.outsideDeploys }, { eventSource: ["dynamodb.amazonaws.com"], requestParameters: { tableName: [table, watch.tableArn], streamSpecification: { streamEnabled: [false] } } }),
          ...calls(TABLE_KEY_EVENTS, { eventSource: ["kms.amazonaws.com"], resources: { ARN: [watch.tableKeyArn] } }),
        ],
      },
    });
    const alarmNames = [watch.changed.alarmName, watch.failing.alarmName, watch.dropped.alarmName, watch.silent.alarmName];
    const alarmChanges = operatorRule("OperatorAlarmChanges", "An operator audit alarm was disabled or deleted, or rewritten outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.monitoring"],
      ...cloudTrail,
      detail: {
        eventSource: ["monitoring.amazonaws.com"],
        // DisableAlarmActions and DeleteAlarms take a list, `alarmNames`; PutMetricAlarm one `alarmName`
        $or: [...calls({ always: OPERATOR_ALARM_EVENTS.always }, { requestParameters: { alarmNames } }), ...calls({ outsideDeploys: OPERATOR_ALARM_EVENTS.outsideDeploys }, { requestParameters: { alarmName: alarmNames } })],
      },
    });
    const topics = Object.values(this.topics.topics);
    const topicArns = topics.map((t) => t.topicArn);
    const routeChanges = operatorRule("OperatorAlertRouteChanges", "An alarm topic or a subscription to one was deleted, lost its permissions or was changed outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.sns"],
      ...cloudTrail,
      detail: {
        eventSource: ["sns.amazonaws.com"],
        $or: [
          ...calls(ALARM_TOPIC_EVENTS, { requestParameters: { topicArn: topicArns } }),
          // PutDataProtectionPolicy names the topic in `resourceArn`, not `topicArn`
          ...calls(ALARM_TOPIC_RESOURCE_EVENTS, { requestParameters: { resourceArn: topicArns } }),
          // A subscription's ARN is its topic's ARN, a colon and an ID
          ...calls(ALARM_SUBSCRIPTION_EVENTS, { requestParameters: { subscriptionArn: topicArns.map((arn) => ({ prefix: `${arn}:` })) } }),
        ],
      },
    });
    // The audit stack deploys first and publishes its trail's key ARN in this region
    const trailKeyArn = StringParameter.valueForStringParameter(this, auditOutputParameters(envName).trailKeyArn);
    const keyAndTrailChanges = operatorRule("OperatorAlertKeyAndTrailChanges", "The alarm topics' or trail's key was disabled, scheduled for deletion or changed outside a deploy, an alias pointed at the topics' key, or a CloudTrail trail was stopped or changed (supply-checkout-6uw.11)", {
      source: ["aws.kms", "aws.cloudtrail"],
      ...cloudTrail,
      detail: {
        $or: [
          // KMS takes a key ID, key ARN, alias name or alias ARN; CloudTrail names the key's ARN in `resources` whichever was used.
          // The trail's key too: disabling it stops the trail's log files (supply-checkout-3sv.3)
          ...calls(ALARM_KEY_EVENTS, { eventSource: ["kms.amazonaws.com"], resources: { ARN: [this.topics.key.keyArn, trailKeyArn] } }),
          // An alias made or moved to point at the key (the key ID or ARN in `targetKeyId`)
          ...calls(ALARM_KEY_ALIAS_EVENTS, { eventSource: ["kms.amazonaws.com"], requestParameters: { targetKeyId: [this.topics.key.keyId, this.topics.key.keyArn] } }),
          { eventSource: ["cloudtrail.amazonaws.com"], eventName: [...TRAIL_EVENTS] },
        ],
      },
    });
    // DeleteRule, DisableRule and PutRule name the rule in `name`; RemoveTargets and PutTargets in `rule`.
    const silencing = OPERATOR_RULE_SILENCING_EVENTS.filter((e) => e !== "RemoveTargets");
    const tamperingPattern = (watched: unknown[]): EventPattern => ({
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
    });
    // The deletion records watch's rules get a tampering rule of their own, which the two below watch in turn
    const deletionsTampering = new Rule(this, "DeletionsRuleTampering", {
      ruleName: deletionsRuleTamperingName(envName),
      description: "A deletion records watch rule was deleted, disabled or lost its target, or was rewritten outside a deploy (supply-checkout-72d.17)",
      eventPattern: tamperingPattern(alsoWatched.map((r) => r.ruleName)),
    });
    // Every operator rule by its name's prefix, these two included, so each watches the other and any rule added later
    const watched = [{ prefix: operatorRulePrefix(envName) }, deletionsRuleTamperingName(envName)];
    const tampering = operatorRule("OperatorRuleTampering", "An operator alert rule was deleted, disabled or lost its target, or was rewritten outside a deploy (ADR 0015)", tamperingPattern(watched));
    const tamperingWatch = operatorRule(
      "OperatorRuleTamperingWatch",
      "The same as OperatorRuleTampering, which it watches in turn, so neither can be removed first unseen (supply-checkout-6uw.11)",
      tamperingPattern(watched),
    );
    const rules = [admin, selfService, watchChanges, roleChanges, logChanges, tableChanges, alarmChanges, routeChanges, keyAndTrailChanges, tampering, tamperingWatch, deletionsTampering];
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
      [watchChanges, message("the operator audit watch")],
      [roleChanges, message("the operator audit watch's role")],
      [logChanges, message("the operator audit watch's log group")],
      [tableChanges, message("the table's stream or the table key")],
      [alarmChanges, message("an operator audit alarm")],
      [routeChanges, message("the alarm topics")],
      [keyAndTrailChanges, message("the alarm topics' key or CloudTrail")],
      [tampering, message("an operator alert rule")],
      [tamperingWatch, message("an operator alert rule")],
      [deletionsTampering, message("a deletion records watch rule")],
    ]);
    for (const rule of rules) {
      // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
      rule.addTarget({ bind: () => ({ arn: topic.topicArn, input: messages.get(rule) }) });
    }
    // Changes to the route an alert takes also go to P2: deleting or breaking the P1 topic still reaches someone
    const p2 = this.topics.topics.P2;
    const routeRules = [routeChanges, keyAndTrailChanges];
    for (const rule of routeRules) rule.addTarget({ bind: () => ({ arn: p2.topicArn, input: messages.get(rule) }) });
    p2.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowAlertRouteChangesToPublish",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [p2.topicArn],
        conditions: { ArnEquals: { "aws:SourceArn": routeRules.map((r) => r.ruleArn) } },
      }),
    );
    return rules;
  }
}
