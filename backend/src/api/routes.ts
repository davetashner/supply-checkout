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

/** API Gateway's route key for a route, e.g. `GET /teams/{teamId}/products`. */
export const routeKey = (route: { readonly method: string; readonly path: string }) => `${route.method} ${route.path}`;

/**
 * The session tag the data Lambda puts on its per-team role session. The
 * data-access role's policy allows only items whose partition key is that
 * team's (dynamodb:LeadingKeys), so a bug that reaches for another team's
 * items is refused by IAM as well as by the TeamContext check.
 */
export const TEAM_SESSION_TAG = "teamId";

/** Environment variables the api stack sets and the handlers read. */
export const API_ENV = {
  tableName: "TABLE_NAME",
  /** The role the data Lambda assumes, tagged with the team, for every team's reads and writes. */
  dataRoleArn: "DATA_ROLE_ARN",
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
