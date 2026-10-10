import {
  AlarmStatusWidget,
  Dashboard,
  GraphWidget,
  type IAlarm,
  type IMetric,
  TextWidget,
} from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { BusinessMetric, type BusinessMetricName, NEEDS_ATTENTION_METRICS } from "../../../backend/src/observability/names.js";
import { apiGateway, apiLatencySearch, apiSearch, business, dynamoDbThrottles, FIVE_MINUTES, lambda } from "./metrics.js";
import { cloudFront, opsErrorRate, routerFailures } from "./web-alarms.js";

export interface OpsDashboardProps {
  readonly envName: string;
  /** Every region in the environment; each graph has one line per region. */
  readonly regions: readonly string[];
  readonly tableName: string;
  /**
   * The HTTP API's ID in this, the dashboard's, region (the api stack's SSM
   * output): its graphs name it, one metric each. Other regions' API graphs
   * use SEARCH, which can't be counted ahead (see DASHBOARD_METRICS_LIMIT).
   */
  readonly api: { readonly region: string; readonly apiId: string };
  /** This region's alarms, shown at the top. */
  readonly alarms: readonly IAlarm[];
  /**
   * The web distribution and its router, when this stack has their alarms
   * (the primary region is GLOBAL_SERVICES_REGION): a row of CloudFront graphs.
   */
  readonly web?: {
    readonly distributionId: string;
    readonly routerFunctionName: string;
    readonly opsDistributionId: string;
  };
}

/**
 * Metrics the dashboard may reference: CloudWatch's free tier is 3 dashboards
 * of up to 50 metrics each, and one over 50 costs $3 a month
 * (supply-checkout-7pe.1). infra/test/observability.test.ts counts them in
 * the deployed regions' templates: every metric a graph names, inside metric
 * math too, once for each place it's named.
 */
export const DASHBOARD_METRICS_LIMIT = 50;

const WIDTH = 24;

/**
 * One CloudWatch dashboard for the environment, in the primary region, that
 * reads every region's metrics cross-region, each line labelled with its
 * region (ADR 0010). It's kept to DASHBOARD_METRICS_LIMIT metrics, so it
 * shows what the runbooks look at: traffic, errors and latency, the web app,
 * the business metrics of each journey, the purge's gauges, the operator
 * audit watch's heartbeat, and "Needs attention" (the one metric every rare
 * event adds to; the event's own metric is in the metrics console, and the
 * text beside the graph lists them). The alarm panel lists the alarms.
 * Every other business metric is in the metrics console (SupplyCheckout, by
 * Region) and in Logs Insights. A dashboard in each other region is phase 2.
 */
export class OpsDashboard extends Construct {
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: OpsDashboardProps) {
    super(scope, id);
    const { regions } = props;
    const each = <T extends IMetric>(fn: (region: string) => T | T[]) => regions.flatMap((r) => fn(r));
    const graph = (title: string, left: IMetric[], width = WIDTH / 3) => new GraphWidget({ title, left, width, height: 6 });
    const businessGraph = (title: string, names: BusinessMetricName[], width = WIDTH / 4) =>
      graph(title, each((r) => names.map((name) => business(name, r))), width);
    const gaugeGraph = (title: string, names: BusinessMetricName[], width = WIDTH / 4) =>
      graph(title, each((r) => names.map((name) => business(name, r, FIVE_MINUTES, "Maximum"))), width);
    // The API's own metrics where its ID is known, a search elsewhere
    const api = (name: "Count" | "4xx" | "5xx", r: string): IMetric =>
      r === props.api.region ? apiGateway(name, props.api.apiId, r) : apiSearch(name, r);
    const apiLatency = (r: string): IMetric =>
      r === props.api.region ? apiGateway("Latency", props.api.apiId, r, "p95") : apiLatencySearch(r);

    this.dashboard = new Dashboard(this, "Dashboard", {
      dashboardName: `supply-checkout-${props.envName}`,
    });

    this.dashboard.addWidgets(
      new TextWidget({
        markdown: [
          `# Supply Checkout ${props.envName}`,
          `Regions: ${regions.join(", ")}. Every line is labelled with its region.`,
          "Alarms and thresholds: docs/journeys.md, *Alarms for blocked journeys*. Every other business metric is in the metrics console (SupplyCheckout, by Region).",
        ].join("\n\n"),
        width: WIDTH,
        height: 3,
      }),
    );
    this.dashboard.addWidgets(
      new AlarmStatusWidget({ title: "Alarms", alarms: [...props.alarms], width: WIDTH, height: 4 }),
    );

    // Needs attention: the one metric every rare event adds to (backend/src/observability/names.ts)
    this.dashboard.addWidgets(
      graph("Needs attention: rare events, any kind", each((r) => business(BusinessMetric.NeedsAttention, r)), WIDTH / 2),
      new TextWidget({
        markdown: [
          "### Which event?",
          `Each adds to NeedsAttention and to its own metric: ${[...NEEDS_ATTENTION_METRICS].map((m) => `\`${m}\``).join(", ")}.`,
          "Find it in the metrics console (SupplyCheckout, by Region), or in Logs Insights over the functions' log groups: `filter ispresent(NeedsAttention)`. What to do for each: docs/observability.md, *When Needs attention fires*.",
        ].join("\n\n"),
        width: WIDTH / 2,
        height: 6,
      }),
    );

    // Traffic, errors and latency
    this.dashboard.addWidgets(
      graph("API: requests, 4xx and 5xx", each((r) => [api("Count", r), api("4xx", r), api("5xx", r)])),
      graph("Lambda: invocations, errors and throttles", each((r) => [lambda("Invocations", r), lambda("Errors", r), lambda("Throttles", r)])),
      graph("DynamoDB: throttles (system errors: the Database errors alarm)", each((r) => dynamoDbThrottles(props.tableName, r))),
    );
    this.dashboard.addWidgets(graph("API: p95 latency (ms)", each((r) => apiLatency(r)), WIDTH / 4));

    // The web app on CloudFront (GLOBAL_SERVICES_REGION only): Site down, Web router failing, Operator page down
    if (props.web) {
      const { distributionId, routerFunctionName, opsDistributionId } = props.web;
      this.dashboard.addWidgets(
        graph("Web: CloudFront requests and 5xx rate %", [
          cloudFront("Requests", { DistributionId: distributionId }, "Sum", "Requests (CloudFront)"),
          cloudFront("5xxErrorRate", { DistributionId: distributionId }, "Average", "5xx rate % (CloudFront)"),
        ], WIDTH / 4),
        graph("Web: router errors and throttles", [routerFailures(routerFunctionName)], WIDTH / 4),
        graph("Operator page: requests and 5xx rate %", [
          cloudFront("Requests", { DistributionId: opsDistributionId }, "Sum", "Operator page requests (CloudFront)"),
          opsErrorRate(opsDistributionId),
        ], WIDTH / 4),
      );
    }

    // Business metrics (docs/journeys.md, "Business metrics the app must publish")
    this.dashboard.addWidgets(
      businessGraph("J4: checkouts and returns", [BusinessMetric.Checkouts, BusinessMetric.Returns]),
      businessGraph("J4: writes and conflicts", [BusinessMetric.Writes, BusinessMetric.ConditionalWriteConflicts]),
      businessGraph("J4: live updates, failed and deferred", [BusinessMetric.LiveUpdates, BusinessMetric.LiveUpdateFailures, BusinessMetric.LiveUpdatesDeferred]),
      businessGraph("J1: sign-ups; J3: invites sent, accepted and failed", [BusinessMetric.SignUps, BusinessMetric.InvitesSent, BusinessMetric.InvitesAccepted, BusinessMetric.InvitesFailed]),
    );
    this.dashboard.addWidgets(
      businessGraph("J5: receipt reads, failures and lines", [BusinessMetric.ReceiptReads, BusinessMetric.ReceiptReadFailures, BusinessMetric.ReceiptLines]),
      businessGraph("J5: receipt tokens", [BusinessMetric.ReceiptTokens]),
      graph("J5: receipt model call p95 (ms)", each((r) => business(BusinessMetric.ReceiptReadLatency, r, FIVE_MINUTES, "p95")), WIDTH / 4),
      businessGraph("J5: receipt limits (rate, allowance, trials near it)", [BusinessMetric.ReceiptRateLimited, BusinessMetric.ReceiptLimitReached, BusinessMetric.ReceiptTrialsNearLimit]),
    );
    this.dashboard.addWidgets(
      businessGraph("J7: billing errors", [BusinessMetric.CheckoutSessionErrors, BusinessMetric.BillingPortalErrors, BusinessMetric.InvoiceListErrors, BusinessMetric.WebhookSignatureFailures]),
      businessGraph("J7, J8: billing events and owner emails, and not", [BusinessMetric.BillingEventsApplied, BusinessMetric.BillingNotices, BusinessMetric.BillingNoticeFailures]),
      businessGraph("J3: email bounces and complaints", [BusinessMetric.EmailBounces, BusinessMetric.EmailComplaints]),
      // The purge's gauges (primary region), at their maximum
      gaugeGraph("J11: closed teams overdue for deletion; J7: set aside, oldest Stripe customer deletion queued (hours)", [BusinessMetric.ClosedTeamsOverdue, BusinessMetric.ClosedTeamsSetAside, BusinessMetric.StripeCustomerDeletionOldestHours]),
    );
    // The operator audit watch's heartbeats (primary region): a gap means it isn't reading the stream ("Operator audit watch silent")
    this.dashboard.addWidgets(businessGraph("Operators: audit watch heartbeats", [BusinessMetric.OperatorAuditWatchHeartbeat]));
  }
}
