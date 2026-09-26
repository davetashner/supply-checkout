// Names, options and helpers for sign-in (ADR 0007, supply-checkout-zsm).
//
// The identity stack (lib/stacks/identity-stack.ts) owns the Cognito user
// pool. Everything another stack or a script needs from it is in SSM under
// /supply-checkout/<env>/identity/, named by identityOutputParameters() below.
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

/** The Vite dev server (npm run dev), allowed as a callback URL outside prod by default. */
export const LOCAL_DEV_ORIGIN = "http://localhost:5173";

/** SSM parameters the identity stack publishes, in its own region. */
export const identityOutputParameters = (envName: string) => {
  const prefix = `/supply-checkout/${envName}/identity`;
  return {
    userPoolId: `${prefix}/user-pool-id`,
    userPoolArn: `${prefix}/user-pool-arn`,
    /** The web app's public client (PKCE, no secret): the JWT authorizer's audience. */
    webClientId: `${prefix}/web-client-id`,
    /** `https://cognito-idp.<region>.amazonaws.com/<pool id>`: the JWT issuer. */
    issuerUrl: `${prefix}/issuer-url`,
    /** `https://auth.<env domain>`: Managed Login and the OAuth endpoints (/oauth2/authorize, /oauth2/token). */
    authUrl: `${prefix}/auth-url`,
  };
};

/**
 * Secrets Manager secrets the operator creates before turning on a social
 * provider (see "Sign-in" in docs/infrastructure.md). Each is a JSON object; the
 * stack reads the fields with CloudFormation dynamic references at deploy
 * time, so no value is ever in a template or this repository.
 */
export const identityProviderSecrets = (envName: string) => ({
  /** `{"clientId": "…apps.googleusercontent.com", "clientSecret": "…"}` */
  google: `supply-checkout/${envName}/identity/google`,
  /** `{"servicesId": "com.example.signin", "teamId": "…", "keyId": "…", "privateKey": "<the .p8 key file's contents>"}` */
  apple: `supply-checkout/${envName}/identity/apple`,
});

export interface IdentityOptions {
  /** Sign in with Apple. Needs the `apple` secret. Default off. */
  readonly apple: boolean;
  /** Google sign-in. Needs the `google` secret. Default off. */
  readonly google: boolean;
  /** Allow LOCAL_DEV_ORIGIN as a callback and sign-out URL. Default on everywhere except prod. */
  readonly localhostCallbacks: boolean;
}

function flag(node: { tryGetContext(key: string): unknown }, key: string, fallback: boolean): boolean {
  const value = node.tryGetContext(key);
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${key} must be true or false (got "${String(value)}")`);
}

/**
 * Sign-in options from CDK context: `-c appleSignIn=true`, `-c googleSignIn=true`,
 * `-c localhostCallbacks=true|false`. Keep the provider flags in cdk.json once
 * they're on, like delegatedEnvs: a deploy without them removes the provider.
 */
export function identityOptionsFromContext(node: { tryGetContext(key: string): unknown }, envName: string): IdentityOptions {
  return {
    apple: flag(node, "appleSignIn", false),
    google: flag(node, "googleSignIn", false),
    localhostCallbacks: flag(node, "localhostCallbacks", envName !== "prod"),
  };
}

export interface CognitoJwtAuthorizerProps {
  /** The environment whose user pool issues the tokens. */
  readonly envName: string;
  /** Where the API reads the token. @default the Authorization header */
  readonly identitySource?: string[];
}

/**
 * An HTTP API JWT authorizer for the environment's user pool (ADR 0006), for
 * the api stack (supply-checkout-d8b):
 *
 *   api.addRoutes({ path: "/me", methods: [HttpMethod.GET], integration, authorizer: cognitoJwtAuthorizer(this, { envName }) });
 *
 * API Gateway checks the signature against the pool's JWKS, the expiry, the
 * issuer, and the audience. Cognito access tokens carry the app client in
 * `client_id` rather than `aud`, and API Gateway checks `client_id` when `aud`
 * is absent, so the web client ID is the audience for both token types.
 *
 * The issuer and client ID are read from the identity stack's SSM parameters
 * at deploy time, so they must exist in the calling stack's region. Today that
 * is the primary region. A second region (phase 2) needs them copied there, or
 * passed in by the pipeline.
 */
export function cognitoJwtAuthorizer(scope: Construct, props: CognitoJwtAuthorizerProps): HttpJwtAuthorizer {
  const names = identityOutputParameters(props.envName);
  const issuer = StringParameter.valueForStringParameter(scope, names.issuerUrl);
  const clientId = StringParameter.valueForStringParameter(scope, names.webClientId);
  return new HttpJwtAuthorizer("CognitoJwt", issuer, {
    authorizerName: "cognito-jwt",
    jwtAudience: [clientId],
    identitySource: props.identitySource,
  });
}

// Managed Login colors, from the app's tokens in src/styles.css. Cognito wants
// 8-digit lowercase RGBA hex without the #.
const light = { ground: "edf1eeff", surface: "ffffffff", ink: "17211eff", muted: "56655fff", line: "d2dbd6ff", accent: "0e6b58ff", accentInk: "ffffffff", accentHover: "0a5546ff", accentSoft: "d5ebe4ff", danger: "b3261eff" };
const dark = { ground: "101614ff", surface: "18201dff", ink: "e3ece8ff", muted: "95a69fff", line: "2b3632ff", accent: "43c3a0ff", accentInk: "06231cff", accentHover: "6fd3b7ff", accentSoft: "16352dff", danger: "f08a80ff" };

const button = (c: typeof light) => ({
  defaults: { backgroundColor: c.accent, textColor: c.accentInk },
  hover: { backgroundColor: c.accentHover, textColor: c.accentInk },
  active: { backgroundColor: c.accentHover, textColor: c.accentInk },
  disabled: { backgroundColor: c.line, borderColor: c.line },
});

/**
 * The Managed Login branding document (AWS::Cognito::ManagedLoginBranding
 * `Settings`). Only the values that differ from Cognito's defaults are given;
 * Cognito fills in the rest. Light or dark follows the browser, as the app
 * does. To change the look, edit it in the console's branding designer, then
 * copy the changes back here with
 * `aws cognito-idp describe-managed-login-branding-by-client`.
 */
export const managedLoginBranding = {
  categories: {
    global: { colorSchemeMode: "DYNAMIC", pageHeader: { enabled: false }, pageFooter: { enabled: false }, spacingDensity: "REGULAR" },
    form: { displayGraphics: true, instructions: { enabled: false }, languageSelector: { enabled: false }, location: { horizontal: "CENTER", vertical: "CENTER" }, sessionTimerDisplay: "NONE" },
  },
  componentClasses: {
    buttons: { borderRadius: 10 },
    input: {
      borderRadius: 10,
      lightMode: { defaults: { backgroundColor: light.surface, borderColor: light.line }, placeholderColor: light.muted },
      darkMode: { defaults: { backgroundColor: dark.surface, borderColor: dark.line }, placeholderColor: dark.muted },
    },
    inputLabel: { lightMode: { textColor: light.ink }, darkMode: { textColor: dark.ink } },
    inputDescription: { lightMode: { textColor: light.muted }, darkMode: { textColor: dark.muted } },
    link: {
      lightMode: { defaults: { textColor: light.accent }, hover: { textColor: light.accentHover } },
      darkMode: { defaults: { textColor: dark.accent }, hover: { textColor: dark.accentHover } },
    },
    focusState: { lightMode: { borderColor: light.accent }, darkMode: { borderColor: dark.accent } },
    divider: { lightMode: { borderColor: light.line }, darkMode: { borderColor: dark.line } },
  },
  components: {
    pageBackground: { image: { enabled: false }, lightMode: { color: light.ground }, darkMode: { color: dark.ground } },
    form: {
      borderRadius: 14,
      backgroundImage: { enabled: false },
      logo: { enabled: false, formInclusion: "IN", location: "CENTER", position: "TOP" },
      lightMode: { backgroundColor: light.surface, borderColor: light.line },
      darkMode: { backgroundColor: dark.surface, borderColor: dark.line },
    },
    pageText: {
      lightMode: { headingColor: light.ink, bodyColor: light.ink, descriptionColor: light.muted },
      darkMode: { headingColor: dark.ink, bodyColor: dark.ink, descriptionColor: dark.muted },
    },
    primaryButton: { lightMode: button(light), darkMode: button(dark) },
    secondaryButton: {
      lightMode: { defaults: { backgroundColor: light.surface, borderColor: light.accent, textColor: light.accent }, hover: { backgroundColor: light.accentSoft, borderColor: light.accent, textColor: light.accent }, active: { backgroundColor: light.accentSoft, borderColor: light.accent, textColor: light.accent } },
      darkMode: { defaults: { backgroundColor: dark.surface, borderColor: dark.accent, textColor: dark.accent }, hover: { backgroundColor: dark.accentSoft, borderColor: dark.accent, textColor: dark.accent }, active: { backgroundColor: dark.accentSoft, borderColor: dark.accent, textColor: dark.accent } },
    },
    alert: { borderRadius: 10, lightMode: { error: { backgroundColor: "f7dedbff", borderColor: light.danger } }, darkMode: { error: { backgroundColor: "3c1c19ff", borderColor: dark.danger } } },
  },
} as const;
