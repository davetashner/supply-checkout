import { readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUrlIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { domainOutputParameters, dnsInputParameters } from "../lib/domain.js";
import {
  cognitoJwtAuthorizer,
  identityOptionsFromContext,
  identityOutputParameters,
  identityProviderSecrets,
  LOCAL_DEV_ORIGIN,
  managedLoginBranding,
} from "../lib/identity.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST], primaryRegion: EAST };

function build(overrides: Partial<DeploymentConfig> = {}, context: Record<string, unknown> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [], ...context } });
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  return { app, stacks, template: Template.fromStack(stacks.identity) };
}

const ssmParameter = (name: string) => ({ Type: Match.stringLikeRegexp("^AWS::SSM::Parameter::Value<"), Default: name });
const only = (template: Template, type: string) => {
  const found = Object.values(template.findResources(type));
  expect(found, type).toHaveLength(1);
  return found[0];
};

describe("user pool (ADR 0007)", () => {
  it("is an Essentials pool, protected from deletion and retained", () => {
    const { stacks, template } = build();
    expect(stacks.identity.layer).toBe("stateful");
    expect(stacks.identity.terminationProtection).toBe(true);
    template.hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({ UserPoolTier: "ESSENTIALS", DeletionProtection: "ACTIVE", UserPoolName: "supply-checkout-prod" }),
    });
  });

  it("signs in by email with a password, an email code or a passkey bound to auth.", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UsernameAttributes: ["email"],
      UsernameConfiguration: { CaseSensitive: false },
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP", "WEB_AUTHN"] } }),
      WebAuthnRelyingPartyID: "auth.supplycheckout.com",
      WebAuthnUserVerification: "preferred",
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] },
    });
    build({ envName: "dev" }).template.hasResourceProperties("AWS::Cognito::UserPool", { WebAuthnRelyingPartyID: "auth.dev.supplycheckout.com" });
  });

  it("makes TOTP MFA optional, with no SMS", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      MfaConfiguration: "OPTIONAL",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
      SmsConfiguration: Match.absent(),
    });
  });

  it("sends email through SES from the environment's domain", () => {
    const { template } = build({ envName: "staging" });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        From: "Supply Checkout <noreply@staging.supplycheckout.com>",
        SourceArn: { "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp(`:ses:${EAST}:`), ":identity/staging.supplycheckout.com"])] },
      },
    });
  });

  it("waits for its certificate, its SES identity, and the web stack's apex record", () => {
    const deps = (overrides: Partial<DeploymentConfig>) =>
      build(overrides).stacks.identity.dependencies.map((d) => d.stackName).sort();
    const web = `supply-checkout-prod-${GLOBAL_SERVICES_REGION}-web`;
    expect(deps({})).toEqual([`supply-checkout-prod-${EAST}-domain`, web].sort());
    expect(deps({ regions: [WEST], primaryRegion: WEST })).toEqual(
      [`supply-checkout-prod-${GLOBAL_SERVICES_REGION}-domain`, `supply-checkout-prod-${WEST}-domain`, web].sort(),
    );
  });
});

describe("Managed Login domain", () => {
  it("serves auth.<env domain> with the certificate the domain stack published", () => {
    const { template } = build();
    template.hasParameter("*", ssmParameter(domainOutputParameters("prod").authCertificateArn));
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: "auth.supplycheckout.com",
      CustomDomainConfig: { CertificateArn: { Ref: Match.stringLikeRegexp("authcertificatearn") } },
      ManagedLoginVersion: 2,
    });
  });

  it("points A and AAAA aliases at the domain's CloudFront distribution in the imported zone, without a custom resource", () => {
    const { template } = build();
    template.hasParameter("*", ssmParameter(dnsInputParameters("prod").hostedZoneId));
    const domainId = Object.keys(template.findResources("AWS::Cognito::UserPoolDomain"))[0];
    for (const Type of ["A", "AAAA"]) {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Type,
        Name: "auth.supplycheckout.com.",
        HostedZoneId: { Ref: Match.stringLikeRegexp("hostedzoneid") },
        AliasTarget: { DNSName: { "Fn::GetAtt": [domainId, "CloudFrontDistribution"] }, HostedZoneId: Match.anyValue() },
      });
    }
    template.resourceCountIs("AWS::Lambda::Function", 0);
    template.resourceCountIs("Custom::UserPoolCloudFrontDomainName", 0);
  });

  it("is branded with the app's colors, light and dark", () => {
    const { template } = build();
    const branding = only(template, "AWS::Cognito::ManagedLoginBranding");
    const clientId = Object.keys(template.findResources("AWS::Cognito::UserPoolClient"))[0];
    expect(branding.Properties.ClientId).toEqual({ Ref: clientId });
    expect(branding.Properties.UseCognitoProvidedValues).toBeUndefined();
    expect(branding.Properties.Settings).toEqual(managedLoginBranding);

    // Every color is 8-digit lowercase RGBA hex, and the accents match src/styles.css
    const colors = JSON.stringify(managedLoginBranding).match(/"[a-zA-Z]*[cC]olor":"[^"]*"/g) ?? [];
    expect(colors.length).toBeGreaterThan(20);
    for (const c of colors) expect(c).toMatch(/:"[0-9a-f]{8}"$/);
    const css = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
    const accents = [...css.matchAll(/--accent:#([0-9A-Fa-f]{6});/g)].map((m) => `${m[1]?.toLowerCase()}ff`);
    const button = managedLoginBranding.components.primaryButton;
    expect(accents).toContain(button.lightMode.defaults.backgroundColor);
    expect(accents).toContain(button.darkMode.defaults.backgroundColor);
    expect(managedLoginBranding.categories.global.colorSchemeMode).toBe("DYNAMIC");
  });
});

describe("web app client", () => {
  it("is a public client using the authorization code flow, with no secret", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "web",
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ["openid", "email", "profile", "aws.cognito.signin.user.admin"],
      ExplicitAuthFlows: ["ALLOW_USER_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
      EnableTokenRevocation: true,
      SupportedIdentityProviders: ["COGNITO"],
    });
  });

  it("issues 60-minute access and ID tokens and rotating 30-day refresh tokens", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 30 * 24 * 60,
      TokenValidityUnits: { AccessToken: "minutes", IdToken: "minutes", RefreshToken: "minutes" },
      RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 10 },
    });
  });

  it("lets users write only their email and name, never a verified flag", () => {
    for (const context of [{}, { appleSignIn: true, googleSignIn: true }]) {
      const { template } = build({ envName: "staging" }, context);
      const client = only(template, "AWS::Cognito::UserPoolClient");
      expect((client.Properties.WriteAttributes as string[]).sort()).toEqual(["email", "family_name", "given_name"]);
    }
  });

  it("returns only to app. in prod, and also to the local dev server elsewhere or when asked", () => {
    const urls = (template: Template) => {
      const client = only(template, "AWS::Cognito::UserPoolClient");
      expect(client.Properties.LogoutURLs).toEqual(client.Properties.CallbackURLs);
      return client.Properties.CallbackURLs;
    };
    expect(urls(build().template)).toEqual(["https://app.supplycheckout.com/"]);
    expect(urls(build({ envName: "dev" }).template)).toEqual(["https://app.dev.supplycheckout.com/", `${LOCAL_DEV_ORIGIN}/`]);
    expect(urls(build({}, { localhostCallbacks: true }).template)).toEqual(["https://app.supplycheckout.com/", `${LOCAL_DEV_ORIGIN}/`]);
    expect(urls(build({ envName: "dev" }, { localhostCallbacks: "false" }).template)).toEqual(["https://app.dev.supplycheckout.com/"]);
  });
});

describe("Apple and Google sign-in", () => {
  const secretRef = (secret: string, field: string) => `{{resolve:secretsmanager:${secret}:SecretString:${field}::}}`;

  it("are off by default", () => {
    const { template } = build();
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });

  it("turn on from context, reading every value from Secrets Manager at deploy time", () => {
    const { template } = build({ envName: "staging" }, { appleSignIn: true, googleSignIn: "true" });
    const secrets = identityProviderSecrets("staging");
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "Google",
      ProviderType: "Google",
      ProviderDetails: {
        client_id: secretRef(secrets.google, "clientId"),
        client_secret: secretRef(secrets.google, "clientSecret"),
        authorize_scopes: "openid email profile",
      },
      AttributeMapping: { email: "email", given_name: "given_name", family_name: "family_name" },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "SignInWithApple",
      ProviderType: "SignInWithApple",
      ProviderDetails: {
        client_id: secretRef(secrets.apple, "servicesId"),
        team_id: secretRef(secrets.apple, "teamId"),
        key_id: secretRef(secrets.apple, "keyId"),
        private_key: secretRef(secrets.apple, "privateKey"),
        authorize_scopes: "name email",
      },
      AttributeMapping: Match.objectLike({ email: "email" }),
    });
    // Referencing the providers also makes CloudFormation create them before the client
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["COGNITO", { Ref: Match.stringLikeRegexp("^Google") }, { Ref: Match.stringLikeRegexp("^Apple") }],
    });
  });

  it("map only attributes the web client may write, and never email_verified", () => {
    const { template } = build({ envName: "staging" }, { appleSignIn: true, googleSignIn: true });
    const writable = only(template, "AWS::Cognito::UserPoolClient").Properties.WriteAttributes as string[];
    const providers = Object.values(template.findResources("AWS::Cognito::UserPoolIdentityProvider"));
    expect(providers).toHaveLength(2);
    for (const provider of providers) {
      const mapped = Object.keys(provider.Properties.AttributeMapping as Record<string, string>);
      expect(mapped).not.toContain("email_verified");
      for (const attribute of mapped) expect(writable, attribute).toContain(attribute);
    }
  });

  it("can be turned on one at a time", () => {
    const { template } = build({}, { googleSignIn: true });
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", { SupportedIdentityProviders: ["COGNITO", { Ref: Match.stringLikeRegexp("^Google") }] });
  });

  it("read their flags strictly", () => {
    const ctx = (values: Record<string, unknown>) => ({ tryGetContext: (key: string) => values[key] });
    expect(identityOptionsFromContext(ctx({}), "prod")).toEqual({ apple: false, google: false, localhostCallbacks: false });
    expect(identityOptionsFromContext(ctx({ appleSignIn: "", googleSignIn: false }), "dev")).toEqual({ apple: false, google: false, localhostCallbacks: true });
    expect(identityOptionsFromContext(ctx({ appleSignIn: "true", googleSignIn: true, localhostCallbacks: "false" }), "dev")).toEqual({
      apple: true,
      google: true,
      localhostCallbacks: false,
    });
    expect(() => identityOptionsFromContext(ctx({ appleSignIn: "yes" }), "prod")).toThrow(/appleSignIn must be true or false/);
  });
});

describe("outputs for the API and the web app", () => {
  it("publishes the pool, the web client, the issuer and the auth URL to SSM", () => {
    const { template } = build();
    const out = identityOutputParameters("prod");
    const poolId = Object.keys(template.findResources("AWS::Cognito::UserPool"))[0];
    const clientId = Object.keys(template.findResources("AWS::Cognito::UserPoolClient"))[0];
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.userPoolId, Value: { Ref: poolId } });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.userPoolArn, Value: { "Fn::GetAtt": [poolId, "Arn"] } });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.webClientId, Value: { Ref: clientId } });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.issuerUrl, Value: { "Fn::GetAtt": [poolId, "ProviderURL"] } });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.authUrl, Value: "https://auth.supplycheckout.com" });
  });

  it("gives the api stack a JWT authorizer for the pool, from those parameters", () => {
    const app = new App();
    const stack = new Stack(app, "Api");
    const api = new HttpApi(stack, "Api");
    api.addRoutes({
      path: "/me",
      methods: [HttpMethod.GET],
      integration: new HttpUrlIntegration("Me", "https://example.com"),
      authorizer: cognitoJwtAuthorizer(stack, { envName: "staging" }),
    });
    const template = Template.fromStack(stack);
    const out = identityOutputParameters("staging");
    template.hasParameter("*", ssmParameter(out.issuerUrl));
    template.hasParameter("*", ssmParameter(out.webClientId));
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      Name: "cognito-jwt",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: {
        Issuer: { Ref: Match.stringLikeRegexp("issuerurl") },
        Audience: [{ Ref: Match.stringLikeRegexp("webclientid") }],
      },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /me", AuthorizationType: "JWT" });
  });
});

describe("cdk-nag", () => {
  it("finds nothing unacknowledged with both providers on, in either region", () => {
    for (const region of APPROVED_REGIONS) {
      const { app } = build({ regions: [region], primaryRegion: region }, { appleSignIn: true, googleSignIn: true, localhostCallbacks: true });
      const report = new AwsSolutionsChecks(app).validateScope(app);
      expect(report.violations).toEqual([]);
    }
  });
});
