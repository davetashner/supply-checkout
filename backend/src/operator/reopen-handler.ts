// The operator reopen function (supply-checkout-6uw.6, ADR 0015): the one
// operator change the ops function can't make with its own role.
//
// Reopening a closed team removes its closure fields (`closedAt`,
// `purgeAfter`, the closed-teams index keys). IAM can limit which attributes
// a request names, but not whether it sets or removes them, so a role that
// could reopen a team could also close one and have the purge delete it. The
// operator-access role therefore gets no closure fields. This function has
// them (REOPEN_ATTRIBUTES, on its own role), no API route, and one caller:
// the ops function, which may invoke it and nothing else may. It takes plain
// values, never expressions, and runs only reopenOpsTeam, which only removes
// them. So a bug in the ops function can at worst reopen a closed team, with
// an audit item, never close or delete one.
//
// The ops function verifies the operator (token, group, Cognito) before it
// invokes this, and passes their `sub`. Answers are `{ ok: true, outcome }`
// or `{ ok: false, error }` for a refusal the ops route turns into 400, 404
// or 409; anything else throws, and the ops route answers 500. Logs carry IDs
// and the result only.

import { ConflictError, InvalidInputError, NotFoundError, type ReopenOutcome, reopenOpsTeam, TeamDeletingError } from "../data/index.js";
import type { Observability } from "../observability/index.js";
import type { DbForOps } from "./ops-db.js";

/** What the ops function sends. */
export interface ReopenRequest {
  readonly operatorSub: string;
  readonly teamId: string;
  readonly reason: unknown;
  readonly expectedVersion: unknown;
  readonly idempotencyKey: unknown;
}

export type ReopenRefusal = "bad_request" | "not_found" | "conflict" | "team_deleting";

export type ReopenAnswer = { readonly ok: true; readonly outcome: ReopenOutcome } | { readonly ok: false; readonly error: { readonly kind: ReopenRefusal; readonly message: string } };

export interface ReopenHandlerDeps {
  /** A handle on the operator-reopen role, tagged with the team (opsScopedDbs). */
  readonly dbFor: DbForOps;
  readonly obs: Observability;
  readonly now?: () => number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELDS = new Set(["operatorSub", "teamId", "reason", "expectedVersion", "idempotencyKey"]);

/** The request, if it's exactly the fields the ops function sends, with IDs that look like IDs. */
export function reopenRequest(event: unknown): ReopenRequest | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  const e = event as Record<string, unknown>;
  if (Object.keys(e).some((k) => !FIELDS.has(k))) return undefined;
  if (typeof e.operatorSub !== "string" || !ID.test(e.operatorSub) || typeof e.teamId !== "string" || !ID.test(e.teamId)) return undefined;
  return { operatorSub: e.operatorSub, teamId: e.teamId, reason: e.reason, expectedVersion: e.expectedVersion, idempotencyKey: e.idempotencyKey };
}

function refusal(error: unknown): ReopenAnswer | undefined {
  const refuse = (kind: ReopenRefusal) => ({ ok: false as const, error: { kind, message: (error as Error).message } });
  if (error instanceof InvalidInputError) return refuse("bad_request");
  if (error instanceof NotFoundError) return refuse("not_found");
  if (error instanceof TeamDeletingError) return refuse("team_deleting");
  if (error instanceof ConflictError) return refuse("conflict");
  return undefined;
}

export function createReopenHandler(deps: ReopenHandlerDeps) {
  const now = deps.now ?? Date.now;
  const { obs } = deps;
  return async (event: unknown): Promise<ReopenAnswer> => {
    const request = reopenRequest(event);
    if (!request) {
      obs.logger.warn("Reopen refused", { result: "bad_request" });
      return { ok: false, error: { kind: "bad_request", message: "Not a reopen request" } };
    }
    const ids = { teamId: request.teamId, operator: request.operatorSub };
    try {
      const outcome = await reopenOpsTeam(deps.dbFor(request.operatorSub, request.teamId), { sub: request.operatorSub }, request.teamId, request, new Date(now()));
      obs.logger.info("Team reopened by an operator", { ...ids, eventId: outcome.eventId, replayed: outcome.replayed });
      return { ok: true, outcome };
    } catch (error) {
      const refused = refusal(error);
      if (!refused || refused.ok) throw error;
      obs.logger.info("Reopen refused", { ...ids, result: refused.error.kind });
      return refused;
    }
  };
}
