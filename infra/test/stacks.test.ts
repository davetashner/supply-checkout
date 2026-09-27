import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App, type Stack, Token, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { addBackupAccount, addSupplyCheckout, type SupplyCheckoutStacks } from "../lib/supply-checkout.js";
import { OPS_INDEX_ATTRIBUTES } from "../../backend/src/data/schema.js";

// No account: tests synth account-agnostic templates, exactly as CI does, so
// snapshots never contain an account ID.
// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(overrides: Partial<DeploymentConfig> = {}) {
  // Version reporting off keeps snapshots stable across CDK upgrades
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [] } });
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
  it("creates domain, data, api, realtime and observability per region, plus identity, backup, email and web in the primary", () => {
    const { stacks } = build();
    expect(names(stacks.all)).toEqual([
      `supply-checkout-prod-${EAST}-api`,
      `supply-checkout-prod-${EAST}-backup`,
      `supply-checkout-prod-${EAST}-data`,
      `supply-checkout-prod-${EAST}-domain`,
      `supply-checkout-prod-${EAST}-email`,
      `supply-checkout-prod-${EAST}-identity`,
      `supply-checkout-prod-${EAST}-observability`,
      `supply-checkout-prod-${EAST}-realtime`,
      `supply-checkout-prod-${EAST}-web`,
      `supply-checkout-prod-${WEST}-api`,
      `supply-checkout-prod-${WEST}-data`,
      `supply-checkout-prod-${WEST}-domain`,
      `supply-checkout-prod-${WEST}-observability`,
      `supply-checkout-prod-${WEST}-realtime`,
    ]);
    for (const [region, r] of Object.entries(stacks.regions)) {
      for (const stack of [r.data, r.api, r.realtime, r.observability]) expect(stack.region).toBe(region);
    }
    for (const [region, stack] of Object.entries(stacks.domain)) expect(stack.region).toBe(region);
    expect(stacks.identity.region).toBe(EAST);
    expect(stacks.backup.region).toBe(EAST);
    expect(stacks.email.region).toBe(EAST);
    expect(stacks.web.region).toBe(EAST);
  });

  it("takes the environment and regions as parameters, keeping domain and web stacks in the global services region", () => {
    const { stacks } = build({ envName: "staging", regions: [WEST], primaryRegion: WEST });
    expect(names(stacks.all)).toEqual([
      // CloudFront, Cognito and AppSync certificates must be in GLOBAL_SERVICES_REGION
      `supply-checkout-staging-${GLOBAL_SERVICES_REGION}-domain`,
      `supply-checkout-staging-${GLOBAL_SERVICES_REGION}-web`,
      `supply-checkout-staging-${WEST}-api`,
      `supply-checkout-staging-${WEST}-backup`,
      `supply-checkout-staging-${WEST}-data`,
      `supply-checkout-staging-${WEST}-domain`,
      `supply-checkout-staging-${WEST}-email`,
      `supply-checkout-staging-${WEST}-identity`,
      `supply-checkout-staging-${WEST}-observability`,
      `supply-checkout-staging-${WEST}-realtime`,
    ]);
    expect(inRegion(stacks, WEST).data.isPrimaryRegion).toBe(true);
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
      "backup",
      "data",
      "data",
      "identity",
    ]);
  });

  it("orders deploys: domain first, data before identity, data and identity before api, api and realtime before observability, all data before web, backup last", () => {
    const { stacks } = build();
    const deps = (s: Stack) => s.dependencies.map((d) => d.stackName).sort();
    const globalDomain = stacks.domain[GLOBAL_SERVICES_REGION]?.stackName;
    for (const [region, r] of Object.entries(stacks.regions)) {
      const domain = stacks.domain[region]?.stackName;
      expect(deps(r.api)).toEqual([r.data.stackName, domain, stacks.identity.stackName].sort());
      expect(deps(r.realtime)).toEqual([...new Set([r.data.stackName, globalDomain])].sort());
      expect(deps(r.observability)).toEqual([r.api.stackName, r.realtime.stackName].sort());
    }
    expect(deps(stacks.identity)).toEqual([globalDomain, stacks.web.stackName, inRegion(stacks, EAST).data.stackName].sort());
    expect(deps(stacks.email)).toEqual([stacks.domain[EAST]?.stackName, inRegion(stacks, EAST).data.stackName].sort());
    expect(deps(stacks.web)).toEqual([globalDomain, ...Object.values(stacks.regions).map((r) => r.data.stackName)].sort());
    for (const domain of Object.values(stacks.domain)) expect(deps(domain)).toEqual([]);
    const east = inRegion(stacks, EAST);
    expect(deps(stacks.backup)).toEqual([east.data.stackName, east.observability.stackName].sort());
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
});

// One snapshot file per stack (test/__snapshots__/<stack name>.json), so a
// change to one stack doesn't touch the others'. `npm run test:update` rewrites them.
describe("template snapshots", () => {
  const { stacks } = build();
  // The backup account's vault stack is a separate app (bin/backup-account.ts)
  const backupAccountApp = new App({ context: { "aws:cdk:version-reporting": false } });
  const backupAccount = addBackupAccount(backupAccountApp, config);
  const snapshotted: Stack[] = [...stacks.all, backupAccount];
  const snapshots = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__");

  it.each(snapshotted.map((stack) => [stack.stackName, stack] as const))("%s matches its snapshot", async (name, stack) => {
    // Lambda asset hashes, and the function version IDs made from them,
    // depend on the checkout's path (bundling is skipped in tests, and CDK
    // hashes the bundling command instead), so mask them
    const json = JSON.stringify(Template.fromStack(stack).toJSON(), null, 2)
      .replace(/"[0-9a-f]{64}\.zip"/g, '"<asset hash>.zip"')
      .replace(/(CurrentVersion[0-9A-F]{8})[0-9a-f]{32}/g, "$1<code hash>");
    await expect(`${json}\n`).toMatchFileSnapshot(join(snapshots, `${name}.json`));
  });

  it("has no snapshot for a stack that no longer exists", () => {
    // (A missing snapshot fails its own test in CI, which never writes one.)
    const current = new Set(names(snapshotted).map((n) => `${n}.json`));
    expect(readdirSync(snapshots).filter((f) => !current.has(f))).toEqual([]);
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
    const east = inRegion(stacks, EAST);
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
    const { stacks } = build({ envName: "staging", regions: [WEST], primaryRegion: WEST });
    const west = inRegion(stacks, WEST);
    const table = tableProps(west.data);
    expect(table.Properties.Replicas.map((r: { Region: string }) => r.Region)).toEqual([west.data.region]);
    expect(table.Properties.TableName).toBe("supply-checkout-staging-app");
  });

  it("is on-demand, streamed, keyed PK/SK with GSI1, GSI2 and the operators' GSI3, TTL on expiresAt, and retained", () => {
    const { stacks } = build();
    const template = Template.fromStack(inRegion(stacks, EAST).data);
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
          {
            IndexName: "GSI2",
            KeySchema: [
              { AttributeName: "GSI2PK", KeyType: "HASH" },
              { AttributeName: "GSI2SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
          // ADR 0015: only the account record, owners' emails and the audit summary, never a team's data
          {
            IndexName: "GSI3",
            KeySchema: [
              { AttributeName: "GSI3PK", KeyType: "HASH" },
              { AttributeName: "GSI3SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: [...OPS_INDEX_ATTRIBUTES] },
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
    const template = Template.fromStack(inRegion(stacks, EAST).data);
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
    const template = Template.fromStack(inRegion(stacks, EAST).data);
    for (const name of ["table-name", "table-arn", "table-stream-arn", "table-key-arn"]) {
      template.hasResourceProperties("AWS::SSM::Parameter", { Name: `/supply-checkout/prod/data/${name}`, Type: "String" });
    }
  });

  it("keeps the data stack termination-protected", () => {
    const { stacks } = build();
    expect(inRegion(stacks, EAST).data.terminationProtection).toBe(true);
  });
});

describe("cdk-nag", () => {
  it("finds nothing unacknowledged in any stack", () => {
    const { app } = build();
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
    expect(report.success).toBe(true);
  });

  // The default build puts identity and web in EAST only. Synth every stack in
  // each region, as the primary and as the only region, so no stack assumes
  // where it runs (ADR 0010).
  it.each(APPROVED_REGIONS)("synths every stack in %s, cdk-nag clean", (region) => {
    const { app, stacks } = build({ regions: [region], primaryRegion: region });
    // The global services region always has the web stack (CloudFront's web
    // ACL) and a domain stack (certificates AWS only accepts there); every
    // other stack runs in the one region.
    const global: Stack[] = [stacks.domain[GLOBAL_SERVICES_REGION] as Stack, stacks.web];
    const regional = stacks.all.filter((s) => region === GLOBAL_SERVICES_REGION || !global.includes(s));
    expect(regional).toHaveLength(region === GLOBAL_SERVICES_REGION ? 9 : 8);
    for (const stack of global) expect(stack?.region).toBe(GLOBAL_SERVICES_REGION);
    for (const stack of regional) expect(stack.region, stack.stackName).toBe(region);
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
    expect(() => app.synth()).not.toThrow();
  });

  it("is wired into synth and fails it on a finding", () => {
    const { app, stacks } = build();
    new Bucket(inRegion(stacks, EAST).data, "UnloggedBucket");
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.success).toBe(false);
    expect(report.violations.map((v) => v.ruleName)).toContain("AwsSolutions-S1");
    expect(() => app.synth()).toThrow(/Validation failed|AwsSolutions/);
  });

  it("honours an acknowledged finding", () => {
    const { app, stacks } = build();
    const bucket = new Bucket(inRegion(stacks, EAST).data, "UnloggedBucket", { enforceSSL: true });
    Validations.of(bucket).acknowledge({ id: "AwsSolutions-S1", reason: "Test: access logs not needed" });
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
  });
});
