import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import { GLOBAL_SERVICES_REGION } from "../config.js";
import { rumAppMonitorName } from "../web/rum.js";
import type { AlarmTopics, Severity } from "./alarm-topics.js";
import { FIVE_MINUTES } from "./metrics.js";

/** Requests in 5 minutes below which "Site down" doesn't look at the 5xx rate, so a quiet night's one error doesn't page. */
export const SITE_DOWN_MIN_REQUESTS = 50;
/** The distribution's 5xx rate (%) over 5 minutes above which "Site down" alarms (docs/journeys.md). */
export const SITE_DOWN_PERCENT = 1;
/** Router errors and throttles in 5 minutes above which "Web router failing" alarms. */
export const ROUTER_FAILING_ABOVE = 4;

/**
 * RUM events ingested in an hour above which "RUM events surge" (P2) alarms.
 * At $1 per 100,000 events that's $1 an hour. Honest traffic is far below it:
 * at most 200 events a session, and MVP traffic is a few hundred sessions a day.
 */
export const RUM_EVENTS_SURGE_PER_HOUR = 100_000;
/** RUM events ingested in an hour above which "RUM events flood" (P1) alarms: $10 an hour, $240 a day if it goes on. */
export const RUM_EVENTS_FLOOD_PER_HOUR = 10 * RUM_EVENTS_SURGE_PER_HOUR;

/**
 * Events the web app's RUM app monitor ingested: RumEventPayloadSize's
 * SampleCount (one sample per event), per hour. AWS/RUM publishes it in the
 * app monitor's region with the dimension application_name.
 */
export function rumEvents(envName: string): Metric {
  return new Metric({
    namespace: "AWS/RUM",
    metricName: "RumEventPayloadSize",
    dimensionsMap: { application_name: rumAppMonitorName(envName) },
    statistic: "SampleCount",
    period: Duration.hours(1),
    region: GLOBAL_SERVICES_REGION,
    label: "RUM events ingested",
  });
}

/**
 * CloudFront metrics: published only in GLOBAL_SERVICES_REGION,
 * with the dimension Region=Global next to the distribution or function.
 */
export function cloudFront(metricName: string, dimensions: Record<string, string>, statistic: "Sum" | "Average" = "Sum", label?: string): Metric {
  return new Metric({
    namespace: "AWS/CloudFront",
    metricName,
    dimensionsMap: { ...dimensions, Region: "Global" },
    statistic,
    period: FIVE_MINUTES,
    region: GLOBAL_SERVICES_REGION,
    label,
  });
}

/** The distribution's 5xx rate (%), or 0 while it has fewer than SITE_DOWN_MIN_REQUESTS requests. */
export function siteErrorRate(distributionId: string): MathExpression {
  return new MathExpression({
    expression: `IF(r >= ${SITE_DOWN_MIN_REQUESTS}, FILL(e, 0), 0)`,
    usingMetrics: {
      e: cloudFront("5xxErrorRate", { DistributionId: distributionId }, "Average"),
      r: cloudFront("Requests", { DistributionId: distributionId }),
    },
    period: FIVE_MINUTES,
    label: "Web 5xx rate % (CloudFront)",
  });
}

/** The router's execution and validation errors and its throttles, added up. */
export function routerFailures(functionName: string): MathExpression {
  const fn = { FunctionName: functionName };
  return new MathExpression({
    expression: "FILL(x, 0) + FILL(v, 0) + FILL(t, 0)",
    usingMetrics: {
      x: cloudFront("FunctionExecutionErrors", fn),
      v: cloudFront("FunctionValidationErrors", fn),
      t: cloudFront("FunctionThrottles", fn),
    },
    period: FIVE_MINUTES,
    label: "Router errors and throttles",
  });
}

export interface WebAlarmsProps {
  readonly envName: string;
  /** The web distribution's ID (the web stack's SSM output). */
  readonly distributionId: string;
  /** The router CloudFront Function's name (the web stack's SSM output). */
  readonly routerFunctionName: string;
  readonly topics: AlarmTopics;
}

/**
 * P1 alarms for the web app being down (supply-checkout-3sv.2), and on RUM
 * events that cost too much. On 2026-09-27 app. and /demo/ answered 503 for
 * 90 minutes after a web deploy broke the router function, and nothing alarmed.
 *
 * - `siteDown` ("Site down" in docs/journeys.md): the distribution's
 *   5xxErrorRate above 1% for 5 minutes, once it has 50 requests. This covers
 *   the router failing (CloudFront answers 503), the bucket failing, and
 *   nothing live on a channel (the router's own 503).
 * - `routerFailing`: the router's FunctionExecutionErrors,
 *   FunctionValidationErrors and FunctionThrottles, 5 or more in 5 minutes.
 *   Every request a broken router sees errors, so this fires even when there
 *   are too few requests for Site down, and says where to look.
 * - `rumSurge` (P2) and `rumFlood` (P1): the RUM app monitor's ingested
 *   events above RUM_EVENTS_SURGE_PER_HOUR and RUM_EVENTS_FLOOD_PER_HOUR in
 *   an hour (supply-checkout-3sv.7). The RUM client's limits bound honest
 *   browsers only; anyone with the identity pool's ID can send billed events.
 *
 * CloudFront's metrics are only in GLOBAL_SERVICES_REGION (and the app
 * monitor is there, with the distribution), and an alarm can
 * only notify a topic in its own region, so these are in the observability
 * stack there. Missing data doesn't breach: no requests is not
 * an outage.
 */
export class WebAlarms extends Construct {
  readonly siteDown: Alarm;
  readonly routerFailing: Alarm;
  readonly rumSurge: Alarm;
  readonly rumFlood: Alarm;
  readonly alarms: Alarm[];

  constructor(scope: Construct, id: string, props: WebAlarmsProps) {
    super(scope, id);
    const alarm = (alarmId: string, title: string, rule: string, metric: MathExpression, threshold: number) => {
      const a = new Alarm(this, alarmId, {
        alarmName: `supply-checkout-${props.envName}-p1-${alarmId}`,
        alarmDescription: [
          `P1 ${title} (Every journey, CloudFront).`,
          rule,
          "Runbook: docs/observability.md, When the web app is down.",
        ].join(" "),
        metric,
        threshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      props.topics.notify(a, "P1");
      return a;
    };
    this.siteDown = alarm(
      "site-down",
      "Site down",
      `The web distribution's 5xxErrorRate above ${SITE_DOWN_PERCENT}% for 5 minutes, once it has at least ${SITE_DOWN_MIN_REQUESTS} requests: app. or /demo/ is failing (a broken router, the bucket, or nothing live on a channel).`,
      siteErrorRate(props.distributionId),
      SITE_DOWN_PERCENT,
    );
    this.routerFailing = alarm(
      "web-router-failing",
      "Web router failing",
      `The router CloudFront Function's execution errors, validation errors and throttles at least ${ROUTER_FAILING_ABOVE + 1} in 5 minutes: requests to app., the apex and /demo/ get 5xx. Usually a bad router deploy.`,
      routerFailures(props.routerFunctionName),
      ROUTER_FAILING_ABOVE,
    );
    // Anyone can send the RUM app monitor events with the public identity pool, and each is billed (supply-checkout-3sv.7)
    const rum = (alarmId: string, severity: Severity, title: string, threshold: number) => {
      const a = new Alarm(this, alarmId, {
        alarmName: `supply-checkout-${props.envName}-${severity.toLowerCase()}-${alarmId}`,
        alarmDescription: [
          `${severity} ${title} (CloudWatch RUM cost).`,
          `The web app's RUM app monitor ingested more than ${threshold} events in an hour ($1 per 100,000): someone is probably sending events with the public identity pool's guest credentials.`,
          "Runbook: docs/observability.md, When RUM events surge.",
        ].join(" "),
        metric: rumEvents(props.envName),
        threshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      props.topics.notify(a, severity);
      return a;
    };
    this.rumSurge = rum("rum-events-surge", "P2", "RUM events surge", RUM_EVENTS_SURGE_PER_HOUR);
    this.rumFlood = rum("rum-events-flood", "P1", "RUM events flood", RUM_EVENTS_FLOOD_PER_HOUR);
    this.alarms = [this.siteDown, this.routerFailing, this.rumSurge, this.rumFlood];
  }
}
