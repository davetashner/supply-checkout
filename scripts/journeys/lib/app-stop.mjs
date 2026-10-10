// Stopping the app in a browser context before its session is read or abandoned
// (supply-checkout-o60.17). The app refreshes its tokens on a timer, and each POST /auth/refresh
// spends the refresh cookie it was sent (lib/sessions.mjs). So a session goes back to the pool
// only once the app can't refresh again: stopApp waits for a refresh already on its way, then
// takes every page of the context to about:blank, and only then is the cookie read.
//
// Navigating away cuts off the app's other requests still in flight (a list, a live update's
// fetch). WebKit fails a cut-off fetch "due to access control checks", and when the app doesn't
// catch it that's an uncaught page error, which the fixtures count as a failure (journeys run
// 38004494194, J4 on iPhone). isAbandonedRequestError allows exactly those: only while stopApp is
// taking the context's pages away, only WebKit's cut-off message, and only for an API request
// that was in flight then (by its full URL). A CORS failure at any other time, or for any other
// request, is still a failure.
//
// A refresh still in flight after AUTH_WAIT_MS may or may not spend the cookie: stopApp still
// stops the app, then throws RefreshInFlight, so a release doesn't pool a cookie that may be
// spent (supply-checkout-o60.18). A request whose page has closed never finishes, so stopApp
// doesn't wait for it, and once the pages are blank nothing from before is in flight any more.

const trackers = new WeakMap();
/** How long stopApp waits for a refresh (any /auth/ request) already on its way. */
export const AUTH_WAIT_MS = 10_000;
/** How long stopApp keeps the allowance open after the pages are blank, for late reports. */
export const SETTLE_MS = 250;
const POLL_MS = 50;

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** stopApp stopped the app, but a refresh was still in flight: its cookie may be spent. */
export class RefreshInFlight extends Error {
  constructor(waitedMs = AUTH_WAIT_MS) { super(`a refresh was still in flight after ${waitedMs / 1000} seconds, so the session cookie may be spent`); this.name = "RefreshInFlight"; }
}

/**
 * Starts following a context's requests to the API (idempotent): call it before the app loads.
 * Returns the context's tracker: the requests in flight, and while stopApp runs, the URLs it
 * abandons.
 */
export function trackRequests(context, apiOrigin) {
  const known = trackers.get(context);
  if (known) return known;
  const origin = new URL(apiOrigin).origin;
  const tracker = { origin, inFlight: new Set(), abandoned: null };
  const toApi = (req) => { try { return new URL(req.url()).origin === origin; } catch { return false; } };
  context.on("request", (req) => {
    if (!toApi(req)) return;
    tracker.inFlight.add(req);
    // A request the app starts while its pages are being taken away is cut off too
    tracker.abandoned?.add(req.url());
  });
  const done = (req) => { tracker.inFlight.delete(req); };
  context.on("requestfinished", done);
  context.on("requestfailed", done);
  trackers.set(context, tracker);
  return tracker;
}

const isAuth = (req) => { try { return new URL(req.url()).pathname.startsWith("/auth/"); } catch { return false; } };
// Whether a request's page has closed: such a request never finishes. A request without a page
// (a service worker's) counts as open.
const pageClosed = (req) => { try { return req.frame().page().isClosed() === true; } catch { return false; } };

/**
 * Stops the app in every page of `context`: waits (up to AUTH_WAIT_MS) for a refresh on its way,
 * so its new cookie lands, then takes each page to about:blank. Afterwards nothing in the context
 * can refresh, so its refresh cookie is the session as it stands. Throws RefreshInFlight (after
 * stopping the app) when a refresh was still on its way after the wait.
 */
export async function stopApp(context, { apiOrigin, authWaitMs = AUTH_WAIT_MS, settleMs = SETTLE_MS, sleep = sleeper } = {}) {
  const tracker = trackRequests(context, apiOrigin);
  const refreshing = () => {
    for (const req of tracker.inFlight) if (pageClosed(req)) tracker.inFlight.delete(req);
    return [...tracker.inFlight].some(isAuth);
  };
  for (let waited = 0; refreshing() && waited < authWaitMs; waited += POLL_MS) await sleep(POLL_MS);
  const unfinished = refreshing();
  tracker.abandoned = new Set([...tracker.inFlight].map((req) => req.url()));
  try {
    for (const page of context.pages()) await page.goto("about:blank");
    await sleep(settleMs);
  } finally {
    tracker.abandoned = null;
    // Every page is blank (or the stop failed): what was in flight is gone, and a request that
    // never reports its end mustn't make the next stop wait
    tracker.inFlight.clear();
  }
  if (unfinished) throw new RefreshInFlight(authWaitMs);
}

// WebKit's report of a fetch cut off by navigation: "<url> due to access control checks.", with
// "Fetch API cannot load " before it in the console
const CUT_OFF = /^(?:Fetch API cannot load )?(\S+) due to access control checks\.?$/;

/**
 * Whether a page or console error is WebKit's report of an API request that stopApp is cutting
 * off in this context right now. False at any other time, and for any other message or URL.
 */
export function isAbandonedRequestError(context, message) {
  const abandoned = trackers.get(context)?.abandoned;
  if (!abandoned?.size) return false;
  const reported = CUT_OFF.exec(String(message ?? ""))?.[1];
  if (!reported) return false;
  for (const href of abandoned) {
    const u = new URL(href);
    // WebKit gives the whole URL; the page error has been seen as "/<host><path>" too
    if (reported === href || reported === `/${u.host}${u.pathname}${u.search}`) return true;
  }
  return false;
}
