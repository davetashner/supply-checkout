// Host names and DNS parameters for each environment (supply-checkout-m64).
//
// Prod serves the registered domain itself from the hosted zone that was
// created by hand in the prod account when the domain was delegated from
// Namecheap. Every other environment serves `<envName>.<domain>` from a zone
// in its own account, delegated from the prod zone with an NS record (see
// DomainStack and the README's "Domain and email" section).
import { type IPublicHostedZone, PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DeploymentConfig } from "./config.js";

/** The zone apex an environment serves: the domain in prod, `<env>.<domain>` elsewhere. */
export function envDomain(config: Pick<DeploymentConfig, "envName" | "domainName">): string {
  return config.envName === "prod" ? config.domainName : `${config.envName}.${config.domainName}`;
}

export interface HostNames {
  /** The zone apex. Serves the demo until the real app launches (supply-checkout-sy6). */
  readonly apex: string;
  readonly www: string;
  /** The web app (CloudFront). */
  readonly app: string;
  /** The HTTP API, one custom domain in every region (ADR 0006, 0010). */
  readonly api: string;
  /** AppSync Events (ADR 0006). */
  readonly realtime: string;
  /** Cognito Managed Login (ADR 0007). */
  readonly auth: string;
  /** SES custom MAIL FROM domain, so SPF aligns with the From address for DMARC. */
  readonly mailFrom: string;
}

export function hostNames(config: Pick<DeploymentConfig, "envName" | "domainName">): HostNames {
  const apex = envDomain(config);
  return {
    apex,
    www: `www.${apex}`,
    app: `app.${apex}`,
    api: `api.${apex}`,
    realtime: `realtime.${apex}`,
    auth: `auth.${apex}`,
    mailFrom: `mail.${apex}`,
  };
}

/**
 * SSM parameters the operator creates by hand before the first deploy, in
 * each region with a domain stack. They hold values that are account-specific
 * or personal, so they stay out of this public repository.
 */
export const dnsInputParameters = (envName: string) => ({
  /** The hosted zone ID for envDomain(), without the `/hostedzone/` prefix. */
  hostedZoneId: `/supply-checkout/${envName}/dns/hosted-zone-id`,
  /** The DMARC aggregate-report destination, e.g. `mailto:dmarc-reports@example.com`. */
  dmarcReportUri: `/supply-checkout/${envName}/dns/dmarc-rua`,
  /**
   * Name servers of a child environment's zone (a StringList), read by the
   * prod zone to delegate `<child>.<domain>`. Only for envs listed in the
   * `delegatedEnvs` context value.
   */
  delegation: (child: string) => `/supply-checkout/${envName}/dns/delegation/${child}`,
});

/** SSM parameters the domain stack publishes for the stacks that use its certificates. */
export const domainOutputParameters = (envName: string) => {
  const prefix = `/supply-checkout/${envName}/domain`;
  return {
    envDomain: `${prefix}/env-domain`,
    /** GLOBAL_SERVICES_REGION only: apex, www. and app. for CloudFront. */
    webCertificateArn: `${prefix}/web-certificate-arn`,
    /** GLOBAL_SERVICES_REGION only: auth. for the Cognito custom domain. */
    authCertificateArn: `${prefix}/auth-certificate-arn`,
    /** GLOBAL_SERVICES_REGION only: realtime. for the AppSync Events custom domain. */
    realtimeCertificateArn: `${prefix}/realtime-certificate-arn`,
    /** Every region: api. for the regional API Gateway custom domain. */
    apiCertificateArn: `${prefix}/api-certificate-arn`,
    /** Primary region only: the SES domain identity. */
    emailIdentity: `${prefix}/email-identity`,
  };
};

/**
 * The environment's existing hosted zone, imported by ID. The ID is read from
 * SSM at deploy time (a CloudFormation SSM parameter), not looked up at synth
 * time with HostedZone.fromLookup, so synth stays account-agnostic in CI and
 * no zone ID lands in cdk.context.json. Any stack that adds records (web, api,
 * realtime, identity) imports the zone with this.
 */
export function importZone(scope: Construct, config: Pick<DeploymentConfig, "envName" | "domainName">): IPublicHostedZone {
  return PublicHostedZone.fromPublicHostedZoneAttributes(scope, "HostedZone", {
    hostedZoneId: StringParameter.valueForStringParameter(scope, dnsInputParameters(config.envName).hostedZoneId),
    zoneName: envDomain(config),
  });
}
