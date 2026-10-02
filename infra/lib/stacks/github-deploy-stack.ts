import { Aws, CfnOutput, DefaultStackSynthesizer, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Effect, OidcProviderNative, PolicyStatement, Role, WebIdentityPrincipal } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { type DeploymentConfig, GITHUB_DEPLOY_ENVIRONMENT, GITHUB_DEPLOY_ENVIRONMENTS, type GithubRepository, GLOBAL_SERVICES_REGION, webPublisherRoleName } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/** GitHub Actions' OIDC issuer. */
export const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
/** The audience aws-actions/configure-aws-credentials asks GitHub for. */
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

const ISSUER = GITHUB_OIDC_URL.replace(/^https:\/\//, "");

/** The deploy role's fixed name, so a workflow can build its ARN from the account ID. */
export const githubDeployRoleName = (envName: string) => `supply-checkout-${envName}-github-deploy`;

/**
 * The `sub` claim of a GitHub OIDC token for a job in one of `repository`'s
 * environments (production by default), with GitHub's immutable subjects (the
 * default for repositories created after 2026-07-15, this one included):
 * `repo:<owner>@<owner ID>/<name>@<repository ID>:environment:<environment>`.
 * The name and IDs are validated in lib/config.ts, and the environments are
 * the constants there, so no `:`, `@`, `/` or wildcard can come from them.
 */
export const githubDeploySubject = (repository: GithubRepository, environment: string = GITHUB_DEPLOY_ENVIRONMENT) => {
  const [owner, name] = repository.name.split("/");
  return `repo:${owner}@${repository.ownerId}/${name}@${repository.repositoryId}:environment:${environment}`;
};

/** The CDK bootstrap roles a `cdk deploy` (and `cdk diff`) assumes, by their bootstrap template names. */
/** CDK's rule for a bootstrap qualifier (`cdk bootstrap --qualifier`). */
const BOOTSTRAP_QUALIFIER_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;

const BOOTSTRAP_ROLES = ["deploy", "file-publishing", "image-publishing", "lookup"] as const;

/**
 * GitHub Actions' way into the account (supply-checkout-5ik, ADR 0012): an IAM
 * OIDC provider for GitHub's token issuer and one deploy role. No access keys
 * are stored anywhere; a workflow job exchanges its GitHub OIDC token for
 * the role's short-lived credentials.
 *
 * - The role trusts only tokens with audience `sts.amazonaws.com` and subject
 *   `repo:<owner>@<owner ID>/<name>@<repository ID>:environment:production`
 *   or `...:environment:production-stateful`, exactly (StringEquals): a job
 *   in this repository that runs in the `production` GitHub environment, or
 *   in `production-stateful`, where the deploy workflow's stateful stacks job
 *   runs behind an approval of its own (supply-checkout-pbp.27). That's GitHub's immutable subject
 *   (supply-checkout-pbp.23): with the IDs in it, a new account or
 *   repository that takes over a freed name doesn't match. A rename changes
 *   the subject and fails closed until the stack is deployed with the new
 *   name; a transfer changes the owner ID too. A job without that
 *   environment, a pull request, or another repository gets a different
 *   subject and is refused. The environment's
 *   protection rules on GitHub (required reviewers, which branches and tags
 *   may deploy) decide which jobs get that subject.
 * - Its permissions: assume this account's CDK bootstrap roles (deploy, file
 *   publishing, image publishing, lookup) in the deployed regions and
 *   GLOBAL_SERVICES_REGION, and the web stack's publisher role
 *   (supply-checkout-pbp.28). Everything a deploy changes is done by
 *   CloudFormation through the bootstrap roles, as when the owner deploys
 *   from a laptop; the publisher role uploads web releases and switches the
 *   live version. No managed policy, no wildcard.
 * - It is NOT part of the main app: the owner deploys it once, from
 *   bin/github-deploy.ts (`npm run deploy:github-deploy`), so a pipeline
 *   running `cdk deploy --all` never changes it by accident. It is not a
 *   security boundary: a job with this role can assume the bootstrap deploy
 *   role and, through CloudFormation's execution role (AdministratorAccess
 *   by default), change this stack or its trust too. The real boundary is
 *   the production environment's rules on GitHub, plus a narrower execution
 *   policy (supply-checkout-3x3.2). Termination protection and RETAIN keep a
 *   stray delete from locking the pipeline out; RETAIN also means deleting
 *   the stack doesn't revoke access.
 * - Prod only: the trust always names the `production` GitHub environment.
 */
export class GithubDeployStack extends SupplyCheckoutStack {
  readonly provider: OidcProviderNative;
  readonly role: Role;

  constructor(scope: Construct, config: DeploymentConfig, region: string, repository: GithubRepository) {
    // Stateful: termination protection. IAM is global, so one stack, in the primary region.
    super(scope, { config, region, component: "github-deploy", layer: "stateful" });
    if (region !== config.primaryRegion) throw new Error("The GitHub deploy stack is in the primary region only (IAM is global)");
    // The trust always names the `production` GitHub environment, so another
    // environment's role would be assumable by prod's deploy jobs
    if (config.envName !== "prod") throw new Error(`The GitHub deploy stack is for prod only: its trust names the ${GITHUB_DEPLOY_ENVIRONMENT} GitHub environment (got envName "${config.envName}")`);

    this.provider = new OidcProviderNative(this, "GithubOidc", {
      url: GITHUB_OIDC_URL,
      clientIds: [GITHUB_OIDC_AUDIENCE],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.role = new Role(this, "DeployRole", {
      roleName: githubDeployRoleName(config.envName),
      description: `GitHub Actions deploys from ${repository.name} (owner ID ${repository.ownerId}, repository ID ${repository.repositoryId}), environments ${GITHUB_DEPLOY_ENVIRONMENTS.join(" and ")} only`,
      assumedBy: new WebIdentityPrincipal(this.provider.oidcProviderArn, {
        StringEquals: {
          [`${ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
          // StringEquals with a list matches any one of them, exactly
          [`${ISSUER}:sub`]: GITHUB_DEPLOY_ENVIRONMENTS.map((environment) => githubDeploySubject(repository, environment)),
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    this.role.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const qualifier = String(this.node.tryGetContext("@aws-cdk/core:bootstrapQualifier") ?? DefaultStackSynthesizer.DEFAULT_QUALIFIER);
    // CDK's own rule for a qualifier. It's part of the role ARNs below, so a
    // `*` or `?` would widen the grant to other roles.
    if (!BOOTSTRAP_QUALIFIER_PATTERN.test(qualifier)) throw new Error(`The CDK bootstrap qualifier must be 1-10 letters, digits, _ or - (got "${qualifier}")`);
    const regions = [...new Set([...config.regions, GLOBAL_SERVICES_REGION])];
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        effect: Effect.ALLOW,
        // TagSession: newer CDK CLIs and bootstrap templates pass session tags
        // when assuming the bootstrap roles; it's limited to the same roles.
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: regions.flatMap((r) =>
          BOOTSTRAP_ROLES.map((kind) => `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-${qualifier}-${kind}-role-${Aws.ACCOUNT_ID}-${r}`),
        ),
      }),
    );

    // The web stack's publisher role (lib/web/publisher.ts, supply-checkout-pbp.28): uploading a
    // release and switching the live version need S3, KeyValueStore and CloudFront Function
    // calls that no bootstrap role makes. That role trusts only this one.
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "AssumeWebPublisher",
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${webPublisherRoleName(config.envName)}`],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: this.role.roleArn,
      description: "The role GitHub Actions assumes to deploy (aws-actions/configure-aws-credentials role-to-assume)",
    });
  }
}
