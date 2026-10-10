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

const trackers = new WeakMap();
/** How long stopApp waits for a refresh (any /auth/ request) already on its way. */
export const AUTH_WAIT_MS = 10_000;
/** How long stopApp keeps the allowance open after the pages are blank, for late reports. */
export const SETTLE_MS = 250;
const POLL_MS = 50;

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Stops the app in every page of `context`: waits (up to AUTH_WAIT_MS) for a refresh on its way,
 * so its new cookie lands, then takes each page to about:blank. Afterwards nothing in the context
 * can refresh, so its refresh cookie is the session as it stands.
 */
export async function stopApp(context, { apiOrigin, authWaitMs = AUTH_WAIT_MS, settleMs = SETTLE_MS, sleep = sleeper } = {}) {
  const tracker = trackRequests(context, apiOrigin);
  for (let waited = 0; [...tracker.inFlight].some(isAuth) && waited < authWaitMs; waited += POLL_MS) await sleep(POLL_MS);
  tracker.abandoned = new Set([...tracker.inFlight].map((req) => req.url()));
  try {
    for (const page of context.pages()) await page.goto("about:blank");
    await sleep(settleMs);
  } finally {
    tracker.abandoned = null;
  }
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
