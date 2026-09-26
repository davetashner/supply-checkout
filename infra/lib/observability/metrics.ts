import { Duration } from "aws-cdk-lib";
import { type IMetric, MathExpression, Metric } from "aws-cdk-lib/aws-cloudwatch";
import {
  type BusinessMetricName,
  METRICS_NAMESPACE,
  REGION_DIMENSION,
} from "../../../backend/src/observability/names.js";

// Metrics read by the dashboard and the alarms, each for one region. The
// dashboard lives in the primary region and draws every region's metrics
// cross-region; each region's alarms read only their own region.

export const FIVE_MINUTES = Duration.minutes(5);

/** A business metric the backend sends (backend/src/observability). */
export function business(name: BusinessMetricName, region: string, period = FIVE_MINUTES): Metric {
  return new Metric({
    namespace: METRICS_NAMESPACE,
    metricName: name,
    dimensionsMap: { [REGION_DIMENSION]: region },
    statistic: "Sum",
    period,
    region,
    label: `${name} (${region})`,
  });
}

/**
 * A Lambda metric across every function in the region: the account-level
 * series, which has no dimensions. The account holds only this app
 * (ADR 0003), so it is the app's total.
 */
export function lambda(name: "Invocations" | "Errors" | "Throttles" | "Duration", region: string, statistic = "Sum"): Metric {
  return new Metric({ namespace: "AWS/Lambda", metricName: name, statistic, period: FIVE_MINUTES, region, label: `Lambda ${name} (${region})` });
}

/** A metric of one HTTP API, across its routes (the ApiId dimension alone). */
export function apiGateway(name: "Count" | "5xx" | "4xx" | "Latency", apiId: string, region: string, statistic = "Sum", period = FIVE_MINUTES): Metric {
  return new Metric({ namespace: "AWS/ApiGateway", metricName: name, dimensionsMap: { ApiId: apiId }, statistic, period, region });
}

/**
 * DynamoDB operations the data-access module uses (backend/src/data). Some
 * DynamoDB metrics exist only per operation, so alarms add them up.
 */
export const DYNAMODB_OPERATIONS = ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "TransactGetItems", "TransactWriteItems"] as const;

export function dynamoDb(name: string, table: string, region: string, operation?: string): Metric {
  return new Metric({
    namespace: "AWS/DynamoDB",
    metricName: name,
    dimensionsMap: operation ? { TableName: table, Operation: operation } : { TableName: table },
    statistic: "Sum",
    period: FIVE_MINUTES,
    region,
  });
}

/** A metric-math ID unique to the region, so one graph can hold every region's expressions. */
const mathId = (prefix: string, region: string) => `${prefix}_${region.replaceAll("-", "_")}`;

/** SystemErrors on the table, summed over every operation the app uses. */
export function dynamoDbSystemErrors(table: string, region: string): MathExpression {
  const usingMetrics: Record<string, IMetric> = {};
  DYNAMODB_OPERATIONS.forEach((op, i) => (usingMetrics[mathId(`e${i}`, region)] = dynamoDb("SystemErrors", table, region, op)));
  return new MathExpression({
    // FILL: an operation with no errors has no data points, and a sum with a
    // missing term would be missing too.
    expression: Object.keys(usingMetrics).map((id) => `FILL(${id}, 0)`).join(" + "),
    usingMetrics,
    period: FIVE_MINUTES,
    label: `DynamoDB system errors (${region})`,
  });
}

/** Read and write throttle events on the table and its indexes. */
export function dynamoDbThrottles(table: string, region: string): MathExpression {
  return new MathExpression({
    expression: `FILL(${mathId("r", region)}, 0) + FILL(${mathId("w", region)}, 0)`,
    usingMetrics: {
      [mathId("r", region)]: dynamoDb("ReadThrottleEvents", table, region),
      [mathId("w", region)]: dynamoDb("WriteThrottleEvents", table, region),
    },
    period: FIVE_MINUTES,
    label: `DynamoDB throttles (${region})`,
  });
}

/**
 * An HTTP API metric summed over every API in the region, found by search, so
 * the dashboard shows the API as soon as the api stack creates it
 * (ADR 0006). Search expressions work on dashboards only, not
 * in alarms; the API's alarms need its ID and are added with the API.
 */
const apiSum = (name: string) => `SUM(SEARCH('{AWS/ApiGateway,ApiId} MetricName="${name}"', 'Sum', 300))`;

export function apiSearch(name: "Count" | "4xx" | "5xx", region: string): MathExpression {
  return new MathExpression({
    expression: apiSum(name),
    usingMetrics: {},
    period: FIVE_MINUTES,
    label: `API ${name === "Count" ? "requests" : name} (${region})`,
    searchRegion: region,
  });
}

/** p95 latency of each HTTP API in the region (percentiles can't be summed). */
export function apiLatencySearch(region: string): MathExpression {
  return new MathExpression({
    expression: `SEARCH('{AWS/ApiGateway,ApiId} MetricName="Latency"', 'p95', 300)`,
    usingMetrics: {},
    period: FIVE_MINUTES,
    label: `API p95 latency (${region})`,
    searchRegion: region,
  });
}

/** 5xx responses as a percentage of requests, over every HTTP API in the region. */
export function apiErrorRate(region: string): MathExpression {
  return new MathExpression({
    expression: `100 * ${apiSum("5xx")} / ${apiSum("Count")}`,
    usingMetrics: {},
    period: FIVE_MINUTES,
    label: `API 5xx rate % (${region})`,
    searchRegion: region,
  });
}
