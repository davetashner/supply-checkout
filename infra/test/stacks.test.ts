import { App, type Stack, Token, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import type { DeploymentConfig } from "../lib/config.js";
import { addSupplyCheckout, type SupplyCheckoutStacks } from "../lib/supply-checkout.js";

// No account: tests synth account-agnostic templates, exactly as CI does, so
// snapshots never contain an account ID.
const config: DeploymentConfig = { envName: "prod", regions: ["us-east-1", "us-west-2"], primaryRegion: "us-east-1" };

function build(overrides: Partial<DeploymentConfig> = {}) {
  // Version reporting off keeps snapshots stable across CDK upgrades
  const app = new App({ context: { "aws:cdk:version-reporting": false } });
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  return { app, stacks };
}

function inRegion(stacks: SupplyCheckoutStacks, region: string) {
  const r = stacks.regions[region];
  if (!r) throw new Error(`No stacks in ${region}`);
  return r;
}

const names = (stacks: Stack[]) => stacks.map((s) => s.stackName).sort();

describe("stack layout", () => {
  it("creates data, api, realtime and observability per region, plus identity and web in the primary", () => {
    const { stacks } = build();
    expect(names(stacks.all)).toEqual([
      "supply-checkout-prod-us-east-1-api",
      "supply-checkout-prod-us-east-1-data",
      "supply-checkout-prod-us-east-1-identity",
      "supply-checkout-prod-us-east-1-observability",
      "supply-checkout-prod-us-east-1-realtime",
      "supply-checkout-prod-us-east-1-web",
      "supply-checkout-prod-us-west-2-api",
      "supply-checkout-prod-us-west-2-data",
      "supply-checkout-prod-us-west-2-observability",
      "supply-checkout-prod-us-west-2-realtime",
    ]);
    for (const [region, r] of Object.entries(stacks.regions)) {
      for (const stack of [r.data, r.api, r.realtime, r.observability]) expect(stack.region).toBe(region);
    }
    expect(stacks.identity.region).toBe("us-east-1");
    expect(stacks.web.region).toBe("us-east-1");
  });

  it("takes the environment and regions as parameters", () => {
    const { stacks } = build({ envName: "staging", regions: ["us-west-2"], primaryRegion: "us-west-2" });
    expect(names(stacks.all)).toEqual([
      "supply-checkout-staging-us-west-2-api",
      "supply-checkout-staging-us-west-2-data",
      "supply-checkout-staging-us-west-2-identity",
      "supply-checkout-staging-us-west-2-observability",
      "supply-checkout-staging-us-west-2-realtime",
      "supply-checkout-staging-us-west-2-web",
    ]);
    expect(inRegion(stacks, "us-west-2").data.isPrimaryRegion).toBe(true);
  });

  it("uses the account from config when given, and none otherwise", () => {
    const account = "0".repeat(12);
    expect(build({ account }).stacks.web.account).toBe(account);
    expect(Token.isUnresolved(build().stacks.web.account)).toBe(true);
  });

  it("protects stateful stacks from deletion and leaves stateless stacks free to replace", () => {
    const { stacks } = build();
    for (const stack of stacks.all) {
      expect(stack.terminationProtection, stack.stackName).toBe(stack.layer === "stateful");
    }
    expect(stacks.all.filter((s) => s.layer === "stateful").map((s) => s.component).sort()).toEqual([
      "data",
      "data",
      "identity",
    ]);
  });

  it("orders deploys: data and identity before api, api and realtime before observability, all data before web", () => {
    const { stacks } = build();
    const deps = (s: Stack) => s.dependencies.map((d) => d.stackName).sort();
    const east = inRegion(stacks, "us-east-1");
    expect(deps(east.api)).toEqual([east.data.stackName, stacks.identity.stackName].sort());
    expect(deps(east.realtime)).toEqual([east.data.stackName]);
    expect(deps(east.observability)).toEqual([east.api.stackName, east.realtime.stackName].sort());
    expect(deps(stacks.web)).toEqual(Object.values(stacks.regions).map((r) => r.data.stackName).sort());
  });

  it("tags every stack and resource with the app, environment and component", () => {
    const { stacks } = build();
    for (const stack of stacks.all) {
      expect(stack.tags.tagValues()).toMatchObject({
        app: "supply-checkout",
        "managed-by": "cdk",
        env: "prod",
        component: stack.component,
        layer: stack.layer,
      });
      Template.fromStack(stack).hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/supply-checkout/prod/${stack.component}/stack`,
        Type: "String",
        Tags: { app: "supply-checkout", "managed-by": "cdk", env: "prod", component: stack.component },
      });
    }
  });

  it("matches the template snapshots", () => {
    const { stacks } = build();
    for (const stack of stacks.all) {
      expect(Template.fromStack(stack).toJSON()).toMatchSnapshot(stack.stackName);
    }
  });
});

describe("app table (ADR 0005, ADR 0010)", () => {
  const tableProps = (stack: Stack) => {
    const tables = Template.fromStack(stack).findResources("AWS::DynamoDB::GlobalTable");
    const [table, ...rest] = Object.values(tables);
    expect(rest).toEqual([]);
    return table;
  };

  it("is one global table in the primary region's data stack, with one replica there", () => {
    const { stacks } = build();
    const east = inRegion(stacks, "us-east-1");
    const table = tableProps(east.data);
    expect(table.Properties.Replicas).toHaveLength(1);
    expect(table.Properties.Replicas[0].Region).toBe(east.data.region);
    expect(table.Properties.TableName).toBe("supply-checkout-prod-app");
    // No other stack in either region has a table yet (the second replica is phase 2)
    for (const stack of stacks.all.filter((s) => s !== east.data)) {
      Template.fromStack(stack).resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
      Template.fromStack(stack).resourceCountIs("AWS::DynamoDB::Table", 0);
    }
  });

  it("follows the primary region when that is the other region", () => {
    const { stacks } = build({ envName: "staging", regions: ["us-west-2"], primaryRegion: "us-west-2" });
    const west = inRegion(stacks, "us-west-2");
    const table = tableProps(west.data);
    expect(table.Properties.Replicas.map((r: { Region: string }) => r.Region)).toEqual([west.data.region]);
    expect(table.Properties.TableName).toBe("supply-checkout-staging-app");
  });

  it("is on-demand, streamed, keyed PK/SK with GSI1, TTL on expiresAt, and retained", () => {
    const { stacks } = build();
    const template = Template.fromStack(inRegion(stacks, "us-east-1").data);
    template.hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        // No local secondary indexes: they can never be removed, and they cap
        // each team's partition at 10 GB.
        LocalSecondaryIndexes: Match.absent(),
      },
    });
  });

  it("has PITR, deletion protection and a customer-managed key with rotation on its replica", () => {
    const { stacks } = build();
    const template = Template.fromStack(inRegion(stacks, "us-east-1").data);
    const keys = template.findResources("AWS::KMS::Key");
    const [keyId, ...otherKeys] = Object.keys(keys);
    expect(otherKeys).toEqual([]);
    template.hasResource("AWS::KMS::Key", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { EnableKeyRotation: true },
    });
    template.hasResourceProperties("AWS::KMS::Alias", { AliasName: "alias/supply-checkout-prod-app-table" });
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      SSESpecification: { SSEEnabled: true, SSEType: "KMS" },
      Replicas: [
        Match.objectLike({
          DeletionProtectionEnabled: true,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          SSESpecification: { KMSMasterKeyId: { "Fn::GetAtt": [keyId, "Arn"] } },
        }),
      ],
    });
  });

  it("publishes the table name, ARNs and key ARN to SSM for the other stacks", () => {
    const { stacks } = build();
    const template = Template.fromStack(inRegion(stacks, "us-east-1").data);
    for (const name of ["table-name", "table-arn", "table-stream-arn", "table-key-arn"]) {
      template.hasResourceProperties("AWS::SSM::Parameter", { Name: `/supply-checkout/prod/data/${name}`, Type: "String" });
    }
  });

  it("keeps the data stack termination-protected", () => {
    const { stacks } = build();
    expect(inRegion(stacks, "us-east-1").data.terminationProtection).toBe(true);
  });
});

describe("cdk-nag", () => {
  it("finds nothing unacknowledged in any stack", () => {
    const { app } = build();
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
    expect(report.success).toBe(true);
  });

  it("is wired into synth and fails it on a finding", () => {
    const { app, stacks } = build();
    new Bucket(inRegion(stacks, "us-east-1").data, "UnloggedBucket");
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.success).toBe(false);
    expect(report.violations.map((v) => v.ruleName)).toContain("AwsSolutions-S1");
    expect(() => app.synth()).toThrow(/Validation failed|AwsSolutions/);
  });

  it("honours an acknowledged finding", () => {
    const { app, stacks } = build();
    const bucket = new Bucket(inRegion(stacks, "us-east-1").data, "UnloggedBucket", { enforceSSL: true });
    Validations.of(bucket).acknowledge({ id: "AwsSolutions-S1", reason: "Test: access logs not needed" });
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
  });
});
