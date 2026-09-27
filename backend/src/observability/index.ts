// Structured logs and business metrics for every Lambda function, built on
// Powertools for AWS Lambda (TypeScript).
//
// - Logs are one JSON object per line, with the service, environment, region,
//   request ID and X-Ray trace ID on every line, so Logs Insights can filter
//   and join them.
// - Business metrics go out as CloudWatch embedded metric format (EMF) in the
//   log stream: no PutMetricData calls, no extra latency. Every metric has
//   exactly one dimension, Region, which the dashboard and alarms in
//   infra/lib/observability read with the same names (./names.ts).
//
// Usage in a handler:
//
//   const obs = createObservability({ service: "sheets" });
//   export const handler = withObservability(obs, async (event) => {
//     obs.logger.info("Checking out", { sheetId });
//     obs.count(BusinessMetric.Checkouts, items.length, { teamId });
//     ...
//   });

import { Logger } from "@aws-lambda-powertools/logger";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import type { Context } from "aws-lambda";
import { type BusinessMetricName, ENV, METRICS_NAMESPACE, REGION_DIMENSION } from "./names.js";

export { BusinessMetric, type BusinessMetricName, METRICS_NAMESPACE, REGION_DIMENSION } from "./names.js";
export type { Logger } from "@aws-lambda-powertools/logger";

export interface ObservabilityOptions {
  /** The function's service name, e.g. "sheets". Defaults to POWERTOOLS_SERVICE_NAME. */
  readonly service?: string;
  /** Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Values that are safe to put in logs and metric metadata: never secrets or personal data. */
export type Metadata = Record<string, string | number | boolean>;

/** Units a gauge can be in. */
export type GaugeUnit = "Count" | "Percent";

export interface Observability {
  readonly logger: Logger;
  /** The region every metric is dimensioned by. */
  readonly region: string;
  /**
   * Adds `value` to a business metric. Metadata (such as the team ID) is
   * written beside the metric in the log line, not as a dimension.
   */
  count(metric: BusinessMetricName, value?: number, metadata?: Metadata): void;
  /**
   * Records a level measured now (a gauge, such as a scheduled check's
   * finding), in the given unit. Alarms read its Maximum.
   */
  gauge(metric: BusinessMetricName, value: number, unit?: GaugeUnit): void;
  /** Writes buffered metrics. withObservability calls this after every invocation. */
  flush(): void;
}

function regionFrom(env: NodeJS.ProcessEnv): string {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION is not set");
  return region;
}

export function createObservability(options: ObservabilityOptions = {}): Observability {
  const env = options.env ?? process.env;
  const region = regionFrom(env);
  const service = options.service ?? env[ENV.service] ?? "supply-checkout";
  const envName = env[ENV.envName] ?? "local";

  const logger = new Logger({
    serviceName: service,
    logLevel: (env[ENV.logLevel] as "INFO" | undefined) ?? "INFO",
    persistentKeys: { env: envName, region },
  });

  const metrics = new Metrics({ namespace: env[ENV.namespace] ?? METRICS_NAMESPACE, serviceName: service });
  // Powertools adds a `service` dimension by default. Replace it with Region
  // alone, so every function's Checkouts add up to one metric per region.
  // (Its singleMetric() would add `service` back, so count() doesn't use it.)
  metrics.clearDefaultDimensions();
  metrics.setDefaultDimensions({ [REGION_DIMENSION]: region });

  let pending = false;
  const flush = () => {
    if (!pending) return;
    pending = false;
    metrics.publishStoredMetrics();
  };
  return {
    logger,
    region,
    flush,
    count(metric, value = 1, metadata = {}) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`Metric ${metric} needs a count of 0 or more (got ${value})`);
      // Metadata is per log line, so a metric with metadata goes out on its own
      // line rather than sharing one with other metrics' metadata.
      const hasMetadata = Object.keys(metadata).length > 0;
      if (hasMetadata) flush();
      for (const [key, v] of Object.entries(metadata)) metrics.addMetadata(key, String(v));
      metrics.addMetric(metric, MetricUnit.Count, value);
      pending = true;
      if (hasMetadata) flush();
    },
    gauge(metric, value, unit = "Count") {
      if (!Number.isFinite(value) || value < 0) throw new Error(`Metric ${metric} needs a value of 0 or more (got ${value})`);
      metrics.addMetric(metric, unit === "Percent" ? MetricUnit.Percent : MetricUnit.Count, value);
      pending = true;
    },
  };
}

/**
 * Wraps a Lambda handler: adds the request ID and cold-start flag to every log
 * line, logs an unhandled error once with its stack, and always flushes
 * metrics, even when the handler throws.
 */
export function withObservability<E, R>(
  obs: Observability,
  handler: (event: E, context: Context) => Promise<R>,
): (event: E, context: Context) => Promise<R> {
  return async (event, context) => {
    obs.logger.addContext(context);
    try {
      return await handler(event, context);
    } catch (error) {
      obs.logger.error("Unhandled error", error as Error);
      throw error;
    } finally {
      obs.flush();
    }
  };
}
