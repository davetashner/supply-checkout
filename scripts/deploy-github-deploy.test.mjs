// node --test scripts/deploy-github-deploy.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_REPO } from "./check-environments.mjs";
import {
  DEFAULT_OWNER_ID,
  DEFAULT_REPOSITORY_ID,
  cdkArgs,
  cliContext,
  contextProblems,
  contextSources,
  idProblems,
  main,
  repositoryFrom,
} from "./deploy-github-deploy.mjs";

/** GitHub's answers: the repository (with IDs) and locked-down environments. */
const github = ({ repoId = DEFAULT_REPOSITORY_ID, ownerId = DEFAULT_OWNER_ID } = {}) => (seen = []) => (p) => {
  seen.push(p);
  if (/^repos\/[^/]+\/[^/]+$/.test(p)) return { id: Number(repoId), owner: { id: Number(ownerId) } };
  if (p.endsWith("deployment-branch-policies?per_page=100")) return { branch_policies: [{ name: "main", type: "branch" }] };
  return {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
  };
};
/** No context files and no CDK_CONTEXT_JSON, unless given. */
const noFiles = { exists: () => false, env: {}, home: "/home/x", infraDir: "/repo/infra" };

test("context from the command line, in every form cdk takes", () => {
  assert.equal(repositoryFrom(["--profile", "p"]), DEFAULT_REPO);
  assert.deepEqual(cliContext(["-c", "githubRepository=o/r", "-c", "githubOwnerId=1", "--context", "githubRepositoryId=2", "--context=envName=prod", "-c=a=b=c"]), {
    githubRepository: "o/r", githubOwnerId: "1", githubRepositoryId: "2", envName: "prod", a: "b=c",
  });
  assert.equal(repositoryFrom(["-c=githubRepository=o/r4"]), "o/r4");
});

test("reads cdk.json, cdk.context.json, ~/.cdk.json and CDK_CONTEXT_JSON", () => {
  const files = {
    "/repo/infra/cdk.json": { context: { envName: "prod" } },
    "/repo/infra/cdk.context.json": { githubOwnerId: 9 },
    "/home/x/.cdk.json": { context: { githubRepository: "x/y" } },
  };
  const sources = contextSources({ infraDir: "/repo/infra", home: "/home/x", env: { CDK_CONTEXT_JSON: '{"githubRepositoryId":"3"}' }, exists: (f) => f in files, read: (f) => JSON.stringify(files[f]) });
  assert.deepEqual(sources.map((s) => s.source), ["/repo/infra/cdk.json", "/repo/infra/cdk.context.json", "/home/x/.cdk.json", "CDK_CONTEXT_JSON"]);
  const problems = contextProblems({}, sources);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /cdk\.context\.json sets githubOwnerId to 9/);
  // The same values on the command line make them harmless
  assert.deepEqual(contextProblems({ githubOwnerId: "9", githubRepository: "x/y", githubRepositoryId: "3" }, sources), []);
  assert.equal(contextProblems({ githubOwnerId: "8" }, sources).length, 3);
});

test("the IDs must be GitHub's", () => {
  const api = github()();
  assert.deepEqual(idProblems(DEFAULT_REPO, DEFAULT_OWNER_ID, DEFAULT_REPOSITORY_ID, api), []);
  assert.deepEqual(idProblems("o/r", "1", "2", github({ repoId: 3, ownerId: 4 })()), ["o/r's repository ID is 3, not 2", "o/r's owner ID is 4, not 1"]);
  assert.deepEqual(idProblems("o/gone", "1", "2", () => null), ["GitHub has no repository o/gone"]);
});

test("checks that repository's IDs and environments, then deploys with the caller's arguments", () => {
  const seen = [];
  const runs = [];
  const args = ["--profile", "p", "-c", "githubRepository=o/r", "-c", "githubOwnerId=1", "-c", "githubRepositoryId=2"];
  const code = main(args, { ...noFiles, api: github({ repoId: 2, ownerId: 1 })(seen), run: (cmd, a) => { runs.push([cmd, ...a]); return { status: 0 }; }, log: () => {} });
  assert.equal(code, 0);
  assert.equal(seen[0], "repos/o/r");
  assert.ok(seen.slice(1).length === 4 && seen.slice(1).every((p) => p.startsWith("repos/o/r/environments/")));
  assert.deepEqual(runs, [["./node_modules/.bin/cdk", ...cdkArgs(args)]]);
  assert.deepEqual(cdkArgs([]), ["deploy", "--app", "npx tsx bin/github-deploy.ts", "-o", "cdk.out/github-deploy"]);
});

test("refuses, deploying nothing, on context set elsewhere, wrong IDs or open environments", () => {
  const cases = [
    [{ ...noFiles, exists: (f) => f === "/repo/infra/cdk.json", read: () => '{"context":{"githubRepository":"evil/repo"}}' }, github()(), /cdk\.json sets githubRepository/],
    [{ ...noFiles, env: { CDK_CONTEXT_JSON: '{"githubOwnerId":1}' } }, github()(), /CDK_CONTEXT_JSON sets githubOwnerId/],
    [noFiles, github({ repoId: 7 })(), /repository ID is 7/],
    [noFiles, (p) => (/^repos\/[^/]+\/[^/]+$/.test(p) ? github()()(p) : null), /production: doesn't exist/],
  ];
  for (const [deps, api, expected] of cases) {
    const runs = [];
    const errors = [];
    assert.equal(main([], { ...deps, api, run: () => runs.push(1), log: () => {}, error: (e) => errors.push(e) }), 1);
    assert.deepEqual(runs, []);
    assert.match(errors[0], expected);
  }
});

test("a failed cdk deploy fails it", () => {
  assert.equal(main([], { ...noFiles, api: github()(), run: () => ({ status: 3 }), log: () => {} }), 3);
  assert.equal(main([], { ...noFiles, api: github()(), run: () => ({ status: null }), log: () => {} }), 1);
});

test("in step with infra: the package script and DEFAULT_GITHUB_REPOSITORY's IDs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../infra/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["deploy:github-deploy"], "node ../scripts/deploy-github-deploy.mjs");
  const config = readFileSync(new URL("../infra/lib/config.ts", import.meta.url), "utf8");
  assert.ok(config.includes(`ownerId: ${DEFAULT_OWNER_ID},`));
  assert.ok(config.includes(`repositoryId: ${DEFAULT_REPOSITORY_ID},`));
});
