import { Aws, Stack, Token } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnAnomalyMonitor, CfnAnomalySubscription } from "aws-cdk-lib/aws-ce";
import { EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { AlarmTopics, Severity } from "./alarm-topics.js";
import { NOT_CLOUDFORMATION } from "./cloudtrail.js";

// OWNER: the defaults below are a guess for a pre-launch account (a few
// dollars to a few tens of dollars a month). Adjust them as real spend
// becomes known, either here or per deploy with CDK context:
//   -c monthlyBudgetUsd=150 -c bedrockBudgetUsd=75 -c costAnomalyUsd=25
// (or the same keys in cdk.json's context).

/** The monthly cost budget, in US dollars. Alerts at 50%, 80% and 100% of actual spend and 100% of forecast spend. */
export const DEFAULT_MONTHLY_BUDGET_USD = 100;

/** Cost Anomaly Detection alerts on an anomaly whose total impact is at least this many US dollars. */
export const DEFAULT_COST_ANOMALY_USD = 20;

/**
 * The monthly budget for Bedrock alone, in US dollars (supply-checkout-i1d.3):
 * receipt reading's model spend, alerting at the same thresholds as the
 * account's budget. Provisional: about 10,000 receipt reads a month.
 */
export const DEFAULT_BEDROCK_BUDGET_USD = 50;

/**
 * The services the Bedrock budget counts, by their names in Cost Explorer's
 * Service dimension, matched exactly. Bedrock's own charges are "Amazon
 * Bedrock"; Anthropic's models are billed through AWS Marketplace under a
 * service named for the model. OWNER: check these against Cost Explorer
 * (grouped by Service) once the first reads are billed, and fix any that
 * don't match, or the budget won't see that spend.
 */
export const BEDROCK_BUDGET_SERVICES = ["Amazon Bedrock", "Claude Haiku 4.5 (Amazon Bedrock Edition)"] as const;

/** The largest value either setting accepts: a typo (an extra zero or two) shouldn't silence the alerts. */
const MAX_USD = 10_000;
/**
 * The smallest: a cent. A smaller amount would be written as "1e-7" in the
 * anomaly subscription's threshold expression (supply-checkout-3sv.19), and
 * every amount is rounded to the cent for the same reason.
 */
const MIN_USD = 0.01;

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
  /** The Bedrock budget (BEDROCK_BUDGET_SERVICES), monthly. */
  readonly bedrockBudgetUsd: number;
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_USD || value > MAX_USD) {
    throw new Error(`${key} must be a number of US dollars from ${MIN_USD} to ${MAX_USD} (got ${JSON.stringify(raw)})`);
  }
  return Math.round(value * 100) / 100;
}

const MONITOR_ARN = /^arn:aws[a-z-]*:ce::(\d{12}):anomalymonitor\/([0-9a-f-]{1,64})$/;

/** Reads monthlyBudgetUsd, bedrockBudgetUsd, costAnomalyUsd and costAnomalyMonitorArn from CDK context. */
export function costAlertsFromContext(node: ContextReader): CostAlertSettings {
  const arn = node.tryGetContext("costAnomalyMonitorArn");
  if (arn !== undefined && (typeof arn !== "string" || !MONITOR_ARN.test(arn))) {
    throw new Error(`costAnomalyMonitorArn must be a Cost Anomaly Detection monitor ARN (got ${JSON.stringify(arn)})`);
  }
  return {
    monthlyBudgetUsd: usd(node, "monthlyBudgetUsd", DEFAULT_MONTHLY_BUDGET_USD),
    bedrockBudgetUsd: usd(node, "bedrockBudgetUsd", DEFAULT_BEDROCK_BUDGET_USD),
    anomalyUsd: usd(node, "costAnomalyUsd", DEFAULT_COST_ANOMALY_USD),
    ...(arn === undefined ? {} : { anomalyMonitorArn: arn }),
  };
}

export const budgetName = (envName: string) => `supply-checkout-${envName}-monthly`;
export const bedrockBudgetName = (envName: string) => `supply-checkout-${envName}-bedrock`;
export const anomalyMonitorName = (envName: string) => `supply-checkout-${envName}-services`;
export const anomalySubscriptionName = (envName: string) => `supply-checkout-${envName}-anomalies`;

/**
 * The cost alert watch's rule name suffix (supply-checkout-3sv.19). The
 * observability stack names the rule under the operator prefix
 * (operatorRuleName), so the operator rule-tampering rules, in the primary
 * region, watch it too, while the primary region is GLOBAL_SERVICES_REGION,
 * as it is for prod.
 */
export const COST_ALERT_RULE_SUFFIX = "cost-alert-changes";

/**
 * Budgets calls that delete or change the budgets, their notifications or
 * their subscribers, which could silence the budget alerts (or point them
 * elsewhere): P2 outside a CloudFormation deploy. Each names the budget in
 * requestParameters.budgetName, except UpdateBudget, which names it in
 * requestParameters.newBudget.budgetName.
 */
export const BUDGET_EVENTS = [
  "DeleteBudget",
  "UpdateBudget",
  "CreateNotification",
  "UpdateNotification",
  "DeleteNotification",
  "CreateSubscriber",
  "UpdateSubscriber",
  "DeleteSubscriber",
] as const;

/** Cost Explorer calls that delete or change the anomaly monitor, named by its ARN: P2 outside a deploy. */
export const ANOMALY_MONITOR_EVENTS = ["DeleteAnomalyMonitor", "UpdateAnomalyMonitor"] as const;
/** Cost Explorer calls that delete or change the anomaly subscription, named by its ARN: P2 outside a deploy. */
export const ANOMALY_SUBSCRIPTION_EVENTS = ["DeleteAnomalySubscription", "UpdateAnomalySubscription"] as const;

export interface CostAlertsProps extends CostAlertSettings {
  readonly envName: string;
  readonly topics: AlarmTopics;
  /** The cost alert watch's rule's fixed name (COST_ALERT_RULE_SUFFIX). */
  readonly ruleName: string;
}

/**
 * The account's monthly cost budget, a monthly budget for Bedrock alone
 * (supply-checkout-i1d.3), and the account's Cost Anomaly Detection monitor
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
 *
 * `changes` (supply-checkout-3sv.19) tells P2 when the budgets, their
 * notifications or subscribers, the anomaly monitor or the subscription are
 * deleted or changed outside a CloudFormation deploy (BUDGET_EVENTS,
 * ANOMALY_MONITOR_EVENTS, ANOMALY_SUBSCRIPTION_EVENTS), from CloudTrail
 * through EventBridge: both services' events arrive in
 * GLOBAL_SERVICES_REGION. Only that rule, by ARN, may publish to the P2
 * topic for it.
 */
export class CostAlerts extends Construct {
  readonly budget: CfnBudget;
  readonly bedrockBudget: CfnBudget;
  readonly monitor?: CfnAnomalyMonitor;
  readonly subscription: CfnAnomalySubscription;
  readonly changes: Rule;

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

    // Bedrock alone (supply-checkout-i1d.3): receipt reading's model spend, which a
    // farm of trial sign-ups would drive, seen apart from the rest of the bill
    this.bedrockBudget = new CfnBudget(this, "BedrockBudget", {
      budget: {
        budgetName: bedrockBudgetName(props.envName),
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.bedrockBudgetUsd, unit: "USD" },
        costTypes: { includeCredit: false, includeRefund: false },
        filterExpression: { dimensions: { key: "SERVICE", values: [...BEDROCK_BUDGET_SERVICES], matchOptions: ["EQUALS"] } },
      },
      notificationsWithSubscribers: [
        ...ACTUAL_THRESHOLDS.map((t) => notification("ACTUAL", t)),
        notification("FORECASTED", FORECAST_THRESHOLD),
      ],
    });
    this.bedrockBudget.node.addDependency(topic);

    let monitorArn: string;
    if (props.anomalyMonitorArn !== undefined) {
      monitorArn = existingMonitorArn(this, props.anomalyMonitorArn);
    } else {
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

    this.changes = this.watchChanges(props, monitorArn);
  }

  private watchChanges(props: CostAlertsProps, monitorArn: string): Rule {
    const budgets = [budgetName(props.envName), bedrockBudgetName(props.envName)];
    const rule = new Rule(this, "Changes", {
      ruleName: props.ruleName,
      description: "The cost budgets, their notifications or subscribers, or the cost anomaly monitor or subscription were deleted or changed outside a deploy (supply-checkout-3sv.19)",
      eventPattern: {
        source: ["aws.budgets", "aws.ce"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          userIdentity: NOT_CLOUDFORMATION,
          $or: [
            { eventSource: ["budgets.amazonaws.com"], eventName: [...BUDGET_EVENTS], requestParameters: { budgetName: budgets } },
            { eventSource: ["budgets.amazonaws.com"], eventName: ["UpdateBudget"], requestParameters: { newBudget: { budgetName: budgets } } },
            { eventSource: ["ce.amazonaws.com"], eventName: [...ANOMALY_MONITOR_EVENTS], requestParameters: { monitorArn: [monitorArn] } },
            { eventSource: ["ce.amazonaws.com"], eventName: [...ANOMALY_SUBSCRIPTION_EVENTS], requestParameters: { subscriptionArn: [this.subscription.attrSubscriptionArn] } },
          ],
        },
      },
    });
    const p2 = props.topics.topics[COST_ALERT_SEVERITY];
    p2.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowCostAlertChangesToPublish",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [p2.topicArn],
        // By the rule's fixed name, not a reference to it: the rule names the
        // subscription, which is created after this policy (Cost Anomaly
        // Detection checks it may publish), so a reference would be a cycle
        conditions: { ArnEquals: { "aws:SourceArn": `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/${props.ruleName}` } },
      }),
    );
    // The topic is encrypted: EventBridge may use its key, for this account's
    // rules (as SupportSmtpWatch does). Naming the rule's ARN would make the
    // key depend on the rule, which depends on the topic, which depends on the
    // key; the topic policy above still lets only this rule publish.
    props.topics.key.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowCostAlertChangesToEncrypt",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
    );
    const message = RuleTargetInput.fromText(
      `Supply Checkout ${props.envName}: ${EventField.fromPath("$.detail.eventName")} on the cost alerts at ${EventField.fromPath("$.detail.eventTime")}, outside a deploy (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). The budget or cost anomaly alerts may be silenced. Follow "When the cost alerts are changed" in docs/observability.md.`,
    );
    // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
    rule.addTarget({ bind: () => ({ arn: p2.topicArn, input: message }) });
    return rule;
  }
}

/**
 * The existing monitor's ARN, in the deploying account (supply-checkout-3sv.19):
 * built from the monitor's ID with this stack's account, so a monitor in
 * another account can't be subscribed to. When the account is known at synth
 * time (a deploy), an ARN naming another account is an error.
 */
function existingMonitorArn(scope: Construct, arn: string): string {
  const [, account, id] = MONITOR_ARN.exec(arn) as RegExpExecArray;
  const stackAccount = Stack.of(scope).account;
  if (!Token.isUnresolved(stackAccount) && account !== stackAccount) {
    throw new Error("costAnomalyMonitorArn names a monitor in another account than the one being deployed to");
  }
  return `arn:${Aws.PARTITION}:ce::${Aws.ACCOUNT_ID}:anomalymonitor/${id}`;
}
