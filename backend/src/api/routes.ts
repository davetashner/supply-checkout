// The HTTP API's routes and the names the Lambda code and the CDK app share
// (infra/lib/stacks/api-stack.ts imports this file), so the routes API Gateway
// serves and the ones the handlers answer can't drift apart. No imports.
// docs/api/openapi.yaml describes the same routes; a test keeps them in step.

/**
 * The generic document operations, which the app's edit screens use, and the
 * inventory commands next to them (backend/src/data/commands.ts,
 * docs/api/commands.md): checkout, return and stock adjust, each one atomic and
 * idempotent by operation ID, and a product's stock history. And the CSV
 * inventory import.
 */
export type Operation = "list" | "get" | "set" | "update" | "delete" | "checkout" | "return" | "adjustStock" | "movements" | "importProducts";
export type HttpMethod = "GET" | "PUT" | "PATCH" | "DELETE" | "POST";

/**
 * A team role, from least to most access (ADR 0007): viewers read; contributors
 * also scan and edit sheets and inventory; owners also manage members, billing
 * and imports.
 */
export type TeamRole = "viewer" | "contributor" | "owner";
export const TEAM_ROLES: readonly TeamRole[] = ["viewer", "contributor", "owner"];

export interface DataRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly collection: "products" | "sheets";
  readonly operation: Operation;
  /**
   * The least role that may call it. The handler checks it on every request,
   * before anything runs; every route that isn't a GET needs at least
   * contributor (a test checks).
   */
  readonly minRole: TeamRole;
  /** API Gateway's throttle for this route across all callers, for routes much heavier than a document write. */
  readonly throttle?: { readonly rate: number; readonly burst: number };
}

const collectionRoutes = (collection: "products" | "sheets", param: string): DataRoute[] => [
  { method: "GET", path: `/teams/{teamId}/${collection}`, collection, operation: "list", minRole: "viewer" },
  { method: "GET", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "get", minRole: "viewer" },
  { method: "PUT", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "set", minRole: "contributor" },
  { method: "PATCH", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "update", minRole: "contributor" },
  { method: "DELETE", path: `/teams/{teamId}/${collection}/{${param}}`, collection, operation: "delete", minRole: "contributor" },
];

const commandRoutes: DataRoute[] = [
  { method: "POST", path: "/teams/{teamId}/sheets/{sheetId}/checkout", collection: "sheets", operation: "checkout", minRole: "contributor" },
  { method: "POST", path: "/teams/{teamId}/sheets/{sheetId}/return", collection: "sheets", operation: "return", minRole: "contributor" },
  { method: "POST", path: "/teams/{teamId}/products/{key}/stock", collection: "products", operation: "adjustStock", minRole: "contributor" },
  { method: "GET", path: "/teams/{teamId}/products/{key}/movements", collection: "products", operation: "movements", minRole: "viewer" },
  // CSV inventory import, all or nothing and idempotent by import ID (backend/src/data/imports.ts). Owners only.
  // Up to 1,000 rows each, so it has its own throttle: imports are occasional, onboarding work.
  { method: "POST", path: "/teams/{teamId}/imports", collection: "products", operation: "importProducts", minRole: "owner", throttle: { rate: 5, burst: 10 } },
];

/** Team data. Every one needs a Cognito access token (the JWT authorizer). */
export const DATA_ROUTES: readonly DataRoute[] = [...collectionRoutes("products", "key"), ...collectionRoutes("sheets", "sheetId"), ...commandRoutes];

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
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly action: "me" | "createTeam" | "acceptInvite" | "listMembers" | "setMemberRole" | "removeMember";
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
 * And a team's members: owners list them, change their roles and remove them,
 * and any member can leave. Each needs a Cognito access token (the JWT
 * authorizer). They write the user's own `USER#` rows (or, for a member
 * change, that member's), which the team-scoped data function can't reach,
 * so they're served by the `account` function.
 */
export const ACCOUNT_ROUTES: readonly AccountRoute[] = [
  { method: "GET", path: "/me", action: "me", throttle: { rate: 50, burst: 100 } },
  { method: "POST", path: "/teams", action: "createTeam", throttle: { rate: 10, burst: 20 } },
  { method: "POST", path: "/invites/{inviteId}/accept", action: "acceptInvite", throttle: { rate: 10, burst: 20 } },
  { method: "GET", path: "/teams/{teamId}/members", action: "listMembers", throttle: { rate: 20, burst: 40 } },
  { method: "PATCH", path: "/teams/{teamId}/members/{userId}", action: "setMemberRole", throttle: { rate: 10, burst: 20 } },
  { method: "DELETE", path: "/teams/{teamId}/members/{userId}", action: "removeMember", throttle: { rate: 10, burst: 20 } },
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
 * `USER#<userId>`, `TEAM#<teamId>` or (on GSI2) `INVITEE#<invitee>`, and, for
 * `member`, only updating or deleting items in `USER#<member>` (another
 * member's team-switcher row, when an owner changes their role or removes
 * them). Every session carries all four; one that doesn't need a tag sets it
 * to ACCOUNT_TAG_UNUSED, which no key can match.
 */
export const ACCOUNT_SESSION_TAGS = { userId: "userId", teamId: "teamId", invitee: "invitee", member: "member" } as const;
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
