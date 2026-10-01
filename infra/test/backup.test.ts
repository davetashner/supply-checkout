import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_GRACE_DAYS,
  COPY_LOCK,
  COPY_RETENTION,
  LOCAL_RETENTION,
  WORKLOAD_LOCK,
  backupCopyFromContext,
  backupParameters,
} from "../lib/backup.js";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { BACKUP_CHANGE_EVENTS, BACKUP_KEY_EVENTS, DELETIONS_COPY_CHANGE_EVENTS, backupAlertRuleNames, deletionsCopyAlertRuleName } from "../lib/backup-alerts.js";
import { ACCOUNT_ID_PATTERN, COPIES_MISSING_AFTER_HOURS, OPTIONAL_ACCOUNT_ID_PATTERN, ORGANIZATION_ID_PATTERN } from "../lib/stacks/backup-account-stack.js";
import { addBackupAccount, addSupplyCheckout } from "../lib/supply-checkout.js";
import { DELETIONS_REPLICATION_RULE_ID, DELETIONS_REPLICATION_STUCK_MINUTES, deletionsReplicationRoleName } from "../lib/deletions.js";
import { DELETION_RECORD_RETENTION_DAYS, deletionsReplicaBucketName } from "../../backend/src/deletions/names.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };
const TABLE = "supply-checkout-prod-app";

function workload(context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  const app = testApp(context);
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  return { app, stacks, template: Template.fromStack(stacks.backup) };
}

function backupAccount(overrides: Partial<DeploymentConfig> = {}, context: Record<string, unknown> = {}) {
  const app = testApp(context);
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

type Rule = { Properties: { Name: string; EventPattern: Record<string, unknown>; Targets: { Arn: unknown }[] } };
const rules = (template: Template) => Object.values(template.findResources("AWS::Events::Rule")) as Rule[];
const byName = (template: Template, name: string) => rules(template).find((r) => r.Properties.Name === name) as Rule;
/** The ARN a topic policy uses for a rule of this name, in the stack's account and region. */
const ruleArn = (name: string) => ({
  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":events:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:rule/${name}`]],
});

/** Both accounts' change rules: the same patterns, on that account's vault key, to that account's topic. */
function expectChangeRules(template: Template, names: { changes: string; keyChanges: string }, topic: unknown, keyId: RegExp, others: string[] = []) {
  expect(rules(template).map((r) => r.Properties.Name).sort()).toEqual([names.changes, names.keyChanges, ...others].sort());
  expect(byName(template, names.changes).Properties.EventPattern).toEqual({
    source: ["aws.backup"],
    "detail-type": ["AWS API Call via CloudTrail"],
    detail: { eventSource: ["backup.amazonaws.com"], eventName: [...BACKUP_CHANGE_EVENTS] },
  });
  expect(byName(template, names.keyChanges).Properties.EventPattern).toEqual({
    source: ["aws.kms"],
    "detail-type": ["AWS API Call via CloudTrail"],
    detail: { eventSource: ["kms.amazonaws.com"], eventName: [...BACKUP_KEY_EVENTS], resources: { ARN: [{ "Fn::GetAtt": [expect.stringMatching(keyId), "Arn"] }] } },
  });
  for (const rule of rules(template)) {
    expect(rule.Properties.Targets).toEqual([expect.objectContaining({ Arn: topic })]);
    // Names the CloudTrail event, never the person
    const target = JSON.stringify(rule.Properties.Targets);
    expect(target).toContain("$.detail.eventID");
    expect(target).toContain("When backups are tampered with");
    expect(target).not.toContain("userIdentity");
  }
}

describe("backup change events", () => {
  it("cover a vault's access policy and lock, the plan, a selection and the vault key", () => {
    for (const name of [
      "PutBackupVaultAccessPolicy",
      "DeleteBackupVaultAccessPolicy",
      "PutBackupVaultLockConfiguration",
      "DeleteBackupVaultLockConfiguration",
      "DeleteBackupPlan",
      "DeleteBackupSelection",
    ]) {
      expect(BACKUP_CHANGE_EVENTS, name).toContain(name);
    }
    expect([...BACKUP_KEY_EVENTS].sort()).toEqual(["DisableKey", "PutKeyPolicy", "ScheduleKeyDeletion"]);
    expect(backupAlertRuleNames("prod", "workload")).toEqual({ changes: "supply-checkout-prod-backup-changes", keyChanges: "supply-checkout-prod-backup-key-changes" });
    expect(backupAlertRuleNames("prod", "backup-account")).toEqual({
      changes: "supply-checkout-prod-backup-vault-changes",
      keyChanges: "supply-checkout-prod-backup-vault-key-changes",
    });
  });
});

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
  it("keep each rule inside its vault's lock", () => {
    for (const [d, lock] of [
      [LOCAL_RETENTION, WORKLOAD_LOCK],
      [COPY_RETENTION, COPY_LOCK],
    ] as const) {
      expect(d.toDays()).toBeGreaterThanOrEqual(lock.minRetention.toDays());
      expect(d.toDays()).toBeLessThanOrEqual(lock.maxRetention.toDays());
    }
    // Fixed forever on the compliance vault once its grace period ends
    expect(COPY_LOCK.minRetention.toDays()).toBe(30);
    expect(COPY_LOCK.maxRetention.toDays()).toBe(365);
    expect(WORKLOAD_LOCK.minRetention.toDays()).toBe(7);
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
      "Fn::Join": ["", ["arn:aws:iam::", { "Fn::Select": [4, { "Fn::Split": [":", { Ref: copyVault }] }] }, ":root"]],
    };
    const key = statements(template, "AWS::KMS::Key", (p) => p.KeyPolicy as { Statement: Statement[] });
    const viaBackup = { "kms:ViaService": { "Fn::Join": ["", ["backup.", { Ref: "AWS::Region" }, ".amazonaws.com"]] } };
    expect(key.find((s) => s.Sid === "BackupAccountCopiesRecoveryPoints")).toMatchObject({
      Principal: { AWS: backupAccountRoot },
      // Read-only use: no Encrypt or ReEncrypt
      Action: ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"],
      Condition: { StringEquals: viaBackup },
    });
    const grant = key.find((s) => s.Sid === "BackupAccountGrantsToAwsBackup");
    expect(grant).toMatchObject({
      Action: "kms:CreateGrant",
      Condition: { StringEquals: viaBackup, Bool: { "kms:GrantIsForAWSResource": "true" } },
    });
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
    expect(params.map((p) => p.Default)).not.toContain(backupParameters("prod").organizationId);
    const key = statements(template, "AWS::KMS::Key", (p) => p.KeyPolicy as { Statement: Statement[] });
    expect(key.map((s) => s.Sid).filter(Boolean)).toEqual([]);
    const vault = statements(template, "AWS::Backup::BackupVault", (p) => p.AccessPolicy as { Statement: Statement[] });
    expect(vault.map((s) => s.Effect)).toEqual(["Deny"]);
    expect(policyStatements(template, "BackupRole").flatMap(actions)).not.toContain("backup:CopyIntoBackupVault");
    expect(policyStatements(template, "BackupRole").flatMap(actions)).not.toContain("backup:CopyFromBackupVault");
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
      ["BackUpTheTable", "CopyFromThisVault", "CopyToTheBackupAccount", "GrantKeysToAwsBackup", "ManageTheTablesBackups", "ReadTheTablesKey", "UseTheVaultKey"].sort(),
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
    expect(bySid.CopyToTheBackupAccount?.Condition).toEqual({
      StringEquals: { "aws:ResourceOrgID": { Ref: ssmParameter(template, backupParameters("prod").organizationId) } },
    });
    expect(actions(bySid.CopyFromThisVault as Statement)).toEqual(["backup:CopyFromBackupVault"]);
    expect(JSON.stringify(bySid.CopyFromThisVault?.Resource)).toContain(':recovery-point:*"');
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
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
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

  it("alarms to the P2 topic when a deletion record fails to replicate to the backup account, and not without the copy", () => {
    const { template } = workload();
    const topic = ssmParameter(template, "/supply-checkout/prod/observability/alarm-topic-p2-arn");
    const vault = ssmParameter(template, "/supply-checkout/prod/backup/copy-vault-arn");
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-deletions-replication-failed",
      Namespace: "AWS/S3",
      MetricName: "OperationsFailedReplication",
      Dimensions: [
        {
          Name: "DestinationBucket",
          Value: { "Fn::Join": ["", [`supply-checkout-prod-deletions-copy-${EAST}-`, { "Fn::Select": [4, { "Fn::Split": [":", { Ref: vault }] }] }]] },
        },
        { Name: "RuleId", Value: DELETIONS_REPLICATION_RULE_ID },
        { Name: "SourceBucket", Value: { "Fn::Join": ["", [`supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] } },
      ],
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 0,
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: topic }],
      OKActions: [{ Ref: topic }],
    });
    workload({ backupCopy: "false" }).template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("alarms to the P2 topic when a deletion record has waited an hour to replicate, pending or behind, and not without the copy (supply-checkout-72d.14)", () => {
    const { template } = workload();
    const topic = ssmParameter(template, "/supply-checkout/prod/observability/alarm-topic-p2-arn");
    const periods = DELETIONS_REPLICATION_STUCK_MINUTES / 15;
    expect(Number.isInteger(periods)).toBe(true);
    const metric = (name: string) =>
      Match.objectLike({
        Id: name === "OperationsPendingReplication" ? "pending" : "latency",
        ReturnData: false,
        MetricStat: Match.objectLike({
          Metric: Match.objectLike({ Namespace: "AWS/S3", MetricName: name, Dimensions: Match.arrayWith([{ Name: "RuleId", Value: DELETIONS_REPLICATION_RULE_ID }]) }),
          Period: 900,
          Stat: "Maximum",
        }),
      });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "supply-checkout-prod-p2-deletions-replication-stuck",
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: `IF(FILL(pending, 0) > 0 OR FILL(latency, 0) > ${DELETIONS_REPLICATION_STUCK_MINUTES * 60}, 1, 0)` }),
        metric("OperationsPendingReplication"),
        metric("ReplicationLatency"),
      ]),
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Threshold: 1,
      EvaluationPeriods: periods,
      DatapointsToAlarm: periods,
      TreatMissingData: "notBreaching",
      AlarmDescription: Match.stringLikeRegexp("When deletion records stop replicating"),
      AlarmActions: [{ Ref: topic }],
      OKActions: [{ Ref: topic }],
    });
    // Same dimensions as the failed-replication alarm
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties);
    const failed = alarms.find((a) => a.AlarmName === "supply-checkout-prod-p2-deletions-replication-failed");
    const stuck = alarms.find((a) => a.AlarmName === "supply-checkout-prod-p2-deletions-replication-stuck");
    for (const m of (stuck?.Metrics as { MetricStat?: { Metric: { Dimensions: unknown } } }[]).filter((m) => m.MetricStat)) {
      expect(m.MetricStat?.Metric.Dimensions).toEqual(failed?.Dimensions);
    }
    const names = Object.values(workload({ backupCopy: "false" }).template.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties.AlarmName);
    expect(names).not.toContain("supply-checkout-prod-p2-deletions-replication-stuck");
  });

  it("tells P1 when a vault policy or lock, the plan, a selection or the vault key changes, and P1 lets only those rules publish", () => {
    const { template, stacks } = workload();
    const names = backupAlertRuleNames("prod", "workload");
    const topic = { Ref: ssmParameter(template, "/supply-checkout/prod/observability/alarm-topic-p1-arn") };
    expectChangeRules(template, names, topic, /^VaultKey/);
    // With no copy to the backup account, the alerts are still there
    expect(rules(workload({ backupCopy: "false" }).template)).toHaveLength(2);
    // The observability stack's P1 topic lets these two rule names publish, and nothing else from EventBridge but its own rules
    const observability = Template.fromStack((stacks.regions[EAST] as (typeof stacks.regions)[string]).observability);
    const allow = Object.values(observability.findResources("AWS::SNS::TopicPolicy"))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
      .find((s) => s.Sid === "AllowBackupChangeAlertsToPublish");
    expect(allow).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sns:Publish",
      Resource: { Ref: expect.stringMatching(/^AlarmTopicsP1/) },
      Condition: { ArnEquals: { "aws:SourceArn": [ruleArn(names.changes), ruleArn(names.keyChanges)] } },
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
    expect(params.RestoreAccountIds).toMatchObject({ Type: "CommaDelimitedList", Default: "", AllowedPattern: OPTIONAL_ACCOUNT_ID_PATTERN });
    expect(params.SourceAccountIds).toMatchObject({ AllowedPattern: ACCOUNT_ID_PATTERN });
    expect(params.OrganizationId).toMatchObject({ Type: "String", AllowedPattern: ORGANIZATION_ID_PATTERN });
    expect(params.OrganizationId?.Default).toBeUndefined();
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\d{12}/);
  });

  it("validates each account ID and the organization ID", () => {
    const ok = (pattern: string, value: string) => new RegExp(pattern).test(value);
    expect(ok(ACCOUNT_ID_PATTERN, "0".repeat(12))).toBe(true);
    for (const bad of ["", "0".repeat(11), "0".repeat(13), "abcdefghijkl"]) expect(ok(ACCOUNT_ID_PATTERN, bad)).toBe(false);
    expect(ok(OPTIONAL_ACCOUNT_ID_PATTERN, "")).toBe(true);
    expect(ok(OPTIONAL_ACCOUNT_ID_PATTERN, "0".repeat(12))).toBe(true);
    expect(ok(OPTIONAL_ACCOUNT_ID_PATTERN, "0".repeat(11))).toBe(false);
    expect(ok(ORGANIZATION_ID_PATTERN, "o-abcdefghij")).toBe(true);
    expect(ok(ORGANIZATION_ID_PATTERN, "r-abcdefghij")).toBe(false);
  });

  it("has a vault with its own rotating key and a compliance-mode lock", () => {
    const { template } = backupAccount();
    template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain", Properties: { EnableKeyRotation: true } });
    template.hasResource("AWS::Backup::BackupVault", {
      DeletionPolicy: "Retain",
      Properties: {
        BackupVaultName: "supply-checkout-prod-backup-copies",
        EncryptionKeyArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^VaultKey"), "Arn"] },
        LockConfiguration: { MinRetentionDays: 30, MaxRetentionDays: 365, ChangeableForDays: COMPLIANCE_GRACE_DAYS },
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
      Condition: { StringEquals: { "aws:PrincipalAccount": { Ref: "SourceAccountIds" }, "aws:PrincipalOrgID": { Ref: "OrganizationId" } } },
    });
  });

  it("shares its key only with the restore accounts", () => {
    const { template } = backupAccount();
    const vaultKey = Object.entries(template.findResources("AWS::KMS::Key")).filter(([id]) => id.startsWith("VaultKey"));
    expect(vaultKey).toHaveLength(1);
    const key = vaultKey.flatMap(([, r]) => (r.Properties.KeyPolicy as { Statement: Statement[] }).Statement);
    const shared = key.filter((s) => s.Sid);
    expect(shared.map((s) => s.Sid).sort()).toEqual(["RestoreAccountsCopyRecoveryPoints", "RestoreAccountsGrantToAwsBackup"]);
    for (const s of shared) {
      expect(s.Condition).toMatchObject({
        StringEquals: { "aws:PrincipalAccount": { Ref: "RestoreAccountIds" }, "aws:PrincipalOrgID": { Ref: "OrganizationId" } },
      });
      expect(actions(s)).not.toContain("kms:*");
      expect(actions(s)).not.toContain("kms:Encrypt");
    }
  });

  it("lets the copy-out role copy only into the restore accounts' supply-checkout vaults", () => {
    const { template } = backupAccount();
    const policy = policyStatements(template, "CopyOutRole");
    const copy = policy.find((s) => s.Sid === "CopyIntoRestoreAccountVaults");
    expect(copy?.Condition).toEqual({
      StringEquals: { "aws:ResourceAccount": { Ref: "RestoreAccountIds" }, "aws:ResourceOrgID": { Ref: "OrganizationId" } },
    });
    expect(policy.find((s) => s.Sid === "CopyFromThisVault")?.Action).toBe("backup:CopyFromBackupVault");
    expect(JSON.stringify(copy?.Resource)).toContain(":*:backup-vault:supply-checkout-*");
    template.hasOutput("CopyVaultArn", { Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^Vault"), "BackupVaultArn"] } });
  });

  it("alarms on its own topic when no copy completes in the vault for 36 hours, and treats no data as no copy", () => {
    const { template } = backupAccount();
    expect(COPIES_MISSING_AFTER_HOURS).toBe(36);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    const topic = { Ref: expect.stringMatching(/^AlertTopic/) };
    const [alarm] = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
    expect(alarm?.Properties).toMatchObject({
      AlarmName: "supply-checkout-prod-backup-copies-missing",
      ComparisonOperator: "LessThanThreshold",
      Threshold: 1,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: "breaching",
      AlarmActions: [topic],
      OKActions: [topic],
    });
    const metrics = alarm?.Properties.Metrics as { Id: string; Expression?: string; MetricStat?: { Metric: unknown; Period: number; Stat: string } }[];
    expect(metrics.find((m) => m.Expression)?.Expression).toBe("FILL(vault, 0) + FILL(dynamodb, 0)");
    const vault = { Name: "BackupVaultName", Value: "supply-checkout-prod-backup-copies" };
    expect(metrics.filter((m) => m.MetricStat)).toEqual([
      { Id: "vault", ReturnData: false, MetricStat: { Metric: { Namespace: "AWS/Backup", MetricName: "NumberOfRecoveryPointsCompleted", Dimensions: [vault] }, Period: 43200, Stat: "Sum" } },
      {
        Id: "dynamodb",
        ReturnData: false,
        MetricStat: {
          Metric: { Namespace: "AWS/Backup", MetricName: "NumberOfRecoveryPointsCompleted", Dimensions: [vault, { Name: "ResourceType", Value: "DynamoDB" }] },
          Period: 43200,
          Stat: "Sum",
        },
      },
    ]);
    // 3 periods of 12 hours
    expect(3 * 12).toBe(COPIES_MISSING_AFTER_HOURS);
  });

  it("alerts when a vault policy or lock, a plan, a selection or the vault key changes", () => {
    const { template } = backupAccount();
    expectChangeRules(template, backupAlertRuleNames("prod", "backup-account"), { Ref: expect.stringMatching(/^AlertTopic/) }, /^VaultKey/, [deletionsCopyAlertRuleName("prod")]);
  });

  it("alerts when the deletion records copy's policy, ownership, Object Lock or versioning changes (supply-checkout-72d.13)", () => {
    const { template } = backupAccount();
    expect([...DELETIONS_COPY_CHANGE_EVENTS]).toEqual(
      expect.arrayContaining([
        "PutBucketPolicy",
        "DeleteBucketPolicy",
        "PutBucketOwnershipControls",
        "PutObjectLockConfiguration",
        "PutBucketVersioning",
        "PutBucketLifecycle",
        "DeleteBucketLifecycle",
        "PutBucketPublicAccessBlock",
        "DeleteBucketPublicAccessBlock",
      ]),
    );
    const rule = byName(template, deletionsCopyAlertRuleName("prod"));
    expect(rule.Properties.EventPattern).toEqual({
      source: ["aws.s3"],
      "detail-type": ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["s3.amazonaws.com"],
        eventName: [...DELETIONS_COPY_CHANGE_EVENTS],
        requestParameters: { bucketName: [{ "Fn::Join": ["", [`supply-checkout-prod-deletions-copy-`, { Ref: "AWS::Region" }, "-", { Ref: "AWS::AccountId" }]] }] },
      },
    });
  });

  it("emails the alerts to the addresses in this account's SSM parameters, over an encrypted topic only its alarms and rules may use", () => {
    const { template } = backupAccount();
    template.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: "supply-checkout-prod-backup-alerts",
      KmsMasterKeyId: { "Fn::GetAtt": [Match.stringLikeRegexp("^AlertKey"), "Arn"] },
    });
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: { Ref: ssmParameter(template, "/supply-checkout/prod/alarms/email-1") },
    });
    expect(backupAccount({}, { alarmContacts: '{"email":2}' }).template.findResources("AWS::SNS::Subscription")).toSatisfy(
      (subs: object) => Object.keys(subs).length === 2,
    );
    const policy = statements(template, "AWS::SNS::TopicPolicy", (p) => p.PolicyDocument as { Statement: Statement[] });
    const allows = policy.filter((s) => s.Effect === "Allow");
    expect(allows.map((s) => s.Sid).sort()).toEqual(["AllowBackupChangeAlertsToPublish", "AllowCloudWatchAlarmsToPublish"]);
    const names = backupAlertRuleNames("prod", "backup-account");
    expect(allows.find((s) => s.Sid === "AllowBackupChangeAlertsToPublish")).toMatchObject({
      Principal: { Service: "events.amazonaws.com" },
      Action: "sns:Publish",
      Condition: { ArnEquals: { "aws:SourceArn": [ruleArn(names.changes), ruleArn(names.keyChanges), ruleArn(deletionsCopyAlertRuleName("prod"))] } },
    });
    expect(allows.find((s) => s.Sid === "AllowCloudWatchAlarmsToPublish")?.Condition).toMatchObject({
      StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
    });
    expect(policy).toContainEqual(expect.objectContaining({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }));
    const alertKey = Object.entries(template.findResources("AWS::KMS::Key")).find(([id]) => id.startsWith("AlertKey"))?.[1];
    expect(alertKey?.Properties.EnableKeyRotation).toBe(true);
    const services = (alertKey?.Properties.KeyPolicy.Statement as Statement[]).find((s) => s.Sid === "AlarmsAndRulesPublishToTheTopic");
    expect(services).toMatchObject({
      Principal: { Service: ["cloudwatch.amazonaws.com", "events.amazonaws.com"] },
      Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
      Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
    });
    // Still no address or account ID in the template
    expect(JSON.stringify(template.toJSON())).not.toMatch(/@|\d{12}/);
  });

  it("keeps the deletion records' replica under a compliance-mode lock as long as the source, owned by this account, and retained", () => {
    const { template } = backupAccount();
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        BucketName: { "Fn::Join": ["", [`supply-checkout-prod-deletions-copy-`, { Ref: "AWS::Region" }, "-", { Ref: "AWS::AccountId" }]] },
        VersioningConfiguration: { Status: "Enabled" },
        ObjectLockEnabled: true,
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: DELETION_RECORD_RETENTION_DAYS } } },
        LifecycleConfiguration: { Rules: [{ ExpirationInDays: DELETION_RECORD_RETENTION_DAYS + 1, NoncurrentVersionExpiration: { NoncurrentDays: 1 }, Status: "Enabled" }] },
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        LoggingConfiguration: { LogFilePrefix: "s3/deletions-copy/", DestinationBucketName: Match.anyValue() },
      },
    });
    expect(DELETION_RECORD_RETENTION_DAYS).toBeGreaterThanOrEqual(400);
    template.hasOutput("DeletionsReplicaBucket", { Value: { Ref: Match.stringLikeRegexp("^DeletionsReplica") } });
    // S3 bucket names are at most 63 characters, even for the longest environment name
    for (const region of APPROVED_REGIONS) expect(deletionsReplicaBucketName("staging", region, "0".repeat(12)).length).toBeLessThanOrEqual(63);
  });

  it("lets only the source accounts' replication role, in the organization, replicate into the replica, and nothing more", () => {
    const { template } = backupAccount();
    const policies = Object.values(template.findResources("AWS::S3::BucketPolicy")).filter((p) => JSON.stringify(p.Properties.Bucket).includes("DeletionsReplica"));
    expect(policies).toHaveLength(1);
    const statements = policies[0]?.Properties.PolicyDocument.Statement as Statement[];
    const allows = statements.filter((st) => st.Effect === "Allow");
    expect(allows.map((st) => st.Sid).sort()).toEqual(["SourceAccountsCheckTheBucket", "SourceAccountsReplicateRecords"]);
    const role = {
      StringEquals: { "aws:PrincipalAccount": { Ref: "SourceAccountIds" }, "aws:PrincipalOrgID": { Ref: "OrganizationId" } },
      ArnLike: { "aws:PrincipalArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:iam::*:role/${deletionsReplicationRoleName("prod")}`]] } },
    };
    for (const st of allows) expect(st.Condition).toEqual(role);
    expect(allows.find((st) => st.Sid === "SourceAccountsReplicateRecords")?.Action).toEqual(["s3:ObjectOwnerOverrideToBucketOwner", "s3:ReplicateObject"]);
    expect(allows.find((st) => st.Sid === "SourceAccountsCheckTheBucket")?.Action).toEqual(["s3:GetBucketObjectLockConfiguration", "s3:GetBucketVersioning"]);
    for (const st of allows) expect(actions(st).some((a) => /Delete|Put|\*/.test(a))).toBe(false);
    // Every other statement refuses anything but TLS
    for (const st of statements.filter((st) => st.Effect !== "Allow")) expect(st.Condition).toEqual({ Bool: { "aws:SecureTransport": "false" } });
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
