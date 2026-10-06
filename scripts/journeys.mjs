// The customer journeys' traceability: journeys/registry.json holds each journey, its
// steps and its alarms; this script ties them to the tests and to docs/journeys.md.
//
//   npm run journeys:trace   check everything below, then print the table (journey, step,
//                            status, tests, alarms). Exits 1 on any problem. CI's lint job runs it.
//   npm run journeys:docs    rewrite the generated parts of docs/journeys.md from the registry
//
// Options: --json <file> also writes the trace as JSON (for journey videos and evidence packs),
// --tests <file> reads Playwright's `--list --reporter=json` output from a file instead of
// listing the tests (which needs a build: npm run build:web).
//
// What it checks:
// - the registry is well formed: step IDs J<n>.<m> in order, a status of built or planned
// - every built step of a journey that isn't phase 2 has a test: a Playwright test tagged with
//   the step (@J4.2), or a test file listed in the step's `tests` (backend tests), or else an
//   `untested` reason in the registry. A planned step has no tests tagged with it.
// - every critical journey has at least one alarm of its own (not counting Every journey's)
// - every tag and test.step ID in tests/ names a journey or step in the registry
// - each alarm with `infra` exists in infra/lib/observability, and the alarms agree with the
//   doc's alarm tables and its "Which alarms exist" table
// - docs/journeys.md's journeys table, status legend and step lists are what the registry
//   generates (npm run journeys:docs), and its journey headings match the registry's names
//
// It also warns, without failing, when a planned step's beads are all closed, or a built step's
// aren't, in the committed beads export (.beads/issues.jsonl).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY = "journeys/registry.json";
export const DOC = "docs/journeys.md";
const ALARMS_HEADING = "## Alarms for blocked journeys";
const JOURNEY_TAG = /^@?(J\d+)(?:\.(\d+))?$/;
const escapeRegExp = (s) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

// ---------------------------------------------------------------------------
// The registry

export function validateRegistry(reg) {
  const problems = [];
  const ids = new Set();
  for (const [n, j] of (reg.journeys || []).entries()) {
    if (j.id !== `J${n}`) problems.push(`Journey ${n} in the registry has ID ${j.id}; journeys are J0, J1, … in order`);
    ids.add(j.id);
    for (const field of ["name", "persona"]) if (!j[field]) problems.push(`${j.id} has no ${field}`);
    if (typeof j.critical !== "boolean") problems.push(`${j.id} needs critical: true or false`);
    if (!j.steps?.length) problems.push(`${j.id} has no steps`);
    for (const [k, s] of (j.steps || []).entries()) {
      if (s.id !== `${j.id}.${k + 1}`) problems.push(`Step ${k + 1} of ${j.id} has ID ${s.id}; steps are ${j.id}.1, ${j.id}.2, … in order`);
      if (!s.text) problems.push(`${s.id} has no text`);
      if (!["built", "planned"].includes(s.status)) problems.push(`${s.id} has status ${JSON.stringify(s.status)}; use built or planned`);
      if ("untested" in s && (s.status !== "built" || typeof s.untested !== "string" || !s.untested.trim())) {
        problems.push(`${s.id}: untested is a reason, and only for a built step`);
      }
    }
    for (const p of j.planned || []) if (!p.what) problems.push(`${j.id} has a planned item without what`);
  }
  const names = new Set();
  for (const a of reg.alarms || []) {
    if (names.has(a.name)) problems.push(`Alarm ${a.name} is in the registry twice`);
    names.add(a.name);
    if (!a.journeys?.length) problems.push(`Alarm ${a.name} lists no journeys`);
    for (const id of a.journeys || []) if (id !== "*" && !ids.has(id)) problems.push(`Alarm ${a.name} names ${id}, which isn't a journey`);
    if (a.infra && a.coveredBy) problems.push(`Alarm ${a.name} has both infra and coveredBy`);
  }
  for (const a of reg.alarms || []) {
    const by = a.coveredBy && (reg.alarms || []).find((b) => b.name === a.coveredBy);
    if (a.coveredBy && !by?.infra) problems.push(`Alarm ${a.name} is covered by ${a.coveredBy}, which isn't a built alarm in the registry`);
  }
  for (const j of reg.journeys || []) {
    if (j.critical && !j.phase2 && !journeyAlarms(reg, j.id).length) {
      problems.push(`${j.id} is critical but has no alarm of its own. List one in the registry's alarms (and the doc), even if it's planned`);
    }
  }
  return problems;
}

// The journey's own alarms, not Every journey's, with whether each exists
export const journeyAlarms = (reg, id) =>
  (reg.alarms || []).filter((a) => a.journeys.includes(id)).map((a) => ({
    name: a.name,
    state: a.infra ? "built" : a.coveredBy ? `covered by ${a.coveredBy}` : "planned",
  }));

export function journeyStatus(j) {
  if (j.phase2) return "Planned (phase 2)";
  const built = j.steps.filter((s) => s.status === "built");
  if (!built.length) return "Planned";
  if (built.length < j.steps.length) return "Partly built";
  let status = built.some((s) => s.untested) ? "Built, not all tested" : "Tested";
  if (j.planned?.length) status += `; still to come: ${j.planned.map((p) => p.what).join(", ")}`;
  return status;
}

// ---------------------------------------------------------------------------
// Tests

// Every test in Playwright's `--list --reporter=json` output, once each, with its tags
export function playwrightTests(list) {
  const tests = new Map();
  const walk = (suite, titles) => {
    for (const spec of suite.specs || []) {
      const title = [...titles, spec.title].join(" › ");
      const key = `${spec.file}:${spec.line}:${title}`;
      if (!tests.has(key)) tests.set(key, { file: `tests/${spec.file}`, line: spec.line, title, tags: (spec.tags || []).map((t) => t.replace(/^@/, "")) });
    }
    for (const child of suite.suites || []) walk(child, [...titles, child.title]);
  };
  for (const file of list.suites || []) walk(file, []);
  return [...tests.values()];
}

// Playwright's listing loads every spec, and the specs load the web build: it's built first
// when it's missing
export function listPlaywrightTests(root = ROOT, { run = execFileSync } = {}) {
  if (!existsSync(join(root, "dist", "web", "index.html"))) {
    console.error("Building the web app (npm run build:web), which the Playwright tests load…");
    run("npm", ["run", "build:web"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  }
  let out;
  try {
    out = run("npx", ["playwright", "test", "--list", "--reporter=json", "--project=desktop-chrome"], {
      cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(`Couldn't list the Playwright tests:\n${listErrors(e.stdout) || e.stderr || e.message}`, { cause: e });
  }
  const list = JSON.parse(out);
  if (list.errors?.length) throw new Error(`Couldn't list the Playwright tests:\n${listErrors(out)}`);
  return list;
}

// The errors in Playwright's JSON listing (a spec that doesn't load, say), one per line
export function listErrors(stdout) {
  try {
    return (JSON.parse(stdout).errors || []).map((e) => e.message).join("\n");
  } catch {
    return "";
  }
}

// The step IDs that test.step names start with, in each spec file, with their lines and the line
// of the test whose body they're in (none for a test.step in a helper outside every test)
export function stepNames(sources) {
  const found = [];
  const lineAt = (text, index) => text.slice(0, index).split("\n").length;
  for (const [file, text] of Object.entries(sources)) {
    const bodies = testCalls(text);
    for (const m of text.matchAll(/test\.step\(\s*["'`](J\d+\.\d+)\b/g)) {
      const inside = bodies.filter((b) => b.start < m.index && m.index < b.end).at(-1);
      found.push({ file, id: m[1], line: lineAt(text, m.index), ...(inside ? { testLine: lineAt(text, inside.start) } : {}) });
    }
  }
  return found;
}

// Where each test(…) call starts and ends in a spec's source: from "test(" to its closing
// parenthesis, skipping strings, template literals and comments
export function testCalls(text) {
  const calls = [];
  for (const m of text.matchAll(/(?<![\w.$])test(?:\.(?:only|skip|fixme|fail|slow))?\(/g)) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
      else if (c === '"' || c === "'") i = skipQuoted(text, i, c);
      else if (c === "`") i = skipTemplate(text, i);
      else if (c === "/" && text[i + 1] === "/") i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
      else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i) < 0 ? text.length : text.indexOf("*/", i) + 1;
    }
    calls.push({ start: m.index, end: i });
  }
  return calls;
}

function skipQuoted(text, i, quote) {
  for (i++; i < text.length && text[i] !== quote && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
  return i;
}

function skipTemplate(text, i) {
  for (i++; i < text.length && text[i] !== "`"; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "$" && text[i + 1] === "{") {
      // Up to the matching }, which may hold strings and templates of its own
      let depth = 0;
      for (i++; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) break;
        else if (text[i] === '"' || text[i] === "'") i = skipQuoted(text, i, text[i]);
        else if (text[i] === "`") i = skipTemplate(text, i);
      }
    }
  }
  return i;
}

function specSources(root) {
  const dir = join(root, "tests");
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".spec.js")).map((f) => [`tests/${f}`, readFileSync(join(dir, f), "utf8")]));
}

// ---------------------------------------------------------------------------
// The doc

export const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
const heading = (j) => `${j.id}. ${j.name}`;
const beadList = (beads) => (beads?.length ? beads.map((b) => `\`${b}\``).join(", ") : "");

export function renderTable(reg) {
  return [
    "**Status** (computed from the registry by `npm run journeys:docs`)",
    "- **Tested**: every step is built and has automated tests. \"Still to come\" names what's planned beyond the steps.",
    "- **Built, not all tested**: every step is built; some have no automated test yet, for the reasons in the registry.",
    "- **Partly built**: some steps are built and tested; the steps marked *Planned* aren't built yet.",
    "- **Planned**: no step is built yet. The beads listed build it.",
    "",
    "| # | Journey | Persona | Critical | Status |",
    "| --- | --- | --- | --- | --- |",
    ...reg.journeys.map((j) => `| [${j.id}](#${slug(heading(j))}) | ${j.name} | ${j.persona} | ${j.critical ? "Yes" : "No"} | ${journeyStatus(j)} |`),
  ].join("\n");
}

export function renderSteps(j) {
  return j.steps.map((s) => {
    const planned = s.status === "planned" ? ` *Planned${s.beads?.length ? `: ${beadList(s.beads)}` : ""}.*` : "";
    return `- **${s.id}** ${s.text}${planned}`;
  }).join("\n");
}

// Replaces what's between <!-- journeys:NAME --> and <!-- /journeys:NAME --> with `body`
function replaceBlock(md, name, body, problems) {
  const open = `<!-- journeys:${name} -->`, close = `<!-- /journeys:${name} -->`;
  const start = md.indexOf(open), end = md.indexOf(close);
  if (start < 0 || end < start) {
    problems.push(`${DOC} is missing the markers ${open} … ${close}`);
    return md;
  }
  return `${md.slice(0, start + open.length)}\n${body}\n${md.slice(end)}`;
}

export function generateDoc(md, reg) {
  const problems = [];
  let out = replaceBlock(md, "table", renderTable(reg), problems);
  for (const j of reg.journeys) out = replaceBlock(out, `steps ${j.id}`, renderSteps(j), problems);
  return { md: out, problems };
}

// The journeys half's headings agree with the registry
export function checkHeadings(md, reg) {
  const problems = [];
  const half = md.split(ALARMS_HEADING)[0];
  const found = [...half.matchAll(/^### (J\d+)\. (.+)$/gm)].map((m) => ({ id: m[1], text: `${m[1]}. ${m[2]}` }));
  for (const j of reg.journeys) {
    const h = found.find((f) => f.id === j.id);
    if (!h) problems.push(`${DOC} has no heading "### ${heading(j)}"`);
    else if (h.text !== heading(j)) problems.push(`${DOC}'s heading "### ${h.text}" doesn't match the registry's name: "### ${heading(j)}"`);
  }
  for (const f of found) if (!reg.journeys.some((j) => j.id === f.id)) problems.push(`${DOC} has ${f.id}, which isn't in ${REGISTRY}`);
  return problems;
}

// Each journey's hand-written **Status:** paragraph starts with the status the table computes
// ("tested", "partly built", …), so the two can't disagree
export function checkStatusLines(md, reg) {
  const problems = [];
  const half = md.split(ALARMS_HEADING)[0];
  for (const part of half.split(/^### /m).slice(1)) {
    const j = reg.journeys.find((x) => x.id === /^(J\d+)\./.exec(part)?.[1]);
    const line = /^\*\*Status:\*\* (.*)$/m.exec(part)?.[1];
    if (!j || line === undefined) continue;
    const want = journeyStatus(j).split(/[;(]/)[0].trim().toLowerCase();
    if (!line.toLowerCase().startsWith(want)) problems.push(`${DOC}: ${j.id}'s Status paragraph should start with "${want}", as the journeys table says (it starts "${line.slice(0, 40)}")`);
  }
  return problems;
}

// The alarms half: each "### <journeys>" section's bold alarm names, and the "Which alarms exist" table
export function docAlarms(md) {
  const half = md.split(ALARMS_HEADING)[1] || "";
  const sections = [];
  let built = [];
  for (const part of half.split(/^### /m).slice(1)) {
    const [title, ...rest] = part.split("\n");
    const body = rest.join("\n");
    if (title === "Which alarms exist") {
      built = [...body.matchAll(/^\| ([^|*][^|]*?) \| ([^|]+?) \|/gm)]
        .filter((m) => m[1] !== "Alarm" && !/^-+$/.test(m[1]))
        .flatMap((m) => m[1].split(", ").map((name) => ({ name, journeys: m[2] })));
      continue;
    }
    const journeys = title === "Every journey" ? ["*"] : /^J\d/.test(title) ? title.split(/[.:]/)[0].match(/J\d+/g) : null;
    if (!journeys) continue;
    sections.push({ title, journeys, names: [...body.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map((m) => m[1]) });
  }
  return { sections, built };
}

export function checkAlarms(md, reg, infraSource) {
  const problems = [];
  const { sections, built } = docAlarms(md);
  const byName = new Map(reg.alarms.map((a) => [a.name, a]));
  for (const s of sections) {
    for (const name of s.names) {
      const a = byName.get(name);
      if (!a) problems.push(`Alarm ${name} (${DOC}, ${s.title}) isn't in ${REGISTRY}`);
      else if (!a.journeys.some((id) => s.journeys.includes(id))) problems.push(`Alarm ${name} is under ${s.title} in ${DOC}, but the registry lists it for ${a.journeys.join(", ")}`);
    }
  }
  for (const a of reg.alarms) {
    for (const id of a.journeys) {
      if (!sections.some((s) => s.journeys.includes(id) && s.names.includes(a.name))) {
        problems.push(`Alarm ${a.name} is listed for ${id === "*" ? "Every journey" : id} in the registry, but not in that section of ${DOC}`);
      }
    }
  }
  const builtNames = new Set(built.map((b) => b.name));
  for (const a of reg.alarms) {
    if (a.infra && !builtNames.has(a.name)) problems.push(`Alarm ${a.name} is built (infra: ${a.infra}) but isn't in ${DOC}'s "Which alarms exist" table`);
    if (!a.infra && builtNames.has(a.name)) problems.push(`Alarm ${a.name} is in ${DOC}'s "Which alarms exist" table, but the registry has no infra ID for it`);
    // The ID is a whole string ("site-down"), or ends an alarm name after its severity (`…-p1-site-down`)
    if (a.infra && !new RegExp(`(["\`]|-p\\d-)${escapeRegExp(a.infra)}["\`]`).test(infraSource)) {
      problems.push(`Alarm ${a.name}'s infra ID ${a.infra} isn't in infra/lib/observability`);
    }
  }
  for (const name of builtNames) if (!byName.has(name)) problems.push(`Alarm ${name} (${DOC}, Which alarms exist) isn't in ${REGISTRY}`);
  return problems;
}

// The test titles right after a file's name: `file.spec.js`: "one", "two" and "three"; … A list
// of quoted titles starts straight after the colon and ends at the first thing that isn't one,
// so quoted words in the prose around it aren't read as titles.
export function quotedTitles(after) {
  const titles = [];
  const list = /^\s*:\s*/.exec(after);
  if (!list) return titles;
  const item = /^"([^"]+)"(\s*(?:,\s*and\s+|,\s*|;\s*|\s+and\s+))?/y;
  let rest = after.slice(list[0].length);
  for (let m; (m = item.exec(rest)); rest = rest.slice(m[0].length)) {
    item.lastIndex = 0;
    titles.push(m[1]);
    if (!m[2]) break;
  }
  return titles;
}

// The hand-written **Tests:** paragraphs in each journey's section: every file they name exists,
// every test they quote by title is in that file and tagged with the journey or one of its
// steps, and every spec file they name has at least one test tagged for the journey
export function checkTestsLines(md, reg, tests, fileExists = () => true) {
  const problems = [];
  const half = md.split(ALARMS_HEADING)[0];
  for (const part of half.split(/^### /m).slice(1)) {
    const id = /^(J\d+)\./.exec(part)?.[1];
    const j = reg.journeys.find((x) => x.id === id);
    if (!j) continue;
    const mine = (t) => t.tags.some((tag) => tag === j.id || tag.startsWith(`${j.id}.`));
    for (const para of part.split(/\n\s*\n/)) {
      const at = para.indexOf("**Tests:**");
      if (at < 0) continue;
      // Each `file`, and the quoted titles after it up to the next file
      const text = para.slice(at);
      const refs = [...text.matchAll(/`([^`]+\.(?:spec\.js|test\.ts))`/g)];
      for (const [k, ref] of refs.entries()) {
        const name = ref[1];
        const path = name.includes("/") ? name : name.endsWith(".spec.js") ? `tests/${name}` : `backend/test/${name}`;
        if (!fileExists(path)) {
          problems.push(`${DOC}, ${j.id}'s Tests: ${name} doesn't exist`);
          continue;
        }
        if (!path.endsWith(".spec.js")) continue;
        const inFile = tests.filter((t) => t.file === path);
        const after = text.slice(ref.index + ref[0].length, refs[k + 1]?.index ?? text.length);
        const titles = quotedTitles(after);
        for (const title of titles) {
          const found = inFile.filter((t) => t.title.split(" › ").at(-1) === title);
          if (!found.length) problems.push(`${DOC}, ${j.id}'s Tests: ${name} has no test "${title}"`);
          else if (!found.some(mine)) problems.push(`${DOC}, ${j.id}'s Tests: "${title}" (${name}) isn't tagged @${j.id} or with one of its steps`);
        }
        if (!titles.length && !inFile.some(mine)) problems.push(`${DOC}, ${j.id}'s Tests: ${name} has no test tagged @${j.id} or with one of its steps`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The trace

export function trace(reg, tests, { steps = [], fileExists = () => true, beads = null } = {}) {
  const problems = [], warnings = [];
  const stepIds = new Set(reg.journeys.flatMap((j) => j.steps.map((s) => s.id)));
  const journeyIds = new Set(reg.journeys.map((j) => j.id));
  for (const t of tests) {
    for (const tag of t.tags) {
      const m = JOURNEY_TAG.exec(tag);
      if (!m && /^J\d/.test(tag)) problems.push(`${t.file}: "${t.title}" has tag @${tag}; journey tags look like @J4 or @J4.2`);
      else if (m && !(m[2] ? stepIds.has(tag) : journeyIds.has(tag))) problems.push(`${t.file}: "${t.title}" has tag @${tag}, which isn't in ${REGISTRY}`);
    }
  }
  for (const s of steps) {
    if (!stepIds.has(s.id)) {
      problems.push(`${s.file}: a test.step is named for ${s.id}, which isn't in ${REGISTRY}`);
      continue;
    }
    // Only a test.step in a test's own body is checked, against that test (or each test a loop makes
    // from it); one in a helper outside every test can't be pinned on a test
    const owners = s.testLine === undefined ? [] : tests.filter((t) => t.file === s.file && t.line === s.testLine);
    if (owners.length && !owners.some((t) => t.tags.includes(s.id))) {
      problems.push(`${s.file}:${s.line}: a test.step is named for ${s.id} in "${owners[0].title}", which isn't tagged @${s.id}`);
    }
  }

  const status = (id) => beads?.get(id);
  const journeys = reg.journeys.map((j) => {
    const rows = j.steps.map((s) => {
      const tagged = tests.filter((t) => t.tags.includes(s.id));
      const other = s.tests || [];
      for (const path of other) if (!fileExists(path)) problems.push(`${s.id} lists ${path}, which doesn't exist`);
      if (s.status === "planned" && tagged.length) problems.push(`${s.id} is planned, but ${tagged.length} test(s) are tagged @${s.id}. If it's built now, mark it built`);
      if (s.status === "built" && !j.phase2 && !tagged.length && !other.length && !s.untested) {
        problems.push(`${s.id} is built but has no test. Tag a test that covers it with @${s.id}, or record why there's none as untested in ${REGISTRY}`);
      }
      if (s.untested && (tagged.length || other.length)) problems.push(`${s.id} has tests now: remove its untested reason`);
      if (beads && s.beads?.length) {
        const known = s.beads.filter((b) => status(b));
        if (s.status === "planned" && known.length && known.every((b) => status(b) === "closed")) warnings.push(`${s.id} is planned, but its beads are closed (${known.join(", ")}): is it built now?`);
        if (s.status === "built") for (const b of known) if (status(b) !== "closed") warnings.push(`${s.id} is built, but ${b} is ${status(b)}`);
      }
      return {
        id: s.id, text: s.text, status: s.status, simulated: s.simulated, untested: s.untested,
        tests: tagged.map(({ file, line, title }) => ({ file, line, title })), otherTests: other,
      };
    });
    if (beads) {
      for (const p of j.planned || []) {
        const known = (p.beads || []).filter((b) => status(b));
        if (known.length && known.every((b) => status(b) === "closed")) warnings.push(`${j.id}'s still to come "${p.what}" has only closed beads (${known.join(", ")}): is it built now?`);
      }
    }
    return {
      id: j.id, name: j.name, persona: j.persona, critical: j.critical, phase2: !!j.phase2,
      status: journeyStatus(j), alarms: journeyAlarms(reg, j.id), steps: rows,
    };
  });
  const untagged = tests.filter((t) => !t.tags.some((tag) => JOURNEY_TAG.test(tag))).length;
  return { journeys, everyJourneyAlarms: journeyAlarms(reg, "*"), untagged, problems, warnings };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summarizeTests(row) {
  if (!row.tests.length && !row.otherTests.length) return row.untested ? `none: ${row.untested}` : row.status === "planned" ? "" : "none";
  const files = new Map();
  for (const t of row.tests) files.set(t.file.replace(/^tests\//, ""), (files.get(t.file.replace(/^tests\//, "")) || 0) + 1);
  const parts = [...files].map(([f, n]) => (n > 1 ? `${f} ×${n}` : f));
  return [...parts, ...row.otherTests.map((p) => p.replace(/^backend\/test\//, "backend: "))].join(", ");
}

function summarizeAlarms(alarms) {
  if (!alarms.length) return "";
  return alarms.map((a) => (a.state === "built" ? a.name : `${a.name} (${a.state})`)).join(", ");
}

export function renderTrace(result) {
  const lines = ["| Journey | Step | Status | Tests | Alarms |", "| --- | --- | --- | --- | --- |"];
  for (const j of result.journeys) {
    for (const [k, s] of j.steps.entries()) {
      const journey = k ? "" : `**${j.id} ${j.name}**${j.critical ? " (critical)" : ""}: ${j.status}`;
      lines.push(`| ${journey} | ${s.id} | ${s.status} | ${summarizeTests(s)} | ${k ? "" : summarizeAlarms(j.alarms)} |`);
    }
  }
  lines.push("", `Every journey's alarms: ${summarizeAlarms(result.everyJourneyAlarms)}`);
  lines.push(`${plural(result.untagged, "Playwright test")} with no journey tag.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

function readBeads(root) {
  const path = join(root, ".beads", "issues.jsonl");
  if (!existsSync(path)) return null;
  const beads = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line);
      if (b.id) beads.set(b.id, b.status);
    } catch {}
  }
  return beads;
}

function infraSource(root) {
  const dir = join(root, "infra", "lib", "observability");
  return readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

export function main(argv, root = ROOT) {
  const arg = (name) => { const k = argv.indexOf(name); return k >= 0 ? argv[k + 1] : undefined; };
  const reg = JSON.parse(readFileSync(join(root, REGISTRY), "utf8"));
  const problems = validateRegistry(reg);
  if (problems.length) {
    console.error(`${REGISTRY} has problems:\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
    return 1;
  }
  const docPath = join(root, DOC);
  const md = readFileSync(docPath, "utf8");
  const generated = generateDoc(md, reg);
  problems.push(...generated.problems);
  if (argv.includes("--write")) {
    if (generated.md !== md) writeFileSync(docPath, generated.md);
    console.log(generated.md !== md ? `Updated ${DOC}` : `${DOC} is up to date`);
  } else if (generated.md !== md && !generated.problems.length) {
    problems.push(`${DOC}'s journeys table or step lists don't match ${REGISTRY}. Run npm run journeys:docs`);
  }
  problems.push(...checkHeadings(generated.md, reg), ...checkStatusLines(generated.md, reg), ...checkAlarms(generated.md, reg, infraSource(root)));

  const testsFile = arg("--tests");
  const list = testsFile ? JSON.parse(readFileSync(testsFile, "utf8")) : listPlaywrightTests(root);
  const result = trace(reg, playwrightTests(list), {
    steps: stepNames(specSources(root)),
    fileExists: (p) => existsSync(join(root, p)),
    beads: readBeads(root),
  });
  problems.push(...result.problems, ...checkTestsLines(generated.md, reg, playwrightTests(list), (p) => existsSync(join(root, p))));
  const json = arg("--json");
  if (json) writeFileSync(json, `${JSON.stringify({ journeys: result.journeys, everyJourneyAlarms: result.everyJourneyAlarms }, null, 2)}\n`);

  console.log(renderTrace(result));
  if (result.warnings.length) console.log(`\nWarnings (checked against .beads/issues.jsonl):\n${result.warnings.map((w) => `- ${w}`).join("\n")}`);
  if (problems.length) {
    console.error(`\nThe journeys don't trace:\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\nSee "Keeping this page current" in ${DOC}.`);
    return 1;
  }
  console.log(`\njourneys: ${plural(reg.journeys.length, "journey")}, ${plural(reg.journeys.reduce((n, j) => n + j.steps.length, 0), "step")}, all traced`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
