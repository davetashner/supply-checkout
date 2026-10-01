import { Aws } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnAnomalyMonitor, CfnAnomalySubscription } from "aws-cdk-lib/aws-ce";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { AlarmTopics, Severity } from "./alarm-topics.js";

// OWNER: the defaults below are a guess for a pre-launch account (a few
// dollars to a few tens of dollars a month). Adjust them as real spend
// becomes known, either here or per deploy with CDK context:
//   -c monthlyBudgetUsd=150 -c costAnomalyUsd=25
// (or the same keys in cdk.json's context).

/** The monthly cost budget, in US dollars. Alerts at 50%, 80% and 100% of actual spend and 100% of forecast spend. */
export const DEFAULT_MONTHLY_BUDGET_USD = 100;

/** Cost Anomaly Detection alerts on an anomaly whose total impact is at least this many US dollars. */
export const DEFAULT_COST_ANOMALY_USD = 20;

/** The largest value either setting accepts: a typo (an extra zero or two) shouldn't silence the alerts. */
const MAX_USD = 10_000;

/** Percentages of the monthly budget that alert on actual spend. */
export const ACTUAL_THRESHOLDS = [50, 80, 100] as const;
/** Percentage of the monthly budget that alerts on forecast spend. */
export const FORECAST_THRESHOLD = 100;

/**
 * Cost alerts go to email only (supply-checkout-jxq): the P2 topic, whose
 * recipients are the alarm email addresses. A cost surprise isn't worth
 * waking anyone for.
 */
export const COST_ALERT_SEVERITY: Severity = "P2";

export interface CostAlertSettings {
  readonly monthlyBudgetUsd: number;
  readonly anomalyUsd: number;
  /**
   * An existing Cost Anomaly Detection monitor to subscribe to, instead of
   * creating one. An account may have only one AWS services monitor, and AWS
   * may already have made one ("Default-Services-Monitor"). Its ARN has the
   * account ID, so it's given on the command line, never committed.
   */
  readonly anomalyMonitorArn?: string;
}

interface ContextReader {
  tryGetContext(key: string): unknown;
}

function usd(node: ContextReader, key: string, fallback: number): number {
  const raw = node.tryGetContext(key);
  if (raw === undefined) return fallback;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_USD) {
    throw new Error(`${key} must be a number of US dollars above 0 and at most ${MAX_USD} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

const MONITOR_ARN = /^arn:aws[a-z-]*:ce::\d{12}:anomalymonitor\/[0-9a-f-]{1,64}$/;

/** Reads monthlyBudgetUsd, costAnomalyUsd and costAnomalyMonitorArn from CDK context. */
export function costAlertsFromContext(node: ContextReader): CostAlertSettings {
  const arn = node.tryGetContext("costAnomalyMonitorArn");
  if (arn !== undefined && (typeof arn !== "string" || !MONITOR_ARN.test(arn))) {
    throw new Error(`costAnomalyMonitorArn must be a Cost Anomaly Detection monitor ARN (got ${JSON.stringify(arn)})`);
  }
  return {
    monthlyBudgetUsd: usd(node, "monthlyBudgetUsd", DEFAULT_MONTHLY_BUDGET_USD),
    anomalyUsd: usd(node, "costAnomalyUsd", DEFAULT_COST_ANOMALY_USD),
    ...(arn === undefined ? {} : { anomalyMonitorArn: arn }),
  };
}

export const budgetName = (envName: string) => `supply-checkout-${envName}-monthly`;
export const anomalyMonitorName = (envName: string) => `supply-checkout-${envName}-services`;
export const anomalySubscriptionName = (envName: string) => `supply-checkout-${envName}-anomalies`;

export interface CostAlertsProps extends CostAlertSettings {
  readonly envName: string;
  readonly topics: AlarmTopics;
}

/**
 * The account's monthly cost budget and its Cost Anomaly Detection monitor
 * and subscription (supply-checkout-jxq), notifying the P2 alarm topic.
 *
 * Budgets and Cost Explorer are account-wide, not regional (Cost Explorer's
 * API is in GLOBAL_SERVICES_REGION only), so this belongs in exactly one
 * stack: the observability stack in GLOBAL_SERVICES_REGION.
 *
 * Both services publish to the encrypted topic as AWS service principals,
 * so the topic's policy and its key's policy let each publish, for this
 * account's budgets and anomaly subscriptions only (confused deputy
 * prevention: aws:SourceAccount and aws:SourceArn).
 */
export class CostAlerts extends Construct {
  readonly budget: CfnBudget;
  readonly monitor?: CfnAnomalyMonitor;
  readonly subscription: CfnAnomalySubscription;

  constructor(scope: Construct, id: string, props: CostAlertsProps) {
    super(scope, id);
    const topic = props.topics.topics[COST_ALERT_SEVERITY];

    // Budgets' and anomaly subscriptions' ARNs have no region
    const budgetsSource = `arn:${Aws.PARTITION}:budgets::${Aws.ACCOUNT_ID}:*`;
    const anomalySource = `arn:${Aws.PARTITION}:ce::${Aws.ACCOUNT_ID}:anomalysubscription/*`;
    const publishers = [
      { sid: "AllowBudgetsToPublish", service: "budgets.amazonaws.com", source: budgetsSource },
      { sid: "AllowCostAnomaliesToPublish", service: "costalerts.amazonaws.com", source: anomalySource },
    ];
    for (const { sid, service, source } of publishers) {
      const conditions = { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID }, ArnLike: { "aws:SourceArn": source } };
      topic.addToResourcePolicy(
        new PolicyStatement({ sid, principals: [new ServicePrincipal(service)], actions: ["sns:Publish"], resources: [topic.topicArn], conditions }),
      );
      // The topic is encrypted: the service needs a data key to publish
      props.topics.key.addToResourcePolicy(
        new PolicyStatement({ sid, principals: [new ServicePrincipal(service)], actions: ["kms:Decrypt", "kms:GenerateDataKey*"], resources: ["*"], conditions }),
      );
    }

    const sns = { subscriptionType: "SNS", address: topic.topicArn };
    const notification = (notificationType: "ACTUAL" | "FORECASTED", threshold: number): CfnBudget.NotificationWithSubscribersProperty => ({
      notification: { notificationType, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
      subscribers: [sns],
    });
    this.budget = new CfnBudget(this, "Budget", {
      budget: {
        budgetName: budgetName(props.envName),
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        // Gross spend: credits and refunds would hide a runaway cost until they ran out
        costTypes: { includeCredit: false, includeRefund: false },
      },
      notificationsWithSubscribers: [
        ...ACTUAL_THRESHOLDS.map((t) => notification("ACTUAL", t)),
        notification("FORECASTED", FORECAST_THRESHOLD),
      ],
    });
    // Budgets checks it may publish when it saves the notifications
    this.budget.node.addDependency(topic);

    let monitorArn = props.anomalyMonitorArn;
    if (monitorArn === undefined) {
      this.monitor = new CfnAnomalyMonitor(this, "Monitor", {
        monitorName: anomalyMonitorName(props.envName),
        monitorType: "DIMENSIONAL",
        monitorDimension: "SERVICE",
      });
      monitorArn = this.monitor.attrMonitorArn;
    }
    this.subscription = new CfnAnomalySubscription(this, "Subscription", {
      subscriptionName: anomalySubscriptionName(props.envName),
      monitorArnList: [monitorArn],
      // SNS subscribers must be IMMEDIATE
      frequency: "IMMEDIATE",
      subscribers: [{ type: "SNS", address: topic.topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: [String(props.anomalyUsd)] },
      }),
    });
    // Cost Anomaly Detection checks it may publish when the subscription is saved
    this.subscription.node.addDependency(topic);
  }
}
