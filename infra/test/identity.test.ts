import { readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUrlIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { domainOutputParameters, dnsInputParameters } from "../lib/domain.js";
import { OPERATORS_GROUP } from "../../backend/src/identity/names.js";
import {
  cognitoJwtAuthorizer,
  OPS_CLI_CALLBACK,
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
/** The customer pool's one resource of a type (the operator pool's, whose IDs start with Ops, are tested below). */
const only = (template: Template, type: string) => {
  const found = Object.entries(template.findResources(type)).filter(([id]) => !id.startsWith("Ops")).map(([, r]) => r);
  expect(found, type).toHaveLength(1);
  return found[0];
};
/** The operator pool's one resource of a type. */
const ops = (template: Template, type: string) => {
  const found = Object.entries(template.findResources(type)).filter(([id]) => id.startsWith("Ops")).map(([, r]) => r);
  expect(found, type).toHaveLength(1);
  return found[0] as { Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
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

  it("lets users write only their email and name, never a verified flag or the linked email", () => {
    const writable = (context: Record<string, unknown>) =>
      (only(build({ envName: "staging" }, context).template, "AWS::Cognito::UserPoolClient").Properties.WriteAttributes as string[]).sort();
    expect(writable({})).toEqual(["email", "family_name", "given_name"]);
    // With a provider on, also the attributes the providers map claims to (Cognito requires it); the triggers decide what they mean
    for (const context of [{ googleSignIn: true }, { appleSignIn: true }, { appleSignIn: true, googleSignIn: true }]) {
      expect(writable(context)).toEqual(["custom:idp_email_verified", "custom:idp_hd", "email", "family_name", "given_name"]);
      expect(writable(context)).not.toContain("custom:linked_email");
    }
  });

  it("lets the web client read every attribute, so GetUser returns a linked user's recorded email and identities", () => {
    // The account API counts a linked user's email as verified only while it's custom:linked_email
    // (backend/src/api/cognito-user.ts); GetUser returns only attributes the token's client can read
    for (const context of [{}, { appleSignIn: true, googleSignIn: true }]) {
      expect(only(build({ envName: "staging" }, context).template, "AWS::Cognito::UserPoolClient").Properties.ReadAttributes).toBeUndefined();
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
      AttributeMapping: { email: "email", given_name: "given_name", family_name: "family_name", "custom:idp_email_verified": "email_verified", "custom:idp_hd": "hd" },
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
      AttributeMapping: Match.objectLike({ email: "email", "custom:idp_email_verified": "email_verified" }),
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

  it("keep mutable custom attributes for the providers' claims and the linked email, even with both off", () => {
    for (const context of [{}, { googleSignIn: true }]) {
      build({}, context).template.hasResourceProperties("AWS::Cognito::UserPool", {
        Schema: Match.arrayWith([
          { Name: "idp_email_verified", AttributeDataType: "String", Mutable: true },
          { Name: "idp_hd", AttributeDataType: "String", Mutable: true },
          { Name: "linked_email", AttributeDataType: "String", Mutable: true },
        ]),
      });
    }
  });

  it("map custom:linked_email from no provider, so only the linking trigger sets it", () => {
    const { template } = build({}, { appleSignIn: true, googleSignIn: true });
    for (const provider of Object.values(template.findResources("AWS::Cognito::UserPoolIdentityProvider"))) {
      expect(Object.keys(provider.Properties.AttributeMapping as Record<string, string>)).not.toContain("custom:linked_email");
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

describe("Google and Apple triggers (supply-checkout-6v9)", () => {
  const withProviders = () => build({ envName: "staging" }, { appleSignIn: true, googleSignIn: true });
  /** The logical ID of the function whose Code comes from backend/src/identity/<name>.ts. */
  const fnId = (template: Template, id: string) => {
    const found = Object.keys(template.findResources("AWS::Lambda::Function")).filter((k) => k.startsWith(id));
    expect(found, id).toHaveLength(1);
    return found[0] as string;
  };
  const statementsOf = (template: Template, roleId: string) =>
    Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((p) => JSON.stringify(p.Properties.Roles) === JSON.stringify([{ Ref: roleId }]))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[]);
  const sameStatements = (actual: unknown[], expected: unknown[]) => {
    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  };
  const roleOf = (template: Template, id: string) =>
    (template.toJSON().Resources[fnId(template, id)].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];

  it("aren't there with both providers off", () => {
    const { stacks, template } = build();
    expect(stacks.identity.federatedTriggers).toBeUndefined();
    template.resourceCountIs("AWS::Lambda::Function", 0);
    expect(only(template, "AWS::Cognito::UserPool").Properties.LambdaConfig).toBeUndefined();
  });

  it("guard native sign-ins, set email_verified before every token and link sign-ups to existing accounts, with either provider on", () => {
    for (const context of [{ googleSignIn: true }, { appleSignIn: true }]) {
      const { stacks, template } = build({}, context);
      expect(stacks.identity.federatedTriggers).toBeDefined();
      template.resourceCountIs("AWS::Lambda::Function", 3);
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        LambdaConfig: {
          PreAuthentication: { "Fn::GetAtt": [fnId(template, "SignInGuard"), "Arn"] },
          PreTokenGeneration: { "Fn::GetAtt": [fnId(template, "EmailVerified"), "Arn"] },
          PreSignUp: { "Fn::GetAtt": [fnId(template, "AccountLink"), "Arn"] },
        },
      });
      for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
        expect(fn.Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: 5 });
      }
    }
    const source = readFileSync(new URL("../lib/stacks/identity-stack.ts", import.meta.url), "utf8");
    expect(source).toContain("src/identity/${name}.ts");
    expect(source).toMatch(/trigger\("SignInGuard", "sign-in-guard"/);
    expect(source).toMatch(/trigger\("EmailVerified", "email-verified"/);
    expect(source).toMatch(/trigger\("AccountLink", "account-link"/);
  });

  it("may each be invoked only by this pool", () => {
    const { template } = withProviders();
    const poolId = Object.keys(template.findResources("AWS::Cognito::UserPool"))[0];
    const permissions = Object.values(template.findResources("AWS::Lambda::Permission")).map((p) => p.Properties);
    expect(permissions).toHaveLength(3);
    for (const id of ["SignInGuard", "EmailVerified", "AccountLink"]) {
      expect(permissions).toContainEqual({
        Action: "lambda:InvokeFunction",
        FunctionName: { "Fn::GetAtt": [fnId(template, id), "Arn"] },
        Principal: "cognito-idp.amazonaws.com",
        SourceArn: { "Fn::GetAtt": [poolId, "Arn"] },
      });
    }
  });

  it("give the guard no AWS permissions, the email_verified trigger only AdminUpdateUserAttributes and the linking trigger only ListUsers, AdminUpdateUserAttributes and AdminLinkProviderForUser, on this pool", () => {
    const { template } = withProviders();
    const poolId = Object.keys(template.findResources("AWS::Cognito::UserPool"))[0];
    const xray = { Effect: "Allow", Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource: "*" };
    const logs = (id: string) => ({ Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": [Object.keys(template.findResources("AWS::Logs::LogGroup")).find((k) => k.startsWith(`${id}Logs`)), "Arn"] } });
    sameStatements(statementsOf(template, roleOf(template, "SignInGuard")), [logs("SignInGuard"), xray]);
    const setVerified = { Sid: "SetEmailVerified", Effect: "Allow", Action: "cognito-idp:AdminUpdateUserAttributes", Resource: { "Fn::GetAtt": [poolId, "Arn"] } };
    sameStatements(statementsOf(template, roleOf(template, "EmailVerified")), [logs("EmailVerified"), xray, setVerified]);
    const link = { Sid: "LinkToExistingAccount", Effect: "Allow", Action: ["cognito-idp:ListUsers", "cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminLinkProviderForUser"], Resource: { "Fn::GetAtt": [poolId, "Arn"] } };
    sameStatements(statementsOf(template, roleOf(template, "AccountLink")), [logs("AccountLink"), xray, link]);
    for (const role of Object.values(template.findResources("AWS::IAM::Role"))) expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it("get their grant after the pool exists, so the pool can name the functions (no dependency cycle)", () => {
    const { template } = withProviders();
    const poolId = Object.keys(template.findResources("AWS::Cognito::UserPool"))[0] as string;
    const grantIds = ["EmailVerifiedUpdateUser", "AccountLinkUsers"].map(
      (name) => Object.keys(template.findResources("AWS::IAM::Policy", { Properties: { PolicyName: Match.stringLikeRegexp(name) } }))[0],
    );
    for (const grantId of grantIds) expect(grantId).toBeDefined();
    for (const [id, fn] of Object.entries(template.findResources("AWS::Lambda::Function")) as [string, { DependsOn?: string[]; Properties: unknown }][]) {
      for (const grantId of grantIds) expect(fn.DependsOn ?? [], id).not.toContain(grantId);
      expect(JSON.stringify(fn.Properties), id).not.toContain(poolId);
    }
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

describe("operator pool (ADR 0015)", () => {
  it("is a second Essentials pool, protected from deletion and retained, in the primary region", () => {
    const { template } = build();
    const pool = ops(template, "AWS::Cognito::UserPool");
    expect(pool.DeletionPolicy).toBe("Retain");
    expect(pool.UpdateReplacePolicy).toBe("Retain");
    expect(pool.Properties).toMatchObject({ UserPoolName: "supply-checkout-prod-ops", UserPoolTier: "ESSENTIALS", DeletionProtection: "ACTIVE" });
  });

  it("has no self sign-up, and signs in only with a password then TOTP, which is required", () => {
    const pool = ops(build().template, "AWS::Cognito::UserPool").Properties;
    expect(pool.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: true });
    expect(pool.MfaConfiguration).toBe("ON");
    expect(pool.EnabledMfas).toEqual(["SOFTWARE_TOKEN_MFA"]);
    expect((pool.Policies as { SignInPolicy: unknown }).SignInPolicy).toEqual({ AllowedFirstAuthFactors: ["PASSWORD"] });
    expect((pool.Policies as { PasswordPolicy: { MinimumLength: number } }).PasswordPolicy.MinimumLength).toBeGreaterThanOrEqual(16);
    // No email or phone: nothing to verify or send, no self-service recovery, no passkeys, no triggers
    expect(pool.AccountRecoverySetting).toEqual({ RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }] });
    for (const key of ["UsernameAttributes", "AliasAttributes", "AutoVerifiedAttributes", "EmailConfiguration", "SmsConfiguration", "WebAuthnRelyingPartyID", "LambdaConfig"]) expect(pool[key], key).toBeUndefined();
  });

  it("has the operators group, and no identity providers", () => {
    const { template } = build();
    const group = ops(template, "AWS::Cognito::UserPoolGroup").Properties;
    expect(group).toMatchObject({ GroupName: OPERATORS_GROUP, UserPoolId: { Ref: expect.stringMatching(/^OpsUserPool/) } });
    expect(group.RoleArn).toBeUndefined();
    for (const [, idp] of Object.entries(template.findResources("AWS::Cognito::UserPoolIdentityProvider"))) {
      expect(JSON.stringify(idp.Properties.UserPoolId)).not.toContain("OpsUserPool");
    }
  });

  it("has one public ops client: code with PKCE to the CLI's localhost callback, 15-minute tokens, 8-hour refresh with rotation, no API sign-in", () => {
    const client = ops(build().template, "AWS::Cognito::UserPoolClient").Properties;
    expect(client).toMatchObject({
      ClientName: "ops",
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "aws.cognito.signin.user.admin"],
      CallbackURLs: [OPS_CLI_CALLBACK],
      LogoutURLs: [OPS_CLI_CALLBACK],
      SupportedIdentityProviders: ["COGNITO"],
      ExplicitAuthFlows: [],
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      RefreshTokenValidity: 480,
      TokenValidityUnits: { AccessToken: "minutes", IdToken: "minutes", RefreshToken: "minutes" },
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: "ENABLED",
      RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 10 },
    });
    expect(client.WriteAttributes).toEqual(["family_name", "given_name"]);
  });

  it("serves Managed Login at ops-auth. with its own certificate, and publishes its settings", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: "ops-auth.supplycheckout.com", UserPoolId: { Ref: Match.stringLikeRegexp("^OpsUserPool") }, ManagedLoginVersion: 2 });
    template.hasParameter("*", ssmParameter(domainOutputParameters("prod").opsAuthCertificateArn));
    for (const type of ["A", "AAAA"]) template.hasResourceProperties("AWS::Route53::RecordSet", { Name: "ops-auth.supplycheckout.com.", Type: type });
    expect(ops(template, "AWS::Cognito::ManagedLoginBranding").Properties).toMatchObject({ UseCognitoProvidedValues: true });
    const out = identityOutputParameters("prod");
    for (const name of [out.opsUserPoolId, out.opsUserPoolArn, out.opsClientId, out.opsIssuerUrl]) template.hasResourceProperties("AWS::SSM::Parameter", { Name: name });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.opsAuthUrl, Value: "https://ops-auth.supplycheckout.com" });
  });
});
