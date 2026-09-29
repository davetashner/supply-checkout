import { fileURLToPath } from "node:url";
import { Duration, Stack } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import { GROUP_WATCH_EVERY_MINUTES, GROUP_WATCH_SILENT_ALARM_MINUTES, INITIAL_GROUP_SNAPSHOT, OPS_ENV, operatorGroupSnapshotParameter, opsResourceNames } from "../../../backend/src/ops/names.js";
import { bundling } from "../stacks/api-stack.js";
import type { AlarmTopics } from "./alarm-topics.js";
import { LOG_RETENTION } from "./defaults.js";
import { business, FIVE_MINUTES } from "./metrics.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

export interface OperatorGroupWatchProps {
  readonly envName: string;
  /** The primary region, where the operator pool is. */
  readonly region: string;
  /** The operator pool's ID (the identity stack's SSM output). */
  readonly userPoolId: string;
  /** The schedule rule's fixed name, under the operator rules' prefix so the rule-tampering rules watch it. */
  readonly ruleName: string;
  readonly topics: AlarmTopics;
}

/**
 * The operator group watch (supply-checkout-3sv.5, ADR 0015), primary region
 * only: a check on the operators group that doesn't depend on CloudTrail
 * reaching EventBridge. In the 2026-09-27 drill, AdminAddUserToGroup and
 * AdminRemoveUserFromGroup were in the trail and matched OperatorPoolChanges'
 * pattern, but never reached the rule ("Operators" in docs/infrastructure.md).
 *
 * - `fn` (backend/src/ops/operator-group-watch-handler.ts) runs every
 *   GROUP_WATCH_EVERY_MINUTES from `schedule`, lists the group
 *   (ListUsersInGroup) and compares each member's `sub` and enabled flag with
 *   what it saved last in `snapshot`, an SSM parameter. Each change counts in
 *   OperatorGroupChanged.
 * - `changed`: P1 when OperatorGroupChanged is above 0 in 5 minutes
 *   ("Operator group changed").
 * - `silent`: P2 when no run has finished (the OperatorGroupMembers gauge) in
 *   GROUP_WATCH_SILENT_ALARM_MINUTES ("Operator group watch silent"): the
 *   schedule disabled or deleted, the function failing or throttled, its
 *   permissions or log group gone. Missing data breaches.
 *
 * The schedule rule's name starts with the operator rules' prefix, so
 * disabling or deleting it, or changing its target, alerts through the
 * rule-tampering rules. Its role may only list the operator pool's users in a
 * group (never change one), and read and write its own parameter.
 */
export class OperatorGroupWatch extends Construct {
  readonly fn: NodejsFunction;
  readonly role: Role;
  readonly snapshot: StringParameter;
  readonly schedule: Rule;
  readonly changed: Alarm;
  readonly silent: Alarm;

  constructor(scope: Construct, id: string, props: OperatorGroupWatchProps) {
    super(scope, id);
    const logGroup = new LogGroup(this, "Logs", { retention: LOG_RETENTION });
    this.snapshot = new StringParameter(this, "Snapshot", {
      parameterName: operatorGroupSnapshotParameter(props.envName),
      // The first run replaces this without alerting; a deploy doesn't change it again
      stringValue: INITIAL_GROUP_SNAPSHOT,
      description: "The operators group as the operator group watch last saw it: each member's sub and whether they're enabled (supply-checkout-3sv.5)",
    });
    const role = (this.role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the operator group watch",
    }));
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    role.addToPolicy(
      new PolicyStatement({
        sid: "ListOperatorGroup",
        actions: ["cognito-idp:ListUsersInGroup"],
        resources: [Stack.of(this).formatArn({ service: "cognito-idp", resource: "userpool", resourceName: props.userPoolId })],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: "OwnSnapshot",
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [this.snapshot.parameterArn],
      }),
    );
    this.fn = new NodejsFunction(this, "Function", {
      functionName: opsResourceNames(props.envName).operatorGroupWatchFunction,
      role,
      logGroup,
      entry: `${BACKEND}src/ops/operator-group-watch.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      description: "Alarms when anyone joins or leaves the operators group, or is disabled or enabled",
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        [OPS_ENV.opsUserPoolId]: props.userPoolId,
        [OPS_ENV.groupSnapshotParameter]: this.snapshot.parameterName,
      },
      bundling,
    });
    this.schedule = new Rule(this, "Schedule", {
      ruleName: props.ruleName,
      description: `Runs the operator group watch every ${GROUP_WATCH_EVERY_MINUTES} minutes (supply-checkout-3sv.5)`,
      schedule: Schedule.rate(Duration.minutes(GROUP_WATCH_EVERY_MINUTES)),
      // The next run is soon, and compares against the same snapshot
      targets: [new LambdaFunction(this.fn, { retryAttempts: 0 })],
    });

    this.changed = new Alarm(this, "Changed", {
      alarmName: `supply-checkout-${props.envName}-p1-operator-group-changed`,
      alarmDescription:
        "P1. Operator group changed: someone joined or left the operators group, or an operator was disabled or enabled, since the operator group watch last looked. The watch's log lists them by sub; CloudTrail's AdminAddUserToGroup, AdminRemoveUserFromGroup, AdminDeleteUser, AdminDisableUser or AdminEnableUser event says who did it. If nobody expected it, follow \"Operators\" in docs/infrastructure.md.",
      metric: business(BusinessMetric.OperatorGroupChanged, props.region, FIVE_MINUTES),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.changed, "P1");

    this.silent = new Alarm(this, "Silent", {
      alarmName: `supply-checkout-${props.envName}-p2-operator-group-watch-silent`,
      alarmDescription: `P2. Operator group watch silent: no run of the operator group watch has finished in ${GROUP_WATCH_SILENT_ALARM_MINUTES} minutes, so "Operator group changed" can't fire. Check its schedule rule is enabled, and its log for the error (a missing permission, the parameter or the pool); follow "Operators" in docs/infrastructure.md.`,
      metric: business(BusinessMetric.OperatorGroupMembers, props.region, Duration.minutes(GROUP_WATCH_SILENT_ALARM_MINUTES), "SampleCount"),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    });
    props.topics.notify(this.silent, "P2");
  }
}
