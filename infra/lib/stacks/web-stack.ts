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
import { opsContentSecurityPolicy } from "../web/ops-content-security-policy.js";
import { WebPublisher } from "../web/publisher.js";
import { RealUserMonitoring } from "../web/rum.js";
import { SupplyCheckoutStack } from "./base-stack.js";
import { logsBucketName, webBucketName } from "./data-stack.js";

/** Release channels: the live version of each is a key in the KeyValueStore (web/router.js). */
export const RELEASE_CHANNELS = ["app", "demo"] as const;

/**
 * The operator page's channel (web/ops-router.js), a key in the same KeyValueStore. It isn't in
 * the store's import source: changing that replaces the store and resets every channel, and a
 * missing key is treated like "none" (503) until the first `publish-web.mjs publish --channel ops`.
 */
export const OPS_CHANNEL = "ops";

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
    /** The operator page's distribution (supply-checkout-gxlt). */
    opsDistributionId: `${prefix}/ops-distribution-id`,
    /** The operator page's router function: check-router runs it too. */
    opsRouterFunctionName: `${prefix}/ops-router-function-name`,
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

/** A CloudFront Function's source without its comment lines (CloudFront Functions are limited to 10 KB). */
const functionSource = (file: string) =>
  readFileSync(new URL(`../web/${file}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
const ROUTER_SOURCE = functionSource("router.js");
const OPS_ROUTER_SOURCE = functionSource("ops-router.js");

/** Hostnames the router compares against: lowercase letters, digits, dots and dashes only. */
const HOST = /^[a-z0-9.-]+$/;

/** The router's source with its placeholders filled in. */
export function routerCode(values: { kvsId: string; apex: string; www: string; app: string }): string {
  for (const key of ["apex", "www", "app"] as const) {
    if (!HOST.test(values[key])) throw new Error(`router.js ${key} host "${values[key]}" isn't a lowercase hostname`);
  }
  return fillIn("router.js", ROUTER_SOURCE, {
    __KVS_ID__: values.kvsId,
    __APEX_HOST__: values.apex,
    __WWW_HOST__: values.www,
    __APP_HOST__: values.app,
    __HSTS__: `max-age=${HSTS_MAX_AGE.toSeconds()}; includeSubDomains`,
  });
}

/** The operator page's router (web/ops-router.js) with its placeholders filled in. */
export function opsRouterCode(values: { kvsId: string; ops: string }): string {
  if (!HOST.test(values.ops)) throw new Error(`ops-router.js ops host "${values.ops}" isn't a lowercase hostname`);
  return fillIn("ops-router.js", OPS_ROUTER_SOURCE, {
    __KVS_ID__: values.kvsId,
    __OPS_HOST__: values.ops,
    __HSTS__: `max-age=${HSTS_MAX_AGE.toSeconds()}; includeSubDomains`,
  });
}

function fillIn(file: string, source: string, fill: Record<string, string>): string {
  // A replacer function, so "$&" and the like in a value are copied as they are
  let code = source;
  for (const [placeholder, value] of Object.entries(fill)) code = code.replace(placeholder, () => value);
  const left = code.match(/__[A-Z_]+__/);
  if (left) throw new Error(`${file} placeholder ${left[0]} isn't filled in`);
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
 * - The web publisher role (web/publisher.ts): what the deploy workflow publishes
 *   releases and switches the live version with, assumed only by the GitHub
 *   deploy role (supply-checkout-pbp.28).
 * - The operator page (supply-checkout-gxlt, ADR 0015 §6): a second distribution
 *   for ops. alone, its own origin, with its own router (web/ops-router.js, the
 *   "ops" channel, releases named ops-*), a strict CSP
 *   (web/ops-content-security-policy.ts), no caching anywhere, and the same
 *   bucket, WAF and logs. No customer app code is ever served there.
 * - The bucket's origin failover to a second region is phase 2 (supply-checkout-d79).
 */
export class WebStack extends SupplyCheckoutStack {
  readonly distribution: Distribution;
  readonly opsDistribution: Distribution;
  readonly opsRouter: CloudFrontFunction;
  readonly liveVersions: KeyValueStore;
  readonly webAcl: CfnWebACL;
  readonly rum: RealUserMonitoring;
  readonly publisher: WebPublisher;

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
      comment: "Serves the live release for the host's channel; serves the apex home page, or redirects it to the app",
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

    // The operator page: its own distribution and origin, ops.<env domain>
    this.opsRouter = new CloudFrontFunction(this, "OpsRouter", {
      comment: "Serves the operator page's live release on ops. only",
      runtime: FunctionRuntime.JS_2_0,
      keyValueStore: this.liveVersions,
      code: FunctionCode.fromInline(opsRouterCode({ kvsId: this.liveVersions.keyValueStoreId, ops: names.ops })),
    });
    const opsHeaders = new ResponseHeadersPolicy(this, "OpsSecurityHeaders", {
      comment: "Operator page: strict CSP, no caching, HSTS and the other security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: opsContentSecurityPolicy({ api: names.api, opsAuth: names.opsAuth }),
          override: true,
        },
        strictTransportSecurity: { accessControlMaxAge: HSTS_MAX_AGE, includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        // The sign-in answer is in the page's URL for a moment: it's never sent on as a referrer
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          // Nothing the page serves is kept by the browser
          { header: "Cache-Control", value: "no-store", override: true },
          { header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), payment=()", override: true },
          { header: "Cross-Origin-Opener-Policy", value: "same-origin", override: true },
          { header: "Cross-Origin-Resource-Policy", value: "same-origin", override: true },
          { header: "X-Robots-Tag", value: "noindex, nofollow", override: true },
        ],
      },
    });
    this.opsDistribution = new Distribution(this, "OpsDistribution", {
      comment: `Supply Checkout ${config.envName}: operator page`,
      domainNames: [names.ops],
      certificate: Certificate.fromCertificateArn(
        this,
        "OpsCertificate",
        StringParameter.valueForStringParameter(this, domainOutputParameters(config.envName).opsWebCertificateArn),
      ),
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      webAclId: this.webAcl.attrArn,
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: "cloudfront/ops/",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        // Nothing cached at the edge either: a few operators, a few small files
        cachePolicy: CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: opsHeaders,
        compress: true,
        functionAssociations: [{ function: this.opsRouter, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
    });
    Validations.of(this.opsDistribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason: "No geo restriction: operators can travel; sign-in needs password plus TOTP, and WAF rate-limits abuse.",
    });

    this.publisher = new WebPublisher(this, "Publisher", {
      envName: config.envName,
      bucket,
      bucketRegion,
      liveVersions: this.liveVersions,
      routers: [router, this.opsRouter],
      distribution: this.distribution,
    });

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    for (const [id, host] of [["Apex", names.apex], ["Www", names.www], ["App", names.app]] as const) {
      new ARecord(this, `${id}A`, { zone, recordName: host, target });
      new AaaaRecord(this, `${id}Aaaa`, { zone, recordName: host, target });
    }
    const opsTarget = RecordTarget.fromAlias(new CloudFrontTarget(this.opsDistribution));
    new ARecord(this, "OpsA", { zone, recordName: names.ops, target: opsTarget });
    new AaaaRecord(this, "OpsAaaa", { zone, recordName: names.ops, target: opsTarget });

    const out = webOutputParameters(config.envName);
    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: name, stringValue: value, description });
    publish("DistributionIdParam", out.distributionId, this.distribution.distributionId, "Web distribution ID");
    publish("RouterFunctionNameParam", out.routerFunctionName, router.functionName, "Router CloudFront Function name");
    publish("OpsDistributionIdParam", out.opsDistributionId, this.opsDistribution.distributionId, "Operator page distribution ID");
    publish("OpsRouterFunctionNameParam", out.opsRouterFunctionName, this.opsRouter.functionName, "Operator page router CloudFront Function name");
    publish("LiveVersionStoreParam", out.liveVersionStoreArn, this.liveVersions.keyValueStoreArn, "KeyValueStore holding the live release per channel");
    publish("BucketNameParam", out.bucketName, bucket.bucketName, "Bucket holding web releases");
    publish("BucketRegionParam", out.bucketRegion, bucketRegion, "Region of the web releases bucket");
    publish("RumAppMonitorIdParam", out.rumAppMonitorId, this.rum.appMonitor.attrId, "CloudWatch RUM app monitor ID (the web app's config.json)");
    publish("RumIdentityPoolIdParam", out.rumIdentityPoolId, this.rum.identityPool.ref, "Cognito identity pool the web app sends RUM events with");
    publish("RumRegionParam", out.rumRegion, this.region, "Region of the RUM app monitor");
  }
}
