// The data-access module (ADR 0005). It is the only code allowed to use the
// DynamoDB client (see eslint.config.js). Every team's data is read and written
// through a TeamContext, which only authorizeTeam, createTeam, acceptInvite and
// teamContextForStripeCustomer can issue.

export { createDb, type Db, type DbOptions } from "./client.js";
export { ConflictError, ForbiddenError, InvalidInputError, LimitReachedError } from "./errors.js";
export { localRegion, writeRegionFor, type HomedTeam } from "./region.js";
export { authorizeTeam, TeamContext, type Role } from "./team-context.js";
export type { Page } from "./query.js";
export * from "./teams.js";
export * from "./invites.js";
export * from "./products.js";
export * from "./sheets.js";
export * from "./usage.js";
export * from "./audit.js";
export * from "./billing.js";
