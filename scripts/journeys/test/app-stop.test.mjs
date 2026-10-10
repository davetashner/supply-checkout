// node --test scripts/journeys/test/ (part of npm run test:scripts): stopping the app in a
// browser context before its session is read or abandoned (lib/app-stop.mjs), and the narrow
// allowance for the requests that cuts off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROD } from "../lib/config.mjs";
import { AUTH_WAIT_MS, RefreshInFlight, isAbandonedRequestError, stopApp, trackRequests } from "../lib/app-stop.mjs";
import { fakeBrowserContext as fakeContext, fakeRequest as request } from "./helpers.mjs";

const opts = (sleep = async () => {}) => ({ apiOrigin: PROD.api, settleMs: 0, sleep });

test("stopApp takes every page of the context to about:blank", async () => {
  const ctx = fakeContext({ pages: 2 });
  await stopApp(ctx, opts());
  assert.deepEqual(ctx.log, ["page0 goto about:blank", "page1 goto about:blank"]);
  assert.ok(ctx.pages().every((p) => p.url() === "about:blank"));
});

test("stopApp waits for a refresh already on its way before it navigates, so its new cookie lands", async () => {
  const ctx = fakeContext();
  trackRequests(ctx, PROD.api);
  const refresh = request(`${PROD.api}/auth/refresh`);
  ctx.emit("request", refresh);
  ctx.emit("request", request(`${PROD.api}/teams/t1/products`));
  let sleeps = 0;
  await stopApp(ctx, opts(async () => {
    ctx.log.push("wait");
    if (++sleeps === 3) ctx.emit("requestfinished", refresh);
  }));
  assert.deepEqual(ctx.log, ["wait", "wait", "wait", "page0 goto about:blank", "wait"], "a list in flight isn't waited for, the refresh is");
});

test("stopApp's wait for a refresh is bounded: it still stops the app, then says the cookie may be spent", async () => {
  const ctx = fakeContext();
  trackRequests(ctx, PROD.api);
  ctx.emit("request", request(`${PROD.api}/auth/refresh`));
  let sleeps = 0;
  await assert.rejects(stopApp(ctx, { ...opts(async () => { sleeps++; }), authWaitMs: 500 }), (err) => {
    assert.ok(err instanceof RefreshInFlight);
    assert.match(err.message, /^a refresh was still in flight after 0\.5 seconds, so the session cookie may be spent$/);
    return true;
  });
  assert.equal(sleeps, 10 + 1, "500 ms in 50 ms steps, then the settle");
  assert.equal(ctx.pages()[0].url(), "about:blank");
  assert.match(new RefreshInFlight().message, new RegExp(`after ${AUTH_WAIT_MS / 1000} seconds`));
});

test("a request that never reports its end doesn't make the next stopApp wait", async () => {
  const ctx = fakeContext();
  const t = trackRequests(ctx, PROD.api);
  ctx.emit("request", request(`${PROD.api}/auth/refresh`));
  ctx.emit("request", request(`${PROD.api}/teams/t1/products`));
  await assert.rejects(stopApp(ctx, { ...opts(), authWaitMs: 100 }), RefreshInFlight);
  assert.equal(t.inFlight.size, 0, "the pages are blank: nothing from before is in flight");
  let sleeps = 0;
  await stopApp(ctx, opts(async () => { sleeps++; }));
  assert.equal(sleeps, 1, "only the settle");
  assert.equal(isAbandonedRequestError(ctx, `${PROD.api}/auth/refresh due to access control checks.`), false);
});

test("in-flight requests are forgotten even when a navigation fails", async () => {
  const ctx = fakeContext();
  const t = trackRequests(ctx, PROD.api);
  ctx.emit("request", request(`${PROD.api}/teams/t1/products`));
  ctx.list[0].goto = async () => { throw new Error("page crashed"); };
  await assert.rejects(stopApp(ctx, opts()), /page crashed/);
  assert.equal(t.inFlight.size, 0);
});

test("stopApp doesn't wait for a refresh whose page has closed", async () => {
  const ctx = fakeContext();
  const t = trackRequests(ctx, PROD.api);
  ctx.emit("request", request(`${PROD.api}/auth/refresh`, { pageClosed: true }));
  ctx.emit("request", request(`${PROD.api}/teams/t1/products`, { pageClosed: true }));
  const open = request(`${PROD.api}/teams/t1/projects`, { pageClosed: false });
  ctx.emit("request", open);
  let abandoned;
  ctx.onGoto = () => { abandoned = [...t.abandoned]; };
  let sleeps = 0;
  await stopApp(ctx, opts(async () => { sleeps++; }));
  assert.equal(sleeps, 1, "no wait, only the settle");
  assert.deepEqual(abandoned, [`${PROD.api}/teams/t1/projects`], "a closed page's requests aren't allowed to be cut off either");
});

test("stopApp still waits for a refresh on an open page, or one with no page", async () => {
  for (const req of [request(`${PROD.api}/auth/refresh`, { pageClosed: false }), request(`${PROD.api}/auth/refresh`)]) {
    const ctx = fakeContext();
    trackRequests(ctx, PROD.api);
    ctx.emit("request", req);
    let sleeps = 0;
    await stopApp(ctx, opts(async () => { if (++sleeps === 2) ctx.emit("requestfinished", req); }));
    assert.equal(sleeps, 2 + 1);
  }
});

test("a request cut off by stopApp is allowed only while it navigates, and only for that request", async () => {
  const ctx = fakeContext();
  const other = fakeContext();
  trackRequests(ctx, PROD.api);
  trackRequests(ctx, PROD.api); // idempotent: one set of listeners
  assert.equal(ctx.listenerCount("request"), 1);
  const products = `${PROD.api}/teams/t1/products`;
  const projects = `${PROD.api}/teams/t1/projects?since=2026-01-01`;
  ctx.emit("request", request(products));
  ctx.emit("request", request("https://dataplane.rum.us-east-1.amazonaws.com/appmonitors/x"));
  const cut = (href) => `${href} due to access control checks.`;
  const seen = {};
  ctx.onGoto = () => {
    // A list the app starts as the page goes is cut off too
    ctx.emit("request", request(projects));
    const host = new URL(PROD.api).host;
    seen.during = {
      products: isAbandonedRequestError(ctx, cut(products)),
      console: isAbandonedRequestError(ctx, `Fetch API cannot load ${products} due to access control checks.`),
      hostForm: isAbandonedRequestError(ctx, `/${host}/teams/t1/projects?since=2026-01-01 due to access control checks.`),
      started: isAbandonedRequestError(ctx, cut(projects)),
      otherUrl: isAbandonedRequestError(ctx, cut(`${PROD.api}/me`)),
      otherQuery: isAbandonedRequestError(ctx, cut(`${PROD.api}/teams/t1/projects`)),
      rum: isAbandonedRequestError(ctx, cut("https://dataplane.rum.us-east-1.amazonaws.com/appmonitors/x")),
      otherMessage: isAbandonedRequestError(ctx, `${products} failed: TypeError`),
      otherContext: isAbandonedRequestError(other, cut(products)),
    };
  };
  assert.equal(isAbandonedRequestError(ctx, cut(products)), false, "before stopApp, a CORS failure is a failure");
  await stopApp(ctx, opts());
  assert.deepEqual(seen.during, { products: true, console: true, hostForm: true, started: true, otherUrl: false, otherQuery: false, rum: false, otherMessage: false, otherContext: false });
  assert.equal(isAbandonedRequestError(ctx, cut(products)), false, "after stopApp, it's a failure again");
  assert.equal(isAbandonedRequestError(fakeContext(), cut(products)), false, "a context never tracked");
  assert.equal(isAbandonedRequestError(ctx, undefined), false);
});

test("the allowance closes even when a navigation fails", async () => {
  const ctx = fakeContext();
  trackRequests(ctx, PROD.api);
  const href = `${PROD.api}/teams/t1/products`;
  ctx.emit("request", request(href));
  let during;
  ctx.list[0].goto = async () => { during = isAbandonedRequestError(ctx, `${href} due to access control checks.`); throw new Error("page crashed"); };
  await assert.rejects(stopApp(ctx, opts()), /page crashed/);
  assert.equal(during, true);
  assert.equal(isAbandonedRequestError(ctx, `${href} due to access control checks.`), false);
});

test("a finished or failed request is no longer in flight", async () => {
  const ctx = fakeContext();
  const t = trackRequests(ctx, PROD.api);
  const a = request(`${PROD.api}/teams/t1/products`), b = request(`${PROD.api}/teams/t1/projects`);
  ctx.emit("request", a);
  ctx.emit("request", b);
  ctx.emit("request", request("not a url"));
  ctx.emit("requestfinished", a);
  ctx.emit("requestfailed", b);
  assert.equal(t.inFlight.size, 0);
  let during;
  ctx.onGoto = () => { during = isAbandonedRequestError(ctx, `${PROD.api}/teams/t1/products due to access control checks.`); };
  await stopApp(ctx, opts());
  assert.equal(during, false, "nothing was in flight, so nothing is allowed");
});
