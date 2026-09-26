// The AppSync Events Lambda authorizer (ADR 0006, ADR 0016, docs/api/realtime.md).
//
// AppSync calls it with the token the client sent, for each connection and
// each subscription. It answers:
//
// - EVENT_CONNECT: allowed with a valid Cognito access token for the web app.
// - EVENT_SUBSCRIBE: allowed only for exactly `/users/<sub>`, where `<sub>` is
//   the token's own user. No wildcards, no other user's channel. It reads no
//   data: which teams' changes reach that channel is the stream consumer's
//   job, and it publishes only to current members of an active team.
// - Anything else, EVENT_PUBLISH included: refused. Clients never publish;
//   the `users` namespace takes publishes only with IAM, from the stream
//   consumer, so this is a second lock on the same door.
//
// Nothing is cached (ttlOverride 0): AppSync's authorizer cache is keyed on
// the token, and a cached answer for one channel must not stand for another.

import type { Context } from "aws-lambda";
import type { Observability } from "../observability/index.js";
import { userFromChannel, USERS_NAMESPACE } from "./channels.js";

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
      if (namespace !== undefined && namespace !== USERS_NAMESPACE) throw new Denied("Unknown namespace");
      const owner = userFromChannel(channel);
      if (!owner) throw new Denied("Not a user channel");
      const userId = await userFrom(deps, event.authorizationToken, now());
      if (owner !== userId) throw new Denied("Not this user's channel");
      deps.obs.logger.info("Subscribe allowed", { ...log, userId });
      return ALLOW;
    } catch (error) {
      if (error instanceof Denied) {
        deps.obs.logger.info("Denied", { ...log, reason: error.message });
        return DENY;
      }
      // Anything unexpected: fail closed, and let the error count against the function
      throw error;
    }
  };
}
