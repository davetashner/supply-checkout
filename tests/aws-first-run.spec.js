// The web build's first-run checklist (src/first-run.js, src/aws/account.js): after an owner
// names a new team, a short list gets the empty team ready, ticks itself off, and shows until
// it's finished or dismissed. Its progress is the team's, on the server (/me's `checklist` and
// PATCH /teams/{teamId}/checklist, supply-checkout-fs56), so it's the same on every device.
// Against the fake backend in tests/fake-aws.js.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const checklist = (page) => page.locator("#firstRun");
const modal = (page) => page.locator("#modal");
// What an earlier version kept on the device, for team t1
const KEY = "supplyCheckout.firstRun.t1";
const kept = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
// A team with a checklist under way, and its progress on the server
const started = (checklist = {}) => ({ ...TEAM, members: 1, checklist: { receipt: false, done: false, ...checklist } });
const progress = (backend) => backend.teams[0].checklist;
const patches = (backend, team = "t1") => backend.requests("PATCH", `/teams/${team}/checklist`).map((r) => r.body);
// A JPEG's first bytes, which the browser can't decode, so src/photo.js sends it as it is
const photo = { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("receipt photo")]) };
const receipt = { store: "Hardware Co", date: "2026-09-20", items: [{ raw: "PTR TAPE", name: "Painter's tape", qty: 2, price: 6.25, match: null }], subtotal: 12.5, tax: 0, total: 12.5 };

// Scans a receipt from the checklist's step (or, once it's done, the app's own Scan receipt),
// and saves its one line to storage
async function scanReceipt(page, fromChecklist = true) {
  if (fromChecklist) {
    const chooser = page.waitForEvent("filechooser");
    await checklist(page).locator("label[for=receiptFile]").click();
    await (await chooser).setFiles(photo);
  } else await page.setInputFiles("#receiptFile", photo);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
  await page.locator(".rline").first().getByLabel("For").selectOption("stock");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("2 added to storage");
}

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

// Names the team with Enter in the field, not a click on Create team: in Firefox, a click right
// after typing on a page that just opened sometimes loses its mousedown (the page gets the
// mousemove and mouseup, so no click and no POST /teams). Clicking the button is covered by
// "a new user names their team" in aws-account.spec.js.
async function createTeam(page, backend, name = "Bravo Co") {
  await openAws(page, backend);
  await page.getByLabel("Team name").fill(name);
  await page.getByLabel("Team name").press("Enter");
  await connected(page);
  return backend.teams[0].id;
}

test("a pasted team name loses its invisible direction and zero-width characters", { tag: ["@J1.3"] }, async ({ page }) => {
  // The API refuses them in a team name (supply-checkout-1dg.13)
  const backend = new FakeBackend({ teams: [] });
  await openAws(page, backend);
  await page.getByLabel("Team name").focus();
  await page.keyboard.insertText("Bravo \u202eoC\u202c\u200b");
  // Enter, as in createTeam
  await page.keyboard.press("Enter");
  await connected(page);
  expect(backend.teams[0].name).toBe("Bravo oC");
});

test("a new owner is guided through the checklist to a team ready to use", { tag: ["@J1.3"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [], receipt });
  const team = await createTeam(page, backend);
  const list = checklist(page);
  await expect(list.getByRole("heading", { name: "Get your team started" })).toBeVisible();
  await expect(list).toContainText("0 of 4 done");
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expectAccessible(page);
  expect(progress(backend)).toEqual({ receipt: false, done: false });
  // A new team has no other members, so the invite step asks the server about invites
  expect(backend.requests("GET", `/teams/${team}/invites`)).toHaveLength(1);

  // Supplies, by hand: the inventory opens with a new item
  await list.getByRole("button", { name: "Add an item" }).click();
  await expect(page.locator("#tab-prices")).toHaveAttribute("aria-pressed", "true");
  await modal(page).getByLabel("Item name").fill("Nitrile gloves");
  await modal(page).getByLabel("Price each ($)").fill("13");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(list).toContainText("1 of 4 done");
  await expect(list.getByRole("heading", { name: "Done: Add your supplies" })).toBeVisible();
  await expect(list.getByRole("button", { name: "Add an item" })).toHaveCount(0);

  // The crew, from the members screen: the team's invite is on the server, so nothing more is sent
  await list.getByRole("button", { name: "Invite people" }).click();
  await modal(page).getByLabel("Email").fill("sam@example.com");
  await modal(page).getByRole("button", { name: "Send invite" }).click();
  await expect(page.locator("#toast")).toHaveText("Invite sent to sam@example.com");
  await modal(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(list).toContainText("2 of 4 done");
  expect(patches(backend, team)).toEqual([]);

  // A receipt, saved to storage: the inventory shows, with the checklist above it
  await scanReceipt(page);
  await expect(page.locator("#tab-prices")).toHaveAttribute("aria-pressed", "true");
  await expect(list).toContainText("3 of 4 done");
  await expect(list.getByRole("heading", { name: "Done: Scan a receipt" })).toBeVisible();
  await expect.poll(() => progress(backend)).toEqual({ receipt: true, done: false });

  // A first project: it opens, and the checklist waits behind it
  await list.getByRole("button", { name: "Create a project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Foxtrot Dental");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator("#projectView")).toBeVisible();
  await expect(list).toBeHidden();
  await expect.poll(() => progress(backend)).toEqual({ receipt: true, done: true });
  await page.getByRole("button", { name: "← All projects" }).click();
  await expect(list.getByRole("heading", { name: "You're all set" })).toBeVisible();
  await expectAccessible(page);
  await list.getByRole("button", { name: "Close" }).click();
  await expect(list).toBeHidden();
  expect(patches(backend, team)).toEqual([{ receipt: true }, { done: true }, { done: true }]);
});

test("a finished or dismissed checklist stays away, on every device", { tag: ["@J1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started({ done: true })] });
  await openAws(page, backend);
  await connected(page);
  await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
  await expect(checklist(page)).toHaveCount(0);
  expect(backend.requests("GET", "/teams/t1/invites")).toHaveLength(0);
});

test("its progress is the team's: another device shows the same steps done", { tag: ["@J1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [{ ...started({ receipt: true }), members: 2 }] });
  await openAws(page, backend);
  await connected(page);
  const list = checklist(page);
  // The receipt saved elsewhere, and the crew: the team has another member, so no need to ask about invites
  await expect(list).toContainText("2 of 4 done");
  await expect(list.getByRole("heading", { name: "Done: Scan a receipt" })).toBeVisible();
  await expect(list.getByRole("heading", { name: "Done: Invite your crew" })).toBeVisible();
  expect(backend.requests("GET", "/teams/t1/invites")).toHaveLength(0);
});

const invite = (id, inviteStatus) => ({ id, email: `${id}@example.com`, role: "contributor", createdAt: "2026-09-20T12:00:00.000Z", expiresAt: "2026-09-27T12:00:00.000Z", inviteStatus, failureReason: inviteStatus === "failed" ? "bounced" : null, failedAt: null });

test("the invite step ticks for an invite still waiting, sent from another device", { tag: ["@J1", "@J3.1"] }, async ({ page }) => {
  await openAws(page, new FakeBackend({ teams: [started()], teamInvites: { t1: [invite("old", "expired"), invite("sam", "pending")] } }));
  await connected(page);
  await expect(checklist(page)).toContainText("1 of 4 done");
  await expect(checklist(page).getByRole("heading", { name: "Done: Invite your crew" })).toBeVisible();
});

test("the invite step doesn't tick for invites that expired or failed", { tag: ["@J1", "@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()], teamInvites: { t1: [invite("old", "expired"), invite("bad", "failed")] } });
  await openAws(page, backend);
  await connected(page);
  await expect.poll(() => backend.requests("GET", "/teams/t1/invites").length).toBe(1);
  await expect(checklist(page)).toContainText("0 of 4 done");
});

test("the invite step waits when the invites can't be read", { tag: ["@J1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()] });
  backend.on("GET", "/teams/t1/invites", { status: 500, body: { error: { code: "internal", message: "internal" } } });
  await openAws(page, backend);
  await connected(page);
  await expect(checklist(page)).toContainText("0 of 4 done");
});

test("the checklist offers the CSV import with its template, and fits a phone in dark mode", { tag: ["@J1", "@J2.4"] }, async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ colorScheme: "dark" });
  const backend = new FakeBackend({ teams: [] });
  await createTeam(page, backend, "A team with a rather long name for a small screen");
  const list = checklist(page);
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expectAccessible(page);
  await list.getByRole("button", { name: "Import a CSV file" }).click();
  await expect(modal(page).getByRole("heading", { name: "Import inventory" })).toBeVisible();
  const download = page.waitForEvent("download");
  await modal(page).getByRole("button", { name: "Download a template" }).click();
  expect((await download).suggestedFilename()).toBe("inventory-template.csv");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(list).toContainText("0 of 4 done");
});

test("a team with only older projects, not loaded at start, has its first project", { tag: ["@J1"] }, async ({ page }) => {
  // The page lists recent projects only (supply-checkout-1dg.11); one more request says there are older ones
  const backend = new FakeBackend({ teams: [started()], docs: { "t1/projects/old": { client: "Oldfield Co", date: "2019-05-01", status: "closed", items: {} } } });
  await openAws(page, backend);
  await connected(page);
  await expect(checklist(page)).toContainText("1 of 4 done");
  await expect(checklist(page).getByRole("heading", { name: "Done: Create your first project" })).toBeVisible();
  expect(backend.requests("GET", "/teams/t1/projects").some((r) => r.query.limit === "1")).toBe(true);
});

test("dismissing it is kept for the team, on the server", { tag: ["@J1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()] });
  await openAws(page, backend);
  await connected(page);
  const list = checklist(page);
  await expect(list).toContainText("0 of 4 done");
  // A tap on its text does nothing
  await list.getByText("Invite the people who take supplies to jobs.").click();
  await expect(page.locator("#overlay")).toBeHidden();
  // Not over a project or a receipt: only the project list and inventory
  await page.locator("#tab-prices").click();
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: "Dismiss the getting started checklist" }).click();
  await expect(list).toBeHidden();
  await expect.poll(() => progress(backend)).toEqual({ receipt: false, done: true });
  await page.locator("#tab-projects").click();
  await expect(list).toBeHidden();
  // And on the next load, on any device: another page, with what the server now has
  const other = await page.context().newPage();
  await openAws(other, new FakeBackend({ teams: backend.teams }));
  await connected(other);
  await expect(other.locator(".teambar")).toContainText("Team: Echo Cleaning");
  await expect(checklist(other)).toHaveCount(0);
  await other.close();
});

test("a dismissal the server didn't take still hides it on this page", { tag: ["@J1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()] });
  backend.on("PATCH", "/teams/t1/checklist", { status: 500, body: { error: { code: "internal", message: "internal" } } });
  await openAws(page, backend);
  await connected(page);
  await checklist(page).getByRole("button", { name: "Dismiss the getting started checklist" }).click();
  await expect(checklist(page)).toBeHidden();
  await expect.poll(() => patches(backend)).toEqual([{ done: true }]);
  expect(progress(backend)).toEqual({ receipt: false, done: false });
});

test("a second receipt doesn't send the step again", { tag: ["@J1", "@J5"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()], receipt });
  await openAws(page, backend);
  await connected(page);
  await scanReceipt(page);
  await expect.poll(() => progress(backend)).toEqual({ receipt: true, done: false });
  await scanReceipt(page, false);
  expect(patches(backend)).toEqual([{ receipt: true }]);
});

test("an invite sent from the team bar's Members ticks the step too", { tag: ["@J1", "@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()] });
  await openAws(page, backend);
  await connected(page);
  await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
  await modal(page).getByLabel("Email").fill("sam@example.com");
  await modal(page).getByRole("button", { name: "Send invite" }).click();
  await expect(page.locator("#toast")).toHaveText("Invite sent to sam@example.com");
  // Another: the step is already ticked
  await modal(page).getByLabel("Email").fill("lee@example.com");
  await modal(page).getByRole("button", { name: "Send invite" }).click();
  await expect(page.locator("#toast")).toHaveText("Invite sent to lee@example.com");
  await modal(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(checklist(page)).toContainText("1 of 4 done");
  await expect(checklist(page).getByRole("heading", { name: "Done: Invite your crew" })).toBeVisible();
});

for (const [what, team] of [
  ["a contributor", { ...started(), role: "contributor" }],
  ["the owner of a closed team", { ...started(), closedAt: "2026-09-01T12:00:00.000Z", deletesAt: "2026-10-01T12:00:00.000Z" }],
]) {
  test(`${what} doesn't see it, even with one started`, { tag: ["@J1"] }, async ({ page }) => {
    await openAws(page, new FakeBackend({ teams: [team] }));
    await connected(page);
    await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
    await expect(checklist(page)).toHaveCount(0);
  });
}

test("it hides when a write is refused because another owner closed the team meanwhile", { tag: ["@J1"] }, async ({ page }) => {
  const backend = new FakeBackend({ teams: [started()] });
  await openAws(page, backend);
  await connected(page);
  await expect(checklist(page).getByRole("button", { name: "Invite people" })).toBeVisible();
  const before = backend.requests("GET", "/me").length;
  backend.teams[0] = { ...backend.teams[0], closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" };
  backend.on("PUT", /^\/teams\/t1\/projects\//, { status: 403, body: { error: { code: "permission_denied", message: "permission_denied", reason: "team_closed" } } });
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Delta");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator("#notice")).toHaveText("This team is closed, so nothing in it can be changed.");
  await expect.poll(() => backend.requests("GET", "/me").length).toBe(before + 1);
  await expect(page.locator(".teambar .closed-note")).toBeVisible();
  await expect(checklist(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Invite people" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import a CSV file" })).toHaveCount(0);
  // Its progress is kept, so it's back if the team is reopened
  expect(patches(backend)).toEqual([]);
  expect(progress(backend)).toEqual({ receipt: false, done: false });
});

test("an owner's existing team that never had one doesn't get one", { tag: ["@J1"] }, async ({ page }) => {
  await openAws(page, new FakeBackend());
  await connected(page);
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
});

test.describe("a checklist an earlier version kept on this device", () => {
  test("is started on the server with its progress, and forgotten here", { tag: ["@J1"] }, async ({ page }) => {
    const backend = new FakeBackend();
    await openAws(page, backend, { storage: { local: { [KEY]: JSON.stringify({ invited: true, receipt: true }) } } });
    await connected(page);
    await expect(checklist(page)).toContainText("1 of 4 done");
    await expect(checklist(page).getByRole("heading", { name: "Done: Scan a receipt" })).toBeVisible();
    await expect.poll(() => kept(page)).toBeNull();
    expect(patches(backend)).toEqual([{ started: true, receipt: true }]);
    expect(progress(backend)).toEqual({ receipt: true, done: false });
  });

  test("with nothing done yet, is started on the server too", { tag: ["@J1"] }, async ({ page }) => {
    const backend = new FakeBackend();
    await openAws(page, backend, { storage: { local: { [KEY]: "{}" } } });
    await connected(page);
    await expect(checklist(page)).toContainText("0 of 4 done");
    await expect.poll(() => patches(backend)).toEqual([{ started: true }]);
  });

  test("stays here if the server didn't take it, to try again next time", { tag: ["@J1"] }, async ({ page }) => {
    const backend = new FakeBackend();
    backend.on("PATCH", "/teams/t1/checklist", { status: 500, body: { error: { code: "internal", message: "internal" } } });
    await openAws(page, backend, { storage: { local: { [KEY]: "{}" } } });
    await connected(page);
    await expect(checklist(page)).toContainText("0 of 4 done");
    await expect.poll(() => patches(backend)).toEqual([{ started: true }]);
    expect(await kept(page)).toBe("{}");
  });

  for (const [what, team, state] of [
    ["finished or dismissed", TEAM, { done: true }],
    ["the server's checklist wins over", started({ done: true }), { receipt: true }],
  ]) {
    test(`is forgotten when ${what}`, { tag: ["@J1"] }, async ({ page }) => {
      const backend = new FakeBackend({ teams: [team] });
      await openAws(page, backend, { storage: { local: { [KEY]: JSON.stringify(state) } } });
      await connected(page);
      await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
      await expect(checklist(page)).toHaveCount(0);
      expect(await kept(page)).toBeNull();
      expect(patches(backend)).toEqual([]);
    });
  }
});

test("a new team gets the checklist even when storage is blocked", { tag: ["@J1"] }, async ({ page }) => {
  await page.addInitScript(() => {
    for (const m of ["getItem", "setItem"]) {
      const real = Storage.prototype[m];
      Storage.prototype[m] = function (...args) {
        if (this === window.localStorage) throw new DOMException("Blocked", "SecurityError");
        return real.apply(this, args);
      };
    }
  });
  const backend = new FakeBackend({ teams: [] });
  await createTeam(page, backend);
  await expect(checklist(page)).toContainText("0 of 4 done");
});
