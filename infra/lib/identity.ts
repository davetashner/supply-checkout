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
    /** The operator pool (ADR 0015). */
    opsUserPoolId: `${prefix}/ops-user-pool-id`,
    opsUserPoolArn: `${prefix}/ops-user-pool-arn`,
    /** The operator pool's public `ops` client (PKCE): the ops authorizer's audience. */
    opsClientId: `${prefix}/ops-client-id`,
    /** The operator pool's JWT issuer. */
    opsIssuerUrl: `${prefix}/ops-issuer-url`,
    /** `https://ops-auth.<env domain>`: the operator pool's Managed Login and OAuth endpoints. */
    opsAuthUrl: `${prefix}/ops-auth-url`,
    /** The ops client's managed login branding: OperatorBrandingChanges matches calls that name only it (supply-checkout-6uw.21). */
    opsBrandingId: `${prefix}/ops-branding-id`,
  };
};

/**
 * Where `npm run ops` listens for the operator pool's sign-in redirect
 * (scripts/ops.mjs). A fixed port, because Cognito matches callback URLs
 * exactly; http is allowed only for localhost.
 */
export const OPS_CLI_CALLBACK = "http://localhost:8765/";

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

/**
 * The HTTP API's JWT authorizer for the operator pool (ADR 0015): the /ops
 * routes' only authorizer. Its issuer is the operator pool and its audience
 * the `ops` client, so a customer's token fails it, and an operator's token
 * fails the customer authorizer. The ops function checks the operators group
 * and asks Cognito on every request.
 */
export function opsJwtAuthorizer(scope: Construct, props: { readonly envName: string }): HttpJwtAuthorizer {
  const names = identityOutputParameters(props.envName);
  const issuer = StringParameter.valueForStringParameter(scope, names.opsIssuerUrl);
  const clientId = StringParameter.valueForStringParameter(scope, names.opsClientId);
  return new HttpJwtAuthorizer("OpsCognitoJwt", issuer, { authorizerName: "ops-cognito-jwt", jwtAudience: [clientId] });
}

// Managed Login colors, from the app's default Work Order palette in src/styles.css
// (accent is the text and link color, fill the filled button's). Cognito wants
// 8-digit lowercase RGBA hex without the #.
const light = { ground: "eef1f6ff", surface: "ffffffff", ink: "141b2dff", muted: "4f596dff", line: "d2d9e5ff", accent: "1f4fd1ff", accentHover: "1a43b3ff", fill: "1f4fd1ff", fillHover: "1a43b3ff", accentInk: "ffffffff", accentSoft: "dce5fcff", danger: "b42318ff", dangerSoft: "fbe0dcff" };
const dark = { ground: "0e1320ff", surface: "171e30ff", ink: "e6eaf2ff", muted: "9aa4b8ff", line: "283249ff", accent: "7fa4ffff", accentHover: "a3beffff", fill: "3d63d6ff", fillHover: "3458c4ff", accentInk: "ffffffff", accentSoft: "1b2a52ff", danger: "ff8a80ff", dangerSoft: "3d1c1cff" };

const button = (c: typeof light) => ({
  defaults: { backgroundColor: c.fill, textColor: c.accentInk },
  hover: { backgroundColor: c.fillHover, textColor: c.accentInk },
  active: { backgroundColor: c.fillHover, textColor: c.accentInk },
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
    alert: { borderRadius: 10, lightMode: { error: { backgroundColor: light.dangerSoft, borderColor: light.danger } }, darkMode: { error: { backgroundColor: dark.dangerSoft, borderColor: dark.danger } } },
  },
} as const;
