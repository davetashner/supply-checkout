import { Duration, RemovalPolicy, SecretValue, Validations } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  FeaturePlan,
  ManagedLoginVersion,
  Mfa,
  OAuthScope,
  PasskeyUserVerification,
  ProviderAttribute,
  UserPool,
  type UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolEmail,
  UserPoolIdentityProviderApple,
  UserPoolIdentityProviderGoogle,
  type IUserPoolIdentityProvider,
} from "aws-cdk-lib/aws-cognito";
import { AaaaRecord, ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { domainOutputParameters, hostNames, importZone } from "../domain.js";
import {
  type IdentityOptions,
  LOCAL_DEV_ORIGIN,
  identityOptionsFromContext,
  identityOutputParameters,
  identityProviderSecrets,
  managedLoginBranding,
} from "../identity.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * The Cognito user pool, in the primary region only (ADR 0007,
 * supply-checkout-zsm). Both regions verify JWTs locally against its signing
 * keys (ADR 0010).
 *
 * - Essentials tier: Managed Login, and choice-based sign-in with an email
 *   code, a password or a passkey. Plus (threat protection) isn't needed yet.
 * - Optional TOTP MFA. Owners must have MFA on before they change billing;
 *   that's enforced by the billing routes, not here (see below).
 * - Managed Login at `auth.<env domain>` with the app's colors. Passkeys use
 *   that host as their relying party ID, which Cognito requires with a custom
 *   domain. Passkeys are bound to it: changing the domain orphans them.
 * - One public app client for the web app: authorization code with PKCE, no
 *   secret; 60-minute access and ID tokens, 30-day refresh tokens with rotation.
 * - Sign in with Apple and Google, each only when turned on in context
 *   (`-c appleSignIn=true`, `-c googleSignIn=true`) and its secret exists.
 *
 * Owners before billing: the billing routes (supply-checkout-d8b and the
 * billing beads) call AdminGetUser for the caller's `sub` and refuse any change
 * with 403 `mfa_required` unless `UserMFASettingList` contains
 * `SOFTWARE_TOKEN_MFA`. The web app sets TOTP up with AssociateSoftwareToken
 * and VerifySoftwareToken, which is why the client grants the
 * `aws.cognito.signin.user.admin` scope. No trigger Lambda is needed for the
 * MVP. Later: a pre sign-up trigger to link an Apple or Google sign-in to an
 * existing account with the same email (AdminLinkProviderForUser).
 *
 * The auth. certificate is read from the domain stack's SSM output in this
 * region. When the primary region isn't GLOBAL_SERVICES_REGION, copy that
 * parameter here first (see the README).
 */
export class IdentityStack extends SupplyCheckoutStack {
  readonly userPool: UserPool;
  readonly webClient: UserPoolClient;
  readonly domain: UserPoolDomain;
  readonly options: IdentityOptions;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "identity", layer: "stateful" });

    const names = hostNames(config);
    const outputs = identityOutputParameters(config.envName);
    const secrets = identityProviderSecrets(config.envName);
    this.options = identityOptionsFromContext(this.node, config.envName);

    this.userPool = new UserPool(this, "UserPool", {
      userPoolName: `supply-checkout-${config.envName}`,
      featurePlan: FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: "Your Supply Checkout verification code",
        emailBody: "Your Supply Checkout verification code is {####}. It expires in 24 hours.",
      },
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true, passkey: true } },
      passkeyRelyingPartyId: names.auth,
      passkeyUserVerification: PasskeyUserVerification.PREFERRED,
      // Passwordless sign-in requires MFA to be optional, not required.
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      // Email codes need SES; the domain stack verified the domain in this region.
      email: UserPoolEmail.withSES({
        fromEmail: `noreply@${names.apex}`,
        fromName: "Supply Checkout",
        sesVerifiedDomain: names.apex,
        sesRegion: region,
      }),
    });
    Validations.of(this.userPool).acknowledge(
      {
        id: "AwsSolutions-COG2",
        reason: "ADR 0007: MFA is optional for users. Cognito requires optional MFA for passwordless (email code, passkey) sign-in, and owners must turn on TOTP before billing changes, enforced by the billing routes.",
      },
      {
        id: "AwsSolutions-COG8",
        reason: "ADR 0007 chose the Essentials tier: it has Managed Login and passkeys, and the Plus tier's threat protection costs more per active user than the $3 plan can carry at launch. Revisit with supply-checkout-4p1.",
      },
    );

    // Managed Login at auth.<env domain>. Cognito serves it through CloudFront,
    // so the certificate is in GLOBAL_SERVICES_REGION. Cognito also requires
    // the parent domain (the apex) to resolve before it creates the domain,
    // so this stack deploys after the web stack and its apex record.
    const certificate = Certificate.fromCertificateArn(
      this,
      "AuthCertificate",
      StringParameter.valueForStringParameter(this, domainOutputParameters(config.envName).authCertificateArn),
    );
    this.domain = this.userPool.addDomain("Domain", {
      customDomain: { domainName: names.auth, certificate },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const zone = importZone(this, config);
    // An alias to the domain's CloudFront distribution attribute. (Route 53's
    // UserPoolDomainTarget looks the name up with a custom resource unless a
    // feature flag is set; this needs neither.)
    const target = RecordTarget.fromAlias({
      bind: () => ({ hostedZoneId: CloudFrontTarget.getHostedZoneId(this), dnsName: this.domain.cloudFrontEndpoint }),
    });
    new ARecord(this, "AuthAlias", { zone, recordName: names.auth, target });
    new AaaaRecord(this, "AuthAliasIpv6", { zone, recordName: names.auth, target });

    const providers = this.addSocialProviders(secrets);

    const appUrl = `https://${names.app}/`;
    const urls = this.options.localhostCallbacks ? [appUrl, `${LOCAL_DEV_ORIGIN}/`] : [appUrl];
    this.webClient = this.userPool.addClient("WebClient", {
      userPoolClientName: "web",
      generateSecret: false,
      authFlows: { user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE, OAuthScope.COGNITO_ADMIN],
        callbackUrls: urls,
        logoutUrls: urls,
      },
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO,
        // References to the providers, so CloudFormation creates them first
        ...providers.map((p) => UserPoolClientIdentityProvider.custom(p.providerName)),
      ],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      // Rotation: every refresh returns a new refresh token. The old one keeps
      // working briefly so two tabs refreshing at once don't sign each other out.
      refreshTokenRotationGracePeriod: Duration.seconds(10),
    });

    new CfnManagedLoginBranding(this, "Branding", {
      userPoolId: this.userPool.userPoolId,
      clientId: this.webClient.userPoolClientId,
      settings: managedLoginBranding,
    });

    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: name, stringValue: value, description });
    publish("UserPoolIdParam", outputs.userPoolId, this.userPool.userPoolId, "Cognito user pool ID");
    publish("UserPoolArnParam", outputs.userPoolArn, this.userPool.userPoolArn, "Cognito user pool ARN");
    publish("WebClientIdParam", outputs.webClientId, this.webClient.userPoolClientId, "Web app client ID (public, PKCE): the JWT audience");
    publish("IssuerUrlParam", outputs.issuerUrl, this.userPool.userPoolProviderUrl, "JWT issuer for the API authorizer");
    publish("AuthUrlParam", outputs.authUrl, `https://${names.auth}`, "Managed Login and OAuth endpoints");
  }

  private addSocialProviders(secrets: ReturnType<typeof identityProviderSecrets>): IUserPoolIdentityProvider[] {
    const providers: IUserPoolIdentityProvider[] = [];
    // Dynamic references ({{resolve:secretsmanager:…}}), resolved by
    // CloudFormation at deploy time. The IDs aren't secret, but they're
    // account-specific, so they stay out of the template and the repository.
    const field = (secret: string, name: string) => SecretValue.secretsManager(secret, { jsonField: name });

    if (this.options.google) {
      providers.push(
        new UserPoolIdentityProviderGoogle(this, "Google", {
          userPool: this.userPool,
          clientId: field(secrets.google, "clientId").unsafeUnwrap(),
          clientSecretValue: field(secrets.google, "clientSecret"),
          scopes: ["openid", "email", "profile"],
          attributeMapping: {
            email: ProviderAttribute.GOOGLE_EMAIL,
            emailVerified: ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
            givenName: ProviderAttribute.GOOGLE_GIVEN_NAME,
            familyName: ProviderAttribute.GOOGLE_FAMILY_NAME,
          },
        }),
      );
    }
    if (this.options.apple) {
      providers.push(
        new UserPoolIdentityProviderApple(this, "Apple", {
          userPool: this.userPool,
          clientId: field(secrets.apple, "servicesId").unsafeUnwrap(),
          teamId: field(secrets.apple, "teamId").unsafeUnwrap(),
          keyId: field(secrets.apple, "keyId").unsafeUnwrap(),
          privateKeyValue: field(secrets.apple, "privateKey"),
          scopes: ["name", "email"],
          attributeMapping: {
            email: ProviderAttribute.APPLE_EMAIL,
            emailVerified: ProviderAttribute.APPLE_EMAIL_VERIFIED,
            givenName: ProviderAttribute.APPLE_FIRST_NAME,
            familyName: ProviderAttribute.APPLE_LAST_NAME,
          },
        }),
      );
    }
    return providers;
  }
}
