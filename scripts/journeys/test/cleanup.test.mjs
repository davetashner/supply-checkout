// node --test scripts/journeys/test/ (part of npm run test:scripts): cleanup's scope, order and
// persistence, with fake Cognito, API and mail bucket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runBarcode, runName, throwawayAddress } from "../lib/addresses.mjs";
import { readConfig } from "../lib/config.mjs";
import { createMasker } from "../lib/mask.mjs";
import { recordKey } from "../lib/runs.mjs";
import { BASELINE_MARKUP, MARKUP_SENTINEL, resetMarkup } from "../lib/settings.mjs";
import { cleanTeam, cleanup, main, parseArgs } from "../cleanup.mjs";
import { at, fakeEnv, fakeS3, sesMessage } from "./helpers.mjs";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const RUN = "9-1";
const config = readConfig(fakeEnv());
const owner = throwawayAddress(RUN, "owner");
const crew = throwawayAddress(RUN, "crew");
const crashedOwner = throwawayAddress("8-1", "owner");

const doc = (id, data, version = 1) => ({ id, version, data });
const teamDocs = () => ({
  projects: [
    doc("p-run", { client: runName(RUN, "Job"), createdAt: "2026-10-07T11:00:00Z" }, 4),
    doc("p-old", { client: runName("7-1", "Job"), createdAt: "2026-10-05T11:00:00Z" }),
    doc("p-recent-other", { client: runName("8-1", "Job"), createdAt: "2026-10-07T10:00:00Z" }),
    doc("p-real", { client: "Echo Studio", createdAt: "2020-01-01T00:00:00Z" }),
    doc("adhoc-3", { kind: "adhoc", createdAt: "2026-10-07T11:00:00Z", items: { [runBarcode(RUN, 1)]: { code: runBarcode(RUN, 1), name: runName(RUN, "Gloves") } } }),
    doc("adhoc-2", { kind: "adhoc", createdAt: "2026-10-07T11:00:00Z", items: { [runBarcode(RUN, 1)]: { name: runName(RUN, "Gloves") }, SKU1: { code: "SKU1", name: "Paper towels" } } }),
    doc("adhoc-1", { kind: "adhoc", items: {} }),
  ],
  products: [
    doc(runBarcode(RUN, 1), { code: runBarcode(RUN, 1), name: runName(RUN, "Gloves") }, 3),
    doc("SKU1", { code: "SKU1", name: "Paper towels", updatedAt: "2020-01-01T00:00:00Z" }),
  ],
});

/** A fake world: Cognito, the API per signed-in account, the mail bucket and its log of calls. */
function world({ failList = false, failSignIn = [], records = [], codeFor = () => "12345678", meFor, settings = {}, failSettings = false } = {}) {
  const log = [];
  const tokens = new Map();
  let n = 0;
  const cognito = {
    async signInWithPassword(email, password, totp) {
      if (failSignIn.includes(email)) throw new Error("Cognito InitiateAuth failed: NotAuthorizedException");
      if (email === config.accounts.owner.email) assert.equal(typeof totp, "function");
      const t = `eyJtoken.${++n}.sig`;
      tokens.set(t, email);
      log.push(["signIn", email]);
      return { accessToken: t, idToken: `id${n}`, refreshToken: `rt${n}` };
    },
    async startEmailCode(email) { log.push(["startEmailCode", email]); return { session: "s", username: email }; },
    async answerEmailCode({ username }, code) {
      assert.equal(code, codeFor(username));
      const t = `eyJtoken.${++n}.sig`;
      tokens.set(t, username);
      log.push(["answerEmailCode", username]);
      return { accessToken: t };
    },
    async globalSignOut(token) { log.push(["globalSignOut", tokens.get(token)]); },
  };
  const docs = { "team-desktop-1": teamDocs(), "team-phone-2": teamDocs() };
  const apiFor = (token) => {
    const who = tokens.get(token);
    return {
      async me() {
        log.push(["me", who]);
        if (meFor?.[who]) return meFor[who];
        if (who === config.accounts.owner.email) return { user: { id: "u-owner", email: who, emailVerified: true }, teams: [{ id: "team-desktop-1" }, { id: "team-phone-2" }] };
        return { user: { id: `u-${who.slice(0, 12)}`, email: who, emailVerified: true }, teams: who === owner ? [{ id: "t-run", name: "Run team", role: "owner", closedAt: null }] : [{ id: "t-run", name: "Run team", role: "contributor", closedAt: null }] };
      },
      async listProjects(teamId) { if (failList) throw new Error("GET /teams/{teamId}/projects answered 500"); return docs[teamId].projects; },
      async listProducts(teamId) { return docs[teamId].products; },
      async deleteProject(teamId, id, version) { log.push(["deleteProject", teamId, id, version]); },
      async deleteProduct(teamId, id, version) { log.push(["deleteProduct", teamId, id, version]); },
      async getSettings(teamId) { if (failSettings) throw new Error("GET /teams/{teamId}/settings answered 503"); return settings[teamId] ?? { version: 1, settings: { equipmentMarkup: 0 } }; },
      async putSettings(teamId, markup, version) { log.push(["putSettings", who, teamId, markup, version]); },
      async closeTeam(teamId, name) { log.push(["closeTeam", who, teamId, name]); },
      async deleteMe() { log.push(["deleteMe", who]); },
    };
  };
  const objects = Object.fromEntries(records.map((r) => [recordKey(r.runId, r.role), JSON.stringify(r)]));
  const mailS3 = fakeS3(objects);
  const mail = async ({ to, want }) => { log.push(["mail", to, want]); return { code: codeFor(to) }; };
  return { log, cognito, apiFor, mailS3, mail };
}

const run = (w, extra = {}) => cleanup({ config, runId: RUN, cognito: w.cognito, apiFor: w.apiFor, mailS3: w.mailS3, masker: createMasker({ github: false }), mail: w.mail, totpCode: async () => "000000", now: () => NOW, ...extra });

test("cleanTeam deletes this run's and day-old runs' projects (General Use included) before items, and nothing else", async () => {
  const w = world();
  const { log } = w;
  const api = w.apiFor((await w.cognito.signInWithPassword(config.accounts.crew.email, "x")).accessToken);
  const r = await cleanTeam(api, "team-desktop-1", { runId: RUN, now: () => NOW });
  const deletes = log.filter(([op]) => op.startsWith("delete"));
  assert.deepEqual(deletes, [
    ["deleteProject", "team-desktop-1", "p-run", 4],
    ["deleteProject", "team-desktop-1", "p-old", 1],
    ["deleteProject", "team-desktop-1", "adhoc-3", 1],
    ["deleteProduct", "team-desktop-1", runBarcode(RUN, 1), 3],
  ]);
  assert.deepEqual(r, { done: ["project", "project", "project", "item"], left: [] });
});

test("cleanTeam carries on past a failed delete and reports it", async () => {
  const api = {
    listProjects: async () => teamDocs().projects,
    listProducts: async () => teamDocs().products,
    deleteProject: async (t, id) => { if (id === "p-run") throw new Error("DELETE /teams/{teamId}/projects/{projectId} answered 409 aborted"); },
    deleteProduct: async () => {},
  };
  const r = await cleanTeam(api, "team-desktop-1", { runId: RUN, now: () => NOW });
  assert.deepEqual(r.left, ["a project (DELETE /teams/{teamId}/projects/{projectId} answered 409 aborted)"]);
  assert.equal(r.done.length, 3);
});

test("cleanup order: owner and teams, throwaways (members first, closing the run's team), then everyone signed out", async () => {
  const records = [
    { runId: RUN, role: "owner", address: owner, state: "started", teamIds: ["t-run"] },
    { runId: RUN, role: "crew", address: crew, state: "started" },
    { runId: "8-1", role: "owner", address: crashedOwner, state: "deleted" },
  ];
  const w = world({ records });
  const r = await run(w);
  const ops = w.log.map(([op, ...rest]) => `${op} ${rest.map((x) => (x === owner ? "throwaway-owner" : x === crew ? "throwaway-crew" : x)).join(" ")}`.trim());
  const idx = (s) => ops.indexOf(s);
  assert.ok(idx(`signIn ${config.accounts.owner.email}`) === 0);
  assert.ok(idx(`me ${config.accounts.owner.email}`) < ops.findIndex((o) => o.startsWith("deleteProject")));
  assert.ok(ops.findLastIndex((o) => o.startsWith("deleteProduct")) < idx("startEmailCode throwaway-crew"));
  assert.ok(idx("deleteMe throwaway-crew") < idx("startEmailCode throwaway-owner"), "members before owners");
  assert.ok(idx("closeTeam throwaway-owner t-run Run team") < idx("deleteMe throwaway-owner"));
  assert.ok(!ops.some((o) => o.includes(crashedOwner)), "a deleted record is left alone");
  const signOuts = ops.filter((o) => o.startsWith("globalSignOut"));
  assert.deepEqual(signOuts, [`globalSignOut ${config.accounts.owner.email}`, `globalSignOut ${config.accounts.crew.email}`, `globalSignOut ${config.accounts.viewer.email}`]);
  assert.ok(ops.findIndex((o) => o.startsWith("globalSignOut")) > idx("deleteMe throwaway-owner"), "signing out is last");
  assert.deepEqual(r.left, []);
  // Records move to deleted, and hold no secret
  for (const role of ["owner", "crew"]) {
    const rec = JSON.parse(w.mailS3.store.get(recordKey(RUN, role)).body.toString());
    assert.equal(rec.state, "deleted");
    assert.deepEqual(Object.keys(rec).sort(), Object.keys(rec).filter((k) => ["runId", "role", "address", "state", "userId", "teamIds", "updatedAt"].includes(k)).sort());
  }
  // What it prints names no address in full
  assert.ok(!r.done.join("\n").includes(owner) && !r.done.join("\n").includes(config.accounts.owner.email));
});

test("cleanup signs everyone out even when signing in as owner fails, and reports what's left", async () => {
  const w = world({ failSignIn: [config.accounts.owner.email] });
  const r = await run(w);
  assert.match(r.left[0], /Couldn't sign in as the long-lived owner/);
  assert.ok(!w.log.some(([op]) => op.startsWith("delete")));
  assert.deepEqual(w.log.filter(([op]) => op === "globalSignOut").map(([, who]) => who), [config.accounts.crew.email, config.accounts.viewer.email]);
});

test("cleanup stops at the /me guard: a strange team means no deletes in the long-lived teams", async () => {
  const w = world({ meFor: { [config.accounts.owner.email]: { user: { email: config.accounts.owner.email, emailVerified: true }, teams: [{ id: "team-desktop-1" }, { id: "house-finch-team" }] } } });
  const r = await run(w);
  assert.match(r.left[0], /this run expects; stopping/);
  assert.ok(!r.left[0].includes("house-finch-team"));
  assert.ok(!w.log.some(([op]) => op === "deleteProject"));
  assert.ok(w.log.some(([op, who]) => op === "globalSignOut" && who === config.accounts.owner.email), "the owner's session still ends");
});

test("cleanup keeps going when a team can't be listed or a throwaway can't be deleted", async () => {
  const records = [{ runId: RUN, role: "owner", address: owner, state: "started", teamIds: ["t-run"] }];
  const w = world({ failList: true, records, meFor: { [owner]: { user: { email: owner, emailVerified: true }, teams: [{ id: "someone-elses", role: "owner", name: "X" }] } } });
  const r = await run(w);
  assert.equal(r.left.filter((l) => /couldn't list the team/.test(l)).length, 2);
  assert.ok(r.left.some((l) => /A throwaway owner of this run: not deleted: .*journey team/.test(l)));
  assert.ok(!w.log.some(([op]) => op === "closeTeam" || op === "deleteMe"));
  assert.ok(w.log.some(([op, who]) => op === "globalSignOut" && who === owner), "an undeleted throwaway is signed out everywhere");
});

test("cleanup deletes a crashed run's throwaway and never closes a team that run didn't make", async () => {
  const records = [{ runId: "8-1", role: "owner", address: crashedOwner, state: "started", teamIds: ["t-crashed"] }];
  const w = world({ records, meFor: { [crashedOwner]: { user: { email: crashedOwner, emailVerified: true }, teams: [{ id: "t-crashed", name: "Old", role: "owner", closedAt: null }] } } });
  const r = await run(w);
  assert.ok(w.log.some(([op, who, team]) => op === "closeTeam" && who === crashedOwner && team === "t-crashed"));
  assert.ok(w.log.some(([op, who]) => op === "deleteMe" && who === crashedOwner));
  assert.match(r.done.join("\n"), /A throwaway owner of an earlier run: deleted/);
});

test("cleanup reports unreadable run records and a bad address without acting on them", async () => {
  const w = world();
  w.mailS3.store.set("runs/9-1/accounts/owner.json", { body: Buffer.from(JSON.stringify({ runId: RUN, role: "owner", address: owner, state: "started", password: "x" })), lastModified: 0 });
  const r = await run(w);
  assert.ok(r.left.some((l) => /run record \(owner\) couldn't be read/.test(l)));
  assert.ok(!w.log.some(([op]) => op === "startEmailCode"));
  const broken = world();
  broken.mailS3.list = async () => { throw new Error("S3 list failed: AccessDenied"); };
  const r2 = await run(broken);
  assert.ok(r2.left.some((l) => /Couldn't read the run records: S3 list failed/.test(l)));
});

test("cleanup's CLI refuses outside Actions without the opt-in, and its arguments", async () => {
  assert.deepEqual(parseArgs(["--run", "5-1"]), { run: "5-1" });
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  const errors = [];
  const orig = console.error;
  console.error = (s) => errors.push(s);
  try {
    assert.equal(await main([], fakeEnv()), 1);
    assert.equal(await main(["--bad"], {}), 1);
  } finally {
    console.error = orig;
  }
  assert.match(errors[0], /runs only in GitHub Actions/);
  void at;
});

test("cleanup puts back a journey team's equipment markup left on J2.5's sentinel, and no other", async () => {
  const w = world({ settings: { "team-desktop-1": { version: 7, settings: { equipmentMarkup: MARKUP_SENTINEL } }, "team-phone-2": { version: 3, settings: { equipmentMarkup: 25 } } } });
  const r = await run(w);
  assert.deepEqual(w.log.filter(([op]) => op === "putSettings"), [["putSettings", config.accounts.owner.email, "team-desktop-1", BASELINE_MARKUP, 7]]);
  assert.ok(r.done.includes("Journeys desktop: put the equipment markup back"));
  assert.deepEqual(r.left, []);
});

test("cleanup reports a markup it couldn't check, and carries on", async () => {
  const w = world({ failSettings: true });
  const r = await run(w);
  assert.deepEqual(r.left, [
    "Journeys desktop: couldn't check or put back the equipment markup: GET /teams/{teamId}/settings answered 503",
    "Journeys phone: couldn't check or put back the equipment markup: GET /teams/{teamId}/settings answered 503",
  ]);
  assert.ok(w.log.some(([op]) => op === "deleteProject"), "the teams were still cleaned");
});

test("resetMarkup changes only the sentinel, at the version it read", async () => {
  const calls = [];
  const api = (res) => ({ getSettings: async () => res, putSettings: async (...a) => calls.push(a) });
  assert.equal(await resetMarkup(api({ version: 0, settings: {} }), "t"), false);
  assert.equal(await resetMarkup(api({ version: 2, settings: { equipmentMarkup: 0 } }), "t"), false);
  assert.equal(await resetMarkup(api({ version: 2, settings: { equipmentMarkup: 12.35 } }), "t"), false);
  assert.equal(await resetMarkup(api({ version: 4, settings: { equipmentMarkup: MARKUP_SENTINEL } }), "t"), true);
  assert.deepEqual(calls, [["t", BASELINE_MARKUP, 4]]);
});

test("cleanup deletes the unused sign-in codes mailed to the long-lived accounts, and no other mail", async () => {
  const w = world();
  const throwaway = throwawayAddress(RUN, "owner");
  await w.mailS3.put("inbox/crew-code", sesMessage({ to: config.accounts.crew.email, body: "Your code is 123456" }));
  await w.mailS3.put("inbox/viewer-code", sesMessage({ to: config.accounts.viewer.email, body: "Your code is 654321" }));
  await w.mailS3.put("inbox/throwaway", sesMessage({ to: throwaway, body: "Your code is 111111" }));
  const r = await run(w);
  assert.ok(!w.mailS3.store.has("inbox/crew-code") && !w.mailS3.store.has("inbox/viewer-code"));
  assert.ok(w.mailS3.store.has("inbox/throwaway"));
  assert.ok(r.done.includes("Deleted 2 unused sign-in codes to the long-lived accounts"), r.done.join("; "));
  assert.deepEqual(r.left, []);
  const failing = world();
  failing.mailS3.list = async () => { throw new Error("AccessDenied"); };
  const r2 = await run(failing);
  assert.ok(r2.left.some((l) => l.startsWith("Couldn't sweep the long-lived accounts' unused sign-in codes")), r2.left.join("; "));
});
