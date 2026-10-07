// Before any prod journey test runs (tests/prod/global-setup.mjs calls this):
//
// 1. Refuse unless it's a GitHub Actions run or opted in, and every project's baseURL is the
//    prod app's.
// 2. Read and check every secret, and mask them all.
// 3. Read the app's config.json (its API and sign-in hosts must be prod's) for the client ID.
// 4. Sign in as each long-lived account through the API (password, and TOTP for owner) and check
//    /me: a verified test account, in exactly the two journey teams. Any mismatch stops the run.
//    Comps running out become warnings for the summary.
// 5. Make the run's throwaway addresses (unguessable), mask them, and record them as `planned`
//    under runs/<runId>/ in the mail bucket before any is used, so a crashed run's cleanup can
//    find them.
//
// Returns what the workers need, as environment variables (workers inherit the main process's
// environment), and the warnings.
import { THROWAWAY_ROLES, throwawayAddress } from "./addresses.mjs";
import { assertRunAllowed, checkBaseUrl, readConfig, secretValues } from "./config.mjs";
import { checkMe } from "./guards.mjs";
import { writeRecord } from "./runs.mjs";

export async function setup({ env, baseUrls, runId, appConfig, createCognito, apiFor, mailS3, masker, totpCode, random }) {
  assertRunAllowed(env);
  for (const url of baseUrls) checkBaseUrl(url);
  const config = readConfig(env);
  for (const v of secretValues(config)) masker.add(v);
  const { clientId } = await appConfig();
  const cognito = createCognito(clientId);
  const warnings = [];
  const teamIds = Object.values(config.teams);
  for (const account of Object.values(config.accounts)) {
    const tokens = await cognito.signInWithPassword(account.email, account.password, account.totp ? totpCode : undefined);
    for (const t of Object.values(tokens)) masker.add(t);
    const me = await apiFor(tokens.accessToken).me();
    masker.add(me?.user?.id);
    warnings.push(...checkMe(me, { email: account.email, teamIds, requireTeams: true }));
  }
  const out = { JOURNEYS_CLIENT_ID: clientId };
  for (const role of THROWAWAY_ROLES) {
    const address = masker.add(throwawayAddress(runId, role, random ? { random } : undefined));
    await writeRecord(mailS3, { runId, role, address, state: "planned" });
    out[`JOURNEYS_THROWAWAY_${role.toUpperCase()}`] = address;
  }
  return { env: out, warnings: [...new Set(warnings)] };
}
