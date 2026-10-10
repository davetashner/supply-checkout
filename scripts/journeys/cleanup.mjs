#!/usr/bin/env node
// Cleanup after a prod journey run, pass or fail (docs/journey-tests-plan.md, "Data isolation and
// cleanup"). The journeys workflow runs it with `if: always()`:
//
//   node scripts/journeys/cleanup.mjs [--run <runId>]
//
// In order, carrying on past any failure:
//
// 1. Signs in as the long-lived `owner` (API only: password and TOTP) and checks /me (only the
//    two journey teams).
// 2. In both long-lived teams, deletes every project and item named for this run, and anything
//    named for another run that's more than a day old (a crashed run's leftovers); projects first,
//    including a General Use (no job) project whose every line is such an item, and a finished
//    General Use with no lines left (J14's), then the items.
//    Then puts back the team's equipment markup if J2.5's test left it on its sentinel value
//    (lib/settings.mjs): a run that died mid-test leaves the team's settings as they were.
// 3. Deletes each throwaway account a run recorded under runs/ in the mail bucket and didn't
//    finish deleting (this run's, and a crashed run's): signs in as it by email code (read from
//    the mailbox, checked like every test mail), closes the teams that run created and it owns,
//    and calls DELETE /me. Members before owners. Each destructive call goes through
//    assertDestructiveAllowed first. A run that died mid-sign-up (`signup`) may have left an
//    unconfirmed account, which can't sign in: it's confirmed first with a new code
//    (ResendConfirmationCode). Only when Cognito says there's no such user is the record marked
//    deleted; if no code comes, it stays `signup` and the next cleanup tries again, until runs/
//    expires it (30 days). An owner that died between POST /teams and recording the team's ID
//    has the team's name in its record (written before POST /teams): the one team it owns
//    with exactly that name counts as the run's.
// 4. Last, always: signs every long-lived account (and any throwaway it couldn't delete) out
//    everywhere (Cognito GlobalSignOut), so no token in a trace in the results bucket still works.
//
// Then prints what it did and what's left (masked), and exits 1 if anything is left.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isOwnerRole, parseThrowaway } from "./lib/addresses.mjs";
import { appConfig, createApi } from "./lib/api.mjs";
import { createCognito } from "./lib/cognito.mjs";
import { PROD, assertRunAllowed, readConfig, runDir, runId as currentRunId, secretValues } from "./lib/config.mjs";
import { assertDestructiveAllowed, checkMe, isRunScoped } from "./lib/guards.mjs";
import { MailTimeout, sweepInbox, waitForMail } from "./lib/mailbox.mjs";
import { createSessionPool } from "./lib/sessions.mjs";
import { MASKED_VALUES_FILE, createMasker } from "./lib/mask.mjs";
import { readRecords, writeRecord } from "./lib/runs.mjs";
import { resetMarkup } from "./lib/settings.mjs";
import { createS3 } from "./lib/s3.mjs";
import { freshTotp } from "./lib/totp.mjs";

const message = (err) => (err instanceof Error ? err.message : String(err));

/** Deletes this run's things (and crashed runs' older ones) in one long-lived team. */
export async function cleanTeam(api, teamId, { runId, now }) {
  const done = [];
  const left = [];
  const scoped = (doc) => isRunScoped(doc, { runId, now: now() });
  const [projects, products] = await Promise.all([api.listProjects(teamId), api.listProducts(teamId)]);
  const runProducts = products.filter(scoped);
  const runKeys = new Set(runProducts.map((p) => p.id));
  const lineIsRuns = (key, line, project) => runKeys.has(key) || scoped({ data: { name: line?.name, code: line?.code, createdAt: project.data?.createdAt } });
  const generalUse = (p) => p.data?.kind === "adhoc" && Object.keys(p.data.items ?? {}).length > 0 && Object.entries(p.data.items).every(([k, line]) => lineIsRuns(k, line, p));
  // A finished General Use with no lines left: J14 moves its only line to the run's project, then
  // taps Finished Return. Nothing is on it, so in a journey team it's only ever a test's leftover.
  // An open one is left alone: the next quick take adds to it.
  const emptyFinishedGeneralUse = (p) => p.data?.kind === "adhoc" && p.data.status === "closed" && Object.keys(p.data.items ?? {}).length === 0;
  const runProjects = projects.filter((p) => scoped(p) || generalUse(p) || emptyFinishedGeneralUse(p));
  for (const p of runProjects) {
    try { await api.deleteProject(teamId, p.id, p.version); done.push("project"); } catch (err) { left.push(`a project (${message(err)})`); }
  }
  for (const p of runProducts) {
    try { await api.deleteProduct(teamId, p.id, p.version); done.push("item"); } catch (err) { left.push(`an item (${message(err)})`); }
  }
  return { done, left };
}

/**
 * The whole cleanup, with every dependency injected. Returns `{ done, left }`: lists of what it
 * did and what it couldn't, as masked text.
 */
export async function cleanup({ config, runId, cognito, apiFor, mailS3, masker, log = () => {}, mail = waitForMail, totpCode, now = Date.now, savedSessions = null }) {
  const done = [];
  const left = [];
  const sessions = [];
  const longLived = { emails: Object.values(config.accounts).map((a) => a.email), teamIds: Object.values(config.teams) };
  const signedIn = (label, tokens) => {
    masker.add(tokens.accessToken);
    masker.add(tokens.idToken);
    masker.add(tokens.refreshToken);
    sessions.push({ label, accessToken: tokens.accessToken });
    return apiFor(tokens.accessToken);
  };
  // "confirmed" once an unconfirmed leftover is confirmed, or when Cognito says it already is;
  // "gone" when Cognito says there's no such user; "no code" when the resend went but no code
  // came (maybe no account there: Cognito may answer an unknown address as a real one)
  const confirmLeftover = async (address) => {
    const since = now();
    try {
      await cognito.resendConfirmationCode(address);
    } catch (err) {
      // Already confirmed; or no account at all
      if (err?.type === "InvalidParameterException") return "confirmed";
      if (err?.type === "UserNotFoundException") return "gone";
      throw err;
    }
    try {
      const { code } = await mail({ s3: mailS3, to: address, since, want: "code", masker, log });
      await cognito.confirmSignUp(address, code);
      return "confirmed";
    } catch (err) {
      if (err instanceof MailTimeout) return "no code";
      throw err;
    }
  };

  try {
    // 1 and 2: the long-lived teams, as owner
    let owner;
    try {
      const { email, password } = config.accounts.owner;
      owner = signedIn("owner", await cognito.signInWithPassword(email, password, totpCode));
      checkMe(await owner.me(), { email, teamIds: longLived.teamIds });
    } catch (err) {
      owner = null;
      left.push(`Couldn't sign in as the long-lived owner and check /me: ${message(err)}`);
    }
    if (owner) {
      for (const [which, teamId] of Object.entries(config.teams)) {
        try {
          const r = await cleanTeam(owner, teamId, { runId, now });
          if (r.done.length) done.push(`Journeys ${which}: deleted ${r.done.filter((d) => d === "project").length} projects and ${r.done.filter((d) => d === "item").length} items`);
          for (const l of r.left) left.push(`Journeys ${which}: couldn't delete ${l}`);
        } catch (err) {
          left.push(`Journeys ${which}: couldn't list the team: ${message(err)}`);
        }
        try {
          if (await resetMarkup(owner, teamId)) done.push(`Journeys ${which}: put the equipment markup back`);
        } catch (err) {
          left.push(`Journeys ${which}: couldn't check or put back the equipment markup: ${message(err)}`);
        }
      }
    }

    // 3: throwaway accounts, members before owners
    let records = [];
    try {
      const r = await readRecords(mailS3);
      records = r.records;
      left.push(...r.problems);
    } catch (err) {
      left.push(`Couldn't read the run records: ${message(err)}`);
    }
    for (const r of records) masker.add(r.address);
    const runIds = [...new Set([runId, ...records.map((r) => r.runId)])];
    const teamsOfRun = (id) => records.filter((r) => r.runId === id).flatMap((r) => r.teamIds ?? []);
    // Members before owners; a `signup` record (the run died around SignUp) as well as `started`
    const pending = records.filter((r) => r.state === "started" || r.state === "signup").sort((a, b) => isOwnerRole(a.role) - isOwnerRole(b.role));
    for (const record of pending) {
      const label = `A throwaway ${record.role} of ${record.runId === runId ? "this run" : "an earlier run"}`;
      try {
        if (!parseThrowaway(record.address)) throw new Error("not a throwaway address");
        // A run that died mid-sign-up may have left the account unconfirmed, which can't sign
        // in: confirm it first, with a new code. Each record is tried once per cleanup
        const confirmation = record.state === "signup" ? await confirmLeftover(record.address) : "confirmed";
        // Cognito said there's no such user: SignUp never made it
        if (confirmation === "gone") {
          await writeRecord(mailS3, { ...record, state: "deleted" });
          done.push(`${label}: never signed up (Cognito has no such account), so there was nothing to delete`);
          continue;
        }
        let challenge, code;
        try {
          const since = now();
          challenge = await cognito.startEmailCode(record.address);
          ({ code } = await mail({ s3: mailS3, to: record.address, since, want: "code", masker, log }));
        } catch (err) {
          if (record.state === "signup" && err?.type === "UserNotFoundException") {
            await writeRecord(mailS3, { ...record, state: "deleted" });
            done.push(`${label}: never signed up (Cognito has no such account), so there was nothing to delete`);
            continue;
          }
          // No code at all for a sign-up that may never have reached Cognito (it answers an
          // unknown address as it would a real one): the record stays `signup`, so the next
          // cleanup tries again, until the record expires with runs/ (30 days). Such an account,
          // if it exists, is unconfirmed: no team, no data, and it can't sign in
          if (confirmation === "no code" && err instanceof MailTimeout) {
            done.push(`${label}: no confirmation or sign-in code came, so it may never have signed up; kept for the next cleanup to try again`);
            continue;
          }
          throw err;
        }
        const api = signedIn(label, await cognito.answerEmailCode(challenge, code));
        const createdTeams = teamsOfRun(record.runId);
        const me = await api.me();
        masker.add(me?.user?.id);
        for (const t of me?.teams ?? []) masker.add(t?.id);
        // The run died between POST /teams and recording the team's ID: the team it named
        // beforehand, exactly, that it owns, and only if it's the one such team
        let adopted = {};
        if (record.teamName && !(record.teamIds ?? []).length) {
          const named = (me?.teams ?? []).filter((t) => t?.name === record.teamName && t.role === "owner" && typeof t.id === "string");
          if (named.length === 1) {
            createdTeams.push(named[0].id);
            adopted = { teamIds: [named[0].id] };
            await writeRecord(mailS3, { ...record, ...adopted });
          }
        }
        checkMe(me, { email: record.address, teamIds: createdTeams });
        for (const team of me.teams) {
          if (team.role !== "owner" || team.closedAt) continue;
          assertDestructiveAllowed({ action: "closeTeam", account: record.address, runIds, longLived, team, createdTeams });
          await api.closeTeam(team.id, team.name);
        }
        assertDestructiveAllowed({ action: "deleteAccount", account: record.address, runIds, longLived });
        await api.deleteMe();
        sessions.pop();
        await writeRecord(mailS3, { ...record, ...adopted, state: "deleted" });
        done.push(`${label}: deleted`);
      } catch (err) {
        left.push(`${label}: not deleted: ${message(err)}`);
      }
    }
  } finally {
    // The unused codes Managed Login mailed the long-lived accounts before their password sign-ins
    try {
      const n = await sweepInbox({ s3: mailS3, to: longLived.emails, log });
      if (n) done.push(`Deleted ${n} unused sign-in ${n === 1 ? "code" : "codes"} to the long-lived accounts`);
    } catch (err) {
      left.push(`Couldn't sweep the long-lived accounts' unused sign-in codes: ${message(err)}`);
    }
    // 4: every session ends, whatever happened above
    for (const role of ["crew", "viewer"]) {
      try {
        const { email, password } = config.accounts[role];
        signedIn(role, await cognito.signInWithPassword(email, password));
      } catch (err) {
        left.push(`Couldn't sign in as the long-lived ${role} to sign it out everywhere: ${message(err)}`);
      }
    }
    for (const s of sessions) {
      try { await cognito.globalSignOut(s.accessToken); done.push(`Signed ${s.label} out everywhere`); } catch (err) { left.push(`Couldn't sign ${s.label} out everywhere: ${message(err)}`); }
    }
    // 5: the tests' saved sessions (lib/sessions.mjs), whose refresh tokens the sign-outs above revoked
    if (savedSessions) {
      try { savedSessions.clear(); done.push("Deleted the tests' saved sessions"); } catch (err) { left.push(`Couldn't delete the tests' saved sessions: ${message(err)}`); }
    }
  }
  return { done: done.map(masker.redact), left: left.map(masker.redact) };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run" && argv[i + 1]) out.run = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const masker = createMasker();
  try {
    const args = parseArgs(argv);
    assertRunAllowed(env);
    const config = readConfig(env);
    for (const v of secretValues(config)) masker.remember(v);
    const runId = args.run ?? currentRunId(env);
    const dir = runDir(env, runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    masker.persistTo(path.join(dir, MASKED_VALUES_FILE));
    const { clientId } = await appConfig();
    const cognito = createCognito({ region: PROD.region, clientId });
    const totpCode = () => freshTotp(config.accounts.owner.totp, { stateFile: path.join(dir, "totp-step") });
    const log = (line) => console.log(masker.redact(line));
    const { done, left } = await cleanup({ config, runId, cognito, apiFor: (token) => createApi({ token }), mailS3: createS3(config.buckets.mail), masker, log, totpCode, savedSessions: createSessionPool(dir) });
    for (const d of done) console.log(`cleanup: ${d}`);
    for (const l of left) console.log(`cleanup: LEFT ${l}`);
    console.log(left.length ? `cleanup: ${left.length} thing${left.length === 1 ? "" : "s"} left` : "cleanup: nothing left");
    return left.length ? 1 : 0;
  } catch (err) {
    console.error(`cleanup: ${masker.redact(message(err))}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
