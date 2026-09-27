// The HTTP API's routes and the names the Lambda code and the CDK app share
// (infra/lib/stacks/api-stack.ts imports this file), so the routes API Gateway
// serves and the ones the handlers answer can't drift apart. No imports.
// docs/api/openapi.yaml describes the same routes; a test keeps them in step.

/**
 * The generic document operations, which the app's edit screens use, and the
 * inventory commands next to them (backend/src/data/commands.ts,
 * docs/api/commands.md): checkout, return, adding a receipt's lines and stock adjust, each one atomic and
 * idempotent by operation ID, and a product's stock history. And the CSV
 * inventory import.
 */
export type Operation = "list" | "get" | "set" | "update" | "delete" | "checkout" | "return" | "addLines" | "adjustStock" | "movements" | "importProducts" | "supportActions";
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
  /** The documents it serves; `team` for a route about the team itself. */
  readonly collection: "products" | "sheets" | "team";
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
  // A receipt's lines for a client, added to an existing sheet in one transaction (no stock moves)
  { method: "POST", path: "/teams/{teamId}/sheets/{sheetId}/lines", collection: "sheets", operation: "addLines", minRole: "contributor" },
  { method: "POST", path: "/teams/{teamId}/products/{key}/stock", collection: "products", operation: "adjustStock", minRole: "contributor" },
  { method: "GET", path: "/teams/{teamId}/products/{key}/movements", collection: "products", operation: "movements", minRole: "viewer" },
  // CSV inventory import, all or nothing and idempotent by import ID (backend/src/data/imports.ts). Owners only.
  // Up to 1,000 rows each, so it has its own throttle: imports are occasional, onboarding work.
  { method: "POST", path: "/teams/{teamId}/imports", collection: "products", operation: "importProducts", minRole: "owner", throttle: { rate: 5, burst: 10 } },
  // What platform operators did to the team (ADR 0015), attributed to "Supply Checkout support". Owners only.
  { method: "GET", path: "/teams/{teamId}/support-actions", collection: "team", operation: "supportActions", minRole: "owner" },
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
  readonly action:
    | "me"
    | "createTeam"
    | "acceptInvite"
    | "listMembers"
    | "setMemberRole"
    | "removeMember"
    | "listInvites"
    | "createInvite"
    | "revokeInvite"
    | "resendInvite"
    | "closeTeam"
    | "reopenTeam"
    | "deleteAccount"
    | "sendEmailCode"
    | "verifyEmail";
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
 * and any member can leave. And a team's invites: owners invite people by
 * email, see each invite as pending, failed or expired, revoke it and re-send
 * it. Owners close a team (and reopen it before it's deleted), and anyone deletes their own account (the
 * account handler's "Closing a team" and "Deleting an account"). And
 * verifying the user's email address with a code Cognito emails them.
 * Each needs a Cognito access token (the JWT
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
  // Creating and re-sending an invite send an email, so they're the tightest; each team
  // and each address also has a daily limit (INVITES_PER_TEAM_PER_DAY, INVITES_PER_ADDRESS_PER_DAY)
  { method: "GET", path: "/teams/{teamId}/invites", action: "listInvites", throttle: { rate: 20, burst: 40 } },
  { method: "POST", path: "/teams/{teamId}/invites", action: "createInvite", throttle: { rate: 5, burst: 10 } },
  { method: "DELETE", path: "/teams/{teamId}/invites/{inviteId}", action: "revokeInvite", throttle: { rate: 10, burst: 20 } },
  { method: "POST", path: "/teams/{teamId}/invites/{inviteId}/resend", action: "resendInvite", throttle: { rate: 5, burst: 10 } },
  // Rare, and each does a lot: closing deletes the team's invites, and deleting an
  // account visits every team the user is in and deletes the Cognito user
  { method: "POST", path: "/teams/{teamId}/close", action: "closeTeam", throttle: { rate: 2, burst: 5 } },
  // Rare, and it emails every owner
  { method: "POST", path: "/teams/{teamId}/reopen", action: "reopenTeam", throttle: { rate: 2, burst: 5 } },
  { method: "DELETE", path: "/me", action: "deleteAccount", throttle: { rate: 2, burst: 5 } },
  // Cognito emails the code and limits codes and tries per user; these keep the total down too
  { method: "POST", path: "/me/email/code", action: "sendEmailCode", throttle: { rate: 5, burst: 10 } },
  { method: "POST", path: "/me/email/verify", action: "verifyEmail", throttle: { rate: 10, burst: 20 } },
];

export interface OpsRoute {
  readonly method: "GET" | "PUT" | "DELETE" | "POST";
  readonly path: string;
  readonly action: "listTeams" | "getTeam" | "setComp" | "endComp" | "listAudit" | "listStuckImports" | "clearStuckImport";
  readonly throttle: { readonly rate: number; readonly burst: number };
}

/**
 * Platform operators (ADR 0015): list and search teams, read one team's
 * account record, comp a team or end its comp, read the operator audit, and
 * list stuck imports and take one out of the stuck-import check.
 * Each needs an access token from the operator user pool (its own JWT
 * authorizer; a customer's token fails it), and the `ops` function checks
 * the `operators` group with Cognito on every request. Primary region only.
 */
export const OPS_ROUTES: readonly OpsRoute[] = [
  { method: "GET", path: "/ops/teams", action: "listTeams", throttle: { rate: 5, burst: 10 } },
  { method: "GET", path: "/ops/teams/{teamId}", action: "getTeam", throttle: { rate: 5, burst: 10 } },
  { method: "PUT", path: "/ops/teams/{teamId}/comp", action: "setComp", throttle: { rate: 2, burst: 5 } },
  { method: "DELETE", path: "/ops/teams/{teamId}/comp", action: "endComp", throttle: { rate: 2, burst: 5 } },
  { method: "GET", path: "/ops/audit", action: "listAudit", throttle: { rate: 5, burst: 10 } },
  // Imports stuck part-way (the "Imports stuck" alarm, docs/journeys.md J2), and taking one out of the check
  { method: "GET", path: "/ops/imports", action: "listStuckImports", throttle: { rate: 5, burst: 10 } },
  { method: "POST", path: "/ops/teams/{teamId}/imports/{importId}/clear", action: "clearStuckImport", throttle: { rate: 2, burst: 5 } },
];

/**
 * The session tag the ops function puts on its operator-access role session:
 * the team a comp changes, or OPS_TAG_UNUSED. The role may update the comp
 * attributes of `TEAM#<tag>` only (dynamodb:LeadingKeys).
 */
export const OPS_SESSION_TAG = "teamId";
export const OPS_TAG_UNUSED = ".";

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
 * `USER#<userId>`, `TEAM#<teamId>` or (on GSI2) `INVITEE#<invitee>`; for
 * `member`, only updating or deleting items in `USER#<member>` (another
 * member's team-switcher row, when an owner changes their role or removes
 * them); and for `inviteLimit`, only updating the day's invite counter in
 * `INVITELIMIT#<inviteLimit>` (the hashed address an owner is inviting).
 * Every session carries all five; one that doesn't need a tag sets it to
 * ACCOUNT_TAG_UNUSED, which no key can match.
 */
export const ACCOUNT_SESSION_TAGS = { userId: "userId", teamId: "teamId", invitee: "invitee", member: "member", inviteLimit: "inviteLimit" } as const;
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
  /** The role the ops function assumes (ADR 0015). */
  opsRoleArn: "OPS_ROLE_ARN",
  /** The operator pool's issuer URL: only its tokens reach the ops function. */
  opsIssuerUrl: "OPS_ISSUER_URL",
  /** The operator pool's `ops` client: the only audience the ops function accepts. */
  opsClientId: "OPS_CLIENT_ID",
  /** The operator pool, for AdminListGroupsForUser on every request. */
  opsUserPoolId: "OPS_USER_POOL_ID",
} as const;

/** The refresh-token cookie, scoped to the auth endpoints. */
export const REFRESH_COOKIE = "__Secure-sc_refresh";
export const REFRESH_COOKIE_PATH = "/auth";
