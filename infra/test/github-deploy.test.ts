import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import {
  APPROVED_REGIONS,
  DEFAULT_GITHUB_REPOSITORY,
  type DeploymentConfig,
  GITHUB_DEPLOY_ENVIRONMENT,
  GITHUB_DEPLOY_ENVIRONMENTS,
  GLOBAL_SERVICES_REGION,
  type GithubRepository,
  githubRepositoryFromContext,
  webPublisherRoleName,
} from "../lib/config.js";
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_URL, githubDeployRoleName, githubDeploySubject } from "../lib/stacks/github-deploy-stack.js";
import { addGithubDeploy } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST], primaryRegion: EAST };
const REPO: GithubRepository = { name: "example-owner/example-repo", ownerId: 1234, repositoryId: 567890 };
const SUBJECT = "repo:example-owner@1234/example-repo@567890:environment:production";
const STATEFUL_SUBJECT = "repo:example-owner@1234/example-repo@567890:environment:production-stateful";

function build(overrides: Partial<DeploymentConfig> = {}, repository = REPO) {
  const app = testApp();
  const stack = addGithubDeploy(app, { ...config, ...overrides }, repository);
  return { app, stack, template: Template.fromStack(stack) };
}

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown; Principal?: unknown };
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

function role(template: Template) {
  const roles = Object.values(template.findResources("AWS::IAM::Role"));
  expect(roles).toHaveLength(1);
  return roles[0] as { Properties: Record<string, unknown> & { AssumeRolePolicyDocument: { Statement: Statement[] } } };
}

function policyStatements(template: Template): Statement[] {
  return Object.values(template.findResources("AWS::IAM::Policy")).flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

/** A bootstrap role's ARN as the template builds it (partition and account from CloudFormation). */
const bootstrapRole = (kind: string, region: string) => ({
  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, `:role/cdk-hnb659fds-${kind}-role-`, { Ref: "AWS::AccountId" }, `-${region}`]],
});

describe("GitHub repository config", () => {
  const context = (values: Record<string, unknown>) => ({ tryGetContext: (key: string) => values[key] });
  const full = { githubRepository: REPO.name, githubOwnerId: "1234", githubRepositoryId: "567890" };

  it("defaults to this repository, by name and by GitHub's immutable owner and repository IDs, and deploys from the production environment", () => {
    // Public identifiers (gh api repos/davetashner/supply-checkout --jq '{owner_id: .owner.id, repo_id: .id}')
    expect(DEFAULT_GITHUB_REPOSITORY).toEqual({ name: "davetashner/supply-checkout", ownerId: 5702882, repositoryId: 1388338851 });
    expect(GITHUB_DEPLOY_ENVIRONMENT).toBe("production");
    expect(GITHUB_DEPLOY_ENVIRONMENTS).toEqual(["production", "production-stateful"]);
    expect(githubRepositoryFromContext(context({}))).toEqual(DEFAULT_GITHUB_REPOSITORY);
    expect(githubRepositoryFromContext(context(full))).toEqual(REPO);
    // cdk.json or a test may give the IDs as numbers
    expect(githubRepositoryFromContext(context({ ...full, githubOwnerId: 1234, githubRepositoryId: 567890 }))).toEqual(REPO);
  });

  it.each(["", "owner", "owner/", "/repo", "owner/repo/extra", "owner/*", "*/repo", "own*er/repo", "owner/repo:environment:x", "-owner/repo", "owner/re po", "owner@1/repo", "owner/repo@2", "owner@1/repo@2", "owner:1/repo"])(
    "rejects the name %o",
    (value) => {
      expect(() => githubRepositoryFromContext(context({ ...full, githubRepository: value }))).toThrow(/githubRepository/);
    },
  );

  it.each(["", "0", "-1", "1.5", "12a", "*", "1:repository_id:2", " 12", "1e3", "0x10", "01", "99999999999999999999"])("rejects the ID %o", (value) => {
    expect(() => githubRepositoryFromContext(context({ ...full, githubOwnerId: value }))).toThrow(/githubOwnerId/);
    expect(() => githubRepositoryFromContext(context({ ...full, githubRepositoryId: value }))).toThrow(/githubRepositoryId/);
  });

  it("takes the name and both IDs together, so an override can't keep this repository's IDs under another name", () => {
    for (const key of Object.keys(full)) {
      const partial = Object.fromEntries(Object.entries(full).filter(([k]) => k !== key));
      expect(() => githubRepositoryFromContext(context(partial)), key).toThrow(/githubRepository, githubOwnerId and githubRepositoryId together/);
    }
    expect(() => githubRepositoryFromContext(context({ githubOwnerId: "1" }))).toThrow(/together/);
  });
});

describe("GitHub Actions deploy role (supply-checkout-5ik)", () => {
  it("is one stack in the primary region, named for the environment, with termination protection", () => {
    const { stack } = build();
    expect(stack.stackName).toBe(`supply-checkout-prod-${EAST}-github-deploy`);
    expect(stack.region).toBe(EAST);
    expect(stack.terminationProtection).toBe(true);
  });

  it("registers GitHub's OIDC issuer with the STS audience only", () => {
    const { template } = build();
    expect(GITHUB_OIDC_URL).toBe("https://token.actions.githubusercontent.com");
    expect(GITHUB_OIDC_AUDIENCE).toBe("sts.amazonaws.com");
    template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    template.hasResourceProperties("AWS::IAM::OIDCProvider", { Url: GITHUB_OIDC_URL, ClientIdList: [GITHUB_OIDC_AUDIENCE] });
  });

  it("builds GitHub's immutable subject: owner and repository names, each with its ID, then the environment", () => {
    expect(githubDeploySubject(REPO)).toBe(SUBJECT);
    expect(githubDeploySubject(REPO, "production-stateful")).toBe(STATEFUL_SUBJECT);
    // What GitHub's sub_claim_prefix for this repository is, plus the environment
    expect(githubDeploySubject(DEFAULT_GITHUB_REPOSITORY)).toBe("repo:davetashner@5702882/supply-checkout@1388338851:environment:production");
  });

  it("can be assumed only with a GitHub token for this repository's production or production-stateful environment, matched on immutable IDs", () => {
    const { template } = build();
    const r = role(template);
    expect(r.Properties.RoleName).toBe(githubDeployRoleName("prod"));
    expect(githubDeployRoleName("prod")).toBe("supply-checkout-prod-github-deploy");
    const [trust, ...others] = r.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toEqual({
      Effect: "Allow",
      Action: "sts:AssumeRoleWithWebIdentity",
      Principal: { Federated: { Ref: expect.stringMatching(/^GithubOidc/) } },
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": [SUBJECT, STATEFUL_SUBJECT],
        },
      },
    });
    // Exactly one trust statement, no StringLike (no wildcard subject), no other principal
    expect(others).toEqual([]);
    expect(Object.keys(trust?.Condition as object)).toEqual(["StringEquals"]);
    expect(JSON.stringify(trust)).not.toContain("*");
    // Not the old subject keyed on the mutable owner/name alone
    expect(JSON.stringify(trust)).not.toContain(`repo:${REPO.name}:`);
  });

  it("follows the configured repository", () => {
    const { template } = build({}, { name: "someone/fork", ownerId: 42, repositoryId: 4242 });
    expect(JSON.stringify(role(template).Properties.AssumeRolePolicyDocument)).toContain('"repo:someone@42/fork@4242:environment:production"');
    expect(role(template).Properties.Description).toBe("GitHub Actions deploys from someone/fork (owner ID 42, repository ID 4242), environments production and production-stateful only");
    expect(githubDeployRoleName("staging")).toBe("supply-checkout-staging-github-deploy");
  });

  it("refuses any environment but prod, since the trust always names the production GitHub environment", () => {
    expect(() => build({ envName: "staging" })).toThrow(/prod only/);
  });

  it("uses a bootstrap qualifier from context, and refuses one that isn't CDK's 1-10 letters, digits, _ or -", () => {
    const withQualifier = (qualifier: string) => {
      const app = testApp({ "@aws-cdk/core:bootstrapQualifier": qualifier });
      return Template.fromStack(addGithubDeploy(app, config, REPO));
    };
    expect(JSON.stringify(policyStatements(withQualifier("custom_q-1")))).toContain(":role/cdk-custom_q-1-deploy-role-");
    for (const bad of ["*", "?", "hnb*", "a?b", "", "elevenchars", "a/b", "a:b"]) {
      expect(() => withQualifier(bad), bad).toThrow(/bootstrap qualifier/);
    }
  });

  it("has no managed policy, a one-hour session, and may only assume the CDK bootstrap roles of the deployed regions and the web publisher role", () => {
    const { template } = build();
    const r = role(template);
    expect(r.Properties.ManagedPolicyArns).toBeUndefined();
    expect(r.Properties.Policies).toBeUndefined();
    expect(r.Properties.MaxSessionDuration).toBe(3600);
    const statements = policyStatements(template);
    expect(statements).toEqual([
      {
        Sid: "AssumeCdkBootstrapRoles",
        Effect: "Allow",
        Action: ["sts:AssumeRole", "sts:TagSession"],
        Resource: ["deploy", "file-publishing", "image-publishing", "lookup"].map((kind) => bootstrapRole(kind, EAST)),
      },
      {
        // supply-checkout-pbp.28: the web stack's publisher role, by its fixed name, and nothing else
        Sid: "AssumeWebPublisher",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":role/supply-checkout-prod-web-publisher"]] },
      },
    ]);
    expect(webPublisherRoleName("prod")).toBe("supply-checkout-prod-web-publisher");
    for (const s of statements) for (const a of actions(s)) expect(a).not.toContain("*");
    // No wildcard in any resource either: each ARN names exactly one role
    for (const s of statements) expect(JSON.stringify(s.Resource)).not.toMatch(/[*?]/);
  });

  it("adds each deployed region's bootstrap roles, and GLOBAL_SERVICES_REGION's", () => {
    const { template } = build({ regions: [WEST], primaryRegion: WEST });
    const [statement] = policyStatements(template);
    const regions = [WEST, GLOBAL_SERVICES_REGION];
    const roles = regions.flatMap((region) => ["deploy", "file-publishing", "image-publishing", "lookup"].map((kind) => bootstrapRole(kind, region)));
    // In any order: cdk.json's @aws-cdk/aws-iam:minimizePolicies sorts them
    expect(statement?.Resource).toHaveLength(roles.length);
    expect(statement?.Resource).toEqual(expect.arrayContaining(roles));
    const both = policyStatements(build({ regions: [EAST, WEST], primaryRegion: EAST }).template)[0];
    expect(both?.Resource).toHaveLength(8);
  });

  it("publishes the role's ARN as an output for the workflow", () => {
    build().template.hasOutput("DeployRoleArn", { Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^DeployRole"), "Arn"] } });
  });

  it("is cdk-nag clean in every approved region", () => {
    for (const region of APPROVED_REGIONS) {
      const { app } = build({ regions: [region], primaryRegion: region });
      const report = new AwsSolutionsChecks(app).validateScope(app);
      expect(report.violations).toEqual([]);
      expect(() => app.synth()).not.toThrow();
    }
  });
});
