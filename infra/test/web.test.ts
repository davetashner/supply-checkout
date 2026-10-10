import { readFileSync } from "node:fs";
import { Aws, Stack } from "aws-cdk-lib";
import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { domainOutputParameters, hostNames } from "../lib/domain.js";
import { DELETION_RECORD_RETENTION_DAYS } from "../../backend/src/deletions/names.js";
import { photosBucketName, photosHost } from "../../backend/src/photos/names.js";
import { webBucketName } from "../lib/stacks/data-stack.js";
import { DELETIONS_REPLICATION_RULE_ID, deletionsReplicationRoleName } from "../lib/deletions.js";
import { MANAGED_RULE_GROUPS, OPS_CHANNEL, RATE_LIMIT_PER_5_MINUTES, RELEASE_CHANNELS, webOutputParameters } from "../lib/stacks/web-stack.js";
import { contentSecurityPolicy, cspDirectives } from "../lib/web/content-security-policy.js";
import { opsContentSecurityPolicy, opsCspDirectives } from "../lib/web/ops-content-security-policy.js";
import { RUM_SESSION_SAMPLE_RATE, RUM_TELEMETRIES, rumAppMonitorName } from "../lib/web/rum.js";
import { PUBLISHER_PARAMETERS } from "../lib/web/publisher.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };
const names = hostNames(config);
// The CSP's hosts: the web stack's RUM app monitor is in GLOBAL_SERVICES_REGION
// and the photos bucket in the primary region (supply-checkout-6uw.30)
const cspHosts = { ...names, rumRegion: GLOBAL_SERVICES_REGION, photos: photosHost(photosBucketName("prod", EAST, Aws.ACCOUNT_ID), EAST) };

function build(overrides: Partial<DeploymentConfig> = {}) {
  const app = testApp();
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  const data = (region: string) => {
    const r = stacks.regions[region];
    if (!r) throw new Error(`No stacks in ${region}`);
    return Template.fromStack(r.data);
  };
  return { stacks, web: Template.fromStack(stacks.web), data };
}

describe("web bucket (data stack)", () => {
  it("is in the primary region's data stack only, named with its region, and retained", () => {
    const { data } = build();
    data(EAST).hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        BucketName: { "Fn::Join": ["", [`supply-checkout-prod-web-${EAST}-`, { Ref: "AWS::AccountId" }]] },
        VersioningConfiguration: { Status: "Enabled" },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LoggingConfiguration: { LogFilePrefix: "s3/web/", DestinationBucketName: Match.anyValue() },
      },
    });
    // The second region's bucket and replication are phase 2 (supply-checkout-d79)
    data(WEST).resourceCountIs("AWS::S3::Bucket", 0);
    expect(webBucketName("prod", EAST, "0".repeat(12))).toBe(`supply-checkout-prod-web-${EAST}-${"0".repeat(12)}`);
  });

  it("lets only this account's CloudFront distributions read it, over TLS", () => {
    const { data } = build();
    const policies = Object.values(data(EAST).findResources("AWS::S3::BucketPolicy"));
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const read = statements.find((s) => s.Sid === "CloudFrontReadsReleases");
    expect(read).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: ["s3:GetObject", "s3:ListBucket"],
      Condition: {
        StringEquals: { "AWS:SourceAccount": { Ref: "AWS::AccountId" } },
        ArnLike: { "AWS:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudfront::", { Ref: "AWS::AccountId" }, ":distribution/*"]] } },
      },
    });
    expect(statements.filter((s) => s.Effect === "Deny" && s.Condition?.Bool?.["aws:SecureTransport"] === "false").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps logs for a year in a bucket CloudFront can write to", () => {
    const { data } = build();
    data(EAST).hasResourceProperties("AWS::S3::Bucket", {
      BucketName: { "Fn::Join": ["", [`supply-checkout-prod-logs-${EAST}-`, { Ref: "AWS::AccountId" }]] },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerPreferred" }] },
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 365, Status: "Enabled" })] },
    });
  });

  it("publishes the bucket name", () => {
    build().data(EAST).hasResourceProperties("AWS::SSM::Parameter", { Name: "/supply-checkout/prod/data/web-bucket-name" });
  });
});

describe("deletion records bucket (data stack, supply-checkout-0ic7)", () => {
  it("keeps each record under a compliance-mode lock for longer than any backup, then expires it, and is retained", () => {
    const { data } = build();
    data(EAST).hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        BucketName: { "Fn::Join": ["", [`supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] },
        VersioningConfiguration: { Status: "Enabled" },
        ObjectLockEnabled: true,
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: DELETION_RECORD_RETENTION_DAYS } } },
        LifecycleConfiguration: { Rules: [{ ExpirationInDays: DELETION_RECORD_RETENTION_DAYS + 1, NoncurrentVersionExpiration: { NoncurrentDays: 1 }, Status: "Enabled" }] },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        LoggingConfiguration: { LogFilePrefix: "s3/deletions/", DestinationBucketName: Match.anyValue() },
      },
    });
    // Longer than the vault locks' 365-day maximum retention
    expect(DELETION_RECORD_RETENTION_DAYS).toBeGreaterThan(365);
    build().data(EAST).hasResourceProperties("AWS::SSM::Parameter", { Name: "/supply-checkout/prod/data/deletions-bucket-name" });
  });

  it("refuses anything but TLS, and grants nobody anything in its bucket policy", () => {
    const { data } = build();
    const policies = Object.values(data(EAST).findResources("AWS::S3::BucketPolicy")).filter((p) => JSON.stringify(p.Properties.Bucket).includes("DeletionsBucket"));
    expect(policies).toHaveLength(1);
    const statements = policies[0]?.Properties.PolicyDocument.Statement as { Effect: string }[];
    expect(statements.map((st) => st.Effect)).toEqual(["Deny"]);
  });

  describe("replication to the backup account (supply-checkout-72d.10)", () => {
    const deletionsBucket = (template: Template) =>
      Object.entries(template.findResources("AWS::S3::Bucket")).find(([id]) => id.startsWith("DeletionsBucket")) as [string, { Properties: Record<string, unknown>; DependsOn?: string[] }];
    const vaultParam = (template: Template) =>
      Object.entries(template.toJSON().Parameters as Record<string, { Default?: string }>).find(([, p]) => p.Default === "/supply-checkout/prod/backup/copy-vault-arn")?.[0] as string;
    const orgParam = (template: Template) =>
      Object.entries(template.toJSON().Parameters as Record<string, { Default?: string }>).find(([, p]) => p.Default === "/supply-checkout/prod/backup/organization-id")?.[0] as string;
    const backupAccount = (template: Template) => ({ "Fn::Select": [4, { "Fn::Split": [":", { Ref: vaultParam(template) }] }] });
    const replicaArn = (template: Template) => ({
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-deletions-copy-${EAST}-`, backupAccount(template)]],
    });
    const sourceArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] };
    type Statement = { Sid: string; Action: string | string[]; Resource: unknown; Condition?: unknown };

    it("replicates every new record to the backup account's replica, owned there, with no delete markers and with metrics", () => {
      const template = build().data(EAST);
      expect(vaultParam(template)).toBeDefined();
      const [, bucket] = deletionsBucket(template);
      expect(bucket.Properties.ReplicationConfiguration).toEqual({
        Role: { "Fn::GetAtt": [expect.stringMatching(/^DeletionsReplicationRole/), "Arn"] },
        Rules: [
          {
            Id: DELETIONS_REPLICATION_RULE_ID,
            Priority: 1,
            Status: "Enabled",
            Filter: { Prefix: "" },
            DeleteMarkerReplication: { Status: "Disabled" },
            Destination: {
              Bucket: replicaArn(template),
              Account: backupAccount(template),
              AccessControlTranslation: { Owner: "Destination" },
              Metrics: { Status: "Enabled" },
            },
          },
        ],
      });
      // The role's permissions exist before S3 is told to use it
      expect(bucket.DependsOn?.some((d) => d.startsWith("DeletionsReplicationRoleDefaultPolicy"))).toBe(true);
    });

    it("uses a role only S3, for this bucket in this account, may assume, that reads this bucket and writes only into the replica in the organization", () => {
      const template = build().data(EAST);
      template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: deletionsReplicationRoleName("prod"),
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Principal: { Service: "s3.amazonaws.com" },
              Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } }, ArnLike: { "aws:SourceArn": sourceArn } },
            },
          ],
        },
      });
      const [policy] = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p.Properties.Roles).includes("DeletionsReplicationRole"));
      const statements = policy?.Properties.PolicyDocument.Statement as Statement[];
      const inOrg = { StringEquals: { "aws:ResourceAccount": backupAccount(template), "aws:ResourceOrgID": { Ref: orgParam(template) } } };
      const objects = (arn: unknown) => ({ "Fn::Join": ["", [...(arn as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1], "/*"]] });
      expect(statements).toEqual([
        { Sid: "ReadTheReplicationConfiguration", Effect: "Allow", Action: ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource: sourceArn },
        {
          Sid: "ReadRecordVersions",
          Effect: "Allow",
          Action: ["s3:GetObjectLegalHold", "s3:GetObjectRetention", "s3:GetObjectVersionAcl", "s3:GetObjectVersionForReplication"],
          Resource: objects(sourceArn),
        },
        {
          Sid: "WriteReplicasToTheBackupAccount",
          Effect: "Allow",
          Action: ["s3:ObjectOwnerOverrideToBucketOwner", "s3:ReplicateObject"],
          Resource: objects(replicaArn(template)),
          Condition: inOrg,
        },
        {
          Sid: "CheckTheReplicaBucket",
          Effect: "Allow",
          Action: ["s3:GetBucketObjectLockConfiguration", "s3:GetBucketVersioning"],
          Resource: replicaArn(template),
          Condition: inOrg,
        },
      ]);
      // Nothing that could remove or overwrite a replica
      expect(statements.flatMap((st) => [st.Action].flat()).filter((a) => /Delete|Put|\*/.test(a))).toEqual([]);
    });

    it("is left out, with no backup parameters read, with backupCopy=false", () => {
      const app = testApp({ backupCopy: "false" });
      const stacks = addSupplyCheckout(app, config);
      const template = Template.fromStack(stacks.regions[EAST]?.data as Stack);
      expect(deletionsBucket(template)[1].Properties.ReplicationConfiguration).toBeUndefined();
      template.resourceCountIs("AWS::IAM::Role", 0);
      expect(vaultParam(template)).toBeUndefined();
      expect(stacks.regions[EAST]?.data.deletionsReplicationRole).toBeUndefined();
    });

    it("is only in the primary region", () => {
      const template = build().data(WEST);
      template.resourceCountIs("AWS::S3::Bucket", 0);
      template.resourceCountIs("AWS::IAM::Role", 0);
    });
  });
});

describe("web stack", () => {
  it("is in the global services region even when the primary region is another", () => {
    expect(build().stacks.web.region).toBe(GLOBAL_SERVICES_REGION);
    const { stacks, web } = build({ regions: [WEST], primaryRegion: WEST });
    expect(stacks.web.region).toBe(GLOBAL_SERVICES_REGION);
    // ... and reads the bucket from the primary region
    const [distribution] = Object.values(web.findResources("AWS::CloudFront::Distribution"));
    expect(JSON.stringify(distribution.Properties.DistributionConfig.Origins)).toContain(`supply-checkout-prod-web-${WEST}-`);
  });

  it("serves the apex, www. and app. over HTTPS with the domain stack's certificate", () => {
    const { web } = build();
    web.hasParameter("*", { Type: "AWS::SSM::Parameter::Value<String>", Default: domainOutputParameters("prod").webCertificateArn });
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: [names.apex, names.www, names.app],
        ViewerCertificate: {
          AcmCertificateArn: { Ref: Match.stringLikeRegexp("webcertificatearn") },
          MinimumProtocolVersion: "TLSv1.2_2021",
          SslSupportMethod: "sni-only",
        },
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https", Compress: true }),
        WebACLId: { "Fn::GetAtt": ["WebAcl", "Arn"] },
        Logging: Match.objectLike({ Prefix: "cloudfront/web/" }),
      },
    });
  });

  it("reads the bucket through origin access control", () => {
    const { web } = build();
    // One for each distribution: the web app's and the operator page's
    web.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
    web.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: "s3", SigningBehavior: "always" }),
    });
  });

  it("routes every request through the router function, which reads the live-version store", () => {
    const { web } = build();
    web.hasResourceProperties("AWS::CloudFront::KeyValueStore", {
      ImportSource: Match.objectLike({ SourceType: "S3" }),
    });
    web.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionConfig: Match.objectLike({
        Runtime: "cloudfront-js-2.0",
        KeyValueStoreAssociations: [{ KeyValueStoreARN: { "Fn::GetAtt": [Match.stringLikeRegexp("LiveVersions"), "Arn"] } }],
      }),
      AutoPublish: true,
    });
    const [fn] = Object.values(web.findResources("AWS::CloudFront::Function"));
    const code = JSON.stringify(fn.Properties.FunctionCode);
    expect(code).not.toMatch(/__[A-Z_]+__/);
    expect(code).toContain("LiveVersions");
    // The redirects' fixed hosts, and the same HSTS as the response headers policy
    const text = (fn.Properties.FunctionCode["Fn::Join"][1] as unknown[]).filter((part) => typeof part === "string").join("");
    for (const host of [names.apex, names.www, names.app]) expect(text).toContain(`"${host}"`);
    expect(text).toContain('const HSTS = "max-age=63072000; includeSubDomains";');
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: Match.anyValue() }],
        }),
      },
    });
    expect(RELEASE_CHANNELS).toEqual(["app", "demo"]);
  });

  it("sends CSP, HSTS and the other security headers", () => {
    const { web, stacks } = build();
    web.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentSecurityPolicy: { ContentSecurityPolicy: Stack.of(stacks.web).resolve(contentSecurityPolicy(cspHosts)), Override: true },
          StrictTransportSecurity: { AccessControlMaxAgeSec: 63072000, IncludeSubdomains: true, Override: true },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
        },
        CustomHeadersConfig: {
          Items: [
            Match.objectLike({ Header: "Permissions-Policy", Value: Match.stringLikeRegexp("camera=\\(self\\)") }),
            { Header: "Cross-Origin-Opener-Policy", Value: "same-origin", Override: true },
          ],
        },
      }),
    });
  });

  it("puts a rate limit and AWS managed rules in the CloudFront-scoped web ACL", () => {
    const { web } = build();
    const [acl] = Object.values(web.findResources("AWS::WAFv2::WebACL"));
    expect(acl.Properties.Scope).toBe("CLOUDFRONT");
    expect(acl.Properties.DefaultAction).toEqual({ Allow: {} });
    const rules = acl.Properties.Rules;
    expect(rules[0]).toMatchObject({
      Name: "RateLimitPerIp",
      Priority: 0,
      Action: { Block: {} },
      Statement: { RateBasedStatement: { Limit: RATE_LIMIT_PER_5_MINUTES, AggregateKeyType: "IP" } },
    });
    expect(rules.slice(1).map((r: { Statement: { ManagedRuleGroupStatement: { Name: string } } }) => r.Statement.ManagedRuleGroupStatement.Name)).toEqual([
      ...MANAGED_RULE_GROUPS,
    ]);
    for (const rule of rules) expect(rule.VisibilityConfig.CloudWatchMetricsEnabled).toBe(true);
  });

  it("points A and AAAA alias records for the apex, www. and app. at the distribution", () => {
    const { web } = build();
    for (const host of [names.apex, names.www, names.app]) {
      for (const Type of ["A", "AAAA"]) {
        web.hasResourceProperties("AWS::Route53::RecordSet", {
          Name: `${host}.`,
          Type,
          AliasTarget: Match.objectLike({ DNSName: { "Fn::GetAtt": [Match.stringLikeRegexp("Distribution"), "DomainName"] } }),
        });
      }
    }
    // And ops. (the operator page's distribution, below)
    web.resourceCountIs("AWS::Route53::RecordSet", 8);
  });

  it("publishes what scripts/publish-web.mjs needs", () => {
    const { web } = build();
    for (const name of Object.values(webOutputParameters("prod"))) {
      web.hasResourceProperties("AWS::SSM::Parameter", { Name: name, Type: "String" });
    }
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: webOutputParameters("prod").bucketRegion, Value: EAST });
  });
});

describe("operator page (ops., supply-checkout-gxlt)", () => {
  const opsDistribution = (web: Template) => {
    const found = Object.entries(web.findResources("AWS::CloudFront::Distribution")).filter(([, d]) => JSON.stringify(d.Properties.DistributionConfig.Aliases) === JSON.stringify([names.ops]));
    expect(found).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a CloudFormation resource's properties
    return found[0] as [string, { Properties: { DistributionConfig: Record<string, any> } }];
  };

  it("is its own distribution for ops. alone, with its own certificate, and the web app's has no ops.", () => {
    const { web } = build();
    web.resourceCountIs("AWS::CloudFront::Distribution", 2);
    const [, ops] = opsDistribution(web);
    const config = ops.Properties.DistributionConfig;
    expect(config.Aliases).toEqual(["ops.supplycheckout.com"]);
    expect(JSON.stringify(config.ViewerCertificate.AcmCertificateArn).toLowerCase()).toContain("opswebcertificatearn");
    expect(config.ViewerCertificate).toMatchObject({ MinimumProtocolVersion: "TLSv1.2_2021", SslSupportMethod: "sni-only" });
    expect(config.WebACLId).toEqual({ "Fn::GetAtt": ["WebAcl", "Arn"] });
    expect(config.Logging).toMatchObject({ Prefix: "cloudfront/ops/" });
    expect(config.HttpVersion).toBe("http2and3");
    web.hasParameter("*", { Type: "AWS::SSM::Parameter::Value<String>", Default: domainOutputParameters("prod").opsWebCertificateArn });
    for (const [, d] of Object.entries(web.findResources("AWS::CloudFront::Distribution"))) {
      const aliases = d.Properties.DistributionConfig.Aliases as string[];
      if (!aliases.includes(names.ops)) expect(aliases).not.toContain(names.ops);
    }
  });

  it("caches nothing, takes only GET and HEAD over HTTPS, and routes through its own router", () => {
    const { web } = build();
    const [, ops] = opsDistribution(web);
    const behavior = ops.Properties.DistributionConfig.DefaultCacheBehavior;
    // AWS's managed CachingDisabled policy
    expect(behavior.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    expect(behavior.AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(behavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(behavior.FunctionAssociations).toEqual([{ EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [expect.stringMatching(/^OpsRouter/), "FunctionARN"] } }]);
    expect(behavior.ResponseHeadersPolicyId).toEqual({ Ref: expect.stringMatching(/^OpsSecurityHeaders/) });
    // Its router reads the same store, and is filled in with ops. and HSTS
    const [, fn] = Object.entries(web.findResources("AWS::CloudFront::Function")).find(([id]) => id.startsWith("OpsRouter")) ?? [];
    const text = JSON.stringify(fn?.Properties.FunctionCode);
    expect(text).not.toMatch(/__[A-Z_]+__/);
    expect(text).toContain('const OPS = \\"ops.supplycheckout.com\\"');
    expect(text).toContain("LiveVersions");
    expect(OPS_CHANNEL).toBe("ops");
    // The store's seed is unchanged: adding a key there would replace the store
    expect(RELEASE_CHANNELS).toEqual(["app", "demo"]);
  });

  it("sends a strict CSP, no-store, HSTS, DENY framing and no referrer", () => {
    const { web } = build();
    const [, policy] = Object.entries(web.findResources("AWS::CloudFront::ResponseHeadersPolicy")).find(([id]) => id.startsWith("OpsSecurityHeaders")) ?? [];
    const config = policy?.Properties.ResponseHeadersPolicyConfig;
    expect(config.SecurityHeadersConfig).toEqual({
      ContentSecurityPolicy: { ContentSecurityPolicy: opsContentSecurityPolicy({ api: names.api, opsAuth: names.opsAuth }), Override: true },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 63072000, IncludeSubdomains: true, Override: true },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: "DENY", Override: true },
      ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
    });
    const headers = Object.fromEntries(config.CustomHeadersConfig.Items.map((h: { Header: string; Value: string }) => [h.Header, h.Value]));
    expect(headers).toEqual({
      "Cache-Control": "no-store",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex, nofollow",
    });
  });

  it("the CSP allows only the page's own files, the API and the operator sign-in", () => {
    const d = opsCspDirectives({ api: names.api, opsAuth: names.opsAuth });
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["connect-src"]).toEqual(["'self'", "https://api.supplycheckout.com", "https://ops-auth.supplycheckout.com"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["require-trusted-types-for"]).toEqual(["'script'"]);
    // No workers or manifest: worker-src would otherwise fall back to script-src 'self'
    expect(d["worker-src"]).toEqual(["'none'"]);
    expect(d["manifest-src"]).toEqual(["'none'"]);
    for (const [name, values] of Object.entries(d)) {
      for (const value of values) {
        expect(value, name).not.toMatch(/unsafe|\*|data:|blob:|\/\/auth\.|realtime\./);
        if (value.startsWith("https://")) expect(name).toBe("connect-src");
      }
    }
    expect(() => opsCspDirectives({ api: "api.example.com; script-src *", opsAuth: names.opsAuth })).toThrow(/host name/);
    expect(() => opsCspDirectives({ api: names.api, opsAuth: "" })).toThrow(/host name/);
  });

  it("points A and AAAA records for ops. at its own distribution, and publishes its IDs", () => {
    const { web } = build();
    const [id] = opsDistribution(web);
    for (const Type of ["A", "AAAA"]) {
      web.hasResourceProperties("AWS::Route53::RecordSet", { Name: "ops.supplycheckout.com.", Type, AliasTarget: Match.objectLike({ DNSName: { "Fn::GetAtt": [id, "DomainName"] } }) });
    }
    const out = webOutputParameters("prod");
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: out.opsDistributionId, Value: { Ref: id } });
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: out.opsRouterFunctionName });
  });
});

describe("web publisher role (supply-checkout-pbp.28)", () => {
  type Statement = { Sid: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
  const publisher = () => {
    const { web } = build();
    const roles = web.findResources("AWS::IAM::Role", { Properties: { RoleName: "supply-checkout-prod-web-publisher" } });
    const [id, role] = Object.entries(roles)[0] ?? [];
    expect(id).toBeDefined();
    const policies = Object.values(web.findResources("AWS::IAM::Policy")).filter((p) =>
      (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === id),
    );
    expect(policies).toHaveLength(1);
    return { role, statements: policies[0]?.Properties.PolicyDocument.Statement as Statement[] };
  };

  it("can be assumed only by the GitHub deploy role, with no managed policy and one-hour sessions", () => {
    const { role } = publisher();
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        // This account (the stack's region fixes the partition), narrowed to the deploy role by the condition
        Principal: { AWS: { "Fn::Join": ["", ["arn:aws:iam::", { Ref: "AWS::AccountId" }, ":root"]] } },
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":role/supply-checkout-prod-github-deploy"]] },
          },
        },
      },
    ]);
  });

  it("may only read publish-web's parameters, upload under releases/, switch live versions and test the router", () => {
    const { statements } = publisher();
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));
    expect(Object.keys(bySid).sort()).toEqual(["CheckRouter", "ListReleases", "ReadDistributionAliases", "ReadPublishParameters", "SwitchLiveVersions", "UploadReleases"]);
    const all = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(all.sort()).toEqual([
      "cloudfront-keyvaluestore:DescribeKeyValueStore",
      "cloudfront-keyvaluestore:GetKey",
      "cloudfront-keyvaluestore:ListKeys",
      "cloudfront-keyvaluestore:PutKey",
      "cloudfront:DescribeFunction",
      "cloudfront:GetDistributionConfig",
      "cloudfront:TestFunction",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]);
    expect(statements.every((s) => s.Effect === "Allow")).toBe(true);
    expect(JSON.stringify(bySid.UploadReleases?.Resource)).toContain(`${webBucketName("prod", EAST, "")}`.replace(/-$/, ""));
    expect(JSON.stringify(bySid.UploadReleases?.Resource)).toMatch(/\/releases\/\*"/);
    expect(bySid.ListReleases?.Condition).toEqual({ StringLike: { "s3:prefix": ["releases/*"] } });
    // Exactly the store, the routers and the distribution: each a reference, not a wildcard
    for (const sid of ["SwitchLiveVersions", "CheckRouter", "ReadDistributionAliases"]) {
      expect(JSON.stringify(bySid[sid]?.Resource)).not.toContain("*");
    }
    // Both routers, the web app's and the operator page's (check-router runs both)
    const routers = JSON.stringify(bySid.CheckRouter?.Resource);
    expect(routers).toMatch(/"Router[A-F0-9]+"/);
    expect(routers).toMatch(/"OpsRouter[A-F0-9]+"/);
  });

  it("reads every parameter publish-web reads, and only under /supply-checkout/<env>/", () => {
    const source = readFileSync(new URL("../../scripts/publish-web.mjs", import.meta.url), "utf8");
    const read = [...source.matchAll(/`\/supply-checkout\/\$\{envName\}\/([a-z/-]+)`/g)].map((m) => m[1] as string);
    expect(read.length).toBeGreaterThan(10);
    for (const name of read) {
      expect(PUBLISHER_PARAMETERS.some((p) => (p.endsWith("/*") ? name.startsWith(p.slice(0, -1)) : name === p)), name).toBe(true);
    }
    const { statements } = publisher();
    const resources = JSON.stringify(statements.find((s) => s.Sid === "ReadPublishParameters")?.Resource);
    for (const p of PUBLISHER_PARAMETERS) expect(resources).toContain(`:parameter/supply-checkout/prod/${p}`);
  });
});

describe("content security policy", () => {
  // Every external URL src/index.html loads, by the directive that governs it
  const html = readFileSync(new URL("../../src/index.html", import.meta.url), "utf8");
  const directives = cspDirectives(cspHosts);
  const origin = (url: string) => new URL(url).origin;

  it("allows the scripts and stylesheets src/index.html loads", () => {
    const scripts = [...html.matchAll(/<script[^>]*\bsrc="(https:[^"]+)"/g)].map((m) => origin(m[1] as string));
    const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(https:[^"]+)"/g)].map((m) => origin(m[1] as string));
    // No third-party scripts: ZXing is bundled
    expect(scripts).toEqual([]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(styles).toContain("https://fonts.googleapis.com");
    for (const s of scripts) expect(directives["script-src"]).toContain(s);
    for (const s of styles) expect(directives["style-src"]).toContain(s);
    // Preconnects are to the font hosts
    const preconnects = [...html.matchAll(/<link[^>]*rel="preconnect"[^>]*href="(https:[^"]+)"/g)].map((m) => origin(m[1] as string));
    expect(preconnects).toContain("https://fonts.gstatic.com");
    expect(directives["font-src"]).toContain("https://fonts.gstatic.com");
  });

  it("allows no inline or eval'd script and no framing", () => {
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives["style-src"]).not.toContain("'unsafe-inline'");
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    // The app starts no workers
    expect(directives["worker-src"]).toEqual(["'none'"]);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
  });

  it("allows the environment's API, realtime and sign-in hosts", () => {
    expect(directives["connect-src"]).toEqual(
      expect.arrayContaining([`https://${names.api}`, `wss://${names.realtime}`, `https://${names.auth}`]),
    );
    expect(contentSecurityPolicy({ ...hostNames({ envName: "staging", domainName: "supplycheckout.com" }), rumRegion: GLOBAL_SERVICES_REGION, photos: cspHosts.photos })).toContain(
      "https://api.staging.supplycheckout.com",
    );
  });

  it("allows the RUM client's Cognito and data plane hosts in the app monitor's region, and nothing else of AWS's", () => {
    const aws = directives["connect-src"]?.filter((h) => h.endsWith(".amazonaws.com"));
    expect(aws).toEqual([
      `https://cognito-identity.${GLOBAL_SERVICES_REGION}.amazonaws.com`,
      `https://dataplane.rum.${GLOBAL_SERVICES_REGION}.amazonaws.com`,
    ]);
    // The RUM client is bundled: no script host
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(() => cspDirectives({ ...cspHosts, rumRegion: "${Token[AWS.Region.1]}" })).toThrow(/isn't a region name/);
  });

  it("fits CloudFront's header limit", () => {
    // With a real account ID in the photos bucket's name, and the longest environment name and approved region
    const region = [...APPROVED_REGIONS].sort((a, b) => b.length - a.length)[0] as string;
    expect(contentSecurityPolicy({ ...cspHosts, photos: photosHost(photosBucketName("staging", region, "123456789012"), region) }).length).toBeLessThan(1783);
  });

  it("allows profile photos from the photos bucket's own regional host only, not the rest of S3 (supply-checkout-6uw.30)", () => {
    expect(directives["img-src"]).toEqual(["'self'", "data:", "blob:", `https://${cspHosts.photos}`]);
    expect(cspHosts.photos.startsWith(`supply-checkout-prod-photos-${EAST}-`)).toBe(true);
    expect(cspHosts.photos.endsWith(`.s3.${EAST}.amazonaws.com`)).toBe(true);
    for (const photos of ["*.amazonaws.com", `s3.${EAST}.amazonaws.com`, `a.s3.${EAST}.amazonaws.com https://evil.example`, `a.s3.${EAST}.amazonaws.com; script-src *`, "", "a.s3.amazonaws.com"]) {
      expect(() => cspDirectives({ ...cspHosts, photos }), photos).toThrow(/regional host/);
    }
  });
});

describe("CloudWatch RUM (web stack)", () => {
  const poolRef = { Ref: Match.stringLikeRegexp("^RumIdentityPool") };
  const guestRoleArn = { "Fn::GetAtt": [Match.stringLikeRegexp("^RumGuestRole"), "Arn"] };

  it("has an app monitor for app. that collects errors and performance only, without cookies, X-Ray or custom events", () => {
    const { web } = build();
    web.resourceCountIs("AWS::RUM::AppMonitor", 1);
    web.hasResourceProperties("AWS::RUM::AppMonitor", {
      Name: rumAppMonitorName("prod"),
      Domain: names.app,
      CwLogEnabled: false,
      CustomEvents: { Status: "DISABLED" },
      AppMonitorConfiguration: {
        AllowCookies: false,
        EnableXRay: false,
        SessionSampleRate: RUM_SESSION_SAMPLE_RATE,
        Telemetries: ["errors", "performance"],
        IdentityPoolId: poolRef,
        GuestRoleArn: guestRoleArn,
      },
    });
    // No http telemetry: it would record API URLs, which carry team and document IDs
    expect(RUM_TELEMETRIES).not.toContain("http");
    expect(RUM_SESSION_SAMPLE_RATE).toBeGreaterThan(0);
    expect(RUM_SESSION_SAMPLE_RATE).toBeLessThanOrEqual(1);
  });

  it("has an identity pool with guest identities only, enhanced flow only", () => {
    const { web } = build();
    web.resourceCountIs("AWS::Cognito::IdentityPool", 1);
    const [pool] = Object.values(web.findResources("AWS::Cognito::IdentityPool"));
    const { IdentityPoolTags, ...properties } = pool?.Properties ?? {};
    expect(IdentityPoolTags).toEqual(expect.arrayContaining([{ Key: "app", Value: "supply-checkout" }]));
    // No sign-in providers of any kind: guests only
    expect(properties).toEqual({
      IdentityPoolName: "supply-checkout-prod-rum",
      AllowUnauthenticatedIdentities: true,
      AllowClassicFlow: false,
    });
    web.resourceCountIs("AWS::Cognito::IdentityPoolRoleAttachment", 1);
    web.hasResourceProperties("AWS::Cognito::IdentityPoolRoleAttachment", {
      IdentityPoolId: poolRef,
      Roles: Match.exact({ unauthenticated: guestRoleArn }),
    });
  });

  it("lets only the pool's guest identities assume the guest role, which may only send events to this app monitor", () => {
    const { web } = build();
    const roles = Object.entries(web.findResources("AWS::IAM::Role")).filter(([, r]) => r.Properties.RoleName === "supply-checkout-prod-rum-guest");
    expect(roles).toHaveLength(1);
    const [[logicalId, role]] = roles as [[string, { Properties: Record<string, unknown> }]];
    web.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "supply-checkout-prod-rum-guest",
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: Match.exact([
          {
            Effect: "Allow",
            Principal: { Federated: "cognito-identity.amazonaws.com" },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "cognito-identity.amazonaws.com:aud": poolRef },
              "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "unauthenticated" },
            },
          },
        ]),
      },
    });
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.Policies).toEqual([
      {
        PolicyName: "PutRumEvents",
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "rum:PutRumEvents",
              Resource: {
                "Fn::Join": ["", [`arn:aws:rum:${GLOBAL_SERVICES_REGION}:`, { Ref: "AWS::AccountId" }, `:appmonitor/${rumAppMonitorName("prod")}`]],
              },
            },
          ],
        },
      },
    ]);
    // No other policy in the stack grants the guest role anything
    for (const policy of Object.values(web.findResources("AWS::IAM::Policy"))) {
      expect(JSON.stringify(policy.Properties.Roles)).not.toContain(logicalId);
    }
  });

  it("publishes what config.json needs", () => {
    const { web } = build();
    const out = webOutputParameters("prod");
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: out.rumAppMonitorId, Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^RumAppMonitor"), "Id"] } });
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: out.rumIdentityPoolId, Value: poolRef });
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: out.rumRegion, Value: GLOBAL_SERVICES_REGION });
  });
});
