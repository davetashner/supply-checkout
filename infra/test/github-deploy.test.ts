import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import {
  APPROVED_REGIONS,
  DEFAULT_GITHUB_REPOSITORY,
  type DeploymentConfig,
  GITHUB_DEPLOY_ENVIRONMENT,
  GLOBAL_SERVICES_REGION,
  githubRepositoryFromContext,
} from "../lib/config.js";
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_URL, githubDeployRoleName } from "../lib/stacks/github-deploy-stack.js";
import { addGithubDeploy } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST], primaryRegion: EAST };
const REPO = "example-owner/example-repo";

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

  it("defaults to this repository and deploys from the production environment", () => {
    expect(DEFAULT_GITHUB_REPOSITORY).toBe("davetashner/supply-checkout");
    expect(GITHUB_DEPLOY_ENVIRONMENT).toBe("production");
    expect(githubRepositoryFromContext(context({}))).toBe(DEFAULT_GITHUB_REPOSITORY);
    expect(githubRepositoryFromContext(context({ githubRepository: REPO }))).toBe(REPO);
  });

  it.each(["", "owner", "owner/", "/repo", "owner/repo/extra", "owner/*", "*/repo", "own*er/repo", "owner/repo:environment:x", "-owner/repo", "owner/re po"])(
    "rejects %o",
    (value) => {
      expect(() => githubRepositoryFromContext(context({ githubRepository: value }))).toThrow(/githubRepository/);
    },
  );
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

  it("can be assumed only with a GitHub token for this repository's production environment", () => {
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
          "token.actions.githubusercontent.com:sub": `repo:${REPO}:environment:production`,
        },
      },
    });
    // Exactly one trust statement, no StringLike (no wildcard subject), no other principal
    expect(others).toEqual([]);
    expect(Object.keys(trust?.Condition as object)).toEqual(["StringEquals"]);
    expect(JSON.stringify(trust)).not.toContain("*");
  });

  it("follows the configured repository", () => {
    const { template } = build({}, "someone/fork");
    expect(JSON.stringify(role(template).Properties.AssumeRolePolicyDocument)).toContain('"repo:someone/fork:environment:production"');
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

  it("has no managed policy, a one-hour session, and may only assume the CDK bootstrap roles of the deployed regions", () => {
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
    ]);
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
