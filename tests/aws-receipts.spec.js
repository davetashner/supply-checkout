// The web build's receipt reading (src/aws/receipts.js): "Scan receipt" sends the photo to
// POST /teams/{teamId}/receipts/read (ADR 0008), against the fake backend in
// tests/fake-aws.js, and the app's review reads what comes back. The server's side is
// backend/test/receipts-api.test.ts.
import { test, expect, modal, modalViolations } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");

const READ = "/teams/t1/receipts/read";
const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
// A JPEG's first bytes, which the browser can't decode, so src/photo.js sends it as it is
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("receipt photo")]);
const photo = { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: JPEG };
// The server answers `match` with product keys, which the model can't invent: anything else is no match
const receipt = {
  store: "Hardware Co",
  date: "2026-09-20",
  items: [
    { raw: "STRG BIN 12QT", name: "Sterilite 12 qt storage bin", qty: 4, price: 5.5, match: "nb-bins" },
    { raw: "PTR TAPE 1.88", name: "Painter's tape, 1.88 in", qty: 2, price: 6.25, match: null },
    { raw: "MOP", name: "Mop heads", qty: 1, price: 4, match: "i1" },
  ],
  subtotal: 34.5, tax: 2.4, total: 36.9,
};
const line = (page, i) => page.locator(".rline").nth(i);
const failure = (page) => page.locator("#rBody .reading");
const left = (page) => page.locator("#receiptsLeft");
const USAGE = "/teams/t1/receipts/usage";

async function scan(page, backend, file = photo) {
  await openAws(page, backend);
  await connected(page);
  await page.setInputFiles("#receiptFile", file);
}

test.describe("reading a receipt on the receipt endpoint", { tag: ["@J5", "@J5.1", "@J5.2"] }, () => {
  test("sends only the photo, and reviews the lines with the server's product keys as matches", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    await scan(page, backend);
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    const [call] = backend.requests("POST", READ);
    // The photo as base64, with its type, and nothing else: the server builds the prompt
    expect(call.body).toEqual({ image: { mediaType: "image/jpeg", data: JPEG.toString("base64") } });
    expect(call.headers.authorization).toMatch(/^Bearer at-/);
    await expect(page.locator("#rBody .meta")).toContainText("Hardware Co");
    await expect(page.locator(".rline")).toHaveCount(3);
    // A key of the team's product is a suggested match; null, or anything that isn't a product key, is none
    await expect(line(page, 0)).toContainText("Suggested match, please check");
    await expect(line(page, 0).locator('select[data-f="match"]')).toHaveValue("nb-bins");
    await expect(line(page, 1).locator('select[data-f="match"]')).toHaveValue("");
    await expect(line(page, 2).locator('select[data-f="match"]')).toHaveValue("");
    await expect(line(page, 2)).not.toContainText("Suggested match");
  });

  test("shows the model's text as text, never as markup, in the review and in inventory", { tag: ["@J5.3"] }, async ({ page }) => {
    const html = '<img src=x onerror="window.__pwned=1">Bins';
    const backend = new FakeBackend({
      docs: seeded(),
      receipt: { ...receipt, store: "<b>Shop</b>", items: [{ raw: "<script>window.__pwned=2</script>", name: html, qty: 1, price: 2, match: null }] },
    });
    await scan(page, backend);
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await expect(page.locator("#rBody .meta")).toContainText("<b>Shop</b>");
    await expect(line(page, 0)).toContainText("Receipt: <script>window.__pwned=2</script>");
    await expect(line(page, 0).locator('input[data-f="name"]')).toHaveValue(html);
    expect(await page.locator("#rBody img, #rBody b, #rBody script").count()).toBe(0);
    await line(page, 0).getByLabel("For").selectOption("stock");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast")).toHaveText("1 added to storage");
    const put = backend.requests("PUT", /^\/teams\/t1\/products\/nb-/)[0];
    expect(put.body.data.name).toBe(html);
    await page.getByRole("button", { name: "Inventory" }).click();
    await expect(page.locator("#main")).toContainText(html);
    expect(await page.locator("#main img").count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test("says when the team has read all its receipts this month", { tag: ["@J5.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt, receiptLimit: 1 });
    await scan(page, backend);
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await page.getByRole("button", { name: "← All sheets" }).click();
    await page.setInputFiles("#receiptFile", photo);
    await expect(failure(page)).toContainText("Your team has read all the receipts included this month. Enter the items by hand, or ask an owner about your plan.");
    expect(backend.requests("POST", READ)).toHaveLength(2);
    // Typing the items in still works
    await page.getByRole("button", { name: "Enter items by hand" }).click();
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    // What's left was read again: none
    await page.getByRole("button", { name: "← All sheets" }).click();
    await expect(left(page)).toHaveText("No receipt scans left this month");
  });

  for (const [what, status, error, message] of [
    ["the model took too long", 504, { code: "unavailable", reason: "model_timeout" }, "Reading the receipt took too long. Try again, or take a sharper photo."],
    ["the model's reply couldn't be used", 502, { code: "internal", reason: "invalid_output" }, "The receipt couldn't be read cleanly. Try again, or take a sharper photo."],
    ["the model is busy", 429, { code: "quota_exceeded", reason: "model_busy" }, "Too many requests right now. Wait a minute and try again."],
    ["the model service refused the photo", 400, { code: "bad_request", reason: "image_rejected" }, "That image couldn't be used. Try a JPEG or PNG photo."],
    ["the model service is down", 503, { code: "unavailable" }, "Reading the receipt failed. Check your connection and try again."],
  ]) {
    test(`says so when ${what}`, { tag: ["@J5.1"] }, async ({ page }) => {
      const backend = new FakeBackend({ docs: seeded(), receipt });
      backend.on("POST", READ, { status, body: { error: { message: "from the server", ...error } } });
      await scan(page, backend);
      await expect(failure(page)).toContainText("Couldn't read that receipt");
      await expect(failure(page)).toContainText(message);
    });
  }

  test("says to sign in again when the session ended", { tag: ["@J5.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    // Refused, and refused again after the refresh
    backend.on("POST", READ, { status: 401, body: { message: "Unauthorized" } }, 2);
    await scan(page, backend);
    await expect(failure(page)).toContainText("Your sign-in expired. Reload the page and sign in again.");
  });

  test("refuses a photo the endpoint can't take without sending it", { tag: ["@J5.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    await scan(page, backend, { name: "IMG_0001.heic", mimeType: "image/heic", buffer: Buffer.from("not a jpeg") });
    await expect(failure(page)).toContainText("That image couldn't be used. Try a JPEG or PNG photo.");
    // Over 1.5 MB (a photo the browser couldn't shrink)
    await page.getByRole("button", { name: "← All sheets" }).click();
    await page.setInputFiles("#receiptFile", { ...photo, buffer: Buffer.concat([JPEG, Buffer.alloc(1_500_001)]) });
    await expect(failure(page)).toContainText("That image couldn't be used. Try a JPEG or PNG photo.");
    expect(backend.requests("POST", READ)).toEqual([]);
  });

  test("Stop cancels the request and goes back", { tag: ["@J5.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    const release = backend.hold("POST", READ);
    await scan(page, backend);
    await expect(page.getByRole("heading", { name: "Reading receipt…" })).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("heading", { name: "Reading receipt…" })).toHaveCount(0);
    await expect(page.getByText("Scan receipt")).toBeVisible();
    release();
  });

  test("Stop while the photo is still being read sends nothing", { tag: ["@J5.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    // Holds the photo step (src/aws/receipts.js reads the photo's bytes) until the test lets it go
    await page.addInitScript(() => {
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        return new Promise((resolve) => { window.__releasePhoto = () => resolve(read.call(this)); });
      };
    });
    await scan(page, backend);
    await expect(page.getByRole("heading", { name: "Reading receipt…" })).toBeVisible();
    await page.waitForFunction(() => typeof window.__releasePhoto === "function");
    await page.getByRole("button", { name: "Stop" }).click();
    // The photo step finishes, finds it was stopped, and goes back without a request
    await page.evaluate(() => window.__releasePhoto());
    await expect(page.getByRole("heading", { name: "Reading receipt…" })).toHaveCount(0);
    await expect(page.getByText("Scan receipt")).toBeVisible();
    await page.waitForTimeout(200);
    expect(backend.requests("POST", READ)).toEqual([]);
    expect(backend.receiptsRead).toEqual({});
  });

  test("Stop while the session is being refreshed doesn't send the read again", { tag: ["@J5.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    // The first try finds the token expired; the refresh waits
    backend.on("POST", READ, { status: 401, body: { message: "Unauthorized" } });
    await openAws(page, backend);
    await connected(page);
    const release = backend.hold("POST", "/auth/refresh");
    await page.setInputFiles("#receiptFile", photo);
    await expect.poll(() => backend.requests("POST", READ).length).toBe(1);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBe(2);
    await page.getByRole("button", { name: "Stop" }).click();
    release();
    await expect(page.getByRole("heading", { name: "Reading receipt…" })).toHaveCount(0);
    await expect(page.getByText("Scan receipt")).toBeVisible();
    await page.waitForTimeout(200);
    expect(backend.requests("POST", READ)).toHaveLength(1);
    expect(backend.receiptsRead).toEqual({});
    await expect(page.getByRole("heading", { name: "Review receipt" })).toHaveCount(0);
  });

  test("isn't offered to a viewer", { tag: ["@J9"] }, async ({ page }) => {
    await openAws(page, new FakeBackend({ docs: seeded(), teams: [{ ...TEAM, role: "viewer" }] }));
    await connected(page);
    await expect(page.locator("#main")).toBeVisible();
    await expect(page.getByText("Scan receipt")).toHaveCount(0);
    await expect(left(page)).toHaveCount(0);
  });
});

// supply-checkout-wxx: each team's allowance (a month's while it pays, its trial's while it
// doesn't) and each person's rate limit, as backend/src/data/usage.ts counts them
test.describe("receipt scans left, and the limits", { tag: ["@J5", "@J5.1"] }, () => {
  test("shows the scans left under the bar, and counts each read", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    await openAws(page, backend);
    await connected(page);
    await expect(left(page)).toHaveText("200 of 200 receipt scans left this month");
    // On a phone too, it fits the width
    const box = await left(page).boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    await page.setInputFiles("#receiptFile", photo);
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await page.getByRole("button", { name: "← All sheets" }).click();
    // From the read's own answer: no second request
    await expect(left(page)).toHaveText("199 of 200 receipt scans left this month");
    expect(backend.requests("GET", USAGE)).toHaveLength(1);
  });

  test("says when a trial's scans are used up, with how to get more", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt, receiptLimit: 1, receiptPeriod: "trial" });
    await openAws(page, backend);
    await connected(page);
    await expect(left(page)).toHaveText("1 of 1 free trial receipt scans left");
    await page.setInputFiles("#receiptFile", photo);
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await page.getByRole("button", { name: "← All sheets" }).click();
    await expect(left(page)).toHaveText("No free trial receipt scans left. An owner can subscribe to scan more.");
    await page.setInputFiles("#receiptFile", photo);
    await expect(failure(page)).toContainText("Your team has used all the receipt scans included in its free trial. Enter the items by hand, or ask an owner to subscribe to keep scanning receipts.");
  });

  for (const [what, message] of [
    ["the person has read a lot in a short time", "You've read a lot of receipts in a short time. Try again in 3 minutes, or enter the items by hand."],
    ["today's free trial scans are used up", "You've used today's free trial receipt scans; more tomorrow. Enter the items by hand, or ask an owner to subscribe."],
  ]) {
    test(`says how long to wait when ${what}`, async ({ page }) => {
      const backend = new FakeBackend({ docs: seeded(), receipt });
      // The server's words say how long, from the Retry-After it also sends
      backend.on("POST", READ, { status: 429, body: { error: { code: "quota_exceeded", reason: "rate_limited", message } } });
      await scan(page, backend);
      await expect(failure(page)).toContainText("Couldn't read that receipt");
      await expect(failure(page)).toContainText(message);
      // Not counted against the team
      await page.getByRole("button", { name: "← All sheets" }).click();
      await expect(left(page)).toHaveText("200 of 200 receipt scans left this month");
    });
  }

  test("still scans when the scans left can't be read", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    backend.on("GET", USAGE, { status: 503, body: { error: { code: "unavailable", message: "down" } } });
    await scan(page, backend);
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await page.getByRole("button", { name: "← All sheets" }).click();
    // The read's answer had them
    await expect(left(page)).toHaveText("199 of 200 receipt scans left this month");
  });

  test("shows owners the scans used in Team settings", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), receipt });
    backend.receiptsRead.t1 = 12;
    await openAws(page, backend);
    await connected(page);
    const settings = page.locator(".teambar").getByRole("button", { name: "Team settings" });
    await settings.click();
    await expect(modal(page).locator("#receiptUsage")).toHaveText("Receipt scans: 12 of 200 used this month (188 left). The count starts again on the 1st (UTC).");
    expect(await modalViolations(page)).toEqual([]);
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // A trial's, in all
    backend.receiptPeriod = "trial";
    backend.receiptLimit = 25;
    await settings.click();
    await expect(modal(page).locator("#receiptUsage")).toHaveText("Receipt scans: 12 of the 25 in your free trial used (13 left). A subscription includes more each month.");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // And when they can't be read, the markup still can
    backend.on("GET", USAGE, { status: 503, body: { error: { code: "unavailable", message: "down" } } });
    await settings.click();
    await expect(modal(page).locator("#receiptUsage")).toHaveText("Receipt scans: couldn't load what's left. Open the settings again to retry.");
    await expect(modal(page).getByLabel("Markup on company equipment bought for a client (%)")).toHaveValue("0");
  });
});
