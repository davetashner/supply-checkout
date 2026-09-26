import { type IAspect, Validations } from "aws-cdk-lib";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { type CfnFunction, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IConstruct } from "constructs";
import { ENV, METRICS_NAMESPACE } from "../../../backend/src/observability/names.js";
import type { DeploymentConfig } from "../config.js";

/**
 * How long CloudWatch Logs keeps application logs.
 *
 * There is no information security policy yet (supply-checkout-4p1). One year
 * covers incident investigation and a SOC 2 audit window, and the structured
 * logs carry IDs, not personal data. Revisit when the policy is written.
 */
export const LOG_RETENTION = RetentionDays.ONE_YEAR;

/** What `new LogGroup()` sets when given no retention. */
const CDK_DEFAULT_RETENTION = RetentionDays.TWO_YEARS;

/**
 * Applied to the whole app (lib/supply-checkout.ts), so every Lambda function
 * and log group added later gets the same observability settings without
 * remembering to ask for them:
 *
 * - Every log group gets LOG_RETENTION unless it chose another retention.
 *   `new LogGroup()` with no `retention` writes CDK's default of two years
 *   into the template, indistinguishable from asking for two years, so the
 *   aspect treats two years as unset too; so does the log group CDK makes for
 *   each function (the `@aws-cdk/aws-lambda:useCdkManagedLogGroup` flag in
 *   cdk.json makes it). Any other explicit retention wins; a function that
 *   needs one passes its own `logGroup`.
 * - Functions get X-Ray active tracing (with the two X-Ray write permissions,
 *   in a policy of their own), JSON log format, and the environment variables
 *   backend/src/observability reads: the metrics namespace and the
 *   environment name. A function that sets its own tracing mode keeps it.
 */
export class ObservabilityDefaults implements IAspect {
  private readonly config: DeploymentConfig;

  constructor(config: DeploymentConfig) {
    this.config = config;
  }

  visit(node: IConstruct): void {
    if (node instanceof CfnLogGroup && (node.retentionInDays === undefined || node.retentionInDays === CDK_DEFAULT_RETENTION)) {
      node.retentionInDays = LOG_RETENTION;
    }
    if (node instanceof LambdaFunction) this.function(node);
  }

  private function(fn: LambdaFunction): void {
    const cfn = fn.node.defaultChild as CfnFunction;
    fn.addEnvironment(ENV.namespace, METRICS_NAMESPACE);
    fn.addEnvironment(ENV.envName, this.config.envName);
    cfn.loggingConfig ??= { logFormat: "JSON" };
    const managed = fn.node.tryFindChild("LogGroup");
    if (managed instanceof LogGroup) (managed.node.defaultChild as CfnLogGroup).retentionInDays = LOG_RETENTION;

    if (cfn.tracingConfig !== undefined) return;
    cfn.tracingConfig = { mode: "Active" };
    if (!fn.role) return;
    const policy = new Policy(fn, "XRayWrite", {
      statements: [
        new PolicyStatement({
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"],
        }),
      ],
    });
    policy.attachToRole(fn.role);
    Validations.of(policy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "X-Ray PutTraceSegments and PutTelemetryRecords don't support resource-level permissions",
    });
  }
}
