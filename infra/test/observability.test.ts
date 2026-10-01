import { readFileSync } from "node:fs";
import { Validations } from "aws-cdk-lib";
import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { AwsSolutionsChecks } from "cdk-nag";
import type { Construct } from "constructs";
import { describe, expect, it } from "vitest";
import { BusinessMetric } from "../../backend/src/observability/names.js";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { alarmContactParameter, alarmContactsFromContext } from "../lib/observability/alarm-topics.js";
import { LOG_RETENTION } from "../lib/observability/defaults.js";
import { journeyAlarmSpecs, SET_ASIDE_INCIDENT_AT } from "../lib/observability/journey-alarms.js";
import { ROUTER_FAILING_ABOVE, RUM_EVENTS_FLOOD_PER_HOUR, RUM_EVENTS_SURGE_PER_HOUR, SITE_DOWN_MIN_REQUESTS, SITE_DOWN_PERCENT } from "../lib/observability/web-alarms.js";
import { rumAppMonitorName } from "../lib/web/rum.js";
import { webOutputParameters } from "../lib/stacks/web-stack.js";
import { OPERATOR_AUDIT_HEARTBEAT } from "../../backend/src/data/schema.js";
import { DELETION_PREFIXES, LIFECYCLE_EXPIRATION } from "../../backend/src/deletions/names.js";
import {
  CHECK_EVERY_MINUTES,
  GROUP_WATCH_EVERY_MINUTES,
  GROUP_WATCH_SILENT_ALARM_MINUTES,
  INITIAL_GROUP_SNAPSHOT,
  HEARTBEAT_EVERY_MINUTES,
  HEARTBEAT_SILENT_ALARM_MINUTES,
  PURGE_EVERY_HOURS,
  PURGE_OVERDUE_AFTER_HOURS,
  PURGE_SILENT_ALARM_HOURS,
  SEAT_RECONCILE_HOUR_UTC,
  SEAT_RECONCILE_SILENT_ALARM_DAYS,
  STUCK_IMPORT_AFTER_MINUTES,
} from "../../backend/src/ops/names.js";
import { DELETIONS_BUCKET_CHANGE_EVENTS } from "../lib/observability/deletion-records-watch.js";
import { addBackupAccount, addSupplyCheckout } from "../lib/supply-checkout.js";
import {
  ALARM_KEY_ALIAS_EVENTS,
  ALARM_KEY_EVENTS,
  ALARM_SUBSCRIPTION_EVENTS,
  ALARM_TOPIC_EVENTS,
  ALARM_TOPIC_RESOURCE_EVENTS,
  AUDIT_WATCH_FUNCTION_EVENTS,
  AUDIT_WATCH_LOG_EVENTS,
  AUDIT_WATCH_MAPPING_EVENTS,
  AUDIT_WATCH_ROLE_EVENTS,
  LOG_ACCOUNT_POLICY_TYPES,
  OPERATOR_ALARM_EVENTS,
  OPERATOR_POOL_ADMIN_EVENTS,
  OPERATOR_POOL_CONFIG_EVENTS,
  OPERATOR_POOL_PROTECTION_EVENTS,
  OPERATOR_RULE_CHANGE_EVENTS,
  OPERATOR_RULE_SILENCING_EVENTS,
  OPERATOR_SELF_SERVICE_EVENTS,
  OPERATOR_USER_EVENTS,
  OPERATOR_LOCKOUT_EVENTS,
  OPERATOR_BRANDING_EVENTS,
  TABLE_KEY_EVENTS,
  TRAIL_BUCKET_EVENTS,
  TRAIL_KEY_EVENTS,
  TABLE_POLICY_EVENTS,
  TABLE_UPDATE_EVENTS,
  EVENT_PATTERN_LIMIT,
  OPERATOR_RULE_SUFFIXES,
  OPERATOR_GROUP_WATCH_RULE_SUFFIX,
  OPERATOR_POOL_RULE_STATE,
  GROUP_SNAPSHOT_EVENTS,
  GROUP_WATCH_ROLE_FUNCTION_EVENTS,
  RULE_INPUT_PARAMETER_EVENTS,
  operatorRuleInputParameters,
  authorizerInputParameters,
  ssmParameterNameMatch,
  deletionsRuleTamperingName,
  operatorRuleName,
  operatorRulePrefix,
  tamperingWatchRuleName,
  TRAIL_EVENTS,
} from "../lib/stacks/observability-stack.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  const app = testApp(context);
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  const region = (r: string) => {
    const s = stacks.regions[r];
    if (!s) throw new Error(`No stacks in ${r}`);
    return s;
  };
  return { app, stacks, region };
}

const observability = (r: string = EAST, context: Record<string, unknown> = {}) =>
  Template.fromStack(build(context).region(r).observability);

const ALARM_IDS = [
  "functions-failing",
  "api-errors",
  "api-slow",
  "functions-throttled",
  "database-errors",
  "database-throttled",
  "sign-out-not-revoking",
  "security-notices-failing",
  "security-notices-dropped",
  "sign-up-trigger-failing",
  "imports-stuck",
  "email-verification-not-saved",
  "email-codes-failing",
  "near-sending-limit",
  "invite-surge",
  "email-bouncing",
  "email-complaints",
  "email-events-dropped",
  "writes-rejected",
  "live-updates-failing",
  "live-updates-delayed",
  "live-updates-dropped",
  "live-updates-deferred",
  "receipt-reading-failing",
  "checkout-broken",
  "billing-portal-broken",
  "webhook-signature-failures",
  "billing-events-stuck",
  "billing-events-late",
  "seat-syncs-stuck",
  "seat-counts-drifting",
  "entitlements-drifting",
  "deletion-overdue",
  "team-closed-notices-failing",
  "reopened-team-subscription-ended",
  "closed-team-charged",
  "closed-team-subscription-not-found",
  "closed-team-subscription-set-aside",
  "closed-team-subscriptions-set-aside-many",
  "stripe-customer-already-deleted",
  "team-reopened-notices-failing",
];

/** Alarms on gauges that only the primary region's scheduled checks and purge send (ops-checks.ts), and on the user pool's trigger, which is there alone. */
const PRIMARY_ONLY_ALARM_IDS = [
  "sign-up-trigger-failing",
  "imports-stuck",
  "near-sending-limit",
  "seat-counts-drifting",
  "entitlements-drifting",
  "deletion-overdue",
  "closed-team-charged",
  "closed-team-subscription-not-found",
  "closed-team-subscription-set-aside",
  "closed-team-subscriptions-set-aside-many",
  "stripe-customer-already-deleted",
];

describe("alarm topics", () => {
  it("has a P1 and a P2 topic, encrypted with a rotating key that CloudWatch may use, refusing plain HTTP", () => {
    const t = observability();
    t.resourceCountIs("AWS::SNS::Topic", 2);
    for (const p of ["p1", "p2"]) {
      t.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: `supply-checkout-prod-alarms-${p}`,
        KmsMasterKeyId: { "Fn::GetAtt": [Match.stringLikeRegexp("^AlarmTopicsKey"), "Arn"] },
      });
    }
    t.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: ["cloudwatch.amazonaws.com", "events.amazonaws.com"] },
            Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
            Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
          }),
        ]),
      },
    });
    t.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });

  it("lets only this account's alarms in this region publish to each topic, in every region", () => {
    for (const r of [EAST, WEST]) {
      const t = observability(r);
      const policies = t.findResources("AWS::SNS::TopicPolicy");
      const statements = Object.values(policies).map((p) => {
        const doc = p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] };
        const topics = p.Properties.Topics as { Ref: string }[];
        return { topics: topics.map((x) => x.Ref), allow: doc.Statement.filter((s) => s.Effect === "Allow") };
      });
      // One policy per topic, P1 and P2, each with exactly one Allow
      expect(statements.map((s) => s.topics).flat().sort()).toEqual([
        expect.stringMatching(/^AlarmTopicsP1/),
        expect.stringMatching(/^AlarmTopicsP2/),
      ]);
      for (const { topics, allow: all } of statements) {
        // The primary region's P1 topic also takes the operator-pool alert, from that one rule only (tested below)
        // (and the backup stack's change alerts, by rule name)
        // (and the P2 topic takes the alert-route rule's, tested below)
        // (and the deletion records bucket's change rule, tested with the watch)
        const allow = all.filter((a) => !["AllowOperatorPoolAlertToPublish", "AllowBackupChangeAlertsToPublish", "AllowAlertRouteChangesToPublish", "AllowDeletionsBucketAlertToPublish"].includes(String(a.Sid)));
        if (all.length !== allow.length) expect([r, topics[0]]).toEqual([EAST, expect.stringMatching(/^AlarmTopicsP[12]/)]);
        expect(allow).toEqual([
          {
            Sid: "AllowCloudWatchAlarmsToPublish",
            Effect: "Allow",
            Principal: { Service: "cloudwatch.amazonaws.com" },
            Action: "sns:Publish",
            Resource: { Ref: topics[0] },
            Condition: {
              StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
              ArnLike: {
                "aws:SourceArn": {
                  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudwatch:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":alarm:*"]],
                },
              },
            },
          },
        ]);
      }
      // The topics' key lets CloudWatch encrypt what it publishes
      t.hasResourceProperties("AWS::KMS::Key", {
        KeyPolicy: {
          Statement: Match.arrayWith([
            {
              Effect: "Allow",
              // In the primary region, EventBridge alerts publish too, and cdk.json's
              // @aws-cdk/aws-iam:minimizePolicies merges the two services' statements
              Principal: { Service: r === EAST ? ["cloudwatch.amazonaws.com", "events.amazonaws.com"] : "cloudwatch.amazonaws.com" },
              Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
              Resource: "*",
              Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
            },
          ]),
        },
      });
    }
  });

  it("points every alarm action at a topic whose policy lets CloudWatch publish", () => {
    const t = observability();
    const allowed = new Set(
      Object.values(t.findResources("AWS::SNS::TopicPolicy"))
        .filter((p) =>
          (p.Properties.PolicyDocument as { Statement: { Effect: string; Principal?: { Service?: string } }[] }).Statement.some(
            (s) => s.Effect === "Allow" && s.Principal?.Service === "cloudwatch.amazonaws.com",
          ),
        )
        .flatMap((p) => (p.Properties.Topics as { Ref: string }[]).map((x) => x.Ref)),
    );
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm"));
    expect(alarms.length).toBeGreaterThan(0);
    for (const a of alarms) {
      for (const action of [...(a.Properties.AlarmActions as { Ref: string }[]), ...(a.Properties.OKActions as { Ref: string }[])]) {
        expect(allowed.has(action.Ref)).toBe(true);
      }
    }
  });

  it("subscribes P1 to email and SMS and P2 to email, from SSM parameters resolved at deploy time", () => {
    const t = observability();
    const subs = Object.values(t.findResources("AWS::SNS::Subscription")).map((r) => r.Properties);
    const params = t.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
    const described = subs.map((s) => {
      const param = params[s.Endpoint.Ref];
      expect(param.Type).toBe("AWS::SSM::Parameter::Value<String>");
      return `${s.TopicArn.Ref.replace(/^AlarmTopics(P\d).*$/, "$1")} ${s.Protocol} ${param.Default}`;
    });
    expect(described.sort()).toEqual([
      "P1 email /supply-checkout/prod/alarms/email-1",
      "P1 sms /supply-checkout/prod/alarms/sms-1",
      "P2 email /supply-checkout/prod/alarms/email-1",
    ]);
  });

  it("takes the number of recipients from context, as JSON or an object", () => {
    const two = observability(EAST, { alarmContacts: '{"email":2,"sms":2}' });
    two.resourceCountIs("AWS::SNS::Subscription", 6);
    const none = observability(EAST, { alarmContacts: { email: 0, sms: 0 } });
    none.resourceCountIs("AWS::SNS::Subscription", 0);
    expect(alarmContactsFromContext({ tryGetContext: () => ({ sms: 3 }) })).toEqual({ email: 1, sms: 3 });
    expect(alarmContactParameter("staging", "sms", 2)).toBe("/supply-checkout/staging/alarms/sms-2");
  });

  it("rejects a recipient count that isn't a small whole number", () => {
    for (const bad of [{ email: -1 }, { sms: 1.5 }, { email: 6 }, { sms: "2" }]) {
      expect(() => alarmContactsFromContext({ tryGetContext: () => bad }), JSON.stringify(bad)).toThrow(/alarmContacts/);
    }
  });

  it("never puts an address or phone number in the template", () => {
    const json = JSON.stringify(observability().toJSON());
    expect(json).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(json).not.toMatch(/\+\d{10,}/);
  });

  it("publishes the topic ARNs to SSM", () => {
    const t = observability();
    for (const p of ["p1", "p2"]) {
      t.hasResourceProperties("AWS::SSM::Parameter", { Name: `/supply-checkout/prod/observability/alarm-topic-${p}-arn` });
    }
  });
});

describe("journey alarms (docs/journeys.md)", () => {
  it("creates the alarms in every region, the primary-only ones in the primary region alone, each notifying its severity's topic on alarm and recovery", () => {
    for (const r of config.regions) {
      const t = observability(r);
      // The purge's own alarm is with the purge, and the operator audit and group watches' are with the watches, in the primary region only (tested below)
      const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm"))
        .map((a) => a.Properties)
        .filter((a) => !["supply-checkout-prod-p2-deletion-not-running", "supply-checkout-prod-p2-seat-reconcile-not-running"].includes(a.AlarmName) && !/operator-audit|operator-group|deletion-record|site-down|web-router|rum-events/.test(String(a.AlarmName)));
      const specs = journeyAlarmSpecs(r, "t", "api", "prod").filter((s) => r === config.primaryRegion || !s.primaryOnly);
      expect(alarms.map((a) => a.AlarmName).sort()).toEqual(
        specs.map((s) => `supply-checkout-prod-${s.severity.toLowerCase()}-${s.id}`).sort(),
      );
      const expected = r === config.primaryRegion ? ALARM_IDS : ALARM_IDS.filter((id) => !PRIMARY_ONLY_ALARM_IDS.includes(id));
      expect(specs.map((s) => s.id).sort()).toEqual([...expected].sort());
      for (const a of alarms) {
        const topic = a.AlarmName.includes("-p1-") ? /^AlarmTopicsP1/ : /^AlarmTopicsP2/;
        expect(a.AlarmActions[0].Ref).toMatch(topic);
        expect(a.OKActions).toEqual(a.AlarmActions);
        expect(a.TreatMissingData).toBe("notBreaching");
        expect(a.AlarmDescription).toContain(r);
        expect(a.AlarmDescription).toContain("docs/journeys.md");
      }
    }
  });

  it("creates the alarms on the scheduled checks' and the purge's gauges in the primary region only, where they run", () => {
    expect(journeyAlarmSpecs(EAST, "t", "api", "prod").filter((s) => s.primaryOnly).map((s) => s.id).sort()).toEqual([...PRIMARY_ONLY_ALARM_IDS].sort());
    const names = (r: string) => Object.values(observability(r).findResources("AWS::CloudWatch::Alarm")).map((a) => String(a.Properties.AlarmName));
    const east = names(EAST);
    const west = names(WEST);
    for (const id of PRIMARY_ONLY_ALARM_IDS) {
      expect(east.filter((n) => n.endsWith(`-${id}`))).toHaveLength(1);
      expect(west.filter((n) => n.endsWith(`-${id}`))).toEqual([]);
    }
    // The other region still gets every other journey alarm
    expect(west).toContain("supply-checkout-prod-p1-functions-failing");
    // A single-region deployment in the other region makes it the primary, with every alarm
    const solo = Object.values(Template.fromStack(build({}, { regions: [WEST], primaryRegion: WEST }).region(WEST).observability).findResources("AWS::CloudWatch::Alarm"))
      .map((a) => String(a.Properties.AlarmName));
    for (const id of PRIMARY_ONLY_ALARM_IDS) expect(solo.filter((n) => n.endsWith(`-${id}`))).toHaveLength(1);
  });

  it("reads business metrics from the SupplyCheckout namespace with the region as their only dimension", () => {
    const t = observability(WEST);
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p1-checkout-broken",
      Threshold: 0,
      Metrics: [
        Match.objectLike({
          MetricStat: {
            Metric: {
              Namespace: "SupplyCheckout",
              MetricName: BusinessMetric.CheckoutSessionErrors,
              Dimensions: [{ Name: "Region", Value: WEST }],
            },
            Stat: "Sum",
            Period: 300,
          },
        }),
      ],
    });
  });

  it("alarms on a rate only once there is enough traffic", () => {
    const t = observability();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-receipt-reading-failing",
      Threshold: 10,
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "IF(d >= 5, 100 * FILL(n, 0) / d, 0)" }),
        Match.objectLike({ Id: "n", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: "ReceiptReadFailures" }), Period: 900 }) }),
        Match.objectLike({ Id: "d", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: "ReceiptReads" }), Period: 900 }) }),
      ]),
    });
  });

  it("adds up DynamoDB system errors on the app table over every operation, filling gaps", () => {
    const t = observability();
    const [alarm] = Object.values(t.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: "supply-checkout-prod-p1-database-errors" } }));
    const [expr, ...metrics] = alarm.Properties.Metrics;
    const suffix = EAST.replaceAll("-", "_");
    expect(expr.Expression).toMatch(new RegExp(`^FILL\\(e0_${suffix}, 0\\)( \\+ FILL\\(e\\d_${suffix}, 0\\))+$`));
    expect(metrics.length).toBeLessThanOrEqual(9); // an alarm takes at most 10 metrics
    for (const m of metrics) {
      expect(m.MetricStat.Metric.Dimensions).toContainEqual({ Name: "TableName", Value: "supply-checkout-prod-app" });
    }
  });
});

describe("web app down alarms (supply-checkout-3sv.2)", () => {
  const webAlarm = (t: Template, id: string) => {
    const [alarm] = Object.values(t.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: `supply-checkout-prod-p1-${id}` } }));
    return alarm?.Properties;
  };
  const ssmRef = (t: Template, name: string) => {
    const [id] = Object.entries(t.findParameters("*", { Type: "AWS::SSM::Parameter::Value<String>", Default: name })).map(([k]) => k);
    expect(id).toBeDefined();
    return { Ref: id };
  };

  it("are in the global services region's observability stack only, reading the web stack's outputs", () => {
    expect(EAST).toBe(GLOBAL_SERVICES_REGION);
    const { stacks, region } = build();
    const east = Template.fromStack(region(EAST).observability);
    for (const id of ["site-down", "web-router-failing"]) {
      const a = webAlarm(east, id);
      expect(a).toBeDefined();
      expect(a.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP1/);
      expect(a.OKActions).toEqual(a.AlarmActions);
      expect(a.TreatMissingData).toBe("notBreaching");
      expect(a.EvaluationPeriods).toBe(1);
      expect(a.AlarmDescription).toContain("docs/observability.md, When the web app is down");
    }
    const west = Template.fromStack(region(WEST).observability);
    expect(webAlarm(west, "site-down")).toBeUndefined();
    expect(webAlarm(west, "web-router-failing")).toBeUndefined();
    expect(stacks.regions[EAST]?.observability.dependencies).toContain(stacks.web);
    // A deployment without the global services region has no stack there to hold them
    const solo = Template.fromStack(build({}, { regions: [WEST], primaryRegion: WEST }).region(WEST).observability);
    expect(webAlarm(solo, "site-down")).toBeUndefined();
  });

  it("Site down: the distribution's 5xx rate above 1%, only once there are enough requests", () => {
    const t = observability(EAST);
    const distribution = ssmRef(t, webOutputParameters("prod").distributionId);
    const a = webAlarm(t, "site-down");
    expect(a.Threshold).toBe(SITE_DOWN_PERCENT);
    expect(SITE_DOWN_PERCENT).toBe(1);
    expect(a.ComparisonOperator).toBe("GreaterThanThreshold");
    const [expr, ...metrics] = a.Metrics;
    expect(expr).toMatchObject({ Expression: `IF(r >= ${SITE_DOWN_MIN_REQUESTS}, FILL(e, 0), 0)`, ReturnData: true });
    expect(SITE_DOWN_MIN_REQUESTS).toBeGreaterThanOrEqual(20);
    const byId = Object.fromEntries(metrics.map((m: { Id: string }) => [m.Id, m]));
    expect(byId.e.MetricStat).toEqual({
      Metric: { Namespace: "AWS/CloudFront", MetricName: "5xxErrorRate", Dimensions: [{ Name: "DistributionId", Value: distribution }, { Name: "Region", Value: "Global" }] },
      Period: 300,
      Stat: "Average",
    });
    expect(byId.r.MetricStat).toEqual({
      Metric: { Namespace: "AWS/CloudFront", MetricName: "Requests", Dimensions: [{ Name: "DistributionId", Value: distribution }, { Name: "Region", Value: "Global" }] },
      Period: 300,
      Stat: "Sum",
    });
  });

  it("Web router failing: the router function's errors and throttles, added up", () => {
    const t = observability(EAST);
    const fn = ssmRef(t, webOutputParameters("prod").routerFunctionName);
    const a = webAlarm(t, "web-router-failing");
    expect(a.Threshold).toBe(ROUTER_FAILING_ABOVE);
    const [expr, ...metrics] = a.Metrics;
    expect(expr.Expression).toBe("FILL(x, 0) + FILL(v, 0) + FILL(t, 0)");
    expect(metrics.map((m: { MetricStat: { Metric: { MetricName: string } } }) => m.MetricStat.Metric.MetricName).sort()).toEqual(
      ["FunctionExecutionErrors", "FunctionThrottles", "FunctionValidationErrors"],
    );
    for (const m of metrics) {
      expect(m.MetricStat).toMatchObject({ Stat: "Sum", Period: 300 });
      expect(m.MetricStat.Metric).toMatchObject({ Namespace: "AWS/CloudFront", Dimensions: [{ Name: "FunctionName", Value: fn }, { Name: "Region", Value: "Global" }] });
    }
  });
});

describe("live update alarms", () => {
  it("watch the stream consumer's publishes, its iterator age and its dead-letter queue, by name", () => {
    const t = observability();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-live-updates-failing",
      Threshold: 1,
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "IF(d >= 20, 100 * FILL(n, 0) / d, 0)" }),
        Match.objectLike({ Id: "n", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: "LiveUpdateFailures" }), Period: 600 }) }),
        Match.objectLike({ Id: "d", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: "LiveUpdates" }), Period: 600 }) }),
      ]),
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-live-updates-delayed",
      Namespace: "AWS/Lambda",
      MetricName: "IteratorAge",
      Dimensions: [{ Name: "FunctionName", Value: "supply-checkout-prod-live-updates" }],
      Statistic: "Maximum",
      Threshold: 30000,
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-live-updates-dropped",
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Dimensions: [{ Name: "QueueName", Value: "supply-checkout-prod-live-updates-dlq" }],
      Threshold: 0,
    });
  });

  it("use the names the realtime stack gives its consumer and queue", () => {
    const stacks = build();
    const realtime = Template.fromStack(stacks.region(EAST).realtime);
    realtime.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "supply-checkout-prod-live-updates" });
    realtime.hasResourceProperties("AWS::SQS::Queue", { QueueName: "supply-checkout-prod-live-updates-dlq" });
  });
});

describe("alarms on sign-in, email and import failures the functions don't throw for", () => {
  it("alarms on repeated sign-out revoke failures (J0)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-sign-out-not-revoking",
      Metrics: [
        Match.objectLike({
          MetricStat: {
            Metric: { Namespace: "SupplyCheckout", MetricName: BusinessMetric.SignOutRevokeFailures, Dimensions: [{ Name: "Region", Value: EAST }] },
            Stat: "Sum",
            Period: 900,
          },
        }),
      ],
      Threshold: 2,
      ComparisonOperator: "GreaterThanThreshold",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
    });
  });

  it("alarms on any failed email_verified update, promotion or downgrade (J3)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-email-verification-not-saved",
      Threshold: 0,
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "FILL(v, 0) + FILL(u, 0)" }),
        Match.objectLike({ Id: "v", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.EmailVerifyFailures }), Period: 900, Stat: "Sum" }) }),
        Match.objectLike({ Id: "u", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.EmailUnverifyFailures }), Period: 900, Stat: "Sum" }) }),
      ]),
    });
  });

  it("alarms above 80% of the SES daily quota (J3) and on any stuck import (J2), reading the gauges' maximum", () => {
    const t = observability();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-near-sending-limit",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.EmailQuotaUsedPercent }), Stat: "Maximum", Period: 900 }) })],
      Threshold: 80,
      TreatMissingData: "notBreaching",
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-imports-stuck",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.StuckImports }), Stat: "Maximum", Period: 900 }) })],
      Threshold: 0,
    });
    // Each 15-minute period holds at least one run of the checks
    expect(CHECK_EVERY_MINUTES).toBeLessThanOrEqual(15);
    expect(STUCK_IMPORT_AFTER_MINUTES).toBe(60);
  });
});

describe("RUM cost guard (supply-checkout-3sv.7)", () => {
  const rumAlarm = (t: Template, name: string) => {
    const [alarm] = Object.values(t.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: name } }));
    return alarm?.Properties;
  };
  const events = {
    Metric: { Namespace: "AWS/RUM", MetricName: "RumEventPayloadSize", Dimensions: [{ Name: "application_name", Value: rumAppMonitorName("prod") }] },
    Period: 3600,
    Stat: "SampleCount",
  };

  it("counts the events the app monitor ingests in an hour: P2 well above real traffic, P1 at ten times that", () => {
    const t = observability(EAST);
    const surge = rumAlarm(t, "supply-checkout-prod-p2-rum-events-surge");
    const flood = rumAlarm(t, "supply-checkout-prod-p1-rum-events-flood");
    for (const [a, topic, threshold] of [[surge, /^AlarmTopicsP2/, RUM_EVENTS_SURGE_PER_HOUR], [flood, /^AlarmTopicsP1/, RUM_EVENTS_FLOOD_PER_HOUR]] as const) {
      expect(a).toBeDefined();
      expect(a.Metrics).toHaveLength(1);
      expect(a.Metrics[0].MetricStat).toEqual(events);
      expect(a.Threshold).toBe(threshold);
      expect(a.ComparisonOperator).toBe("GreaterThanThreshold");
      expect(a.EvaluationPeriods).toBe(1);
      expect(a.TreatMissingData).toBe("notBreaching");
      expect(a.AlarmActions[0].Ref).toMatch(topic);
      expect(a.OKActions).toEqual(a.AlarmActions);
      expect(a.AlarmDescription).toContain("docs/observability.md, When RUM events surge");
    }
    // At $1 per 100,000 events: the surge is at least a few times an honest day's traffic, and the flood ten times the surge
    expect(RUM_EVENTS_SURGE_PER_HOUR).toBeGreaterThanOrEqual(50_000);
    expect(RUM_EVENTS_FLOOD_PER_HOUR).toBe(10 * RUM_EVENTS_SURGE_PER_HOUR);
  });

  it("are only where the app monitor is, in the global services region", () => {
    expect(rumAlarm(observability(WEST), "supply-checkout-prod-p2-rum-events-surge")).toBeUndefined();
    expect(rumAlarm(observability(WEST), "supply-checkout-prod-p1-rum-events-flood")).toBeUndefined();
  });
});

describe("alarms added with the email code routes, the live update budget, team closure and the purge", () => {
  it("alarms on repeated 5xx answers from the email code routes (J3)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-email-codes-failing",
      Threshold: 2,
      EvaluationPeriods: 1,
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "FILL(s, 0) + FILL(c, 0)" }),
        Match.objectLike({ Id: "s", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.EmailCodeSendFailures }), Period: 900, Stat: "Sum" }) }),
        Match.objectLike({ Id: "c", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.EmailCodeVerifyFailures }), Period: 900, Stat: "Sum" }) }),
      ]),
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
    });
  });

  it("alarms on live updates deferred in 3 consecutive 5-minute periods, not on one (J4)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-live-updates-deferred",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.LiveUpdatesDeferred }), Stat: "Sum", Period: 300 }) })],
      Threshold: 0,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: "notBreaching",
    });
  });

  it("alarms on any owner not emailed that their team closed (J11)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-team-closed-notices-failing",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.TeamClosedNoticeFailures }), Stat: "Sum", Period: 900 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
    });
  });

  it("alarms on any security notice not emailed to an account's own address (J0, supply-checkout-3sv.13)", () => {
    for (const r of config.regions) {
      observability(r).hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "supply-checkout-prod-p2-security-notices-failing",
        Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.SecurityNoticeFailures, Dimensions: [{ Name: "Region", Value: r }] }), Stat: "Sum", Period: 900 }) })],
        Threshold: 0,
        ComparisonOperator: "GreaterThanThreshold",
        TreatMissingData: "notBreaching",
        AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
        AlarmDescription: Match.stringLikeRegexp("^P2 Security notices failing \\(J0"),
      });
    }
  });

  it("alarms on any owner not emailed that their team reopened (J11)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-team-reopened-notices-failing",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.TeamReopenedNoticeFailures }), Stat: "Sum", Period: 900 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("^P2 Team reopened emails failing \\(J11"),
    });
  });

  it("alarms on any reopened team whose subscription was set to end as it reopened, in every region (J7, J11)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-reopened-team-subscription-ended",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.ReopenedTeamSubscriptionsEnded }), Stat: "Sum", Period: 900 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("^P2 Reopened team's subscription ended \\(J7, J11"),
    });
  });

  it("alarms on any error or throttle of the post confirmation trigger, P1, where the user pool is (J1, supply-checkout-8jc.31)", () => {
    const fn = { Name: "FunctionName", Value: "supply-checkout-prod-post-confirmation" };
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p1-sign-up-trigger-failing",
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "FILL(e, 0) + FILL(t, 0)" }),
        Match.objectLike({ Id: "e", MetricStat: Match.objectLike({ Metric: { Namespace: "AWS/Lambda", MetricName: "Errors", Dimensions: [fn] }, Stat: "Sum", Period: 300 }) }),
        Match.objectLike({ Id: "t", MetricStat: Match.objectLike({ Metric: { Namespace: "AWS/Lambda", MetricName: "Throttles", Dimensions: [fn] }, Stat: "Sum", Period: 300 }) }),
      ]),
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP1") }],
      AlarmDescription: Match.stringLikeRegexp("^P1 Sign-up trigger failing \\(J1"),
    });
  });

  it("alarms on any closed team charged for a period after it closed, where the purge runs (J7, J11)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-closed-team-charged",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.ClosedTeamRenewalsCharged }), Stat: "Sum", Period: 3600 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("^P2 Closed team charged \\(J7, J11"),
    });
  });

  it("alarms on any closed team's subscription Stripe doesn't have, where the purge runs (J7, J11, supply-checkout-8jc.17)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-closed-team-subscription-not-found",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.ClosedTeamSubscriptionsNotFound }), Stat: "Sum", Period: 3600 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("^P2 Closed-team subscription not found in Stripe \\(J7, J11"),
    });
  });

  it("alarms while any closed team is set aside, on the purge's gauge, over periods that always hold a run (J7, J11, supply-checkout-8jc.36)", () => {
    const t = observability();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-closed-team-subscription-set-aside",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.ClosedTeamsSetAside }), Stat: "Maximum", Period: 2 * PURGE_EVERY_HOURS * 3600 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("^P2 Closed-team subscription set aside \\(J7, J11.*stays on until each team is handled"),
    });
    // Not on the one-off count, which goes quiet the hour after a team is set aside
    const onCount = Object.values(t.findResources("AWS::CloudWatch::Alarm")).filter((a) => JSON.stringify(a.Properties.Metrics ?? a.Properties.MetricName ?? "").includes(`"${BusinessMetric.ClosedTeamSubscriptionsSetAside}"`));
    expect(onCount).toEqual([]);
  });

  it("treats many closed teams set aside at once as an incident, P1, on the same gauge (J7, J11, supply-checkout-8jc.37)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p1-closed-team-subscriptions-set-aside-many",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.ClosedTeamsSetAside }), Stat: "Maximum", Period: 2 * PURGE_EVERY_HOURS * 3600 }) })],
      // At SET_ASIDE_INCIDENT_AT or more
      Threshold: SET_ASIDE_INCIDENT_AT - 1,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP1") }],
      AlarmDescription: Match.stringLikeRegexp("^P1 Many closed-team subscriptions set aside \\(J7, J11.*key or mode mismatch"),
    });
    expect(SET_ASIDE_INCIDENT_AT).toBe(5);
  });

  it("alarms on any purged team's Stripe customer Stripe says was already deleted, where the purge runs (J7, J11, supply-checkout-8jc.37)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-stripe-customer-already-deleted",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.StripeCustomersAlreadyDeleted }), Stat: "Sum", Period: 3600 }) })],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("^P2 Stripe customer already deleted \\(J7, J11.*deletion record"),
    });
  });

  it("alarms on any closed team overdue for deletion, over periods that always hold a purge run (J11)", () => {
    observability().hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-deletion-overdue",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.ClosedTeamsOverdue }), Stat: "Maximum", Period: 2 * PURGE_EVERY_HOURS * 3600 }) })],
      Threshold: 0,
      AlarmDescription: Match.stringLikeRegexp(`more than ${PURGE_OVERDUE_AFTER_HOURS} hours`),
    });
    expect(PURGE_OVERDUE_AFTER_HOURS).toBeGreaterThanOrEqual(PURGE_EVERY_HOURS);
  });
});

describe("scheduled checks", () => {
  const functions = (t: Template) => Object.values(t.findResources("AWS::Lambda::Function")).map((f) => f.Properties);

  it("run in the primary region only, every 10 minutes (the purge every hour, the seat reconciliation nightly), without retries", () => {
    const { region } = build();
    const west = Template.fromStack(region(WEST).observability);
    west.resourceCountIs("AWS::Lambda::Function", 0);
    west.resourceCountIs("AWS::Events::Rule", 0);
    const t = observability();
    expect(functions(t).map((f) => f.FunctionName).sort()).toEqual([
      "supply-checkout-prod-deletion-records-watch",
      "supply-checkout-prod-email-quota",
      "supply-checkout-prod-operator-audit-watch",
      "supply-checkout-prod-operator-group-watch",
      "supply-checkout-prod-seat-reconcile",
      "supply-checkout-prod-stuck-imports",
      "supply-checkout-prod-team-purge",
    ]);
    const rules = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties).filter((r) => r.ScheduleExpression !== undefined);
    expect(rules).toHaveLength(5);
    expect(rules.map((r) => r.ScheduleExpression).sort()).toEqual([`cron(0 ${SEAT_RECONCILE_HOUR_UTC} * * ? *)`, "rate(1 hour)", `rate(${CHECK_EVERY_MINUTES} minutes)`, `rate(${CHECK_EVERY_MINUTES} minutes)`, `rate(${GROUP_WATCH_EVERY_MINUTES} minutes)`].sort());
    for (const rule of rules) expect(rule.Targets).toEqual([expect.objectContaining({ RetryPolicy: { MaximumRetryAttempts: 0 } })]);
    t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "supply-checkout-prod-team-purge", Timeout: 300 });
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "supply-checkout-prod-stuck-imports",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Environment: { Variables: Match.objectLike({ TABLE_NAME: "supply-checkout-prod-app" }) },
    });
  });

  /** Every Allow statement on the function's role, X-Ray's own policy aside. */
  function statements(t: Template, functionName: string) {
    const [fn] = functions(t).filter((f) => f.FunctionName === functionName);
    const role = (fn.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    return Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === role) && !String(p.Properties.PolicyName).includes("XRayWrite"))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
  }

  it("let the stuck-import check read only the committing-imports partition's keys and progress", () => {
    const t = observability();
    const found = statements(t, "supply-checkout-prod-stuck-imports");
    expect(found.map((s) => s.Action)).toEqual([["logs:CreateLogStream", "logs:PutLogEvents"], "dynamodb:Query", ["kms:Decrypt", "kms:DescribeKey"]]);
    const query = found.find((s) => s.Action === "dynamodb:Query") as Record<string, unknown>;
    expect(query.Resource).toEqual({
      "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app/index/GSI1"]],
    });
    expect(query.Condition).toEqual({
      "ForAllValues:StringEquals": {
        "dynamodb:LeadingKeys": ["IMPORTS#COMMITTING"],
        "dynamodb:Attributes": ["PK", "SK", "GSI1PK", "GSI1SK", "committed", "total"],
      },
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
    });
    const kms = found.find((s) => JSON.stringify(s.Action).includes("kms")) as Record<string, unknown>;
    expect(kms.Condition).toEqual({ StringEquals: { "kms:ViaService": { "Fn::Join": ["", ["dynamodb.", { Ref: "AWS::Region" }, ".amazonaws.com"]] } } });
  });

  it("let the team purge find due teams in the closed-teams index and delete whole items, naming only keys and closure fields", () => {
    const found = statements(observability(), "supply-checkout-prod-team-purge");
    expect(found.map((s) => s.Action)).toEqual([
      ["logs:CreateLogStream", "logs:PutLogEvents"],
      "dynamodb:Query",
      "dynamodb:Query",
      ["dynamodb:DeleteItem", "dynamodb:GetItem"],
      "dynamodb:UpdateItem",
      ["kms:Decrypt", "kms:DescribeKey"],
      "secretsmanager:GetSecretValue",
      "s3:PutObject",
    ]);
    // The Stripe secret key of this environment's mode, and no other secret
    expect(found.find((s) => s.Sid === "ReadStripeSecretKey")).toEqual({
      Sid: "ReadStripeSecretKey",
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:secretsmanager:${EAST}:`, { Ref: "AWS::AccountId" }, ":secret:supply-checkout/prod/stripe/test-secret-key-??????"]] },
    });
    // Team deletion records only: no reads, deletes or retention changes, and not users/
    expect(found.at(-1)).toEqual({
      Sid: "PutTeamDeletionRecords",
      Effect: "Allow",
      Action: "s3:PutObject",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }, "/teams/*"]] },
      Condition: { Null: { "s3:if-none-match": "false" } },
    });
    const [fn] = functions(observability()).filter((f) => f.FunctionName === "supply-checkout-prod-team-purge");
    expect((fn.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({
      DELETIONS_BUCKET: { "Fn::Join": ["", [`supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] },
      DELETIONS_REGION: EAST,
      STRIPE_SECRET_ID: "supply-checkout/prod/stripe/test-secret-key",
      STRIPE_MODE: "test",
    });
    const attributes = ["PK", "SK", "GSI1PK", "GSI1SK", "closedAt", "purgeAfter", "purging", "stripeCustomerId", "stripeSubscriptionId", "stripeCancelledFor", "stripeSetAsideFor", "stripeSetAsideReason", "teamId"];
    const [, index, query, items, mark] = found as Record<string, unknown>[];
    expect(index?.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAMS#CLOSED"], "dynamodb:Attributes": attributes },
      // COUNT for the overdue gauge, which returns no items
      StringEquals: { "dynamodb:Select": ["SPECIFIC_ATTRIBUTES", "COUNT"] },
    });
    const table = {
      "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]],
    };
    expect(query?.Resource).toEqual(table);
    expect(query?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*", "USER#*", "STRIPE#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": attributes },
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
    });
    expect(items?.Resource).toEqual(table);
    expect(items?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*", "USER#*", "STRIPE#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": attributes },
      StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
    });
    // The purging mark and the subscription-ended record: team partitions only, naming only the META item's key, purgeAfter
    // and the two marks: never closedAt, so it can't close or reopen a team
    expect(mark?.Resource).toEqual(table);
    expect(mark?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "purgeAfter", "purging", "stripeCancelledFor", "stripeSetAsideFor", "stripeSetAsideReason"] },
      StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
    });
  });

  it("alarm when the team purge stops sending its gauge for 3 hours, in the primary region only (J11)", () => {
    const { region } = build();
    const east = Template.fromStack(region(EAST).observability);
    east.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-deletion-not-running",
      Metrics: [
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({ Namespace: "SupplyCheckout", MetricName: BusinessMetric.ClosedTeamsOverdue, Dimensions: [{ Name: "Region", Value: EAST }] }),
            Stat: "SampleCount",
            Period: PURGE_SILENT_ALARM_HOURS * 3600,
          }),
        }),
      ],
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      EvaluationPeriods: 1,
      TreatMissingData: "breaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      OKActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("docs/journeys.md"),
    });
    // More than two missed runs, so one slow run doesn't alarm
    expect(PURGE_SILENT_ALARM_HOURS).toBeGreaterThan(2 * PURGE_EVERY_HOURS);
    // The other region runs no purge, so an alarm there would always be in alarm
    const west = Object.values(Template.fromStack(region(WEST).observability).findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties.AlarmName);
    expect(west).not.toContain("supply-checkout-prod-p2-deletion-not-running");
  });

  it("let the seat reconciliation list teams from the operators' index by keys, customer, closure and status, and send only to the seat sync queue (supply-checkout-l50)", () => {
    const t = observability();
    const found = statements(t, "supply-checkout-prod-seat-reconcile");
    expect(found.map((s) => s.Action)).toEqual([["logs:CreateLogStream", "logs:PutLogEvents"], "dynamodb:Query", ["kms:Decrypt", "kms:DescribeKey"], "sqs:SendMessage"]);
    const query = found.find((s) => s.Action === "dynamodb:Query") as Record<string, unknown>;
    expect(query.Resource).toEqual({
      "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app/index/GSI3"]],
    });
    expect(query.Condition).toEqual({
      "ForAllValues:StringEquals": {
        "dynamodb:LeadingKeys": ["OPS#TEAMS"],
        "dynamodb:Attributes": ["PK", "SK", "GSI3PK", "GSI3SK", "stripeCustomerId", "closedAt", "status"],
      },
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
    });
    const send = found.find((s) => s.Action === "sqs:SendMessage") as Record<string, unknown>;
    expect(send.Resource).toEqual({
      "Fn::Join": ["", [`arn:aws:sqs:${EAST}:`, { Ref: "AWS::AccountId" }, ":supply-checkout-prod-seat-syncs.fifo"]],
    });
    const [fn] = functions(t).filter((f) => f.FunctionName === "supply-checkout-prod-seat-reconcile");
    expect(fn?.Timeout).toBe(300);
    expect(JSON.stringify(fn?.Environment)).toContain("/supply-checkout-prod-seat-syncs.fifo");
  });

  it("alarm when the seat reconciliation stops sending its gauge for two nights, in the primary region only (J7)", () => {
    const { region } = build();
    const east = Template.fromStack(region(EAST).observability);
    east.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-seat-reconcile-not-running",
      Metrics: [
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({ Namespace: "SupplyCheckout", MetricName: BusinessMetric.SeatReconcileTeams, Dimensions: [{ Name: "Region", Value: EAST }] }),
            Stat: "SampleCount",
            Period: 86400,
          }),
        }),
      ],
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      EvaluationPeriods: SEAT_RECONCILE_SILENT_ALARM_DAYS,
      DatapointsToAlarm: SEAT_RECONCILE_SILENT_ALARM_DAYS,
      TreatMissingData: "breaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
      AlarmDescription: Match.stringLikeRegexp("docs/journeys.md"),
    });
    const west = Object.values(Template.fromStack(region(WEST).observability).findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties.AlarmName);
    expect(west).not.toContain("supply-checkout-prod-p2-seat-reconcile-not-running");
  });

  it("let the SES quota check read the account's quota and nothing else", () => {
    const found = statements(observability(), "supply-checkout-prod-email-quota");
    expect(found.map((s) => [s.Action, s.Resource === "*" ? "*" : "own log group"])).toEqual([
      [["logs:CreateLogStream", "logs:PutLogEvents"], "own log group"],
      ["ses:GetAccount", "*"],
    ]);
  });
});

describe("operator group watch (supply-checkout-3sv.5)", () => {
  const NOT_CLOUDFORMATION = { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] };
  const functions = (t: Template) => Object.entries(t.findResources("AWS::Lambda::Function"));
  const poolParam = /^SsmParameterValuesupplycheckoutprodidentityopsuserpoolid/;

  it("runs every few minutes in the primary region only, from a rule the rule-tampering rules watch", () => {
    const { region } = build();
    const west = Template.fromStack(region(WEST).observability);
    expect(Object.values(west.findResources("AWS::Lambda::Function")).map((f) => f.Properties.FunctionName)).not.toContain("supply-checkout-prod-operator-group-watch");
    const t = observability();
    const rule = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties).find((r) => r.Name === operatorRuleName("prod", OPERATOR_GROUP_WATCH_RULE_SUFFIX));
    expect(rule?.ScheduleExpression).toBe(`rate(${GROUP_WATCH_EVERY_MINUTES} minutes)`);
    expect(rule?.State).toBe("ENABLED");
    expect(rule?.Targets).toEqual([expect.objectContaining({ RetryPolicy: { MaximumRetryAttempts: 0 } })]);
    // Under the prefix the tampering rules match, so disabling or retargeting it alerts P1
    expect(String(rule?.Name).startsWith(operatorRulePrefix("prod"))).toBe(true);
    expect(Object.values(OPERATOR_RULE_SUFFIXES)).not.toContain(OPERATOR_GROUP_WATCH_RULE_SUFFIX);
    const [, fn] = functions(t).find(([, f]) => f.Properties.FunctionName === "supply-checkout-prod-operator-group-watch") ?? [];
    expect(fn?.Properties.Environment.Variables).toMatchObject({
      OPS_USER_POOL_ID: { Ref: expect.stringMatching(poolParam) },
      GROUP_SNAPSHOT_PARAMETER: { Ref: expect.stringMatching(/^OperatorGroupWatchSnapshot/) },
    });
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: "/supply-checkout/prod/observability/operator-group-snapshot", Type: "String", Value: INITIAL_GROUP_SNAPSHOT });
    // Three missed runs before it's called silent
    expect(GROUP_WATCH_SILENT_ALARM_MINUTES).toBe(3 * GROUP_WATCH_EVERY_MINUTES);
  });

  it("may only list the operator pool's group members and read and write its own parameter", () => {
    const t = observability();
    const [, fn] = functions(t).find(([, f]) => f.Properties.FunctionName === "supply-checkout-prod-operator-group-watch") ?? [];
    const role = (fn?.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const found = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === role) && !String(p.Properties.PolicyName).includes("XRayWrite"))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(found.map((s) => s.Action)).toEqual([["logs:CreateLogStream", "logs:PutLogEvents"], "cognito-idp:ListUsersInGroup", ["ssm:GetParameter", "ssm:PutParameter"]]);
    expect(found[1]?.Resource).toEqual({
      "Fn::Join": ["", [`arn:aws:cognito-idp:${EAST}:`, { Ref: "AWS::AccountId" }, ":userpool/", { Ref: expect.stringMatching(poolParam) }]],
    });
    expect(JSON.stringify(found[2]?.Resource)).toContain("OperatorGroupWatchSnapshot");
    // Both only from the watch function itself: another function given this role gets neither (lambda:SourceFunctionArn)
    const onlyThisFunction = {
      ArnEquals: {
        "lambda:SourceFunctionArn": { "Fn::Join": ["", [`arn:aws:lambda:${EAST}:`, { Ref: "AWS::AccountId" }, ":function:supply-checkout-prod-operator-group-watch"]] },
      },
    };
    // Its log writes too: Lambda sets the key on the calls it makes for the function (supply-checkout-3sv.9)
    expect(found[0]?.Condition).toEqual(onlyThisFunction);
    expect(found[1]?.Condition).toEqual(onlyThisFunction);
    expect(found[2]?.Condition).toEqual(onlyThisFunction);
    expect(JSON.stringify(found)).not.toContain('"*"');
  });

  it("alarms P1 on any change to the group, and P2 when it stops running", () => {
    const t = observability();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p1-operator-group-changed",
      // A change, or a snapshot started again (the deploy's initial value, or one it couldn't read)
      Metrics: [
        Match.objectLike({ Expression: "FILL(changed, 0) + FILL(reset, 0)" }),
        Match.objectLike({ Id: "changed", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.OperatorGroupChanged, Dimensions: [{ Name: "Region", Value: EAST }] }), Stat: "Sum", Period: 300 }) }),
        Match.objectLike({ Id: "reset", MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.OperatorGroupBaselineReset, Dimensions: [{ Name: "Region", Value: EAST }] }), Stat: "Sum", Period: 300 }) }),
      ],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP1") }],
      AlarmDescription: Match.stringLikeRegexp("docs/infrastructure.md"),
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-operator-group-watch-silent",
      Metrics: [Match.objectLike({ MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: BusinessMetric.OperatorGroupMembers }), Stat: "SampleCount", Period: GROUP_WATCH_SILENT_ALARM_MINUTES * 60 }) })],
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AlarmTopicsP2") }],
    });
    const west = Object.values(Template.fromStack(build().region(WEST).observability).findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties.AlarmName);
    expect(west.filter((n) => String(n).includes("operator-group"))).toEqual([]);
  });

  it("tell P1 when either of its alarms is disabled, deleted or rewritten outside a deploy, in a rule of its own inside the pattern limit", () => {
    const t = observability();
    const rules = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties);
    const rule = rules.find((r) => r.Name === operatorRuleName("prod", OPERATOR_RULE_SUFFIXES.OperatorGroupWatchAlarmChanges));
    const alarms = ["supply-checkout-prod-p1-operator-group-changed", "supply-checkout-prod-p2-operator-group-watch-silent"];
    // By reference, to the two alarms with those names
    const byName = Object.entries(t.findResources("AWS::CloudWatch::Alarm"));
    const refs = alarms.map((name) => ({ Ref: byName.find(([, a]) => a.Properties.AlarmName === name)?.[0] }));
    expect(refs.every((r) => r.Ref)).toBe(true);
    expect(rule?.EventPattern).toEqual({
      source: ["aws.monitoring"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["monitoring.amazonaws.com"],
        $or: [
          { eventName: ["DisableAlarmActions", "DeleteAlarms"], requestParameters: { alarmNames: refs } },
          { eventName: ["PutMetricAlarm"], requestParameters: { alarmName: refs }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    expect(JSON.stringify(rule?.EventPattern).length).toBeLessThan(EVENT_PATTERN_LIMIT);
    expect(rule?.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
    expect(JSON.stringify(rule?.Targets)).toContain("an operator group watch alarm");
    // Every alarm the watch has is named there
    const own = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties.AlarmName).filter((n) => String(n).includes("operator-group"));
    expect(own.sort()).toEqual(alarms);
  });

  it("tell P1 when its snapshot parameter is changed or deleted by anyone but the watch's role or a deploy", () => {
    const t = observability();
    const rules = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties);
    const rule = rules.find((r) => r.Name === operatorRuleName("prod", OPERATOR_RULE_SUFFIXES.OperatorGroupSnapshotChanges));
    const role = Object.keys(t.findResources("AWS::IAM::Role")).find((id) => id.startsWith("OperatorGroupWatchRole"));
    const name = "/supply-checkout/prod/observability/operator-group-snapshot";
    // With any padding (SSM trims spaces from a name), which also covers an ARN (supply-checkout-6uw.22)
    const names = [{ wildcard: `*${name}*` }];
    const notTheWatch = { ...NOT_CLOUDFORMATION, sessionContext: { sessionIssuer: { arn: [{ exists: false }, { "anything-but": { "Fn::GetAtt": [role, "Arn"] } }] } } };
    expect(rule?.EventPattern).toEqual({
      source: ["aws.ssm"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["ssm.amazonaws.com"],
        $or: [
          { eventName: ["PutParameter", "DeleteParameter", "LabelParameterVersion", "UnlabelParameterVersion"], requestParameters: { name: names }, userIdentity: notTheWatch },
          { eventName: ["DeleteParameters"], requestParameters: { names }, userIdentity: notTheWatch },
        ],
      },
    });
    expect(GROUP_SNAPSHOT_EVENTS).toEqual(["PutParameter", "DeleteParameter", "LabelParameterVersion", "UnlabelParameterVersion"]);
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: name });
    expect(rule?.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
    expect(JSON.stringify(rule?.Targets)).toContain("the operator group watch's snapshot");
    // SSM trims spaces from the beginning and end of a name, so a padded name still pages (supply-checkout-6uw.22)
    const record = (eventName: string, requestParameters: Record<string, unknown>, invokedBy?: string) => ({
      source: "aws.ssm",
      "detail-type": "AWS API Call via CloudTrail",
      detail: { eventSource: "ssm.amazonaws.com", eventName, requestParameters, userIdentity: { sessionContext: { sessionIssuer: { arn: `arn:aws:iam::${"0".repeat(12)}:role/someone` } }, ...(invokedBy ? { invokedBy } : {}) } },
    });
    const pages = (event: unknown) => eventMatches(rule?.EventPattern, event);
    for (const padded of [name, ` ${name}`, `${name} `, `  ${name}  `]) {
      expect(pages(record("PutParameter", { name: padded })), JSON.stringify(padded)).toBe(true);
      expect(pages(record("DeleteParameters", { names: ["/other", padded] })), JSON.stringify(padded)).toBe(true);
      expect(pages(record("PutParameter", { name: padded }, "cloudformation.amazonaws.com")), JSON.stringify(padded)).toBe(false);
    }
    expect(pages(record("PutParameter", { name: "/supply-checkout/prod/observability/alarm-topic-p1-arn" }))).toBe(false);
  });

  it("lets OperatorPoolChanges match management events EventBridge counts as read-only too", () => {
    const t = observability();
    const rule = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties).find((r) => r.Name === operatorRuleName("prod", OPERATOR_RULE_SUFFIXES.OperatorPoolChanges));
    expect(OPERATOR_POOL_RULE_STATE).toBe("ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS");
    expect(rule?.State).toBe(OPERATOR_POOL_RULE_STATE);
    // Every other rule stays plainly enabled
    const others = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties).filter((r) => r.Name !== rule?.Name);
    expect(new Set(others.map((r) => r.State))).toEqual(new Set(["ENABLED"]));
  });
});

describe("dashboard", () => {
  const body = (template: Template) => {
    const [dash] = Object.values(template.findResources("AWS::CloudWatch::Dashboard"));
    // Join the Fn::Join parts that are plain strings; the rest are alarm ARNs and the region
    return (dash.Properties.DashboardBody["Fn::Join"][1] as unknown[]).filter((p) => typeof p === "string").join("");
  };

  it("is in the primary region only", () => {
    const { region } = build();
    Template.fromStack(region(EAST).observability).resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    Template.fromStack(region(WEST).observability).resourceCountIs("AWS::CloudWatch::Dashboard", 0);
    Template.fromStack(region(EAST).observability).hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: "supply-checkout-prod",
    });
  });

  it("shows traffic, errors, latency and every business metric, split by region", () => {
    const text = body(observability());
    for (const title of ["Traffic: API requests", "Errors: API 5xx rate %", "Latency: API p95 (ms)", "Latency: Lambda duration p95 (ms)"]) {
      expect(text).toContain(title);
    }
    for (const r of config.regions) {
      for (const name of Object.values(BusinessMetric)) {
        expect(text).toContain(`["SupplyCheckout","${name}","Region","${r}",{"label":"${name} (${r})","region":"${r}"`);
      }
      expect(text).toContain(`API requests (${r})`);
      expect(text).toContain(`Lambda Duration (${r})`);
    }
  });

  it("shows the web app's alarms and a row of CloudFront graphs", () => {
    const t = observability();
    const [dash] = Object.values(t.findResources("AWS::CloudWatch::Dashboard"));
    const all = JSON.stringify(dash.Properties.DashboardBody);
    for (const id of ["sitedown", "webrouterfailing"]) expect(all).toMatch(new RegExp(`"WebAlarms${id}[0-9A-F]{8}","Arn"`));
    const text = body(t);
    for (const title of ["Web: CloudFront requests", "Web: CloudFront 5xx rate %", "Web: router errors and throttles"]) expect(text).toContain(title);
    expect(text).toContain('"AWS/CloudFront","5xxErrorRate","DistributionId"');
    expect(text).toContain('"AWS/CloudFront","FunctionExecutionErrors","FunctionName"');
  });

  it("follows the configured regions", () => {
    const { region } = build({}, { regions: [EAST] });
    const text = body(Template.fromStack(region(EAST).observability));
    expect(text).toContain(`(${EAST})`);
    expect(text).not.toContain(WEST);
  });
});

describe("defaults for every function and log group", () => {
  const code = Code.fromInline("exports.handler = async () => {}");
  /** A function with the findings that are its author's concern, not the aspect's, acknowledged. */
  function testFunction(scope: Construct, id: string, tracing?: Tracing) {
    const fn = new LambdaFunction(scope, id, { runtime: Runtime.NODEJS_22_X, handler: "index.handler", code, tracing });
    Validations.of(fn).acknowledge({ id: "AwsSolutions-L1", reason: "Test function" });
    Validations.of(fn).acknowledge({
      id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
      reason: "Test function",
    });
    // A function that chooses its own tracing gets the X-Ray permissions from CDK instead
    if (tracing) Validations.of(fn).acknowledge({ id: "AwsSolutions-IAM5[Resource::*]", reason: "Test function" });
    return fn;
  }

  // With this flag (on in cdk.json), each function gets a LogGroup in the
  // template rather than one Lambda creates on first run with no retention.
  const MANAGED_LOG_GROUPS = "@aws-cdk/aws-lambda:useCdkManagedLogGroup";

  it("relies on CDK-managed function log groups, which cdk.json turns on", () => {
    const cdkJson = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8"));
    expect(cdkJson.context[MANAGED_LOG_GROUPS]).toBe(true);
  });

  function withFunctions() {
    const { app, region } = build({ [MANAGED_LOG_GROUPS]: true });
    // Outside the primary region, the observability stack has no functions or log groups of its own
    const stack = region(WEST).observability;
    testFunction(stack, "Plain");
    testFunction(stack, "PassThrough", Tracing.PASS_THROUGH);
    new LogGroup(stack, "Kept", { retention: RetentionDays.ONE_WEEK });
    // No retention: CDK writes its default of two years
    new LogGroup(stack, "Unset");
    return { app, api: stack };
  }

  it("turns on X-Ray tracing and JSON logs, with the X-Ray permissions in a policy of their own", () => {
    const { api } = withFunctions();
    const t = Template.fromStack(api);
    t.hasResourceProperties("AWS::Lambda::Function", {
      TracingConfig: { Mode: "Active" },
      LoggingConfig: Match.objectLike({ LogFormat: "JSON" }),
      Environment: { Variables: { POWERTOOLS_METRICS_NAMESPACE: "SupplyCheckout", SUPPLY_CHECKOUT_ENV: "prod" } },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyName: Match.stringLikeRegexp("XRayWrite"),
      PolicyDocument: { Statement: [{ Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"], Effect: "Allow", Resource: "*" }] },
    });
    expect(Object.keys(t.findResources("AWS::IAM::Policy", { Properties: { PolicyName: Match.stringLikeRegexp("XRayWrite") } }))).toHaveLength(1);
  });

  it("keeps a tracing mode the function chose", () => {
    const t = Template.fromStack(withFunctions().api);
    t.hasResourceProperties("AWS::Lambda::Function", { TracingConfig: { Mode: "PassThrough" } });
  });

  it("gives log groups the default retention unless they set one", () => {
    const t = Template.fromStack(withFunctions().api);
    expect(LOG_RETENTION).toBe(365);
    const retentions = Object.values(t.findResources("AWS::Logs::LogGroup")).map((g) => g.Properties.RetentionInDays);
    expect(retentions.sort()).toEqual([365, 365, 365, 7]);
  });

  it.each([
    ["the default build", {}, {}],
    ["one region", {}, { regions: [WEST], primaryRegion: WEST }],
  ] as const)("keeps every log group in every stack for LOG_RETENTION, in %s", (_name, context, overrides) => {
    const { stacks } = build({ [MANAGED_LOG_GROUPS]: true, ...context }, overrides);
    let count = 0;
    for (const stack of stacks.all) {
      for (const [id, group] of Object.entries(Template.fromStack(stack).findResources("AWS::Logs::LogGroup"))) {
        expect(group.Properties?.RetentionInDays, `${stack.stackName} ${id}`).toBe(LOG_RETENTION);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it("leaves nothing for cdk-nag to find", () => {
    const { app } = withFunctions();
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
  });

  it("applies to functions in every stack, not just the API", () => {
    const { region } = build();
    const fn = testFunction(region(WEST).realtime, "Publisher");
    Template.fromStack(region(WEST).realtime).hasResourceProperties("AWS::Lambda::Function", {
      TracingConfig: { Mode: "Active" },
    });
    expect(fn.node.tryFindChild("XRayWrite")).toBeDefined();
  });
});

/**
 * Whether an EventBridge pattern matches an event, for the few operators the
 * operator rules use: lists of values (a CloudFormation reference stands for
 * its value, and matches only the same reference), `exists`, `anything-but`
 * and `$or`. Not a full implementation; enough to show which rules a record
 * reaches.
 */
function eventMatches(pattern: unknown, event: unknown): boolean {
  const isReference = (v: object) => Object.keys(v).some((k) => k === "Ref" || k.startsWith("Fn::"));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const valueMatches = (rule: unknown, value: unknown): boolean => {
    if (rule && typeof rule === "object" && !isReference(rule)) {
      const r = rule as Record<string, unknown>;
      if ("exists" in r) return r.exists === (value !== undefined);
      if ("anything-but" in r) return value !== undefined && !same(value, r["anything-but"]);
      if ("wildcard" in r) {
        const pattern = String(r.wildcard).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        return typeof value === "string" && new RegExp(`^${pattern}$`, "s").test(value);
      }
      throw new Error(`Unsupported operator ${JSON.stringify(rule)}`);
    }
    return value !== undefined && same(rule, value);
  };
  const p = pattern as Record<string, unknown>;
  const e = (event ?? {}) as Record<string, unknown>;
  return Object.entries(p).every(([key, rule]) => {
    if (key === "$or") return (rule as unknown[]).some((branch) => eventMatches(branch, event));
    const value = e[key];
    if (Array.isArray(rule)) return rule.some((r) => (Array.isArray(value) ? value.some((v) => valueMatches(r, v)) : valueMatches(r, value)));
    return value !== undefined && typeof value === "object" && eventMatches(rule, value);
  });
}

/**
 * The names of the SSM parameters a template's value reads at deploy time: by
 * Ref to an SSM parameter, or by name inside an Fn::Sub.
 */
function ssmReads(t: Template) {
  const parameters = (t.toJSON() as { Parameters?: Record<string, { Type?: string; Default?: string }> }).Parameters ?? {};
  const isSsm = (id: string) => Boolean(parameters[id]?.Type?.startsWith("AWS::SSM::Parameter::Value"));
  const ssmRefs = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(ssmRefs);
    if (!value || typeof value !== "object") return [];
    const v = value as Record<string, unknown>;
    if (typeof v.Ref === "string" && isSsm(v.Ref)) return [String(parameters[v.Ref].Default)];
    if ("Fn::Sub" in v) {
      const sub = v["Fn::Sub"];
      const text = String(Array.isArray(sub) ? sub[0] : sub);
      const inText = [...text.matchAll(/\$\{([^}!.]+)\}/g)].map((m) => m[1]).filter(isSsm).map((id) => String(parameters[id].Default));
      return [...inText, ...(Array.isArray(sub) ? ssmRefs(sub[1]) : [])];
    }
    return Object.values(v).flatMap(ssmRefs);
  };
  return { parameters, isSsm, ssmRefs };
}

/**
 * Each change to each SSM parameter pages through its own rule, with or
 * without spaces around the name, unless CloudFormation made it; reading one,
 * or changing one of `notWatched`, pages through none.
 */
function expectEachParameterPagesItsOwnRule(ruleFor: Map<string, { props: Record<string, unknown> }>, notWatched: string[]) {
  const names = [...ruleFor.keys()];
  const record = (eventName: string, requestParameters: Record<string, unknown>, invokedBy?: string) => ({
    source: "aws.ssm",
    "detail-type": "AWS API Call via CloudTrail",
    detail: { eventSource: "ssm.amazonaws.com", eventName, requestParameters, userIdentity: { type: "AssumedRole", ...(invokedBy ? { invokedBy } : {}) } },
  });
  const paging = (event: unknown) => names.filter((n) => eventMatches(ruleFor.get(n)?.props.EventPattern, event));
  for (const name of names) {
    for (const padded of [name, ` ${name}`, `${name} `, `   ${name}  `]) {
      const label = JSON.stringify(padded);
      for (const eventName of RULE_INPUT_PARAMETER_EVENTS) {
        expect(paging(record(eventName, { name: padded, overwrite: true })), `${eventName} ${label}`).toEqual([name]);
        expect(paging(record(eventName, { name: padded }, "cloudformation.amazonaws.com")), `${eventName} ${label} by a deploy`).toEqual([]);
      }
      expect(paging(record("DeleteParameters", { names: ["/supply-checkout/prod/other", padded] })), `DeleteParameters ${label}`).toEqual([name]);
      expect(paging(record("DeleteParameters", { names: [padded] }, "cloudformation.amazonaws.com")), `DeleteParameters ${label} by a deploy`).toEqual([]);
    }
    // Reading one isn't a change, and DeleteParameter's name isn't in `names`
    expect(paging(record("GetParameter", { name })), `GetParameter ${name}`).toEqual([]);
    expect(paging(record("DeleteParameter", { names: [name] })), `DeleteParameter with names ${name}`).toEqual([]);
  }
  for (const name of notWatched) {
    expect(paging(record("PutParameter", { name })), name).toEqual([]);
    expect(paging(record("DeleteParameters", { names: [name] })), name).toEqual([]);
  }
}

describe("operator pool alerts (ADR 0015)", () => {
  const NOT_CLOUDFORMATION = { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] };

  function operatorRules() {
    const t = observability();
    // The deletion records watch's rules are tested with the watch
    const rules = Object.entries(t.findResources("AWS::Events::Rule")).filter(([id, r]) => r.Properties.EventPattern && !id.startsWith("DeletionRecordsWatch"));
    expect(rules).toHaveLength(28);
    const byId = (prefix: string) => {
      // Logical IDs end in an 8-character hash
      const found = rules.find(([id]) => id.startsWith(prefix) && /^[0-9A-F]{8}$/.test(id.slice(prefix.length)));
      if (!found) throw new Error(`No rule ${prefix}`);
      return { id: found[0], props: found[1].Properties as Record<string, unknown> };
    };
    return {
      t,
      admin: byId("OperatorPoolChanges"),
      protection: byId("OperatorPoolProtection"),
      branding: byId("OperatorBrandingChanges"),
      self: byId("OperatorSelfServiceChanges"),
      watchChanges: byId("OperatorAuditWatchChanges"),
      roleChanges: byId("OperatorAuditWatchRoleChanges"),
      logChanges: byId("OperatorAuditWatchLogChanges"),
      tableChanges: byId("OperatorAuditWatchTableChanges"),
      alarmChanges: byId("OperatorAlarmChanges"),
      groupAlarmChanges: byId("OperatorGroupWatchAlarmChanges"),
      snapshotChanges: byId("OperatorGroupSnapshotChanges"),
      inputs: ["OperatorInputOpsPoolId", "OperatorInputOpsBrandingId", "OperatorInputTrailKeyArn", "OperatorInputTableKeyArn", "OperatorInputTableStreamArn"].map(byId),
      authorizers: ["OperatorAuthorizerIssuerUrl", "OperatorAuthorizerWebClientId", "OperatorAuthorizerUserPoolId", "OperatorAuthorizerOpsIssuerUrl", "OperatorAuthorizerOpsClientId", "OperatorAuthorizerAuthUrl"].map(byId),
      routeChanges: byId("OperatorAlertRouteChanges"),
      keyAndTrailChanges: byId("OperatorAlertKeyAndTrailChanges"),
      trailBucketChanges: byId("OperatorTrailBucketChanges"),
      tampering: byId("OperatorRuleTampering"),
      tamperingWatch: byId("OperatorRuleTamperingWatch"),
      deletionsTampering: byId("DeletionsRuleTampering"),
    };
  }

  it("tell P1 about user, group, password, MFA and pool changes, and what an operator's own token changes, in the primary region only", () => {
    const { region } = build();
    const west = Template.fromStack(region(WEST).observability);
    expect(Object.values(west.findResources("AWS::Events::Rule")).filter((r) => r.Properties.EventPattern)).toEqual([]);
    const { t, admin, protection, branding, self, watchChanges, roleChanges, logChanges, tableChanges, alarmChanges, groupAlarmChanges, snapshotChanges, inputs, authorizers, routeChanges, keyAndTrailChanges, trailBucketChanges, tampering, tamperingWatch, deletionsTampering } = operatorRules();
    const poolId = { Ref: expect.stringMatching(/identityopsuserpoolid/i) };
    expect(admin.props.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        requestParameters: { userPoolId: [poolId] },
        $or: [
          { eventName: [...OPERATOR_USER_EVENTS] },
          { eventName: [...OPERATOR_POOL_CONFIG_EVENTS], userIdentity: NOT_CLOUDFORMATION },
          // Locking an operator out: outside a deploy (supply-checkout-6uw.16)
          { eventName: [...OPERATOR_LOCKOUT_EVENTS], userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    // Deleting an operator always alerts; disabling or signing one out alerts outside a deploy (supply-checkout-6uw.16)
    expect(OPERATOR_USER_EVENTS).toContain("AdminDeleteUser");
    expect([...OPERATOR_LOCKOUT_EVENTS]).toEqual(["AdminDisableUser", "AdminUserGlobalSignOut"]);
    for (const name of ["AdminDeleteUser", "AdminDisableUser", "AdminUserGlobalSignOut", "AdminCreateUser", "AdminAddUserToGroup", "AdminRemoveUserFromGroup", "UpdateUserPool", "SetUserPoolMfaConfig", "CreateUserPoolClient", "UpdateUserPoolClient", "AdminSetUserPassword", "AdminResetUserPassword", "AdminEnableUser", "AdminSetUserMFAPreference", "AdminUpdateUserAttributes", "CreateGroup", "UpdateGroup", "DeleteGroup", "CreateIdentityProvider", "AdminLinkProviderForUser"]) {
      expect(OPERATOR_POOL_ADMIN_EVENTS, name).toContain(name);
    }
    // Deleting or changing the ops client, domain or identity providers locks every operator out as surely as deleting them: outside a deploy (supply-checkout-6uw.19)
    for (const name of ["DeleteUserPoolClient", "DeleteUserPoolDomain", "UpdateUserPoolDomain", "DeleteIdentityProvider", "UpdateIdentityProvider"]) {
      expect(OPERATOR_POOL_CONFIG_EVENTS, name).toContain(name);
    }
    // A second (custom) domain, and the ops client's managed login branding (its only style): outside a deploy (supply-checkout-6uw.20)
    for (const name of ["CreateUserPoolDomain", "DeleteManagedLoginBranding", "UpdateManagedLoginBranding"]) {
      expect(OPERATOR_POOL_CONFIG_EVENTS, name).toContain(name);
    }
    // The pool itself (supply-checkout-6uw.20): deleting it, or an UpdateUserPool that leaves deletion protection anything but
    // ACTIVE, whoever makes it. UpdateUserPool resets a setting it isn't given to its default, and DeletionProtection's
    // default is INACTIVE, so a call without it turns protection off too: matched by `exists: false`. DeleteUserPool
    // carries no deletionProtection, so it always matches
    expect([...OPERATOR_POOL_PROTECTION_EVENTS]).toEqual(["DeleteUserPool", "UpdateUserPool"]);
    expect(protection.props.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: ["DeleteUserPool", "UpdateUserPool"],
        requestParameters: { userPoolId: [poolId], deletionProtection: [{ exists: false }, { "anything-but": "ACTIVE" }] },
      },
    });
    // No CloudFormation exemption: a deploy that turns protection off is the first step of deleting the pool
    expect(JSON.stringify(protection.props.EventPattern)).not.toContain("userIdentity");
    expect(protection.props.Name).toBe(operatorRuleName("prod", OPERATOR_RULE_SUFFIXES.OperatorPoolProtection));
    expect(JSON.stringify(protection.props.Targets)).toContain("the operator pool itself");
    expect(self.props.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: ["AssociateSoftwareToken", "VerifySoftwareToken", "SetUserMFAPreference", "UpdateUserAttributes", "DeleteUser"],
        $or: [{ requestParameters: { userPoolId: [poolId] } }, { additionalEventData: { userPoolId: [poolId] } }],
      },
    });
    expect([...OPERATOR_SELF_SERVICE_EVENTS]).toHaveLength(5);
    for (const rule of [admin, protection, branding, self, watchChanges, roleChanges, logChanges, tableChanges, alarmChanges, trailBucketChanges, ...inputs, ...authorizers, tampering, tamperingWatch]) {
      expect(rule.props.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
      expect(JSON.stringify(rule.props.Targets)).not.toContain("userIdentity");
    }
    // The route an alert takes: both topics, so breaking one still reaches the other
    for (const rule of [routeChanges, keyAndTrailChanges]) {
      expect(rule.props.Targets).toEqual([
        expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } }),
        expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP2/) } }),
      ]);
    }
    // Only these rules may publish
    const statements = Object.values(t.findResources("AWS::SNS::TopicPolicy")).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    const fromEvents = statements.filter((st) => (st.Principal as { Service?: unknown } | undefined)?.Service === "events.amazonaws.com");
    expect(fromEvents).toHaveLength(4);
    expect(fromEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Sid: "AllowOperatorPoolAlertToPublish",
        Condition: { ArnEquals: { "aws:SourceArn": [admin, protection, branding, self, watchChanges, roleChanges, logChanges, tableChanges, alarmChanges, groupAlarmChanges, snapshotChanges, ...inputs, ...authorizers, routeChanges, keyAndTrailChanges, trailBucketChanges, tampering, tamperingWatch, deletionsTampering].map((r) => ({ "Fn::GetAtt": [r.id, "Arn"] })) } },
      }),
      // The two route rules on the P2 topic, and nothing else
      expect.objectContaining({
        Sid: "AllowAlertRouteChangesToPublish",
        Resource: { Ref: expect.stringMatching(/^AlarmTopicsP2/) },
        Condition: { ArnEquals: { "aws:SourceArn": [routeChanges, keyAndTrailChanges].map((r) => ({ "Fn::GetAtt": [r.id, "Arn"] })) } },
      }),
      // The deletion records bucket's change rule (tested with the watch)
      expect.objectContaining({ Sid: "AllowDeletionsBucketAlertToPublish" }),
      // The backup stack's two change-alert rules, by name (tested in backup.test.ts)
      expect.objectContaining({ Sid: "AllowBackupChangeAlertsToPublish" }),
    ]));
  });

  it("never exempt CloudFormation from user, membership, password or MFA calls, only from pool, client and group configuration (supply-checkout-6uw.7)", () => {
    // The two lists split the calls, with nothing in both
    expect([...OPERATOR_POOL_ADMIN_EVENTS].sort()).toEqual([...OPERATOR_USER_EVENTS, ...OPERATOR_POOL_CONFIG_EVENTS, ...OPERATOR_LOCKOUT_EVENTS].sort());
    expect(new Set(OPERATOR_POOL_ADMIN_EVENTS).size).toBe(OPERATOR_POOL_ADMIN_EVENTS.length);
    for (const name of ["AdminDeleteUser", "AdminCreateUser", "AdminAddUserToGroup", "AdminRemoveUserFromGroup", "AdminSetUserPassword", "AdminResetUserPassword", "AdminEnableUser", "AdminSetUserMFAPreference", "AdminUpdateUserAttributes", "AdminLinkProviderForUser"]) {
      expect(OPERATOR_USER_EVENTS, name).toContain(name);
    }
    // Every exempt call configures the pool, a client, a group or a provider: none names a user
    for (const name of OPERATOR_POOL_CONFIG_EVENTS) {
      expect(name).toMatch(/^(Create|Update|Delete|Set)(Group|UserPool|UserPoolMfaConfig|UserPoolClient|UserPoolDomain|IdentityProvider|ManagedLoginBranding)$/);
      expect(name).not.toMatch(/User(?!Pool)|Password|MFAPreference|Admin/);
    }
    const { admin } = operatorRules();
    const pattern = admin.props.EventPattern as { detail: Record<string, unknown> };
    // No exemption at the top of the pattern: only on the configuration branch
    expect(pattern.detail).not.toHaveProperty("userIdentity");
    const branches = pattern.detail.$or as { eventName: string[]; userIdentity?: unknown }[];
    const always = branches.filter((b) => b.userIdentity === undefined).flatMap((b) => b.eventName);
    expect(always).toEqual([...OPERATOR_USER_EVENTS]);
  });

  it("tell P1 about calls on the ops branding by its branding ID, even without the pool ID, outside a deploy (supply-checkout-6uw.21)", () => {
    const { admin, branding } = operatorRules();
    const poolId = { Ref: expect.stringMatching(/identityopsuserpoolid/i) };
    const brandingId = { Ref: expect.stringMatching(/identityopsbrandingid/i) };
    expect([...OPERATOR_BRANDING_EVENTS]).toEqual(["DeleteManagedLoginBranding", "UpdateManagedLoginBranding"]);
    for (const name of OPERATOR_BRANDING_EVENTS) expect(OPERATOR_POOL_CONFIG_EVENTS, name).toContain(name);
    expect(branding.props.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: ["DeleteManagedLoginBranding", "UpdateManagedLoginBranding"],
        // A call that names the ops pool alerts through OperatorPoolChanges already, so it isn't paged twice
        requestParameters: { managedLoginBrandingId: [brandingId], userPoolId: [{ exists: false }, { "anything-but": poolId }] },
        userIdentity: NOT_CLOUDFORMATION,
      },
    });
    expect(branding.props.Name).toBe(operatorRuleName("prod", OPERATOR_RULE_SUFFIXES.OperatorBrandingChanges));
    expect(branding.props.State).toBe("ENABLED");
    expect(JSON.stringify(branding.props.Targets)).toContain("the operator pool's managed login branding");

    // Between them, the two rules page exactly once for a branding call on the ops branding, whichever IDs it carries
    const pool = (admin.props.EventPattern as { detail: { requestParameters: { userPoolId: unknown[] } } }).detail.requestParameters.userPoolId[0];
    const ours = (branding.props.EventPattern as { detail: { requestParameters: { managedLoginBrandingId: unknown[] } } }).detail.requestParameters.managedLoginBrandingId[0];
    const record = (eventName: string, requestParameters: Record<string, unknown>, invokedBy?: string) => ({
      source: "aws.cognito-idp",
      "detail-type": "AWS API Call via CloudTrail",
      detail: { eventSource: "cognito-idp.amazonaws.com", eventName, requestParameters, userIdentity: { type: "AssumedRole", ...(invokedBy ? { invokedBy } : {}) } },
    });
    const pages = (event: unknown) => [admin, branding].filter((r) => eventMatches(r.props.EventPattern, event)).length;
    for (const eventName of OPERATOR_BRANDING_EVENTS) {
      expect(pages(record(eventName, { managedLoginBrandingId: ours })), `${eventName} by branding ID only`).toBe(1);
      expect(pages(record(eventName, { userPoolId: pool })), `${eventName} by pool ID only`).toBe(1);
      expect(pages(record(eventName, { userPoolId: pool, managedLoginBrandingId: ours })), `${eventName} by both`).toBe(1);
      expect(pages(record(eventName, { userPoolId: { Ref: "another pool" }, managedLoginBrandingId: ours })), `${eventName} naming another pool`).toBe(1);
      // Another branding in another pool, and a deploy's own calls, don't page
      expect(pages(record(eventName, { userPoolId: { Ref: "another pool" }, managedLoginBrandingId: { Ref: "another branding" } })), `${eventName} on another branding`).toBe(0);
      expect(pages(record(eventName, { managedLoginBrandingId: { Ref: "another branding" } })), `${eventName} on another branding, no pool`).toBe(0);
      expect(pages(record(eventName, { managedLoginBrandingId: ours }, "cloudformation.amazonaws.com")), `${eventName} by a deploy`).toBe(0);
      expect(pages(record(eventName, { userPoolId: pool, managedLoginBrandingId: ours }, "cloudformation.amazonaws.com")), `${eventName} by a deploy, both IDs`).toBe(0);
    }
    // Other calls carrying the branding ID aren't this rule's
    expect(eventMatches(branding.props.EventPattern, record("DescribeManagedLoginBranding", { managedLoginBrandingId: ours }))).toBe(false);
  });

  it("tell P1 when an SSM parameter an operator rule or watch reads at deploy time is changed or deleted outside a deploy, however its name is padded (supply-checkout-6uw.22)", () => {
    const { t, inputs } = operatorRules();
    const expected = {
      OperatorInputOpsPoolId: "/supply-checkout/prod/identity/ops-user-pool-id",
      OperatorInputOpsBrandingId: "/supply-checkout/prod/identity/ops-branding-id",
      OperatorInputTrailKeyArn: "/supply-checkout/prod/audit/trail-key-arn",
      OperatorInputTableKeyArn: "/supply-checkout/prod/data/table-key-arn",
      OperatorInputTableStreamArn: "/supply-checkout/prod/data/table-stream-arn",
    };
    expect(operatorRuleInputParameters("prod")).toEqual(expected);
    const names = Object.values(expected);
    expect([...RULE_INPUT_PARAMETER_EVENTS]).toEqual(["PutParameter", "DeleteParameter", "LabelParameterVersion", "UnlabelParameterVersion"]);
    // SSM trims spaces from the beginning and end of a name, so one wildcard on each side (which also covers an ARN)
    expect(ssmParameterNameMatch("/a/b")).toEqual({ wildcard: "*/a/b*" });
    expect(inputs).toHaveLength(names.length);
    const ruleFor = new Map<string, (typeof inputs)[number]>();
    for (const [id, name] of Object.entries(expected)) {
      const rule = inputs.find((r) => r.id.startsWith(id));
      if (!rule) throw new Error(`No rule ${id}`);
      ruleFor.set(name, rule);
      const match = [{ wildcard: `*${name}*` }];
      // One parameter per rule: two wildcards, so EventBridge doesn't refuse the pattern as too complex
      expect(rule.props.EventPattern, id).toEqual({
        source: ["aws.ssm"],
        "detail-type": ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["ssm.amazonaws.com"],
          $or: [
            { eventName: [...RULE_INPUT_PARAMETER_EVENTS], requestParameters: { name: match }, userIdentity: NOT_CLOUDFORMATION },
            // DeleteParameters names it in a list
            { eventName: ["DeleteParameters"], requestParameters: { names: match }, userIdentity: NOT_CLOUDFORMATION },
          ],
        },
      });
      expect(JSON.stringify(rule.props.EventPattern).split("*").length - 1, id).toBe(4);
      expect(rule.props.Name).toBe(operatorRuleName("prod", OPERATOR_RULE_SUFFIXES[id as keyof typeof OPERATOR_RULE_SUFFIXES]));
      expect(rule.props.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
      expect(JSON.stringify(rule.props.Targets)).toContain(`the SSM parameter ${name}, which the operator alerts read at deploy time`);
    }

    // Every SSM parameter an operator rule's pattern, or either watch, reads at deploy time is one of them:
    // by Ref, or by name inside an Fn::Sub; and nothing reads one through a {{resolve:ssm:...}} dynamic reference
    const { parameters, isSsm, ssmRefs } = ssmReads(t);
    // The Fn::Sub scan finds a parameter named in one
    const someSsm = Object.keys(parameters).find(isSsm) ?? "";
    expect(someSsm).not.toBe("");
    expect(ssmRefs({ "Fn::Sub": `x-\${${someSsm}}-\${AWS::Region}` })).toEqual([parameters[someSsm].Default]);
    const operatorRuleResources = Object.entries(t.findResources("AWS::Events::Rule")).filter(([id, r]) => r.Properties.EventPattern && !id.startsWith("DeletionRecordsWatch"));
    const watchResources = [
      ...Object.entries(t.findResources("AWS::Lambda::EventSourceMapping")),
      ...Object.entries(t.findResources("AWS::Lambda::Function")).filter(([id]) => id.startsWith("OperatorAuditWatch") || id.startsWith("OperatorGroupWatch")),
      ...Object.entries(t.findResources("AWS::IAM::Policy")).filter(([id]) => id.startsWith("OperatorAuditWatch") || id.startsWith("OperatorGroupWatch")),
    ];
    const read = new Set([...operatorRuleResources, ...watchResources].flatMap(([, r]) => ssmRefs(r.Properties)));
    expect([...read].sort()).toEqual([...names].sort());

    // Each call on each parameter pages through its own rule, with or without spaces around the name, unless CloudFormation
    // made it; nothing else does: another environment's parameter, or a sibling these rules don't read
    expectEachParameterPagesItsOwnRule(ruleFor, ["/supply-checkout/staging/identity/ops-user-pool-id", "/supply-checkout/prod/identity/user-pool-id", "/supply-checkout/prod/identity/ops-client-id", "/supply-checkout/prod/data/table-arn"]);
  });

  it("tell P1 when an SSM parameter sign-in or the API's or realtime authorizers read is changed or deleted outside a deploy, however its name is padded (supply-checkout-6uw.23)", () => {
    const { authorizers } = operatorRules();
    const expected = {
      OperatorAuthorizerIssuerUrl: "/supply-checkout/prod/identity/issuer-url",
      OperatorAuthorizerWebClientId: "/supply-checkout/prod/identity/web-client-id",
      OperatorAuthorizerUserPoolId: "/supply-checkout/prod/identity/user-pool-id",
      OperatorAuthorizerOpsIssuerUrl: "/supply-checkout/prod/identity/ops-issuer-url",
      OperatorAuthorizerOpsClientId: "/supply-checkout/prod/identity/ops-client-id",
      OperatorAuthorizerAuthUrl: "/supply-checkout/prod/identity/auth-url",
    };
    expect(authorizerInputParameters("prod")).toEqual(expected);
    expect(authorizers).toHaveLength(Object.keys(expected).length);
    const ruleFor = new Map<string, (typeof authorizers)[number]>();
    for (const [id, name] of Object.entries(expected)) {
      const rule = authorizers.find((r) => r.id.startsWith(id) && /^[0-9A-F]{8}$/.test(r.id.slice(id.length)));
      if (!rule) throw new Error(`No rule ${id}`);
      ruleFor.set(name, rule);
      const match = [{ wildcard: `*${name}*` }];
      expect(rule.props.EventPattern, id).toEqual({
        source: ["aws.ssm"],
        "detail-type": ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["ssm.amazonaws.com"],
          $or: [
            { eventName: [...RULE_INPUT_PARAMETER_EVENTS], requestParameters: { name: match }, userIdentity: NOT_CLOUDFORMATION },
            { eventName: ["DeleteParameters"], requestParameters: { names: match }, userIdentity: NOT_CLOUDFORMATION },
          ],
        },
      });
      expect(JSON.stringify(rule.props.EventPattern).split("*").length - 1, id).toBe(4);
      // Under the operator prefix, so the rule-tampering rules watch it
      expect(rule.props.Name).toBe(operatorRuleName("prod", OPERATOR_RULE_SUFFIXES[id as keyof typeof OPERATOR_RULE_SUFFIXES]));
      expect(String(rule.props.Name).startsWith(operatorRulePrefix("prod"))).toBe(true);
      expect(rule.props.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
      expect(JSON.stringify(rule.props.Targets)).toContain(`the SSM parameter ${name}, which sign-in or the API's and realtime authorizers read at deploy or publish time`);
    }
    expectEachParameterPagesItsOwnRule(ruleFor, ["/supply-checkout/staging/identity/issuer-url", "/supply-checkout/prod/identity/ops-user-pool-id", "/supply-checkout/prod/identity/ops-auth-url", "/supply-checkout/prod/identity/user-pool-arn"]);

    // Every identity parameter anything in the api or realtime stack reads (authorizers, functions' environments, policies)
    // is watched by one of these rules or OperatorInputOpsPoolId, but the operator pool's ARN: it's only an IAM resource (the
    // ops function's AdminListGroupsForUser), so a rewritten one narrows a permission and fails closed
    const { region } = build();
    const api = Template.fromStack(region(EAST).api);
    const realtime = Template.fromStack(region(EAST).realtime);
    const identityReads = (t: Template) => ssmReads(t).ssmRefs((t.toJSON() as { Resources: unknown }).Resources).filter((n) => n.startsWith("/supply-checkout/prod/identity/"));
    const read = new Set([...identityReads(api), ...identityReads(realtime)]);
    const watched = new Set([...Object.values(expected), operatorRuleInputParameters("prod").OperatorInputOpsPoolId]);
    const failClosed = ["/supply-checkout/prod/identity/ops-user-pool-arn"];
    expect([...read].filter((n) => !watched.has(n)).sort()).toEqual(failClosed);
    // The JWT authorizers, the ops function and the realtime authorizer function are among what's read
    const fed = (t: Template, resources: [string, { Properties?: unknown }][]) => resources.flatMap(([, r]) => ssmReads(t).ssmRefs(r.Properties));
    const jwtAuthorizers = Object.entries(api.findResources("AWS::ApiGatewayV2::Authorizer"));
    expect(jwtAuthorizers.map(([, r]) => r.Properties.AuthorizerType)).toEqual(["JWT", "JWT"]);
    const opsFunction = Object.entries(api.findResources("AWS::Lambda::Function")).filter(([id]) => /^OpsFunction[0-9A-F]{8}$/.test(id));
    const realtimeAuthorizer = Object.entries(realtime.findResources("AWS::Lambda::Function")).filter(([id]) => /^Authorizer[0-9A-F]{8}$/.test(id));
    expect([opsFunction, realtimeAuthorizer].map((f) => f.length)).toEqual([1, 1]);
    const tokenChecks = new Set([...fed(api, jwtAuthorizers), ...fed(api, opsFunction), ...fed(realtime, realtimeAuthorizer)]);
    expect([...tokenChecks].sort()).toEqual([...watched].filter((n) => !n.endsWith("/auth-url")).sort());
    // The auth function's sign-in URL is fixed in the template, not read from SSM; publish-web.mjs still reads auth-url
    // into the web app's config, which is why it's watched
    expect([...read]).not.toContain("/supply-checkout/prod/identity/auth-url");
    for (const t of [api, realtime]) expect(JSON.stringify(t.toJSON())).not.toMatch(/resolve:ssm/);
  });

  it("tell P1 when an operator alert rule is deleted, disabled or loses its target, whoever does it, or is rewritten outside a deploy, with two rules watching each other (supply-checkout-6uw.11)", () => {
    const { t, tampering, tamperingWatch, deletionsTampering } = operatorRules();
    expect([...OPERATOR_RULE_SILENCING_EVENTS]).toEqual(["DeleteRule", "DisableRule", "RemoveTargets"]);
    expect([...OPERATOR_RULE_CHANGE_EVENTS]).toEqual(["PutRule", "PutTargets"]);
    const pattern = (watched: unknown[]) => ({
      source: ["aws.events"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["events.amazonaws.com"],
        $or: [
          { eventName: ["DeleteRule", "DisableRule"], requestParameters: { name: watched } },
          { eventName: ["RemoveTargets"], requestParameters: { rule: watched } },
          { eventName: ["PutRule"], requestParameters: { name: watched }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: ["PutTargets"], requestParameters: { rule: watched }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    // Every operator rule by its name's prefix, the two tampering rules included, and the deletion records rules' own tampering rule by its fixed name (supply-checkout-72d.17)
    const watched = [{ prefix: "supply-checkout-prod-operator-" }, deletionsRuleTamperingName("prod")];
    expect(operatorRulePrefix("prod")).toBe("supply-checkout-prod-operator-");
    expect(tampering.props.EventPattern).toEqual(pattern(watched));
    expect(tamperingWatch.props.EventPattern).toEqual(pattern(watched));
    expect(tamperingWatch.props.Name).toBe(tamperingWatchRuleName("prod"));
    for (const rule of [tampering, tamperingWatch]) expect(JSON.stringify(rule.props.Targets)).toContain("an operator alert rule");
    // So every rule the prefix is meant to cover must have a fixed name under it: every rule in the stack but the deletion records watch's three
    const names = Object.entries(t.findResources("AWS::Events::Rule"))
      .filter(([id, r]) => r.Properties.EventPattern && !id.startsWith("DeletionRecordsWatch") && !id.startsWith("DeletionsRuleTampering"))
      .map(([, r]) => r.Properties.Name as unknown);
    expect(names).toHaveLength(Object.keys(OPERATOR_RULE_SUFFIXES).length);
    expect(names.sort()).toEqual(Object.values(OPERATOR_RULE_SUFFIXES).map((suffix) => `supply-checkout-prod-operator-${suffix}`).sort());
    // The deletions tampering rule's name isn't under the prefix, which is why it's named on its own
    expect(deletionsRuleTamperingName("prod").startsWith(operatorRulePrefix("prod"))).toBe(false);
    // That one watches the deletion records watch's rule and its bucket-changes rule, the same way
    const watchRules = ["DeletionRecordsWatchRule", "DeletionRecordsWatchBucketChanges"].map((prefix) => Object.keys(t.findResources("AWS::Events::Rule")).find((id) => id.startsWith(prefix) && /^[0-9A-F]{8}$/.test(id.slice(prefix.length))));
    expect(watchRules.every(Boolean)).toBe(true);
    expect(deletionsTampering.props.Name).toBe(deletionsRuleTamperingName("prod"));
    expect(deletionsTampering.props.EventPattern).toEqual(pattern(watchRules.map((id) => ({ Ref: id }))));
    expect(deletionsTampering.props.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
    expect(JSON.stringify(deletionsTampering.props.Targets)).toContain("a deletion records watch rule");
  });

  it("give every operator rule a name EventBridge takes, even with the longest environment name", () => {
    const envName = "a".repeat(16);
    const t = Template.fromStack(build({}, { envName }).region(EAST).observability);
    const names = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties.Name as unknown).filter((n): n is string => typeof n === "string");
    expect(names).toEqual(expect.arrayContaining(Object.values(OPERATOR_RULE_SUFFIXES).map((suffix) => operatorRuleName(envName, suffix))));
    for (const name of names) {
      expect(name.length, name).toBeLessThanOrEqual(64);
      expect(name, name).toMatch(/^[.\-_A-Za-z0-9]+$/);
    }
  });

  it("tell P1 when the operator audit watch's mapping, function or role is deleted, or changed outside a deploy (supply-checkout-6uw.11)", () => {
    const { t, watchChanges, roleChanges } = operatorRules();
    const mapping = Object.keys(t.findResources("AWS::Lambda::EventSourceMapping"))[0];
    const role = Object.keys(t.findResources("AWS::IAM::Role")).find((id) => id.startsWith("OperatorAuditWatchRole"));
    // The operator group watch's function and role too (supply-checkout-3sv.5)
    const groupRole = Object.keys(t.findResources("AWS::IAM::Role")).find((id) => id.startsWith("OperatorGroupWatchRole"));
    const names = ["supply-checkout-prod-operator-audit-watch", "supply-checkout-prod-operator-group-watch"].flatMap((fn) => [fn, { wildcard: `*:function:${fn}*` }]);
    const prefixed = (list: readonly string[]) => list.map((prefix) => ({ prefix }));
    expect(watchChanges.props.EventPattern).toEqual({
      source: ["aws.lambda"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["lambda.amazonaws.com"],
        $or: [
          { eventName: prefixed(AUDIT_WATCH_MAPPING_EVENTS.always), requestParameters: { uUID: [{ Ref: mapping }] } },
          { eventName: prefixed(AUDIT_WATCH_MAPPING_EVENTS.outsideDeploys), requestParameters: { uUID: [{ Ref: mapping }] }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: prefixed(AUDIT_WATCH_FUNCTION_EVENTS.always), requestParameters: { functionName: names } },
          { eventName: prefixed(AUDIT_WATCH_FUNCTION_EVENTS.outsideDeploys), requestParameters: { functionName: names }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    // The role's calls, in a rule of their own so each pattern stays well inside EventBridge's limit (supply-checkout-pbp.17)
    expect(roleChanges.props.EventPattern).toEqual({
      source: ["aws.iam", "aws.lambda"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          { eventName: [...AUDIT_WATCH_ROLE_EVENTS.always], eventSource: ["iam.amazonaws.com"], requestParameters: { roleName: [{ Ref: role }, { Ref: groupRole }] } },
          { eventName: [...AUDIT_WATCH_ROLE_EVENTS.outsideDeploys], eventSource: ["iam.amazonaws.com"], requestParameters: { roleName: [{ Ref: role }, { Ref: groupRole }] }, userIdentity: NOT_CLOUDFORMATION },
          // Another function given the group watch's role, outside a deploy (supply-checkout-3sv.5); Lambda's event names carry a version, so by prefix
          {
            eventName: [{ prefix: "CreateFunction" }, { prefix: "UpdateFunctionConfiguration" }],
            eventSource: ["lambda.amazonaws.com"],
            // Its ARN, or any ARN ending in its name (a path, another spelling of the ARN) (supply-checkout-3sv.9)
            requestParameters: { role: [{ "Fn::GetAtt": [groupRole, "Arn"] }, { wildcard: { "Fn::Join": ["", ["*:role/*", { Ref: groupRole }]] } }] },
            userIdentity: NOT_CLOUDFORMATION,
          },
        ],
      },
    });
    expect(GROUP_WATCH_ROLE_FUNCTION_EVENTS.outsideDeploys).toEqual(["CreateFunction", "UpdateFunctionConfiguration"]);
    // Taking EventBridge's permission to invoke a watch away stops it: whoever does it (supply-checkout-3sv.9)
    expect([...AUDIT_WATCH_FUNCTION_EVENTS.always]).toEqual(["DeleteFunction", "RemovePermission"]);
    // Zero concurrency, a disabled mapping and new code are each covered
    expect(AUDIT_WATCH_FUNCTION_EVENTS.outsideDeploys).toEqual(expect.arrayContaining(["PutFunctionConcurrency", "UpdateFunctionCode", "UpdateFunctionConfiguration"]));
    expect(AUDIT_WATCH_MAPPING_EVENTS.outsideDeploys).toEqual(["UpdateEventSourceMapping"]);
    expect(JSON.stringify(watchChanges.props.Targets)).toContain("the operator audit watch");
    expect(JSON.stringify(roleChanges.props.Targets)).toContain("the operator audit watch's role");
  });

  it("tell P1 when the watch's log group, the table's stream or the table key is deleted or disabled, or changed outside a deploy (supply-checkout-6uw.11)", () => {
    const { t, logChanges, tableChanges } = operatorRules();
    // The operator audit watch's log group and the operator group watch's (supply-checkout-3sv.5)
    const groups = ["OperatorAuditWatchLogs", "OperatorGroupWatchLogs"].map((prefix) => ({ Ref: Object.keys(t.findResources("AWS::Logs::LogGroup")).find((id) => id.startsWith(prefix)) }));
    expect(groups.every((g) => g.Ref)).toBe(true);
    // One wildcard per group: two per group with both groups made EventBridge refuse the rule as too complex on deploy
    const identifier = groups.flatMap((name) => [name, { wildcard: { "Fn::Join": ["", ["*:log-group:", name, "*"]] } }]);
    const tableArn = { "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]] };
    const streamPrefix = { prefix: { "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app/stream/"]] } };
    const table = ["supply-checkout-prod-app", tableArn];
    const key = { Ref: expect.stringMatching(/datatablekeyarn/i) };
    // The log group and the table in two rules, so each pattern stays well inside EventBridge's limit (supply-checkout-pbp.17)
    expect(logChanges.props.EventPattern).toEqual({
      source: ["aws.logs"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["logs.amazonaws.com"],
        $or: [
          // The role can't recreate a deleted group, and its metrics are in its lines
          { eventName: ["DeleteLogGroup"], requestParameters: { logGroupName: groups } },
          { eventName: ["PutTransformer", "DeleteTransformer", "PutDataProtectionPolicy"], requestParameters: { logGroupIdentifier: identifier }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: ["PutAccountPolicy"], requestParameters: { policyType: ["TRANSFORMER_POLICY", "DATA_PROTECTION_POLICY"] } },
        ],
      },
    });
    expect(tableChanges.props.EventPattern).toEqual({
      source: ["aws.dynamodb", "aws.kms"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          { eventName: ["PutResourcePolicy", "DeleteResourcePolicy"], eventSource: ["dynamodb.amazonaws.com"], requestParameters: { resourceArn: [tableArn, streamPrefix] }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: ["UpdateTable"], eventSource: ["dynamodb.amazonaws.com"], requestParameters: { tableName: table }, userIdentity: NOT_CLOUDFORMATION },
          // Turning the stream off alerts even in a deploy
          { eventName: ["UpdateTable"], eventSource: ["dynamodb.amazonaws.com"], requestParameters: { tableName: table, streamSpecification: { streamEnabled: [false] } } },
          { eventName: ["DisableKey", "ScheduleKeyDeletion"], eventSource: ["kms.amazonaws.com"], resources: { ARN: [key] } },
          { eventName: ["PutKeyPolicy"], eventSource: ["kms.amazonaws.com"], resources: { ARN: [key] }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    expect([...AUDIT_WATCH_LOG_EVENTS.always]).toEqual(["DeleteLogGroup"]);
    expect([...LOG_ACCOUNT_POLICY_TYPES]).toEqual(["TRANSFORMER_POLICY", "DATA_PROTECTION_POLICY"]);
    expect([...TABLE_POLICY_EVENTS.outsideDeploys, ...TABLE_UPDATE_EVENTS.outsideDeploys]).toEqual(["PutResourcePolicy", "DeleteResourcePolicy", "UpdateTable"]);
    expect([...TABLE_KEY_EVENTS.always, ...TABLE_KEY_EVENTS.outsideDeploys]).toEqual(["DisableKey", "ScheduleKeyDeletion", "PutKeyPolicy"]);
    expect(JSON.stringify(logChanges.props.Targets)).toContain("the operator audit watch's log group");
    expect(JSON.stringify(tableChanges.props.Targets)).toContain("the table's stream or the table key");
  });

  it("tell P1 when an operator audit alarm is disabled or deleted, or rewritten outside a deploy (supply-checkout-6uw.11)", () => {
    const { alarmChanges } = operatorRules();
    const alarms = ["supply-checkout-prod-p1-operator-audit-changed", "supply-checkout-prod-p2-operator-audit-watch-failing", "supply-checkout-prod-p2-operator-audit-watch-dropped", "supply-checkout-prod-p2-operator-audit-watch-silent"];
    const which = ["Changed", "Failing", "Dropped", "Silent"];
    const resolved = JSON.parse(JSON.stringify(alarmChanges.props.EventPattern).replace(/\{"Ref":"OperatorAuditWatch(Changed|Failing|Dropped|Silent)[0-9A-F]+"\}/g, (_m, w: string) => JSON.stringify(alarms[which.indexOf(w)])));
    expect(resolved).toEqual({
      source: ["aws.monitoring"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["monitoring.amazonaws.com"],
        $or: [
          { eventName: ["DisableAlarmActions", "DeleteAlarms"], requestParameters: { alarmNames: alarms } },
          { eventName: ["PutMetricAlarm"], requestParameters: { alarmName: alarms }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    expect([...OPERATOR_ALARM_EVENTS.always, ...OPERATOR_ALARM_EVENTS.outsideDeploys]).toEqual(["DisableAlarmActions", "DeleteAlarms", "PutMetricAlarm"]);
  });

  it("tell P1 and P2 when an alarm topic, a subscription, the topics' key or a CloudTrail trail is broken, or changed outside a deploy (supply-checkout-6uw.11)", () => {
    const { routeChanges, keyAndTrailChanges } = operatorRules();
    const topics = [{ Ref: expect.stringMatching(/^AlarmTopicsP1/) }, { Ref: expect.stringMatching(/^AlarmTopicsP2/) }];
    const subscriptions = topics.map((ref) => ({ prefix: { "Fn::Join": ["", [ref, ":"]] } }));
    const keyArn = { "Fn::GetAtt": [expect.stringMatching(/^AlarmTopicsKey/), "Arn"] };
    const key = [{ Ref: expect.stringMatching(/^AlarmTopicsKey/) }, keyArn];
    const trailKeyArn = { Ref: expect.stringMatching(/^SsmParameterValuesupplycheckoutprodaudittrailkeyarn/) };
    // The topics and the key and trails in two rules, so each pattern stays well inside EventBridge's limit (supply-checkout-pbp.17)
    expect(routeChanges.props.EventPattern).toEqual({
      source: ["aws.sns"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["sns.amazonaws.com"],
        $or: [
          { eventName: ["DeleteTopic", "RemovePermission"], requestParameters: { topicArn: topics } },
          { eventName: ["SetTopicAttributes"], requestParameters: { topicArn: topics }, userIdentity: NOT_CLOUDFORMATION },
          // A data protection policy names the topic in `resourceArn`: one that denies every inbound message stops the topic, so always
          { eventName: ["PutDataProtectionPolicy"], requestParameters: { resourceArn: topics } },
          { eventName: ["Unsubscribe", "SetSubscriptionAttributes"], requestParameters: { subscriptionArn: subscriptions }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    expect(keyAndTrailChanges.props.EventPattern).toEqual({
      source: ["aws.kms", "aws.cloudtrail"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          // By the key's ARN in `resources`, so a call through an alias (or an alias ARN) still matches
          // ...and the trail's key, from the audit stack's SSM parameter (supply-checkout-3sv.3)
          { eventName: ["DisableKey", "ScheduleKeyDeletion"], eventSource: ["kms.amazonaws.com"], resources: { ARN: [keyArn, trailKeyArn] } },
          { eventName: ["PutKeyPolicy"], eventSource: ["kms.amazonaws.com"], resources: { ARN: [keyArn, trailKeyArn] }, userIdentity: NOT_CLOUDFORMATION },
          // Any alias pointed at the key, whoever makes it
          { eventName: ["CreateAlias", "UpdateAlias"], eventSource: ["kms.amazonaws.com"], requestParameters: { targetKeyId: key } },
          { eventSource: ["cloudtrail.amazonaws.com"], eventName: [...TRAIL_EVENTS] },
        ],
      },
    });
    expect([...TRAIL_EVENTS]).toEqual(expect.arrayContaining(["StopLogging", "DeleteTrail"]));
    expect(JSON.stringify(routeChanges.props.Targets)).toContain("the alarm topics at");
    expect(JSON.stringify(keyAndTrailChanges.props.Targets)).toContain("the alarm topics' key or CloudTrail");
    expect([...ALARM_TOPIC_EVENTS.always, ...ALARM_TOPIC_EVENTS.outsideDeploys, ...ALARM_SUBSCRIPTION_EVENTS.outsideDeploys]).toEqual(expect.arrayContaining(["DeleteTopic", "SetTopicAttributes", "Unsubscribe"]));
    expect([...ALARM_KEY_EVENTS.always, ...ALARM_KEY_EVENTS.outsideDeploys]).toEqual(["DisableKey", "ScheduleKeyDeletion", "PutKeyPolicy"]);
    expect([...ALARM_KEY_ALIAS_EVENTS.always]).toEqual(["CreateAlias", "UpdateAlias"]);
    expect([...ALARM_TOPIC_RESOURCE_EVENTS.always]).toEqual(["PutDataProtectionPolicy"]);
  });

  it("tell P1 when the CloudTrail trail's bucket or key is changed so the log archive could be destroyed or cut off (supply-checkout-3sv.4)", () => {
    const { trailBucketChanges } = operatorRules();
    const bucket = [{ "Fn::Join": ["", [`supply-checkout-prod-trail-${EAST}-`, { Ref: "AWS::AccountId" }]] }];
    const trailKeyArn = { Ref: expect.stringMatching(/^SsmParameterValuesupplycheckoutprodaudittrailkeyarn/) };
    expect(trailBucketChanges.props.Name).toBe("supply-checkout-prod-operator-trail-bucket-changes");
    expect(trailBucketChanges.props.EventPattern).toEqual({
      source: ["aws.s3", "aws.kms"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          // Deleting the bucket, its policy or its encryption: whoever does it
          { eventName: [...TRAIL_BUCKET_EVENTS.always], eventSource: ["s3.amazonaws.com"], requestParameters: { bucketName: bucket } },
          // A one-day lifecycle rule, versioning off, a policy that cuts CloudTrail off, another key or no access logs: outside a deploy
          { eventName: [...TRAIL_BUCKET_EVENTS.outsideDeploys], eventSource: ["s3.amazonaws.com"], requestParameters: { bucketName: bucket }, userIdentity: NOT_CLOUDFORMATION },
          // A grant hands the trail key to someone else; rotation off: whoever does it (nothing here ever makes either)
          { eventName: [...TRAIL_KEY_EVENTS.always], eventSource: ["kms.amazonaws.com"], resources: { ARN: [trailKeyArn] } },
        ],
      },
    });
    for (const name of ["PutBucketPolicy", "DeleteBucketPolicy", "PutBucketLifecycle", "DeleteBucketLifecycle", "PutBucketVersioning", "PutBucketEncryption", "DeleteBucketEncryption", "PutBucketLogging", "DeleteBucket"]) {
      expect([...TRAIL_BUCKET_EVENTS.always, ...TRAIL_BUCKET_EVENTS.outsideDeploys], name).toContain(name);
    }
    expect([...TRAIL_BUCKET_EVENTS.always]).toEqual(["DeleteBucket", "DeleteBucketPolicy", "DeleteBucketEncryption"]);
    expect([...TRAIL_KEY_EVENTS.always]).toEqual(["CreateGrant", "DisableKeyRotation"]);
    const target = JSON.stringify(trailBucketChanges.props.Targets);
    expect(target).toContain("the CloudTrail trail's bucket or key");
    expect(target).toContain("$.detail.eventID");
  });
});

describe("operator audit watch (supply-checkout-6uw.5)", () => {
  function watchFunction(t: Template) {
    const [entry] = Object.entries(t.findResources("AWS::Lambda::Function")).filter(([, f]) => f.Properties.FunctionName === "supply-checkout-prod-operator-audit-watch");
    if (!entry) throw new Error("No watch function");
    return { id: entry[0], props: entry[1].Properties as Record<string, unknown> };
  }

  it("reads only MODIFY and REMOVE records of OPAUDIT# partitions, and INSERTs of their AUDIT# items, from the table's stream, in the primary region only", () => {
    const west = Template.fromStack(build().region(WEST).observability);
    west.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
    const t = observability();
    const fn = watchFunction(t);
    const mappings = Object.values(t.findResources("AWS::Lambda::EventSourceMapping")).map((m) => m.Properties);
    expect(mappings).toHaveLength(1);
    const [mapping] = mappings;
    expect(mapping).toMatchObject({
      FunctionName: { Ref: fn.id },
      EventSourceArn: { Ref: expect.stringMatching(/datatablestreamarn/i) },
      StartingPosition: "LATEST",
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 5,
    });
    expect(mapping.FilterCriteria).toEqual({
      Filters: [
        { Pattern: JSON.stringify({ eventName: ["MODIFY", "REMOVE"], dynamodb: { Keys: { PK: { S: [{ prefix: "OPAUDIT#" }] } } } }) },
        { Pattern: JSON.stringify({ eventName: ["INSERT"], dynamodb: { Keys: { PK: { S: [{ prefix: "OPAUDIT#" }] }, SK: { S: [{ prefix: "AUDIT#" }] } } } }) },
        { Pattern: JSON.stringify({ eventName: ["INSERT", "MODIFY"], dynamodb: { Keys: { PK: { S: ["OPWATCH#HEARTBEAT"] }, SK: { S: ["HEARTBEAT"] } } } }) },
      ],
    });
  });

  it("records a batch it gave up on in an encrypted dead-letter queue, and alarms P2 on any (supply-checkout-6uw.11)", () => {
    const t = observability();
    const [mapping] = Object.values(t.findResources("AWS::Lambda::EventSourceMapping")).map((m) => m.Properties);
    const queues = Object.entries(t.findResources("AWS::SQS::Queue")).filter(([id]) => id.startsWith("OperatorAuditWatchDeadLetterQueue"));
    expect(queues).toHaveLength(1);
    const [[queueId, queue]] = queues as [[string, { Properties: Record<string, unknown> }]];
    expect(queue.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86_400 });
    expect(mapping?.DestinationConfig).toEqual({ OnFailure: { Destination: { "Fn::GetAtt": [queueId, "Arn"] } } });
    const alarm = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties).find((a) => a.AlarmName === "supply-checkout-prod-p2-operator-audit-watch-dropped");
    expect(alarm).toMatchObject({
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
      Statistic: "Maximum",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
    expect(alarm?.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP2/);
    expect(JSON.stringify(Object.values(t.findResources("AWS::CloudWatch::Dashboard"))[0])).toMatch(/"OperatorAuditWatchDropped[0-9A-F]+","Arn"/);
  });

  it("gives the watch no table access: only the stream, and the table key through DynamoDB", () => {
    const t = observability();
    const fn = watchFunction(t);
    const role = (fn.props.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const found = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === role) && !String(p.Properties.PolicyName).includes("XRayWrite"))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(found.map((s) => s.Action)).toEqual(
      expect.arrayContaining([["logs:CreateLogStream", "logs:PutLogEvents"], ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"], ["kms:Decrypt", "kms:DescribeKey"], "dynamodb:ListStreams"]),
    );
    // And sending to its own dead-letter queue, only
    const dlq = found.find((s) => JSON.stringify(s.Action).includes("sqs:"));
    expect(dlq?.Resource).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^OperatorAuditWatchDeadLetterQueue/), "Arn"] });
    expect([dlq?.Action].flat().every((a) => /^sqs:(SendMessage|GetQueueAttributes|GetQueueUrl)$/.test(String(a)))).toBe(true);
    expect(found).toHaveLength(5);
    const actions = found.flatMap((s) => [s.Action].flat() as string[]);
    for (const a of actions) expect(a).not.toMatch(/^dynamodb:(GetItem|Query|Scan|PutItem|UpdateItem|DeleteItem|BatchGetItem|BatchWriteItem)$/);
    const stream = found.find((s) => JSON.stringify(s.Action).includes("GetRecords"));
    expect(stream?.Resource).toEqual({ Ref: expect.stringMatching(/datatablestreamarn/i) });
    const kms = found.find((s) => JSON.stringify(s.Action).includes("kms:Decrypt"));
    expect(kms?.Condition).toEqual({ StringEquals: { "kms:ViaService": { "Fn::Join": ["", ["dynamodb.", { Ref: "AWS::Region" }, ".amazonaws.com"]] } } });
  });

  it("alarms P1 on any OperatorAuditChanged, and P2 when the watch fails, both on the dashboard", () => {
    const t = observability();
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties);
    const changed = alarms.find((a) => a.AlarmName === "supply-checkout-prod-p1-operator-audit-changed");
    expect(changed).toMatchObject({
      Metrics: [
        expect.objectContaining({
          MetricStat: expect.objectContaining({
            Metric: { Namespace: "SupplyCheckout", MetricName: BusinessMetric.OperatorAuditChanged, Dimensions: [{ Name: "Region", Value: EAST }] },
            Period: 300,
            Stat: "Sum",
          }),
        }),
      ],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
    expect(changed?.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP1/);
    expect(changed?.OKActions).toEqual(changed?.AlarmActions);
    const failing = alarms.find((a) => a.AlarmName === "supply-checkout-prod-p2-operator-audit-watch-failing");
    expect(failing).toMatchObject({ MetricName: "Errors", Namespace: "AWS/Lambda", Threshold: 0, TreatMissingData: "notBreaching" });
    expect(failing?.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP2/);
    const dashboard = JSON.stringify(Object.values(t.findResources("AWS::CloudWatch::Dashboard"))[0]);
    expect(dashboard).toMatch(/"OperatorAuditWatchChanged[0-9A-F]+","Arn"/);
    expect(dashboard).toMatch(/"OperatorAuditWatchFailing[0-9A-F]+","Arn"/);
    // Neither exists in the second region
    const west = Object.values(Template.fromStack(build().region(WEST).observability).findResources("AWS::CloudWatch::Alarm")).map((a) => String(a.Properties.AlarmName));
    expect(west.filter((n) => n.includes("operator-audit"))).toEqual([]);
  });

  it("rewrites a heartbeat item on a schedule, and alarms P2 when the watch stops counting it, missing data breaching (supply-checkout-6uw.11)", () => {
    Template.fromStack(build().region(WEST).observability).resourceCountIs("AWS::Scheduler::Schedule", 0);
    const t = observability();
    const schedules = Object.values(t.findResources("AWS::Scheduler::Schedule")).map((r) => r.Properties);
    expect(schedules).toHaveLength(1);
    const [schedule] = schedules;
    expect(schedule).toMatchObject({
      ScheduleExpression: `rate(${HEARTBEAT_EVERY_MINUTES} minutes)`,
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: { Arn: "arn:aws:scheduler:::aws-sdk:dynamodb:putItem", RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 } },
    });
    expect(JSON.parse(schedule.Target.Input)).toEqual({
      TableName: "supply-checkout-prod-app",
      Item: { PK: { S: OPERATOR_AUDIT_HEARTBEAT.PK }, SK: { S: OPERATOR_AUDIT_HEARTBEAT.SK }, at: { S: "<aws.scheduler.scheduled-time>" } },
    });
    // Its role: Scheduler in this account only, PutItem of the heartbeat item's keys and `at`, nothing else
    const roleId = (schedule.Target.RoleArn as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const role = t.findResources("AWS::IAM::Role")[roleId]?.Properties;
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } } },
    ]);
    const statements = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleId))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(statements).toHaveLength(2);
    expect(statements).toContainEqual(expect.objectContaining({
      Sid: "HeartbeatItemOnly",
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [OPERATOR_AUDIT_HEARTBEAT.PK], "dynamodb:Attributes": ["PK", "SK", "at"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    }));
    expect(statements).toContainEqual(expect.objectContaining({ Sid: "TableKeyThroughDynamoDb", Resource: { Ref: expect.stringMatching(/datatablekeyarn/i) } }));
    // The heartbeat is its own partition: not an operator audit item, not a team's
    expect(OPERATOR_AUDIT_HEARTBEAT.PK).not.toMatch(/^(OPAUDIT|TEAM)#/);
    const alarm = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties).find((a) => a.AlarmName === "supply-checkout-prod-p2-operator-audit-watch-silent");
    expect(alarm).toMatchObject({
      Metrics: [
        expect.objectContaining({
          MetricStat: expect.objectContaining({
            Metric: { Namespace: "SupplyCheckout", MetricName: BusinessMetric.OperatorAuditWatchHeartbeat, Dimensions: [{ Name: "Region", Value: EAST }] },
            Period: HEARTBEAT_SILENT_ALARM_MINUTES * 60,
            Stat: "Sum",
          }),
        }),
      ],
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
    });
    expect(HEARTBEAT_SILENT_ALARM_MINUTES).toBeGreaterThanOrEqual(2 * HEARTBEAT_EVERY_MINUTES);
    expect(alarm?.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP2/);
    expect(JSON.stringify(Object.values(t.findResources("AWS::CloudWatch::Dashboard"))[0])).toMatch(/"OperatorAuditWatchSilent[0-9A-F]+","Arn"/);
  });
});

describe("deletion records watch (supply-checkout-72d.16)", () => {
  const BUCKET = { "Fn::Join": ["", [`supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] };

  function watch(t: Template) {
    const [entry] = Object.entries(t.findResources("AWS::Lambda::Function")).filter(([, f]) => f.Properties.FunctionName === "supply-checkout-prod-deletion-records-watch");
    if (!entry) throw new Error("No watch function");
    const rules = Object.entries(t.findResources("AWS::Events::Rule")).filter(([id]) => id.startsWith("DeletionRecordsWatchRule"));
    expect(rules).toHaveLength(1);
    return { id: entry[0], props: entry[1].Properties as Record<string, unknown>, rule: rules[0]?.[1].Properties as Record<string, unknown> };
  }

  it("has the deletion records bucket send its events to EventBridge, without a notifications custom resource", () => {
    const data = Template.fromStack(build().region(EAST).data);
    data.hasResourceProperties("AWS::S3::Bucket", { BucketName: BUCKET, NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } } });
    data.resourceCountIs("Custom::S3BucketNotifications", 0);
  });

  it("passes the function the bucket's writes and deletions, other than the lifecycle rule's, in the primary region only", () => {
    const west = Template.fromStack(build().region(WEST).observability);
    expect(Object.keys(west.findResources("AWS::Events::Rule")).filter((id) => id.startsWith("DeletionRecordsWatch"))).toEqual([]);
    const t = observability();
    const fn = watch(t);
    expect(fn.rule.EventPattern).toEqual({
      source: ["aws.s3"],
      "detail-type": ["Object Created", "Object Deleted"],
      detail: { bucket: { name: [BUCKET] }, reason: [{ "anything-but": [LIFECYCLE_EXPIRATION] }] },
    });
    expect(fn.rule.Targets).toEqual([
      expect.objectContaining({ Arn: { "Fn::GetAtt": [fn.id, "Arn"] }, RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 } }),
    ]);
    // Only this rule may invoke it
    t.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "events.amazonaws.com",
      FunctionName: { "Fn::GetAtt": [fn.id, "Arn"] },
      SourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^DeletionRecordsWatchRule"), "Arn"] },
    });
    expect(fn.props).toMatchObject({ Runtime: "nodejs24.x", Environment: { Variables: expect.objectContaining({ DELETIONS_BUCKET: BUCKET, DELETIONS_REGION: EAST }) } });
  });

  it("lets the watch list the versions of record keys in the one bucket, and nothing else", () => {
    const t = observability();
    const fn = watch(t);
    const role = (fn.props.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const found = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === role) && !String(p.Properties.PolicyName).includes("XRayWrite"))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.Action)).toEqual([["logs:CreateLogStream", "logs:PutLogEvents"], "s3:ListBucketVersions"]);
    expect(found[1]).toEqual({
      Sid: "ListRecordVersions",
      Effect: "Allow",
      Action: "s3:ListBucketVersions",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] },
      Condition: { StringLike: { "s3:prefix": Object.values(DELETION_PREFIXES).map((p) => `${p}*`) } },
    });
  });

  it("alarms P2 on any DeletionRecordRewrites, and P2 when the watch fails, both on the dashboard", () => {
    const t = observability();
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties);
    const rewritten = alarms.find((a) => a.AlarmName === "supply-checkout-prod-p2-deletion-record-rewritten");
    expect(rewritten).toMatchObject({
      Metrics: [
        expect.objectContaining({
          MetricStat: expect.objectContaining({
            Metric: { Namespace: "SupplyCheckout", MetricName: BusinessMetric.DeletionRecordRewrites, Dimensions: [{ Name: "Region", Value: EAST }] },
            Period: 300,
            Stat: "Sum",
          }),
        }),
      ],
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
    expect(rewritten?.AlarmDescription).toContain("docs/backups.md, When a deletion record is rewritten");
    expect(rewritten?.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP2/);
    expect(rewritten?.OKActions).toEqual(rewritten?.AlarmActions);
    const failing = alarms.find((a) => a.AlarmName === "supply-checkout-prod-p2-deletion-records-watch-failing");
    expect(failing).toMatchObject({ Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching" });
    // Its errors, the events Lambda dropped after retries, and invocations EventBridge couldn't make
    const fn = watch(t);
    const metrics = failing?.Metrics as { Id: string; Expression?: string; MetricStat?: { Metric: { Namespace: string; MetricName: string; Dimensions: unknown }; Stat: string } }[];
    expect(metrics.find((m) => m.Expression)?.Expression).toBe("FILL(errors, 0) + FILL(dropped, 0) + FILL(failed, 0)");
    const stat = (id: string) => metrics.find((m) => m.Id === id)?.MetricStat;
    expect(stat("errors")?.Metric).toEqual({ Namespace: "AWS/Lambda", MetricName: "Errors", Dimensions: [{ Name: "FunctionName", Value: { Ref: fn.id } }] });
    expect(stat("dropped")?.Metric).toEqual({ Namespace: "AWS/Lambda", MetricName: "AsyncEventsDropped", Dimensions: [{ Name: "FunctionName", Value: { Ref: fn.id } }] });
    expect(stat("failed")?.Metric).toEqual({ Namespace: "AWS/Events", MetricName: "FailedInvocations", Dimensions: [{ Name: "RuleName", Value: { Ref: expect.stringMatching(/^DeletionRecordsWatchRule/) } }] });
    for (const id of ["errors", "dropped", "failed"]) expect(stat(id)?.Stat).toBe("Sum");
    expect(failing?.AlarmActions[0].Ref).toMatch(/^AlarmTopicsP2/);
    const dashboard = JSON.stringify(Object.values(t.findResources("AWS::CloudWatch::Dashboard"))[0]);
    expect(dashboard).toMatch(/"DeletionRecordsWatchRewritten[0-9A-F]+","Arn"/);
    expect(dashboard).toMatch(/"DeletionRecordsWatchFailing[0-9A-F]+","Arn"/);
    const west = Object.values(Template.fromStack(build().region(WEST).observability).findResources("AWS::CloudWatch::Alarm")).map((a) => String(a.Properties.AlarmName));
    expect(west.filter((n) => n.includes("deletion-record"))).toEqual([]);
  });

  it("tells P1 when the bucket's lifecycle, notifications, policy, replication, ownership, public access, Object Lock or versioning changes (review B1)", () => {
    const t = observability();
    for (const name of ["PutBucketLifecycle", "DeleteBucketLifecycle", "PutBucketNotification", "PutBucketPolicy", "DeleteBucketPolicy", "PutBucketReplication", "DeleteBucketReplication", "PutBucketOwnershipControls", "PutObjectLockConfiguration", "PutBucketVersioning"]) {
      expect(DELETIONS_BUCKET_CHANGE_EVENTS, name).toContain(name);
    }
    const [entry] = Object.entries(t.findResources("AWS::Events::Rule")).filter(([id]) => id.startsWith("DeletionRecordsWatchBucketChanges"));
    if (!entry) throw new Error("No bucket changes rule");
    const [id, rule] = entry;
    expect(rule.Properties.EventPattern).toEqual({
      source: ["aws.s3"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: { eventSource: ["s3.amazonaws.com"], eventName: [...DELETIONS_BUCKET_CHANGE_EVENTS], requestParameters: { bucketName: [BUCKET] } },
    });
    expect(rule.Properties.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
    const target = JSON.stringify(rule.Properties.Targets);
    expect(target).toContain("$.detail.eventID");
    expect(target).toContain("When the deletion records bucket is changed");
    expect(target).not.toContain("userIdentity");
    // The P1 topic lets this rule publish, by its ARN
    const statements = Object.values(t.findResources("AWS::SNS::TopicPolicy")).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(statements.find((st) => st.Sid === "AllowDeletionsBucketAlertToPublish")).toEqual({
      Sid: "AllowDeletionsBucketAlertToPublish",
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sns:Publish",
      Resource: { Ref: expect.stringMatching(/^AlarmTopicsP1/) },
      Condition: { ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": [id, "Arn"] } } },
    });
  });
});

describe("EventBridge pattern sizes (supply-checkout-pbp.17)", () => {
  // Each reference as long as a real one or longer: a generated name (a role,
  // a log group, a rule) or an ARN is under 128 characters here; the pseudo
  // parameters take their longest values
  // As long as the longest region name (14 characters; region names live only in lib/config.ts)
  const REGION = "r".repeat(14);
  const PSEUDO: Record<string, string> = { "AWS::AccountId": "0".repeat(12), "AWS::Partition": "aws-us-gov", "AWS::Region": REGION, "AWS::URLSuffix": "amazonaws.com.cn" };
  const REFERENCE = "x".repeat(128);
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== "object") return value;
    const v = value as Record<string, unknown>;
    if (typeof v.Ref === "string") return PSEUDO[v.Ref] ?? REFERENCE;
    if (Array.isArray(v["Fn::Join"])) {
      const [sep, parts] = v["Fn::Join"] as [string, unknown[]];
      return parts.map((part) => (typeof part === "string" ? part : String(resolve(part)))).join(sep);
    }
    if (Object.keys(v).some((k) => k.startsWith("Fn::"))) return REFERENCE;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  };
  // Well inside the limit: 12% to spare for longer names and small changes
  const MAX = Math.floor(EVENT_PATTERN_LIMIT * 0.88);

  function patterns(stacks: { stackName: string; node: { id: string } }[]) {
    return stacks.flatMap((stack) =>
      Object.entries(Template.fromStack(stack as never).findResources("AWS::Events::Rule"))
        .filter(([, r]) => r.Properties.EventPattern)
        .map(([id, r]) => ({ where: `${stack.stackName} ${id}`, size: JSON.stringify(resolve(r.Properties.EventPattern)).length })),
    );
  }

  it("keeps every rule's pattern in every stack well inside EventBridge's 2,048 characters, with and without the backup copy, with the longest environment name, and in the backup account", () => {
    expect(EVENT_PATTERN_LIMIT).toBe(2048);
    const all = [
      ...patterns(build().stacks.all),
      ...patterns(build({ backupCopy: "false" }).stacks.all),
      // The longest environment name, since the patterns hold names built from it
      ...patterns(build({}, { envName: "a".repeat(16) }).stacks.all),
      ...patterns([addBackupAccount(testApp(), config)]),
    ];
    // The operator and deletion records rules, the backup change rules, and the backup account's
    expect(all.length).toBeGreaterThanOrEqual(3 * 18 + 3);
    for (const { where, size } of all) expect(size, where).toBeLessThan(MAX);
  });

  it("measures references at least as long as the real ones", () => {
    // A topic ARN, the table's ARN and a key ARN in the longest partition and region all fit in a reference
    expect(`arn:aws-us-gov:sns:${REGION}:${"0".repeat(12)}:supply-checkout-${"a".repeat(16)}-alarms-p1`.length).toBeLessThan(REFERENCE.length);
    expect(`arn:aws-us-gov:kms:${REGION}:${"0".repeat(12)}:key/${"k".repeat(36)}`.length).toBeLessThan(REFERENCE.length);
    // CloudFormation's generated names: a role's is at most 64 characters, and a log group's is the stack name, the logical ID and a suffix
    expect(`supply-checkout-${"a".repeat(16)}-${REGION}-observability-OperatorAuditWatchLogsC88D29BF-${"s".repeat(12)}`.length).toBeLessThan(REFERENCE.length);
  });
});
