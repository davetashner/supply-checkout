import { Aws } from "aws-cdk-lib";
import type { Alarm } from "aws-cdk-lib/aws-cloudwatch";
import { CfnRule, EventField, type EventPattern, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import { operatorGroupSnapshotParameter, opsResourceNames } from "../../../backend/src/ops/names.js";
import { backupAlertRuleArns, backupJobAlertRuleArn } from "../backup-alerts.js";
import { type DeploymentConfig, GLOBAL_SERVICES_REGION, stripeModeOf } from "../config.js";
import { AlarmTopics, alarmContactsFromContext, alarmRecipientParameterPrefix } from "../observability/alarm-topics.js";
import { apiOutputParameters } from "./api-stack.js";
import { auditOutputParameters, trailBucketName } from "./audit-stack.js";
import { webOutputParameters } from "./web-stack.js";
import { identityOutputParameters } from "../identity.js";
import { OpsDashboard } from "../observability/dashboard.js";
import { JourneyAlarms } from "../observability/journey-alarms.js";
import { DeletionRecordsWatch } from "../observability/deletion-records-watch.js";
import { photosDownloadAlarm } from "../observability/photos-alarm.js";
import { OperatorAuditWatch } from "../observability/operator-audit-watch.js";
import { OperatorGroupWatch } from "../observability/operator-group-watch.js";
import { OpsChecks } from "../observability/ops-checks.js";
import { BY_CLOUDFORMATION, NOT_CLOUDFORMATION } from "../observability/cloudtrail.js";
import { COST_ALERT_RULE_SUFFIX, CostAlerts, costAlertsFromContext } from "../observability/cost-alerts.js";
import { WebAlarms } from "../observability/web-alarms.js";
import { SupportSmtpWatch } from "../observability/support-smtp-watch.js";
import { supportMailFromContext } from "../email.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * Calls on the operator pool that change who is an operator or how they sign
 * in: users, group membership, passwords and MFA. Each alerts P1 whoever
 * makes it, CloudFormation included (supply-checkout-6uw.7): a stack deploy
 * must never add an operator silently. Deleting one too: deleting every
 * operator would lock responders out (supply-checkout-6uw.16).
 */
export const OPERATOR_USER_EVENTS = [
  "AdminCreateUser",
  "AdminDeleteUser",
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
 * Configuration calls on the operator pool: its groups, settings, app client,
 * domain, managed login branding and identity providers. Each alerts P1
 * unless CloudFormation made it for a deploy, which is how they're meant to
 * change. Deleting or changing the ops client or domain locks every operator
 * out; identity provider changes are watched so one can't be added and
 * repointed unseen (the ops client supports only COGNITO, so they aren't
 * themselves a lockout) (supply-checkout-6uw.19). A second, custom domain,
 * and deleting or changing the ops client's branding (its only managed login
 * style, so deleting it likely breaks operator sign-in) too
 * (supply-checkout-6uw.20).
 */
export const OPERATOR_POOL_CONFIG_EVENTS = [
  "CreateGroup",
  "UpdateGroup",
  "DeleteGroup",
  "UpdateUserPool",
  "SetUserPoolMfaConfig",
  "CreateUserPoolClient",
  "UpdateUserPoolClient",
  "DeleteUserPoolClient",
  "UpdateUserPoolDomain",
  "DeleteUserPoolDomain",
  "CreateUserPoolDomain",
  "DeleteManagedLoginBranding",
  "UpdateManagedLoginBranding",
  "CreateIdentityProvider",
  "UpdateIdentityProvider",
  "DeleteIdentityProvider",
] as const;

/**
 * The ops client's managed login branding calls (supply-checkout-6uw.21):
 * UpdateManagedLoginBranding takes UserPoolId as optional, so a call naming
 * only the branding ID logs no requestParameters.userPoolId and
 * OperatorPoolChanges can't see it. OperatorBrandingChanges matches these by
 * the branding's ID instead. Both are in OPERATOR_POOL_CONFIG_EVENTS too.
 */
export const OPERATOR_BRANDING_EVENTS = ["DeleteManagedLoginBranding", "UpdateManagedLoginBranding"] as const;

/**
 * The operator pool itself (supply-checkout-6uw.20): DeleteUserPool, and an
 * UpdateUserPool that leaves deletion protection anything but ACTIVE (an
 * UpdateUserPool resets a setting it isn't given to its default, which for
 * DeletionProtection is INACTIVE). OperatorPoolProtection alerts P1 on these
 * whoever makes them: no deploy should turn the ops pool's protection off.
 */
export const OPERATOR_POOL_PROTECTION_EVENTS = ["DeleteUserPool", "UpdateUserPool"] as const;

/**
 * Calls that lock an operator out without deleting them: disabling them, or
 * ending every session they have. P1 outside a deploy (supply-checkout-6uw.16):
 * no template makes them, and done to every operator they lock responders
 * out as surely as a deletion. `npm run operators -- disable`, `remove` and
 * `reset` make them, and say so.
 */
export const OPERATOR_LOCKOUT_EVENTS = ["AdminDisableUser", "AdminUserGlobalSignOut"] as const;

/** Every admin and configuration call on the operator pool that alerts P1 (ADR 0015). */
export const OPERATOR_POOL_ADMIN_EVENTS = [...OPERATOR_USER_EVENTS, ...OPERATOR_POOL_CONFIG_EVENTS, ...OPERATOR_LOCKOUT_EVENTS] as const;

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
  OperatorPoolProtection: "pool-protection",
  OperatorBrandingChanges: "branding-changes",
  OperatorSelfServiceChanges: "self-service-changes",
  OperatorAuditWatchChanges: "audit-watch-changes",
  OperatorAuditWatchRoleChanges: "audit-watch-role",
  OperatorAuditWatchLogChanges: "audit-watch-logs",
  OperatorAuditWatchTableChanges: "audit-watch-table",
  OperatorAlarmChanges: "alarm-changes",
  OperatorAlertRouteChanges: "alert-route-changes",
  // Alarm recipients (supply-checkout-6uw.23): P2 only, CloudFormation included
  OperatorAlarmRecipientChanges: "alarm-recipients",
  OperatorAlarmSubscriptionChanges: "alarm-subscriptions",
  OperatorAlertKeyAndTrailChanges: "alert-key-and-trail",
  OperatorTrailBucketChanges: "trail-bucket-changes",
  OperatorRuleTampering: "rule-tampering",
  OperatorRuleTamperingWatch: "rule-tampering-watch",
  OperatorGroupWatchAlarmChanges: "group-watch-alarms",
  OperatorGroupSnapshotChanges: "group-snapshot",
  // One rule per parameter the operator rules read at deploy time (supply-checkout-6uw.22, operatorRuleInputParameters)
  OperatorInputOpsPoolId: "input-ops-pool-id",
  OperatorInputOpsBrandingId: "input-ops-branding-id",
  OperatorInputTrailKeyArn: "input-trail-key-arn",
  OperatorInputTableKeyArn: "input-table-key-arn",
  OperatorInputTableStreamArn: "input-table-stream-arn",
  // One rule per parameter the API's and realtime authorizers read at deploy time (supply-checkout-6uw.23, authorizerInputParameters)
  OperatorAuthorizerIssuerUrl: "authz-issuer-url",
  OperatorAuthorizerWebClientId: "authz-web-client-id",
  OperatorAuthorizerUserPoolId: "authz-user-pool-id",
  OperatorAuthorizerOpsIssuerUrl: "authz-ops-issuer-url",
  OperatorAuthorizerOpsClientId: "authz-ops-client-id",
  OperatorAuthorizerAuthUrl: "authz-auth-url",
} as const;

/**
 * The operator group watch's schedule rule (supply-checkout-3sv.5): under the
 * operator prefix, so the rule-tampering rules alert when it's disabled,
 * deleted or retargeted. It has no event pattern, so it isn't one of
 * OPERATOR_RULE_SUFFIXES.
 */
export const OPERATOR_GROUP_WATCH_RULE_SUFFIX = "group-watch";

/**
 * The support SMTP user watch's rule (supply-checkout-6qd): under the
 * operator prefix, so the rule-tampering rules alert when it's disabled,
 * deleted or retargeted. It's in GLOBAL_SERVICES_REGION (IAM's events) and
 * they're in the primary region, which for prod is the same region.
 */
export const SUPPORT_SMTP_RULE_SUFFIX = "support-smtp-user";

/**
 * SSM calls that change or remove the operator group watch's snapshot
 * parameter (supply-checkout-3sv.5): P1 unless the watch's own role or
 * CloudFormation made them. DeleteParameters names it in a list.
 */
export const GROUP_SNAPSHOT_EVENTS = ["PutParameter", "DeleteParameter", "LabelParameterVersion", "UnlabelParameterVersion"] as const;

/**
 * SSM calls that change or remove a parameter the operator rules and watches
 * read at deploy time (supply-checkout-6uw.22): P1 unless CloudFormation made
 * them. Each names the parameter in `requestParameters.name`, and
 * DeleteParameters in the list `names`.
 */
export const RULE_INPUT_PARAMETER_EVENTS = GROUP_SNAPSHOT_EVENTS;

/**
 * How the SSM rules match a parameter's name in `requestParameters.name` or
 * `names` (supply-checkout-6uw.22). SSM removes spaces from the beginning and
 * end of a name before it acts, and CloudTrail may record the name as sent,
 * so `" <name> "` rewrites the parameter but wouldn't match the name exactly.
 * One wildcard, `*<name>*`, matches the name with any padding. These calls
 * don't take a parameter's ARN (the SSM API reference says so for each), but
 * this would match one too. It also matches a longer name containing this
 * one, which only over-alerts.
 *
 * EventBridge refuses a pattern whose wildcards are too complex when the rule
 * is saved, and repeated sequences after a wildcard add to it (as with the
 * log groups in OperatorAuditWatchLogChanges), so each SSM rule names one
 * parameter: two wildcards, in `name` and `names`, like the log rule.
 */
export const ssmParameterNameMatch = (name: string) => ({ wildcard: `*${name}*` });

/**
 * The SSM parameters the operator rules and watches read at deploy time
 * (supply-checkout-6uw.22), by the construct ID of the rule that watches each,
 * each published by the stack that owns the resource: the ops pool's ID
 * (OperatorPoolChanges, OperatorPoolProtection, OperatorBrandingChanges,
 * OperatorSelfServiceChanges and the operator group watch), the ops branding's
 * ID (OperatorBrandingChanges), the trail key's ARN
 * (OperatorAlertKeyAndTrailChanges, OperatorTrailBucketChanges), the table
 * key's ARN (OperatorAuditWatchTableChanges and the audit watch's role) and
 * the table stream's ARN (the audit watch's event source mapping). Rewritten,
 * the next observability deploy would point those at something else, through
 * CloudFormation's own PutRule, which the tampering rules exempt.
 */
export const operatorRuleInputParameters = (envName: string) => {
  const identity = identityOutputParameters(envName);
  return {
    OperatorInputOpsPoolId: identity.opsUserPoolId,
    OperatorInputOpsBrandingId: identity.opsBrandingId,
    OperatorInputTrailKeyArn: auditOutputParameters(envName).trailKeyArn,
    OperatorInputTableKeyArn: `/supply-checkout/${envName}/data/table-key-arn`,
    OperatorInputTableStreamArn: `/supply-checkout/${envName}/data/table-stream-arn`,
  } as const satisfies Partial<Record<keyof typeof OPERATOR_RULE_SUFFIXES, string>>;
};

/**
 * The SSM parameters the API's and realtime authorizers read at deploy time
 * (supply-checkout-6uw.23), by the construct ID of the rule that watches each:
 * the customer pool's issuer and the web client's ID (the customer JWT
 * authorizer's issuer and audience, cognitoJwtAuthorizer), the customer
 * pool's ID (the realtime authorizer function's pool), and the operator
 * pool's issuer and the ops client's ID (the ops JWT authorizer,
 * opsJwtAuthorizer, and the ops function's own token check). Rewritten, the
 * next api or realtime deploy would accept another pool's or client's tokens,
 * through CloudFormation, which these rules exempt. The operator pool's ID,
 * which the ops function also reads, is OperatorInputOpsPoolId's. Also the
 * customer sign-in URL, which scripts/publish-web.mjs writes into the web
 * app's config.json (where the browser goes to sign in); the auth function no
 * longer reads it from SSM. The rules are named under the operator prefix, so
 * the rule-tampering rules watch them.
 */
export const authorizerInputParameters = (envName: string) => {
  const identity = identityOutputParameters(envName);
  return {
    OperatorAuthorizerIssuerUrl: identity.issuerUrl,
    OperatorAuthorizerWebClientId: identity.webClientId,
    OperatorAuthorizerUserPoolId: identity.userPoolId,
    OperatorAuthorizerOpsIssuerUrl: identity.opsIssuerUrl,
    OperatorAuthorizerOpsClientId: identity.opsClientId,
    OperatorAuthorizerAuthUrl: identity.authUrl,
  } as const satisfies Partial<Record<keyof typeof OPERATOR_RULE_SUFFIXES, string>>;
};

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
/** Lambda calls that give a function the operator group watch's role, outside a deploy (supply-checkout-3sv.5), by prefix like the others. */
export const GROUP_WATCH_ROLE_FUNCTION_EVENTS = { outsideDeploys: ["CreateFunction", "UpdateFunctionConfiguration"] } as const;
/**
 * The watch functions' own calls: deleting one, or taking away a permission on
 * it (RemovePermission, e.g. EventBridge's to invoke the group watch, which
 * stops every run with only its P2 silent alarm 15 minutes later), whoever does
 * it (supply-checkout-3sv.9); changing its code, configuration or concurrency
 * outside a deploy.
 */
export const AUDIT_WATCH_FUNCTION_EVENTS = { always: ["DeleteFunction", "RemovePermission"], outsideDeploys: ["PutFunctionConcurrency", "UpdateFunctionCode", "UpdateFunctionConfiguration"] } as const;
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
/**
 * SNS calls that change who an alarm topic reaches, for
 * OperatorAlarmSubscriptionChanges (supply-checkout-6uw.23): a new
 * subscription whoever makes it, and CloudFormation's own Unsubscribe or
 * SetSubscriptionAttributes during a deploy (anyone else's already alert
 * through OperatorAlertRouteChanges, ALARM_SUBSCRIPTION_EVENTS). A deploy
 * after an alarm recipient parameter is rewritten replaces that
 * subscription: Subscribe to the new endpoint, then Unsubscribe the old one.
 */
export const ALARM_RECIPIENT_SUBSCRIPTION_EVENTS = { always: ["Subscribe"], byDeploys: ALARM_SUBSCRIPTION_EVENTS.outsideDeploys } as const;
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
 * S3 calls on the trail's bucket that would destroy or cut off the log
 * archive (supply-checkout-3sv.4): deleting the bucket, its policy or its
 * encryption whoever does it; a lifecycle rule (a one-day expiry), versioning
 * suspended, a policy that denies CloudTrail, another key, or its access logs
 * turned off, outside a deploy. CloudTrail records PutBucketLifecycleConfiguration
 * as PutBucketLifecycle (as for DELETIONS_BUCKET_CHANGE_EVENTS).
 */
export const TRAIL_BUCKET_EVENTS = {
  always: ["DeleteBucket", "DeleteBucketPolicy", "DeleteBucketEncryption"],
  outsideDeploys: ["PutBucketPolicy", "PutBucketLifecycle", "DeleteBucketLifecycle", "PutBucketVersioning", "PutBucketEncryption", "PutBucketLogging"],
} as const;
/**
 * KMS calls on the trail's key that nothing here ever makes: a grant lets
 * someone else use it (read the logs, or encrypt files CloudTrail's
 * validation won't match), and rotation off weakens it. Whoever makes them.
 * Disabling it, scheduling its deletion and its policy are ALARM_KEY_EVENTS.
 */
export const TRAIL_KEY_EVENTS = { always: ["CreateGrant", "DisableKeyRotation"] } as const;


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
 *   errors, and P2 ones on the operator page's distribution and router
 *   (web-alarms.ts), from the web stack's SSM outputs.
 * - `costs`: GLOBAL_SERVICES_REGION only, the account's monthly cost budget
 *   and its Cost Anomaly Detection monitor and subscription, to the P2 topic
 *   (cost-alerts.ts, supply-checkout-jxq). Both services are account-wide,
 *   so they're in one stack, in the region Cost Explorer's API is in. P2
 *   when they're deleted or changed outside a deploy (supply-checkout-3sv.19).
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
 * - `supportSmtp`: prod with `supportMail` only (supply-checkout-6qd): P2
 *   on IAM changes to the support SMTP user (GLOBAL_SERVICES_REGION, where
 *   IAM's events arrive) and on its sends above the hourly limit (primary
 *   region) (support-smtp-watch.ts).
 * - `deletionRecords`: primary region only, the P2 alarm on a deletion
 *   record written over or deleted, from the bucket's S3 events, and the P1
 *   rule on changes to the bucket (deletion-records-watch.ts).
 * - `photoDownloads`: primary region only, the P2 alarm on more than 5 GiB of
 *   profile photos downloaded in an hour (photos-alarm.ts, supply-checkout-6uw.30).
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
  readonly photoDownloads?: Alarm;
  readonly web?: WebAlarms;
  readonly costs?: CostAlerts;
  readonly supportSmtp?: SupportSmtpWatch;

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
          opsDistributionId: StringParameter.valueForStringParameter(this, webOutputParameters(config.envName).opsDistributionId),
        }
      : undefined;
    if (webIds) this.web = new WebAlarms(this, "WebAlarms", { envName: config.envName, ...webIds, topics: this.topics });
    // Budgets and Cost Anomaly Detection are account-wide: one stack, in the region of Cost Explorer's API
    if (region === GLOBAL_SERVICES_REGION) {
      this.costs = new CostAlerts(this, "CostAlerts", {
        envName: config.envName,
        topics: this.topics,
        ruleName: operatorRuleName(config.envName, COST_ALERT_RULE_SUFFIX),
        ...costAlertsFromContext(this.node),
      });
    }

    // The support SMTP user's alerts: IAM's events arrive in GLOBAL_SERVICES_REGION, SES's sends in the primary region
    const supportUserChanges = region === GLOBAL_SERVICES_REGION;
    if (supportMailFromContext(this.node, config.envName) && (supportUserChanges || this.isPrimaryRegion)) {
      this.supportSmtp = new SupportSmtpWatch(this, "SupportSmtpWatch", {
        envName: config.envName,
        ruleName: operatorRuleName(config.envName, SUPPORT_SMTP_RULE_SUFFIX),
        region,
        topics: this.topics,
        userChanges: supportUserChanges,
        sends: this.isPrimaryRegion,
      });
    }

    for (const [severity, topic] of Object.entries(this.topics.topics)) {
      new StringParameter(this, `AlarmTopic${severity}Param`, {
        parameterName: `/supply-checkout/${config.envName}/observability/alarm-topic-${severity.toLowerCase()}-arn`,
        stringValue: topic.topicArn,
        description: `SNS topic for ${severity} alarms in this region`,
      });
    }

    if (this.isPrimaryRegion) {
      this.checks = new OpsChecks(this, "OpsChecks", { envName: config.envName, tableName: table, topics: this.topics, stripeMode: stripeModeOf(config), config });
      this.operatorAudit = new OperatorAuditWatch(this, "OperatorAuditWatch", { envName: config.envName, region, tableName: table, topics: this.topics });
      this.operatorGroup = new OperatorGroupWatch(this, "OperatorGroupWatch", {
        envName: config.envName,
        region,
        userPoolId: StringParameter.valueForStringParameter(this, identityOutputParameters(config.envName).opsUserPoolId),
        ruleName: operatorRuleName(config.envName, OPERATOR_GROUP_WATCH_RULE_SUFFIX),
        topics: this.topics,
      });
      this.deletionRecords = new DeletionRecordsWatch(this, "DeletionRecordsWatch", { envName: config.envName, region, topics: this.topics });
      this.photoDownloads = photosDownloadAlarm(this, { envName: config.envName, region, topics: this.topics });
      // The tampering rules also watch the deletion records watch's two rules (supply-checkout-72d.17)
      this.operatorChanges = this.alertOnOperatorChanges(config.envName, this.operatorAudit, this.operatorGroup, [this.deletionRecords.rule, this.deletionRecords.bucketChanges]);
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
      // And tells P2 when a backup or copy job fails ("Backup failed", supply-checkout-7pe.1): only that rule, by name
      this.topics.topics.P2.addToResourcePolicy(
        new PolicyStatement({
          sid: "AllowBackupJobAlertsToPublish",
          principals: [new ServicePrincipal("events.amazonaws.com")],
          actions: ["sns:Publish"],
          resources: [this.topics.topics.P2.topicArn],
          conditions: { ArnEquals: { "aws:SourceArn": backupJobAlertRuleArn(config.envName) } },
        }),
      );
      this.dashboard = new OpsDashboard(this, "Dashboard", {
        envName: config.envName,
        regions: config.regions,
        tableName: table,
        api: { region, apiId },
        web: webIds,
        alarms: [...this.alarms.alarms, ...(this.web?.alarms ?? []), this.operatorAudit.changed, this.operatorAudit.dropped, this.operatorAudit.silent, this.operatorGroup.changed, this.operatorGroup.silent, this.deletionRecords.failing, this.photoDownloads, ...(this.supportSmtp?.sends ? [this.supportSmtp.sends] : []), ...(this.supportSmtp?.dailySends ? [this.supportSmtp.dailySends] : [])],
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
   *   still alert. Deleting an operator alerts whoever does it, and disabling
   *   or signing one out everywhere (OPERATOR_LOCKOUT_EVENTS) outside a
   *   deploy (supply-checkout-6uw.16).
   * - `OperatorPoolProtection` (supply-checkout-6uw.20): DeleteUserPool on
   *   the operator pool, or an UpdateUserPool on it whose deletionProtection
   *   is missing (UpdateUserPool then resets it to INACTIVE) or anything but
   *   ACTIVE (OPERATOR_POOL_PROTECTION_EVENTS), whoever makes it, CloudFormation
   *   included. DeleteUserPool carries no deletionProtection, so it always
   *   matches; once the pool is gone, the userPoolId matches above are moot.
   *   A rule of its own, since the extra requestParameters condition would
   *   otherwise share a key with OperatorPoolChanges' pool ID.
   * - `OperatorBrandingChanges` (supply-checkout-6uw.21): the branding calls
   *   in OPERATOR_BRANDING_EVENTS on the ops branding, by its ID, unless
   *   CloudFormation made them for a deploy, as in OperatorPoolChanges. Only
   *   when they don't name the ops pool (no userPoolId, or another one): a
   *   call that names it already alerts through OperatorPoolChanges. A rule
   *   of its own, so OperatorPoolChanges' pattern stays as it is.
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
   * - `OperatorGroupWatchAlarmChanges` and `OperatorGroupSnapshotChanges`
   *   (supply-checkout-3sv.5): the operator group watch's two alarms, as
   *   above, and any change to or deletion of its snapshot parameter that
   *   neither its own role nor CloudFormation made. Its function, role and log
   *   group are in the three rules above.
   * - `OperatorInput*` (supply-checkout-6uw.22), one per parameter:
   *   PutParameter, DeleteParameter(s) or (Un)LabelParameterVersion on an SSM
   *   parameter these rules or the watches read at deploy time
   *   (operatorRuleInputParameters), with any padding around its name
   *   (ssmParameterNameMatch), outside a deploy. A rewritten ID would
   *   otherwise retarget them at the next ordinary deploy, unseen.
   * - `OperatorAuthorizer*` (supply-checkout-6uw.23), the same, one per SSM
   *   parameter the API's JWT authorizers, the ops function's token check or
   *   the realtime authorizer read at deploy time (authorizerInputParameters):
   *   a rewritten issuer, client or pool would change which tokens they accept
   *   at the next api or realtime deploy; and the sign-in URL the web publish
   *   writes into the app's config.
   * - `OperatorAlertRouteChanges`: deleting either alarm topic, or taking
   *   its permissions away, whoever does it; changing its attributes (its
   *   policy or key) or a subscription to it, including unsubscribing,
   *   outside a deploy; and a data protection policy on either topic,
   *   whoever sets it.
   * - `OperatorAlarmRecipientChanges` and `OperatorAlarmSubscriptionChanges`
   *   (supply-checkout-6uw.23), P2 only, CloudFormation included (the
   *   owner's decision): any PutParameter, DeleteParameter(s) or
   *   (Un)LabelParameterVersion on an SSM parameter under
   *   /supply-checkout/<env>/alarms/ (alarmRecipientParameterPrefix, with any
   *   padding); and any Subscribe to either alarm topic, and CloudFormation's
   *   own Unsubscribe or SetSubscriptionAttributes on a subscription to one.
   *   The subscriptions take their endpoints from those parameters only when
   *   the stack deploys, so the parameter alert goes to the recipients from
   *   before the change. The deploy then subscribes the new endpoint before
   *   it unsubscribes the old (a replacement, the old one removed in the
   *   stack's cleanup), so its Subscribe alert usually reaches the old
   *   recipient too, and its Unsubscribe alert the ones still subscribed.
   * - `OperatorAlertKeyAndTrailChanges`: disabling or scheduling the
   *   deletion of the topics' key or the audit stack's trail key whoever does
   *   it, changing either's policy outside a deploy, or pointing an alias at
   *   the topics' key; and stopping, deleting or narrowing any CloudTrail
   *   trail in the account (the audit stack's trail is the one these rules
   *   need, supply-checkout-3sv.3).
   *   Both route rules tell both topics, so deleting one still reaches the other.
   * - `OperatorTrailBucketChanges` (supply-checkout-3sv.4): deleting the
   *   trail's bucket, its policy or its encryption whoever does it, and its
   *   policy, lifecycle, versioning, encryption or access logging changed
   *   outside a deploy (TRAIL_BUCKET_EVENTS); a grant on the trail's key or
   *   its rotation turned off, whoever does it (TRAIL_KEY_EVENTS). These break
   *   the log archive, not the alerts, so P1 only.
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
  private alertOnOperatorChanges(envName: string, watch: OperatorAuditWatch, groupWatch: OperatorGroupWatch, alsoWatched: Rule[]): Rule[] {
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
            // An operator disabled or signed out everywhere: outside a deploy (supply-checkout-6uw.16)
            { eventName: [...OPERATOR_LOCKOUT_EVENTS], userIdentity: NOT_CLOUDFORMATION },
          ],
        },
      },
    );
    // Read-only management events too (OPERATOR_POOL_RULE_STATE)
    (admin.node.defaultChild as CfnRule).state = OPERATOR_POOL_RULE_STATE;
    const protection = operatorRule(
      "OperatorPoolProtection",
      "Operator pool: deleted, or its deletion protection turned off, even by a deploy (supply-checkout-6uw.20)",
      {
        ...base,
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          eventName: [...OPERATOR_POOL_PROTECTION_EVENTS],
          // A missing deletionProtection resets it to INACTIVE, and DeleteUserPool has none
          requestParameters: { userPoolId: [poolId], deletionProtection: [{ exists: false }, { "anything-but": "ACTIVE" }] },
        },
      },
    );
    // A branding call that names only the branding (UpdateManagedLoginBranding's UserPoolId is optional, supply-checkout-6uw.21)
    const brandingId = StringParameter.valueForStringParameter(this, identityOutputParameters(envName).opsBrandingId);
    const branding = operatorRule("OperatorBrandingChanges", "Operator pool: its managed login branding changed or deleted outside a deploy, by branding ID (supply-checkout-6uw.21)", {
      ...base,
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: [...OPERATOR_BRANDING_EVENTS],
        // A call that names the ops pool alerts through OperatorPoolChanges already, so it isn't paged twice
        requestParameters: { managedLoginBrandingId: [brandingId], userPoolId: [{ exists: false }, { "anything-but": poolId }] },
        userIdentity: NOT_CLOUDFORMATION,
      },
    });
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
    // The operator group watch's function, role and log group too (supply-checkout-3sv.5)
    const watchFunctions = [opsResourceNames(envName).operatorAuditWatchFunction, opsResourceNames(envName).operatorGroupWatchFunction];
    // A name, or an ARN with or without a qualifier; one wildcard for both ARNs keeps the pattern inside the limit with the
    // longest envName (it also matches a longer name that starts with this one, which only over-alerts)
    const functionNames = watchFunctions.flatMap((name) => [name, { wildcard: `*:function:${name}*` }]);
    const logGroups = [watch.logGroup.logGroupName, groupWatch.logGroup.logGroupName];
    const table = tableName(envName);
    const watchChanges = operatorRule("OperatorAuditWatchChanges", "The operator audit watch's stream mapping, or its or the operator group watch's function, was deleted, or changed outside a deploy (supply-checkout-6uw.11)", {
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
    const roleChanges = operatorRule("OperatorAuditWatchRoleChanges", "The operator audit or group watch's role or its policies were deleted or changed outside a deploy, or a function given the group watch's role outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.iam", "aws.lambda"],
      ...cloudTrail,
      detail: {
        $or: [
          ...calls(AUDIT_WATCH_ROLE_EVENTS, { eventSource: ["iam.amazonaws.com"], requestParameters: { roleName: [watch.role.roleName, groupWatch.role.roleName] } }),
          // Any other function given the operator group watch's role (supply-checkout-3sv.5); its grants also need lambda:SourceFunctionArn.
          // Its ARN, and any ARN ending in its name (a path, or an ARN spelled differently from GetAtt's), which only over-alerts
          // on another role whose name ends in this one (supply-checkout-3sv.9)
          ...calls(GROUP_WATCH_ROLE_FUNCTION_EVENTS, { eventSource: ["lambda.amazonaws.com"], requestParameters: { role: [groupWatch.role.roleArn, { wildcard: `*:role/*${groupWatch.role.roleName}` }] } }, true),
        ],
      },
    });
    const logChanges = operatorRule("OperatorAuditWatchLogChanges", "The operator audit or group watch's log group was deleted, or given a transformer or data protection policy outside a deploy, or one was set for the account (supply-checkout-6uw.11)", {
      source: ["aws.logs"],
      ...cloudTrail,
      detail: {
        eventSource: ["logs.amazonaws.com"],
        $or: [
          // DeleteLogGroup names the group; the transformer and data protection calls take its name or ARN
          ...calls({ always: AUDIT_WATCH_LOG_EVENTS.always }, { requestParameters: { logGroupName: logGroups } }),
          // One wildcard per group covers the ARN with or without ":*". EventBridge refuses a rule as "too complex" with two
          // per group once there are two groups, because the generated names repeat long sequences after each wildcard
          // (it only checks this when the rule is saved, so tests can't see it). It also matches a longer name, which only over-alerts.
          ...calls({ outsideDeploys: AUDIT_WATCH_LOG_EVENTS.outsideDeploys }, { requestParameters: { logGroupIdentifier: logGroups.flatMap((g) => [g, { wildcard: `*:log-group:${g}*` }]) } }),
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
    const alarmNames = [watch.changed.alarmName, watch.dropped.alarmName, watch.silent.alarmName];
    const alarmChanges = operatorRule("OperatorAlarmChanges", "An operator audit alarm was disabled or deleted, or rewritten outside a deploy (supply-checkout-6uw.11)", {
      source: ["aws.monitoring"],
      ...cloudTrail,
      detail: {
        eventSource: ["monitoring.amazonaws.com"],
        // DisableAlarmActions and DeleteAlarms take a list, `alarmNames`; PutMetricAlarm one `alarmName`
        $or: [...calls({ always: OPERATOR_ALARM_EVENTS.always }, { requestParameters: { alarmNames } }), ...calls({ outsideDeploys: OPERATOR_ALARM_EVENTS.outsideDeploys }, { requestParameters: { alarmName: alarmNames } })],
      },
    });
    // The operator group watch's two alarms, the same way (OperatorAlarmChanges has no room for them)
    const groupAlarmNames = [groupWatch.changed.alarmName, groupWatch.silent.alarmName];
    const groupAlarmChanges = operatorRule("OperatorGroupWatchAlarmChanges", "An operator group watch alarm was disabled or deleted, or rewritten outside a deploy (supply-checkout-3sv.5)", {
      source: ["aws.monitoring"],
      ...cloudTrail,
      detail: {
        eventSource: ["monitoring.amazonaws.com"],
        $or: [...calls({ always: OPERATOR_ALARM_EVENTS.always }, { requestParameters: { alarmNames: groupAlarmNames } }), ...calls({ outsideDeploys: OPERATOR_ALARM_EVENTS.outsideDeploys }, { requestParameters: { alarmName: groupAlarmNames } })],
      },
    });
    // Its snapshot: a PutParameter could hide the next change. The watch's own writes and a deploy's don't alert.
    // The name as a string, like the functions', to keep the pattern short. These calls take only a name, not an ARN, but SSM
    // trims spaces from it, so the name is matched with any padding (ssmParameterNameMatch, supply-checkout-6uw.22)
    const snapshotName = operatorGroupSnapshotParameter(envName);
    const snapshotNames = [ssmParameterNameMatch(snapshotName)];
    const notTheWatch = { ...NOT_CLOUDFORMATION, sessionContext: { sessionIssuer: { arn: [{ exists: false }, { "anything-but": groupWatch.role.roleArn }] } } };
    const snapshotChanges = operatorRule("OperatorGroupSnapshotChanges", "The operator group watch's snapshot parameter was changed or deleted by anyone but the watch or a deploy (supply-checkout-3sv.5)", {
      source: ["aws.ssm"],
      ...cloudTrail,
      detail: {
        eventSource: ["ssm.amazonaws.com"],
        $or: [
          { eventName: [...GROUP_SNAPSHOT_EVENTS], requestParameters: { name: snapshotNames }, userIdentity: notTheWatch },
          // DeleteParameters names it in a list
          { eventName: ["DeleteParameters"], requestParameters: { names: snapshotNames }, userIdentity: notTheWatch },
        ],
      },
    });
    // What the rules and watches read at deploy time: a rewritten value retargets them at the next deploy (supply-checkout-6uw.22).
    // And what the API's and realtime authorizers read: a rewritten value changes which tokens they accept (supply-checkout-6uw.23).
    // CloudFormation is exempt, as in the snapshot rule: the identity, audit and data stacks write these when they deploy.
    // One rule per parameter, to keep each pattern's wildcards few (ssmParameterNameMatch)
    const parameterRules = (parameters: Partial<Record<keyof typeof OPERATOR_RULE_SUFFIXES, string>>, readBy: string, bead: string) =>
      (Object.entries(parameters) as [keyof typeof OPERATOR_RULE_SUFFIXES, string][]).map(([id, name]) => {
        const names = [ssmParameterNameMatch(name)];
        const what = `the SSM parameter ${name}, which ${readBy}`;
        const rule = operatorRule(id, `The SSM parameter ${name}, which ${readBy}, was changed or deleted outside a deploy (${bead})`, {
          source: ["aws.ssm"],
          ...cloudTrail,
          detail: {
            eventSource: ["ssm.amazonaws.com"],
            $or: [
              { eventName: [...RULE_INPUT_PARAMETER_EVENTS], requestParameters: { name: names }, userIdentity: NOT_CLOUDFORMATION },
              // DeleteParameters names it in a list
              { eventName: ["DeleteParameters"], requestParameters: { names }, userIdentity: NOT_CLOUDFORMATION },
            ],
          },
        });
        return { rule, what };
      });
    const inputRules = [
      ...parameterRules(operatorRuleInputParameters(envName), "the operator alerts read at deploy time", "supply-checkout-6uw.22"),
      ...parameterRules(authorizerInputParameters(envName), "sign-in or the API's and realtime authorizers read at deploy or publish time", "supply-checkout-6uw.23"),
    ];
    const topics = Object.values(this.topics.topics);
    const topicArns = topics.map((t) => t.topicArn);
    const subscriptionArns = topicArns.map((arn) => ({ prefix: `${arn}:` }));
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
          ...calls(ALARM_SUBSCRIPTION_EVENTS, { requestParameters: { subscriptionArn: subscriptionArns } }),
        ],
      },
    });
    // Who the alarms reach (supply-checkout-6uw.23): the owner edits these legitimately, so P2 only, and with no CloudFormation
    // exemption. The SSM write alerts the recipients from before it (the subscriptions only change at the next deploy); the
    // deploy's own Subscribe and Unsubscribe alert too, since that's when the recipients actually change
    const recipientPrefix = alarmRecipientParameterPrefix(envName);
    const recipientNames = [ssmParameterNameMatch(recipientPrefix)];
    const recipientChanges = operatorRule("OperatorAlarmRecipientChanges", `An alarm recipient parameter under ${recipientPrefix} was changed or deleted, by anyone, deploys included (supply-checkout-6uw.23)`, {
      source: ["aws.ssm"],
      ...cloudTrail,
      detail: {
        eventSource: ["ssm.amazonaws.com"],
        $or: [
          { eventName: [...RULE_INPUT_PARAMETER_EVENTS], requestParameters: { name: recipientNames } },
          // DeleteParameters names it in a list
          { eventName: ["DeleteParameters"], requestParameters: { names: recipientNames } },
        ],
      },
    });
    const subscriptionChanges = operatorRule("OperatorAlarmSubscriptionChanges", "A subscription to an alarm topic was made, or changed or removed by a deploy (supply-checkout-6uw.23)", {
      source: ["aws.sns"],
      ...cloudTrail,
      detail: {
        eventSource: ["sns.amazonaws.com"],
        $or: [
          // Subscribe names the topic; whoever makes it
          { eventName: [...ALARM_RECIPIENT_SUBSCRIPTION_EVENTS.always], requestParameters: { topicArn: topicArns } },
          // A deploy's own; anyone else's alerts P1 and P2 through OperatorAlertRouteChanges
          { eventName: [...ALARM_RECIPIENT_SUBSCRIPTION_EVENTS.byDeploys], requestParameters: { subscriptionArn: subscriptionArns }, userIdentity: BY_CLOUDFORMATION },
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
    // The trail's bucket and key: a one-day lifecycle rule or a policy that denies CloudTrail silently destroys or cuts off the
    // log archive (supply-checkout-3sv.4). The bucket's name as the template builds it, like the deletion records bucket's
    const trailBucket = trailBucketName(envName, this.region);
    const trailBucketChanges = operatorRule("OperatorTrailBucketChanges", "The CloudTrail trail's bucket was deleted or lost its policy or encryption, or changed outside a deploy, or its key granted or rotation turned off (supply-checkout-3sv.4)", {
      source: ["aws.s3", "aws.kms"],
      ...cloudTrail,
      detail: {
        $or: [
          ...calls(TRAIL_BUCKET_EVENTS, { eventSource: ["s3.amazonaws.com"], requestParameters: { bucketName: [trailBucket] } }),
          ...calls(TRAIL_KEY_EVENTS, { eventSource: ["kms.amazonaws.com"], resources: { ARN: [trailKeyArn] } }),
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
    // The rules that tell P1; the alarm recipient rules tell P2 only (below)
    const rules = [admin, protection, branding, selfService, watchChanges, roleChanges, logChanges, tableChanges, alarmChanges, groupAlarmChanges, snapshotChanges, ...inputRules.map((i) => i.rule), routeChanges, keyAndTrailChanges, trailBucketChanges, tampering, tamperingWatch, deletionsTampering];
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
      [protection, message("the operator pool itself (deletion or deletion protection)")],
      [branding, message("the operator pool's managed login branding")],
      [selfService, message("the operator pool")],
      [watchChanges, message("the operator audit watch")],
      [roleChanges, message("the operator audit watch's role")],
      [logChanges, message("the operator audit watch's log group")],
      [tableChanges, message("the table's stream or the table key")],
      [alarmChanges, message("an operator audit alarm")],
      [groupAlarmChanges, message("an operator group watch alarm")],
      [snapshotChanges, message("the operator group watch's snapshot")],
      ...inputRules.map(({ rule, what }) => [rule, message(what)] as const),
      [routeChanges, message("the alarm topics")],
      [recipientChanges, message(`the alarm recipient parameters under ${recipientPrefix}`)],
      [subscriptionChanges, message("a subscription to an alarm topic")],
      [keyAndTrailChanges, message("the alarm topics' key or CloudTrail")],
      [trailBucketChanges, message("the CloudTrail trail's bucket or key")],
      [tampering, message("an operator alert rule")],
      [tamperingWatch, message("an operator alert rule")],
      [deletionsTampering, message("a deletion records watch rule")],
    ]);
    for (const rule of rules) {
      // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
      rule.addTarget({ bind: () => ({ arn: topic.topicArn, input: messages.get(rule) }) });
    }
    // Changes to the route an alert takes also go to P2: deleting or breaking the P1 topic still reaches someone.
    // The alarm recipient rules go to P2 only (supply-checkout-6uw.23)
    const p2 = this.topics.topics.P2;
    const routeRules = [routeChanges, keyAndTrailChanges];
    const recipientRules = [recipientChanges, subscriptionChanges];
    const p2Rules = [...routeRules, ...recipientRules];
    for (const rule of p2Rules) rule.addTarget({ bind: () => ({ arn: p2.topicArn, input: messages.get(rule) }) });
    // Only these rules may publish to P2 (not any rule in the account)
    p2.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowAlertRouteChangesToPublish",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [p2.topicArn],
        conditions: { ArnEquals: { "aws:SourceArn": p2Rules.map((r) => r.ruleArn) } },
      }),
    );
    return [...rules, ...recipientRules];
  }
}
