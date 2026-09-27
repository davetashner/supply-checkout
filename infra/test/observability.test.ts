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
import { CHECK_EVERY_MINUTES, PURGE_EVERY_HOURS, PURGE_OVERDUE_AFTER_HOURS, PURGE_SILENT_ALARM_HOURS, STUCK_IMPORT_AFTER_MINUTES } from "../../backend/src/ops/names.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";
import { OPERATOR_POOL_ADMIN_EVENTS, OPERATOR_SELF_SERVICE_EVENTS } from "../lib/stacks/observability-stack.js";

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
        const allow = all.filter((a) => a.Sid !== "AllowOperatorPoolAlertToPublish");
        if (all.length !== allow.length) expect([r, topics[0]]).toEqual([EAST, expect.stringMatching(/^AlarmTopicsP1/)]);
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
  it("creates the same alarms in every region, each notifying its severity's topic on alarm and recovery", () => {
    for (const r of config.regions) {
      const t = observability(r);
      // The purge's own alarm is with the purge, in the primary region only (scheduled checks, below)
      const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties).filter((a) => a.AlarmName !== "supply-checkout-prod-p2-deletion-not-running");
      const specs = journeyAlarmSpecs(r, "t", "api", "prod");
      expect(alarms.map((a) => a.AlarmName).sort()).toEqual(
        specs.map((s) => `supply-checkout-prod-${s.severity.toLowerCase()}-${s.id}`).sort(),
      );
      expect(specs.map((s) => s.id).sort()).toEqual([...ALARM_IDS].sort());
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
    expect(functions(t).map((f) => f.FunctionName).sort()).toEqual(["supply-checkout-prod-email-quota", "supply-checkout-prod-stuck-imports", "supply-checkout-prod-team-purge"]);
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
    ]);
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
  it("tell P1 about user, group, password, MFA and pool changes (not CloudFormation's), and what an operator's own token changes, in the primary region only", () => {
    const { region } = build();
    const west = Template.fromStack(region(WEST).observability);
    expect(Object.values(west.findResources("AWS::Events::Rule")).filter((r) => r.Properties.EventPattern)).toEqual([]);
    const t = observability();
    const rules = Object.entries(t.findResources("AWS::Events::Rule")).filter(([, r]) => r.Properties.EventPattern);
    expect(rules).toHaveLength(2);
    const [[adminId, admin], [selfId, self]] = rules.sort(([a], [b]) => a.localeCompare(b)) as [[string, { Properties: Record<string, unknown> }], [string, { Properties: Record<string, unknown> }]];
    const poolId = { Ref: expect.stringMatching(/identityopsuserpoolid/i) };
    expect(admin.Properties.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: [...OPERATOR_POOL_ADMIN_EVENTS],
        requestParameters: { userPoolId: [poolId] },
        userIdentity: { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] },
      },
    });
    for (const name of ["AdminCreateUser", "AdminAddUserToGroup", "AdminRemoveUserFromGroup", "UpdateUserPool", "SetUserPoolMfaConfig", "CreateUserPoolClient", "UpdateUserPoolClient", "AdminSetUserPassword", "AdminResetUserPassword", "AdminEnableUser", "AdminSetUserMFAPreference", "AdminUpdateUserAttributes", "CreateGroup", "UpdateGroup", "DeleteGroup", "CreateIdentityProvider", "AdminLinkProviderForUser"]) {
      expect(OPERATOR_POOL_ADMIN_EVENTS, name).toContain(name);
    }
    expect(self.Properties.EventPattern).toEqual({
      source: ["aws.cognito-idp"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["cognito-idp.amazonaws.com"],
        eventName: ["AssociateSoftwareToken", "VerifySoftwareToken", "SetUserMFAPreference", "UpdateUserAttributes", "DeleteUser"],
        $or: [{ requestParameters: { userPoolId: [poolId] } }, { additionalEventData: { userPoolId: [poolId] } }],
      },
    });
    expect([...OPERATOR_SELF_SERVICE_EVENTS]).toHaveLength(5);
    for (const rule of [admin, self]) {
      expect(rule.Properties.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(/^AlarmTopicsP1/) } })]);
      expect(JSON.stringify(rule.Properties.Targets)).not.toContain("userIdentity");
    }
    // Only these rules may publish
    const statements = Object.values(t.findResources("AWS::SNS::TopicPolicy")).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
    expect(statements.filter((st) => (st.Principal as { Service?: unknown } | undefined)?.Service === "events.amazonaws.com")).toEqual([
      expect.objectContaining({ Sid: "AllowOperatorPoolAlertToPublish", Condition: { ArnEquals: { "aws:SourceArn": [{ "Fn::GetAtt": [adminId, "Arn"] }, { "Fn::GetAtt": [selfId, "Arn"] }] } } }),
    ]);
  });
});
