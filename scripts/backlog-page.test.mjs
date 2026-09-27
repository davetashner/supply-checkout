// Tests for scripts/backlog-page.mjs: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const script = new URL("./backlog-page.mjs", import.meta.url).pathname;
// Addresses built at runtime, so this file itself holds none
const at = (user) => `${user}@${"leaky"}.io`;
const bead = (id, fields) => ({
  id: `supply-checkout-${id}`, priority: 2, issue_type: "task", labels: ["mvp"], status: "open",
  description: "", acceptance_criteria: "", notes: "", created_at: "2026-09-01T10:00:00Z",
  owner: at("owner-person"), created_by: "Creator Person", assignee: "Assignee Person",
  ...fields,
});
const beads = {
  all: [
    bead("epic", { issue_type: "epic", title: "The epic", labels: [] }),
    bead("a", { title: "Ship it", parent: "supply-checkout-epic", status: "closed",
      closed_at: "2026-09-20T15:00:00Z", close_reason: "Completed in PR #148" }),
    bead("b", { title: "Doing it", parent: "supply-checkout-epic", status: "in_progress",
      notes: `ask ${at("notes-person")} </script> first` }),
    bead("c", { title: "Next one", parent: "supply-checkout-epic" }),
    bead("d", { title: "Waiting one", labels: ["phase-2"] }),
  ],
  ready: [{ id: "supply-checkout-c" }],
  blocked: [{ id: "supply-checkout-d", blocked_by: ["supply-checkout-c", "supply-checkout-gone"] }],
};

function generate() {
  const dir = mkdtempSync(join(tmpdir(), "backlog-page-"));
  writeFileSync(join(dir, "beads.json"), JSON.stringify(beads));
  const out = join(dir, "index.html");
  const log = execFileSync("node", [script, "--from-json", join(dir, "beads.json"), "--out", out], { encoding: "utf8" });
  return { log, out, html: readFileSync(out, "utf8") };
}

// Just enough DOM to run the page's script and read what it renders
function render(html) {
  const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: "", innerHTML: "", value: "", attrs: {}, dataset: {}, handlers: {},
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.handlers[t] = f; } });
    return els.get(id);
  };
  const tabs = ["upcoming", "done"].map((t) => Object.assign(el(`tab-${t}`), { dataset: { tab: t } }));
  const store = new Map();
  const context = {
    document: { getElementById: el, querySelectorAll: (s) => (s === ".tabs button" ? tabs : []) },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    location: { hash: "" },
  };
  vm.runInNewContext(code, context);
  return { el, click: (id) => el(id).handlers.click() };
}

test("writes the page and prints its path", () => {
  const { log, out } = generate();
  assert.match(log, /Wrote the backlog page \(5 beads\)/);
  assert.ok(log.includes(out));
});

test("never embeds owners, creators, assignees or email addresses", () => {
  const { html } = generate();
  for (const leak of ["owner-person", "Creator Person", "Assignee Person", "notes-person", "leaky", "created_by", '"owner"', '"assignee"']) {
    assert.ok(!html.includes(leak), `page contains ${leak}`);
  }
  assert.ok(html.includes("ask [email] \\u003c/script> first"), "masks emails and escapes < in the data");
});

test("renders the tabs, counts and stats", () => {
  const page = render(generate().html);
  assert.equal(page.el("n-upcoming").textContent, 3);
  assert.equal(page.el("n-done").textContent, 1);
  const stats = page.el("stats").innerHTML;
  for (const [n, label] of [[1, "Completed"], [1, "In progress"], [1, "Ready to start"], [1, "Waiting on others"]]) {
    assert.ok(stats.includes(`<b>${n}</b><span>${label}</span>`), `stat ${label}`);
  }
  assert.ok(stats.includes("<b>33%</b><span>MVP done · 1 of 3</span>"));
  assert.ok(page.el("epic").innerHTML.includes("The epic (1/3)"));

  const upcoming = page.el("view").innerHTML;
  assert.equal(page.el("tab-upcoming").attrs["aria-selected"], "true");
  assert.match(upcoming, /In progress <small>1/);
  assert.match(upcoming, /Next up <small>1/);
  assert.match(upcoming, /Blocked <small>1/);
  assert.ok(upcoming.includes("c Next one"), "lists the blocker that exists, and drops the unknown one");
  assert.ok(!upcoming.includes("gone"));

  page.click("tab-done");
  const done = page.el("view").innerHTML;
  assert.equal(page.el("tab-done").attrs["aria-selected"], "true");
  assert.ok(done.includes('href="https://github.com/davetashner/supply-checkout/pull/148"'));
  assert.ok(done.includes("Ship it"));
  assert.ok(!done.includes("Doing it"));
});
