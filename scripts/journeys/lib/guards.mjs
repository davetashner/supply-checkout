// The harness's guards (docs/journey-tests-plan.md, "What the security review must check", 5):
//
// - checkMe: right after each sign-in, `/me` must be a verified test account (the address we
//   signed in as, at the test mail domain) whose every team is one this run expects. A wrong
//   secret (a real person's password, say) stops the run before it touches anything.
// - assertDestructiveAllowed: account deletion and team closure only as a throwaway account of a
//   run (this one, or a crashed run's that cleanup found in runs/), and only on a team that run
//   created; never a long-lived account or team.
// - isRunScoped: what cleanup may delete in a long-lived team: things named for this run, or
//   named for another run and older than a day (a crashed run's leftovers).
import { parseThrowaway, runOf } from "./addresses.mjs";
import { isAtTestDomain } from "./config.mjs";

export class GuardError extends Error {}

/** A comp with fewer days than this left is a warning in the summary (owner decision 7). */
export const COMP_WARNING_DAYS = 30;
const DAY = 86_400_000;

/**
 * Checks a `GET /me` body. `email` is the address the harness signed in as; `teamIds` the teams
 * this account may be in (the two long-lived teams, or a throwaway's own). Returns warnings
 * (comps running out); throws GuardError otherwise. Messages never include IDs or addresses.
 */
export function checkMe(me, { email, teamIds, now = Date.now(), requireTeams = false }) {
  const user = me?.user;
  if (!user || typeof user.email !== "string") throw new GuardError("/me has no user");
  if (user.emailVerified !== true) throw new GuardError("/me says the account's email isn't verified");
  if (!isAtTestDomain(user.email)) throw new GuardError("/me is not a test account (its email isn't at the test mail domain)");
  if (typeof email !== "string" || user.email.toLowerCase() !== email.toLowerCase()) throw new GuardError("/me is a different account from the one the harness signed in as");
  if (!Array.isArray(me.teams)) throw new GuardError("/me has no team list");
  const allowed = new Set(teamIds);
  const strangers = me.teams.filter((t) => !allowed.has(t?.id));
  if (strangers.length) throw new GuardError(`/me lists ${strangers.length} team${strangers.length === 1 ? "" : "s"} that ${strangers.length === 1 ? "isn't a journey team" : "aren't journey teams"} this run expects; stopping`);
  if (requireTeams && me.teams.length !== allowed.size) throw new GuardError(`/me lists ${me.teams.length} of the ${allowed.size} journey teams this account should be in`);
  const warnings = [];
  for (const t of me.teams) {
    const until = Date.parse(t.comp?.until ?? "");
    if (requireTeams && !Number.isFinite(until)) warnings.push(`A long-lived journey team (${t.name}) has no comp`);
    else if (Number.isFinite(until) && until - now < COMP_WARNING_DAYS * DAY) warnings.push(`A long-lived journey team's comp (${t.name}) ends in ${Math.max(0, Math.floor((until - now) / DAY))} days: renew it with npm run ops -- comp`);
  }
  return warnings;
}

/**
 * Whether the harness may delete an account or close a team. `account` is the address signed
 * in; `runIds` the runs whose throwaways may go (this run, plus crashed runs found in runs/);
 * `longLived` the long-lived accounts' addresses and team IDs; for a team, `createdTeams` the
 * teams those runs recorded creating, and `team` the team as `/me` lists it. Throws GuardError
 * unless every condition holds.
 */
export function assertDestructiveAllowed({ action, account, runIds, longLived, team, createdTeams }) {
  if (action !== "deleteAccount" && action !== "closeTeam") throw new GuardError("Unknown destructive action");
  const lower = String(account ?? "").toLowerCase();
  if (longLived.emails.some((e) => e.toLowerCase() === lower)) throw new GuardError("Refusing a destructive call as a long-lived journey account");
  const parsed = parseThrowaway(account);
  if (!parsed) throw new GuardError("Refusing a destructive call as an account that isn't a run's throwaway");
  if (!new Set(runIds).has(parsed.runId)) throw new GuardError("Refusing a destructive call as another run's throwaway account");
  if (action === "closeTeam") {
    if (!team || typeof team.id !== "string") throw new GuardError("Refusing to close a team that /me doesn't list");
    if (longLived.teamIds.includes(team.id)) throw new GuardError("Refusing to close a long-lived journey team");
    if (!new Set(createdTeams).has(team.id)) throw new GuardError("Refusing to close a team the run didn't create");
    if (team.role !== "owner") throw new GuardError("Refusing to close a team the account doesn't own");
  }
}

/**
 * Whether cleanup may delete a document in a long-lived team: its name (a project's `client`, a
 * product's `name`) or barcode carries a run ID, and that's this run, or another run and the
 * document is more than a day old (`createdAt` or `updatedAt`). A document without a date is
 * swept only for this run.
 */
export function isRunScoped(doc, { runId, now = Date.now() }) {
  const data = doc?.data ?? {};
  const owner = runOf({ name: data.client ?? data.name, code: data.code });
  if (!owner) return false;
  if (owner === runId) return true;
  const at = Date.parse(data.createdAt ?? data.updatedAt ?? "");
  return Number.isFinite(at) && now - at > DAY;
}
