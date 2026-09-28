import { Arn, Stack, Validations } from "aws-cdk-lib";
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment } from "aws-cdk-lib/aws-cognito";
import { FederatedPrincipal, PolicyDocument, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { CfnAppMonitor } from "aws-cdk-lib/aws-rum";
import { Construct } from "constructs";

/**
 * What the app monitor collects: JavaScript errors and page performance
 * (navigation and resource timing, web vitals). No "http" (it would record the
 * API's URLs, which carry team and document IDs), no "interaction" (clicks on
 * elements) and no "replay".
 */
export const RUM_TELEMETRIES = ["errors", "performance"] as const;

/**
 * Every session is recorded. At MVP traffic that's a few dollars a month
 * ($1 per 100,000 events, at most 200 events a session); lower it when traffic
 * grows. Errors are rare, so sampling would hide most of them.
 */
export const RUM_SESSION_SAMPLE_RATE = 1;

export const rumAppMonitorName = (envName: string) => `supply-checkout-${envName}-app`;

export interface RealUserMonitoringProps {
  readonly envName: string;
  /** The host the app is served from (app.<env domain>); RUM drops events from any other. */
  readonly appHost: string;
}

/**
 * CloudWatch RUM for the web app (supply-checkout-al0): an app monitor, and the
 * Cognito identity pool whose guest (unauthenticated) identities the browser
 * uses to send it events.
 *
 * - The pool has no identity providers and only the enhanced flow (no classic
 *   flow, so no one can assume its role with their own AssumeRoleWithWebIdentity
 *   request). Cognito scopes guest sessions down further with its own session
 *   policies.
 * - Its guest role trusts only this pool's unauthenticated identities
 *   (`aud` and `amr`), and may only call rum:PutRumEvents on this app monitor.
 * - The monitor sets no cookies (so no user ID or session carries over
 *   between visits), has X-Ray off and custom events off, and keeps its data
 *   in RUM (30 days) rather than CloudWatch Logs.
 *
 * The browser gets the monitor's ID, the pool's ID and the region from
 * config.json, which scripts/publish-web.mjs writes from the SSM parameters
 * the web stack publishes.
 */
export class RealUserMonitoring extends Construct {
  readonly appMonitor: CfnAppMonitor;
  readonly identityPool: CfnIdentityPool;
  readonly guestRole: Role;

  constructor(scope: Construct, id: string, props: RealUserMonitoringProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const name = rumAppMonitorName(props.envName);

    this.identityPool = new CfnIdentityPool(this, "IdentityPool", {
      identityPoolName: `supply-checkout-${props.envName}-rum`,
      allowUnauthenticatedIdentities: true,
      allowClassicFlow: false,
    });
    Validations.of(this.identityPool).acknowledge({
      id: "AwsSolutions-COG7",
      reason:
        "The browser sends RUM events before anyone signs in, so it needs guest identities. Their role can only call rum:PutRumEvents on this app monitor.",
    });

    const appMonitorArn = Arn.format({ service: "rum", resource: "appmonitor", resourceName: name }, stack);
    this.guestRole = new Role(this, "GuestRole", {
      roleName: `supply-checkout-${props.envName}-rum-guest`,
      description: "Guest identities of the RUM identity pool: send events to the web app's RUM app monitor only",
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: { "cognito-identity.amazonaws.com:aud": this.identityPool.ref },
          "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "unauthenticated" },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      inlinePolicies: {
        PutRumEvents: new PolicyDocument({
          statements: [new PolicyStatement({ actions: ["rum:PutRumEvents"], resources: [appMonitorArn] })],
        }),
      },
    });

    new CfnIdentityPoolRoleAttachment(this, "Roles", {
      identityPoolId: this.identityPool.ref,
      roles: { unauthenticated: this.guestRole.roleArn },
    });

    this.appMonitor = new CfnAppMonitor(this, "AppMonitor", {
      name,
      domain: props.appHost,
      cwLogEnabled: false,
      appMonitorConfiguration: {
        allowCookies: false,
        enableXRay: false,
        sessionSampleRate: RUM_SESSION_SAMPLE_RATE,
        telemetries: [...RUM_TELEMETRIES],
        identityPoolId: this.identityPool.ref,
        guestRoleArn: this.guestRole.roleArn,
      },
      customEvents: { status: "DISABLED" },
    });
  }
}
