import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { GLOBAL_SERVICES_REGION } from "../config.js";
import type { AlarmTopics } from "./alarm-topics.js";
import { FIVE_MINUTES } from "./metrics.js";

/** Requests in 5 minutes below which "Site down" doesn't look at the 5xx rate, so a quiet night's one error doesn't page. */
export const SITE_DOWN_MIN_REQUESTS = 50;
/** The distribution's 5xx rate (%) over 5 minutes above which "Site down" alarms (docs/journeys.md). */
export const SITE_DOWN_PERCENT = 1;
/** Router errors and throttles in 5 minutes above which "Web router failing" alarms. */
export const ROUTER_FAILING_ABOVE = 4;

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
 * P1 alarms for the web app being down (supply-checkout-3sv.2): on 2026-09-27
 * app. and /demo/ answered 503 for 90 minutes after a web deploy broke the
 * router function, and nothing alarmed.
 *
 * - `siteDown` ("Site down" in docs/journeys.md): the distribution's
 *   5xxErrorRate above 1% for 5 minutes, once it has 50 requests. This covers
 *   the router failing (CloudFront answers 503), the bucket failing, and
 *   nothing live on a channel (the router's own 503).
 * - `routerFailing`: the router's FunctionExecutionErrors,
 *   FunctionValidationErrors and FunctionThrottles, 5 or more in 5 minutes.
 *   Every request a broken router sees errors, so this fires even when there
 *   are too few requests for Site down, and says where to look.
 *
 * CloudFront's metrics are only in GLOBAL_SERVICES_REGION, and an alarm can
 * only notify a topic in its own region, so these are in the observability
 * stack there. Missing data doesn't breach: no requests is not
 * an outage.
 */
export class WebAlarms extends Construct {
  readonly siteDown: Alarm;
  readonly routerFailing: Alarm;
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
    this.alarms = [this.siteDown, this.routerFailing];
  }
}
