import { Annotations, Aws, CfnOutput, Duration, RemovalPolicy, Validations } from "aws-cdk-lib";
import { Effect, PolicyStatement, Role, ServicePrincipal, WebIdentityPrincipal } from "aws-cdk-lib/aws-iam";
import { MxRecord } from "aws-cdk-lib/aws-route53";
import { BlockPublicAccess, Bucket, BucketEncryption, type LifecycleRule, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { EmailIdentity, type Identity, type IReceiptRuleAction, ReceiptRuleSet, TlsPolicy } from "aws-cdk-lib/aws-ses";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { type DeploymentConfig, GITHUB_JOURNEYS_ENVIRONMENT, type GithubRepository } from "../config.js";
import { importZone } from "../domain.js";
import {
  hasJourneys,
  JOURNEY_ACCESS_LOG_PREFIXES,
  JOURNEY_MAIL_INBOX_PREFIX,
  JOURNEY_MAIL_LABEL,
  JOURNEY_MAIL_RETENTION_DAYS,
  JOURNEY_RECEIPT_RULE_NAME,
  JOURNEY_RUNS_PREFIX,
  JOURNEY_RUNS_RETENTION_DAYS,
  journeyMailBucketName,
  journeyMailDomain,
  journeyReceiptRuleSetName,
  journeyResultsBucketName,
  journeysRoleName,
} from "../journeys.js";
import { SupplyCheckoutStack } from "./base-stack.js";
import { logsBucketName } from "./data-stack.js";
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_URL, githubDeploySubject } from "./github-deploy-stack.js";

const ISSUER = GITHUB_OIDC_URL.replace(/^https:\/\//, "");

/** SSM parameters the journeys stack publishes, in its own region. */
export const journeysOutputParameters = (envName: string) => {
  const prefix = `/supply-checkout/${envName}/journeys`;
  return {
    mailDomain: `${prefix}/mail-domain`,
    mailBucketName: `${prefix}/mail-bucket-name`,
    resultsBucketName: `${prefix}/results-bucket-name`,
    roleArn: `${prefix}/role-arn`,
  };
};

/**
 * What the prod journey tests need in AWS (supply-checkout-o60.3,
 * docs/journey-tests-plan.md, "The test mailbox" and "Credentials and
 * secrets"), in the primary region:
 *
 * - **The test mail subdomain**, `e2e.<env domain>`: an MX record to SES
 *   inbound in this region, and an SES domain identity with Easy DKIM (its
 *   CNAMEs in the zone), so Cognito's codes and the app's mail can reach it
 *   while SES is in the sandbox (supply-checkout-3sv.18).
 * - **An SES receipt rule set** with one rule: recipient the subdomain only
 *   (not its subdomains, not any other domain), TLS required, spam and virus
 *   scanning on (the verdicts go into the stored message's headers), one
 *   action: write the message to the mail bucket under `inbox/`. CloudFormation
 *   can't make a rule set active, and only one is active per account and region,
 *   so the owner activates it by hand (docs/infrastructure.md, "Journey tests").
 * - **The mail bucket**: private (public access blocked, ACLs off, TLS only),
 *   SSE-S3, `inbox/` expires after a day and everything else (`runs/`, the
 *   harness's records of each run's throwaway accounts) after 30. Only SES may
 *   write `inbox/`, and only for this rule (`aws:SourceArn`).
 * - **The results bucket**: the same protections, 30 days. Playwright traces
 *   and videos go here, never to Actions artifacts, which are public in this
 *   repository.
 * - **The journeys role**, `supply-checkout-<env>-journeys`: trusted only by a
 *   GitHub Actions job in this repository's `production-journeys` environment
 *   (GitHub's immutable subject, audience `sts.amazonaws.com`, StringEquals),
 *   for an hour at most. S3 only: list the mail bucket under `inbox/` and
 *   `runs/`, read and delete `inbox/` messages, read and write `runs/`
 *   records, and write traces under `runs/` in the results bucket. No KMS (both
 *   buckets use SSE-S3), Cognito, DynamoDB, Secrets Manager, SES, CloudWatch,
 *   iam:PassRole or sts:AssumeRole.
 *
 * Neither bucket is versioned, unlike every other bucket that holds data here
 * (supply-checkout-8x1): they hold throwaway test mail and test traces, and a
 * deleted sign-in code must be gone, not kept as an old version.
 *
 * Like the GitHub deploy stack, this is a separate CDK app (bin/journeys.ts):
 * the release pipeline never deploys it, so the role can't exist before the
 * owner has set up the `production-journeys` environment on GitHub. GitHub
 * makes an unprotected environment the first time a job names one that
 * doesn't exist, and any branch's job could then assume the role. Prod only,
 * since the trust names that one environment.
 */
export class JourneysStack extends SupplyCheckoutStack {
  readonly mailDomain: string;
  readonly mailBucket: Bucket;
  readonly resultsBucket: Bucket;
  readonly ruleSet: ReceiptRuleSet;
  readonly emailIdentity: EmailIdentity;
  readonly role: Role;

  constructor(scope: Construct, config: DeploymentConfig, region: string, repository: GithubRepository) {
    super(scope, { config, region, component: "journeys", layer: "stateful" });
    if (region !== config.primaryRegion) throw new Error("The journeys stack is in the primary region only (SES and IAM)");
    if (!hasJourneys(config)) throw new Error(`The journeys stack is for prod only: its role's trust names the ${GITHUB_JOURNEYS_ENVIRONMENT} GitHub environment (got envName "${config.envName}")`);

    this.mailDomain = journeyMailDomain(config);
    const zone = importZone(this, config);
    const logs = Bucket.fromBucketName(this, "LogsBucket", logsBucketName(config.envName, region));

    const bucket = (id: string, bucketName: string, logPrefix: string, lifecycleRules: LifecycleRule[]) => {
      const b = new Bucket(this, id, {
        bucketName,
        encryption: BucketEncryption.S3_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
        enforceSSL: true,
        versioned: false,
        lifecycleRules,
        serverAccessLogsBucket: logs,
        serverAccessLogsPrefix: logPrefix,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      Annotations.of(b).acknowledgeWarning(
        "@aws-cdk/aws-s3:accessLogsPolicyNotAdded",
        `The logs bucket is the data stack's: its policy grants S3 log delivery from this bucket under ${logPrefix} (JourneyMailBucketAccessLogs and JourneyResultsBucketAccessLogs in data-stack.ts).`,
      );
      return b;
    };

    // Every message SES receives for the subdomain lands under inbox/ and is
    // gone a day later; run records under runs/ (and anything else) after 30.
    // The shorter of two matching expirations wins.
    this.mailBucket = bucket("MailBucket", journeyMailBucketName(config.envName, region), JOURNEY_ACCESS_LOG_PREFIXES.mail, [
      { id: "Inbox", prefix: JOURNEY_MAIL_INBOX_PREFIX, expiration: Duration.days(JOURNEY_MAIL_RETENTION_DAYS) },
      { id: "Everything", expiration: Duration.days(JOURNEY_RUNS_RETENTION_DAYS), abortIncompleteMultipartUploadAfter: Duration.days(1) },
    ]);
    this.resultsBucket = bucket("ResultsBucket", journeyResultsBucketName(config.envName, region), JOURNEY_ACCESS_LOG_PREFIXES.results, [
      { id: "Everything", expiration: Duration.days(JOURNEY_RUNS_RETENTION_DAYS), abortIncompleteMultipartUploadAfter: Duration.days(1) },
    ]);

    // The subdomain's mail goes to SES inbound in this region
    new MxRecord(this, "TestMailMx", {
      zone,
      recordName: JOURNEY_MAIL_LABEL,
      values: [{ priority: 10, hostName: `inbound-smtp.${region}.amazonaws.com` }],
    });

    // Verified with Easy DKIM, its three CNAMEs added to the zone (CDK adds
    // them for an identity with a hosted zone; the identity's name is the
    // subdomain, not the zone's apex). It sends nothing: the app sends only
    // from noreply@ at the apex (lib/email.ts).
    const identity: Identity = { value: this.mailDomain, hostedZone: zone };
    this.emailIdentity = new EmailIdentity(this, "TestMailIdentity", { identity });

    // SES writes each message under inbox/, for this account's rule only. The
    // rule's ARN is built from its fixed names, so the policy can exist before
    // the rule (SES writes a test object when the rule is created).
    const ruleSetName = journeyReceiptRuleSetName(config.envName);
    const ruleArn = `arn:${Aws.PARTITION}:ses:${Aws.REGION}:${Aws.ACCOUNT_ID}:receipt-rule-set/${ruleSetName}:receipt-rule/${JOURNEY_RECEIPT_RULE_NAME}`;
    this.mailBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "SesWritesTestMail",
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("ses.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [this.mailBucket.arnForObjects(`${JOURNEY_MAIL_INBOX_PREFIX}*`)],
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID, "aws:SourceArn": ruleArn } },
      }),
    );
    // The S3 action, without CDK's (aws-ses-actions S3), whose bucket grant
    // checks only the account, not the rule
    const writeToMailBucket: IReceiptRuleAction = {
      bind: () => ({ s3Action: { bucketName: this.mailBucket.bucketName, objectKeyPrefix: JOURNEY_MAIL_INBOX_PREFIX } }),
    };
    this.ruleSet = new ReceiptRuleSet(this, "TestMailRuleSet", {
      receiptRuleSetName: ruleSetName,
      rules: [
        {
          receiptRuleName: JOURNEY_RECEIPT_RULE_NAME,
          // The subdomain exactly: SES matches `@e2e.<domain>`, and would match its
          // subdomains only for a recipient starting with a dot
          recipients: [this.mailDomain],
          enabled: true,
          scanEnabled: true,
          tlsPolicy: TlsPolicy.REQUIRE,
          actions: [writeToMailBucket],
        },
      ],
    });
    const rule = this.ruleSet.node.findChild("Rule0");
    if (this.mailBucket.policy) rule.node.addDependency(this.mailBucket.policy);

    // GitHub's OIDC provider is the GitHub deploy stack's (one per account
    // for GitHub's URL); its ARN is fixed by the URL.
    const providerArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:oidc-provider/${ISSUER}`;
    this.role = new Role(this, "JourneysRole", {
      roleName: journeysRoleName(config.envName),
      description: `Prod journey tests from ${repository.name} (owner ID ${repository.ownerId}, repository ID ${repository.repositoryId}), environment ${GITHUB_JOURNEYS_ENVIRONMENT} only: the test mailbox and results buckets`,
      assumedBy: new WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${ISSUER}:sub`]: githubDeploySubject(repository, GITHUB_JOURNEYS_ENVIRONMENT),
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });

    const inbox = `${JOURNEY_MAIL_INBOX_PREFIX}*`;
    const runs = `${JOURNEY_RUNS_PREFIX}*`;
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "ListTestMailAndRunRecords",
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [this.mailBucket.bucketArn],
        // A listing must name one of the two prefixes; one without a prefix is refused
        conditions: { StringLike: { "s3:prefix": [inbox, runs] } },
      }),
    );
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "ReadAndDeleteTestMail",
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:DeleteObject"],
        resources: [this.mailBucket.arnForObjects(inbox)],
      }),
    );
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "ReadAndWriteRunRecords",
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [this.mailBucket.arnForObjects(runs)],
      }),
    );
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "UploadTraces",
        effect: Effect.ALLOW,
        actions: ["s3:PutObject"],
        resources: [this.resultsBucket.arnForObjects(runs)],
      }),
    );
    const defaultPolicy = this.role.node.findChild("DefaultPolicy");
    const objectsReason = (what: string) =>
      `${what}. The harness names objects by run ID and message ID, unknown until the run, so the resource is a prefix wildcard in one bucket; no action wildcard.`;
    Validations.of(defaultPolicy).acknowledge(
      { id: `AwsSolutions-IAM5[Resource::<${this.logicalId(this.mailBucket)}.Arn>/${inbox}]`, reason: objectsReason("Read and delete the test mail SES writes under inbox/") },
      { id: `AwsSolutions-IAM5[Resource::<${this.logicalId(this.mailBucket)}.Arn>/${runs}]`, reason: objectsReason("Read and write the harness's run records under runs/") },
      { id: `AwsSolutions-IAM5[Resource::<${this.logicalId(this.resultsBucket)}.Arn>/${runs}]`, reason: objectsReason("Upload a run's traces under runs/") },
    );

    const params = journeysOutputParameters(config.envName);
    new StringParameter(this, "MailDomainParam", { parameterName: params.mailDomain, stringValue: this.mailDomain, description: "The journey tests' mail subdomain" });
    new StringParameter(this, "MailBucketParam", { parameterName: params.mailBucketName, stringValue: this.mailBucket.bucketName, description: "The journey tests' mail bucket" });
    new StringParameter(this, "ResultsBucketParam", { parameterName: params.resultsBucketName, stringValue: this.resultsBucket.bucketName, description: "The journey tests' results bucket" });
    new StringParameter(this, "RoleArnParam", { parameterName: params.roleArn, stringValue: this.role.roleArn, description: "The role the journey tests assume" });

    new CfnOutput(this, "JourneysRoleArn", { value: this.role.roleArn, description: "The role the journeys job assumes (the production-journeys environment's JOURNEYS_AWS_ROLE_ARN)" });
    new CfnOutput(this, "MailBucketName", { value: this.mailBucket.bucketName, description: "Where SES writes the test subdomain's mail, under inbox/" });
    new CfnOutput(this, "ResultsBucketName", { value: this.resultsBucket.bucketName, description: "Where the journeys job uploads traces, under runs/" });
    new CfnOutput(this, "ReceiptRuleSetName", { value: ruleSetName, description: "Activate it by hand: aws ses set-active-receipt-rule-set (docs/infrastructure.md, Journey tests)" });
  }

  private logicalId(bucket: Bucket): string {
    return this.getLogicalId(bucket.node.defaultChild as never);
  }
}
