// The run's throwaway accounts (J1, J3, J5 and J11; docs/journey-tests-plan.md, "Test accounts and
// test teams"): signing one up, keeping its run record current, and telling the app's emails
// apart. Each throwaway is `run-<runId>-<role>-<32 hex>@` the test mail domain (addresses.mjs),
// so the backend marks it, and every team it makes, as test: out of the business metrics.
//
// Sign-up is Cognito's public SignUp on the web client, with no password, and ConfirmSignUp with
// the code mailed to the address (read from the test mailbox, checked like every test mail). The
// account then signs in by email code, through Managed Login in the browser. Every step is
// recorded under runs/<runId>/accounts/ before it's taken, so a run that dies at any point leaves
// a record the next cleanup acts on: `signup` before SignUp, `started` once confirmed, `deleted`
// once J11 has deleted it.
import { attemptRoles, parseThrowaway } from "./addresses.mjs";
import { PROD, isAtTestDomain } from "./config.mjs";

/**
 * A throwaway's run record as the journey goes. `write(record)` stores the whole record (the
 * fixtures' harness.record) and returns it as stored; each update carries every field, so a
 * later write never drops the user ID or the teams an earlier one recorded.
 */
export function createRecordKeeper({ runId, role, address, write }) {
  const parsed = parseThrowaway(address);
  if (!parsed || parsed.runId !== runId || parsed.role !== role) throw new Error("Not this run's throwaway address for the role");
  let current = { runId, role, address, state: "planned" };
  return {
    get: () => ({ ...current, ...(current.teamIds ? { teamIds: [...current.teamIds] } : {}) }),
    async update(patch) {
      const next = { ...current, ...patch, runId, role, address };
      delete next.updatedAt;
      const stored = await write(next);
      current = { ...next, ...(stored ?? {}) };
      return current;
    },
  };
}

/** The two throwaways of a test's try (attemptRoles), with their addresses from global setup. */
export function throwawayPair({ runId, retry, addresses, write }) {
  const roles = attemptRoles(retry);
  const make = (role) => {
    const address = addresses[role];
    if (!address) throw new Error(`Global setup made no throwaway address for ${role}`);
    return { role, address, keeper: createRecordKeeper({ runId, role, address, write: (record) => write(role, record) }) };
  };
  return { owner: make(roles.owner), crew: make(roles.crew) };
}

/**
 * Signs a throwaway up and confirms it: records `signup`, calls SignUp (no password), waits for
 * the confirmation code in the mailbox, confirms, and records `started`. Returns `since`, when
 * the sign-up began (the welcome email comes after it). Refuses any address that isn't a run's
 * throwaway at the test mail domain, whatever the caller passes.
 */
export async function signUpThrowaway({ cognito, mail, keeper, now = Date.now }) {
  const { address } = keeper.get();
  if (!isAtTestDomain(address) || !parseThrowaway(address)) throw new Error("Refusing to sign up an address that isn't a run's throwaway at the test mail domain");
  await keeper.update({ state: "signup" });
  const since = now();
  const { confirmed } = await cognito.signUp(address);
  if (!confirmed) {
    const { code } = await mail({ to: address, since, want: "code" });
    await cognito.confirmSignUp(address, code);
  }
  await keeper.update({ state: "started" });
  return { since };
}

const appUrl = (link) => {
  try {
    const url = new URL(link);
    return url.origin === PROD.app ? url : null;
  } catch { return null; }
};

/** The welcome email's link: the app's home, and nothing else (backend/src/email/templates.ts welcomeContent). */
export function isWelcomeLink(link) {
  const url = appUrl(link);
  return !!url && url.pathname === "/" && !url.search && !url.hash;
}

/** An invite email's link: the app's home with the invite's ID and one-time token (templates.ts, invite). */
export function isInviteLink(link) {
  const url = appUrl(link);
  return !!url && url.pathname === "/" && /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get("invite") ?? "") && !!url.searchParams.get("token");
}

/**
 * Checks the team POST /teams made for a throwaway owner: a 14-day trial, no card (J1's
 * expectation). Returns a list of what's wrong, empty when it's right; never an ID.
 */
export function checkNewTeam(team, { name, now = Date.now() }) {
  const problems = [];
  if (!team || typeof team.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(team.id)) return ["POST /teams answered without a team ID"];
  if (team.name !== name) problems.push("the team's name isn't the one typed");
  if (team.role !== undefined && team.role !== "owner") problems.push("the new team's creator isn't its owner");
  if (team.plan !== "trial") problems.push(`the plan is ${JSON.stringify(team.plan)}, not "trial"`);
  if (team.status !== "trialing") problems.push(`the status is ${JSON.stringify(team.status)}, not "trialing"`);
  const days = (Date.parse(team.trialEndsAt ?? "") - now) / 86_400_000;
  if (!Number.isFinite(days) || days < 13.9 || days > 14.1) problems.push("the trial doesn't end 14 days from now");
  return problems;
}
