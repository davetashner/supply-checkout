import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { domainOutputParameters, hostNames } from "../lib/domain.js";
import { webBucketName } from "../lib/stacks/data-stack.js";
import { MANAGED_RULE_GROUPS, RATE_LIMIT_PER_5_MINUTES, RELEASE_CHANNELS, webOutputParameters } from "../lib/stacks/web-stack.js";
import { contentSecurityPolicy, cspDirectives } from "../lib/web/content-security-policy.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };
const names = hostNames(config);

function build(overrides: Partial<DeploymentConfig> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [] } });
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
    web.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
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
    expect(code).not.toContain("__KVS_ID__");
    expect(code).toContain("LiveVersions");
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
    const { web } = build();
    web.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentSecurityPolicy: { ContentSecurityPolicy: contentSecurityPolicy(names), Override: true },
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
    web.resourceCountIs("AWS::Route53::RecordSet", 6);
  });

  it("publishes what scripts/publish-web.mjs needs", () => {
    const { web } = build();
    for (const name of Object.values(webOutputParameters("prod"))) {
      web.hasResourceProperties("AWS::SSM::Parameter", { Name: name, Type: "String" });
    }
    web.hasResourceProperties("AWS::SSM::Parameter", { Name: webOutputParameters("prod").bucketRegion, Value: EAST });
  });
});

describe("content security policy", () => {
  // Every external URL src/index.html loads, by the directive that governs it
  const html = readFileSync(new URL("../../src/index.html", import.meta.url), "utf8");
  const directives = cspDirectives(names);
  const origin = (url: string) => new URL(url).origin;

  it("allows the scripts and stylesheets src/index.html loads", () => {
    const scripts = [...html.matchAll(/<script[^>]*\bsrc="(https:[^"]+)"/g)].map((m) => origin(m[1] as string));
    const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(https:[^"]+)"/g)].map((m) => origin(m[1] as string));
    expect(scripts).toContain("https://cdn.jsdelivr.net");
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
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
  });

  it("allows the environment's API, realtime and sign-in hosts", () => {
    expect(directives["connect-src"]).toEqual(
      expect.arrayContaining([`https://${names.api}`, `wss://${names.realtime}`, `https://${names.auth}`]),
    );
    expect(contentSecurityPolicy(hostNames({ envName: "staging", domainName: "supplycheckout.com" }))).toContain(
      "https://api.staging.supplycheckout.com",
    );
  });

  it("fits CloudFront's header limit", () => {
    expect(contentSecurityPolicy(names).length).toBeLessThan(1783);
  });
});
