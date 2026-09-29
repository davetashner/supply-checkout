import {
  AlarmStatusWidget,
  Dashboard,
  GraphWidget,
  type IAlarm,
  type IMetric,
  TextWidget,
} from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { BusinessMetric, type BusinessMetricName } from "../../../backend/src/observability/names.js";
import {
  apiErrorRate,
  apiLatencySearch,
  apiSearch,
  business,
  dynamoDbSystemErrors,
  dynamoDbThrottles,
  FIVE_MINUTES,
  lambda,
} from "./metrics.js";
import { cloudFront, routerFailures, SITE_DOWN_MIN_REQUESTS, siteErrorRate } from "./web-alarms.js";

export interface OpsDashboardProps {
  readonly envName: string;
  /** Every region in the environment; each graph has one line per region. */
  readonly regions: readonly string[];
  readonly tableName: string;
  /** This region's alarms, shown at the top. */
  readonly alarms: readonly IAlarm[];
  /**
   * The web distribution and its router, when this stack has their alarms
   * (the primary region is GLOBAL_SERVICES_REGION): a row of CloudFront graphs.
   */
  readonly web?: { readonly distributionId: string; readonly routerFunctionName: string };
}

const WIDTH = 24;

/**
 * One CloudWatch dashboard for the environment, in the primary region, that
 * reads every region's metrics cross-region: traffic, errors, latency and the
 * business metrics, each line labelled with its region (ADR 0010). A
 * dashboard in each other region is phase 2.
 */
export class OpsDashboard extends Construct {
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: OpsDashboardProps) {
    super(scope, id);
    const { regions } = props;
    const each = <T extends IMetric>(fn: (region: string) => T | T[]) => regions.flatMap((r) => fn(r));
    const graph = (title: string, left: IMetric[], width = WIDTH / 3) => new GraphWidget({ title, left, width, height: 6 });
    const businessGraph = (title: string, names: BusinessMetricName[]) =>
      graph(title, each((r) => names.map((name) => business(name, r))), WIDTH / 4);

    this.dashboard = new Dashboard(this, "Dashboard", {
      dashboardName: `supply-checkout-${props.envName}`,
    });

    this.dashboard.addWidgets(
      new TextWidget({
        markdown: [
          `# Supply Checkout ${props.envName}`,
          `Regions: ${regions.join(", ")}. Every line is labelled with its region.`,
          "Alarms and thresholds: docs/journeys.md, *Alarms for blocked journeys*.",
        ].join("\n\n"),
        width: WIDTH,
        height: 3,
      }),
    );
    this.dashboard.addWidgets(
      new AlarmStatusWidget({ title: "Alarms", alarms: [...props.alarms], width: WIDTH, height: 4 }),
    );

    // Traffic
    this.dashboard.addWidgets(
      graph("Traffic: API requests", each((r) => apiSearch("Count", r))),
      graph("Traffic: Lambda invocations", each((r) => lambda("Invocations", r))),
      graph("Traffic: API 4xx", each((r) => apiSearch("4xx", r))),
    );

    // Errors
    this.dashboard.addWidgets(
      graph("Errors: API 5xx rate %", each((r) => apiErrorRate(r))),
      graph(
        "Errors: Lambda errors and throttles",
        each((r) => [lambda("Errors", r), lambda("Throttles", r)]),
      ),
      graph(
        "Errors: DynamoDB system errors and throttles",
        each((r) => [dynamoDbSystemErrors(props.tableName, r), dynamoDbThrottles(props.tableName, r)]),
      ),
    );

    // Latency
    this.dashboard.addWidgets(
      graph("Latency: API p95 (ms)", each((r) => apiLatencySearch(r)), WIDTH / 2),
      graph("Latency: Lambda duration p95 (ms)", each((r) => lambda("Duration", r, "p95")), WIDTH / 2),
    );

    // The web app on CloudFront (GLOBAL_SERVICES_REGION only): Site down and Web router failing
    if (props.web) {
      const { distributionId, routerFunctionName } = props.web;
      this.dashboard.addWidgets(
        graph("Web: CloudFront requests", [cloudFront("Requests", { DistributionId: distributionId }, "Sum", "Requests (CloudFront)")]),
        graph(`Web: CloudFront 5xx rate % (at least ${SITE_DOWN_MIN_REQUESTS} requests)`, [siteErrorRate(distributionId)]),
        graph("Web: router errors and throttles", [routerFailures(routerFunctionName)]),
      );
    }

    // Business metrics (docs/journeys.md, "Business metrics the app must publish")
    this.dashboard.addWidgets(
      businessGraph("J4: checkouts and returns", [BusinessMetric.Checkouts, BusinessMetric.Returns]),
      businessGraph("J4: writes and conflicts", [BusinessMetric.Writes, BusinessMetric.ConditionalWriteConflicts]),
      businessGraph("J5: receipt reads and lines", [BusinessMetric.ReceiptReads, BusinessMetric.ReceiptReadFailures, BusinessMetric.ReceiptLines]),
      businessGraph("J5: receipt tokens", [BusinessMetric.ReceiptTokens]),
    );
    this.dashboard.addWidgets(
      businessGraph("J1: sign-ups", [BusinessMetric.SignUps]),
      businessGraph("J3: invites", [BusinessMetric.InvitesSent, BusinessMetric.InvitesAccepted, BusinessMetric.InvitesFailed]),
      businessGraph("J7: billing errors", [BusinessMetric.CheckoutSessionErrors, BusinessMetric.BillingPortalErrors, BusinessMetric.WebhookSignatureFailures]),
      businessGraph("J7, J8: billing events and owner emails", [BusinessMetric.BillingEventsApplied, BusinessMetric.BillingNotices, BusinessMetric.BillingNoticeFailures]),
      businessGraph("J4: live updates, failed and deferred", [BusinessMetric.LiveUpdates, BusinessMetric.LiveUpdateFailures, BusinessMetric.LiveUpdatesDeferred]),
    );
    this.dashboard.addWidgets(
      businessGraph("J3: email bounces and complaints", [BusinessMetric.EmailBounces, BusinessMetric.EmailComplaints]),
      businessGraph("J3: email verification not saved", [BusinessMetric.EmailVerifyFailures, BusinessMetric.EmailUnverifyFailures]),
      businessGraph("J0: sign-outs not revoked", [BusinessMetric.SignOutRevokeFailures]),
      // Gauges from the scheduled checks (primary region), at their maximum
      graph("J2: stuck imports; J3: SES quota used %", each((r) => [BusinessMetric.StuckImports, BusinessMetric.EmailQuotaUsedPercent].map((name) => business(name, r, FIVE_MINUTES, "Maximum"))), WIDTH / 4),
    );
    this.dashboard.addWidgets(
      businessGraph("Accounts: teams closed, accounts deleted, teams purged", [BusinessMetric.TeamsClosed, BusinessMetric.AccountsDeleted, BusinessMetric.TeamsPurged]),
      businessGraph("Accounts: owners emailed that their team closed, and not", [BusinessMetric.TeamClosedNotices, BusinessMetric.TeamClosedNoticeFailures]),
      businessGraph("Accounts: teams reopened, owners emailed about it, and not", [BusinessMetric.TeamsReopened, BusinessMetric.TeamReopenedNotices, BusinessMetric.TeamReopenedNoticeFailures]),
      // The purge's gauge (primary region), at its maximum
      graph("J11: closed teams overdue for deletion", each((r) => business(BusinessMetric.ClosedTeamsOverdue, r, FIVE_MINUTES, "Maximum")), WIDTH / 4),
      businessGraph("J3: email codes not sent or checked (5xx)", [BusinessMetric.EmailCodeSendFailures, BusinessMetric.EmailCodeVerifyFailures]),
    );
    this.dashboard.addWidgets(
      // The operator audit watch (primary region): any point here is a P1
      businessGraph("Operators: audit items changed or deleted (not by TTL)", [BusinessMetric.OperatorAuditChanged]),
      // Its heartbeats: a gap means it isn't reading the stream ("Operator audit watch silent")
      businessGraph("Operators: audit watch heartbeats", [BusinessMetric.OperatorAuditWatchHeartbeat]),
      // The deletion records watch (primary region): any point here is a P2
      businessGraph("Backups: deletion records rewritten or deleted", [BusinessMetric.DeletionRecordRewrites]),
      // Closed teams' subscriptions ended, and purged teams' Stripe customers deleted (supply-checkout-t0en)
      businessGraph("J7: closed teams' subscriptions ended, Stripe customers deleted", [BusinessMetric.ClosedTeamSubscriptionsEnded, BusinessMetric.StripeCustomersDeleted]),
      // The operator group watch (primary region): a change is a P1; a gap in the size means it isn't running ("Operator group watch silent")
      graph(
        "Operators: group changes, resets and size",
        each((r) => [business(BusinessMetric.OperatorGroupChanged, r), business(BusinessMetric.OperatorGroupBaselineReset, r), business(BusinessMetric.OperatorGroupMembers, r, FIVE_MINUTES, "Maximum")]),
        WIDTH / 4,
      ),
    );
  }
}
