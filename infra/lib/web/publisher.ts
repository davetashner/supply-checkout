import { Aws, Duration, Validations } from "aws-cdk-lib";
import type { Distribution, Function as CloudFrontFunction, KeyValueStore } from "aws-cdk-lib/aws-cloudfront";
import { AccountRootPrincipal, Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { webPublisherRoleName } from "../config.js";
import { webBucketName } from "../stacks/data-stack.js";
import { githubDeployRoleName } from "../stacks/github-deploy-stack.js";

/**
 * The SSM parameters scripts/publish-web.mjs reads, under /supply-checkout/<env>/: the web
 * stack's outputs (bucket, store, router, distribution, RUM) and the app's config.json values
 * from the api, identity and realtime stacks (publish-web.mjs configParameterNames; web.test.ts
 * checks this covers them).
 */
export const PUBLISHER_PARAMETERS = [
  "web/*",
  "api/url",
  "identity/auth-url",
  "identity/web-client-id",
  "realtime/websocket-url",
  "realtime/host",
] as const;

export interface WebPublisherProps {
  readonly envName: string;
  /** The releases bucket (the primary region's data stack), and its region. */
  readonly bucket: IBucket;
  readonly bucketRegion: string;
  readonly liveVersions: KeyValueStore;
  readonly router: CloudFrontFunction;
  readonly distribution: Distribution;
}

/**
 * What the deploy workflow publishes the web app and demo with (supply-checkout-pbp.28):
 * `publish-web.mjs publish`, `live` and `check-router`. CDK's bootstrap roles, the only roles
 * the GitHub deploy role may otherwise assume, can't do it: the file-publishing role writes only
 * to CDK's staging bucket, the deploy role only drives CloudFormation, and the lookup role only
 * reads (no s3:PutObject, KeyValueStore PutKey or cloudfront:TestFunction). So this role may:
 *
 * - read the parameters publish-web reads (PUBLISHER_PARAMETERS), in this stack's region;
 * - list the releases bucket under releases/, and read and write objects there (a release is
 *   uploaded once; versioning keeps any overwritten object for 30 days);
 * - describe, list, read and put keys in the live-version KeyValueStore (making a release live,
 *   or rolling back);
 * - read the distribution's config (its aliases) and describe and test the router function
 *   (check-router). Nothing else: no delete, no invalidation, no change to the distribution.
 *
 * Only the GitHub deploy role may assume it (the account as principal, with aws:PrincipalArn
 * naming that role, so the trust doesn't need the role to exist yet). The owner publishes with
 * their own SSO role, as before.
 */
export class WebPublisher extends Construct {
  readonly role: Role;

  constructor(scope: Construct, id: string, props: WebPublisherProps) {
    super(scope, id);
    const deployRole = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${githubDeployRoleName(props.envName)}`;
    this.role = new Role(this, "Role", {
      roleName: webPublisherRoleName(props.envName),
      description: `Publishes the web app and demo from the deploy workflow (assumed by ${githubDeployRoleName(props.envName)} only)`,
      assumedBy: new AccountRootPrincipal().withConditions({ ArnEquals: { "aws:PrincipalArn": deployRole } }),
      maxSessionDuration: Duration.hours(1),
    });
    // In this stack's region (GLOBAL_SERVICES_REGION), where publish-web reads them. Phase 2
    // (ADR 0010): if the primary region isn't this one, the api, identity and realtime stacks
    // publish these in theirs, so either publish them here too or point these ARNs there.
    const parameter = (name: string) =>
      `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/supply-checkout/${props.envName}/${name}`;
    this.role.addToPolicy(new PolicyStatement({
      sid: "ReadPublishParameters",
      effect: Effect.ALLOW,
      actions: ["ssm:GetParameters", "ssm:GetParameter"],
      resources: PUBLISHER_PARAMETERS.map(parameter),
    }));
    this.role.addToPolicy(new PolicyStatement({
      sid: "ListReleases",
      effect: Effect.ALLOW,
      actions: ["s3:ListBucket"],
      resources: [props.bucket.bucketArn],
      conditions: { StringLike: { "s3:prefix": ["releases/*"] } },
    }));
    this.role.addToPolicy(new PolicyStatement({
      sid: "UploadReleases",
      effect: Effect.ALLOW,
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [props.bucket.arnForObjects("releases/*")],
    }));
    this.role.addToPolicy(new PolicyStatement({
      sid: "SwitchLiveVersions",
      effect: Effect.ALLOW,
      actions: [
        "cloudfront-keyvaluestore:DescribeKeyValueStore",
        "cloudfront-keyvaluestore:ListKeys",
        "cloudfront-keyvaluestore:GetKey",
        "cloudfront-keyvaluestore:PutKey",
      ],
      resources: [props.liveVersions.keyValueStoreArn],
    }));
    this.role.addToPolicy(new PolicyStatement({
      sid: "CheckRouter",
      effect: Effect.ALLOW,
      actions: ["cloudfront:DescribeFunction", "cloudfront:TestFunction"],
      resources: [props.router.functionArn],
    }));
    this.role.addToPolicy(new PolicyStatement({
      sid: "ReadDistributionAliases",
      effect: Effect.ALLOW,
      actions: ["cloudfront:GetDistributionConfig"],
      resources: [`arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${props.distribution.distributionId}`],
    }));
    const policy = this.role.node.findChild("DefaultPolicy");
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:<AWS::Region>:<AWS::AccountId>:parameter/supply-checkout/${props.envName}/web/*]`,
      reason: "The web stack's own output parameters, which publish-web reads by name; nothing else under that prefix.",
    });
    Validations.of(policy).acknowledge({
      // The imported bucket's ARN, as cdk-nag prints it
      id: `AwsSolutions-IAM5[Resource::arn:aws:s3:::${webBucketName(props.envName, props.bucketRegion, "<AWS::AccountId>")}/releases/*]`,
      reason: "Each release is its own folder, releases/<version>/, named at publish time; only that prefix, and no delete.",
    });
  }
}
