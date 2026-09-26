import { Certificate, CertificateValidation, type ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { type IPublicHostedZone, NsRecord, TxtRecord } from "aws-cdk-lib/aws-route53";
import { EmailIdentity, Identity } from "aws-cdk-lib/aws-ses";
import { StringListParameter, StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../config.js";
import { dnsInputParameters, domainOutputParameters, envDomain, hostNames, importZone } from "../domain.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/** Environments whose zones the prod zone delegates to, from `-c delegatedEnvs=staging,dev`. */
export function delegatedEnvsFromContext(node: { tryGetContext(key: string): unknown }): string[] {
  const value = node.tryGetContext("delegatedEnvs");
  if (value === undefined || value === "") return [];
  const envs = Array.isArray(value) ? value.map(String) : String(value).split(",").map((s) => s.trim()).filter(Boolean);
  for (const env of envs) {
    if (env === "prod" || !/^[a-z][a-z0-9-]{0,15}$/.test(env)) throw new Error(`delegatedEnvs: "${env}" is not a child environment name`);
  }
  return envs;
}

/**
 * DNS, certificates and the email domain for one environment in one region
 * (supply-checkout-m64).
 *
 * - The hosted zone is **imported**, never created: prod's zone was created by
 *   hand when the domain was delegated from Namecheap. Its ID is an SSM
 *   parameter the operator creates (`/supply-checkout/<env>/dns/hosted-zone-id`),
 *   read at deploy time (see importZone in domain.ts).
 * - Every region: an ACM certificate for `api.` (API Gateway custom domains
 *   need a certificate in their own region).
 * - GLOBAL_SERVICES_REGION: certificates for CloudFront (apex, www., app.),
 *   Cognito's custom domain (auth.) and AppSync's (realtime.), all of which
 *   AWS requires there. The app adds a domain stack in that region even when
 *   it isn't one of the deployed regions.
 * - Primary region: the SES domain identity with Easy DKIM, a custom MAIL FROM
 *   domain (MX and SPF), SPF on the apex, and DMARC. SES in the second region
 *   is phase 2 (supply-checkout-3x3.1).
 * - Prod only, opt-in: NS records delegating `<env>.<domain>` to the staging
 *   and dev accounts' zones (`-c delegatedEnvs=staging,dev`).
 *
 * Certificates are validated by DNS in the imported zone; CloudFormation adds
 * the validation records and waits for issuance. Each certificate's ARN is
 * published to SSM under /supply-checkout/<env>/domain/ in this region.
 */
export class DomainStack extends SupplyCheckoutStack {
  readonly zone: IPublicHostedZone;
  readonly apiCertificate?: ICertificate;
  readonly webCertificate?: ICertificate;
  readonly authCertificate?: ICertificate;
  readonly realtimeCertificate?: ICertificate;
  readonly emailIdentity?: EmailIdentity;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "domain", layer: "stateless" });

    const names = hostNames(config);
    const inputs = dnsInputParameters(config.envName);
    const outputs = domainOutputParameters(config.envName);
    this.zone = importZone(this, config);

    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: name, stringValue: value, description });
    const certificate = (id: string, domainName: string, alternates: string[] = []) =>
      new Certificate(this, id, {
        domainName,
        subjectAlternativeNames: alternates.length ? alternates : undefined,
        validation: CertificateValidation.fromDns(this.zone),
      });

    publish("EnvDomainParam", outputs.envDomain, envDomain(config), "Zone apex this environment serves");

    const isDeployedRegion = config.regions.includes(region);
    if (isDeployedRegion) {
      this.apiCertificate = certificate("ApiCertificate", names.api);
      publish("ApiCertificateParam", outputs.apiCertificateArn, this.apiCertificate.certificateArn, `Certificate for ${names.api} in this region`);
    }

    if (region === GLOBAL_SERVICES_REGION) {
      this.webCertificate = certificate("WebCertificate", names.app, [names.apex, names.www]);
      this.authCertificate = certificate("AuthCertificate", names.auth);
      this.realtimeCertificate = certificate("RealtimeCertificate", names.realtime);
      publish("WebCertificateParam", outputs.webCertificateArn, this.webCertificate.certificateArn, "CloudFront certificate: app., apex and www.");
      publish("AuthCertificateParam", outputs.authCertificateArn, this.authCertificate.certificateArn, "Cognito custom domain certificate: auth.");
      publish("RealtimeCertificateParam", outputs.realtimeCertificateArn, this.realtimeCertificate.certificateArn, "AppSync custom domain certificate: realtime.");
    }

    if (region === config.primaryRegion) {
      // Easy DKIM (three CNAMEs) and a custom MAIL FROM domain (MX and SPF on
      // mail.<apex>), so both DKIM and SPF align with the From domain for DMARC.
      this.emailIdentity = new EmailIdentity(this, "EmailIdentity", {
        identity: Identity.publicHostedZone(this.zone),
        mailFromDomain: names.mailFrom,
      });
      publish("EmailIdentityParam", outputs.emailIdentity, this.emailIdentity.emailIdentityName, "SES domain identity");

      // Only SES sends as this domain. If the zone already has TXT records at
      // the apex (a site verification, say), merge them in here first, or the
      // deploy fails because the record set exists.
      new TxtRecord(this, "ApexSpf", { zone: this.zone, values: ["v=spf1 include:amazonses.com -all"] });
      // Monitor first (p=none). Once the aggregate reports show SES mail
      // passing, tighten to p=quarantine, then p=reject.
      const rua = StringParameter.valueForStringParameter(this, inputs.dmarcReportUri);
      new TxtRecord(this, "Dmarc", {
        zone: this.zone,
        recordName: "_dmarc",
        values: [`v=DMARC1; p=none; rua=${rua}; adkim=r; aspf=r; fo=1`],
      });
    }

    if (config.envName === "prod" && region === config.primaryRegion) {
      for (const child of delegatedEnvsFromContext(this.node)) {
        new NsRecord(this, `Delegate-${child}`, {
          zone: this.zone,
          recordName: child,
          values: StringListParameter.valueForTypedListParameter(this, inputs.delegation(child)),
        });
      }
    }
  }
}
