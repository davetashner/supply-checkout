import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { COMMITTING_IMPORTS_PARTITION, GSI1, STUCK_IMPORT_ATTRIBUTES } from "../../../backend/src/data/schema.js";
import { CHECK_EVERY_MINUTES, OPS_ENV, opsResourceNames } from "../../../backend/src/ops/names.js";
import { bundling } from "../stacks/api-stack.js";
import { LOG_RETENTION } from "./defaults.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

export interface OpsChecksProps {
  readonly envName: string;
  /** The app table's name (a global table has the same name in every region). */
  readonly tableName: string;
}

/**
 * Scheduled checks that turn state no AWS metric shows into business-metric
 * gauges for the journey alarms (backend/src/ops), in the primary region
 * only: the table is global, so one region's index sees every team's imports,
 * and SES sends from the primary region.
 *
 * - `stuckImports`: counts inventory imports still committing an hour after
 *   they started (StuckImports, "Imports stuck"). Its role may only Query
 *   GSI1's committing-imports partition, naming and reading only the keys and
 *   progress (dynamodb:LeadingKeys, dynamodb:Attributes, dynamodb:Select), so
 *   it can't read any team's data. A scheduled check was chosen over counting
 *   starts and finishes because an import can be retried and finished hours
 *   later, which counts can't tell from a stuck one; the index lists exactly
 *   the jobs not finished, and the Query is of a partition that's normally
 *   empty.
 * - `emailQuota`: SES's 24-hour sends against its quota
 *   (EmailQuotaUsedPercent, "Near the sending limit"). ses:GetAccount only.
 *
 * Each runs every CHECK_EVERY_MINUTES from an EventBridge rule, with its own
 * log group and a role that writes only to it. A failed run shows in the
 * Lambda errors alarm; the gauge alarms treat missing data as not breaching.
 */
export class OpsChecks extends Construct {
  readonly stuckImports: NodejsFunction;
  readonly emailQuota: NodejsFunction;

  constructor(scope: Construct, id: string, props: OpsChecksProps) {
    super(scope, id);
    const names = opsResourceNames(props.envName);
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: props.tableName });

    this.stuckImports = this.check("StuckImports", "stuck-imports", {
      functionName: names.stuckImportsFunction,
      description: "Counts inventory imports still committing an hour after they started",
      environment: { [OPS_ENV.tableName]: props.tableName },
    });
    this.stuckImports.addToRolePolicy(
      new PolicyStatement({
        sid: "CommittingImportsOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI1}`],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [COMMITTING_IMPORTS_PARTITION],
            "dynamodb:Attributes": [...STUCK_IMPORT_ATTRIBUTES],
          },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.stuckImports.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [StringParameter.valueForStringParameter(this, `/supply-checkout/${props.envName}/data/table-key-arn`)],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );

    this.emailQuota = this.check("EmailQuota", "email-quota", {
      functionName: names.emailQuotaFunction,
      description: "Sends the share of the SES 24-hour sending quota used",
      environment: {},
    });
    this.emailQuota.addToRolePolicy(new PolicyStatement({ sid: "ReadSendQuota", actions: ["ses:GetAccount"], resources: ["*"] }));
    Validations.of(this.emailQuota.role as Role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "ses:GetAccount reads the account's sending quota and has no resource-level permissions",
    });
  }

  /** A function from backend/src/ops/<name>.ts, run on the schedule. */
  private check(id: string, name: string, props: { functionName: string; description: string; environment: Record<string, string> }): NodejsFunction {
    const logGroup = new LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION });
    const role = new Role(this, `${id}Role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the ${name} check`,
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    const fn = new NodejsFunction(this, id, {
      functionName: props.functionName,
      role,
      logGroup,
      entry: `${BACKEND}src/ops/${name}.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: props.description,
      environment: { NODE_OPTIONS: "--enable-source-maps", ...props.environment },
      bundling,
    });
    new Rule(this, `${id}Schedule`, {
      description: `Runs the ${name} check every ${CHECK_EVERY_MINUTES} minutes`,
      schedule: Schedule.rate(Duration.minutes(CHECK_EVERY_MINUTES)),
      // The next run is minutes away; a retry would only double the gauge
      targets: [new LambdaFunction(fn, { retryAttempts: 0 })],
    });
    return fn;
  }
}
