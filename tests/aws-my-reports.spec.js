// Your reports in the web build (src/aws/my-reports.js, supply-checkout-loxj): the team bar's button
// and the list it opens, GET /teams/{teamId}/feedback/mine, against the fake backend in
// tests/fake-aws.js. What the server returns, and to whom, is backend/test/feedback-api.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, modalViolations } from "./helpers.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

const MINE = "/teams/t1/feedback/mine";
// The modal's entrance animation would still be part-way when axe checks its contrast
test.use({ reducedMotion: "reduce" });

const dialog = (page) => page.locator("#modal");
const opener = (page, name = "Your reports") => page.locator(".teambar").getByRole("button", { name, exact: true });
const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const report = (n, fields = {}) => ({ id: `r${n}`, shortId: `r${n}`.padEnd(8, "0"), createdAt: `2026-10-0${n}T12:00:00.000Z`, category: "bug", summary: `Report ${n}`, status: "received", ...fields });

async function open(page, { teams, path = "/" } = {}) {
  const backend = new FakeBackend({ teams, docs: seeded() });
  await openAws(page, backend, { path });
  await connected(page);
  return backend;
}

test.describe("Your reports", () => {
  test("lists the reports with each one's status in plain words, and is accessible", async ({ page }) => {
    const backend = await open(page);
    backend.on("GET", MINE, {
      status: 200,
      body: {
        more: false,
        reports: [
          report(5, { summary: "The <b>scanner</b> froze", category: "idea" }),
          report(4, { status: "looking", category: "question" }),
          report(3, { status: "fixed", release: "1.21.0", resolvedAt: "2026-10-12T00:00:00.000Z" }),
          report(2, { status: "fixed" }),
          report(1, { status: "not_planned" }),
          report(6, { status: "something_new", category: "other" }),
        ],
      },
    });
    await opener(page).click();
    await expect(dialog(page).getByRole("heading", { name: "Your reports" })).toBeVisible();
    await expect(dialog(page)).toHaveAttribute("aria-labelledby", "myReportsTitle");
    const rows = dialog(page).locator(".my-report");
    await expect(rows).toHaveText([
      /The <b>scanner<\/b> froze\s+Oct 5, 2026 · Idea\s+Received/,
      /Report 4\s+Oct 4, 2026 · Question\s+Being looked at/,
      /Report 3\s+Oct 3, 2026 · Problem\s+Fixed in 1\.21\.0/,
      /Report 2\s+Oct 2, 2026 · Problem\s+Fixed\s*$/,
      /Report 1\s+Oct 1, 2026 · Problem\s+Not planned/,
      /Report 6\s+Oct 6, 2026 · other\s+Received/,
    ]);
    // Text is text, never markup; nothing internal is on the page
    await expect(dialog(page).locator(".my-report b")).toHaveCount(0);
    await expect(dialog(page)).not.toContainText(/dismiss|bead|reason/i);
    await expect(dialog(page).locator("#myReportsMore")).toHaveCount(0);
    expect(backend.requests("GET", MINE)).toHaveLength(1);
    expect(backend.requests("GET", MINE)[0].body).toBeNull();
    expect(await modalViolations(page)).toEqual([]);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    // Close returns the focus to the button
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(opener(page)).toBeFocused();
  });

  test("says so when there is nothing yet, and when only the newest are shown", async ({ page }) => {
    const backend = await open(page);
    backend.on("GET", MINE, { status: 200, body: { reports: [], more: false } });
    await opener(page).click();
    await expect(dialog(page).locator("#myReportsNone")).toContainText("You haven't reported anything in this team yet");
    await dialog(page).getByRole("button", { name: "Close" }).click();
    backend.on("GET", MINE, { status: 200, body: { reports: [report(1)], more: true } });
    await opener(page).click();
    await expect(dialog(page).locator(".my-report")).toHaveCount(1);
    await expect(dialog(page).locator("#myReportsMore")).toHaveText("Showing your newest reports.");
  });

  test("is there for a viewer too", async ({ page }) => {
    const backend = await open(page, { teams: [{ ...TEAM, role: "viewer" }] });
    backend.on("GET", MINE, { status: 200, body: { reports: [report(1, { status: "looking" })], more: false } });
    await opener(page).click();
    await expect(dialog(page).locator(".my-report")).toContainText("Being looked at");
  });

  test("shows a failure and tries again", async ({ page }) => {
    const backend = await open(page);
    backend.on("GET", MINE, { abort: true });
    backend.on("GET", MINE, { status: 200, body: { reports: [report(1)], more: false } });
    await opener(page).click();
    await expect(dialog(page).locator("#myReportsFail")).toHaveText("Couldn't load your reports. Check your connection and try again.");
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page).locator("#myReportsFail")).toBeHidden();
    await expect(dialog(page).locator(".my-report")).toHaveCount(1);
    expect(backend.requests("GET", MINE)).toHaveLength(2);
  });

  test("tells someone who is no longer in the team, with no retry", async ({ page }) => {
    const backend = await open(page);
    backend.on("GET", MINE, { status: 403, body: { error: { code: "permission_denied", message: "Not a member", reason: "not_member" } } });
    await opener(page).click();
    await expect(dialog(page).locator("#myReportsFail")).toContainText("You aren't in this team any more");
    await expect(dialog(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("speaks Spanish", async ({ page }) => {
    const backend = await open(page, { path: "/?lang=es" });
    backend.on("GET", MINE, {
      status: 200,
      body: { more: false, reports: [report(4, { status: "looking" }), report(3, { status: "fixed", release: "1.21.0" }), report(2, { status: "not_planned", category: "idea" }), report(1)] },
    });
    await opener(page, "Sus reportes").click();
    await expect(dialog(page).getByRole("heading", { name: "Sus reportes" })).toBeVisible();
    const rows = dialog(page).locator(".my-report");
    await expect(rows).toHaveText([/En revisión/, /Corregido en 1\.21\.0/, /No planeado/, /Recibido/]);
    await expect(rows.nth(2)).toContainText("Idea");
    await expect(rows.nth(3)).toContainText("Problema");
  });
});
