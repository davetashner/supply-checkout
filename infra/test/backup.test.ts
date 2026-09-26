import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_GRACE_DAYS,
  COPY_RETENTION,
  LOCAL_RETENTION,
  MAX_LOCK_RETENTION,
  MIN_LOCK_RETENTION,
  backupCopyFromContext,
  backupParameters,
} from "../lib/backup.js";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { addBackupAccount, addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };
const TABLE = "supply-checkout-prod-app";

function workload(context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [], ...context } });
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  return { app, stacks, template: Template.fromStack(stacks.backup) };
}

function backupAccount(overrides: Partial<DeploymentConfig> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false } });
  const stack = addBackupAccount(app, { ...config, ...overrides });
  return { app, stack, template: Template.fromStack(stack) };
}

/** The CloudFormation parameter an SSM parameter name resolves through, at deploy time. */
function ssmParameter(template: Template, name: string): string {
  const params = template.toJSON().Parameters as Record<string, { Type: string; Default?: string }>;
  const [id, ...rest] = Object.entries(params)
    .filter(([, p]) => p.Type === "AWS::SSM::Parameter::Value<String>" && p.Default === name)
    .map(([id]) => id);
  expect(rest).toEqual([]);
  expect(id, name).toBeDefined();
  return id as string;
}

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown; Condition?: unknown };
const statements = (template: Template, type: string, path: (props: Record<string, unknown>) => { Statement: Statement[] }) =>
  Object.values(template.findResources(type)).flatMap((r) => path(r.Properties).Statement);
const policyStatements = (template: Template, rolePrefix: string) =>
  Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref.startsWith(rolePrefix)))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
const actions = (s: Statement) => [s.Action].flat();

describe("backupCopyFromContext", () => {
  const node = (value: unknown) => ({ tryGetContext: () => value });
  it("defaults to on, and reads true or false", () => {
    for (const v of [undefined, "", true, "true"]) expect(backupCopyFromContext(node(v))).toBe(true);
    for (const v of [false, "false"]) expect(backupCopyFromContext(node(v))).toBe(false);
  });
  it("refuses anything else", () => {
    expect(() => backupCopyFromContext(node("no"))).toThrow(/backupCopy must be true or false/);
  });
});

describe("retention settings", () => {
  it("keep every rule inside both vault locks", () => {
    for (const d of [LOCAL_RETENTION, COPY_RETENTION]) {
      expect(d.toDays()).toBeGreaterThanOrEqual(MIN_LOCK_RETENTION.toDays());
      expect(d.toDays()).toBeLessThanOrEqual(MAX_LOCK_RETENTION.toDays());
    }
    // The local copy covers at least PITR's 35 days; the separate account keeps more
    expect(LOCAL_RETENTION.toDays()).toBe(35);
    expect(COPY_RETENTION.toDays()).toBeGreaterThan(LOCAL_RETENTION.toDays());
    expect(COMPLIANCE_GRACE_DAYS).toBeGreaterThanOrEqual(3);
  });
});

describe("backup stack (workload account)", () => {
  it("is only in the primary region, and follows it", () => {
    expect(workload().stacks.backup.region).toBe(EAST);
    const { stacks } = workload({}, { envName: "staging", regions: [WEST], primaryRegion: WEST });
    expect(stacks.backup.stackName).toBe(`supply-checkout-staging-${WEST}-backup`);
  });

  it("has a vault with its own rotating, retained key and a governance-mode lock", () => {
    const { template } = workload();
    template.resourceCountIs("AWS::Backup::BackupVault", 1);
    template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain", Properties: { EnableKeyRotation: true } });
    template.hasResourceProperties("AWS::KMS::Alias", { AliasName: "alias/supply-checkout-prod-backups" });
    template.hasResource("AWS::Backup::BackupVault", {
      DeletionPolicy: "Retain",
      Properties: {
        BackupVaultName: "supply-checkout-prod-backups",
        EncryptionKeyArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^VaultKey"), "Arn"] },
        // No ChangeableForDays: governance mode
        LockConfiguration: { MinRetentionDays: 7, MaxRetentionDays: 365, ChangeableForDays: Match.absent() },
      },
    });
  });

  it("denies deleting recovery points or shortening their lifecycle to everyone", () => {
    const { template } = workload();
    const vault = statements(template, "AWS::Backup::BackupVault", (p) => p.AccessPolicy as { Statement: Statement[] });
    expect(vault).toContainEqual(
      expect.objectContaining({
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: ["backup:DeleteRecoveryPoint", "backup:UpdateRecoveryPointLifecycle"],
      }),
    );
  });

  it("backs up the app table daily at 2am Eastern, keeps it 35 days and copies it to the backup account for 90", () => {
    const { template } = workload();
    const copyVault = ssmParameter(template, backupParameters("prod").copyVaultArn);
    template.resourceCountIs("AWS::Backup::BackupPlan", 1);
    template.hasResourceProperties("AWS::Backup::BackupPlan", {
      BackupPlan: {
        BackupPlanName: "supply-checkout-prod-daily",
        BackupPlanRule: [
          {
            RuleName: "daily",
            ScheduleExpression: "cron(0 2 * * ? *)",
            ScheduleExpressionTimezone: "America/New_York",
            TargetBackupVault: { "Fn::GetAtt": [Match.stringLikeRegexp("^Vault"), "BackupVaultName"] },
            Lifecycle: { DeleteAfterDays: LOCAL_RETENTION.toDays() },
            CopyActions: [{ DestinationBackupVaultArn: { Ref: copyVault }, Lifecycle: { DeleteAfterDays: COPY_RETENTION.toDays() } }],
          },
        ],
      },
    });
    template.resourceCountIs("AWS::Backup::BackupSelection", 1);
    template.hasResourceProperties("AWS::Backup::BackupSelection", {
      BackupSelection: {
        SelectionName: "app-table",
        IamRoleArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^BackupRole"), "Arn"] },
        Resources: [
          {
            "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:table/${TABLE}`]],
          },
        ],
      },
    });
  });

  it("shares the vault key with, and accepts restore copies from, the account in the copy vault's ARN", () => {
    const { template } = workload();
    const copyVault = ssmParameter(template, backupParameters("prod").copyVaultArn);
    const backupAccountRoot = {
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { "Fn::Select": [4, { "Fn::Split": [":", { Ref: copyVault }] }] }, ":root"]],
    };
    const key = statements(template, "AWS::KMS::Key", (p) => p.KeyPolicy as { Statement: Statement[] });
    expect(key.find((s) => s.Sid === "BackupAccountCopiesRecoveryPoints")?.Principal).toEqual({ AWS: backupAccountRoot });
    const grant = key.find((s) => s.Sid === "BackupAccountGrantsToAwsBackup");
    expect(grant).toMatchObject({ Action: "kms:CreateGrant", Condition: { Bool: { "kms:GrantIsForAWSResource": "true" } } });
    const vault = statements(template, "AWS::Backup::BackupVault", (p) => p.AccessPolicy as { Statement: Statement[] });
    expect(vault.find((s) => s.Sid === "BackupAccountCopiesBackForRestores")).toMatchObject({
      Effect: "Allow",
      Principal: { AWS: backupAccountRoot },
      Action: "backup:CopyIntoBackupVault",
    });
  });

  it("with backupCopy=false, has no copy rule and shares nothing with another account", () => {
    const { template } = workload({ backupCopy: "false" });
    const plan = Object.values(template.findResources("AWS::Backup::BackupPlan"))[0];
    expect(plan?.Properties.BackupPlan.BackupPlanRule[0].CopyActions).toBeUndefined();
    const params = Object.values(template.toJSON().Parameters as Record<string, { Default?: string }>);
    expect(params.map((p) => p.Default)).not.toContain(backupParameters("prod").copyVaultArn);
    const key = statements(template, "AWS::KMS::Key", (p) => p.KeyPolicy as { Statement: Statement[] });
    expect(key.map((s) => s.Sid).filter(Boolean)).toEqual([]);
    const vault = statements(template, "AWS::Backup::BackupVault", (p) => p.AccessPolicy as { Statement: Statement[] });
    expect(vault.map((s) => s.Effect)).toEqual(["Deny"]);
    expect(policyStatements(template, "BackupRole").flatMap(actions)).not.toContain("backup:CopyIntoBackupVault");
  });

  it("gives the backup role only the table, its backups, the two keys and the copy vault, with no managed policy", () => {
    const { template } = workload();
    const roles = template.findResources("AWS::IAM::Role");
    for (const role of Object.values(roles)) {
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
      expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
        { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "backup.amazonaws.com" } },
      ]);
    }
    expect(Object.values(roles).map((r) => r.Properties.RoleName).sort()).toEqual(["supply-checkout-prod-backup", "supply-checkout-prod-restore"]);
    const policy = policyStatements(template, "BackupRole");
    const bySid = Object.fromEntries(policy.map((s) => [s.Sid, s]));
    expect(Object.keys(bySid).sort()).toEqual(
      ["BackUpTheTable", "CopyToTheBackupAccount", "GrantKeysToAwsBackup", "ManageTheTablesBackups", "ReadTheTablesKey", "UseTheVaultKey"].sort(),
    );
    expect(actions(bySid.BackUpTheTable as Statement)).toEqual([
      "dynamodb:CreateBackup",
      "dynamodb:DescribeTable",
      "dynamodb:ListTagsOfResource",
      "dynamodb:StartAwsBackupJob",
    ]);
    expect(JSON.stringify(bySid.BackUpTheTable?.Resource)).toContain(`:table/${TABLE}"`);
    expect(JSON.stringify(bySid.ManageTheTablesBackups?.Resource)).toContain(`:table/${TABLE}/backup/*`);
    expect(bySid.CopyToTheBackupAccount?.Resource).toEqual({ Ref: ssmParameter(template, backupParameters("prod").copyVaultArn) });
    expect(bySid.GrantKeysToAwsBackup?.Condition).toEqual({ Bool: { "kms:GrantIsForAWSResource": "true" } });
    for (const s of policy) {
      expect(s.Effect).toBe("Allow");
      expect(s.Resource).not.toBe("*");
      for (const a of actions(s)) expect(a).not.toMatch(/\*/);
    }
  });

  it("lets the restore role create and fill only <table>-restore-* tables", () => {
    const { template } = workload();
    const policy = policyStatements(template, "RestoreRole");
    const writes = policy.find((s) => s.Sid === "RestoreIntoANewTable") as Statement;
    expect(actions(writes)).toContain("dynamodb:RestoreTableFromAwsBackup");
    expect(actions(writes)).toContain("dynamodb:PutItem");
    expect(JSON.stringify(writes.Resource)).toContain(`:table/${TABLE}-restore-*"`);
    // Nothing in the restore role reaches the live table itself
    for (const s of policy) {
      const resource = JSON.stringify(s.Resource);
      expect(resource).not.toMatch(new RegExp(`:table/${TABLE}"`));
      expect(s.Resource).not.toBe("*");
      for (const a of actions(s)) expect(a).not.toMatch(/\*/);
    }
    expect(JSON.stringify(policy.find((s) => s.Sid === "RestoreFromTheTablesBackups")?.Resource)).toContain(`:table/${TABLE}/backup/*`);
  });

  it("alarms to the P2 topic when a backup or copy fails, or no backup finished in a day", () => {
    const { template } = workload();
    const topic = ssmParameter(template, "/supply-checkout/prod/observability/alarm-topic-p2-arn");
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-backup-failed",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 0,
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: topic }],
      OKActions: [{ Ref: topic }],
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "FILL(bf, 0) + FILL(ba, 0) + FILL(be, 0) + FILL(cf, 0)" }),
        Match.objectLike({
          Id: "cf",
          MetricStat: Match.objectLike({
            Metric: { Namespace: "AWS/Backup", MetricName: "NumberOfCopyJobsFailed", Dimensions: [{ Name: "ResourceType", Value: "DynamoDB" }] },
          }),
        }),
      ]),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-no-recent-backup",
      MetricName: "NumberOfBackupJobsCompleted",
      Namespace: "AWS/Backup",
      Period: 86400,
      ComparisonOperator: "LessThanThreshold",
      Threshold: 1,
      TreatMissingData: "breaching",
      AlarmActions: [{ Ref: topic }],
    });
  });

  it("publishes the vault and restore role ARNs to SSM", () => {
    const { template } = workload();
    const names = backupParameters("prod");
    for (const name of [names.vaultArn, names.restoreRoleArn]) {
      template.hasResourceProperties("AWS::SSM::Parameter", { Name: name, Type: "String" });
    }
  });

  it("is termination-protected", () => {
    expect(workload().stacks.backup.terminationProtection).toBe(true);
  });
});

describe("S3 versioning", () => {
  it("is on for every bucket in the app, with old versions expiring", () => {
    const { stacks } = workload();
    let count = 0;
    for (const stack of stacks.all) {
      for (const bucket of Object.values(Template.fromStack(stack).findResources("AWS::S3::Bucket"))) {
        count++;
        expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
        const rules = bucket.Properties.LifecycleConfiguration.Rules as { NoncurrentVersionExpiration?: unknown }[];
        expect(rules.some((r) => r.NoncurrentVersionExpiration)).toBe(true);
      }
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("backup account vault stack", () => {
  it("is a separate app's stack, never part of the workload app", () => {
    const { stacks } = workload();
    expect(stacks.all.map((s) => s.component)).not.toContain("backup-vault");
    const { stack } = backupAccount();
    expect(stack.stackName).toBe(`supply-checkout-prod-${EAST}-backup-vault`);
    expect(stack.terminationProtection).toBe(true);
  });

  it("takes the account IDs as deploy-time parameters, never in the template", () => {
    const { template } = backupAccount();
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default?: string }>;
    expect(params.SourceAccountIds).toMatchObject({ Type: "CommaDelimitedList" });
    expect(params.SourceAccountIds?.Default).toBeUndefined();
    expect(params.RestoreAccountIds).toMatchObject({ Type: "CommaDelimitedList", Default: "" });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\d{12}/);
  });

  it("has a vault with its own rotating key and a compliance-mode lock", () => {
    const { template } = backupAccount();
    template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain", Properties: { EnableKeyRotation: true } });
    template.hasResource("AWS::Backup::BackupVault", {
      DeletionPolicy: "Retain",
      Properties: {
        BackupVaultName: "supply-checkout-prod-backup-copies",
        EncryptionKeyArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^VaultKey"), "Arn"] },
        LockConfiguration: {
          MinRetentionDays: MIN_LOCK_RETENTION.toDays(),
          MaxRetentionDays: MAX_LOCK_RETENTION.toDays(),
          ChangeableForDays: COMPLIANCE_GRACE_DAYS,
        },
      },
    });
  });

  it("accepts copies only from the source accounts, and denies deleting them", () => {
    const { template } = backupAccount();
    const vault = statements(template, "AWS::Backup::BackupVault", (p) => p.AccessPolicy as { Statement: Statement[] });
    expect(vault).toHaveLength(2);
    expect(vault).toContainEqual(
      expect.objectContaining({ Effect: "Deny", Action: ["backup:DeleteRecoveryPoint", "backup:UpdateRecoveryPointLifecycle"] }),
    );
    expect(vault.find((s) => s.Sid === "SourceAccountsCopyIn")).toMatchObject({
      Effect: "Allow",
      Action: "backup:CopyIntoBackupVault",
      Condition: { StringEquals: { "aws:PrincipalAccount": { Ref: "SourceAccountIds" } } },
    });
  });

  it("shares its key only with the restore accounts", () => {
    const { template } = backupAccount();
    const key = statements(template, "AWS::KMS::Key", (p) => p.KeyPolicy as { Statement: Statement[] });
    const shared = key.filter((s) => s.Sid);
    expect(shared.map((s) => s.Sid).sort()).toEqual(["RestoreAccountsCopyRecoveryPoints", "RestoreAccountsGrantToAwsBackup"]);
    for (const s of shared) {
      expect(s.Condition).toMatchObject({ StringEquals: { "aws:PrincipalAccount": { Ref: "RestoreAccountIds" } } });
      expect(actions(s)).not.toContain("kms:*");
    }
  });

  it("lets the copy-out role copy only into the restore accounts' supply-checkout vaults", () => {
    const { template } = backupAccount();
    const policy = policyStatements(template, "CopyOutRole");
    const copy = policy.find((s) => s.Sid === "CopyIntoRestoreAccountVaults");
    expect(copy?.Condition).toEqual({ StringEquals: { "aws:ResourceAccount": { Ref: "RestoreAccountIds" } } });
    expect(JSON.stringify(copy?.Resource)).toContain(":*:backup-vault:supply-checkout-*");
    template.hasOutput("CopyVaultArn", { Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^Vault"), "BackupVaultArn"] } });
  });

  it("is cdk-nag clean in every approved region", () => {
    for (const region of APPROVED_REGIONS) {
      const { app } = backupAccount({ regions: [region], primaryRegion: region });
      const report = new AwsSolutionsChecks(app).validateScope(app);
      expect(report.violations).toEqual([]);
      expect(() => app.synth()).not.toThrow();
    }
  });
});
