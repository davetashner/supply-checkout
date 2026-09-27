// The data-access module (ADR 0005), and the only file outside src/data may
// import (see eslint.config.js). It is the only code allowed to use the
// DynamoDB client. Every team's data is read and written through a
// TeamContext, which only the issuers in team-context.ts can create:
// authorizeTeam, createTeam, acceptInvite, teamContextForStripeCustomer and
// teamContextForEmailEvent.
// The Db handle is opaque: it exposes no DynamoDB client.

export { closeDb, createDb, type Db, type DbOptions } from "./client.js";
export { ConflictError, ForbiddenError, InvalidInputError, LastOwnerError, LimitReachedError, NotFoundError, TeamFullError, TooLargeError } from "./errors.js";
export { localRegion, writeRegionFor, type HomedTeam } from "./region.js";
export {
  acceptInvite,
  authorizeTeam,
  createTeam,
  findInvite,
  TeamContext,
  teamContextForEmailEvent,
  teamContextForStripeCustomer,
  type Role,
} from "./team-context.js";
export {
  ENDED_STATUSES,
  hasEnded,
  MAX_TEAMS_PER_USER,
  MEMBERS_PER_TEAM,
  MEMBERS_PER_TRIAL_TEAM,
  memberCap,
  memberRole,
  PAID_STATUSES,
  normalizeEmail,
  TEAMS_PER_USER_PER_DAY,
  teamIdForRequest,
  TRIAL_DAYS,
} from "./model.js";
export type { Page } from "./query.js";
export * from "./teams.js";
export * from "./invites.js";
export * from "./products.js";
export * from "./sheets.js";
export * from "./usage.js";
export * from "./audit.js";
export * from "./billing.js";
export * from "./documents.js";
export * from "./commands.js";
export * from "./imports.js";
export { MAX_MONEY, MAX_QUANTITY, roundCents } from "./money.js";
export { audienceChangeFromStream, documentChangeFromStream, type DocumentChange } from "./changes.js";
export { liveUpdateRecipients } from "./live-audience.js";
