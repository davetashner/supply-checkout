// node --test scripts/journeys/test/ (part of npm run test:scripts): the throwaway accounts'
// sign-up, run records and email links (lib/throwaway.mjs), the Cognito sign-up calls, and the
// throwaway roles, against fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { THROWAWAY_ROLES, attemptRoles, isOwnerRole, parseThrowaway, throwawayAddress } from "../lib/addresses.mjs";
import { CognitoError, createCognito } from "../lib/cognito.mjs";
import { PROD } from "../lib/config.mjs";
import { checkRecord, readRecords, recordKey, writeRecord } from "../lib/runs.mjs";
import { checkNewTeam, createRecordKeeper, isInviteLink, isWelcomeLink, signUpThrowaway, throwawayPair } from "../lib/throwaway.mjs";
import { at, fakeFetch, fakeS3 } from "./helpers.mjs";

const RUN = "9-1";
const CLIENT = "abcdefghijklmnopqrstuvwxy1";
const addresses = Object.fromEntries(THROWAWAY_ROLES.map((role) => [role, throwawayAddress(RUN, role)]));

/** A record writer into a fake bucket, as the fixtures' harness.record is. */
const recorder = (s3 = fakeS3()) => ({ s3, write: (role, record) => writeRecord(s3, { ...record, runId: RUN, role, address: addresses[role] }) });
const stored = (s3, role) => JSON.parse(s3.store.get(recordKey(RUN, role)).body);

test("a try's throwaway roles: owner and crew, then a fresh pair for the retry, and owners are known", () => {
  assert.deepEqual(THROWAWAY_ROLES, ["owner", "crew", "ownerretry", "crewretry"]);
  assert.deepEqual(attemptRoles(0), { owner: "owner", crew: "crew" });
  assert.deepEqual(attemptRoles(1), { owner: "ownerretry", crew: "crewretry" });
  assert.throws(() => attemptRoles(2), /one try and one retry/);
  for (const role of THROWAWAY_ROLES) assert.deepEqual(parseThrowaway(throwawayAddress(RUN, role)), { runId: RUN, role });
  assert.deepEqual(THROWAWAY_ROLES.filter(isOwnerRole), ["owner", "ownerretry"]);
});

test("run records take the signup state, and nothing new besides", () => {
  const record = { runId: RUN, role: "owner", address: addresses.owner, state: "signup" };
  assert.deepEqual(checkRecord(record), record);
  assert.throws(() => checkRecord({ ...record, state: "signing-up" }), /planned, signup, started or deleted/);
  assert.throws(() => checkRecord({ ...record, code: "123456" }), /may not hold code/);
});

test("the record keeper writes the whole record each time, keeping the user ID and teams", async () => {
  const { s3, write } = recorder();
  const keeper = createRecordKeeper({ runId: RUN, role: "owner", address: addresses.owner, write: (r) => write("owner", r) });
  await keeper.update({ state: "started" });
  await keeper.update({ userId: "u-1" });
  await keeper.update({ teamIds: ["t-1"] });
  await keeper.update({ state: "deleted" });
  const r = stored(s3, "owner");
  assert.deepEqual({ ...r, updatedAt: "x" }, { runId: RUN, role: "owner", address: addresses.owner, state: "deleted", userId: "u-1", teamIds: ["t-1"], updatedAt: "x" });
  // The address, run and role can't be changed by a patch
  await keeper.update({ address: at("someone"), role: "crew", runId: "1-1" });
  assert.equal(stored(s3, "owner").address, addresses.owner);
  assert.equal(s3.store.has(recordKey(RUN, "crew")), false);
  // get() is a copy
  keeper.get().teamIds.push("t-2");
  assert.deepEqual(keeper.get().teamIds, ["t-1"]);
});

test("the record keeper refuses an address that isn't this run's throwaway for the role", () => {
  const write = async (r) => r;
  assert.throws(() => createRecordKeeper({ runId: RUN, role: "owner", address: addresses.crew, write }), /Not this run's/);
  assert.throws(() => createRecordKeeper({ runId: "8-1", role: "owner", address: addresses.owner, write }), /Not this run's/);
  assert.throws(() => createRecordKeeper({ runId: RUN, role: "owner", address: at("owner-lived"), write }), /Not this run's/);
});

test("throwawayPair gives each try its own pair of addresses from global setup", () => {
  const { write } = recorder();
  const first = throwawayPair({ runId: RUN, retry: 0, addresses, write });
  assert.deepEqual([first.owner.role, first.owner.address, first.crew.role, first.crew.address], ["owner", addresses.owner, "crew", addresses.crew]);
  const retry = throwawayPair({ runId: RUN, retry: 1, addresses, write });
  assert.deepEqual([retry.owner.address, retry.crew.address], [addresses.ownerretry, addresses.crewretry]);
  assert.throws(() => throwawayPair({ runId: RUN, retry: 0, addresses: { owner: addresses.owner }, write }), /no throwaway address for crew/);
});

test("sign-up records signup before SignUp, waits for the code mailed since, confirms, then records started", async () => {
  const { s3, write } = recorder();
  const { owner } = throwawayPair({ runId: RUN, retry: 0, addresses, write });
  const log = [];
  const cognito = {
    async signUp(email) { log.push(["signUp", email, stored(s3, "owner").state]); return { confirmed: false }; },
    async confirmSignUp(email, code) { log.push(["confirmSignUp", email, code]); },
  };
  const mail = async (opts) => { log.push(["mail", opts.to, opts.since, opts.want]); return { code: "123456" }; };
  const { since } = await signUpThrowaway({ cognito, mail, keeper: owner.keeper, now: () => 1000 });
  assert.equal(since, 1000);
  assert.deepEqual(log, [["signUp", addresses.owner, "signup"], ["mail", addresses.owner, 1000, "code"], ["confirmSignUp", addresses.owner, "123456"]]);
  assert.equal(stored(s3, "owner").state, "started");
});

test("sign-up skips the code when Cognito confirms at once, and a failed SignUp leaves the record at signup", async () => {
  const { s3, write } = recorder();
  const { crew } = throwawayPair({ runId: RUN, retry: 0, addresses, write });
  let mailed = 0;
  await signUpThrowaway({ cognito: { signUp: async () => ({ confirmed: true }), confirmSignUp: async () => assert.fail("no confirm") }, mail: async () => { mailed++; }, keeper: crew.keeper });
  assert.equal(mailed, 0);
  assert.equal(stored(s3, "crew").state, "started");

  const { owner } = throwawayPair({ runId: RUN, retry: 0, addresses, write });
  await assert.rejects(signUpThrowaway({ cognito: { signUp: async () => { throw new CognitoError("SignUp", "InvalidParameterException"); } }, mail: async () => ({}), keeper: owner.keeper }), /InvalidParameterException/);
  assert.equal(stored(s3, "owner").state, "signup");
});

test("sign-up refuses anything but a run's throwaway at the test mail domain, before any call", async () => {
  let called = false;
  const cognito = { signUp: async () => { called = true; return { confirmed: true }; } };
  const keeper = (address) => ({ get: () => ({ address }), update: async () => { called = true; } });
  for (const address of [at("owner-lived"), "run-9-1-owner-00000000000000000000000000000000@example.com", `${addresses.owner}.example`]) {
    await assert.rejects(signUpThrowaway({ cognito, mail: async () => ({}), keeper: keeper(address) }), /Refusing to sign up/);
  }
  assert.equal(called, false);
});

test("Cognito sign-up calls: no password ever, and errors carry only the type", async () => {
  const { fetch, calls } = fakeFetch({
    SignUp: [200, { UserConfirmed: false, UserSub: "sub-1", CodeDeliveryDetails: { Destination: "r***@e***" } }],
    ConfirmSignUp: (body) => (body.ConfirmationCode === "000000" ? [400, { __type: "CodeMismatchException", message: `Invalid code for ${body.Username}` }] : [200, {}]),
    ResendConfirmationCode: [200, { CodeDeliveryDetails: {} }],
  });
  const c = createCognito({ region: "us-east-1", clientId: CLIENT, fetch });
  assert.deepEqual(await c.signUp(addresses.owner), { confirmed: false });
  assert.deepEqual(calls[0].body, { ClientId: CLIENT, Username: addresses.owner, UserAttributes: [{ Name: "email", Value: addresses.owner }] });
  assert.equal("Password" in calls[0].body, false);
  await c.confirmSignUp(addresses.owner, "123456");
  assert.deepEqual(calls[1].body, { ClientId: CLIENT, Username: addresses.owner, ConfirmationCode: "123456" });
  const err = await c.confirmSignUp(addresses.owner, "000000").catch((e) => e);
  assert.ok(err instanceof CognitoError);
  assert.equal(err.type, "CodeMismatchException");
  assert.doesNotMatch(err.message, /run-|000000/);
  await c.resendConfirmationCode(addresses.crew);
  assert.deepEqual(calls.at(-1).body, { ClientId: CLIENT, Username: addresses.crew });
});

test("the welcome link is the app's home only; an invite link carries an invite ID and token", () => {
  assert.equal(isWelcomeLink(`${PROD.app}/`), true);
  for (const bad of [`${PROD.app}/?invite=i1&token=t`, `${PROD.app}/x`, `${PROD.app}/#a`, "https://example.com/", `${PROD.api}/`, "not a url"]) assert.equal(isWelcomeLink(bad), false, bad);
  assert.equal(isInviteLink(`${PROD.app}/?invite=inv_1-a&token=abc`), true);
  for (const bad of [`${PROD.app}/`, `${PROD.app}/?invite=i1`, `${PROD.app}/?token=t`, `${PROD.app}/?invite=a%2Fb&token=t`, `${PROD.app}/join?invite=i1&token=t`, "https://example.com/?invite=i1&token=t", "::"]) assert.equal(isInviteLink(bad), false, bad);
});

test("a new team must be the owner's, on a 14-day trial", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const team = { id: "t-1", name: "E2E 9-1 J1 team r0", role: "owner", plan: "trial", status: "trialing", trialEndsAt: "2026-10-23T12:00:01Z" };
  assert.deepEqual(checkNewTeam(team, { name: team.name, now }), []);
  assert.deepEqual(checkNewTeam({ ...team, role: undefined }, { name: team.name, now }), []);
  assert.deepEqual(checkNewTeam({ ...team, id: undefined }, { name: team.name, now }), ["POST /teams answered without a team ID"]);
  assert.deepEqual(checkNewTeam(undefined, { name: team.name, now }), ["POST /teams answered without a team ID"]);
  assert.deepEqual(checkNewTeam({ ...team, name: "Other", role: "viewer", plan: "pro", status: "active", trialEndsAt: "2026-10-30T12:00:00Z" }, { name: team.name, now }), [
    "the team's name isn't the one typed",
    "the new team's creator isn't its owner",
    'the plan is "pro", not "trial"',
    'the status is "active", not "trialing"',
    "the trial doesn't end 14 days from now",
  ]);
  assert.deepEqual(checkNewTeam({ ...team, trialEndsAt: null }, { name: team.name, now }), ["the trial doesn't end 14 days from now"]);
  // Nothing in a problem names the team's ID
  assert.ok(checkNewTeam({ ...team, id: "t-secret", plan: "x" }, { name: team.name, now }).every((p) => !p.includes("t-secret")));
});

test("records written through the keeper read back for cleanup", async () => {
  const { s3, write } = recorder();
  const { owner, crew } = throwawayPair({ runId: RUN, retry: 0, addresses, write });
  await owner.keeper.update({ state: "signup" });
  await crew.keeper.update({ state: "started", userId: "u-2" });
  const { records, problems } = await readRecords(s3);
  assert.deepEqual(problems, []);
  assert.deepEqual(records.map((r) => [r.role, r.state]).sort(), [["crew", "started"], ["owner", "signup"]]);
});
