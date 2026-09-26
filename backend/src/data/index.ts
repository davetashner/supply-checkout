// The data-access module (ADR 0005), and the only file outside src/data may
// import (see eslint.config.js). It is the only code allowed to use the
// DynamoDB client. Every team's data is read and written through a
// TeamContext, which only the issuers in team-context.ts can create:
// authorizeTeam, createTeam, acceptInvite and teamContextForStripeCustomer.
// The Db handle is opaque: it exposes no DynamoDB client.

export { createDb, type Db, type DbOptions } from "./client.js";
export { ConflictError, ForbiddenError, InvalidInputError, LimitReachedError } from "./errors.js";
export { localRegion, writeRegionFor, type HomedTeam } from "./region.js";
export {
  acceptInvite,
  authorizeTeam,
  createTeam,
  findInvite,
  TeamContext,
  teamContextForStripeCustomer,
  type Role,
} from "./team-context.js";
export type { Page } from "./query.js";
export * from "./teams.js";
export * from "./invites.js";
export * from "./products.js";
export * from "./sheets.js";
export * from "./usage.js";
export * from "./audit.js";
export * from "./billing.js";
