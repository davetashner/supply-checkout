// Report an issue in the web build (src/aws/report.js, supply-checkout-bmsh.2): the team bar's
// button and the dialog it opens, sending POST /teams/{teamId}/feedback with an Idempotency-Key,
// and what the person sees when it fails, against the fake backend in tests/fake-aws.js. The
// server's side (limits, storage, who may report) is backend/test/feedback-api.test.ts.
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, modalViolations } from "./helpers.js";
import { goToInventory, openProject } from "./ui/index.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const FEEDBACK = "/teams/t1/feedback";
const KEY = /^[A-Za-z0-9_-]{8,128}$/;
// The modal's entrance animation would still be part-way when axe checks its contrast
test.use({ reducedMotion: "reduce" });

const dialog = (page) => page.locator("#modal");
const bar = (page) => page.locator(".teambar");
const opener = (page) => bar(page).getByRole("button", { name: "Report an issue" });
const message = (page) => dialog(page).getByLabel("What happened");
const expected = (page) => dialog(page).getByLabel("What did you expect?");
const sendButton = (page) => dialog(page).getByRole("button", { name: /^(Send report|Try again)$/ });
const summary = (page) => dialog(page).locator("#reportError");
const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const family = { chromium: "chrome", webkit: "safari", firefox: "firefox" };

async function open(page, opts = {}) {
  const backend = opts.backend || new FakeBackend({ docs: seeded() });
  await openAws(page, backend);
  await connected(page);
  return backend;
}
async function openDialog(page) {
  await opener(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Report an issue" })).toBeVisible();
}
async function fill(page, text = "The Add button does nothing on the receipt page.") {
  await message(page).fill(text);
}

test.describe("Report an issue", () => {
  test("opens from the team bar with its controls labelled, counted and accessible", async ({ page }) => {
    await open(page);
    await openDialog(page);
    await expect(dialog(page)).toHaveAttribute("aria-labelledby", "reportTitle");
    await expect(message(page)).toBeFocused();
    // The three kinds, the first chosen
    const kinds = dialog(page).getByRole("group", { name: "What kind of report is this?" });
    await expect(kinds.getByRole("radio")).toHaveCount(3);
    await expect(kinds.getByRole("radio", { name: "Something is broken" })).toBeChecked();
    await expect(kinds.getByRole("radio", { name: "I have an idea" })).not.toBeChecked();
    await expect(kinds.getByRole("radio", { name: "I have a question" })).not.toBeChecked();
    // Off until they say so
    await expect(dialog(page).getByRole("checkbox", { name: "You can email me about this" })).not.toBeChecked();
    // What goes with it, so nothing is a surprise
    await expect(dialog(page).locator("#reportSends")).toHaveText(`Sent with your report: the app version (${version}), the screen you're on, your browser and your role (owner). Please don't include passwords or card numbers.`);
    // Counters, up to the API's limits
    await expect(message(page)).toHaveAttribute("maxlength", "2000");
    await expect(expected(page)).toHaveAttribute("maxlength", "1000");
    await expect(dialog(page).locator("#reportMessageCount")).toHaveText("0 of 2,000 characters");
    await expect(dialog(page).locator("#reportExpectedCount")).toHaveText("0 of 1,000 characters");
    await message(page).fill("Hello");
    await expected(page).fill("It saves");
    await expect(dialog(page).locator("#reportMessageCount")).toHaveText("5 of 2,000 characters");
    await expect(dialog(page).locator("#reportExpectedCount")).toHaveText("8 of 1,000 characters");
    await expect(message(page)).toHaveAccessibleDescription("5 of 2,000 characters");
    expect(await modalViolations(page)).toEqual([]);
    // Every target is at least 44px
    for (const target of await dialog(page).locator("button:visible, label.check").all()) {
      expect((await target.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("sends the report with its context and an Idempotency-Key, and thanks with the reference", async ({ page, browserName }) => {
    const backend = await open(page);
    await openDialog(page);
    await dialog(page).getByRole("radio", { name: "I have an idea" }).check();
    await fill(page, "  Let me sort the pick list.  ");
    await expected(page).fill("A sort button");
    await dialog(page).getByRole("checkbox", { name: "You can email me about this" }).check();
    await sendButton(page).click();

    await expect(dialog(page).getByRole("heading", { name: "Thanks, we read every report" })).toBeVisible();
    await expect(dialog(page).locator("#reportRef")).toHaveText("R7K1Q2");
    const [call] = backend.requests("POST", FEEDBACK);
    expect(call.body).toEqual({
      category: "idea",
      message: "Let me sort the pick list.",
      expected: "A sort button",
      contactOk: true,
      context: { build: version, screen: "projects", browser: family[browserName] },
    });
    expect(call.headers["idempotency-key"]).toMatch(KEY);
    expect(call.headers.authorization).toMatch(/^Bearer at-/);
    expect(backend.reports).toHaveLength(1);
    expect(backend.reports[0]).toMatchObject({ team: "t1", role: "owner" });
    // The thanks is readable and the focus is on its button
    await expect(dialog(page).getByRole("button", { name: "Done" })).toBeFocused();
    expect(await modalViolations(page)).toEqual([]);
    await dialog(page).getByRole("button", { name: "Done" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    // The focus is back where it started
    await expect(opener(page)).toBeFocused();
  });

  test("leaves out an empty expectation, and sends contactOk false by default", async ({ page, browserName }) => {
    const backend = await open(page);
    await openDialog(page);
    await fill(page);
    await expected(page).fill("   ");
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    const [call] = backend.requests("POST", FEEDBACK);
    expect(call.body).toEqual({ category: "bug", message: "The Add button does nothing on the receipt page.", contactOk: false, context: { build: version, screen: "projects", browser: family[browserName] } });
  });

  test("a new report after a sent one gets a new key", async ({ page }) => {
    const backend = await open(page);
    await openDialog(page);
    await fill(page, "First");
    await sendButton(page).click();
    await dialog(page).getByRole("button", { name: "Done" }).click();
    await openDialog(page);
    await expect(message(page)).toHaveValue("");
    await fill(page, "First");
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toHaveText("R7K2Q2");
    const [one, two] = backend.requests("POST", FEEDBACK);
    expect(one.headers["idempotency-key"]).not.toBe(two.headers["idempotency-key"]);
    expect(backend.reports).toHaveLength(2);
  });

  test("won't send nothing: says so, marks the field and sends no request", async ({ page }) => {
    const backend = await open(page);
    await openDialog(page);
    await message(page).fill("   ");
    await sendButton(page).click();
    await expect(summary(page)).toHaveText("Tell us what happened, so we know what to look at.");
    await expect(summary(page)).toHaveAttribute("role", "alert");
    await expect(message(page)).toHaveAttribute("aria-invalid", "true");
    await expect(message(page)).toBeFocused();
    expect(await modalViolations(page)).toEqual([]);
    expect(backend.requests("POST", FEEDBACK)).toHaveLength(0);
    // Once something is there it goes, and the mark is gone
    await fill(page);
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    expect(backend.requests("POST", FEEDBACK)).toHaveLength(1);
  });

  test("a double tap sends one report and the button is off while it's sending", async ({ page }) => {
    const backend = await open(page);
    await openDialog(page);
    await fill(page);
    const release = backend.hold("POST", FEEDBACK);
    await sendButton(page).dblclick();
    await expect(dialog(page).getByRole("button", { name: "Sending…" })).toBeDisabled();
    // Enter in the form doesn't send another either
    await dialog(page).locator("#reportForm").evaluate((f) => f.requestSubmit());
    // Neither Escape nor Cancel closes it while it's on its way
    await page.keyboard.press("Escape");
    await expect(dialog(page).getByRole("button", { name: "Sending…" })).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click({ force: true });
    await expect(dialog(page).getByRole("button", { name: "Sending…" })).toBeVisible();
    release();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    expect(backend.requests("POST", FEEDBACK)).toHaveLength(1);
    expect(backend.reports).toHaveLength(1);
  });

  test("a lost answer keeps the text, and trying again sends the same key so it's one report", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", FEEDBACK, { lost: true });
    await openDialog(page);
    await dialog(page).getByRole("radio", { name: "I have a question" }).check();
    await fill(page, "Where are my exports?");
    await expected(page).fill("A file");
    await sendButton(page).click();
    await expect(summary(page)).toHaveText("Couldn't send your report. Check your connection, then try again. Your text is still here.");
    // The text and choices are all still there, and the button says Try again
    await expect(message(page)).toHaveValue("Where are my exports?");
    await expect(expected(page)).toHaveValue("A file");
    await expect(dialog(page).getByRole("radio", { name: "I have a question" })).toBeChecked();
    await expect(dialog(page).getByRole("button", { name: "Try again" })).toBeFocused();
    await expect(dialog(page).getByRole("button", { name: "Try again" })).toBeEnabled();
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page).locator("#reportRef")).toHaveText("R7K1Q2");
    const [first, again] = backend.requests("POST", FEEDBACK);
    expect(again.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    expect(again.body).toEqual(first.body);
    // The server stored the first and answered the second as a repeat
    expect(backend.reports).toHaveLength(1);
  });

  test("text edited after a failure is sent with a new key, so it isn't taken for the repeat", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", FEEDBACK, { abort: true });
    await openDialog(page);
    await fill(page, "Typo in thes message");
    await sendButton(page).click();
    await expect(summary(page)).toContainText("Couldn't send your report");
    await message(page).fill("No typo in this message");
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    const [first, second] = backend.requests("POST", FEEDBACK);
    expect(second.headers["idempotency-key"]).not.toBe(first.headers["idempotency-key"]);
    expect(backend.reports[0].message).toBe("No typo in this message");
  });

  const refusals = [
    ["the day's limit", { status: 429, body: { error: { code: "quota_exceeded", message: "x", reason: "feedback_limit" } } }, "You've sent today's limit of 5 reports. Try again tomorrow: the day changes at midnight UTC. Your text is still here."],
    ["the route's throttle", { status: 429, body: { message: "Too Many Requests" } }, "Lots of reports are coming in right now. Wait a minute, then send it again."],
    ["a body that's too big", { status: 413, body: { error: { code: "quota_exceeded", message: "x" } } }, "That report is too long to send. Shorten it a little, then send it again."],
    ["a body the API can't use", { status: 400, body: { error: { code: "bad_request", message: "x" } } }, "We couldn't use that report. Check that you wrote what happened, then send it again."],
    ["a team the user left", { status: 403, body: { error: { code: "permission_denied", message: "x", reason: "not_member" } } }, "You aren't in this team any more, so a report can't be sent from here. Reload the page, then try again."],
    ["a team being deleted", { status: 409, body: { error: { code: "aborted", message: "x", reason: "team_deleting" } } }, "This team, or your account, is being deleted, so we can't take a report from here."],
  ];
  for (const [name, answer, text] of refusals) {
    test(`says so for ${name}, and keeps what was typed`, async ({ page }) => {
      const backend = await open(page);
      backend.on("POST", FEEDBACK, answer);
      await openDialog(page);
      await fill(page, "Keep this text");
      await expected(page).fill("and this");
      await sendButton(page).click();
      await expect(summary(page)).toHaveText(text);
      await expect(summary(page)).toHaveAttribute("role", "alert");
      await expect(message(page)).toHaveValue("Keep this text");
      await expect(expected(page)).toHaveValue("and this");
      await expect(dialog(page).getByRole("button", { name: "Send report" })).toBeEnabled();
      expect(await modalViolations(page)).toEqual([]);
      // Sending again works once the cause has gone, and clears the message
      await sendButton(page).click();
      await expect(dialog(page).locator("#reportRef")).toBeVisible();
      await expect(summary(page)).toBeHidden();
    });
  }

  test("the fifth report of the day is stored and the sixth is refused with the limit's message", async ({ page }) => {
    const backend = await open(page);
    for (let i = 1; i <= 5; i++) {
      await openDialog(page);
      await fill(page, `Report ${i}`);
      await sendButton(page).click();
      await expect(dialog(page).locator("#reportRef")).toHaveText(`R7K${i}Q2`);
      await dialog(page).getByRole("button", { name: "Done" }).click();
    }
    await openDialog(page);
    await fill(page, "Report 6");
    await sendButton(page).click();
    await expect(summary(page)).toContainText("today's limit of 5 reports");
    expect(backend.reports).toHaveLength(5);
  });

  test("a viewer can report, and their role is in what's sent", async ({ page }) => {
    const backend = await open(page, { backend: new FakeBackend({ teams: [{ ...TEAM, role: "viewer" }], docs: seeded() }) });
    await openDialog(page);
    await expect(dialog(page).locator("#reportSends")).toContainText("your role (viewer)");
    await fill(page);
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    expect(backend.reports[0].role).toBe("viewer");
  });

  test("a closed team's members can report", async ({ page }) => {
    const closed = { ...TEAM, role: "contributor", closedAt: "2026-10-01T12:00:00.000Z", deletesAt: "2026-10-31T12:00:00.000Z" };
    const backend = await open(page, { backend: new FakeBackend({ teams: [closed], docs: seeded() }) });
    await openDialog(page);
    await fill(page);
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    expect(backend.reports).toHaveLength(1);
  });

  test("names the screen the report comes from: inventory, a project and a receipt", async ({ page }) => {
    const receipt = { store: "Hardware Co", date: "2026-09-20", items: [{ raw: "MOP", name: "Mop heads", qty: 1, price: 4, match: null }], subtotal: 4, tax: 0, total: 4 };
    const backend = await open(page, { backend: new FakeBackend({ docs: seeded(), receipt }) });
    const send = async (text) => {
      await openDialog(page);
      await fill(page, text);
      await sendButton(page).click();
      await dialog(page).getByRole("button", { name: "Done" }).click();
    };
    await goToInventory(page);
    await send("on inventory");
    await page.locator("#tab-projects").click();
    await openProject(page, "Echo Studio");
    await send("on a project");
    await page.getByRole("button", { name: "← All projects", exact: true }).first().click();
    await page.setInputFiles("#receiptFile", { name: "r.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    await send("on a receipt");
    expect(backend.reports.map((r) => [r.message, r.context.screen])).toEqual([
      ["on inventory", "prices"],
      ["on a project", "project"],
      ["on a receipt", "receipt"],
    ]);
  });
});

test.describe("keyboard, focus and leaving", () => {
  test("Escape closes an empty form and puts the focus back on the button", async ({ page }) => {
    await open(page);
    await openDialog(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(opener(page)).toBeFocused();
    // The app's own Escape is back for other dialogs: nothing of ours is left listening
    await openDialog(page);
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(opener(page)).toBeFocused();
  });

  test("Escape with text asks before discarding, and Keep writing returns to the text", async ({ page }) => {
    const backend = await open(page);
    await openDialog(page);
    await fill(page, "Half a thought");
    await page.keyboard.press("Escape");
    await expect(dialog(page).getByText("Discard what you wrote?")).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Keep writing" })).toBeFocused();
    await expect(dialog(page).getByRole("button", { name: "Send report" })).toBeHidden();
    expect(await modalViolations(page)).toEqual([]);
    await dialog(page).getByRole("button", { name: "Keep writing" }).click();
    await expect(message(page)).toBeFocused();
    await expect(message(page)).toHaveValue("Half a thought");
    await expect(dialog(page).getByRole("button", { name: "Send report" })).toBeVisible();
    // Asked again, this time discarding
    await page.keyboard.press("Escape");
    await dialog(page).getByRole("button", { name: "Discard" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(opener(page)).toBeFocused();
    expect(backend.requests("POST", FEEDBACK)).toHaveLength(0);
    // The next one starts empty: nothing was kept
    await openDialog(page);
    await expect(message(page)).toHaveValue("");
  });

  test("a tap outside the dialog asks too, rather than losing the text", async ({ page }) => {
    await open(page);
    await openDialog(page);
    // Typing only in the optional field counts
    await expected(page).fill("Something I expected");
    await page.locator("#overlay").click({ position: { x: 4, y: 4 } });
    await expect(dialog(page).getByText("Discard what you wrote?")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Keep writing" }).click();
    // A tap inside the dialog does nothing of the kind
    await dialog(page).getByRole("heading", { name: "Report an issue" }).click();
    await expect(dialog(page).getByText("Discard what you wrote?")).toBeHidden();
    await expect(expected(page)).toHaveValue("Something I expected");
  });

  test("Tab and Shift+Tab stay inside the dialog", async ({ page }) => {
    await open(page);
    await openDialog(page);
    await dialog(page).getByRole("radio", { name: "I have an idea" }).check();
    await dialog(page).getByRole("radio", { name: "I have an idea" }).focus();
    // Back from the first control goes to the last
    await page.keyboard.press("Shift+Tab");
    await expect(sendButton(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("radio", { name: "I have an idea" })).toBeFocused();
    // And forward from the last goes to the first
    await page.keyboard.press("Tab");
    await expect(message(page)).toBeFocused();
    await sendButton(page).focus();
    await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("radio", { name: "I have an idea" })).toBeFocused();
    // In the middle, Tab goes on as usual
    await message(page).focus();
    await page.keyboard.press("Tab");
    await expect(expected(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(message(page)).toBeFocused();
  });

  test("works with the keyboard alone, from Enter on the button to the thanks", async ({ page }) => {
    const backend = await open(page);
    await opener(page).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Typed with the keyboard");
    await sendButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#overlay")).toBeHidden();
    expect(backend.reports[0].message).toBe("Typed with the keyboard");
  });

  test("something else closing the dialog leaves nothing listening", async ({ page }) => {
    await open(page);
    await openDialog(page);
    await fill(page);
    // The app closed it (as when the account changes in another tab)
    await page.evaluate(() => { document.getElementById("overlay").hidden = true; document.getElementById("modal").innerHTML = ""; });
    // Escape, Tab and a tap on the page do nothing of ours: no error, no focus pulled
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await page.locator("#overlay").dispatchEvent("click");
    await expect(page.locator("#overlay")).toBeHidden();
    await openDialog(page);
    await expect(message(page)).toHaveValue("");
  });

  test("works at phone width, in the dark theme, with the dialog scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page);
    await openDialog(page);
    await fill(page, "x".repeat(300));
    await expect(sendButton(page)).toBeVisible();
    // Nothing is wider than the phone, and the form scrolls inside the dialog
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await dialog(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await modalViolations(page)).toEqual([]);
    await sendButton(page).scrollIntoViewIfNeeded();
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
  });
});

test.describe("the text stays private", () => {
  test("nothing the person typed reaches the console, storage or the page's other requests", async ({ page }) => {
    const secret = "my-secret-sentence-7731";
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    const backend = await open(page);
    backend.on("POST", FEEDBACK, { abort: true });
    await openDialog(page);
    await fill(page, secret);
    await expected(page).fill(secret + "-expected");
    await sendButton(page).click();
    await expect(summary(page)).toBeVisible();
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    expect(logs.filter((l) => l.includes(secret))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(secret);
    // Only the report's own route carried it
    const carrying = backend.calls.filter((c) => JSON.stringify(c.body ?? "").includes(secret) || c.path.includes(secret));
    expect(carrying.map((c) => c.path)).toEqual([FEEDBACK, FEEDBACK]);
    expect(await page.evaluate(() => document.title + location.href)).not.toContain(secret);
  });
});

test.describe("from the couldn't-connect screen", () => {
  test("offers it when the last team is known, and sends under that team", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("GET", "/me", { abort: true });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.team": "t1" } } });
    await expect(page.getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
    await page.getByRole("button", { name: "Report an issue" }).click();
    await expect(dialog(page).locator("#reportSends")).toContainText("your browser. Please");
    await expect(dialog(page).locator("#reportSends")).not.toContainText("your role");
    await fill(page, "I can't get in");
    await sendButton(page).click();
    await expect(dialog(page).locator("#reportRef")).toBeVisible();
    const [call] = backend.requests("POST", FEEDBACK);
    expect(call.body.context).toMatchObject({ build: version, screen: "sign-in" });
    // Back on the screen with its Try again, which works
    await dialog(page).getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Report an issue" })).toBeFocused();
    await page.getByRole("button", { name: "Try again" }).click();
    await connected(page);
  });

  test("isn't offered when no team is known: there's nowhere to send it", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("GET", "/me", { abort: true });
    await openAws(page, backend);
    await expect(page.getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Report an issue" })).toHaveCount(0);
  });
});

// The browser family is read from the user agent, in the API's words
const AGENTS = [
  ["edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"],
  ["opera", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0"],
  ["samsung", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36"],
  ["firefox", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15"],
  ["chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1"],
  ["safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"],
  ["other", "SomeBrowser/1.0"],
];
test.describe("browser family", () => {
  for (const [name, userAgent] of AGENTS) {
    test.describe(name, () => {
      test.use({ userAgent });
      test(`${userAgent.slice(0, 40)}… is ${name}`, async ({ page }) => {
        const backend = await open(page);
        await openDialog(page);
        await fill(page);
        await sendButton(page).click();
        await expect(dialog(page).locator("#reportRef")).toBeVisible();
        expect(backend.reports[0].context.browser).toBe(name);
      });
    });
  }
});

test("the page has no axe violations behind the dialog either", async ({ page }) => {
  await open(page);
  await openDialog(page);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});
