import { fileURLToPath } from "node:url";
import { ArnFormat, Aws, Duration, RemovalPolicy, SecretValue, Stack, Validations } from "aws-cdk-lib";
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
  UserPoolGroup,
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
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import {
  DOWNGRADE_PENDING,
  LINKED_EMAIL,
  LOG_CORRELATION_KEY_ENV,
  OPERATORS_GROUP,
  PROVIDER_EMAIL_VERIFIED,
  PROVIDER_EMAIL_VERIFIED_ATTRIBUTE,
  PROVIDER_HOSTED_DOMAIN,
  PROVIDER_HOSTED_DOMAIN_ATTRIBUTE,
  SECURITY_NOTICES_FUNCTION_ENV,
  identityResourceNames,
} from "../../../backend/src/identity/names.js";
import { emailResourceNames, WELCOME_FUNCTION_ENV } from "../../../backend/src/email/names.js";
import { NOTICE_ADDRESS_CHECK_ATTRIBUTES, NOTICE_ADDRESS_RECORD_ATTRIBUTES, PASSWORD_RESET_RECORD_ATTRIBUTES, tableName, VERIFIED_EMAIL_ATTRIBUTES } from "../../../backend/src/data/schema.js";
import type { DeploymentConfig } from "../config.js";
import { domainOutputParameters, hostNames, importZone } from "../domain.js";
import {
  type IdentityOptions,
  LOCAL_DEV_ORIGIN,
  OPS_CLI_CALLBACK,
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
 * Owners before billing (supply-checkout-8jc.12): the billing routes call
 * GetUser with the caller's own access token and refuse with 403
 * `mfa_required` unless `UserMFASettingList` contains `SOFTWARE_TOKEN_MFA` and
 * it's preferred (Google and Apple users excepted). The account API sets a
 * password (ChangePassword) and TOTP up (AssociateSoftwareToken,
 * VerifySoftwareToken, SetUserMFAPreference) and then signs the user out
 * everywhere (GlobalSignOut), all with the user's own token, which is why the
 * client grants the `aws.cognito.signin.user.admin` scope. No IAM grant.
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
  /** The operator pool (ADR 0015): password plus TOTP, no self sign-up, an `operators` group. */
  readonly opsPool: UserPool;
  readonly opsClient: UserPoolClient;
  readonly opsDomain: UserPoolDomain;
  readonly operatorsGroup: UserPoolGroup;
  /** The pre authentication, pre token generation and pre sign-up triggers, when Google or Apple sign-in is on. */
  readonly federatedTriggers?: { readonly signInGuard: NodejsFunction; readonly emailVerified: NodejsFunction; readonly accountLink: NodejsFunction };
  /** The post confirmation trigger that records a new account's notice address (supply-checkout-8jc.31) and hands over its welcome email (supply-checkout-6uw.25), on every app pool. */
  readonly postConfirmation: NodejsFunction;

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
      // Defined even with both providers off, since a custom attribute can't be
      // removed. Mutable: Cognito or a trigger rewrites them.
      // - Google's and Apple's email_verified claim, and Google's hd (Workspace
      //   domain), for the triggers. Cognito rewrites them at every provider sign-in.
      // - The email a native user had when a provider was linked to it, set only
      //   by the linking trigger: no IdP maps it and no client can write it.
      // - A linked user's pending downgrade, set and cleared only by the
      //   email_verified trigger (supply-checkout-0qr8): likewise never mapped
      //   and never client-writable. Clients can read it, as every attribute:
      //   the account API sees it through GetUser.
      customAttributes: {
        [PROVIDER_EMAIL_VERIFIED]: new StringAttribute({ mutable: true }),
        [PROVIDER_HOSTED_DOMAIN]: new StringAttribute({ mutable: true }),
        [LINKED_EMAIL]: new StringAttribute({ mutable: true }),
        [DOWNGRADE_PENDING]: new StringAttribute({ mutable: true }),
      },
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
      // The account needs SES production access (prod has it since 2026-10-07,
      // supply-checkout-3sv.18): in the sandbox SES delivers only to verified addresses.
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
    this.postConfirmation = this.addPostConfirmationTrigger();

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
      // only at a provider sign-in, right after Cognito has rewritten it; the
      // same goes for Google's hd in custom:idp_hd. Never custom:linked_email
      // or custom:downgrade_pending.
      writeAttributes: providers.length
        ? writable.withCustomAttributes(PROVIDER_EMAIL_VERIFIED, PROVIDER_HOSTED_DOMAIN)
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

    const ops = this.addOperatorPool(config, zone);
    this.opsPool = ops.pool;
    this.opsClient = ops.client;
    this.opsDomain = ops.domain;
    this.operatorsGroup = ops.group;
    publish("OpsUserPoolIdParam", outputs.opsUserPoolId, ops.pool.userPoolId, "Operator user pool ID (ADR 0015)");
    publish("OpsUserPoolArnParam", outputs.opsUserPoolArn, ops.pool.userPoolArn, "Operator user pool ARN (ADR 0015)");
    publish("OpsClientIdParam", outputs.opsClientId, ops.client.userPoolClientId, "Operator pool's ops client ID (public, PKCE): the ops authorizer's audience");
    publish("OpsIssuerUrlParam", outputs.opsIssuerUrl, ops.pool.userPoolProviderUrl, "JWT issuer for the ops authorizer");
    publish("OpsAuthUrlParam", outputs.opsAuthUrl, `https://${names.opsAuth}`, "Operator pool's Managed Login and OAuth endpoints");
    publish("OpsBrandingIdParam", outputs.opsBrandingId, ops.branding.attrManagedLoginBrandingId, "Operator pool's managed login branding ID: what the branding alerts match (supply-checkout-6uw.21)");
  }

  /**
   * The operator pool (ADR 0015), separate from the customers' pool:
   *
   * - No self sign-up. Operators are created only with `aws cognito-idp
   *   admin-create-user` (or the console) under an SSO role, and put in the
   *   `operators` group with `admin-add-user-to-group`. No Lambda role and no
   *   app client can create users or change groups.
   * - Username and password, then TOTP, which is required: the first sign-in
   *   sets it up, and the pool can't issue a token without it. So every token
   *   from this pool proves its session used MFA. No email codes, passkeys,
   *   SMS, Google or Apple, and no email at all: a forgotten password is
   *   reset by an administrator (`admin-set-user-password`), so nothing here
   *   sends mail.
   * - Managed Login at `ops-auth.<env domain>`, its own sign-in host.
   * - One public client, `ops`: authorization code with PKCE, calling back
   *   only to `npm run ops` on localhost and the operator page at
   *   `https://ops.<env domain>/` (supply-checkout-gxlt). Access and ID tokens last 15 minutes and
   *   refresh tokens 8 hours, with rotation and revocation. The
   *   aws.cognito.signin.user.admin scope is there for GetUser, which the ops
   *   function calls with the operator's token on every request.
   * - Primary region only: operators don't need phase 2's failover.
   */
  private addOperatorPool(config: DeploymentConfig, zone: ReturnType<typeof importZone>) {
    const names = hostNames(config);
    const pool = new UserPool(this, "OpsUserPool", {
      userPoolName: `supply-checkout-${config.envName}-ops`,
      featurePlan: FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      signInCaseSensitive: false,
      accountRecovery: AccountRecovery.NONE,
      signInPolicy: { allowedFirstAuthFactors: { password: true } },
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      passwordPolicy: {
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(1),
      },
    });
    Validations.of(pool).acknowledge(
      {
        id: "AwsSolutions-COG3",
        reason: "ADR 0015: the operator pool is on the Essentials tier like the customer pool (threat protection is Plus). It requires password plus TOTP, has no self sign-up, and a handful of users; CloudTrail alerts on its admin calls.",
      },
      {
        id: "AwsSolutions-COG8",
        reason: "ADR 0015: the Essentials tier, as for the customer pool (ADR 0007). The pool requires TOTP for every sign-in and has a handful of users; Plus's threat protection is revisited with supply-checkout-4p1.",
      },
    );
    const group = new UserPoolGroup(this, "OpsOperatorsGroup", {
      userPool: pool,
      groupName: OPERATORS_GROUP,
      description: "May call the /ops routes (ADR 0015). Granted only with admin-add-user-to-group under an SSO role.",
    });

    const certificate = Certificate.fromCertificateArn(
      this,
      "OpsAuthCertificate",
      StringParameter.valueForStringParameter(this, domainOutputParameters(config.envName).opsAuthCertificateArn),
    );
    const domain = pool.addDomain("OpsDomain", {
      customDomain: { domainName: names.opsAuth, certificate },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const target = RecordTarget.fromAlias({
      bind: () => ({ hostedZoneId: CloudFrontTarget.getHostedZoneId(this), dnsName: domain.cloudFrontEndpoint }),
    });
    new ARecord(this, "OpsAuthAlias", { zone, recordName: names.opsAuth, target });
    new AaaaRecord(this, "OpsAuthAliasIpv6", { zone, recordName: names.opsAuth, target });

    const client = pool.addClient("OpsClient", {
      userPoolClientName: "ops",
      generateSecret: false,
      // Sign-in only through Managed Login (authorization code with PKCE); no API sign-in flows
      authFlows: { user: false, userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.COGNITO_ADMIN],
        // The CLI on localhost, and the operator page's root (supply-checkout-gxlt): Cognito
        // matches them exactly, and the page takes the code and comes back from sign-out there
        callbackUrls: [OPS_CLI_CALLBACK, `https://${names.ops}/`],
        logoutUrls: [OPS_CLI_CALLBACK, `https://${names.ops}/`],
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      // Nothing the ops API trusts: groups aren't attributes, and no attribute is read
      readAttributes: new ClientAttributes().withStandardAttributes({ givenName: true, familyName: true }),
      writeAttributes: new ClientAttributes().withStandardAttributes({ givenName: true, familyName: true }),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.hours(8),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
    });
    const branding = new CfnManagedLoginBranding(this, "OpsBranding", {
      userPoolId: pool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    return { pool, client, domain, group, branding };
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
            custom: {
              [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
              // The Workspace domain, only for Workspace accounts: the linking trigger trusts
              // Google for a non-Gmail address only when this is the address's domain
              [PROVIDER_HOSTED_DOMAIN_ATTRIBUTE]: ProviderAttribute.other("hd"),
            },
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
   *   provider only at a provider sign-in. For a linked native user it
   *   unverifies an email that isn't custom:linked_email at a Managed Login
   *   token, and records one the person proved with a code at a refresh
   *   (supply-checkout-kgw). Its role may also call AdminUpdateUserAttributes
   *   on this pool, and read one attribute of the app table: the hash of the
   *   address a user last proved with a code (supply-checkout-ytr2), which
   *   is what lets it record an address.
   * - Pre sign-up (account-link-handler.ts) links a first Google or Apple
   *   sign-in whose provider says the email is verified to the one confirmed
   *   native user with that verified email, when the provider is
   *   authoritative for the address. Its role may also call ListUsers (to
   *   find that user; IAM can't limit the filter, so the code searches by
   *   exact email only), AdminUpdateUserAttributes (to record the linked
   *   email in custom:linked_email) and AdminLinkProviderForUser on this pool.
   *
   * The pool names each function (LambdaConfig), so a function can't name
   * the pool: each grant is a separate policy attached to the role after the
   * pool exists, and the function doesn't wait for it. A trigger's first
   * call comes with a sign-in, after the deploy.
   */
  private addFederatedTriggers(): { signInGuard: NodejsFunction; emailVerified: NodejsFunction; accountLink: NodejsFunction } {
    const signInGuard = this.trigger("SignInGuard", "sign-in-guard", "Refuses password, email-code and passkey sign-ins by Google and Apple users");
    this.userPool.addTrigger(UserPoolOperation.PRE_AUTHENTICATION, signInGuard);

    // The key for the log correlation handle in a failed downgrade's log
    // (logCorrelation() in email-verified-handler.ts): generated in Secrets
    // Manager and passed in with a dynamic reference resolved at deploy time,
    // like the providers' secrets, so the function's role needs no access to
    // Secrets Manager. Operators read it to find the user a handle names
    // (docs/journeys.md, "Email verification not saved").
    const correlationKey = new Secret(this, "LogCorrelationKey", {
      description: "Key for the email_verified trigger's log correlation handles (an HMAC of the user's sub)",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    Validations.of(correlationKey).acknowledge({
      id: "AwsSolutions-SMG4",
      reason: "Only a log correlation key, not a credential: rotating it would only stop older logs' handles matching. Rotate by hand (replace the secret and redeploy) if it leaks.",
    });
    const table = tableName(this.config.envName);
    // A fixed name, for the "Sign-in trigger failing" alarm (journey-alarms.ts,
    // supply-checkout-3sv.16). Changing a live function's name replaces it, which
    // briefly swaps the pool's trigger and its invoke permission: it was set
    // before Google or Apple sign-in was first turned on in prod, so don't change it.
    const emailVerified = this.trigger(
      "EmailVerified",
      "email-verified",
      "Sets email_verified for Google and Apple users from the provider's own claim",
      { [LOG_CORRELATION_KEY_ENV]: correlationKey.secretValue.unsafeUnwrap(), TABLE_NAME: table, [WELCOME_FUNCTION_ENV]: this.welcomeFunctionName },
      identityResourceNames(this.config.envName).emailVerifiedFunction,
    );
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
    // The address a linked user last proved with a code (supply-checkout-ytr2):
    // GetItem of the VERIFIED_EMAIL item in a user's partition, and only its
    // hash and time (VERIFIED_EMAIL_ATTRIBUTES), which no other item has. IAM can't
    // name the user (the trigger has no per-user session) or the sort key, so
    // this is every USER# partition, but only those attributes: it can't
    // read teams, names or emails. The table's key comes with the notice
    // address grant below (one statement for both). The table and its key are
    // in the primary region's data stack, which deploys first (supply-checkout.ts).
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: table });
    new Policy(this, "EmailVerifiedProvenEmail", {
      roles: [emailVerified.role as Role],
      statements: [
        new PolicyStatement({
          sid: "ReadProvenEmailHash",
          actions: ["dynamodb:GetItem"],
          resources: [tableArn],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": [...VERIFIED_EMAIL_ATTRIBUTES] },
            StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          },
        }),
      ],
    });
    // A user's notice address, once the trigger has settled whether their email is verified (supply-checkout-8jc.31)
    this.grantNoticeAddress(emailVerified, "EmailVerifiedNoticeAddress");
    // A new Google or Apple account's welcome email, at the sign-in that verifies it (supply-checkout-6uw.25)
    this.grantWelcome(emailVerified, "EmailVerifiedWelcome");

    const accountLink = this.trigger("AccountLink", "account-link", "Links a first Google or Apple sign-in to the existing account with the same verified email");
    this.userPool.addTrigger(UserPoolOperation.PRE_SIGN_UP, accountLink);
    new Policy(this, "AccountLinkUsers", {
      roles: [accountLink.role as Role],
      statements: [
        new PolicyStatement({
          sid: "LinkToExistingAccount",
          actions: ["cognito-idp:ListUsers", "cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminLinkProviderForUser"],
          resources: [this.userPool.userPoolArn],
        }),
      ],
    });
    return { signInGuard, emailVerified, accountLink };
  }

  /**
   * The post confirmation trigger (backend/src/identity/post-confirmation-handler.ts,
   * supply-checkout-8jc.31): when a native user confirms their sign-up with
   * Cognito's email code, it records the address an email change is told to
   * (NOTICE_ADDRESS), so the account has one before it has a token anyone
   * could change the email with; and, for a sign-up (not a forgotten
   * password), hands the welcome email to its function (grantWelcome). On
   * every app pool, providers or not. It never fails the confirmation.
   *
   * After a confirmed password reset (supply-checkout-6uw.32), it signs the
   * account out everywhere (AdminUserGlobalSignOut, on this pool only),
   * records the reset's time, which the API compares with each session's
   * auth_time (supply-checkout-6uw.33), and hands the notice to the security
   * notices function (grantResetNotice).
   */
  private addPostConfirmationTrigger(): NodejsFunction {
    // A fixed name, for the "Sign-up trigger failing" alarm (journey-alarms.ts)
    const fn = this.trigger(
      "PostConfirmation",
      "post-confirmation",
      "Records a new account's verified address for email change notices, and hands over its welcome email",
      {
        TABLE_NAME: tableName(this.config.envName),
        [WELCOME_FUNCTION_ENV]: this.welcomeFunctionName,
        [SECURITY_NOTICES_FUNCTION_ENV]: emailResourceNames(this.config.envName).securityNoticesFunction,
      },
      identityResourceNames(this.config.envName).postConfirmationFunction,
    );
    this.userPool.addTrigger(UserPoolOperation.POST_CONFIRMATION, fn);
    this.grantNoticeAddress(fn, "PostConfirmationNoticeAddress");
    this.grantWelcome(fn, "PostConfirmationWelcome");
    this.grantResetNotice(fn);
    return fn;
  }

  /**
   * Lets the post confirmation trigger act on a confirmed password reset
   * (supply-checkout-6uw.32, backend/src/identity/post-confirmation-handler.ts):
   * AdminUserGlobalSignOut on this pool only (the user Cognito's own event
   * names), and lambda:InvokeFunction on the security notices function only,
   * by its fixed name in this region and account (the email stack makes it,
   * and deploys after this one, so it's named, not referenced), with the
   * user's sub. Until the email stack has deployed it, the invoke fails,
   * which is counted (SecurityNoticeFailures) and never fails the reset.
   * And recording the reset's time (data/password-reset-time.ts,
   * supply-checkout-6uw.33): UpdateItem naming only the keys and
   * `passwordResetAt` (PASSWORD_RESET_RECORD_ATTRIBUTES), which no other item
   * has, returning nothing, and no read. IAM can't name the user (a trigger
   * has no per-user session) or the sort key, so this is every USER#
   * partition: the code only ever writes PASSWORD_RESET, for the user
   * Cognito's own event names, on a condition that names that sort key. The
   * table's key is grantNoticeAddress's statement. A separate policy,
   * attached after the pool exists (see addFederatedTriggers).
   */
  private grantResetNotice(fn: NodejsFunction): void {
    new Policy(this, "PostConfirmationResetSignOut", {
      roles: [fn.role as Role],
      statements: [
        new PolicyStatement({
          sid: "SignOutAfterReset",
          actions: ["cognito-idp:AdminUserGlobalSignOut"],
          resources: [this.userPool.userPoolArn],
        }),
        new PolicyStatement({
          sid: "RecordPasswordReset",
          actions: ["dynamodb:UpdateItem"],
          resources: [Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: tableName(this.config.envName) })],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": [...PASSWORD_RESET_RECORD_ATTRIBUTES] },
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        }),
        new PolicyStatement({
          sid: "QueueResetNotice",
          actions: ["lambda:InvokeFunction"],
          resources: [
            Stack.of(this).formatArn({
              service: "lambda",
              resource: "function",
              resourceName: emailResourceNames(this.config.envName).securityNoticesFunction,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      ],
    });
  }

  /** The welcome email function's fixed name (the email stack's; emailResourceNames). */
  private get welcomeFunctionName(): string {
    return emailResourceNames(this.config.envName).welcomeFunction;
  }

  /**
   * Lets a trigger hand a new account's welcome email over (supply-checkout-6uw.25,
   * backend/src/identity/welcome-invoke.ts): lambda:InvokeFunction on the
   * welcome email function only, by its fixed name in this region and account
   * (the email stack makes it, and deploys after this one, so it's named, not
   * referenced). The trigger invokes it asynchronously, with only a sub and how
   * the account signed up; until the email stack has deployed it, the invoke
   * fails, which is counted (WelcomeEmailFailures) and never fails sign-up. A
   * separate policy, attached after the pool exists (see addFederatedTriggers).
   */
  private grantWelcome(fn: NodejsFunction, id: string): void {
    new Policy(this, id, {
      roles: [fn.role as Role],
      statements: [
        new PolicyStatement({
          sid: "QueueWelcomeEmail",
          actions: ["lambda:InvokeFunction"],
          resources: [Stack.of(this).formatArn({ service: "lambda", resource: "function", resourceName: this.welcomeFunctionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
        }),
      ],
    });
  }

  /**
   * Lets a trigger record a user's notice address (identity/notice-address.ts,
   * data/security-notices.ts): GetItem of whether one is recorded, reading
   * only the keys and when (NOTICE_ADDRESS_CHECK_ATTRIBUTES), projected
   * (Select SPECIFIC_ATTRIBUTES, required), never the address; and recordNoticeAddress's write, UpdateItem naming only the
   * address record's attributes (NOTICE_ADDRESS_RECORD_ATTRIBUTES) and
   * returning nothing, with its ConditionCheckItem on the DELETING mark, which
   * names only the keys. No other item has these attributes, so it can't
   * change a user's teams, proofs or notices. IAM can't name the user (a
   * trigger has no per-user session) or the sort key, so this is every USER#
   * partition, and it can't require the write's condition: the code only
   * ever writes NOTICE_ADDRESS, on the condition that no address is there.
   * Residual: DynamoDB has no condition key for
   * ReturnValuesOnConditionCheckFailure, so changed code on this role could
   * read a whole USER# item (a membership row's email, say) from a
   * conditional update made to fail; the code never sets it. The table's key
   * only through DynamoDB, with the actions every table writer here has (one
   * statement, which also covers the pre token generation trigger's proof
   * read). A separate policy, attached after the pool exists (see
   * addFederatedTriggers).
   */
  private grantNoticeAddress(fn: NodejsFunction, id: string): void {
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: tableName(this.config.envName) });
    const userPartitions = { "dynamodb:LeadingKeys": ["USER#*"] };
    new Policy(this, id, {
      roles: [fn.role as Role],
      statements: [
        new PolicyStatement({
          sid: "ReadNoticeAddressRecorded",
          actions: ["dynamodb:GetItem"],
          resources: [tableArn],
          conditions: {
            "ForAllValues:StringLike": userPartitions,
            "ForAllValues:StringEquals": { "dynamodb:Attributes": [...NOTICE_ADDRESS_CHECK_ATTRIBUTES] },
            // Projected: required, not IfExists, so a GetItem without a projection (which may carry
            // neither Select nor Attributes) is denied (supply-checkout-3sv.23). hasNoticeAddress
            // (data/security-notices.ts), its only caller, always projects
            StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          },
        }),
        new PolicyStatement({
          sid: "RecordNoticeAddress",
          actions: ["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
          resources: [tableArn],
          conditions: {
            "ForAllValues:StringLike": userPartitions,
            "ForAllValues:StringEquals": { "dynamodb:Attributes": [...NOTICE_ADDRESS_RECORD_ATTRIBUTES] },
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        }),
        new PolicyStatement({
          sid: "TableKeyThroughDynamoDb",
          actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [StringParameter.valueForStringParameter(this, `/supply-checkout/${this.config.envName}/data/table-key-arn`)],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
        }),
      ],
    });
  }

  /** A function from backend/src/identity/<name>.ts, with its own log group and a role that can write only to it. */
  private trigger(id: string, name: string, description: string, environment: Record<string, string> = {}, functionName?: string): NodejsFunction {
    const logGroup = new LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION });
    const role = new Role(this, `${id}Role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the user pool's ${name} trigger`,
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    return new NodejsFunction(this, id, {
      ...(functionName ? { functionName } : {}),
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
      environment: { NODE_OPTIONS: "--enable-source-maps", ...environment },
      bundling,
    });
  }
}
