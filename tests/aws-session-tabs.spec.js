// The web build's session across tabs and after it ends (src/aws/session.js, account.js):
// a tab open as one user when someone else signs in (or the user signs out) in another tab,
// an invite saved in a tab whose session ended, and saves refused once signed out.
import { test, expect, modal } from "./helpers.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, USER, openAws, connected, sockets, setVisible } from "./fake-aws.js";


const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const SAM = { id: "u-sam", email: "sam@example.com", emailVerified: true };
const account = (page) => page.locator("#account");
const changedScreen = (page) => account(page).getByRole("heading", { name: "Your account changed" });
const lists = (backend) => backend.requests("GET", "/teams/t1/projects").filter((r) => !r.query.cursor).length;
const bearer = (backend, token) => backend.calls.filter((c) => c.headers.authorization === "Bearer " + token);

// The app in another tab of the same browser: the same localStorage and refresh cookie
async function otherTab(page, backend) {
  const other = await page.context().newPage();
  backend.pageLoads = 0;
  await openAws(other, backend);
  return other;
}

async function openPat(page, backend = new FakeBackend({ docs: seeded() })) {
  await openAws(page, backend);
  await connected(page);
  await expect.poll(() => lists(backend)).toBe(2);
  return backend;
}

test.describe("another tab", { tag: ["@J0"] }, () => {
  test("someone else signing in stops this tab before it writes anything, then reloads it", async ({ page }) => {
    const backend = await openPat(page);
    // Pat is creating a project; the save is on its way when Sam signs in in another tab
    const release = backend.hold("PUT", /^\/teams\/t1\/projects\//);
    await page.getByRole("button", { name: "+ New project" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Pat's job");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect.poll(() => backend.requests("PUT", /^\/teams\/t1\/projects\//).length).toBe(1);

    backend.user = SAM;
    const other = await otherTab(page, backend);
    await connected(other);
    // Pat's tab stops: the app and the form are gone, live updates closed, and it reloads
    await expect(changedScreen(page)).toBeVisible();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(page.locator(".teambar")).toBeHidden();
    await expect.poll(() => backend.pageLoads).toBe(2);
    expect((await sockets(page)).every((s) => s.closed)).toBe(true);

    // The save already sent is answered 401 (the API's latest token is Sam's), or, in WebKit,
    // cancelled by the reload: either way Pat's tab doesn't refresh with the cookie, which is
    // Sam's now, or send anything again
    const refreshes = backend.requests("POST", "/auth/refresh").length;
    release();
    await expect(page.locator("#toast")).toBeVisible();
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(refreshes);
    expect(backend.requests("PUT", /^\/teams\/t1\/projects\//)).toHaveLength(1);
    expect(backend.docs.size).toBe(Object.keys(seeded()).length);
    // Nothing after the change went out with Pat's token
    const patCalls = bearer(backend, "at-1").length;
    await setVisible(page, true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect(bearer(backend, "at-1")).toHaveLength(patCalls);
    // Sam's tab has Sam's data only
    expect(await other.evaluate(() => localStorage.getItem("supplyCheckout.owner"))).toBe(SAM.id);
    await other.close();
  });

  test("other storage changes are ignored; signing out in another tab reloads this one", async ({ page }) => {
    const backend = await openPat(page);
    backend.shareTokens = true;
    await page.evaluate(() => { window.__storageEvents = 0; addEventListener("storage", () => window.__storageEvents++); });
    const other = await otherTab(page, backend);
    await connected(other);
    // The same user in the other tab: nothing changes here, even as it saves its own things
    await other.evaluate(() => localStorage.setItem("supplyCheckout.theme", "dark"));
    await expect.poll(() => page.evaluate(() => window.__storageEvents)).toBeGreaterThan(0);
    await expect(page.locator(".teambar")).toBeVisible();
    await expect(changedScreen(page)).toHaveCount(0);
    expect(backend.pageLoads).toBe(1);

    await other.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect(changedScreen(page)).toBeVisible();
    await expect.poll(() => backend.pageLoads).toBe(2);
    await other.close();
  });

  test("a refresh that answers after another tab signed someone else in is dropped", async ({ page }) => {
    const backend = await openPat(page);
    // A re-list's 401 starts a refresh, whose answer is held
    backend.on("GET", "/teams/t1/projects", { status: 401, body: { message: "Unauthorized" } });
    const release = backend.delay("POST", "/auth/refresh");
    await setVisible(page, true);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBe(2);
    // The held refresh was answered with this token, for Pat's tab
    const held = backend.token;

    backend.user = SAM;
    const other = await otherTab(page, backend);
    await connected(other);
    await expect(changedScreen(page)).toBeVisible();
    release();
    // Its token isn't taken up: the re-list isn't sent again with it
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBe(3);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect(bearer(backend, held)).toEqual([]);
    await other.close();
  });

  test("a team created as the other tab signs someone else in isn't opened", async ({ page }) => {
    const backend = new FakeBackend({ teams: [] });
    backend.shareTokens = true;
    await openAws(page, backend);
    const release = backend.hold("POST", "/teams");
    await page.getByLabel("Team name").fill("Pat's team");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect.poll(() => backend.requests("POST", "/teams").length).toBe(1);

    backend.user = SAM;
    const other = await otherTab(page, backend);
    await expect(other.getByRole("heading", { name: "Name your team" })).toBeVisible();
    await expect(changedScreen(page)).toBeVisible();
    release();
    await expect.poll(() => backend.teams.length).toBe(1);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    await expect(changedScreen(page)).toBeVisible();
    await expect(page.locator(".teambar")).toHaveCount(0);
    expect(backend.requests("GET", /^\/teams\/t-/)).toEqual([]);
    await other.close();
  });

  test("a team that fails to be created as the other tab signs someone else in says nothing", async ({ page }) => {
    const backend = new FakeBackend({ teams: [] });
    await openAws(page, backend);
    let release;
    const wait = new Promise((r) => { release = r; });
    backend.on("POST", "/teams", { wait, abort: true });
    await page.getByLabel("Team name").fill("Pat's team");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect.poll(() => backend.requests("POST", "/teams").length).toBe(1);

    backend.user = SAM;
    const other = await otherTab(page, backend);
    await expect(other.getByRole("heading", { name: "Name your team" })).toBeVisible();
    await expect(changedScreen(page)).toBeVisible();
    release();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    await expect(changedScreen(page)).toBeVisible();
    expect(backend.teams).toEqual([]);
    await other.close();
  });

  test("when last user's team can't be forgotten, the device isn't marked as the new user's", async ({ page }) => {
    await page.addInitScript(() => {
      const remove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) { if (key === "supplyCheckout.team") throw new DOMException("Blocked", "SecurityError"); return remove.call(this, key); };
    });
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": SAM.id, "supplyCheckout.team": "t1", "supplyCheckout.receiptDraft.t1": "{}" } } });
    await connected(page);
    // The draft went; the team key couldn't, so the mark goes too, and the next sign-in tries again
    expect(await page.evaluate(() => [localStorage.getItem("supplyCheckout.owner"), localStorage.getItem("supplyCheckout.receiptDraft.t1")])).toEqual([null, null]);
    // With no mark of this user's, there's nothing to watch
    await setVisible(page, true);
    await expect(page.locator(".teambar")).toBeVisible();
    expect(backend.pageLoads).toBe(1);
  });

  test("a receipt save that fails as someone else signs in doesn't write the draft back", async ({ page }) => {
    const line = { id: "l1", name: "Paper towels", raw: "", qty: 2, price: 8, dest: "stock", code: "", match: "SKU1", suggested: false, useName: "inv", usePrice: "receipt" };
    const draft = { store: "", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null, savePrices: true, by: "", dests: [{ id: "d1", projectId: "", client: "" }], lines: [line] };
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.receiptDraft.t1": JSON.stringify(draft) } } });
    await connected(page);
    await page.getByRole("button", { name: "Continue review" }).click();
    const release = backend.hold("PUT", "/teams/t1/products/SKU1");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => backend.requests("PUT", "/teams/t1/products/SKU1").length).toBe(1);

    backend.user = SAM;
    const other = await otherTab(page, backend);
    await connected(other);
    await expect(changedScreen(page)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.receiptDraft.t1"))).toBeNull();
    // The save fails (401, or cancelled by the reload), and Pat's draft isn't kept again
    release();
    await expect(page.locator("#toast")).toBeVisible();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect(await page.evaluate(() => [localStorage.getItem("supplyCheckout.receiptDraft.t1"), localStorage.getItem("supplyCheckout.owner")])).toEqual([null, SAM.id]);
    await other.close();
  });

  test("a refresh answered with someone else's tokens stops this tab, even when the other tab couldn't mark the device", async ({ page }) => {
    const backend = await openPat(page);
    // Sam signs in in another tab where the owner mark can't be changed
    backend.user = SAM;
    const other = await page.context().newPage();
    await other.addInitScript(() => {
      const { setItem, removeItem } = Storage.prototype;
      Storage.prototype.setItem = function (k, v) { if (k === "supplyCheckout.owner") throw new DOMException("Full", "QuotaExceededError"); return setItem.call(this, k, v); };
      Storage.prototype.removeItem = function (k) { if (k === "supplyCheckout.owner") throw new DOMException("Blocked", "SecurityError"); return removeItem.call(this, k); };
    });
    backend.pageLoads = 0;
    await openAws(other, backend);
    await connected(other);
    // The mark is still Pat's, so Pat's tab carries on...
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.owner"))).toBe(USER.id);
    await expect(page.locator(".teambar")).toBeVisible();
    // ...until a refresh (after a re-list's 401) answers with Sam's tokens
    backend.on("GET", "/teams/t1/projects", { status: 401, body: { message: "Unauthorized" } });
    const tokens = backend.tokens;
    await setVisible(page, true);
    await expect(changedScreen(page)).toBeVisible();
    await expect.poll(() => backend.pageLoads).toBe(2);
    // Sam's new token was never used here
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect(bearer(backend, `at-${tokens + 1}`)).toEqual([]);
    await other.close();
  });

  test("a change this tab missed is noticed when it's shown again", async ({ page }) => {
    const backend = await openPat(page);
    // As if Sam signed in while this page was in the back-forward cache
    await page.evaluate(() => { localStorage.setItem("supplyCheckout.owner", "u-sam"); dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    await expect(changedScreen(page)).toBeVisible();
    await expect.poll(() => backend.pageLoads).toBe(2);
  });
});

test.describe("signing out or deleting the account here", { tag: ["@J0"] }, () => {
  const hideAndShow = async (page) => { await setVisible(page, false); await setVisible(page, true); };

  test("switching away before Managed Login's sign-out loads doesn't reload over it", async ({ page }) => {
    const backend = await openPat(page);
    // A sign-out that fails leaves the mark watched
    backend.on("POST", "/auth/sign-out", { abort: true });
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#toast")).toHaveText("Couldn't sign out. Try again.");
    // One that goes through removes the mark; the tab is hidden and shown again before the
    // sign-out page loads, and nothing replaces the navigation to it
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(new URL(backend.authRequests[0]).pathname).toBe("/logout");
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.owner"))).toBeNull();
    await hideAndShow(page);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(changedScreen(page)).toHaveCount(0);
    expect(backend.pageLoads).toBe(1);
    expect(backend.authRequests).toHaveLength(1);
  });

  test("a failed sign-out keeps watching the mark", async ({ page }) => {
    const backend = await openPat(page);
    backend.on("POST", "/auth/sign-out", { abort: true });
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#toast")).toHaveText("Couldn't sign out. Try again.");
    await page.evaluate(() => localStorage.setItem("supplyCheckout.owner", "u-sam"));
    await setVisible(page, true);
    await expect(changedScreen(page)).toBeVisible();
    await expect.poll(() => backend.pageLoads).toBe(2);
  });

  test("switching away from the deleted screen leaves it and its sign-out link", async ({ page }) => {
    const backend = await openPat(page);
    await page.locator(".teambar").getByRole("button", { name: "Account" }).click();
    await modal(page).getByLabel("Type DELETE to confirm").fill("DELETE");
    await modal(page).getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.owner"))).toBeNull();
    await hideAndShow(page);
    await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    expect(backend.pageLoads).toBe(1);
    await page.getByRole("link", { name: "Done" }).click();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(new URL(backend.authRequests[0]).pathname).toBe("/logout");
    expect(backend.pageLoads).toBe(1);
  });
});

test.describe("a receipt draft", { tag: ["@J0"] }, () => {
  test("isn't kept once the owner mark isn't this user's, even before this tab has heard", async ({ page }) => {
    const line = { id: "l1", name: "Paper towels", raw: "", qty: 2, price: 8, dest: "stock", code: "", match: "SKU1", suggested: false, useName: "inv", usePrice: "receipt" };
    const draft = JSON.stringify({ store: "", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null, savePrices: true, by: "", dests: [{ id: "d1", projectId: "", client: "" }], lines: [line] });
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.receiptDraft.t1": draft } } });
    await connected(page);
    await page.getByRole("button", { name: "Continue review" }).click();
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("supplyCheckout.receiptDraft.t1")).savePrices);
    // Kept while the mark is Pat's
    await page.locator("#rSavePrices").uncheck();
    expect(await saved()).toBe(false);
    // Sam's sign-in changed the mark; this tab's storage event hasn't run yet
    await page.evaluate(() => localStorage.setItem("supplyCheckout.owner", "u-sam"));
    await page.locator("#rSavePrices").check();
    expect(await saved()).toBe(false);
  });
});

test.describe("an invite saved in this tab", { tag: ["@J0"] }, () => {
  const invited = { id: "i1", teamName: "Bravo Co", role: "contributor", expiresAt: "2026-10-03T12:00:00.000Z" };
  const savedInvite = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("supplyCheckout.invite")));

  test("is marked with the first user it's offered to", async ({ page }) => {
    await openAws(page, new FakeBackend({ teams: [], invites: [invited] }), { path: "/?invite=i1&token=tok" });
    await expect(account(page).getByRole("heading", { name: "Join Bravo Co" })).toBeVisible();
    expect(await savedInvite(page)).toEqual({ id: "i1", token: "tok", user: USER.id });
  });

  test("isn't offered to someone else who signs in after that user's session ended", async ({ page }) => {
    await openAws(page, new FakeBackend({ teams: [TEAM], docs: seeded() }), { storage: { session: { "supplyCheckout.invite": JSON.stringify({ id: "i1", token: "tok", user: SAM.id }) } } });
    await connected(page);
    await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
    expect(await savedInvite(page)).toBeNull();
  });

  test("is offered to someone else when it's one of their own invites", async ({ page }) => {
    await openAws(page, new FakeBackend({ teams: [], invites: [invited] }), { storage: { session: { "supplyCheckout.invite": JSON.stringify({ id: "i1", token: "tok", user: SAM.id }) } } });
    await expect(account(page).getByRole("heading", { name: "Join Bravo Co" })).toBeVisible();
    expect(await savedInvite(page)).toEqual({ id: "i1", token: "tok", user: USER.id });
  });
});

test.describe("after the session ends", { tag: ["@J0"] }, () => {
  test("a save says they're signed out, not to check the connection", async ({ page }) => {
    const backend = await openPat(page);
    backend.token = "expired";
    backend.signedIn = false;
    await page.getByRole("button", { name: "+ New project" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Too late");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator("#toast")).toHaveText("You're signed out, so that wasn't saved. Sign in, then make your change again.");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(modal(page).locator(".save-failed")).toHaveCount(0);
  });

  test("a burst's re-list still waiting isn't sent once the page stops", async ({ page }) => {
    await page.clock.install();
    // Leaving the team stops the page while the session goes on, so a re-list would reach the API
    const backend = await openPat(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }], docs: seeded(), members: { t1: [{ userId: "u-owner", email: "owner@example.com", role: "owner", joinedAt: "2026-09-01T12:00:00.000Z" }, { userId: USER.id, email: USER.email, role: "contributor", joinedAt: "2026-09-02T12:00:00.000Z" }] } }));
    await page.clock.pauseAt(new Date(Date.now() + 60e3));
    const products = () => backend.requests("GET", "/teams/t1/products").filter((r) => !r.query.cursor).length;
    // Eleven events: ten fetched, the eleventh held for a re-list
    await page.evaluate((evs) => evs.forEach((e) => window.__sockets.at(-1).event(e)),
      Array.from({ length: 11 }, (_, i) => ({ v: 1, teamId: "t1", collection: "products", id: `B${i}`, op: "put", version: 1 })));
    await expect.poll(() => backend.requests("GET", /^\/teams\/t1\/products\/./).length).toBe(10);
    const before = products();
    const leave = page.locator(".teambar").getByRole("button", { name: "Leave team" });
    await leave.click();
    await page.getByRole("button", { name: "Tap again to leave" }).click();
    await expect(account(page)).toContainText("You left Echo Cleaning.");
    await page.clock.runFor(5000);
    // A re-list would be on its way by now
    await page.waitForTimeout(500);
    expect(products()).toBe(before);
  });
});
