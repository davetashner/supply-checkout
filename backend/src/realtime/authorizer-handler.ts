// The AppSync Events Lambda authorizer (ADR 0006, docs/api/realtime.md).
//
// AppSync calls it with the token the client sent, for each connection and
// each subscription. It answers:
//
// - EVENT_CONNECT: allowed with a valid Cognito access token for the web app.
// - EVENT_SUBSCRIBE: allowed only for exactly `/teams/<teamId>`, and only if
//   the token's user is a member of that team (authorizeTeam, the same check
//   the data API makes, which also validates the team ID). No wildcards.
// - Anything else, EVENT_PUBLISH included: refused. Clients never publish;
//   the `teams` namespace takes publishes only with IAM, from the stream
//   consumer, so this is a second lock on the same door.
//
// Nothing is cached (ttlOverride 0): AppSync's authorizer cache is keyed on
// the token, and one token subscribes to several channels.

import type { Context } from "aws-lambda";
import { authorizeTeam, type Db, ForbiddenError, InvalidInputError } from "../data/index.js";
import type { Observability } from "../observability/index.js";
import { teamFromChannel, TEAMS_NAMESPACE } from "./channels.js";

/** What AppSync sends a Lambda authorizer for an Event API. */
export interface EventsAuthorizerEvent {
  readonly authorizationToken?: string;
  readonly requestContext?: {
    readonly apiId?: string;
    readonly accountId?: string;
    readonly requestId?: string;
    readonly operation?: string;
    readonly channelNamespaceName?: string;
    readonly channel?: string;
  };
  readonly requestHeaders?: Record<string, string>;
}

export interface EventsAuthorizerResult {
  readonly isAuthorized: boolean;
  readonly ttlOverride?: number;
}

/** The claims this module reads from a verified token. */
export interface AccessTokenClaims {
  readonly sub?: unknown;
  readonly token_use?: unknown;
  readonly exp?: unknown;
}

/** Checks a Cognito token's signature, issuer, expiry, client and token_use; throws if any is wrong. */
export interface TokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

export interface AuthorizerDeps {
  readonly verifier: TokenVerifier;
  readonly db: Db;
  readonly obs: Observability;
  readonly now?: () => number;
}

const SUB = /^[A-Za-z0-9_-]{1,128}$/;
const DENY: EventsAuthorizerResult = { isAuthorized: false, ttlOverride: 0 };
const ALLOW: EventsAuthorizerResult = { isAuthorized: true, ttlOverride: 0 };

class Denied extends Error {
  override readonly name = "Denied";
}

/** The user ID from a token, or Denied. The verifier did the real work; this is the second look, as in the data API. */
async function userFrom(deps: AuthorizerDeps, raw: unknown, now: number): Promise<string> {
  if (typeof raw !== "string" || raw.length === 0) throw new Denied("No token");
  const token = raw.replace(/^Bearer\s+/i, "");
  let claims: AccessTokenClaims;
  try {
    claims = await deps.verifier.verify(token);
  } catch (error) {
    throw new Denied(`Token rejected: ${(error as Error).name}`);
  }
  if (claims.token_use !== "access") throw new Denied("Not an access token");
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) throw new Denied("Token expired");
  if (typeof claims.sub !== "string" || !SUB.test(claims.sub)) throw new Denied("Bad subject");
  return claims.sub;
}

export function createAuthorizerHandler(deps: AuthorizerDeps) {
  const now = deps.now ?? Date.now;
  return async (event: EventsAuthorizerEvent, context?: Context): Promise<EventsAuthorizerResult> => {
    void context;
    const operation = event.requestContext?.operation;
    const channel = event.requestContext?.channel;
    const log = { operation: operation ?? "", channel: channel ?? "" };
    try {
      if (operation === "EVENT_CONNECT") {
        await userFrom(deps, event.authorizationToken, now());
        return ALLOW;
      }
      if (operation !== "EVENT_SUBSCRIBE") throw new Denied("Operation not allowed for clients");

      const namespace = event.requestContext?.channelNamespaceName;
      if (namespace !== undefined && namespace !== TEAMS_NAMESPACE) throw new Denied("Unknown namespace");
      const teamId = teamFromChannel(channel);
      if (!teamId) throw new Denied("Not a team channel");
      const userId = await userFrom(deps, event.authorizationToken, now());
      try {
        await authorizeTeam(deps.db, userId, teamId);
      } catch (error) {
        if (error instanceof ForbiddenError || error instanceof InvalidInputError) throw new Denied("Not a member of this team");
        throw error;
      }
      deps.obs.logger.info("Subscribe allowed", { ...log, teamId, userId });
      return ALLOW;
    } catch (error) {
      if (error instanceof Denied) {
        deps.obs.logger.info("Denied", { ...log, reason: error.message });
        return DENY;
      }
      // DynamoDB trouble: fail closed, and let the error count against the function
      throw error;
    }
  };
}
