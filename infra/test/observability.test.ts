import { readFileSync } from "node:fs";
import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { AwsSolutionsChecks } from "cdk-nag";
import type { Construct } from "constructs";
import { describe, expect, it } from "vitest";
import { BusinessMetric } from "../../backend/src/observability/names.js";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { alarmContactParameter, alarmContactsFromContext } from "../lib/observability/alarm-topics.js";
import { LOG_RETENTION } from "../lib/observability/defaults.js";
import { journeyAlarmSpecs } from "../lib/observability/journey-alarms.js";
import { OPERATOR_AUDIT_HEARTBEAT } from "../../backend/src/data/schema.js";
import { DELETION_PREFIXES, LIFECYCLE_EXPIRATION } from "../../backend/src/deletions/names.js";
import { CHECK_EVERY_MINUTES, HEARTBEAT_EVERY_MINUTES, HEARTBEAT_SILENT_ALARM_MINUTES, PURGE_EVERY_HOURS, PURGE_OVERDUE_AFTER_HOURS, PURGE_SILENT_ALARM_HOURS, STUCK_IMPORT_AFTER_MINUTES } from "../../backend/src/ops/names.js";
import { DELETIONS_BUCKET_CHANGE_EVENTS } from "../lib/observability/deletion-records-watch.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";
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
  OPERATOR_RULE_CHANGE_EVENTS,
  OPERATOR_RULE_SILENCING_EVENTS,
  OPERATOR_SELF_SERVICE_EVENTS,
  OPERATOR_USER_EVENTS,
  TABLE_KEY_EVENTS,
  TABLE_POLICY_EVENTS,
  TABLE_UPDATE_EVENTS,
  deletionsRuleTamperingName,
  tamperingWatchRuleName,
  TRAIL_EVENTS,
} from "../lib/stacks/observability-stack.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [], ...context } });
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
  "webhook-signature-failures",
  "deletion-overdue",
  "team-closed-notices-failing",
  "team-reopened-notices-failing",
];

/** Alarms on gauges that only the primary region's scheduled checks and purge send (ops-checks.ts). */
const PRIMARY_ONLY_ALARM_IDS = ["imports-stuck", "near-sending-limit", "deletion-overdue"];

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
            Principal: { Service: "cloudwatch.amazonaws.com" },
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
              Principal: { Service: "cloudwatch.amazonaws.com" },
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
      // The purge's own alarm is with the purge, and the operator audit watch's two are with the watch, in the primary region only (tested below)
      const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm"))
        .map((a) => a.Properties)
        .filter((a) => a.AlarmName !== "supply-checkout-prod-p2-deletion-not-running" && !/operator-audit|deletion-record/.test(String(a.AlarmName)));
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

  it("run in the primary region only, every 10 minutes (the purge every hour), without retries", () => {
    const { region } = build();
    const west = Template.fromStack(region(WEST).observability);
    west.resourceCountIs("AWS::Lambda::Function", 0);
    west.resourceCountIs("AWS::Events::Rule", 0);
    const t = observability();
    expect(functions(t).map((f) => f.FunctionName).sort()).toEqual([
      "supply-checkout-prod-deletion-records-watch",
      "supply-checkout-prod-email-quota",
      "supply-checkout-prod-operator-audit-watch",
      "supply-checkout-prod-stuck-imports",
      "supply-checkout-prod-team-purge",
    ]);
    const rules = Object.values(t.findResources("AWS::Events::Rule")).map((r) => r.Properties).filter((r) => r.ScheduleExpression !== undefined);
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.ScheduleExpression).sort()).toEqual(["rate(1 hour)", `rate(${CHECK_EVERY_MINUTES} minutes)`, `rate(${CHECK_EVERY_MINUTES} minutes)`]);
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
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app/index/GSI1"]],
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
      ["dynamodb:GetItem", "dynamodb:DeleteItem"],
      "dynamodb:UpdateItem",
      ["kms:Decrypt", "kms:DescribeKey"],
      "s3:PutObject",
    ]);
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
    });
    const attributes = ["PK", "SK", "GSI1PK", "GSI1SK", "closedAt", "purgeAfter", "purging", "stripeCustomerId", "teamId"];
    const [, index, query, items, mark] = found as Record<string, unknown>[];
    expect(index?.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAMS#CLOSED"], "dynamodb:Attributes": attributes },
      // COUNT for the overdue gauge, which returns no items
      StringEquals: { "dynamodb:Select": ["SPECIFIC_ATTRIBUTES", "COUNT"] },
    });
    const table = {
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]],
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
    // The purging mark: team partitions only, naming only the META item's key, purgeAfter and the mark: never closedAt, so it can't close or reopen a team
    expect(mark?.Resource).toEqual(table);
    expect(mark?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "purgeAfter", "purging"] },
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

  it("let the SES quota check read the account's quota and nothing else", () => {
    const found = statements(observability(), "supply-checkout-prod-email-quota");
    expect(found.map((s) => [s.Action, s.Resource === "*" ? "*" : "own log group"])).toEqual([
      [["logs:CreateLogStream", "logs:PutLogEvents"], "own log group"],
      ["ses:GetAccount", "*"],
    ]);
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
      PolicyDocument: { Statement: [{ Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Effect: "Allow", Resource: "*" }] },
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

describe("operator pool alerts (ADR 0015)", () => {
  const NOT_CLOUDFORMATION = { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] };

  function operatorRules() {
    const t = observability();
    // The deletion records watch's rules are tested with the watch
    const rules = Object.entries(t.findResources("AWS::Events::Rule")).filter(([id, r]) => r.Properties.EventPattern && !id.startsWith("DeletionRecordsWatch"));
    expect(rules).toHaveLength(9);
    const byId = (prefix: string) => {
      // Logical IDs end in an 8-character hash
      const found = rules.find(([id]) => id.startsWith(prefix) && /^[0-9A-F]{8}$/.test(id.slice(prefix.length)));
      if (!found) throw new Error(`No rule ${prefix}`);
      return { id: found[0], props: found[1].Properties as Record<string, unknown> };
    };
    return {
      t,
      admin: byId("OperatorPoolChanges"),
      self: byId("OperatorSelfServiceChanges"),
      watchChanges: byId("OperatorAuditWatchChanges"),
      dataPath: byId("OperatorAuditWatchDataPathChanges"),
      alarmChanges: byId("OperatorAlarmChanges"),
      routeChanges: byId("OperatorAlertRouteChanges"),
      tampering: byId("OperatorRuleTampering"),
      tamperingWatch: byId("OperatorRuleTamperingWatch"),
      deletionsTampering: byId("DeletionsRuleTampering"),
    };
  }

  it("tell P1 about user, group, password, MFA and pool changes, and what an operator's own token changes, in the primary region only", () => {
    const { region } = build();
    const west = Template.fromStack(region(WEST).observability);
    expect(Object.values(west.findResources("AWS::Events::Rule")).filter((r) => r.Properties.EventPattern)).toEqual([]);
    const { t, admin, self, watchChanges, dataPath, alarmChanges, routeChanges, tampering, tamperingWatch, deletionsTampering } = operatorRules();
    const poolId = { Ref: expect.stringMatching(/identityopsuserpoolid/i) };
    expect(admin.props.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        requestParameters: { userPoolId: [poolId] },
        $or: [{ eventName: [...OPERATOR_USER_EVENTS] }, { eventName: [...OPERATOR_POOL_CONFIG_EVENTS], userIdentity: NOT_CLOUDFORMATION }],
      },
    });
    for (const name of ["AdminCreateUser", "AdminAddUserToGroup", "AdminRemoveUserFromGroup", "UpdateUserPool", "SetUserPoolMfaConfig", "CreateUserPoolClient", "UpdateUserPoolClient", "AdminSetUserPassword", "AdminResetUserPassword", "AdminEnableUser", "AdminSetUserMFAPreference", "AdminUpdateUserAttributes", "CreateGroup", "UpdateGroup", "DeleteGroup", "CreateIdentityProvider", "AdminLinkProviderForUser"]) {
      expect(OPERATOR_POOL_ADMIN_EVENTS, name).toContain(name);
    }
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
    for (const rule of [admin, self, watchChanges, dataPath, alarmChanges, tampering, tamperingWatch]) {
      expect(rule.props.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
      expect(JSON.stringify(rule.props.Targets)).not.toContain("userIdentity");
    }
    // The route an alert takes: both topics, so breaking one still reaches the other
    expect(routeChanges.props.Targets).toEqual([
      expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } }),
      expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP2/) } }),
    ]);
    // Only these rules may publish
    const statements = Object.values(t.findResources("AWS::SNS::TopicPolicy")).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    const fromEvents = statements.filter((st) => (st.Principal as { Service?: unknown } | undefined)?.Service === "events.amazonaws.com");
    expect(fromEvents).toHaveLength(4);
    expect(fromEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Sid: "AllowOperatorPoolAlertToPublish",
        Condition: { ArnEquals: { "aws:SourceArn": [admin, self, watchChanges, dataPath, alarmChanges, routeChanges, tampering, tamperingWatch, deletionsTampering].map((r) => ({ "Fn::GetAtt": [r.id, "Arn"] })) } },
      }),
      // The route rule on the P2 topic, and nothing else
      expect.objectContaining({ Sid: "AllowAlertRouteChangesToPublish", Resource: { Ref: expect.stringMatching(/^AlarmTopicsP2/) }, Condition: { ArnEquals: { "aws:SourceArn": [{ "Fn::GetAtt": [routeChanges.id, "Arn"] }] } } }),
      // The deletion records bucket's change rule (tested with the watch)
      expect.objectContaining({ Sid: "AllowDeletionsBucketAlertToPublish" }),
      // The backup stack's two change-alert rules, by name (tested in backup.test.ts)
      expect.objectContaining({ Sid: "AllowBackupChangeAlertsToPublish" }),
    ]));
  });

  it("never exempt CloudFormation from user, membership, password or MFA calls, only from pool, client and group configuration (supply-checkout-6uw.7)", () => {
    // The two lists split the calls, with nothing in both
    expect([...OPERATOR_POOL_ADMIN_EVENTS].sort()).toEqual([...OPERATOR_USER_EVENTS, ...OPERATOR_POOL_CONFIG_EVENTS].sort());
    expect(OPERATOR_USER_EVENTS.filter((e) => (OPERATOR_POOL_CONFIG_EVENTS as readonly string[]).includes(e))).toEqual([]);
    for (const name of ["AdminCreateUser", "AdminAddUserToGroup", "AdminRemoveUserFromGroup", "AdminSetUserPassword", "AdminResetUserPassword", "AdminEnableUser", "AdminSetUserMFAPreference", "AdminUpdateUserAttributes", "AdminLinkProviderForUser"]) {
      expect(OPERATOR_USER_EVENTS, name).toContain(name);
    }
    // Every exempt call configures the pool, a client, a group or a provider: none names a user
    for (const name of OPERATOR_POOL_CONFIG_EVENTS) {
      expect(name).toMatch(/^(Create|Update|Delete|Set)(Group|UserPool|UserPoolMfaConfig|UserPoolClient|IdentityProvider)$/);
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

  it("tell P1 when an operator alert rule is deleted, disabled or loses its target, whoever does it, or is rewritten outside a deploy, with two rules watching each other (supply-checkout-6uw.11)", () => {
    const { t, admin, self, watchChanges, dataPath, alarmChanges, routeChanges, tampering, tamperingWatch, deletionsTampering } = operatorRules();
    // And the deletion records rules' own tampering rule, by its fixed name (supply-checkout-72d.17)
    const others = [...[admin, self, watchChanges, dataPath, alarmChanges, routeChanges].map((r) => ({ Ref: r.id })), deletionsRuleTamperingName("prod")];
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
    // Each watches every other rule and the other tampering rule: the second by its fixed name, the first by reference
    expect(tamperingWatch.props.Name).toBe(tamperingWatchRuleName("prod"));
    expect(tampering.props.EventPattern).toEqual(pattern([...others, tamperingWatchRuleName("prod")]));
    expect(tamperingWatch.props.EventPattern).toEqual(pattern([...others, { Ref: tampering.id }]));
    for (const rule of [tampering, tamperingWatch]) expect(JSON.stringify(rule.props.Targets)).toContain("an operator alert rule");
    // That one watches the deletion records watch's rule and its bucket-changes rule, the same way
    const watchRules = ["DeletionRecordsWatchRule", "DeletionRecordsWatchBucketChanges"].map((prefix) => Object.keys(t.findResources("AWS::Events::Rule")).find((id) => id.startsWith(prefix) && /^[0-9A-F]{8}$/.test(id.slice(prefix.length))));
    expect(watchRules.every(Boolean)).toBe(true);
    expect(deletionsTampering.props.Name).toBe(deletionsRuleTamperingName("prod"));
    expect(deletionsTampering.props.EventPattern).toEqual(pattern(watchRules.map((id) => ({ Ref: id }))));
    expect(deletionsTampering.props.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
    expect(JSON.stringify(deletionsTampering.props.Targets)).toContain("a deletion records watch rule");
  });

  it("keep every pattern well inside EventBridge's 4,096 characters, with each reference as long as a real name or ARN", () => {
    const { admin, self, watchChanges, dataPath, alarmChanges, routeChanges, tampering, tamperingWatch, deletionsTampering } = operatorRules();
    const LONG = `"${"x".repeat(90)}"`;
    const resolve = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(resolve) : value && typeof value === "object" ? (Object.keys(value).some((k) => k === "Ref" || k.startsWith("Fn::")) ? LONG : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))) : value;
    for (const rule of [admin, self, watchChanges, dataPath, alarmChanges, routeChanges, tampering, tamperingWatch, deletionsTampering]) {
      expect(JSON.stringify(resolve(rule.props.EventPattern)).length, rule.id).toBeLessThan(3500);
    }
  });

  it("tell P1 when the operator audit watch's mapping, function or role is deleted, or changed outside a deploy (supply-checkout-6uw.11)", () => {
    const { t, watchChanges } = operatorRules();
    const mapping = Object.keys(t.findResources("AWS::Lambda::EventSourceMapping"))[0];
    const role = Object.keys(t.findResources("AWS::IAM::Role")).find((id) => id.startsWith("OperatorAuditWatchRole"));
    const fn = "supply-checkout-prod-operator-audit-watch";
    const names = [fn, { wildcard: `*:function:${fn}` }, { wildcard: `*:function:${fn}:*` }];
    const prefixed = (list: readonly string[]) => list.map((prefix) => ({ prefix }));
    expect(watchChanges.props.EventPattern).toEqual({
      source: ["aws.lambda", "aws.iam"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          { eventName: prefixed(AUDIT_WATCH_MAPPING_EVENTS.always), eventSource: ["lambda.amazonaws.com"], requestParameters: { uUID: [{ Ref: mapping }] } },
          { eventName: prefixed(AUDIT_WATCH_MAPPING_EVENTS.outsideDeploys), eventSource: ["lambda.amazonaws.com"], requestParameters: { uUID: [{ Ref: mapping }] }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: prefixed(AUDIT_WATCH_FUNCTION_EVENTS.always), eventSource: ["lambda.amazonaws.com"], requestParameters: { functionName: names } },
          { eventName: prefixed(AUDIT_WATCH_FUNCTION_EVENTS.outsideDeploys), eventSource: ["lambda.amazonaws.com"], requestParameters: { functionName: names }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: [...AUDIT_WATCH_ROLE_EVENTS.always], eventSource: ["iam.amazonaws.com"], requestParameters: { roleName: [{ Ref: role }] } },
          { eventName: [...AUDIT_WATCH_ROLE_EVENTS.outsideDeploys], eventSource: ["iam.amazonaws.com"], requestParameters: { roleName: [{ Ref: role }] }, userIdentity: NOT_CLOUDFORMATION },
        ],
      },
    });
    // Zero concurrency, a disabled mapping and new code are each covered
    expect(AUDIT_WATCH_FUNCTION_EVENTS.outsideDeploys).toEqual(expect.arrayContaining(["PutFunctionConcurrency", "UpdateFunctionCode", "UpdateFunctionConfiguration"]));
    expect(AUDIT_WATCH_MAPPING_EVENTS.outsideDeploys).toEqual(["UpdateEventSourceMapping"]);
    expect(JSON.stringify(watchChanges.props.Targets)).toContain("the operator audit watch");
  });

  it("tell P1 when the watch's log group, the table's stream or the table key is deleted or disabled, or changed outside a deploy (supply-checkout-6uw.11)", () => {
    const { t, dataPath } = operatorRules();
    const logGroup = Object.keys(t.findResources("AWS::Logs::LogGroup")).find((id) => id.startsWith("OperatorAuditWatchLogs"));
    const name = { Ref: logGroup };
    const identifier = [name, { wildcard: { "Fn::Join": ["", ["*:log-group:", name]] } }, { wildcard: { "Fn::Join": ["", ["*:log-group:", name, ":*"]] } }];
    const tableArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]] };
    const streamPrefix = { prefix: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app/stream/"]] } };
    const table = ["supply-checkout-prod-app", tableArn];
    const key = { Ref: expect.stringMatching(/datatablekeyarn/i) };
    expect(dataPath.props.EventPattern).toEqual({
      source: ["aws.logs", "aws.dynamodb", "aws.kms"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          // The role can't recreate a deleted group, and its metrics are in its lines
          { eventName: ["DeleteLogGroup"], eventSource: ["logs.amazonaws.com"], requestParameters: { logGroupName: [name] } },
          { eventName: ["PutTransformer", "DeleteTransformer", "PutDataProtectionPolicy"], eventSource: ["logs.amazonaws.com"], requestParameters: { logGroupIdentifier: identifier }, userIdentity: NOT_CLOUDFORMATION },
          { eventName: ["PutAccountPolicy"], eventSource: ["logs.amazonaws.com"], requestParameters: { policyType: ["TRANSFORMER_POLICY", "DATA_PROTECTION_POLICY"] } },
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
    expect(JSON.stringify(dataPath.props.Targets)).toContain("the table's stream or the table key");
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
    const { routeChanges } = operatorRules();
    const topics = [{ Ref: expect.stringMatching(/^AlarmTopicsP1/) }, { Ref: expect.stringMatching(/^AlarmTopicsP2/) }];
    const subscriptions = topics.map((ref) => ({ prefix: { "Fn::Join": ["", [ref, ":"]] } }));
    const keyArn = { "Fn::GetAtt": [expect.stringMatching(/^AlarmTopicsKey/), "Arn"] };
    const key = [{ Ref: expect.stringMatching(/^AlarmTopicsKey/) }, keyArn];
    expect(routeChanges.props.EventPattern).toEqual({
      source: ["aws.sns", "aws.kms", "aws.cloudtrail"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        $or: [
          { eventName: ["DeleteTopic", "RemovePermission"], eventSource: ["sns.amazonaws.com"], requestParameters: { topicArn: topics } },
          { eventName: ["SetTopicAttributes"], eventSource: ["sns.amazonaws.com"], requestParameters: { topicArn: topics }, userIdentity: NOT_CLOUDFORMATION },
          // A data protection policy names the topic in `resourceArn`: one that denies every inbound message stops the topic, so always
          { eventName: ["PutDataProtectionPolicy"], eventSource: ["sns.amazonaws.com"], requestParameters: { resourceArn: topics } },
          { eventName: ["Unsubscribe", "SetSubscriptionAttributes"], eventSource: ["sns.amazonaws.com"], requestParameters: { subscriptionArn: subscriptions }, userIdentity: NOT_CLOUDFORMATION },
          // By the key's ARN in `resources`, so a call through an alias (or an alias ARN) still matches
          { eventName: ["DisableKey", "ScheduleKeyDeletion"], eventSource: ["kms.amazonaws.com"], resources: { ARN: [keyArn] } },
          { eventName: ["PutKeyPolicy"], eventSource: ["kms.amazonaws.com"], resources: { ARN: [keyArn] }, userIdentity: NOT_CLOUDFORMATION },
          // Any alias pointed at the key, whoever makes it
          { eventName: ["CreateAlias", "UpdateAlias"], eventSource: ["kms.amazonaws.com"], requestParameters: { targetKeyId: key } },
          { eventSource: ["cloudtrail.amazonaws.com"], eventName: [...TRAIL_EVENTS] },
        ],
      },
    });
    expect([...TRAIL_EVENTS]).toEqual(expect.arrayContaining(["StopLogging", "DeleteTrail"]));
    expect([...ALARM_TOPIC_EVENTS.always, ...ALARM_TOPIC_EVENTS.outsideDeploys, ...ALARM_SUBSCRIPTION_EVENTS.outsideDeploys]).toEqual(expect.arrayContaining(["DeleteTopic", "SetTopicAttributes", "Unsubscribe"]));
    expect([...ALARM_KEY_EVENTS.always, ...ALARM_KEY_EVENTS.outsideDeploys]).toEqual(["DisableKey", "ScheduleKeyDeletion", "PutKeyPolicy"]);
    expect([...ALARM_KEY_ALIAS_EVENTS.always]).toEqual(["CreateAlias", "UpdateAlias"]);
    expect([...ALARM_TOPIC_RESOURCE_EVENTS.always]).toEqual(["PutDataProtectionPolicy"]);
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
