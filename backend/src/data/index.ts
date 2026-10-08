// The data-access module (ADR 0005), and the only file outside src/data may
// import (see eslint.config.js). It is the only code allowed to use the
// DynamoDB client. Every team's data is read and written through a
// TeamContext, which only the issuers in team-context.ts can create:
// authorizeTeam, createTeam, acceptInvite, teamContextForStripeCustomer and
// teamContextForEmailEvent.
// The Db handle is opaque: it exposes no DynamoDB client.

export { closeDb, createDb, type Db, type DbOptions } from "./client.js";
export { AdhocOpenError, ConflictError, EquipmentOutError, ForbiddenError, InvalidInputError, LastOwnerError, LimitReachedError, NotFoundError, RateLimitedError, StockChangedError, SubscriptionEndedError, TeamClosedError, TeamDeletingError, TeamFullError, TooLargeError } from "./errors.js";
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
  type BillingAccess,
  type BillingAccessFields,
  billingAccess,
  type Comp,
  ENDED_STATUSES,
  hasEnded,
  hasStopped,
  STOPPED_STATUSES,
  isReadOnlyForBilling,
  liveComp,
  MAX_TEAMS_PER_USER,
  MEMBERS_PER_TEAM,
  MEMBERS_PER_TRIAL_TEAM,
  memberCap,
  memberRole,
  PAID_STATUSES,
  PAYMENT_GRACE_DAYS,
  normalizeEmail,
  READ_ONLY_RETENTION_DAYS,
  deletionLastDay,
  deletionTime,
  type ReadOnlyReason,
  TEAMS_PER_USER_PER_DAY,
  teamIdForRequest,
  TRIAL_DAYS,
  trialEnd,
} from "./model.js";
export type { Page } from "./query.js";
export * from "./teams.js";
export * from "./invites.js";
export * from "./products.js";
export { MAX_BRAND_LENGTH, brandOf } from "./brand.js";
export * from "./project-items.js";
export * from "./projects.js";
export * from "./usage.js";
export * from "./audit.js";
export * from "./billing.js";
export { BILLED_ROLES, countBilledMembers, isBilledRole, listTeamsToReconcile, type TeamToReconcile } from "./seats.js";
export * from "./documents.js";
export * from "./commands.js";
export * from "./imports.js";
export * from "./settings.js";
export * from "./accounts.js";
export { type ClosedTeamToEnd, closedTeamToEnd, countTeamsDueBefore, isTeamOpen, isTeamPurgedOrPurging, listClosedTeamsToEnd, listSetAsideTeams, listTeamsToPurge, markSubscriptionEnding, markSubscriptionSetAside, purgeTeam, type PurgedStripeIds, type PurgeResult, type SetAsideReason, type SetAsideTeam, type TeamDue } from "./team-purge.js";
export { claimLapseNotice, claimLapseRun, closeLapsedTeam, LAPSE_CHECKOUT_GUARD_HOURS, LAPSE_PURGE_DELAY_HOURS, LAPSE_RECORD_DAYS, LAPSE_TRIAL_NOTICE_DAYS, LAPSE_WARNING_DAYS, LAPSED_CLOSER, type LapseTeam, listLapseCandidates, listOwnerEmails, readLapseTeam, recordWarning, releaseLapseRun, warnedAt } from "./team-lapse.js";
export { listStripeCustomerDeletions, queueStripeCustomerDeletion, removeStripeCustomerDeletion, type StripeDeletion } from "./stripe-deletions.js";
export * from "./email-codes.js";
export * from "./verified-email.js";
export { isAtDomain, isTestAccount, TEST_MAIL_DOMAIN_ENV, testMailDomain } from "./test-accounts.js";
export * from "./security-notices.js";
export * from "./two-step.js";
export * from "./welcome.js";
export * from "./preferences.js";
export { MAX_MONEY, MAX_QUANTITY, roundCents } from "./money.js";
export { audienceChangeFromStream, documentChangeFromStream, type DocumentChange } from "./changes.js";
export { liveUpdateRecipients } from "./live-audience.js";
export * from "./operator.js";
export { OPERATOR_AUDIT_HEARTBEAT, OPERATOR_AUDIT_PREFIX } from "./schema.js";
export * from "./password-resets.js";
