import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  type IMetric,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import type { AlarmTopics, Severity } from "./alarm-topics.js";
import { business, dynamoDbSystemErrors, dynamoDbThrottles, FIVE_MINUTES, lambda } from "./metrics.js";

/**
 * One alarm from docs/journeys.md, "Alarms for blocked journeys". Only alarms
 * whose metrics exist, or will exist as soon as the code that sends them is
 * deployed, are here. The rest are listed in docs/journeys.md with the bead
 * that adds them.
 */
export interface JourneyAlarmSpec {
  /** Construct ID, and the end of the alarm name. */
  readonly id: string;
  /** The alarm's name in docs/journeys.md. */
  readonly title: string;
  /** Journeys it guards: "Every journey", "J4", ... */
  readonly journeys: string;
  readonly severity: Severity;
  /** The threshold from docs/journeys.md, in words, and any difference from it. */
  readonly rule: string;
  readonly metric: IMetric;
  readonly threshold: number;
}

export interface JourneyAlarmsProps {
  readonly envName: string;
  readonly region: string;
  /** The app table's name in this region (a global table has the same name in every region). */
  readonly tableName: string;
  readonly topics: AlarmTopics;
}

const FIFTEEN_MINUTES = Duration.minutes(15);

/** `numerator / denominator` as a percentage, or 0 while the denominator is below `minimum`. */
function percent(numerator: Metric, denominator: Metric, minimum: number, label: string): MathExpression {
  return new MathExpression({
    expression: `IF(d >= ${minimum}, 100 * FILL(n, 0) / d, 0)`,
    usingMetrics: { n: numerator, d: denominator },
    period: numerator.period,
    label,
  });
}

export function journeyAlarmSpecs(region: string, tableName: string): JourneyAlarmSpec[] {
  return [
    // Every journey
    {
      id: "functions-failing",
      title: "Functions failing",
      journeys: "Every journey",
      severity: "P1",
      rule: "Lambda Errors above 1% of invocations for 5 minutes, across every function in the region, once there are at least 20 invocations. Per-function alarms come with the functions.",
      metric: percent(lambda("Errors", region), lambda("Invocations", region), 20, `Lambda error rate % (${region})`),
      threshold: 1,
    },
    {
      id: "functions-throttled",
      title: "Functions throttled",
      journeys: "Every journey",
      severity: "P2",
      rule: "Any Lambda throttles for 5 minutes, across every function in the region.",
      metric: lambda("Throttles", region),
      threshold: 0,
    },
    {
      id: "database-errors",
      title: "Database errors",
      journeys: "Every journey",
      severity: "P1",
      rule: "Any DynamoDB SystemErrors on the app table for 5 minutes.",
      metric: dynamoDbSystemErrors(tableName, region),
      threshold: 0,
    },
    {
      id: "database-throttled",
      title: "Database throttled",
      journeys: "Every journey",
      severity: "P2",
      rule: "Any read or write throttle events on the app table for 5 minutes.",
      metric: dynamoDbThrottles(tableName, region),
      threshold: 0,
    },
    // J3. Invite the crew
    {
      id: "email-bouncing",
      title: "Email bouncing",
      journeys: "J3",
      severity: "P1",
      rule: "SES Reputation.BounceRate above 4%. AWS reviews accounts at 5% and can pause sending at 10%.",
      metric: new Metric({ namespace: "AWS/SES", metricName: "Reputation.BounceRate", statistic: "Maximum", period: FIFTEEN_MINUTES, region }),
      threshold: 0.04,
    },
    {
      id: "email-complaints",
      title: "Email complaints",
      journeys: "J3",
      severity: "P1",
      rule: "SES Reputation.ComplaintRate above 0.08%. AWS reviews at 0.1%.",
      metric: new Metric({ namespace: "AWS/SES", metricName: "Reputation.ComplaintRate", statistic: "Maximum", period: FIFTEEN_MINUTES, region }),
      threshold: 0.0008,
    },
    // J4. Check supplies out and back in
    {
      id: "writes-rejected",
      title: "Writes rejected",
      journeys: "J4",
      severity: "P2",
      rule: "ConditionalWriteConflicts above 5% of Writes over 15 minutes, once there are at least 20 writes. A spike means a sync bug.",
      metric: percent(
        business(BusinessMetric.ConditionalWriteConflicts, region, FIFTEEN_MINUTES),
        business(BusinessMetric.Writes, region, FIFTEEN_MINUTES),
        20,
        `Write conflict rate % (${region})`,
      ),
      threshold: 5,
    },
    // J5. Read a receipt
    {
      id: "receipt-reading-failing",
      title: "Receipt reading failing",
      journeys: "J5",
      severity: "P2",
      rule: "ReceiptReadFailures above 10% of ReceiptReads over 15 minutes, once there are at least 5 reads.",
      metric: percent(
        business(BusinessMetric.ReceiptReadFailures, region, FIFTEEN_MINUTES),
        business(BusinessMetric.ReceiptReads, region, FIFTEEN_MINUTES),
        5,
        `Receipt failure rate % (${region})`,
      ),
      threshold: 10,
    },
    // J7. Subscribe, add seats and see invoices
    {
      id: "checkout-broken",
      title: "Checkout broken",
      journeys: "J7",
      severity: "P1",
      rule: "Any CheckoutSessionErrors for 5 minutes.",
      metric: business(BusinessMetric.CheckoutSessionErrors, region, FIVE_MINUTES),
      threshold: 0,
    },
    {
      id: "webhook-signature-failures",
      title: "Webhook signature failures",
      journeys: "J7",
      severity: "P1",
      rule: "Any WebhookSignatureFailures. Usually a rotated or wrong signing secret.",
      metric: business(BusinessMetric.WebhookSignatureFailures, region, FIVE_MINUTES),
      threshold: 0,
    },
  ];
}

/**
 * The journey alarms for one region, each notifying its severity's topic.
 * Missing data never alarms: most of these metrics only exist once traffic
 * does.
 */
export class JourneyAlarms extends Construct {
  readonly alarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: JourneyAlarmsProps) {
    super(scope, id);
    for (const spec of journeyAlarmSpecs(props.region, props.tableName)) {
      const alarm = new Alarm(this, spec.id, {
        alarmName: `supply-checkout-${props.envName}-${spec.severity.toLowerCase()}-${spec.id}`,
        alarmDescription: [
          `${spec.severity} ${spec.title} (${spec.journeys}, ${props.region}).`,
          spec.rule,
          "Thresholds and runbooks: docs/journeys.md, Alarms for blocked journeys.",
        ].join(" "),
        metric: spec.metric,
        threshold: spec.threshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      props.topics.notify(alarm, spec.severity);
      this.alarms.push(alarm);
    }
  }
}
