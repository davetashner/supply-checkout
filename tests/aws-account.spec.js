// The web build's runtime (src/aws/), part 1: config, sign-in, first sign-in and teams
// (docs/api/onboarding.md), against the fake backend in tests/fake-aws.js.
import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, USER, ORIGIN, AUTH, CONFIG, openAws, connected, lastSocket, sockets, emit, setVisible } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");

const seeded = (team = "t1") => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`${team}/${k}`, v]));
const account = (page) => page.locator("#account");
const alert = (page) => page.locator("#accountError");

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectNoSideways(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test.describe("config", () => {
  for (const [name, config] of [["missing", null], ["not JSON", "{"], ["incomplete", { apiUrl: CONFIG.apiUrl }]]) {
    test(`without a usable config.json (${name}) the app says storage isn't available`, async ({ page }) => {
      const backend = new FakeBackend({ config });
      await openAws(page, backend);
      await expect(page.locator("#notice")).toHaveText("Shared storage isn't available in this view. Reload the page, or try again in a few minutes.");
      expect(backend.calls).toEqual([]);
    });
  }
});

test.describe("sign-in", () => {
  test("resumes the session and opens the team", async ({ page }) => {
    const backend = new FakeBackend({ docs: { ...seeded(), "t1/sheets/mine": { client: "Mine", date: "2026-09-25", createdBy: USER.id, status: "open", items: {} } } });
    await openAws(page, backend);
    await connected(page);
    await expect(page.getByRole("button", { name: /Echo Studio/ })).toContainText("Someone");
    await expect(page.getByRole("button", { name: /Mine/ })).toContainText("Pat Lee");
    await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
    // No receipt reading until its endpoint exists
    await expect(page.getByText("Scan receipt")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBe("t1");

    const me = backend.requests("GET", "/me")[0];
    expect(me.headers.authorization).toBe("Bearer at-1");
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(1);
    // The refresh token is only in a cookie; nothing about the session is stored
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("at-1");

    const sock = await lastSocket(page);
    expect(sock.url).toBe(CONFIG.realtimeUrl);
    expect(sock.protocols[0]).toBe("aws-appsync-event-ws");
    expect(sock.token).toBe("at-1");
    expect(sock.sent[0]).toEqual({ type: "connection_init" });
    expect(sock.sent[1]).toMatchObject({ type: "subscribe", channel: "/users/u-pat", authorization: { host: CONFIG.realtimeHost, Authorization: "at-1" } });
    await expectAccessible(page);
  });

  test("signed out: a sign-in link to Managed Login with PKCE", async ({ page }) => {
    const backend = new FakeBackend({ signedIn: false });
    await openAws(page, backend);
    await expect(account(page).getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(account(page)).toContainText("Sign in to see your team's sheets and inventory.");
    await expect(alert(page)).toBeHidden();
    await expect(page.locator("#main")).toBeHidden();
    await expectAccessible(page);

    const link = page.getByRole("link", { name: "Sign in" });
    const url = new URL(await link.getAttribute("href"));
    const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.signIn")));
    expect(url.origin + url.pathname).toBe(AUTH + "/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: ORIGIN + "/",
      scope: "openid email profile aws.cognito.signin.user.admin",
      state: saved.state,
      code_challenge: createHash("sha256").update(saved.verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await link.click();
    await expect.poll(() => backend.authRequests).toEqual([url.href]);
  });

  test("an invite link is kept across sign-in", async ({ page }) => {
    await openAws(page, new FakeBackend({ signedIn: false }), { path: "/?invite=i1&token=tok" });
    await expect(account(page)).toContainText("Sign in with the email address your invite was sent to");
    expect(new URL(page.url()).search).toBe("");
    expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.invite")))).toEqual({ id: "i1", token: "tok" });
  });

  test("finishes the sign-in redirect", async ({ page }) => {
    const backend = new FakeBackend({ signedIn: false, docs: seeded() });
    const verifier = "v".repeat(43);
    await openAws(page, backend, { path: "/?code=good-code&state=st1", storage: { session: { "supplyCheckout.signIn": JSON.stringify({ verifier, state: "st1" }) } } });
    await connected(page);
    expect(backend.requests("POST", "/auth/session")[0].body).toEqual({ code: "good-code", codeVerifier: verifier, redirectUri: ORIGIN + "/" });
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(0);
    expect(page.url()).toBe(ORIGIN + "/");
    expect(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.signIn"))).toBeNull();
    await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  });

  const unfinished = [
    ["with the wrong state", "/?code=good-code&state=other", { verifier: "v".repeat(43), state: "st1" }],
    ["that was cancelled", "/?error=access_denied", null],
    ["whose code is refused", "/?code=bad-code&state=st1", { verifier: "v".repeat(43), state: "st1" }],
    ["with nothing saved from before", "/?code=good-code&state=st1", null],
  ];
  for (const [name, path, saved] of unfinished) {
    test(`a sign-in redirect ${name} asks to sign in again`, async ({ page }) => {
      const backend = new FakeBackend({ signedIn: false });
      await openAws(page, backend, { path, storage: saved ? { session: { "supplyCheckout.signIn": JSON.stringify(saved) } } : undefined });
      await expect(alert(page)).toHaveText("Sign-in didn't finish. Please try again.");
      await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
      expect(backend.requests("POST", "/auth/session")).toHaveLength(name === "whose code is refused" ? 1 : 0);
    });
  }

  // A first Google or Apple sign-in whose email already has an account: the pre sign-up trigger
  // links it and fails that sign-in with ACCOUNT_LINKED:<provider> (supply-checkout-0b1)
  const linkedError = (provider, state = "st1") => `/?${new URLSearchParams({ error_description: `PreSignUp failed with error ACCOUNT_LINKED:${provider}. `, state, error: "invalid_request" })}`;
  for (const [provider, name, article] of [["Google", "Google", "a"], ["SignInWithApple", "Apple", "an"]]) {
    test(`${article} ${name} sign-in just linked to an existing account signs in again with ${name}, once`, async ({ page }) => {
      const backend = new FakeBackend({ signedIn: false });
      await openAws(page, backend, { path: linkedError(provider), storage: { session: { "supplyCheckout.signIn": JSON.stringify({ verifier: "v".repeat(43), state: "st1" }), "supplyCheckout.invite": JSON.stringify({ id: "i1", token: "tok" }) } } });
      await expect.poll(() => backend.authRequests.length).toBe(1);
      const url = new URL(backend.authRequests[0]);
      const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.signIn")));
      expect(url.origin + url.pathname).toBe(AUTH + "/oauth2/authorize");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: "code",
        client_id: "test-client",
        redirect_uri: ORIGIN + "/",
        scope: "openid email profile aws.cognito.signin.user.admin",
        state: saved.state,
        code_challenge: createHash("sha256").update(saved.verifier).digest("base64url"),
        code_challenge_method: "S256",
        identity_provider: provider,
      });
      expect(saved.relinked).toBe(true);
      expect(saved.state).not.toBe("st1");
      // Said on screen too, with a way on if the redirect doesn't happen
      await expect(account(page).getByRole("heading", { name: "Signing in" })).toBeVisible();
      await expect(account(page)).toContainText(`Your ${name} sign-in is now linked to your Supply Checkout account.`);
      expect(await page.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe(url.href);
      expect(page.url()).toBe(ORIGIN + "/");
      // The invite waits for the retried sign-in
      expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.invite")))).toEqual({ id: "i1", token: "tok" });
      expect(backend.requests("POST", "/auth/session")).toHaveLength(0);
      await expectAccessible(page);
    });
  }

  const notRelinked = [
    ["after a retry already failed", linkedError("Google"), { verifier: "v".repeat(43), state: "st1", relinked: true }],
    ["for a sign-in this tab didn't start", linkedError("Google", "other"), { verifier: "v".repeat(43), state: "st1" }],
    ["with nothing saved from before", linkedError("Google"), null],
    ["for another provider", linkedError("Facebook"), { verifier: "v".repeat(43), state: "st1" }],
    ["without a description", "/?error=invalid_request&state=st1", { verifier: "v".repeat(43), state: "st1" }],
  ];
  for (const [name, path, saved] of notRelinked) {
    test(`a linked-account error ${name} asks to sign in again instead of retrying`, async ({ page }) => {
      const backend = new FakeBackend({ signedIn: false });
      await openAws(page, backend, { path, storage: saved ? { session: { "supplyCheckout.signIn": JSON.stringify(saved) } } : undefined });
      await expect(alert(page)).toHaveText("Sign-in didn't finish. Please try again.");
      const link = page.getByRole("link", { name: "Sign in" });
      await expect(link).toBeVisible();
      expect(new URL(await link.getAttribute("href")).searchParams.has("identity_provider")).toBe(false);
      expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.signIn"))).relinked).toBeUndefined();
      expect(backend.authRequests).toEqual([]);
    });
  }

  test("a failed code exchange can be tried again", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("POST", "/auth/session", { status: 503, body: { error: { code: "internal", message: "Cognito didn't answer" } } });
    await openAws(page, backend, { path: "/?code=good-code&state=st1", storage: { session: { "supplyCheckout.signIn": JSON.stringify({ verifier: "v".repeat(43), state: "st1" }) } } });
    await expect(account(page).getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
    await expectAccessible(page);
    // Trying again resumes from the cookie
    await page.getByRole("button", { name: "Try again" }).click();
    await connected(page);
    await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  });

  test("an unreachable API can be tried again", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("POST", "/auth/refresh", { abort: true });
    backend.on("GET", "/me", { status: 502, body: "<html>Bad gateway</html>" });
    await openAws(page, backend);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await connected(page);
  });

  test("an expired access token is refreshed, and the request tried again", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    // /me first answers with API Gateway's own 401
    backend.on("GET", "/me", { status: 401, body: { message: "Unauthorized" } });
    await openAws(page, backend);
    await connected(page);
    expect(backend.requests("GET", "/me").map((c) => c.headers.authorization)).toEqual(["Bearer at-1", "Bearer at-2"]);

    // Later, a write with an expired token
    backend.token = "expired";
    await page.getByRole("button", { name: "+ New sheet" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Refreshed");
    await page.getByRole("button", { name: "Create sheet" }).click();
    await expect(page.getByRole("heading", { name: "Refreshed" })).toBeVisible();
    const puts = backend.requests("PUT", /^\/teams\/t1\/sheets\//);
    expect(puts.map((c) => c.headers.authorization)).toEqual(["Bearer at-2", "Bearer at-3"]);
    // Live updates reconnect with the new token
    await expect.poll(async () => (await lastSocket(page)).token).toBe("at-3");
  });

  test("when the session has ended, the app asks to sign in", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    // Wait for the re-list after subscribing too, or it can meet the ended session
    // first and show the sign-in screen before the click (seen in iPhone Safari)
    await expect.poll(() => ["products", "sheets"].map((c) => backend.requests("GET", `/teams/t1/${c}`).length)).toEqual([2, 2]);
    backend.token = "expired";
    backend.signedIn = false;
    await page.getByRole("button", { name: "+ New sheet" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Too late");
    await page.getByRole("button", { name: "Create sheet" }).click();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.locator("#main")).toBeHidden();
  });

  test("a session that ends while /me loads asks to sign in", async ({ page }) => {
    const backend = new FakeBackend();
    const release = backend.hold("GET", "/me");
    await openAws(page, backend);
    await expect.poll(() => backend.requests("GET", "/me").length).toBe(1);
    backend.token = "revoked";
    backend.signedIn = false;
    release();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(2);
  });

  test("the access token is refreshed before it expires", async ({ page }) => {
    await page.clock.install();
    // Refreshed a minute in, when it would expire in six
    const backend = new FakeBackend({ docs: seeded(), expiresIn: 360 });
    await openAws(page, backend);
    await connected(page);
    await page.clock.fastForward(61e3);
    await expect.poll(async () => (await lastSocket(page)).token).toBe("at-2");
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(2);
    // The next one fails: the session ended elsewhere
    backend.signedIn = false;
    await page.clock.fastForward(61e3);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("signing out while a refresh is in flight waits for it, so the refresh can't sign the user back in", async ({ page }) => {
    await page.clock.install();
    const backend = new FakeBackend({ docs: seeded(), expiresIn: 360 });
    await openAws(page, backend);
    await connected(page);
    // The scheduled refresh reaches the API, which rotates the refresh token, but its
    // answer (and the new cookie) is slow to arrive
    const deliver = backend.delay("POST", "/auth/refresh");
    await page.clock.fastForward(61e3);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBe(2);
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    // Sign-out waits for the refresh...
    await page.waitForTimeout(200);
    expect(backend.requests("POST", "/auth/sign-out")).toHaveLength(0);
    // ...then revokes the session the refresh left, and no timer refreshes it again
    deliver();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(backend.requests("POST", "/auth/sign-out")).toHaveLength(1);
    expect(backend.signedIn).toBe(false);
    await page.clock.fastForward(600e3);
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(2);
    // (The Managed Login sign-out is a 204 here, so the page stays.) Live updates stopped
    // with the session: the socket's keep-alive, a reconnect and the 10-minute re-list
    // all fall due, and none opens a socket or calls the API without a token
    const socketCount = (await sockets(page)).length, calls = backend.calls.length;
    await page.clock.runFor(700e3);
    expect(await sockets(page)).toHaveLength(socketCount);
    expect(backend.calls.slice(calls).map((c) => `${c.method} ${c.path}`)).toEqual([]);
    // A save now is refused without reaching the API
    await page.getByRole("button", { name: "+ New sheet" }).click();
    await page.getByLabel("Client", { exact: true }).fill("After sign-out");
    await page.getByRole("button", { name: "Create sheet" }).click();
    await page.clock.runFor(5e3);
    expect(backend.calls.slice(calls).map((c) => `${c.method} ${c.path}`)).toEqual([]);

    // Opening the app again shows sign-in
    const again = await page.context().newPage();
    backend.pageLoads = 0;
    await openAws(again, backend);
    await expect(again.getByRole("link", { name: "Sign in" })).toBeVisible();
    await again.close();
  });

  test("without an expiry, the access token is refreshed as if it lasts an hour", async ({ page }) => {
    await page.clock.install();
    const backend = new FakeBackend({ docs: seeded(), expiresIn: null });
    await openAws(page, backend);
    await connected(page);
    // Not right away (a NaN delay would refresh at once, and again and again)...
    await page.clock.fastForward(3290e3);
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(1);
    // ...but five minutes before the hour. (The re-list after a reconnect can race it
    // and refresh once more with the rotated token, so this counts at least one.)
    await page.clock.fastForward(20e3);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBeGreaterThanOrEqual(2);
  });

  test("signing out revokes the session, forgets sign-in's saved state and signs out of Managed Login", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    const keys = ["supplyCheckout.team", "supplyCheckout.owner", "supplyCheckout.receiptDraft", "supplyCheckout.receiptDraft.t1", "supplyCheckout.receiptDraft.t2"];
    const saved = () => page.evaluate((keys) => [sessionStorage.getItem("supplyCheckout.invite"), sessionStorage.getItem("supplyCheckout.signIn"), ...keys.map((k) => localStorage.getItem(k))], keys);
    await page.evaluate(() => {
      sessionStorage.setItem("supplyCheckout.invite", JSON.stringify({ id: "i1", token: "tok" }));
      sessionStorage.setItem("supplyCheckout.signIn", JSON.stringify({ verifier: "v", state: "s" }));
      // Every team's draft, and an older build's one draft
      for (const k of ["supplyCheckout.receiptDraft", "supplyCheckout.receiptDraft.t1", "supplyCheckout.receiptDraft.t2"]) localStorage.setItem(k, JSON.stringify({ vendor: "Costco", items: [{ name: "Paper towels", price: 8.5 }] }));
      localStorage.setItem("supplyCheckout.theme", "dark");
    });

    // The API can't be reached: still signed in, and says so
    backend.on("POST", "/auth/sign-out", { abort: true });
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#toast")).toHaveText("Couldn't sign out. Try again.");
    expect(backend.authRequests).toEqual([]);
    expect(await saved()).not.toContain(null);
    await expect(page.locator(".teambar")).toContainText(TEAM.name);

    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => backend.authRequests).toEqual([`${AUTH}/logout?client_id=test-client&logout_uri=${encodeURIComponent(ORIGIN + "/")}`]);
    expect(backend.requests("POST", "/auth/sign-out")).toHaveLength(2);
    // The chosen team and every receipt draft are forgotten too, so the next person to sign
    // in here doesn't open the team or see the drafts' items, prices and sheets
    expect(await saved()).toEqual([null, null, ...keys.map(() => null)]);
    // Not the theme, which isn't anyone's data
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.theme"))).toBe("dark");
  });

  test("a live update's 401 while signing out doesn't refresh, so it can't sign the user back in", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    const signOut = page.locator(".teambar").getByRole("button", { name: "Sign out" });

    // The sign-out's answer is slow, and meanwhile a live update's fetch gets a 401
    const release = backend.hold("POST", "/auth/sign-out");
    await signOut.click();
    await expect(signOut).toBeDisabled();
    await expect.poll(() => backend.requests("POST", "/auth/sign-out").length).toBe(1);
    backend.token = "expired";
    await emit(page, { v: 1, eventId: "e1", collection: "sheets", id: "s1", op: "put", version: 9 });
    await expect.poll(() => backend.requests("GET", "/teams/t1/sheets/s1").length).toBe(1);
    await page.waitForTimeout(200);
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(1);

    release();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(backend.signedIn).toBe(false);
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(1);
  });

  test("a stalled sign-out times out, says so, and can be tried again", async ({ page }) => {
    await page.clock.install();
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    const signOut = page.locator(".teambar").getByRole("button", { name: "Sign out" });

    // The API never answers: the button stays off until the request gives up at 15 seconds
    const release = backend.hold("POST", "/auth/sign-out");
    await signOut.click();
    await expect.poll(() => backend.requests("POST", "/auth/sign-out").length).toBe(1);
    await expect(signOut).toBeDisabled();
    await page.clock.fastForward(14e3);
    await expect(signOut).toBeDisabled();
    await page.clock.fastForward(1e3);
    await expect(page.locator("#toast")).toHaveText("Couldn't sign out. Try again.");
    await expect(signOut).toBeEnabled();
    expect(backend.authRequests).toEqual([]);
    expect(backend.signedIn).toBe(true);

    // Still signed in, so the refresh a minute later runs; and the next try goes through
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(1);
    await page.clock.fastForward(60e3);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBe(2);
    release();
    await signOut.click();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(backend.requests("POST", "/auth/sign-out")).toHaveLength(2);
  });

  test("a refresh whose answer stalls partway times out as unavailable, and the session carries on", async ({ page }) => {
    await page.clock.install();
    const backend = new FakeBackend({ docs: seeded(), expiresIn: 360 });
    await openAws(page, backend);
    await connected(page);
    // The next refresh's headers arrive, but its body never finishes (until the request is aborted)
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (url, init) => {
        if (!String(url).endsWith("/auth/refresh")) return real(url, init);
        window.fetch = real;
        window.__stalled = true;
        const body = new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(new DOMException("The operation was aborted.", "AbortError"))); } });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      };
    });
    await page.clock.fastForward(61e3);
    await expect.poll(() => page.evaluate(() => window.__stalled)).toBe(true);
    await page.clock.fastForward(15e3);
    // Not read as an empty success: still signed in with the token it had, and writes work
    await page.getByRole("button", { name: "+ New sheet" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Still here");
    await page.getByRole("button", { name: "Create sheet" }).click();
    await expect(page.getByRole("heading", { name: "Still here" })).toBeVisible();
    expect(backend.requests("PUT", /^\/teams\/t1\/sheets\//).map((c) => c.headers.authorization)).toEqual(["Bearer at-1"]);
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  });

  test("a key that can't be removed doesn't keep the others on sign-out", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    await page.evaluate(() => {
      const real = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (k) { if (k === "supplyCheckout.team" || k === "supplyCheckout.signIn") throw new DOMException("Blocked", "SecurityError"); return real.call(this, k); };
      localStorage.setItem("supplyCheckout.receiptDraft.t1", "{}");
      localStorage.setItem("supplyCheckout.receiptDraft.t2", "{}");
      sessionStorage.setItem("supplyCheckout.signIn", "{}");
      sessionStorage.setItem("supplyCheckout.invite", "{}");
    });
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("supplyCheckout.")).sort())).toEqual(["supplyCheckout.team"]);
    expect(await page.evaluate(() => [sessionStorage.getItem("supplyCheckout.signIn"), sessionStorage.getItem("supplyCheckout.invite")])).toEqual(["{}", null]);
  });

  test("a scheduled refresh that fails tries again a minute later", async ({ page }) => {
    await page.clock.install();
    const backend = new FakeBackend({ docs: seeded(), expiresIn: 360 });
    await openAws(page, backend);
    await connected(page);
    // The API doesn't answer the scheduled refresh: still signed in with the token it had
    backend.on("POST", "/auth/refresh", { abort: true });
    await page.clock.fastForward(61e3);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBe(2);
    expect((await lastSocket(page)).token).toBe("at-1");
    await page.clock.fastForward(59e3);
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(2);
    // A minute on, it tries again, and live updates reconnect with the new token
    await page.clock.fastForward(1e3);
    await expect.poll(async () => (await lastSocket(page)).token).toBe("at-2");
    expect(backend.requests("POST", "/auth/refresh")).toHaveLength(3);
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  });

  test("storage that can't be written doesn't stop sign-out", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    await page.evaluate(() => { Storage.prototype.removeItem = () => { throw new DOMException("Blocked", "SecurityError"); }; });
    await page.locator(".teambar").getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => backend.authRequests.length).toBe(1);
    expect(backend.signedIn).toBe(false);
  });
});

test.describe("first sign-in and teams", () => {
  test("a new user names their team", async ({ page }) => {
    const backend = new FakeBackend({ teams: [] });
    await openAws(page, backend);
    await expect(account(page).getByRole("heading", { name: "Name your team" })).toBeVisible();
    await expect(account(page)).toContainText("Signed in as pat@example.com.");
    await expect(page.getByLabel("Team name")).toBeFocused();
    // Focused by the screen, with no autofocus attribute for WebKit to refocus a frame later
    await expect(page.locator("[autofocus]")).toHaveCount(0);
    await expectAccessible(page);

    const create = async (name) => {
      await page.getByLabel("Team name").fill(name);
      await page.getByRole("button", { name: "Create team" }).click();
    };
    // A blank name does nothing
    await create("   ");
    expect(backend.requests("POST", "/teams")).toHaveLength(0);
    backend.on("POST", "/teams", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    await create("Bravo");
    await expect(alert(page)).toHaveText("Couldn't create the team. Check your connection and try again.");
    backend.on("POST", "/teams", { status: 429, body: { error: { code: "quota_exceeded", message: "5 a day" } } });
    await create("Bravo");
    await expect(alert(page)).toContainText("You've made as many teams as you can for now.");
    backend.on("POST", "/teams", { status: 400, body: { error: { code: "bad_request", message: "name" } } });
    await create("Bravo Co");
    await expect(alert(page)).toHaveText("Enter a team name of up to 200 characters.");
    await create("Bravo Co");
    await connected(page);
    await expect(page.locator(".teambar")).toContainText("Team: Bravo Co");
    await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();

    // The same key for the same name; a new one after the name changed
    const keys = backend.requests("POST", "/teams").map((c) => c.headers["idempotency-key"]);
    expect(keys).toHaveLength(4);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys[3]).toBe(keys[2]);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(backend.requests("POST", "/teams").map((c) => c.body)).toEqual([{ name: "Bravo" }, { name: "Bravo" }, { name: "Bravo Co" }, { name: "Bravo Co" }]);
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBe(backend.teams[0].id);
  });

  test("invites without the link are shown, with how to join", async ({ page }) => {
    const backend = new FakeBackend({ teams: [], user: { ...USER, email: null }, invites: [{ id: "i9", teamName: "Bravo Co", role: "viewer", expiresAt: "2026-10-03T12:00:00.000Z" }] });
    await openAws(page, backend);
    await expect(account(page)).toContainText("Bravo Co invited you as a viewer. Open the link in your invite email to join.");
    await expect(account(page)).toContainText("Signed in as you.");
    await account(page).getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => backend.authRequests.length).toBe(1);
  });

  const invited = { id: "i1", teamName: "Bravo Co", role: "contributor", expiresAt: "2026-10-03T12:00:00.000Z" };
  const inviteLink = (token = "tok") => ({ session: { "supplyCheckout.invite": JSON.stringify({ id: "i1", token }) } });

  test("joins the team from an invite link", async ({ page }) => {
    const backend = new FakeBackend({ teams: [], invites: [invited], docs: seeded("t-i1") });
    await openAws(page, backend, { storage: inviteLink() });
    await expect(account(page).getByRole("heading", { name: "Join Bravo Co" })).toBeVisible();
    await expect(account(page)).toContainText("Bravo Co invited you as a contributor.");
    await expect(page.getByRole("button", { name: "Create my own team instead" })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("button", { name: "Join" }).click();
    await connected(page);
    expect(backend.requests("POST", "/invites/i1/accept")[0].body).toEqual({ token: "tok" });
    await expect(page.locator(".teambar")).toContainText("Team: Bravo Co");
    await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.invite"))).toBeNull();
  });

  test("an invite that's expired or used says so, and offers a team of their own", async ({ page }) => {
    const backend = new FakeBackend({ teams: [], invites: [invited] });
    await openAws(page, backend, { storage: inviteLink("wrong") });
    await page.getByRole("button", { name: "Join" }).click();
    await expect(alert(page)).toContainText("This invite has expired, was already used");
    await expect(page.getByRole("button", { name: "Join" })).toBeHidden();
    await page.getByRole("button", { name: "Create my own team instead" }).click();
    await expect(account(page).getByRole("heading", { name: "Name your team" })).toBeVisible();
  });

  test("joining explains an unverified email, too many teams, a full team, and a lost connection", async ({ page }) => {
    const backend = new FakeBackend({ teams: [], invites: [invited] });
    backend.on("POST", "/invites/i1/accept", { status: 403, body: { error: { code: "permission_denied", message: "verify" } } });
    backend.on("POST", "/invites/i1/accept", { status: 429, body: { error: { code: "quota_exceeded", message: "20 teams" } } });
    backend.on("POST", "/invites/i1/accept", { status: 429, body: { error: { code: "quota_exceeded", reason: "team_full", message: "full" } } });
    backend.on("POST", "/invites/i1/accept", { abort: true });
    await openAws(page, backend, { storage: inviteLink() });
    const join = page.getByRole("button", { name: "Join" });
    await join.click();
    await expect(alert(page)).toContainText("Your email address isn't verified yet.");
    await join.click();
    await expect(alert(page)).toContainText("You're already in as many teams as you can be.");
    await join.click();
    await expect(alert(page)).toHaveText("This team is full. Ask the person who invited you to make room, then try again.");
    await join.click();
    await expect(alert(page)).toHaveText("Couldn't join the team. Check your connection and try again.");
    await join.click();
    await connected(page);
  });

  test("an invite to a team they're already in opens their team", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("POST", "/invites/i7/accept", { status: 409, body: { error: { code: "aborted", message: "member" } } });
    await openAws(page, backend, { path: "/?invite=i7&token=tok" });
    await expect(account(page).getByRole("heading", { name: "Join a team" })).toBeVisible();
    await expect(account(page)).toContainText("You've been invited to join a team.");
    await page.getByRole("button", { name: "Join" }).click();
    await connected(page);
    await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
  });

  test("an invite can wait while they use their own team", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded(), invites: [invited] });
    await openAws(page, backend, { storage: inviteLink() });
    await page.getByRole("button", { name: "Not now" }).click();
    await connected(page);
    expect(await page.evaluate(() => sessionStorage.getItem("supplyCheckout.invite"))).toBeNull();
    expect(backend.requests("POST", "/invites/i1/accept")).toHaveLength(0);
  });

  const teams = [TEAM, { ...TEAM, id: "t2", name: "Bravo Co", role: "contributor" }];

  test("with several teams, opens the last one used and switches between them", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: { ...seeded(), "t2/sheets/b1": { client: "Bravo job", date: "2026-09-20", status: "open", items: {} } } });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t2" } } });
    await connected(page);
    await expect(page.getByRole("button", { name: /Bravo job/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Echo Studio/ })).toHaveCount(0);
    const pick = page.getByLabel("Team");
    await expect(pick).toHaveValue("t2");
    await expect(pick.locator("option")).toHaveText(["Echo Cleaning", "Bravo Co"]);
    expect((await lastSocket(page)).sent[1].channel).toBe("/users/u-pat");
    await expectAccessible(page);
    // Switching remembers the team and loads the page again
    await pick.selectOption("t1");
    await expect.poll(() => backend.pageLoads).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBe("t1");
  });

  test("a remembered team they've left falls back to the first", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.team": "gone" } } });
    await connected(page);
    await expect(page.getByLabel("Team")).toHaveValue("t1");
  });

  test("viewers see the view-only notice", async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, role: "viewer" }], docs: seeded() });
    await openAws(page, backend);
    await connected(page);
    await expect(page.locator("#notice")).toHaveText("You have view-only access. Ask the owner to give you Contributor access to scan and edit.");
    await expect(page.getByRole("button", { name: "+ New sheet" })).toHaveCount(0);
  });

  test("the account screens and team bar fit a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const backend = new FakeBackend({ teams: [], invites: [{ ...invited, teamName: "A team with a rather long name, Incorporated" }] });
    await openAws(page, backend, { storage: inviteLink() });
    await expect(page.getByRole("button", { name: "Join" })).toBeVisible();
    await expectNoSideways(page);
    await page.getByRole("button", { name: "Create my own team instead" }).click();
    await expect(page.getByLabel("Team name")).toBeVisible();
    await expectNoSideways(page);
  });

  test("the team switcher fits a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openAws(page, new FakeBackend({ teams: [TEAM, { ...TEAM, id: "t2", name: "A team with a rather long name, Incorporated" }], docs: seeded() }));
    await connected(page);
    await expect(page.getByLabel("Team")).toBeVisible();
    await expectNoSideways(page);
  });

  // Nothing tells the page when another of the user's teams removes them: /me, asked again
  // when the data is re-listed (at most once a minute), does
  test("drops a team the user was removed from when the data is next re-listed", async ({ page }) => {
    const three = [...teams, { ...TEAM, id: "t3", name: "Charlie Ltd", role: "viewer" }];
    const backend = new FakeBackend({ teams: three, docs: seeded() });
    await page.clock.install();
    await openAws(page, backend);
    await connected(page);
    const pick = page.getByLabel("Team");
    await expect(pick.locator("option")).toHaveText(["Echo Cleaning", "Bravo Co", "Charlie Ltd"]);
    const meCalls = () => backend.requests("GET", "/me").length;
    expect(meCalls()).toBe(1);
    backend.teams = backend.teams.filter((t) => t.id !== "t3");
    // Within a minute of loading /me, a re-list doesn't ask again
    await setVisible(page, true);
    await expect.poll(() => backend.requests("GET", "/teams/t1/sheets").length).toBeGreaterThan(1);
    expect(meCalls()).toBe(1);
    await page.clock.fastForward(61e3);
    await setVisible(page, true);
    await expect(pick.locator("option")).toHaveText(["Echo Cleaning", "Bravo Co"]);
    expect(meCalls()).toBe(2);
    // A /me that fails leaves the switcher as it was
    backend.teams = backend.teams.filter((t) => t.id !== "t2");
    backend.on("GET", "/me", { abort: true });
    await page.clock.fastForward(61e3);
    await setVisible(page, true);
    await expect.poll(meCalls).toBe(3);
    await expect(pick.locator("option")).toHaveText(["Echo Cleaning", "Bravo Co"]);
    // One team left: just its name
    await page.clock.fastForward(61e3);
    await setVisible(page, true);
    await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
    await expect(page.getByLabel("Team")).toHaveCount(0);
    await expectAccessible(page);
  });

  test("a /me without the open team leaves the switcher to the removal notice", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    await page.clock.install();
    await openAws(page, backend);
    await connected(page);
    backend.teams = backend.teams.filter((t) => t.id !== "t1");
    await page.clock.fastForward(61e3);
    await setVisible(page, true);
    await expect(page.getByRole("heading", { name: `You're no longer in ${TEAM.name}` })).toBeVisible();
    expect(backend.requests("GET", "/me")).toHaveLength(2);
    await expect(page.getByLabel("Team").locator("option")).toHaveText(["Echo Cleaning", "Bravo Co"]);
  });
});

// The team choice and receipt drafts kept in localStorage, on a device people share
// (supply-checkout-5nj, supply-checkout-i7h)
test.describe("saved on this device", () => {
  const teams = [TEAM, { ...TEAM, id: "t2", name: "Bravo Co", role: "contributor" }];
  const SAM = { id: "u-sam", email: "sam@example.com", emailVerified: true };
  const draft = (store) => JSON.stringify({ store, receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null, savePrices: true, by: "", dests: [{ id: "d1", sheetId: "", client: "" }], lines: [{ id: "l1", name: "Paper towels", raw: "", qty: 1, price: 8, dest: "stock", code: "", match: "", suggested: false, useName: "inv", usePrice: "receipt" }] });
  const resume = (page) => page.getByText("You have a receipt that hasn't been saved yet.");
  const saved = (page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("supplyCheckout."))));
  // The app in another tab of the same browser, with the same storage
  async function reopen(page, backend) {
    const again = await page.context().newPage();
    backend.pageLoads = 0;
    await openAws(again, backend);
    return again;
  }

  test("each team has its own receipt draft", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t2", "supplyCheckout.receiptDraft.t1": draft("Costco"), "supplyCheckout.receiptDraft.t2": draft("Home Depot") } } });
    await connected(page);
    await page.getByRole("button", { name: "Continue review" }).click();
    await expect(page.locator("#rBody .meta")).toContainText("Home Depot");
    await expect(page.locator("#rBody .meta")).not.toContainText("Costco");
    // Discarding it leaves the other team's
    await page.locator("#rDiscard").click();
    await page.locator("#rDiscard").click();
    await expect(resume(page)).toHaveCount(0);
    expect(await saved(page)).toEqual({ "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t2", "supplyCheckout.receiptDraft.t1": draft("Costco") });

    // Switching teams shows the other team's draft
    await page.getByLabel("Team").selectOption("t1");
    await expect.poll(() => backend.pageLoads).toBe(2);
    const again = await reopen(page, backend);
    await connected(again);
    await expect(again.getByLabel("Team")).toHaveValue("t1");
    await again.getByRole("button", { name: "Continue review" }).click();
    await expect(again.locator("#rBody .meta")).toContainText("Costco");
    await again.close();
  });

  test("after a session ends without Sign out, someone else signing in doesn't get the last user's team or drafts", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t2" } } });
    await connected(page);
    // Pat's session ends (it expired, or a sign-out timed out here but went through) and
    // the refresh's 401 shows the sign-in screen, with Pat's team and draft still saved
    await page.evaluate((d) => localStorage.setItem("supplyCheckout.receiptDraft.t2", d), draft("Home Depot"));
    await expect.poll(() => ["products", "sheets"].map((c) => backend.requests("GET", `/teams/t2/${c}`).length)).toEqual([2, 2]);
    backend.token = "expired";
    backend.signedIn = false;
    await page.getByRole("button", { name: "+ New sheet" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Too late");
    await page.getByRole("button", { name: "Create sheet" }).click();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(await saved(page)).toEqual({ "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t2", "supplyCheckout.receiptDraft.t2": draft("Home Depot") });

    // Sam, in both teams too, signs in on the same device
    backend.user = SAM;
    backend.signedIn = true;
    const again = await reopen(page, backend);
    await connected(again);
    await expect(again.getByLabel("Team")).toHaveValue("t1");
    await expect(resume(again)).toHaveCount(0);
    expect(await saved(again)).toEqual({ "supplyCheckout.owner": SAM.id, "supplyCheckout.team": "t1" });
    await again.close();
  });

  test("the same user signing in again keeps their team and drafts", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    const local = { "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t2", "supplyCheckout.receiptDraft.t2": draft("Home Depot") };
    await openAws(page, backend, { storage: { local } });
    await connected(page);
    await expect(page.getByLabel("Team")).toHaveValue("t2");
    await expect(resume(page)).toBeVisible();
    expect(await saved(page)).toEqual(local);
  });

  test("a team and draft saved before they were marked with their user are forgotten", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.team": "t2", "supplyCheckout.receiptDraft": draft("Costco"), "supplyCheckout.receiptDraft.t1": draft("Home Depot") } } });
    await connected(page);
    await expect(page.getByLabel("Team")).toHaveValue("t1");
    await expect(resume(page)).toHaveCount(0);
    expect(await saved(page)).toEqual({ "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t1" });
  });

  test("with storage blocked, sign-in, invites and teams still work", async ({ page }) => {
    await page.addInitScript(() => {
      for (const area of ["localStorage", "sessionStorage"]) Object.defineProperty(window, area, { get() { throw new DOMException("Blocked", "SecurityError"); } });
    });
    const backend = new FakeBackend({ teams, docs: seeded("t2"), invites: [{ id: "i1", teamName: "Bravo Co", role: "contributor", expiresAt: "2026-10-03T12:00:00.000Z" }] });
    await openAws(page, backend, { path: "/?invite=i1&token=tok" });
    // The invite couldn't be kept, so it isn't offered
    await connected(page);
    await expect(page.getByLabel("Team")).toHaveValue("t1");
    await page.getByLabel("Team").selectOption("t2");
    await expect.poll(() => backend.pageLoads).toBe(2);
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  });

  test("an invite saved in a form it can't read is ignored", async ({ page }) => {
    const backend = new FakeBackend({ teams, docs: seeded() });
    await openAws(page, backend, { storage: { session: { "supplyCheckout.invite": "{not json" } } });
    await connected(page);
    expect(backend.requests("POST", "/invites/i1/accept")).toHaveLength(0);
  });
});
