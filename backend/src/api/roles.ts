// The role check every team route runs before it does anything (ADR 0007):
// viewers read; contributors also scan and edit sheets and inventory; owners
// also manage members, billing and imports. The data layer checks roles again
// before each write (writable() in data/team-context.ts); this check gives the
// client the answer it can act on.

import { notMember, ownersOnly, viewOnly } from "./http.js";
import { TEAM_ROLES, type TeamRole } from "./routes.js";

const rank = (role: string): number => TEAM_ROLES.indexOf(role as TeamRole);

/** True if `role` is at least `minimum`. Anything that isn't a team role (a missing or unknown one) is never enough. */
export function hasRole(role: string, minimum: TeamRole): boolean {
  const have = rank(role);
  return have >= 0 && have >= rank(minimum);
}

/**
 * Throws 403 `permission_denied` unless `role` is at least `minimum`, with the
 * reason the client acts on: `view_only` where contributors may go and
 * `owners_only` where only owners may.
 */
export function requireRole(role: string, minimum: TeamRole): void {
  if (hasRole(role, minimum)) return;
  throw minimum === "owner" ? ownersOnly() : minimum === "contributor" ? viewOnly() : notMember();
}
