import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, SecretValue, Validations } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  ClientAttributes,
  FeaturePlan,
  ManagedLoginVersion,
  Mfa,
  OAuthScope,
  PasskeyUserVerification,
  ProviderAttribute,
  StringAttribute,
  UserPool,
  type UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolEmail,
  UserPoolIdentityProviderApple,
  UserPoolIdentityProviderGoogle,
  UserPoolOperation,
  type IUserPoolIdentityProvider,
} from "aws-cdk-lib/aws-cognito";
import { Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { AaaaRecord, ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { PROVIDER_EMAIL_VERIFIED, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "../../../backend/src/identity/names.js";
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
import { LOG_RETENTION } from "../observability/defaults.js";
import { bundling } from "./api-stack.js";
import { SupplyCheckoutStack } from "./base-stack.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

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
 * `aws.cognito.signin.user.admin` scope.
 *
 * Verified emails from Google and Apple: with either provider on, a pre token
 * generation trigger (backend/src/identity/email-verified-handler.ts) sets
 * email_verified from the provider's own claim, which the providers map to
 * `custom:idp_email_verified` (they can't map email_verified itself: it would
 * have to be client-writable). A pre authentication trigger keeps Google and
 * Apple users to their provider, so that claim is fresh whenever it's read
 * (see addFederatedTriggers). A pre sign-up trigger links a first Apple or
 * Google sign-in to an existing account with the same verified email
 * (AdminLinkProviderForUser, supply-checkout-0b1).
 *
 * The auth. certificate is read from the domain stack's SSM output in this
 * region. When the primary region isn't GLOBAL_SERVICES_REGION, copy that
 * parameter here first (see "Sign-in" in docs/infrastructure.md).
 */
export class IdentityStack extends SupplyCheckoutStack {
  readonly userPool: UserPool;
  readonly webClient: UserPoolClient;
  readonly domain: UserPoolDomain;
  readonly options: IdentityOptions;
  /** The pre authentication, pre token generation and pre sign-up triggers, when Google or Apple sign-in is on. */
  readonly federatedTriggers?: { readonly signInGuard: NodejsFunction; readonly emailVerified: NodejsFunction; readonly accountLink: NodejsFunction };

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
      // Google's and Apple's email_verified claim, for the trigger. Defined even
      // with both providers off, since a custom attribute can't be removed.
      // Mutable: Cognito rewrites it from the provider at every sign-in.
      customAttributes: { [PROVIDER_EMAIL_VERIFIED]: new StringAttribute({ mutable: true }) },
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
      // Until the account has SES production access, SES only delivers to
      // verified addresses, so sign-up email reaches only those.
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
    if (providers.length) this.federatedTriggers = this.addFederatedTriggers();

    const writable = new ClientAttributes().withStandardAttributes({ email: true, givenName: true, familyName: true });
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
      // What a signed-in user may change about themselves (UpdateUserAttributes,
      // which the admin scope allows). Never email_verified or
      // phone_number_verified: the API trusts a verified email to list and
      // accept invites. Changing `email` keeps the old, verified address until
      // the new one is confirmed with a code (keepOriginal). Attributes an IdP
      // maps must be in this list, so the IdPs don't map emailVerified; they
      // map their claim to custom:idp_email_verified, which the trigger reads
      // only at a provider sign-in, right after Cognito has rewritten it.
      writeAttributes: providers.length
        ? writable.withCustomAttributes(PROVIDER_EMAIL_VERIFIED)
        : writable,
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
            // No emailVerified: an IdP-mapped attribute must be client-writable,
            // and email_verified mustn't be (see the web client's writeAttributes)
            email: ProviderAttribute.GOOGLE_EMAIL,
            givenName: ProviderAttribute.GOOGLE_GIVEN_NAME,
            familyName: ProviderAttribute.GOOGLE_FAMILY_NAME,
            custom: { [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: ProviderAttribute.GOOGLE_EMAIL_VERIFIED },
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
            givenName: ProviderAttribute.APPLE_FIRST_NAME,
            familyName: ProviderAttribute.APPLE_LAST_NAME,
            custom: { [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: ProviderAttribute.APPLE_EMAIL_VERIFIED },
          },
        }),
      );
    }
    return providers;
  }

  /**
   * The triggers for Google and Apple users (backend/src/identity):
   *
   * - Pre authentication (sign-in-guard-handler.ts) refuses every native
   *   sign-in (password, email code, passkey) by a federated-only user, so
   *   they sign in only through their provider. It needs no AWS permissions.
   * - Pre token generation (email-verified-handler.ts) sets email_verified
   *   from the provider's claim at each provider sign-in. It relies on the
   *   guard: the attribute it reads is user-writable, and is fresh from the
   *   provider only at a provider sign-in. Its role may also call
   *   AdminUpdateUserAttributes on this pool.
   * - Pre sign-up (account-link-handler.ts) links a first Google or Apple
   *   sign-in whose provider says the email is verified to the one confirmed
   *   native user with that verified email. Its role may also call ListUsers
   *   (to find that user; IAM can't limit the filter, so the code searches
   *   by exact email only) and AdminLinkProviderForUser on this pool.
   *
   * The pool names each function (LambdaConfig), so a function can't name
   * the pool: each grant is a separate policy attached to the role after the
   * pool exists, and the function doesn't wait for it. A trigger's first
   * call comes with a sign-in, after the deploy.
   */
  private addFederatedTriggers(): { signInGuard: NodejsFunction; emailVerified: NodejsFunction; accountLink: NodejsFunction } {
    const signInGuard = this.trigger("SignInGuard", "sign-in-guard", "Refuses password, email-code and passkey sign-ins by Google and Apple users");
    this.userPool.addTrigger(UserPoolOperation.PRE_AUTHENTICATION, signInGuard);

    const emailVerified = this.trigger("EmailVerified", "email-verified", "Sets email_verified for Google and Apple users from the provider's own claim");
    this.userPool.addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION, emailVerified);
    new Policy(this, "EmailVerifiedUpdateUser", {
      roles: [emailVerified.role as Role],
      statements: [
        new PolicyStatement({
          sid: "SetEmailVerified",
          actions: ["cognito-idp:AdminUpdateUserAttributes"],
          resources: [this.userPool.userPoolArn],
        }),
      ],
    });

    const accountLink = this.trigger("AccountLink", "account-link", "Links a first Google or Apple sign-in to the existing account with the same verified email");
    this.userPool.addTrigger(UserPoolOperation.PRE_SIGN_UP, accountLink);
    new Policy(this, "AccountLinkUsers", {
      roles: [accountLink.role as Role],
      statements: [
        new PolicyStatement({
          sid: "LinkToExistingAccount",
          actions: ["cognito-idp:ListUsers", "cognito-idp:AdminLinkProviderForUser"],
          resources: [this.userPool.userPoolArn],
        }),
      ],
    });
    return { signInGuard, emailVerified, accountLink };
  }

  /** A function from backend/src/identity/<name>.ts, with its own log group and a role that can write only to it. */
  private trigger(id: string, name: string, description: string): NodejsFunction {
    const logGroup = new LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION });
    const role = new Role(this, `${id}Role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the user pool's ${name} trigger`,
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    return new NodejsFunction(this, id, {
      role,
      logGroup,
      entry: `${BACKEND}src/identity/${name}.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // Cognito waits 5 seconds for a trigger
      timeout: Duration.seconds(5),
      description,
      environment: { NODE_OPTIONS: "--enable-source-maps" },
      bundling,
    });
  }
}
