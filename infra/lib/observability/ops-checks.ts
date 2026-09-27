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
import { CLOSED_TEAMS_PARTITION, COMMITTING_IMPORTS_PARTITION, GSI1, STUCK_IMPORT_ATTRIBUTES, TEAM_PURGE_ATTRIBUTES } from "../../../backend/src/data/schema.js";
import { CHECK_EVERY_MINUTES, OPS_ENV, opsResourceNames, PURGE_BUDGET_MS, PURGE_EVERY_HOURS } from "../../../backend/src/ops/names.js";
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
 * - `teamPurge` isn't a check: every PURGE_EVERY_HOURS it deletes the closed
 *   teams whose read-only period has ended (backend/src/ops/team-purge-handler.ts).
 *   It may Query only GSI1's closed-teams partition there, and on the table
 *   only GetItem, Query and DeleteItem on `TEAM#`, `USER#` and `STRIPE#`
 *   partitions, naming only TEAM_PURGE_ATTRIBUTES (keys, the closure fields,
 *   the Stripe customer and link): it deletes whole items without reading
 *   documents, emails or names. The partitions are wildcards because it acts
 *   on whichever teams are due, which only the table's own index names; no
 *   request reaches it.
 *
 * The checks run every CHECK_EVERY_MINUTES from an EventBridge rule, each with its own
 * log group and a role that writes only to it. A failed run shows in the
 * Lambda errors alarm; the gauge alarms treat missing data as not breaching.
 */
export class OpsChecks extends Construct {
  readonly stuckImports: NodejsFunction;
  readonly emailQuota: NodejsFunction;
  readonly teamPurge: NodejsFunction;

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
    const tableKey = StringParameter.valueForStringParameter(this, `/supply-checkout/${props.envName}/data/table-key-arn`);
    this.stuckImports.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKey],
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

    this.teamPurge = this.check(
      "TeamPurge",
      "team-purge",
      {
        functionName: names.teamPurgeFunction,
        description: "Deletes closed teams once their 30-day read-only period ends",
        environment: { [OPS_ENV.tableName]: props.tableName },
      },
      { every: Duration.hours(PURGE_EVERY_HOURS), timeout: Duration.millis(PURGE_BUDGET_MS + 60_000) },
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "ClosedTeamsIndexOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI1}`],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [CLOSED_TEAMS_PARTITION],
            "dynamodb:Attributes": [...TEAM_PURGE_ATTRIBUTES],
          },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "DeleteClosedTeamItems",
        // GetItem reads a team's closure fields, Query its partition's keys
        // (and nothing else, dynamodb:Attributes), DeleteItem removes each item
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*", "USER#*", "STRIPE#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TEAM_PURGE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE", "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    Validations.of(this.teamPurge.role as Role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "The purge deletes whichever closed teams are due, named only by the table's own closed-teams index: the TEAM#, USER# and STRIPE# partition wildcards are in dynamodb:LeadingKeys, with dynamodb:Attributes limiting it to keys and closure fields",
    });
  }

  /** A function from backend/src/ops/<name>.ts, run on the schedule (every CHECK_EVERY_MINUTES unless `every` says). */
  private check(
    id: string,
    name: string,
    props: { functionName: string; description: string; environment: Record<string, string> },
    options: { every?: Duration; timeout?: Duration } = {},
  ): NodejsFunction {
    const every = options.every ?? Duration.minutes(CHECK_EVERY_MINUTES);
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
      timeout: options.timeout ?? Duration.seconds(30),
      description: props.description,
      environment: { NODE_OPTIONS: "--enable-source-maps", ...props.environment },
      bundling,
    });
    new Rule(this, `${id}Schedule`, {
      description: `Runs the ${name} function every ${every.toHumanString()}`,
      schedule: Schedule.rate(every),
      // The next run is soon; a retry would only double the gauge (or the purge's work)
      targets: [new LambdaFunction(fn, { retryAttempts: 0 })],
    });
    return fn;
  }
}
