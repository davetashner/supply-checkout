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
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", regions: [EAST, WEST], primaryRegion: EAST };

function build(context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, ...context } });
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
  "functions-throttled",
  "database-errors",
  "database-throttled",
  "email-bouncing",
  "email-complaints",
  "writes-rejected",
  "receipt-reading-failing",
  "checkout-broken",
  "webhook-signature-failures",
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
      const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties);
      const specs = journeyAlarmSpecs(r, "t");
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
    const api = region(EAST).api;
    testFunction(api, "Plain");
    testFunction(api, "PassThrough", Tracing.PASS_THROUGH);
    new LogGroup(api, "Kept", { retention: RetentionDays.ONE_WEEK });
    return { app, api };
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
    expect(retentions.sort()).toEqual([365, 365, 7]);
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
