import { readFileSync } from "node:fs";
import { Annotations, Duration, Validations } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  ImportSource,
  KeyValueStore,
  PriceClass,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { ARecord, AaaaRecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { domainOutputParameters, hostNames, importZone } from "../domain.js";
import { contentSecurityPolicy } from "../web/content-security-policy.js";
import { RealUserMonitoring } from "../web/rum.js";
import { SupplyCheckoutStack } from "./base-stack.js";
import { logsBucketName, webBucketName } from "./data-stack.js";

/** Release channels: the live version of each is a key in the KeyValueStore (web/router.js). */
export const RELEASE_CHANNELS = ["app", "demo"] as const;

/** Requests per IP per 5 minutes before WAF blocks it. A page load is about 10. */
export const RATE_LIMIT_PER_5_MINUTES = 2000;

/** AWS managed rule groups on the web ACL, in priority order after the rate limit. */
export const MANAGED_RULE_GROUPS = [
  "AWSManagedRulesAmazonIpReputationList",
  "AWSManagedRulesCommonRuleSet",
  "AWSManagedRulesKnownBadInputsRuleSet",
] as const;

export const webOutputParameters = (envName: string) => {
  const prefix = `/supply-checkout/${envName}/web`;
  return {
    distributionId: `${prefix}/distribution-id`,
    /** The router CloudFront Function's name: its metrics' FunctionName (the web alarms, supply-checkout-3sv.2). */
    routerFunctionName: `${prefix}/router-function-name`,
    liveVersionStoreArn: `${prefix}/live-version-store-arn`,
    bucketName: `${prefix}/bucket-name`,
    bucketRegion: `${prefix}/bucket-region`,
    rumAppMonitorId: `${prefix}/rum-app-monitor-id`,
    rumIdentityPoolId: `${prefix}/rum-identity-pool-id`,
    rumRegion: `${prefix}/rum-region`,
  };
};

/** HSTS on every response: two years, with subdomains. */
export const HSTS_MAX_AGE = Duration.days(730);

/** web/router.js without its comment lines (CloudFront Functions are limited to 10 KB). */
const ROUTER_SOURCE = readFileSync(new URL("../web/router.js", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

/** Hostnames the router compares against: lowercase letters, digits, dots and dashes only. */
const HOST = /^[a-z0-9.-]+$/;

/** The router's source with its placeholders filled in. */
export function routerCode(values: { kvsId: string; apex: string; www: string; app: string }): string {
  for (const key of ["apex", "www", "app"] as const) {
    if (!HOST.test(values[key])) throw new Error(`router.js ${key} host "${values[key]}" isn't a lowercase hostname`);
  }
  const fill: Record<string, string> = {
    __KVS_ID__: values.kvsId,
    __APEX_HOST__: values.apex,
    __WWW_HOST__: values.www,
    __APP_HOST__: values.app,
    __HSTS__: `max-age=${HSTS_MAX_AGE.toSeconds()}; includeSubDomains`,
  };
  // A replacer function, so "$&" and the like in a value are copied as they are
  let code = ROUTER_SOURCE;
  for (const [placeholder, value] of Object.entries(fill)) code = code.replace(placeholder, () => value);
  const left = code.match(/__[A-Z_]+__/);
  if (left) throw new Error(`router.js placeholder ${left[0]} isn't filled in`);
  return code;
}

/**
 * The web app and the demo on CloudFront, with AWS WAF (supply-checkout-qk1).
 *
 * The stack is in GLOBAL_SERVICES_REGION, which AWS requires for a CloudFront
 * web ACL; its certificate comes from the domain stack there. The releases
 * bucket is in the primary region's data stack (stateful), imported by name.
 *
 * - One distribution for the apex, www. and app. A viewer-request CloudFront
 *   Function (web/router.js) reads the live version of the channel
 *   (app. -> "app", the apex's /demo/ -> "demo") from a KeyValueStore and
 *   serves releases/<version>/ from the bucket. The apex's other paths
 *   redirect to app. (302), and www. to the apex (301).
 * - scripts/publish-web.mjs uploads a build to releases/<version>/ and sets
 *   the channel's key; the switch reaches every edge in seconds.
 * - Security headers on every response: CSP (web/content-security-policy.ts),
 *   HSTS, nosniff, frame DENY, a strict referrer policy and Permissions-Policy.
 * - WAF: a per-IP rate limit and AWS managed rules (IP reputation, common
 *   rule set, known bad inputs).
 * - CloudWatch RUM (web/rum.ts): the app's JavaScript errors and page
 *   performance, sent by the browser with a guest identity that may only
 *   call rum:PutRumEvents on the app monitor.
 * - The bucket's origin failover to a second region is phase 2 (supply-checkout-d79).
 */
export class WebStack extends SupplyCheckoutStack {
  readonly distribution: Distribution;
  readonly liveVersions: KeyValueStore;
  readonly webAcl: CfnWebACL;
  readonly rum: RealUserMonitoring;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "web", layer: "stateless" });

    const names = hostNames(config);
    const zone = importZone(this, config);
    const certificate = Certificate.fromCertificateArn(
      this,
      "Certificate",
      StringParameter.valueForStringParameter(this, domainOutputParameters(config.envName).webCertificateArn),
    );

    const bucketRegion = config.primaryRegion;
    const bucket = Bucket.fromBucketAttributes(this, "WebBucket", {
      bucketName: webBucketName(config.envName, bucketRegion),
      region: bucketRegion,
    });
    const logsBucket = Bucket.fromBucketAttributes(this, "LogsBucket", {
      bucketName: logsBucketName(config.envName, bucketRegion),
      region: bucketRegion,
    });

    // Nothing is live until the first publish; the router answers 503. The
    // import source only seeds a new store, and changing it (adding a channel,
    // say) replaces the store, which resets every channel to "none" until the
    // next `publish-web.mjs activate`. A new channel can instead be added with
    // `activate` alone: a missing key is treated like "none".
    this.liveVersions = new KeyValueStore(this, "LiveVersions", {
      comment: "Live release per channel (scripts/publish-web.mjs)",
      source: ImportSource.fromInline(JSON.stringify({ data: RELEASE_CHANNELS.map((key) => ({ key, value: "none" })) })),
    });
    const router = new CloudFrontFunction(this, "Router", {
      comment: "Serves the live release for the host's channel; redirects the apex home page",
      runtime: FunctionRuntime.JS_2_0,
      keyValueStore: this.liveVersions,
      code: FunctionCode.fromInline(
        routerCode({ kvsId: this.liveVersions.keyValueStoreId, apex: names.apex, www: names.www, app: names.app }),
      ),
    });

    // In this stack's region, next to the distribution, like the app itself a
    // single copy (it isn't per data region)
    this.rum = new RealUserMonitoring(this, "Rum", { envName: config.envName, appHost: names.app });

    const headers = new ResponseHeadersPolicy(this, "SecurityHeaders", {
      comment: "CSP, HSTS and the other security headers for the web app",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: contentSecurityPolicy({ ...names, rumRegion: this.region }),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: HSTS_MAX_AGE,
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            // The barcode and receipt photos come from a file input, so the
            // camera is only ever used through the browser's own picker.
            value: "camera=(self), microphone=(), geolocation=(), usb=()",
            override: true,
          },
          { header: "Cross-Origin-Opener-Policy", value: "same-origin", override: true },
        ],
      },
    });

    this.webAcl = new CfnWebACL(this, "WebAcl", {
      name: `supply-checkout-${config.envName}-web`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `supply-checkout-${config.envName}-web`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimitPerIp",
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: RATE_LIMIT_PER_5_MINUTES, aggregateKeyType: "IP" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "RateLimitPerIp", sampledRequestsEnabled: true },
        },
        ...MANAGED_RULE_GROUPS.map((name, i) => ({
          name,
          priority: i + 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
        })),
      ],
    });

    this.distribution = new Distribution(this, "Distribution", {
      comment: `Supply Checkout ${config.envName}: app, demo`,
      domainNames: [names.apex, names.www, names.app],
      certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      webAclId: this.webAcl.attrArn,
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: "cloudfront/web/",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [{ function: router, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
    });
    // The bucket's policy (data stack) grants read to this account's
    // distributions; an imported bucket's policy can't be edited from here.
    Annotations.of(this).acknowledgeWarning(
      "@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac",
      "The data stack's bucket policy grants CloudFront in this account read access.",
    );
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason: "No geo restriction: customers can travel, and WAF rate-limits abuse.",
    });

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    for (const [id, host] of [["Apex", names.apex], ["Www", names.www], ["App", names.app]] as const) {
      new ARecord(this, `${id}A`, { zone, recordName: host, target });
      new AaaaRecord(this, `${id}Aaaa`, { zone, recordName: host, target });
    }

    const out = webOutputParameters(config.envName);
    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: name, stringValue: value, description });
    publish("DistributionIdParam", out.distributionId, this.distribution.distributionId, "Web distribution ID");
    publish("RouterFunctionNameParam", out.routerFunctionName, router.functionName, "Router CloudFront Function name");
    publish("LiveVersionStoreParam", out.liveVersionStoreArn, this.liveVersions.keyValueStoreArn, "KeyValueStore holding the live release per channel");
    publish("BucketNameParam", out.bucketName, bucket.bucketName, "Bucket holding web releases");
    publish("BucketRegionParam", out.bucketRegion, bucketRegion, "Region of the web releases bucket");
    publish("RumAppMonitorIdParam", out.rumAppMonitorId, this.rum.appMonitor.attrId, "CloudWatch RUM app monitor ID (the web app's config.json)");
    publish("RumIdentityPoolIdParam", out.rumIdentityPoolId, this.rum.identityPool.ref, "Cognito identity pool the web app sends RUM events with");
    publish("RumRegionParam", out.rumRegion, this.region, "Region of the RUM app monitor");
  }
}
