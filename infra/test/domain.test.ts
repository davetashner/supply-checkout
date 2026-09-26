import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { dnsInputParameters, domainOutputParameters, envDomain, hostNames } from "../lib/domain.js";
import { delegatedEnvsFromContext } from "../lib/stacks/domain-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(overrides: Partial<DeploymentConfig> = {}, context: Record<string, unknown> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, ...context } });
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  const domain = (region: string) => {
    const stack = stacks.domain[region];
    if (!stack) throw new Error(`No domain stack in ${region}`);
    return Template.fromStack(stack);
  };
  return { app, stacks, domain };
}

const ssmParameter = (name: string) => ({ Type: Match.stringLikeRegexp("^AWS::SSM::Parameter::Value<"), Default: name });

const certificateNames = (template: Template) =>
  Object.values(template.findResources("AWS::CertificateManager::Certificate"))
    .map((c) => [c.Properties.DomainName, ...(c.Properties.SubjectAlternativeNames ?? [])].join(" "))
    .sort();

describe("host names", () => {
  it("serves the registered domain in prod and a subdomain elsewhere", () => {
    expect(envDomain(config)).toBe("supplycheckout.com");
    expect(envDomain({ ...config, envName: "staging" })).toBe("staging.supplycheckout.com");
    expect(hostNames(config)).toEqual({
      apex: "supplycheckout.com",
      www: "www.supplycheckout.com",
      app: "app.supplycheckout.com",
      api: "api.supplycheckout.com",
      realtime: "realtime.supplycheckout.com",
      auth: "auth.supplycheckout.com",
      mailFrom: "mail.supplycheckout.com",
    });
    expect(hostNames({ envName: "dev", domainName: "example.com" }).app).toBe("app.dev.example.com");
  });
});

describe("hosted zone", () => {
  it("imports the existing zone by an ID read from SSM at deploy time, and never creates one", () => {
    const { stacks, domain } = build();
    for (const stack of stacks.all) Template.fromStack(stack).resourceCountIs("AWS::Route53::HostedZone", 0);
    const template = domain(EAST);
    template.hasParameter("*", ssmParameter(dnsInputParameters("prod").hostedZoneId));
    // Every record and certificate validation goes to that zone
    const records = template.findResources("AWS::Route53::RecordSet");
    expect(Object.keys(records).length).toBeGreaterThan(0);
    for (const record of Object.values(records)) expect(record.Properties.HostedZoneId).toEqual({ Ref: expect.stringMatching(/hostedzoneid/) });
  });

  it("uses each environment's own zone and parameters", () => {
    const { domain } = build({ envName: "staging" });
    const template = domain(EAST);
    template.hasParameter("*", ssmParameter("/supply-checkout/staging/dns/hosted-zone-id"));
    template.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "api.staging.supplycheckout.com" });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/supply-checkout/staging/domain/env-domain",
      Value: "staging.supplycheckout.com",
    });
  });
});

describe("certificates", () => {
  it("puts CloudFront, Cognito and AppSync certificates in the global services region and api. in every region", () => {
    const { domain } = build();
    expect(certificateNames(domain(GLOBAL_SERVICES_REGION))).toEqual([
      "api.supplycheckout.com",
      "app.supplycheckout.com supplycheckout.com www.supplycheckout.com",
      "auth.supplycheckout.com",
      "realtime.supplycheckout.com",
    ]);
    expect(certificateNames(domain(WEST))).toEqual(["api.supplycheckout.com"]);
  });

  it("validates every name by DNS in the imported zone", () => {
    const { domain } = build();
    const certs = domain(EAST).findResources("AWS::CertificateManager::Certificate");
    for (const cert of Object.values(certs)) {
      expect(cert.Properties.ValidationMethod).toBe("DNS");
      const names = [cert.Properties.DomainName, ...(cert.Properties.SubjectAlternativeNames ?? [])];
      expect(cert.Properties.DomainValidationOptions).toEqual(names.map((DomainName) => ({ DomainName, HostedZoneId: expect.anything() })));
      for (const option of cert.Properties.DomainValidationOptions) {
        expect(option.HostedZoneId).toEqual({ Ref: expect.stringMatching(/hostedzoneid/) });
      }
    }
  });

  it("publishes each certificate ARN to SSM in its region", () => {
    const { domain } = build();
    const out = domainOutputParameters("prod");
    for (const name of [out.apiCertificateArn, out.webCertificateArn, out.authCertificateArn, out.realtimeCertificateArn]) {
      domain(EAST).hasResourceProperties("AWS::SSM::Parameter", { Name: name, Value: { Ref: Match.anyValue() } });
    }
    domain(WEST).hasResourceProperties("AWS::SSM::Parameter", { Name: out.apiCertificateArn });
    domain(WEST).resourcePropertiesCountIs("AWS::SSM::Parameter", { Name: out.webCertificateArn }, 0);
  });

  it("keeps only the global certificates when the global services region isn't deployed", () => {
    const { domain } = build({ regions: [WEST], primaryRegion: WEST });
    expect(certificateNames(domain(GLOBAL_SERVICES_REGION))).toEqual([
      "app.supplycheckout.com supplycheckout.com www.supplycheckout.com",
      "auth.supplycheckout.com",
      "realtime.supplycheckout.com",
    ]);
    domain(GLOBAL_SERVICES_REGION).resourceCountIs("AWS::SES::EmailIdentity", 0);
    expect(certificateNames(domain(WEST))).toEqual(["api.supplycheckout.com"]);
    domain(WEST).resourceCountIs("AWS::SES::EmailIdentity", 1);
  });
});

describe("email domain (SES)", () => {
  it("verifies the domain with Easy DKIM and a custom MAIL FROM, in the primary region only", () => {
    const { domain } = build();
    const template = domain(EAST);
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "supplycheckout.com",
      MailFromAttributes: { MailFromDomain: "mail.supplycheckout.com" },
    });
    for (const n of [1, 2, 3]) {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Type: "CNAME",
        Name: { "Fn::GetAtt": [Match.anyValue(), `DkimDNSTokenName${n}`] },
      });
    }
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "MX",
      Name: "mail.supplycheckout.com.",
      ResourceRecords: [`10 feedback-smtp.${EAST}.amazonses.com`],
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: "mail.supplycheckout.com.",
      ResourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
    });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: domainOutputParameters("prod").emailIdentity });
    domain(WEST).resourceCountIs("AWS::SES::EmailIdentity", 0);
    domain(WEST).resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  it("publishes SPF on the apex and a monitoring DMARC policy that reports to an address kept in SSM", () => {
    const { domain } = build();
    const template = domain(EAST);
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: "supplycheckout.com.",
      ResourceRecords: ['"v=spf1 include:amazonses.com -all"'],
    });
    template.hasParameter("*", ssmParameter(dnsInputParameters("prod").dmarcReportUri));
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: "_dmarc.supplycheckout.com.",
      ResourceRecords: [
        {
          "Fn::Join": ["", ['"v=DMARC1; p=none; rua=', { Ref: Match.stringLikeRegexp("dmarcrua") }, '; adkim=r; aspf=r; fo=1"']],
        },
      ],
    });
  });
});

describe("subdomain delegation", () => {
  it("delegates nothing by default", () => {
    const { domain } = build();
    domain(EAST).resourcePropertiesCountIs("AWS::Route53::RecordSet", { Type: "NS" }, 0);
  });

  it("delegates each listed environment to the name servers in its SSM parameter", () => {
    const { domain } = build({}, { delegatedEnvs: "staging,dev" });
    const template = domain(EAST);
    for (const child of ["staging", "dev"]) {
      template.hasParameter("*", {
        Type: "AWS::SSM::Parameter::Value<List<String>>",
        Default: dnsInputParameters("prod").delegation(child),
      });
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Type: "NS",
        Name: `${child}.supplycheckout.com.`,
        ResourceRecords: { Ref: Match.stringLikeRegexp(`delegation${child}`) },
      });
    }
    // Only the primary region's stack writes the records
    domain(WEST).resourcePropertiesCountIs("AWS::Route53::RecordSet", { Type: "NS" }, 0);
  });

  it("only delegates from prod", () => {
    const { domain } = build({ envName: "staging" }, { delegatedEnvs: ["dev"] });
    domain(EAST).resourcePropertiesCountIs("AWS::Route53::RecordSet", { Type: "NS" }, 0);
  });

  it("reads the list from context and rejects bad names", () => {
    const ctx = (value: unknown) => ({ tryGetContext: () => value });
    expect(delegatedEnvsFromContext(ctx(undefined))).toEqual([]);
    expect(delegatedEnvsFromContext(ctx(""))).toEqual([]);
    expect(delegatedEnvsFromContext(ctx(["staging"]))).toEqual(["staging"]);
    expect(delegatedEnvsFromContext(ctx("staging, dev"))).toEqual(["staging", "dev"]);
    expect(() => delegatedEnvsFromContext(ctx("prod"))).toThrow(/not a child/);
    expect(() => delegatedEnvsFromContext(ctx("Bad.Name"))).toThrow(/not a child/);
  });
});

describe("cdk-nag", () => {
  it("finds nothing in the domain stacks, with delegation on", () => {
    const { app } = build({}, { delegatedEnvs: "staging" });
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
  });
});
