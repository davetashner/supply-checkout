// The HTTP API's routes and the names the Lambda code and the CDK app share
// (infra/lib/stacks/api-stack.ts imports this file), so the routes API Gateway
// serves and the ones the handlers answer can't drift apart. No imports.
// docs/api/openapi.yaml describes the same routes; a test keeps them in step.

export type Operation = "list" | "get" | "set" | "update" | "delete";
export type HttpMethod = "GET" | "PUT" | "PATCH" | "DELETE" | "POST";

export interface DataRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly collection: "products" | "sheets";
  readonly operation: Operation;
}

const collectionRoutes = (collection: "products" | "sheets", param: string): DataRoute[] => [
  { method: "GET", path: `/teams/{teamId}/${collection}`, collection, operation: "list" },
  { method: "GET", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "get" },
  { method: "PUT", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "set" },
  { method: "PATCH", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "update" },
  { method: "DELETE", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "delete" },
];

/** Team data. Every one needs a Cognito access token (the JWT authorizer). */
export const DATA_ROUTES: readonly DataRoute[] = [...collectionRoutes("products", "key"), ...collectionRoutes("sheets", "sheetId")];

export interface AuthRoute {
  readonly method: "POST";
  readonly path: string;
  readonly action: "session" | "refresh" | "signOut";
}

/**
 * Sign-in session endpoints. No JWT authorizer: they work from the refresh
 * token in an HttpOnly cookie, guarded by SameSite=Strict and an Origin check.
 */
export const AUTH_ROUTES: readonly AuthRoute[] = [
  { method: "POST", path: "/auth/session", action: "session" },
  { method: "POST", path: "/auth/refresh", action: "refresh" },
  { method: "POST", path: "/auth/sign-out", action: "signOut" },
];

export interface AccountRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly action: "me" | "createTeam" | "acceptInvite";
  /**
   * API Gateway's throttle for this route across all callers (requests a
   * second, and burst), below the stage's. /me assumes a role per team, so it
   * is bounded to keep STS well inside its rate.
   */
  readonly throttle: { readonly rate: number; readonly burst: number };
}

/**
 * The signed-in user's own account: their teams and pending invites, creating
 * a team, and accepting an invite (first sign-in, docs/api/onboarding.md).
 * Each needs a Cognito access token (the JWT authorizer). None names a team
 * the caller is already in, so they're served by the `account` function, not
 * the team-scoped data function.
 */
export const ACCOUNT_ROUTES: readonly AccountRoute[] = [
  { method: "GET", path: "/me", action: "me", throttle: { rate: 50, burst: 100 } },
  { method: "POST", path: "/teams", action: "createTeam", throttle: { rate: 10, burst: 20 } },
  { method: "POST", path: "/invites/{inviteId}/accept", action: "acceptInvite", throttle: { rate: 10, burst: 20 } },
];

/** The header that makes `POST /teams` idempotent: the client's key for one "create team" attempt. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** API Gateway's route key for a route, e.g. `GET /teams/{teamId}/products`. */
export const routeKey = (route: { readonly method: string; readonly path: string }) => `${route.method} ${route.path}`;

/**
 * The session tag the data Lambda puts on its per-team role session. The
 * data-access role's policy allows only items whose partition key is that
 * team's (dynamodb:LeadingKeys), so a bug that reaches for another team's
 * items is refused by IAM as well as by the TeamContext check.
 */
export const TEAM_SESSION_TAG = "teamId";

/**
 * Session tags the account function puts on its role session. The
 * account-access role's policy allows only items whose partition key is
 * `USER#<userId>`, `TEAM#<teamId>` or (on GSI2) `INVITEE#<invitee>`. Every
 * session carries all three; one that doesn't need a team or an invitee tags
 * it ACCOUNT_TAG_UNUSED, which no key can match.
 */
export const ACCOUNT_SESSION_TAGS = { userId: "userId", teamId: "teamId", invitee: "invitee" } as const;
export const ACCOUNT_TAG_UNUSED = ".";

/** Environment variables the api stack sets and the handlers read. */
export const API_ENV = {
  tableName: "TABLE_NAME",
  /** The role the data Lambda assumes, tagged with the team, for every team's reads and writes. */
  dataRoleArn: "DATA_ROLE_ARN",
  /** The role the account function assumes, tagged with the user (and a team or invitee). */
  accountRoleArn: "ACCOUNT_ROLE_ARN",
  /** `https://cognito-idp.<region>.amazonaws.com/<pool>`: the JWT issuer, and where GetUser is called. */
  issuerUrl: "ISSUER_URL",
  /** `https://auth.<env domain>`: Cognito's OAuth endpoints. */
  authUrl: "AUTH_URL",
  /** The web app's public client ID. */
  clientId: "CLIENT_ID",
  /** Comma-separated origins allowed to call the auth endpoints, e.g. `https://app.<env domain>`. */
  allowedOrigins: "ALLOWED_ORIGINS",
} as const;

/** The refresh-token cookie, scoped to the auth endpoints. */
export const REFRESH_COOKIE = "__Secure-sc_refresh";
export const REFRESH_COOKIE_PATH = "/auth";
