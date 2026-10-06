// Tests for scripts/journeys.mjs: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateRegistry, journeyStatus, playwrightTests, stepNames, trace, generateDoc, renderTable,
  checkHeadings, docAlarms, checkAlarms, renderTrace, main, slug, ROOT, listErrors, listPlaywrightTests,
  checkTestsLines, checkStatusLines, testCalls, quotedTitles,
} from "./journeys.mjs";

// A small registry: J0 is critical, J1 is phase 2
const registry = () => ({
  journeys: [
    {
      id: "J0", name: "Check out", persona: "Crew member", critical: true,
      steps: [
        { id: "J0.1", text: "Open a sheet.", status: "built" },
        { id: "J0.2", text: "Scan an item.", status: "built", tests: ["backend/test/commands.test.ts"] },
        { id: "J0.3", text: "Sign the sheet.", status: "planned", beads: ["supply-checkout-sig"] },
      ],
    },
    {
      id: "J1", name: "Use the app", persona: "Owner", critical: false, phase2: true,
      steps: [{ id: "J1.1", text: "Open the app.", status: "planned" }],
    },
  ],
  alarms: [
    { name: "API errors", journeys: ["*"], infra: "api-errors" },
    { name: "Checkouts stopped", journeys: ["J0"] },
    { name: "Export failing", journeys: ["J0"], coveredBy: "API errors" },
  ],
});

// Playwright's --list --reporter=json, cut down to what the script reads
const listing = (specs) => ({
  suites: [{
    title: "a.spec.js", file: "a.spec.js", specs: specs.filter((s) => !s.describe),
    suites: [{ title: "group", file: "a.spec.js", specs: specs.filter((s) => s.describe), suites: [] }],
  }],
});
const spec = (title, tags, extra = {}) => ({ title, file: "a.spec.js", line: 1, tags, ...extra });

const doc = () => `# Customer journeys

<!-- journeys:table -->
<!-- /journeys:table -->

### J0. Check out

<!-- journeys:steps J0 -->
old steps
<!-- /journeys:steps J0 -->

### J1. Use the app

<!-- journeys:steps J1 -->
<!-- /journeys:steps J1 -->

## Alarms for blocked journeys

### Which alarms exist

| Alarm | Journeys | Severity | Built as |
| --- | --- | --- | --- |
| API errors | Every journey | P1 | API Gateway 5xx |

### Every journey

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **API errors** | 5xx | 2% | P1 |

### J0. Check out

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Checkouts stopped** | Checkouts | zero | P1 |
| **Export failing** | as API errors | | P2 |
`;

test("a well-formed registry has no problems", () => {
  assert.deepEqual(validateRegistry(registry()), []);
});

test("the registry's IDs, statuses and untested reasons are checked", () => {
  const reg = registry();
  reg.journeys[0].steps[0].id = "J0.7";
  reg.journeys[0].steps[1].status = "done";
  reg.journeys[0].steps[2].untested = "no reason";
  reg.journeys[1].id = "J5";
  reg.journeys[1].name = "";
  reg.alarms.push({ name: "API errors", journeys: ["J9"], infra: "x", coveredBy: "y" });
  reg.alarms.push({ name: "Covered", journeys: ["J0"], coveredBy: "Checkouts stopped" });
  const problems = validateRegistry(reg).join("\n");
  assert.match(problems, /Step 1 of J0 has ID J0\.7/);
  assert.match(problems, /J0\.2 has status "done"/);
  assert.match(problems, /J0\.3: untested is a reason, and only for a built step/);
  assert.match(problems, /Journey 1 in the registry has ID J5/);
  assert.match(problems, /J5 has no name/);
  assert.match(problems, /Alarm API errors is in the registry twice/);
  assert.match(problems, /names J9, which isn't a journey/);
  assert.match(problems, /has both infra and coveredBy/);
  assert.match(problems, /Covered is covered by Checkouts stopped, which isn't a built alarm/);
});

test("a critical journey needs an alarm of its own, not just Every journey's", () => {
  const reg = registry();
  reg.alarms = reg.alarms.filter((a) => a.journeys.includes("*"));
  assert.match(validateRegistry(reg).join("\n"), /J0 is critical but has no alarm of its own/);
  // Phase 2 journeys aren't held to it
  reg.journeys[0].phase2 = true;
  assert.deepEqual(validateRegistry(reg), []);
});

test("the status is computed from the steps", () => {
  const j = (statuses, extra = {}) => ({ steps: statuses.map((status) => ({ status })), ...extra });
  assert.equal(journeyStatus(j(["built", "built"])), "Tested");
  assert.equal(journeyStatus(j(["built", "planned"])), "Partly built");
  assert.equal(journeyStatus(j(["planned"])), "Planned");
  assert.equal(journeyStatus(j(["built"], { phase2: true })), "Planned (phase 2)");
  assert.equal(journeyStatus({ steps: [{ status: "built", untested: "needs a device" }] }), "Built, not all tested");
  assert.equal(journeyStatus(j(["built"], { planned: [{ what: "Bedrock" }, { what: "links" }] })), "Tested; still to come: Bedrock, links");
});

test("tests are read from Playwright's listing once each, with their describe titles and tags", () => {
  const list = listing([spec("one", ["J0.1"]), spec("two", ["J0"], { describe: true, line: 2 })]);
  // The same spec listed twice (another project) counts once
  list.suites[0].specs.push(spec("one", ["J0.1"]));
  assert.deepEqual(playwrightTests(list), [
    { file: "tests/a.spec.js", line: 1, title: "one", tags: ["J0.1"] },
    { file: "tests/a.spec.js", line: 2, title: "group › two", tags: ["J0"] },
  ]);
  assert.deepEqual(playwrightTests({}), []);
  assert.deepEqual(playwrightTests({ suites: [{ specs: [{ title: "x", file: "b.spec.js", line: 3 }] }] }), [{ file: "tests/b.spec.js", line: 3, title: "x", tags: [] }]);
});

test("test.step names are read for their step IDs and lines, and the test whose body they're in", () => {
  const source = [
    `const helper = () => test.step("J0.9 in a helper above", f);`,
    `test("one", { tag: ["@J0.1"] }, async () => {`,
    `  const s = "a ) in a string", t = \`and \${"a ( in a template"} here\`; // a ) in a comment`,
    `  /* a ( in another */ await test.step("J0.1 Open a sheet", async () => {});`,
    `});`,
    `test.describe("group", () => {`,
    `  test.skip(\`two \${x}\`, async () => { await test.step('J4.12 x', f); });`,
    `});`,
    `async function below() { await test.step("J0.2 after every test", f); }`,
  ].join("\n");
  assert.deepEqual(stepNames({ "tests/a.spec.js": source }), [
    { file: "tests/a.spec.js", id: "J0.9", line: 1 },
    { file: "tests/a.spec.js", id: "J0.1", line: 4, testLine: 2 },
    { file: "tests/a.spec.js", id: "J4.12", line: 7, testLine: 7 },
    { file: "tests/a.spec.js", id: "J0.2", line: 9 },
  ]);
  assert.deepEqual(testCalls(source).map((c) => source.slice(c.start, c.end + 1).split("\n").length), [4, 1]);
});

test("a test.step named for a step must be in a test tagged with that step", () => {
  const tests = playwrightTests(listing([spec("opens", ["J0.1"], { line: 1 }), spec("scans", ["J0"], { line: 10 }), spec("tagged by its group", ["J0.2"], { describe: true, line: 20 })]));
  const steps = [
    { file: "tests/a.spec.js", id: "J0.1", line: 2, testLine: 1 },
    { file: "tests/a.spec.js", id: "J0.2", line: 12, testLine: 10 },
    { file: "tests/a.spec.js", id: "J0.2", line: 21, testLine: 20 },
    // In a helper outside every test: nothing to check it against
    { file: "tests/a.spec.js", id: "J0.2", line: 30 },
  ];
  assert.deepEqual(trace(registry(), tests, { steps }).problems, [
    `tests/a.spec.js:12: a test.step is named for J0.2 in "scans", which isn't tagged @J0.2`,
  ]);
});

test("a failed listing says what Playwright said, and a missing web build is built first", () => {
  const stdout = JSON.stringify({ errors: [{ message: "Error: ENOENT: dist/demo/" }, { message: "SyntaxError in a.spec.js" }] });
  assert.equal(listErrors(stdout), "Error: ENOENT: dist/demo/\nSyntaxError in a.spec.js");
  assert.equal(listErrors("not json"), "");
  const root = mkdtempSync(join(tmpdir(), "journeys-list-"));
  const calls = [];
  const fail = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "npm") return "";
    throw Object.assign(new Error("exit 1"), { stdout, stderr: "" });
  };
  const errors = console.error;
  console.error = () => {};
  try {
    assert.throws(() => listPlaywrightTests(root, { run: fail }), /Couldn't list the Playwright tests:\nError: ENOENT: dist\/demo\/\nSyntaxError in a\.spec\.js/);
    assert.deepEqual(calls.map((c) => c.split(" ").slice(0, 3).join(" ")), ["npm run build:web", "npx playwright test"]);
    // Built already: listed straight away; errors in a listing that exits 0 fail it too
    mkdirSync(join(root, "dist/web"), { recursive: true });
    writeFileSync(join(root, "dist/web/index.html"), "");
    calls.length = 0;
    assert.deepEqual(listPlaywrightTests(root, { run: (cmd) => { calls.push(cmd); return JSON.stringify({ suites: [] }); } }), { suites: [] });
    assert.deepEqual(calls, ["npx"]);
    assert.throws(() => listPlaywrightTests(root, { run: () => stdout }), /SyntaxError in a\.spec\.js/);
  } finally {
    console.error = errors;
  }
});

test("a built step with no test fails the trace; a tagged test or a listed file covers it", () => {
  const reg = registry();
  let result = trace(reg, []);
  assert.deepEqual(result.problems, ["J0.1 is built but has no test. Tag a test that covers it with @J0.1, or record why there's none as untested in journeys/registry.json"]);
  result = trace(reg, playwrightTests(listing([spec("opens", ["J0.1"]), spec("other", [])])));
  assert.deepEqual(result.problems, []);
  assert.equal(result.untagged, 1);
  const [j0, j1] = result.journeys;
  assert.equal(j0.status, "Partly built");
  assert.deepEqual(j0.steps[0].tests, [{ file: "tests/a.spec.js", line: 1, title: "opens" }]);
  assert.deepEqual(j0.steps[1].otherTests, ["backend/test/commands.test.ts"]);
  assert.deepEqual(j0.alarms, [{ name: "Checkouts stopped", state: "planned" }, { name: "Export failing", state: "covered by API errors" }]);
  assert.equal(j1.status, "Planned (phase 2)");
  assert.deepEqual(result.everyJourneyAlarms, [{ name: "API errors", state: "built" }]);
});

test("an untested reason lets a built step pass, until it has a test", () => {
  const reg = registry();
  reg.journeys[0].steps[0].untested = "needs a real camera";
  let result = trace(reg, []);
  assert.deepEqual(result.problems, []);
  assert.equal(result.journeys[0].steps[0].untested, "needs a real camera");
  assert.match(renderTrace(result), /\| J0\.1 \| built \| none: needs a real camera \|/);
  result = trace(reg, playwrightTests(listing([spec("opens", ["J0.1"])])));
  assert.deepEqual(result.problems, ["J0.1 has tests now: remove its untested reason"]);
});

test("tags and step names must be in the registry, and planned steps can't have tests", () => {
  const tests = playwrightTests(listing([
    spec("opens", ["J0.1", "slow"]), spec("signs", ["J0.3"]), spec("gone", ["J7"]), spec("typo", ["J0.x"]), spec("far", ["J0.9"]),
  ]));
  const { problems } = trace(registry(), tests, { steps: [{ file: "tests/a.spec.js", id: "J0.8" }], fileExists: (p) => p !== "backend/test/commands.test.ts" });
  assert.deepEqual(problems, [
    `tests/a.spec.js: "gone" has tag @J7, which isn't in journeys/registry.json`,
    `tests/a.spec.js: "typo" has tag @J0.x; journey tags look like @J4 or @J4.2`,
    `tests/a.spec.js: "far" has tag @J0.9, which isn't in journeys/registry.json`,
    "tests/a.spec.js: a test.step is named for J0.8, which isn't in journeys/registry.json",
    "J0.2 lists backend/test/commands.test.ts, which doesn't exist",
    "J0.3 is planned, but 1 test(s) are tagged @J0.3. If it's built now, mark it built",
  ]);
});

test("beads in the export that disagree with a step's status are warnings, not problems", () => {
  const reg = registry();
  reg.journeys[0].steps[0].beads = ["supply-checkout-open", "supply-checkout-unknown"];
  reg.journeys[0].planned = [{ what: "links", beads: ["supply-checkout-sig"] }, { what: "later", beads: ["supply-checkout-open"] }];
  const beads = new Map([["supply-checkout-sig", "closed"], ["supply-checkout-open", "in_progress"]]);
  const result = trace(reg, playwrightTests(listing([spec("opens", ["J0.1"])])), { beads });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, [
    "J0.1 is built, but supply-checkout-open is in_progress",
    "J0.3 is planned, but its beads are closed (supply-checkout-sig): is it built now?",
    `J0's still to come "links" has only closed beads (supply-checkout-sig): is it built now?`,
  ]);
});

test("the doc's table and step lists are generated between their markers", () => {
  const reg = registry();
  const { md, problems } = generateDoc(doc(), reg);
  assert.deepEqual(problems, []);
  assert.match(md, /\| \[J0\]\(#j0-check-out\) \| Check out \| Crew member \| Yes \| Partly built \|/);
  assert.match(md, /\| \[J1\]\(#j1-use-the-app\) \| Use the app \| Owner \| No \| Planned \(phase 2\) \|/);
  assert.match(md, /<!-- journeys:steps J0 -->\n- \*\*J0\.1\*\* Open a sheet\.\n- \*\*J0\.2\*\* Scan an item\.\n- \*\*J0\.3\*\* Sign the sheet\. \*Planned: `supply-checkout-sig`\.\*\n<!-- \/journeys:steps J0 -->/);
  assert.match(md, /- \*\*J1\.1\*\* Open the app\. \*Planned\.\*/);
  assert.doesNotMatch(md, /old steps/);
  // Generating again changes nothing
  assert.equal(generateDoc(md, reg).md, md);
  assert.ok(renderTable(reg).startsWith("**Status**"));
});

test("a doc without the markers is a problem", () => {
  const { problems } = generateDoc("# Customer journeys\n<!-- /journeys:table -->\n<!-- journeys:table -->\n", registry());
  assert.deepEqual(problems, [
    "docs/journeys.md is missing the markers <!-- journeys:table --> … <!-- /journeys:table -->",
    "docs/journeys.md is missing the markers <!-- journeys:steps J0 --> … <!-- /journeys:steps J0 -->",
    "docs/journeys.md is missing the markers <!-- journeys:steps J1 --> … <!-- /journeys:steps J1 -->",
  ]);
});

test("the doc's journey headings match the registry's names", () => {
  assert.deepEqual(checkHeadings(doc(), registry()), []);
  const md = doc().replace("### J0. Check out\n\n<!--", "### J0. Checking out\n\n<!--").replace("### J1. Use the app", "### J2. Use the app");
  assert.deepEqual(checkHeadings(md, registry()), [
    `docs/journeys.md's heading "### J0. Checking out" doesn't match the registry's name: "### J0. Check out"`,
    `docs/journeys.md has no heading "### J1. Use the app"`,
    "docs/journeys.md has J2, which isn't in journeys/registry.json",
  ]);
  assert.equal(slug("J7. Subscribe, add seats and see invoices"), "j7-subscribe-add-seats-and-see-invoices");
});

test("the doc's alarm tables are read by section", () => {
  const { sections, built } = docAlarms(doc());
  assert.deepEqual(built, [{ name: "API errors", journeys: "Every journey" }]);
  assert.deepEqual(sections, [
    { title: "Every journey", journeys: ["*"], names: ["API errors"] },
    { title: "J0. Check out", journeys: ["J0"], names: ["Checkouts stopped", "Export failing"] },
  ]);
  const shared = docAlarms("## Alarms for blocked journeys\n\n### J9, J10, J11: roles\n\n| **Gone** | x |\n\n### Business metrics\n\n| **Not an alarm** | x |\n");
  assert.deepEqual(shared.sections, [{ title: "J9, J10, J11: roles", journeys: ["J9", "J10", "J11"], names: ["Gone"] }]);
  assert.deepEqual(docAlarms("# No alarms").sections, []);
});

test("the alarms must agree with the doc and with infra", () => {
  const infra = `id: "api-errors"`;
  assert.deepEqual(checkAlarms(doc(), registry(), infra), []);
  const reg = registry();
  reg.alarms[1].journeys = ["J1"];
  reg.alarms.push({ name: "Stock drifting", journeys: ["J0"], infra: "stock-drifting" });
  const md = doc().replace("| **Export failing** |", "| **Unknown** |\n| **Export failing** |").replace("| API errors | Every", "| Site down | Every journey | P1 | x |\n| API errors | Every");
  assert.deepEqual(checkAlarms(md, reg, infra), [
    "Alarm Checkouts stopped is under J0. Check out in docs/journeys.md, but the registry lists it for J1",
    "Alarm Unknown (docs/journeys.md, J0. Check out) isn't in journeys/registry.json",
    "Alarm Checkouts stopped is listed for J1 in the registry, but not in that section of docs/journeys.md",
    "Alarm Stock drifting is listed for J0 in the registry, but not in that section of docs/journeys.md",
    `Alarm Stock drifting is built (infra: stock-drifting) but isn't in docs/journeys.md's "Which alarms exist" table`,
    "Alarm Stock drifting's infra ID stock-drifting isn't in infra/lib/observability",
    "Alarm Site down (docs/journeys.md, Which alarms exist) isn't in journeys/registry.json",
  ]);
  // An ID is a whole string or ends an alarm name after its severity, never the tail of another ID
  const suffix = registry();
  suffix.alarms[0].infra = "errors";
  assert.deepEqual(checkAlarms(doc(), suffix, infra), ["Alarm API errors's infra ID errors isn't in infra/lib/observability"]);
  assert.deepEqual(checkAlarms(doc(), registry(), "alarmName: `supply-checkout-${env}-p1-api-errors`"), []);
  const unbuilt = registry();
  delete unbuilt.alarms[0].infra;
  assert.match(checkAlarms(doc(), unbuilt, infra).join("\n"), /Alarm API errors is in docs\/journeys\.md's "Which alarms exist" table, but the registry has no infra ID for it/);
});

test("the doc's Tests paragraphs name files and tests that exist and are tagged for the journey", () => {
  const tests = playwrightTests(listing([spec("opens", ["J0.1"]), spec("closes", ["J1"], { line: 2 }), spec("in a group", ["J0"], { describe: true, line: 3 })]));
  const md = `### J0. Check out

**Status:** partly built.

**Tests:** \`a.spec.js\`: "opens", "in a group"; \`backend/test/commands.test.ts\`, \`b.spec.js\` (all tests).

### J1. Use the app

Some text. **Tests:**
- \`a.spec.js\`: "closes", "gone", "opens"
- \`c.spec.js\`: whatever it covers; \`missing.test.ts\`

## Alarms for blocked journeys

**Tests:** \`nowhere.spec.js\`
`;
  const exists = (p) => !["tests/nowhere.spec.js", "backend/test/missing.test.ts"].includes(p);
  assert.deepEqual(checkTestsLines(md, registry(), tests, exists), [
    "docs/journeys.md, J0's Tests: b.spec.js has no test tagged @J0 or with one of its steps",
    `docs/journeys.md, J1's Tests: a.spec.js has no test "gone"`,
    `docs/journeys.md, J1's Tests: "opens" (a.spec.js) isn't tagged @J1 or with one of its steps`,
    "docs/journeys.md, J1's Tests: c.spec.js has no test tagged @J1 or with one of its steps",
    "docs/journeys.md, J1's Tests: missing.test.ts doesn't exist",
  ]);
});

test("only a list of quoted titles right after a file's colon is read as titles", () => {
  assert.deepEqual(quotedTitles(`: "a", "b" and "c"; then the "Save" button`), ["a", "b", "c"]);
  assert.deepEqual(quotedTitles(`: "a"; "b", and "c"\n- next`), ["a", "b", "c"]);
  assert.deepEqual(quotedTitles(`: failed reads, and what "Try again" does`), []);
  assert.deepEqual(quotedTitles(` (all tests, "x")`), []);
});

test("each journey's Status paragraph starts with the status the table computes", () => {
  const md = "### J0. Check out\n\n**Status:** Partly built: most of it.\n\n### J1. Use the app\n\n**Status:** built.\n\n### J9. Gone\n\n**Status:** x\n";
  assert.deepEqual(checkStatusLines(md, registry()), [`docs/journeys.md: J1's Status paragraph should start with "planned", as the journeys table says (it starts "built.")`]);
  assert.deepEqual(checkStatusLines("### J0. Check out\n\nNo status here.\n", registry()), []);
});

// A repo in a temporary directory, for main()
function repo({ reg = registry(), md = doc(), tags = [["J0.1"]] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "journeys-"));
  for (const dir of ["journeys", "docs", "tests", "backend/test", "infra/lib/observability", ".beads"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "journeys/registry.json"), JSON.stringify(reg));
  writeFileSync(join(root, "docs/journeys.md"), md);
  writeFileSync(join(root, "tests/a.spec.js"), `test("opens", { tag: ["@J0.1"] }, async () => { await test.step("J0.1 Open a sheet", f); });\n`);
  writeFileSync(join(root, "backend/test/commands.test.ts"), "");
  writeFileSync(join(root, "infra/lib/observability/alarms.ts"), `alarmName: \`supply-checkout-\${env}-p1-api-errors\``);
  writeFileSync(join(root, ".beads/issues.jsonl"), `${JSON.stringify({ id: "supply-checkout-sig", status: "closed" })}\n\nnot json\n`);
  writeFileSync(join(root, "list.json"), JSON.stringify(listing(tags.map((t, k) => spec(`test ${k}`, t)))));
  return root;
}

// Runs main() with console output captured
function run(argv, root) {
  const out = [], err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    return { code: main([...argv, "--tests", join(root, "list.json")], root), out: out.join("\n"), err: err.join("\n") };
  } finally {
    Object.assign(console, { log, error });
  }
}

test("main writes the doc, then passes, prints the trace and writes JSON", () => {
  const root = repo();
  let r = run([], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /docs\/journeys\.md's journeys table or step lists don't match journeys\/registry\.json\. Run npm run journeys:docs/);
  r = run(["--write"], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Updated docs\/journeys\.md/);
  r = run(["--write", "--json", join(root, "trace.json")], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /docs\/journeys\.md is up to date/);
  assert.match(r.out, /\| \*\*J0 Check out\*\* \(critical\): Partly built \| J0\.1 \| built \| a\.spec\.js \| Checkouts stopped \(planned\), Export failing \(covered by API errors\) \|/);
  assert.match(r.out, /Warnings \(checked against \.beads\/issues\.jsonl\):\n- J0\.3 is planned, but its beads are closed/);
  assert.match(r.out, /journeys: 2 journeys, 4 steps, all traced/);
  const json = JSON.parse(readFileSync(join(root, "trace.json"), "utf8"));
  assert.equal(json.journeys[0].steps[0].tests[0].title, "test 0");
  assert.equal(json.everyJourneyAlarms[0].name, "API errors");
});

test("main fails on an untraced step, and on a registry it can't use", () => {
  let root = repo({ tags: [[]] });
  run(["--write"], root);
  let r = run([], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /J0\.1 is built but has no test/);
  assert.match(r.out, /1 Playwright test with no journey tag/);
  const reg = registry();
  reg.journeys[0].steps[0].status = "maybe";
  root = repo({ reg });
  r = run([], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /journeys\/registry\.json has problems:\n\n- J0\.1 has status "maybe"/);
});

test("the repo's own registry and doc agree", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "journeys/registry.json"), "utf8"));
  assert.deepEqual(validateRegistry(reg), []);
  const md = readFileSync(join(ROOT, "docs/journeys.md"), "utf8");
  const generated = generateDoc(md, reg);
  assert.deepEqual(generated.problems, []);
  assert.equal(generated.md, md, "run npm run journeys:docs");
  assert.deepEqual(checkHeadings(md, reg), []);
  assert.deepEqual(checkStatusLines(md, reg), []);
});
