// Your own name on Account in the web build (supply-checkout-bt3g, src/aws/name.js): setting,
// changing and clearing your first and last name, which then shows on the team bar, against the
// fake backend in tests/fake-aws.js, which keeps it in the ID token's claims as Cognito does. The
// server's side (the checks, Cognito, the member items) is tested in backend/.
import { test, expect, modalViolations } from "./helpers.js";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const dialog = (page) => page.locator("#modal");
const chip = (page) => page.locator("#accountOpen");
const first = (page) => dialog(page).getByLabel("First name");
const last = (page) => dialog(page).getByLabel("Last name");
const save = (page) => dialog(page).getByRole("button", { name: "Save name" });
const fail = (page) => page.locator("#nameFail");
const puts = (backend) => backend.requests("PUT", "/me/name").map((c) => c.body);
const refreshes = (backend) => backend.requests("POST", "/auth/refresh").length;

async function open(page, options) {
  const backend = new FakeBackend(options);
  await openAws(page, backend);
  await connected(page);
  return backend;
}
async function openAccount(page) {
  await chip(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Name", exact: true })).toBeVisible();
}

test("an account with no name sets one, and the team bar shows it instead of the email", async ({ page }) => {
  const backend = await open(page, { claims: { email: USER.email } });
  await expect(chip(page).locator(".who-name")).toHaveText(USER.email);
  await openAccount(page);
  await expect(first(page)).toHaveValue("");
  await expect(last(page)).toHaveValue("");
  expect(await modalViolations(page)).toEqual([]);
  const before = refreshes(backend);
  await first(page).fill("Jo");
  await last(page).fill("Park");
  await save(page).click();
  await expect(page.locator("#toast")).toHaveText("Your name is saved");
  expect(puts(backend)).toEqual([{ givenName: "Jo", familyName: "Park" }]);
  // New tokens, so the ID token carries the name
  expect(refreshes(backend)).toBeGreaterThan(before);
  await expect(chip(page).locator(".who-name")).toHaveText("Jo Park");
  await expect(chip(page)).toHaveAttribute("aria-label", "Signed in as Jo Park, Owner. Account");
  await expect(save(page)).toBeEnabled();
  // The chip drawn again still opens Account, with the saved name
  await page.keyboard.press("Escape");
  await openAccount(page);
  await expect(first(page)).toHaveValue("Jo");
  await expect(last(page)).toHaveValue("Park");
});

test("changes the name, trimmed and with pasted invisible characters left out", async ({ page }) => {
  const backend = await open(page);
  await expect(chip(page).locator(".who-name")).toHaveText("Pat Lee");
  await openAccount(page);
  await expect(first(page)).toHaveValue("Pat");
  await expect(last(page)).toHaveValue("Lee");
  await first(page).fill("  Patricia​ ");
  await save(page).click();
  await expect(chip(page).locator(".who-name")).toHaveText("Patricia Lee");
  expect(puts(backend)).toEqual([{ givenName: "Patricia", familyName: "Lee" }]);
  await expect(first(page)).toHaveValue("Patricia");
});

test("clears the name: the team bar shows the email again", async ({ page }) => {
  const backend = await open(page);
  await openAccount(page);
  await first(page).fill("");
  await last(page).fill(" ");
  await save(page).click();
  await expect(page.locator("#toast")).toHaveText("Your name is cleared");
  expect(puts(backend)).toEqual([{ givenName: "", familyName: "" }]);
  await expect(chip(page).locator(".who-name")).toHaveText(USER.email);
});

test("refuses a name over 100 characters before sending it, and says why the API refused one", async ({ page }) => {
  const backend = await open(page);
  await openAccount(page);
  await first(page).fill("a".repeat(60));
  await last(page).fill("b".repeat(60));
  await save(page).click();
  await expect(fail(page)).toHaveText("Enter a first and last name of up to 100 characters together.");
  expect(puts(backend)).toEqual([]);
  // The API's own refusal says the same
  backend.on("PUT", "/me/name", { status: 400, body: { error: { code: "bad_request", message: "bad_request", reason: "name_invalid" } } });
  await last(page).fill("Lee");
  await save(page).click();
  await expect(fail(page)).toHaveText("Enter a first and last name of up to 100 characters together.");
  await expect(save(page)).toBeEnabled();
  await expect(chip(page).locator(".who-name")).toHaveText("Pat Lee");
  // Anything else: try again
  backend.on("PUT", "/me/name", { status: 500, body: { error: { code: "internal", message: "internal" } } });
  await save(page).click();
  await expect(fail(page)).toHaveText("Couldn't save your name. Check your connection and try again.");
  // And then it works, and the message goes
  await first(page).fill("Pat");
  await save(page).click();
  await expect(fail(page)).toBeHidden();
  await expect(chip(page).locator(".who-name")).toHaveText("Pat Lee");
});

test("tells a Google or Apple user their provider may set it back", async ({ page }) => {
  await open(page, { user: { ...USER, mfa: "provider" } });
  await openAccount(page);
  await expect(page.locator("#nameHint")).toContainText("Signing in with Google or Apple may set it back");
});

test("a session that ends while the name is saved goes to sign-in, and nothing breaks", async ({ page }) => {
  const backend = await open(page);
  await openAccount(page);
  backend.on("POST", "/auth/refresh", { status: 401, body: { error: { code: "unauthenticated", message: "unauthenticated" } } });
  await first(page).fill("Jo");
  await save(page).click();
  await expect(page.locator("#signIn")).toBeVisible();
  expect(puts(backend)).toEqual([{ givenName: "Jo", familyName: "Lee" }]);
});

test("before a team is open, Account sets the name too", async ({ page }) => {
  const backend = new FakeBackend({ teams: [] });
  await openAws(page, backend);
  await expect(page.getByRole("heading", { name: "Name your team" })).toBeVisible();
  await page.locator("#accountDelete").click();
  await first(page).fill("Jo");
  await save(page).click();
  await expect(page.locator("#toast")).toHaveText("Your name is saved");
  expect(puts(backend)).toEqual([{ givenName: "Jo", familyName: "Lee" }]);
  expect(backend.claims.given_name).toBe("Jo");
});

test("fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  await openAccount(page);
  const [a, b] = await Promise.all([first(page).boundingBox(), last(page).boundingBox()]);
  // One above the other
  expect(b.y).toBeGreaterThan(a.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
